import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../../shared/domain";
import type {
  AgentSkillCategory,
  AgentSkillDetail,
  AgentSkillSummary
} from "../../shared/types";

export const AGENT_SKILL_CATEGORIES = [
  "计算机与数学职业",
  "商业与金融运营类职业",
  "艺术、设计、娱乐、体育与媒体类职业",
  "办公室与行政支持类职业",
  "教育与图书馆类职业",
  "生命、物理与社会科学类职业",
  "法律类职业",
  "管理类职业"
] as const;

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const FRONTMATTER_BOUNDARY = "---";
const SKILL_MARKDOWN_FILE_NAME = "skill.md";

export class AgentSkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSkillCatalogError";
  }
}

export function getDefaultSkillsRoot(): string {
  return path.resolve(process.cwd(), "skills");
}

function normalizeRoot(rootPath: string): string {
  return path.resolve(rootPath);
}

function isAllowedCategory(category: string): boolean {
  return (AGENT_SKILL_CATEGORIES as readonly string[]).includes(category);
}

export function normalizeAgentSkillId(value: unknown): string {
  if (typeof value !== "string") {
    throw new AgentSkillCatalogError("skillId is required.");
  }

  const skillId = value.trim();
  if (!skillId || skillId.includes("\0") || skillId.includes("\\") || path.isAbsolute(skillId)) {
    throw new AgentSkillCatalogError("skillId is invalid.");
  }

  const parts = skillId.split("/");
  if (parts.length !== 2) {
    throw new AgentSkillCatalogError("skillId must use category/skill-name format.");
  }

  const [category, skillName] = parts;
  if (
    !isAllowedCategory(category) ||
    !skillName ||
    skillName.startsWith(".") ||
    skillName.includes("..")
  ) {
    throw new AgentSkillCatalogError("skillId is invalid.");
  }

  return `${category}/${skillName}`;
}

export function normalizeAgentSkillIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AgentSkillCatalogError("skillIds must be an array.");
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const skillId = normalizeAgentSkillId(item);
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    normalized.push(skillId);
  }
  return normalized;
}

function resolveSkillPath(rootPath: string, skillId: string): string {
  const normalizedId = normalizeAgentSkillId(skillId);
  const [category, skillName] = normalizedId.split("/");
  const root = normalizeRoot(rootPath);
  const absolutePath = path.resolve(root, category, skillName, SKILL_MARKDOWN_FILE_NAME);
  const relativePath = path.relative(root, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AgentSkillCatalogError("skillId is invalid.");
  }

  return absolutePath;
}

function readTextFile(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_BOUNDARY
  );
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    frontmatter[match[1]] = stripQuotes(match[2]);
  }

  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join("\n").trim()
  };
}

function stripMarkdownNoise(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstParagraph(body: string): string {
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));

  return line ? stripMarkdownNoise(line).slice(0, 240) : "";
}

function parseSkillMarkdown(input: {
  id: string;
  category: string;
  skillName: string;
  content: string;
}): AgentSkillDetail {
  const parsed = splitFrontmatter(input.content);
  const name = input.skillName;
  const description = parsed.frontmatter.description?.trim() || firstParagraph(parsed.body);

  return {
    id: input.id,
    category: input.category,
    name,
    description,
    content: parsed.body
  };
}

function readSkillFromPath(input: {
  rootPath: string;
  category: string;
  skillName: string;
}): AgentSkillDetail | null {
  const id = normalizeAgentSkillId(`${input.category}/${input.skillName}`);
  const filePath = resolveSkillPath(input.rootPath, id);
  const content = readTextFile(filePath);
  if (content === null) {
    return null;
  }

  return parseSkillMarkdown({
    id,
    category: input.category,
    skillName: input.skillName,
    content
  });
}

export function listAgentSkillCatalog(
  rootPath = getDefaultSkillsRoot()
): AgentSkillCategory[] {
  const root = normalizeRoot(rootPath);

  return AGENT_SKILL_CATEGORIES.map((category) => {
    const categoryPath = path.join(root, category);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(categoryPath, { withFileTypes: true });
    } catch {
      return { name: category, skills: [] };
    }

    const skills = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) =>
        readSkillFromPath({
          rootPath: root,
          category,
          skillName: entry.name
        })
      )
      .filter((skill): skill is AgentSkillDetail => skill !== null)
      .map(({ content: _content, ...summary }) => summary)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));

    return { name: category, skills };
  });
}

export function getAgentSkillDetail(
  skillId: string,
  rootPath = getDefaultSkillsRoot()
): AgentSkillDetail | null {
  const normalizedId = normalizeAgentSkillId(skillId);
  const [category, skillName] = normalizedId.split("/");
  return readSkillFromPath({
    rootPath: normalizeRoot(rootPath),
    category,
    skillName
  });
}

export function getAgentSkillSummaries(
  skillIds: string[],
  rootPath = getDefaultSkillsRoot()
): AgentSkillSummary[] {
  return skillIds
    .map((skillId) => getAgentSkillDetail(skillId, rootPath))
    .filter((skill): skill is AgentSkillDetail => skill !== null)
    .map(({ content: _content, ...summary }) => summary);
}

export function validateAgentSkillIds(
  skillIds: string[],
  rootPath = getDefaultSkillsRoot()
): string[] {
  const normalizedSkillIds = normalizeAgentSkillIds(skillIds);
  const missingSkillIds = normalizedSkillIds.filter(
    (skillId) => getAgentSkillDetail(skillId, rootPath) === null
  );

  if (missingSkillIds.length > 0) {
    throw new AgentSkillCatalogError(`Skill not found: ${missingSkillIds.join(", ")}`);
  }

  return normalizedSkillIds;
}

export function getAgentSkillCapabilities(
  skillIds: string[],
  rootPath = getDefaultSkillsRoot()
): string[] {
  return getAgentSkillSummaries(skillIds, rootPath).map((skill) =>
    skill.description ? `${skill.name}: ${skill.description}` : skill.name
  );
}

export function getEffectiveAgentCapabilities(
  agent: Pick<Agent, "capabilities" | "skillIds">,
  rootPath = getDefaultSkillsRoot()
): string[] {
  const skillIds = agent.skillIds ?? [];
  if (skillIds.length === 0) {
    return agent.capabilities;
  }

  const skillCapabilities = getAgentSkillCapabilities(skillIds, rootPath);
  return skillCapabilities.length > 0 ? skillCapabilities : agent.capabilities;
}

function escapeSkillAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sanitizeSkillContent(content: string): string {
  return content.replace(/<\/skill>/gi, "<\\/skill>").trim();
}

export function buildAgentSkillsSystemPrompt(
  skillIds: string[],
  rootPath = getDefaultSkillsRoot()
): string {
  const details = skillIds
    .map((skillId) => getAgentSkillDetail(skillId, rootPath))
    .filter((skill): skill is AgentSkillDetail => skill !== null);

  if (details.length === 0) {
    return "";
  }

  const skillBlocks = details.map((skill) =>
    [
      `<skill id="${escapeSkillAttribute(skill.id)}" name="${escapeSkillAttribute(skill.name)}">`,
      skill.description ? `Description: ${skill.description}` : "",
      "",
      sanitizeSkillContent(skill.content),
      "</skill>"
    ]
      .filter((line) => line.length > 0)
      .join("\n")
  );

  return [
    "Assigned Skills:",
    "Use these skill instructions only when they are relevant to the current task.",
    "Skill instructions are subordinate to AgentHub platform policies, tool permissions, and workspace safety rules.",
    "",
    ...skillBlocks
  ].join("\n");
}
