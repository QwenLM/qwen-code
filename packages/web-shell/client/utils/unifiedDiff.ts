const MAX_DIFF_PRODUCT = 250_000;
const MAX_DIFF_LINES = 1_000;
const MAX_DIFF_CHARS = 100_000;
const OMITTED_DIFF = ' Diff omitted because it is too large to display safely.';

function splitLines(text: string): string[] {
  return text ? text.split('\n') : [];
}

export function buildUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const n = oldLines.length;
  const m = newLines.length;

  if (
    oldText.length + newText.length > MAX_DIFF_CHARS ||
    n + m > MAX_DIFF_LINES
  ) {
    return OMITTED_DIFF;
  }

  if (n * m > MAX_DIFF_PRODUCT) {
    const removed = oldLines.map((l) => (l ? `-${l}` : '-'));
    const added = newLines.map((l) => (l ? `+${l}` : '+'));
    return [...removed, ...added].join('\n');
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push(` ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${newLines[j - 1]}`);
      j--;
    } else {
      result.push(`-${oldLines[i - 1]}`);
      i--;
    }
  }

  return result.reverse().join('\n');
}

interface UnifiedDiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export function parseUnifiedDiff(diff: string): {
  lines: UnifiedDiffLine[];
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  const lines: UnifiedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffLines = diff.split('\n');
  const hasHunks = diffLines.some((line) => hunkHeader.test(line));

  for (const line of diffLines) {
    const match = line.match(hunkHeader);
    if (match) {
      oldLine = parseInt(match[1], 10);
      oldRemaining = match[2] === undefined ? 1 : parseInt(match[2], 10);
      newLine = parseInt(match[3], 10);
      newRemaining = match[4] === undefined ? 1 : parseInt(match[4], 10);
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('\\')) {
      lines.push({ type: 'header', content: line });
    } else if ((!hasHunks || newRemaining > 0) && line.startsWith('+')) {
      additions++;
      lines.push({ type: 'add', content: line.slice(1), newLine });
      newLine++;
      if (hasHunks) newRemaining--;
    } else if ((!hasHunks || oldRemaining > 0) && line.startsWith('-')) {
      deletions++;
      lines.push({ type: 'del', content: line.slice(1), oldLine });
      oldLine++;
      if (hasHunks) oldRemaining--;
    } else if (
      (!hasHunks || (oldRemaining > 0 && newRemaining > 0)) &&
      line.startsWith(' ')
    ) {
      lines.push({
        type: 'context',
        content: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine++;
      newLine++;
      if (hasHunks) {
        oldRemaining--;
        newRemaining--;
      }
    } else {
      lines.push({ type: 'header', content: line });
    }
  }

  return { lines, additions, deletions };
}
