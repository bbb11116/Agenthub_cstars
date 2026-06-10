import type { CreateDiffProposalInput, DiffProposal } from "../../shared/diff";
import type { Message } from "../../shared/domain";
import { getMessageById } from "../db/repositories/messageRepo";
import { getDispatchRunById } from "../db/repositories/dispatchRunRepo";
import { getDispatchStepById } from "../db/repositories/dispatchStepRepo";
import type { AgentHubDatabase } from "../db";
import { readWorkspaceFile } from "./fileService";
import { createDiffProposal } from "./diffService";

const EMPTY_DIFF_PATTERNS = [
  /no\s+file\s+changes?\s+proposed/gi,
  /本次无需修改文件/g,
  /没有\s*DiffProposal/gi,
  /没有需要修改的文件/g
];

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER_MARKER = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

function splitContentLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");

  if (trailingNewline) {
    lines.pop();
  }

  return { lines, trailingNewline };
}

function parseRangeStart(range: string): number | null {
  const match = range.match(/^(\d+)(?:,\d+)?$/);
  return match ? Number(match[1]) : null;
}

/**
 * Applies a single-file unified diff patch to the given content. Used by
 * `createDiffProposal({ unifiedDiff })`, which is invoked by structured
 * adapter paths (streamingRunService, unifiedAgentProviderAdapter) that
 * already produce trustworthy diffs. The LLM text protocol uses
 * SEARCH/REPLACE blocks instead — see `createDiffProposalFromText`.
 */
export function applyUnifiedDiffToContent(oldContent: string, patch: string): string | null {
  const { lines: oldLines, trailingNewline } = splitContentLines(oldContent);
  const patchLines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const output: string[] = [];
  let oldIndex = 0;
  let sawHunk = false;

  for (let patchIndex = 0; patchIndex < patchLines.length; patchIndex += 1) {
    const hunkMatch = patchLines[patchIndex].match(/^@@\s+-(\d+(?:,\d+)?)\s+\+(\d+(?:,\d+)?)\s+@@/);
    if (!hunkMatch) {
      continue;
    }

    sawHunk = true;
    const oldStart = parseRangeStart(hunkMatch[1]);
    if (oldStart === null) {
      return null;
    }

    const hunkOldIndex = Math.max(oldStart - 1, 0);
    if (hunkOldIndex < oldIndex || hunkOldIndex > oldLines.length) {
      return null;
    }

    output.push(...oldLines.slice(oldIndex, hunkOldIndex));
    oldIndex = hunkOldIndex;
    patchIndex += 1;

    for (; patchIndex < patchLines.length; patchIndex += 1) {
      const line = patchLines[patchIndex];
      if (line.startsWith("@@ ")) {
        patchIndex -= 1;
        break;
      }
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) {
        continue;
      }

      const marker = line[0];
      const value = line.slice(1);

      if (marker === " ") {
        if (oldLines[oldIndex] !== value) {
          return null;
        }
        output.push(value);
        oldIndex += 1;
        continue;
      }

      if (marker === "-") {
        if (oldLines[oldIndex] !== value) {
          return null;
        }
        oldIndex += 1;
        continue;
      }

      if (marker === "+") {
        output.push(value);
      }
    }
  }

  if (!sawHunk) {
    return null;
  }

  output.push(...oldLines.slice(oldIndex));
  return `${output.join("\n")}${trailingNewline ? "\n" : ""}`;
}

type SearchReplaceEdit = {
  search: string;
  replace: string;
};

type ParsedEditBlock = {
  blockText: string;
  filePath: string;
  edits: SearchReplaceEdit[];
  isNewFile: boolean;
};

type ApplyEditsSuccess = { ok: true; newContent: string };
type ApplyEditsFailure = { ok: false; reason: string };
type ApplyEditsResult = ApplyEditsSuccess | ApplyEditsFailure;

type PreparedDiffProposal = {
  block: string;
  input: CreateDiffProposalInput;
};

type FailedEditBlock = {
  block: string;
  filePath: string;
  reason: string;
};

export type DiffProposalTextResult = {
  text: string;
  diffProposals: DiffProposal[];
  diffMessages: Message[];
};

export function stripEmptyDiffBlocks(text: string): string {
  let result = text;

  // Strip legacy ```diff / ```patch fences that contain no real unified
  // diff hunk (e.g. "# No file changes proposed"). Fences with real hunks
  // are no longer parsed as DiffProposals (LLMs must use SEARCH/REPLACE)
  // but we still leave their text in place so the user can see what the
  // LLM emitted.
  result = result.replace(/```(?:diff|patch)\s*\n([\s\S]*?)```/gi, (match, body: string) => {
    return /^@@\s/m.test(body) ? match : "";
  });

  for (const pattern of EMPTY_DIFF_PATTERNS) {
    result = result.replace(pattern, "");
  }

  result = result.replace(
    /(?:^|\n)\s*(?:#\s*)?DiffProposal\s*\n(?:\s*(?:#\s*)?(?:No\s+file\s+changes?\s+proposed|本次无需修改文件|没有\s*DiffProposal|没有需要修改的文件)\s*\n?)?/gi,
    "\n"
  );

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function looksLikeFilePathLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("```")) return false;
  if (/\s/.test(trimmed)) return false;
  // Avoid grabbing markdown headings or list bullets.
  if (/^[#>*\-+]/.test(trimmed)) return false;
  return true;
}

function extractEditsFromBody(body: string): SearchReplaceEdit[] {
  const edits: SearchReplaceEdit[] = [];
  const lines = body.split("\n");
  let index = 0;

  while (index < lines.length) {
    if (lines[index].trim() !== SEARCH_MARKER) {
      index += 1;
      continue;
    }

    const searchLines: string[] = [];
    let cursor = index + 1;
    let foundDivider = false;
    while (cursor < lines.length) {
      if (lines[cursor].trim() === DIVIDER_MARKER) {
        foundDivider = true;
        break;
      }
      searchLines.push(lines[cursor]);
      cursor += 1;
    }
    if (!foundDivider) {
      return [];
    }

    const replaceLines: string[] = [];
    cursor += 1;
    let foundReplaceEnd = false;
    while (cursor < lines.length) {
      if (lines[cursor].trim() === REPLACE_MARKER) {
        foundReplaceEnd = true;
        break;
      }
      replaceLines.push(lines[cursor]);
      cursor += 1;
    }
    if (!foundReplaceEnd) {
      return [];
    }

    edits.push({
      search: searchLines.join("\n"),
      replace: replaceLines.join("\n")
    });

    index = cursor + 1;
  }

  return edits;
}

export function parseSearchReplaceBlocks(text: string): ParsedEditBlock[] {
  const blocks: ParsedEditBlock[] = [];
  const fencePattern = /(^|\n)([^\n]*)\n(```[a-zA-Z0-9_+\-]*\n)([\s\S]*?)\n(```)(?=\n|$)/g;

  for (const match of text.matchAll(fencePattern)) {
    const pathLine = match[2];
    const fenceOpen = match[3];
    const body = match[4];

    if (!body.includes(SEARCH_MARKER)) {
      continue;
    }

    if (!looksLikeFilePathLine(pathLine)) {
      continue;
    }

    const edits = extractEditsFromBody(body);
    if (edits.length === 0) {
      continue;
    }

    // A block represents a "new file" intent when every SEARCH segment is
    // empty. Mixed blocks (some empty, some not) are not allowed because
    // the file-level semantics would be ambiguous — they are dropped here
    // and surfaced as a parser-level failure further down.
    const emptySearchCount = edits.filter((edit) => edit.search.length === 0).length;
    if (emptySearchCount > 0 && emptySearchCount < edits.length) {
      continue;
    }
    const isNewFile = emptySearchCount === edits.length;
    if (isNewFile && edits.some((edit) => edit.replace.length === 0)) {
      continue;
    }

    const blockText = `${pathLine}\n${fenceOpen}${body}\n\`\`\``;
    blocks.push({
      blockText,
      filePath: pathLine.trim(),
      edits,
      isNewFile
    });
  }

  return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function trimEachLineEnd(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function applyOneEdit(
  content: string,
  edit: SearchReplaceEdit
): ApplyEditsResult {
  const normalizedSearch = edit.search.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const normalizedReplace = edit.replace.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Empty SEARCH on an empty file: treat as new-file creation. The block
  // must already have been validated as a pure new-file block upstream, so
  // a non-empty content here means the file was created between parse and
  // apply — surface a clear failure rather than silently no-oping.
  if (normalizedSearch.length === 0) {
    if (content.length === 0) {
      return { ok: true, newContent: normalizedReplace };
    }
    return {
      ok: false,
      reason: "目标文件已存在且非空，无法用空 SEARCH 块（新建语义）应用。请改用普通 SEARCH/REPLACE 块做修改。"
    };
  }

  // Strategy 1: exact substring match.
  const exactCount = countOccurrences(content, normalizedSearch);
  if (exactCount === 1) {
    return {
      ok: true,
      newContent: content.replace(normalizedSearch, () => normalizedReplace)
    };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      reason: `SEARCH 在文件中出现 ${exactCount} 次，无法定位唯一位置。请把 SEARCH 块加长，包含上下文以唯一定位。`
    };
  }

  // Strategy 2: line-end whitespace tolerance.
  const trimmedContent = trimEachLineEnd(content);
  const trimmedSearch = trimEachLineEnd(normalizedSearch);
  const trimmedCount = countOccurrences(trimmedContent, trimmedSearch);
  if (trimmedCount === 1) {
    // Locate in trimmed, then map back to original by walking lines.
    const trimmedIndex = trimmedContent.indexOf(trimmedSearch);
    const linesBefore = trimmedContent.slice(0, trimmedIndex).split("\n");
    const startLine = linesBefore.length - 1;
    const startColumn = linesBefore[linesBefore.length - 1].length;
    const searchLineCount = trimmedSearch.split("\n").length;

    const originalLines = content.split("\n");
    if (startLine + searchLineCount > originalLines.length) {
      return {
        ok: false,
        reason: "SEARCH 行尾空白容忍匹配失败：行数越界。"
      };
    }

    // Reconstruct the original chunk spanning these lines.
    const headLine = originalLines[startLine];
    const head = headLine.slice(0, startColumn);
    const lastLineIndex = startLine + searchLineCount - 1;
    const lastTrimmedLine = trimmedSearch.split("\n").at(-1) ?? "";
    const lastOriginalLine = originalLines[lastLineIndex];
    // Find lastTrimmedLine's offset inside the last original line (anchored to start).
    if (!trimEachLineEnd(lastOriginalLine).startsWith(lastTrimmedLine)) {
      return {
        ok: false,
        reason: "SEARCH 行尾空白容忍匹配失败：结尾行不一致。"
      };
    }
    const tailKeepLength = lastTrimmedLine.length;
    const tail = lastOriginalLine.slice(tailKeepLength);

    const beforeLines = originalLines.slice(0, startLine);
    const afterLines = originalLines.slice(lastLineIndex + 1);

    const replaced = [
      ...beforeLines,
      `${head}${normalizedReplace}${tail}`,
      ...afterLines
    ].join("\n");
    return { ok: true, newContent: replaced };
  }
  if (trimmedCount > 1) {
    return {
      ok: false,
      reason: `SEARCH 在文件中出现 ${trimmedCount} 次（行尾空白容忍后），无法定位唯一位置。请把 SEARCH 块加长，包含上下文以唯一定位。`
    };
  }

  const preview = normalizedSearch.slice(0, 80).replace(/\n/g, "⏎");
  return {
    ok: false,
    reason: `SEARCH 内容未在文件中找到（前 80 字符：${preview}${normalizedSearch.length > 80 ? "..." : ""}）。请先用 read_file 读取最新文件再生成 SEARCH。`
  };
}

export function applySearchReplaceEdits(
  oldContent: string,
  edits: SearchReplaceEdit[]
): ApplyEditsResult {
  let current = oldContent;
  for (let i = 0; i < edits.length; i += 1) {
    const result = applyOneEdit(current, edits[i]);
    if (!result.ok) {
      return {
        ok: false,
        reason: edits.length > 1 ? `第 ${i + 1}/${edits.length} 个 SEARCH/REPLACE：${result.reason}` : result.reason
      };
    }
    current = result.newContent;
  }
  return { ok: true, newContent: current };
}

async function prepareDiffProposalsFromBlocks(
  input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    dispatchStepId?: string;
  },
  blocks: ParsedEditBlock[],
  db: AgentHubDatabase
): Promise<{ prepared: PreparedDiffProposal[]; failed: FailedEditBlock[] }> {
  const prepared: PreparedDiffProposal[] = [];
  const failed: FailedEditBlock[] = [];

  let conversationId = input.conversationId;
  let dispatchRunId: string | undefined;
  let dispatchStepId: string | undefined;

  if (input.dispatchStepId) {
    const step = getDispatchStepById(input.dispatchStepId, db);
    const run = step ? getDispatchRunById(step.dispatchRunId, db) : null;
    if (step && run) {
      conversationId = run.conversationId;
      dispatchRunId = run.id;
      dispatchStepId = step.id;
    }
  }

  for (const block of blocks) {
    let existingContent = "";
    let relativePath = block.filePath;

    try {
      const file = await readWorkspaceFile(
        {
          workspaceId: input.workspaceId,
          conversationId,
          relativePath: block.filePath,
          agentId: input.agentId
        },
        db
      );
      existingContent = file.content;
      relativePath = file.relativePath;
    } catch (error) {
      const isMissing =
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "FILE_NOT_FOUND";
      if (!(isMissing && block.isNewFile)) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({
          block: block.blockText,
          filePath: block.filePath,
          reason: `读取文件失败：${message}`
        });
        continue;
      }
    }

    const apply = applySearchReplaceEdits(existingContent, block.edits);
    if (!apply.ok) {
      failed.push({
        block: block.blockText,
        filePath: block.filePath,
        reason: apply.reason
      });
      continue;
    }

    if (apply.newContent === existingContent) {
      failed.push({
        block: block.blockText,
        filePath: block.filePath,
        reason: "SEARCH 与 REPLACE 内容相同，未产生任何变更。"
      });
      continue;
    }

    prepared.push({
      block: block.blockText,
      input: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId,
        filePath: relativePath,
        newContent: apply.newContent,
        isNewFile: block.isNewFile,
        dispatchRunId,
        dispatchStepId
      }
    });
  }

  return { prepared, failed };
}

function buildFailureNotice(failures: FailedEditBlock[]): string {
  if (failures.length === 0) return "";
  const lines = ["⚠ 以下编辑无法应用："];
  for (const failure of failures) {
    lines.push(`- ${failure.filePath}：${failure.reason}`);
  }
  return lines.join("\n");
}

export async function createDiffProposalFromText(
  input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    text: string;
    dispatchStepId?: string;
  },
  db: AgentHubDatabase
): Promise<DiffProposalTextResult> {
  const blocks = parseSearchReplaceBlocks(input.text);

  if (blocks.length === 0) {
    return {
      text: stripEmptyDiffBlocks(input.text),
      diffProposals: [],
      diffMessages: []
    };
  }

  const { prepared, failed } = await prepareDiffProposalsFromBlocks(
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      dispatchStepId: input.dispatchStepId
    },
    blocks,
    db
  );

  const diffProposals: DiffProposal[] = [];
  const diffMessages: Message[] = [];
  const extraFailures: FailedEditBlock[] = [];

  for (const item of prepared) {
    try {
      const proposal = await createDiffProposal(item.input, db);
      diffProposals.push(proposal);
      const diffMessage = proposal.messageId
        ? getMessageById(proposal.messageId, db)
        : null;
      if (diffMessage) {
        diffMessages.push(diffMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Failed to persist DiffProposal from SEARCH/REPLACE block.", error);
      extraFailures.push({
        block: item.block,
        filePath: item.input.filePath,
        reason: `生成 DiffProposal 失败：${message}`
      });
    }
  }

  let strippedText = input.text;
  for (const block of blocks) {
    strippedText = strippedText.replace(block.blockText, "");
  }
  strippedText = stripEmptyDiffBlocks(strippedText);

  const allFailures = [...failed, ...extraFailures];
  const failureNotice = buildFailureNotice(allFailures);
  const finalText = [strippedText, failureNotice]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    text: finalText,
    diffProposals,
    diffMessages
  };
}
