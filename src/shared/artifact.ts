export type ArtifactType =
  | "code"
  | "html"
  | "markdown"
  | "diff"
  | "document"
  | "presentation"
  | "pdf";

export type ArtifactRenderStatus = "none" | "queued" | "rendering" | "ready" | "error";

export type ArtifactRenderMode =
  | "code"
  | "html_iframe"
  | "markdown"
  | "diff"
  | "pdf"
  | "document_pages"
  | "presentation_pages";

export type ArtifactRenderAsset = {
  id: string;
  role: "primary" | "page";
  fileName: string;
  mimeType: string;
  url?: string;
  pageNumber?: number;
};

export type ArtifactRenderManifest = {
  status: ArtifactRenderStatus;
  mode: ArtifactRenderMode;
  source: "content" | "file_path" | "cache";
  assets: ArtifactRenderAsset[];
  pageCount?: number;
  converter?: string;
  message?: string;
  generatedAt?: string;
};

export type Artifact = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  filePath?: string;
  render?: ArtifactRenderManifest;
  version: number;
  createdAt: string;
};

export type CreateArtifactInput = {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  filePath?: string;
  render?: ArtifactRenderManifest;
  version?: number;
};

export type PreviewArtifactInput = {
  artifactId: string;
  agentId?: string;
};

export type UpdateArtifactInput = Partial<
  Pick<Artifact, "type" | "title" | "content" | "language" | "filePath" | "render" | "version">
>;

export type ArtifactPreviewPayload = {
  messageId: string;
  artifactId: string;
  title: string;
  artifactType: ArtifactType;
  renderMode: ArtifactRenderMode;
  renderStatus: ArtifactRenderStatus;
  filePath?: string;
  language?: string;
  sizeBytes?: number;
  pageCount?: number;
};

export type ArtifactRenderChangedPayload = ArtifactPreviewPayload & {
  render?: ArtifactRenderManifest;
};

export type UpdateArtifactContentInput = {
  artifactId: string;
  content: string;
  title?: string;
};

export type CreateArtifactDiffInput = {
  artifactId: string;
  agentId?: string;
};

export type ArtifactTabState = {
  artifacts: Artifact[];
  activeArtifactId: string | null;
};

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "code",
  "html",
  "markdown",
  "diff",
  "document",
  "presentation",
  "pdf"
];

export function isArtifactType(value: unknown): value is ArtifactType {
  return ARTIFACT_TYPES.includes(value as ArtifactType);
}
