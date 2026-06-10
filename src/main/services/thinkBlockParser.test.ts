import { describe, expect, it } from "vitest";
import { ThinkBlockParser } from "./thinkBlockParser";

describe("ThinkBlockParser", () => {
  it("passes through plain text with no think block", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("hello world")).toEqual({
      visible: "hello world",
      thinking: ""
    });
  });

  it("strips a complete think block at the start of a single feed", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("<think>reasoning here</think>answer")).toEqual({
      visible: "answer",
      thinking: "reasoning here"
    });
    // once closed, subsequent deltas are all visible
    expect(parser.feed(" more")).toEqual({
      visible: " more",
      thinking: ""
    });
  });

  it("strips a think block that has leading and trailing visible text", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("intro<think>reasoning</think>done")).toEqual({
      visible: "introdone",
      thinking: "reasoning"
    });
  });

  it("handles the open tag being split across two deltas", () => {
    const parser = new ThinkBlockParser();
    // First feed leaves the partial "<th" in the buffer.
    expect(parser.feed("hello <th")).toEqual({
      visible: "hello ",
      thinking: ""
    });
    // Second feed completes the tag and the block.
    expect(parser.feed("ink>reasoning</think>ok")).toEqual({
      visible: "ok",
      thinking: "reasoning"
    });
  });

  it("handles the close tag being split across two deltas", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("<think>reasoning</th")).toEqual({
      visible: "",
      thinking: "reasoning"
    });
    expect(parser.feed("ink>after")).toEqual({
      visible: "after",
      thinking: ""
    });
  });

  it("treats an unclosed think block as thinking and stops emitting visible", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("<think>open ended")).toEqual({
      visible: "",
      thinking: "open ended"
    });
    expect(parser.feed(" forever")).toEqual({
      visible: "",
      thinking: " forever"
    });
  });

  it("returns empty results for an empty delta", () => {
    const parser = new ThinkBlockParser();
    expect(parser.feed("")).toEqual({ visible: "", thinking: "" });
  });

  it("treats a second think block after the first as visible", () => {
    // The parser handles a single think block; anything after the first close
    // is treated as visible. Real models rarely emit a second block.
    const parser = new ThinkBlockParser();
    expect(
      parser.feed("<think>first</think>mid<think>second</think>tail")
    ).toEqual({
      visible: "mid<think>second</think>tail",
      thinking: "first"
    });
  });

  it("holds back a literal less-than that could be the start of a tag", () => {
    // When the parser sees a `<`, it cannot tell if the next chars will form
    // `<think>` or a plain `<`. To stay safe across delta boundaries, the
    // `<` is held back. A subsequent feed that doesn't form a tag flushes it.
    const parser = new ThinkBlockParser();
    expect(parser.feed("a < b")).toEqual({ visible: "a ", thinking: "" });
    expect(parser.feed("")).toEqual({ visible: "", thinking: "" });
    // Force a long-enough buffer to confirm the `<` is held back, not lost.
    expect(parser.feed("more text")).toEqual({
      visible: "< bmore text",
      thinking: ""
    });
  });
});
