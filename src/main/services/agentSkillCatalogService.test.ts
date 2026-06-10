import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_SKILL_CATEGORIES,
  buildAgentSkillsSystemPrompt,
  getAgentSkillCapabilities,
  getAgentSkillDetail,
  listAgentSkillCatalog,
  normalizeAgentSkillId,
  validateAgentSkillIds
} from "./agentSkillCatalogService";

let tempDir: string | null = null;

function createTempSkillRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-skills-"));
  for (const category of AGENT_SKILL_CATEGORIES) {
    fs.mkdirSync(path.join(tempDir, category), { recursive: true });
  }
  return tempDir;
}

function writeSkill(rootPath: string, category: string, skillName: string, content: string): string {
  const skillPath = path.join(rootPath, category, skillName);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "skill.md"), content);
  return `${category}/${skillName}`;
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("agentSkillCatalogService", () => {
  it("lists folder skills with skill.md metadata", () => {
    const rootPath = createTempSkillRoot();
    const skillId = writeSkill(
      rootPath,
      "计算机与数学职业",
      "Frontend Engineer",
      [
        "---",
        "name: Ignored Name",
        "description: Builds React UI and reviews accessibility.",
        "---",
        "",
        "# Frontend Skill",
        "",
        "Use React component boundaries."
      ].join("\n")
    );

    const catalog = listAgentSkillCatalog(rootPath);
    const computerCategory = catalog.find((category) => category.name === "计算机与数学职业");

    expect(computerCategory?.skills).toEqual([
      {
        id: skillId,
        category: "计算机与数学职业",
        name: "Frontend Engineer",
        description: "Builds React UI and reviews accessibility."
      }
    ]);
  });

  it("reads skill detail content without frontmatter", () => {
    const rootPath = createTempSkillRoot();
    const skillId = writeSkill(
      rootPath,
      "法律类职业",
      "Legal Researcher",
      [
        "---",
        "name: Ignored Name",
        "description: Reviews legal constraints.",
        "---",
        "",
        "# Legal Researcher",
        "",
        "Track assumptions and cite uncertainty."
      ].join("\n")
    );

    expect(getAgentSkillDetail(skillId, rootPath)).toMatchObject({
      id: skillId,
      category: "法律类职业",
      name: "Legal Researcher",
      description: "Reviews legal constraints.",
      content: "# Legal Researcher\n\nTrack assumptions and cite uncertainty."
    });
  });

  it("validates skill ids and rejects path traversal", () => {
    const rootPath = createTempSkillRoot();
    const skillId = writeSkill(rootPath, "管理类职业", "Project Manager", "# PM\n\nPlan work.");

    expect(validateAgentSkillIds([skillId, skillId], rootPath)).toEqual([skillId]);
    expect(() => normalizeAgentSkillId("../secret.md")).toThrow(/format|invalid/);
    expect(() => validateAgentSkillIds(["管理类职业/Missing"], rootPath)).toThrow(/Skill not found/);
  });

  it("builds capabilities and runtime prompt from selected skills", () => {
    const rootPath = createTempSkillRoot();
    const skillId = writeSkill(
      rootPath,
      "商业与金融运营类职业",
      "Financial Analyst",
      [
        "---",
        "name: Ignored Name",
        "description: Models revenue and operating assumptions.",
        "---",
        "",
        "# Financial Analyst",
        "",
        "Separate facts from projections."
      ].join("\n")
    );

    expect(getAgentSkillCapabilities([skillId], rootPath)).toEqual([
      "Financial Analyst: Models revenue and operating assumptions."
    ]);
    const prompt = buildAgentSkillsSystemPrompt([skillId], rootPath);

    expect(prompt).toContain("Assigned Skills:");
    expect(prompt).toContain('name="Financial Analyst"');
    expect(prompt).toContain("Separate facts from projections.");
    expect(prompt).toContain("subordinate to AgentHub platform policies");
  });
});
