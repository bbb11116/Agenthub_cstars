import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  Artifact,
  ArtifactRenderAsset,
  ArtifactRenderChangedPayload,
  ArtifactRenderManifest,
  ArtifactRenderMode
} from "../../shared/artifact";
import { getDatabase, type AgentHubDatabase } from "../db";
import {
  getArtifactById,
  updateArtifact as updateArtifactRow
} from "../db/repositories/artifactRepo";
import { createWorkspacePathGuard } from "../utils/pathGuard";
import { resolveExecutionWorkspaceForConversation } from "./workspaceContextResolver";

const execFileAsync = promisify(execFile);
const PREVIEW_PROTOCOL = "agenthub-preview";
const CACHE_ROOT = path.join(os.tmpdir(), "agenthub-artifact-render-cache");
const OFFICE_CONVERTER_CANDIDATES = ["soffice", "libreoffice"];

type RenderNotifier = (payload: ArtifactRenderChangedPayload) => void;

let renderNotifier: RenderNotifier | null = null;
const runningRenders = new Set<string>();

function getModeForArtifact(artifact: Artifact): ArtifactRenderMode {
  switch (artifact.type) {
    case "html":
      return "html_iframe";
    case "markdown":
      return "markdown";
    case "diff":
      return "diff";
    case "document":
      return "document_pages";
    case "presentation":
      return "presentation_pages";
    case "pdf":
      return "pdf";
    case "code":
      return "code";
  }
}

function getNativeRenderManifest(artifact: Artifact): ArtifactRenderManifest {
  return {
    status: "ready",
    mode: getModeForArtifact(artifact),
    source: "content",
    assets: [],
    generatedAt: new Date().toISOString()
  };
}

function getQueuedRenderManifest(artifact: Artifact): ArtifactRenderManifest {
  return {
    status: "queued",
    mode: getModeForArtifact(artifact),
    source: artifact.filePath ? "file_path" : "content",
    assets: [],
    generatedAt: new Date().toISOString()
  };
}

function getErrorRenderManifest(
  artifact: Artifact,
  message: string,
  converter?: string
): ArtifactRenderManifest {
  return {
    status: "error",
    mode: getModeForArtifact(artifact),
    source: artifact.filePath ? "file_path" : "content",
    assets: [],
    converter,
    message,
    generatedAt: new Date().toISOString()
  };
}

function getCacheDir(artifactId: string): string {
  return path.join(CACHE_ROOT, artifactId);
}

function getAssetUrl(artifactId: string, assetId: string): string {
  return `${PREVIEW_PROTOCOL}://artifact/${encodeURIComponent(artifactId)}/${encodeURIComponent(assetId)}`;
}

function getPrimaryPdfAsset(artifactId: string): ArtifactRenderAsset {
  return {
    id: "primary",
    role: "primary",
    fileName: "render.pdf",
    mimeType: "application/pdf",
    url: getAssetUrl(artifactId, "primary")
  };
}

function isOfficeRenderable(artifact: Artifact): boolean {
  return artifact.type === "document" || artifact.type === "presentation";
}

function needsExternalRender(artifact: Artifact): boolean {
  return artifact.type === "pdf" || isOfficeRenderable(artifact);
}

function getRenderPayload(artifact: Artifact): ArtifactRenderChangedPayload {
  return {
    messageId: "",
    artifactId: artifact.id,
    title: artifact.title,
    artifactType: artifact.type,
    renderMode: artifact.render?.mode ?? getModeForArtifact(artifact),
    renderStatus: artifact.render?.status ?? "none",
    filePath: artifact.filePath,
    language: artifact.language,
    pageCount: artifact.render?.pageCount,
    sizeBytes: Buffer.byteLength(artifact.content, "utf8"),
    render: artifact.render
  };
}

function notifyRenderChanged(artifact: Artifact): void {
  renderNotifier?.(getRenderPayload(artifact));
}

function updateRenderManifest(
  artifact: Artifact,
  render: ArtifactRenderManifest,
  db: AgentHubDatabase
): Artifact {
  const updated = updateArtifactRow(artifact.id, { render }, db) ?? {
    ...artifact,
    render
  };
  notifyRenderChanged(updated);
  return updated;
}

async function resolveArtifactSourcePath(
  artifact: Artifact,
  db: AgentHubDatabase
): Promise<string> {
  if (!artifact.filePath) {
    throw new Error("A file path is required to render this artifact.");
  }

  const workspaceContext = resolveExecutionWorkspaceForConversation(
    artifact.conversationId,
    artifact.agentId,
    db
  );
  const guard = createWorkspacePathGuard(workspaceContext.rootPath);
  const resolved = guard.resolve(artifact.filePath);
  const safePath = guard.assertInside(resolved.absolutePath);
  const stats = await fs.stat(safePath);

  if (!stats.isFile()) {
    throw new Error("Artifact file path does not point to a file.");
  }

  return safePath;
}

export async function findOfficeConverter(): Promise<string | null> {
  const candidates = process.env.AGENTHUB_SOFFICE_PATH
    ? [process.env.AGENTHUB_SOFFICE_PATH, ...OFFICE_CONVERTER_CANDIDATES]
    : OFFICE_CONVERTER_CANDIDATES;

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 5000 });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function prepareCacheDir(artifactId: string): Promise<string> {
  const cacheDir = getCacheDir(artifactId);
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

async function countPdfPages(pdfPath: string): Promise<number | undefined> {
  try {
    const content = await fs.readFile(pdfPath, "latin1");
    const matches = content.match(/\/Type\s*\/Page\b/g);
    return matches?.length;
  } catch {
    return undefined;
  }
}

async function copyPdfArtifact(
  artifact: Artifact,
  sourcePath: string
): Promise<ArtifactRenderManifest> {
  const cacheDir = await prepareCacheDir(artifact.id);
  const outputPath = path.join(cacheDir, "render.pdf");
  await fs.copyFile(sourcePath, outputPath);
  const pageCount = await countPdfPages(outputPath);

  return {
    status: "ready",
    mode: "pdf",
    source: "cache",
    assets: [getPrimaryPdfAsset(artifact.id)],
    pageCount,
    generatedAt: new Date().toISOString()
  };
}

async function convertOfficeArtifact(
  artifact: Artifact,
  sourcePath: string
): Promise<ArtifactRenderManifest> {
  const converter = await findOfficeConverter();

  if (!converter) {
    throw new Error("LibreOffice/soffice is required for document and PPT rendering.");
  }

  const cacheDir = await prepareCacheDir(artifact.id);
  await execFileAsync(
    converter,
    ["--headless", "--convert-to", "pdf", "--outdir", cacheDir, sourcePath],
    { timeout: 60_000 }
  );

  const convertedName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
  const convertedPath = path.join(cacheDir, convertedName);
  const outputPath = path.join(cacheDir, "render.pdf");
  await fs.rename(convertedPath, outputPath);
  const pageCount = await countPdfPages(outputPath);

  return {
    status: "ready",
    mode: artifact.type === "presentation" ? "presentation_pages" : "document_pages",
    source: "cache",
    assets: [getPrimaryPdfAsset(artifact.id)],
    pageCount,
    converter,
    generatedAt: new Date().toISOString()
  };
}

export function getInitialRenderManifest(artifact: Artifact): ArtifactRenderManifest {
  return needsExternalRender(artifact)
    ? getQueuedRenderManifest(artifact)
    : getNativeRenderManifest(artifact);
}

export function setArtifactRenderNotifier(notifier: RenderNotifier | null): void {
  renderNotifier = notifier;
}

export function scheduleArtifactRender(
  artifactId: string,
  db: AgentHubDatabase = getDatabase()
): void {
  const artifact = getArtifactById(artifactId, db);

  if (!artifact || !needsExternalRender(artifact) || runningRenders.has(artifact.id)) {
    return;
  }

  runningRenders.add(artifact.id);

  void renderArtifact(artifact.id, db).finally(() => {
    runningRenders.delete(artifact.id);
  });
}

export async function renderArtifact(
  artifactId: string,
  db: AgentHubDatabase = getDatabase()
): Promise<Artifact> {
  const artifact = getArtifactById(artifactId, db);

  if (!artifact) {
    throw new Error("Artifact not found.");
  }

  if (!needsExternalRender(artifact)) {
    return updateRenderManifest(artifact, getNativeRenderManifest(artifact), db);
  }

  const renderingArtifact = updateRenderManifest(
    artifact,
    {
      ...getQueuedRenderManifest(artifact),
      status: "rendering"
    },
    db
  );

  try {
    const sourcePath = await resolveArtifactSourcePath(renderingArtifact, db);
    const render =
      renderingArtifact.type === "pdf"
        ? await copyPdfArtifact(renderingArtifact, sourcePath)
        : await convertOfficeArtifact(renderingArtifact, sourcePath);

    return updateRenderManifest(renderingArtifact, render, db);
  } catch (error) {
    return updateRenderManifest(
      renderingArtifact,
      getErrorRenderManifest(
        renderingArtifact,
        error instanceof Error ? error.message : "Failed to render artifact."
      ),
      db
    );
  }
}

export function getArtifactRenderAssetFilePath(
  artifactId: string,
  assetId: string,
  db: AgentHubDatabase = getDatabase()
): string {
  const artifact = getArtifactById(artifactId, db);

  if (!artifact?.render || artifact.render.status !== "ready") {
    throw new Error("Artifact render is not ready.");
  }

  const asset = artifact.render.assets.find((item) => item.id === assetId);

  if (!asset) {
    throw new Error("Artifact render asset not found.");
  }

  const safeFileName = path.basename(asset.fileName);
  return path.join(getCacheDir(artifact.id), safeFileName);
}
