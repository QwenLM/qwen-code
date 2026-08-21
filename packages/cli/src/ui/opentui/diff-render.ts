/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified-diff parsing and coloring shared by the tool-confirmation dialog
 * (pre-approval preview) and the message-list tool card (post-execution
 * result). Both are ports of ink's DiffRenderer: an all-additions diff (new
 * file) renders as the file content with a dim line-number gutter; a mixed
 * diff renders gutter + colored +/- prefix lines; the raw diff envelope
 * (Index:/===/---/+++ headers) never reaches the screen.
 */

import { C } from './theme.js';

/** One rendered diff line = a row of colored spans, so a dim line-number
 * gutter can sit next to normally colored content. */
export type DiffLine = Array<{ text: string; color: string }>;

interface ParsedDiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

// Port of ink DiffRenderer's parseDiffWithLineNumbers: hunk headers set the
// line counters; everything before the first hunk is skipped.
function parseDiffLines(diffContent: string): ParsedDiffLine[] {
  const result: ParsedDiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;
  for (const line of diffContent.split('\n')) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10) - 1;
      currentNewLine = parseInt(hunkMatch[2], 10) - 1;
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      currentNewLine++;
      result.push({
        type: 'add',
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('-')) {
      currentOldLine++;
      result.push({
        type: 'del',
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(' ')) {
      currentOldLine++;
      currentNewLine++;
      result.push({
        type: 'context',
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('\\')) {
      result.push({ type: 'other', content: line });
    }
  }
  return result;
}

/** ink DiffRenderer parity: colored, guttered lines for one unified diff. */
export function renderDiffBody(fileDiff: string): DiffLine[] {
  const parsed = parseDiffLines(fileDiff);
  const isNewFile =
    parsed.length > 0 &&
    parsed.every(
      (l) => l.type === 'add' || l.type === 'hunk' || l.type === 'other',
    );
  if (isNewFile) {
    const added = parsed.filter((l) => l.type === 'add');
    if (added.length === 0) {
      return [[{ text: 'No changes detected.', color: C.dim }]];
    }
    const gutterWidth = String(added.length).length;
    return added.map((l, i) => [
      { text: `${String(i + 1).padStart(gutterWidth)} `, color: C.dim },
      { text: l.content, color: C.text },
    ]);
  }
  const displayable = parsed.filter(
    (l) => l.type !== 'hunk' && l.type !== 'other',
  );
  if (displayable.length === 0) {
    return [[{ text: 'No changes detected.', color: C.dim }]];
  }
  const maxLineNumber = Math.max(
    0,
    ...displayable.map((l) => l.oldLine ?? 0),
    ...displayable.map((l) => l.newLine ?? 0),
  );
  const gutterWidth = Math.max(1, String(maxLineNumber).length);
  return displayable.map((l) => {
    const lineNumber = l.type === 'del' ? l.oldLine : l.newLine;
    const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    return [
      {
        text: `${String(lineNumber ?? '').padStart(gutterWidth)} `,
        color: C.dim,
      },
      {
        text: `${prefix} `,
        color: l.type === 'add' ? C.green : l.type === 'del' ? C.red : C.text,
      },
      { text: l.content, color: C.text },
    ];
  });
}
