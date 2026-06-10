type DiffLineType = "equal" | "delete" | "insert";

type DiffLine = {
  type: DiffLineType;
  line: string;
};

export type UnifiedDiffInput = {
  oldFilePath: string;
  newFilePath: string;
  oldContent: string;
  newContent: string;
};

function splitLines(content: string): string[] {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (normalizedContent.length === 0) {
    return [];
  }

  const lines = normalizedContent.split("\n");

  if (normalizedContent.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function createFullReplacementDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    ...oldLines.map((line) => ({ type: "delete" as const, line })),
    ...newLines.map((line) => ({ type: "insert" as const, line }))
  ];
}

function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const comparisonCost = oldLines.length * newLines.length;

  if (comparisonCost > 4_000_000) {
    return createFullReplacementDiff(oldLines, newLines);
  }

  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;

      table[offset] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(
              table[(oldIndex + 1) * width + newIndex],
              table[oldIndex * width + newIndex + 1]
            );
    }
  }

  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push({ type: "equal", line: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      table[(oldIndex + 1) * width + newIndex] >=
      table[oldIndex * width + newIndex + 1]
    ) {
      diff.push({ type: "delete", line: oldLines[oldIndex] });
      oldIndex += 1;
      continue;
    }

    diff.push({ type: "insert", line: newLines[newIndex] });
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    diff.push({ type: "delete", line: oldLines[oldIndex] });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diff.push({ type: "insert", line: newLines[newIndex] });
    newIndex += 1;
  }

  return diff;
}

function formatRange(start: number, count: number): string {
  if (count === 0) {
    return `${Math.max(start - 1, 0)},0`;
  }

  return count === 1 ? String(start) : `${start},${count}`;
}

export function createUnifiedDiff({
  newContent,
  newFilePath,
  oldContent,
  oldFilePath
}: UnifiedDiffInput): string {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const diff = diffLines(oldLines, newLines);
  const oldRange = formatRange(1, oldLines.length);
  const newRange = formatRange(1, newLines.length);
  const body = diff.map((entry) => {
    switch (entry.type) {
      case "equal":
        return ` ${entry.line}`;
      case "delete":
        return `-${entry.line}`;
      case "insert":
        return `+${entry.line}`;
    }
  });

  return [
    `--- a/${oldFilePath}`,
    `+++ b/${newFilePath}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...body
  ].join("\n");
}
