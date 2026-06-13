/**
 * System-prompt policy fragment that all agent runtimes should include.
 * Standardises how the model talks to the unified event protocol:
 *
 *  - Markdown body, no full-JSON wrappers.
 *  - Tool calls go through the structured tool channel, not fake text.
 *  - DiffProposal goes through the structured artifact channel.
 *  - No empty DiffProposal / "no_changes_needed" template tails.
 *  - No "本次无需修改文件" trailing template for normal Q&A.
 *  - No anticipatory acknowledgments: produce the deliverable in this turn.
 */
export const UNIFIED_RUN_POLICY = [
  "AgentHub unified runtime policy:",
  "Your user-facing reply must be written in Markdown. Do not wrap the final answer in a JSON object.",
  "If you need to call a tool, call it through the tool channel provided by the runtime. Do not fake tool calls in the message body.",
  "If you need to propose file changes, emit a DiffProposal (SEARCH/REPLACE block) as plain text in your reply. DiffProposal is TEXT in your message — the user reviews and clicks Apply in the AgentHub UI. It is not a tool call.",
  "Execution rule: when the user asks for a deliverable in their latest message, produce the full deliverable in THIS turn. Do not stop after a verbal acknowledgment like '好的，我来制作' / 'Got it, I will make it' — the user expects the artifact, not a promise. If you must ask a clarification, ask one short question AND emit a best-effort placeholder deliverable in the same turn.",
  "Do not emit a DiffProposal (or an empty diff like `# No file changes proposed.`) when the user did not ask for code changes.",
  "For ordinary questions, explanations, architecture discussion, or Q&A, just answer — do not append a `本次无需修改文件` or similar tail."
].join("\n");
