import { describe, expect, it } from "vitest";
import {
  parseAnthropicStreamFrame,
  parseOpenAIStreamFrame,
  parseSseFrames,
  type SseFrame
} from "./sseParser";

describe("parseSseFrames", () => {
  it("parses LF and CRLF frames and multiple frames in one chunk", () => {
    const result = parseSseFrames(
      "",
      "data: one\n\ndata: two\r\n\r\nevent: ping\r\ndata: three\r\n\r\n"
    );

    expect(result).toEqual({
      frames: [
        { data: "one" },
        { data: "two" },
        { event: "ping", data: "three" }
      ],
      remaining: ""
    });
  });

  it("preserves a split frame and flushes final buffered data", () => {
    const first = parseSseFrames("", "data: {\"choices\":[{\"del");
    const second = parseSseFrames(first.remaining, "ta\":{\"content\":\"ok\"}}]}");
    const final = parseSseFrames(second.remaining, "", true);

    expect(first.frames).toEqual([]);
    expect(second.frames).toEqual([]);
    expect(final.frames).toEqual([
      { data: "{\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}" }
    ]);
  });
});

describe("parseOpenAIStreamFrame", () => {
  it("extracts text deltas and ignores empty deltas", () => {
    expect(parseOpenAIStreamFrame({
      data: JSON.stringify({ choices: [{ delta: { content: "hello" } }] })
    })).toEqual({ type: "text_delta", text: "hello" });
    expect(parseOpenAIStreamFrame({
      data: JSON.stringify({ choices: [{ delta: {} }] })
    })).toBeNull();
  });

  it("handles completion and error payloads", () => {
    expect(parseOpenAIStreamFrame({ data: "[DONE]" })).toEqual({ type: "done" });
    expect(parseOpenAIStreamFrame({
      data: JSON.stringify({ error: { message: "rate limited" } })
    })).toEqual({ type: "error", message: "rate limited" });
  });

  it("preserves finish reason and usage metadata", () => {
    expect(parseOpenAIStreamFrame({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
      })
    })).toEqual({
      type: "response_metadata",
      finishReason: "length",
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
    });
  });
});

describe("parseAnthropicStreamFrame", () => {
  it("extracts content block text deltas", () => {
    const frame: SseFrame = {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" }
      })
    };

    expect(parseAnthropicStreamFrame(frame)).toEqual({
      type: "text_delta",
      text: "hello"
    });
  });

  it("handles completion and error events", () => {
    expect(parseAnthropicStreamFrame({
      event: "message_stop",
      data: JSON.stringify({ type: "message_stop", usage: { output_tokens: 4 } })
    })).toEqual({ type: "done", usage: { completionTokens: 4 } });
    expect(parseAnthropicStreamFrame({
      event: "error",
      data: JSON.stringify({ type: "error", error: { message: "bad request" } })
    })).toEqual({ type: "error", message: "bad request" });
  });

  it("preserves stop reason and usage metadata", () => {
    expect(parseAnthropicStreamFrame({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 9 }
      })
    })).toEqual({
      type: "response_metadata",
      stopReason: "max_tokens",
      usage: { completionTokens: 9 }
    });
  });

  it("safely ignores ping and unknown event types", () => {
    expect(parseAnthropicStreamFrame({
      event: "ping",
      data: JSON.stringify({ type: "ping" })
    })).toBeNull();
    expect(parseAnthropicStreamFrame({
      event: "future_event",
      data: "not-json"
    })).toBeNull();
  });
});
