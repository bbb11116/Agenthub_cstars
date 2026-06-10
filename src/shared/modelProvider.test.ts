import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  ONE_MILLION_CONTEXT_WINDOW_TOKENS,
  createModelProviderLimits,
  normalizeModelProviderLimits
} from "./modelProvider";

describe("model provider limits", () => {
  it("defaults new providers to a 256K context window", () => {
    expect(createModelProviderLimits(false)).toEqual({
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      source: "default_256k"
    });
  });

  it("uses a 1M context window only when explicitly enabled", () => {
    expect(createModelProviderLimits(true)).toEqual({
      contextWindowTokens: ONE_MILLION_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      source: "user_enabled_1m"
    });
  });

  it("fills missing legacy limits with the 256K default", () => {
    expect(normalizeModelProviderLimits(undefined)).toEqual({
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      source: "default_256k"
    });
  });
});
