import { describe, expect, it } from "vitest";
import { MAX_DISPATCH_STEPS } from "../../../shared/groupChat";
import { parseMentionNames } from "./mentionParser";

describe("parseMentionNames", () => {
  it("extracts ordered unique ASCII and CJK mentions", () => {
    expect(parseMentionNames("@Frontend, 请和 @测试助手 @Frontend 一起检查")).toEqual([
      "Frontend",
      "测试助手"
    ]);
  });

  it("caps the number of dispatch mentions", () => {
    const names = Array.from(
      { length: MAX_DISPATCH_STEPS + 2 },
      (_, index) => `@agent-${index}`
    ).join(" ");

    expect(parseMentionNames(names)).toHaveLength(MAX_DISPATCH_STEPS);
  });
});
