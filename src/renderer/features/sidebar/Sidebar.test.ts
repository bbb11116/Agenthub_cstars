import { describe, expect, it } from "vitest";
import { canDeleteAgentFromContacts } from "./Sidebar";

describe("canDeleteAgentFromContacts", () => {
  it("shows deletion only for available specialist sub Agents", () => {
    expect(
      canDeleteAgentFromContacts({
        role: "sub",
        type: "specialist",
        status: "available"
      })
    ).toBe(true);
    expect(
      canDeleteAgentFromContacts({
        role: "main",
        type: "orchestrator",
        status: "available"
      })
    ).toBe(false);
    expect(
      canDeleteAgentFromContacts({
        role: "sub",
        type: "specialist",
        status: "running"
      })
    ).toBe(false);
  });
});
