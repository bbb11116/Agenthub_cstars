import { describe, expect, it } from "vitest";
import { getSkill, listSkills } from "./skillRegistry";

describe("skillRegistry", () => {
  it("does not register the conversational create_agent_draft skill", () => {
    expect(getSkill("create_agent_draft")).toBeUndefined();
    expect(listSkills().map((skill) => skill.name)).not.toContain("create_agent_draft");
  });
});
