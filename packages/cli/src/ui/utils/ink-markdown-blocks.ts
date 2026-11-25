/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ColumnAlign } from './TableRenderer.js';
import {
  CODE_FENCE_RE,
  isClosingCodeFence,
  splitMarkdownTableRow,
  TABLE_ROW_RE,
  TABLE_SEPARATOR_RE,
} from './pending-rendered-height.js';

const MATH_FENCE_RE = /^ *\$\$ *$/;
const HEADING_RE = /^ *(#{1,4}) +(.*)/;
const UNORDERED_ITEM_RE = /^([ \t]*)([-*+]) +(.*)/;
const ORDERED_ITEM_RE = /^([ \t]*)(\d+)\. +(.*)/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const RULE_RE = /^ *([-*_] *){3,} *$/;
const QUOTE_RE = /^ *> ?(.*)$/;

type Fence =
  | { kind: 'code'; content: string[]; info: string }
  | { kind: 'math'; content: string[] };

interface Table {
  kind: 'table';
  headers: string[];
  rows: string[][];
  aligns: ColumnAlign[];
}

type InkMarkdownBlock = { index: number } & (
  | Fence
  | (Table & { frontier: boolean })
  | { kind: 'text'; text: string; tableFallback?: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | {
      kind: 'list';
      text: string;
      marker: string;
      ordered: boolean;
      indentation: number;
      checked?: boolean;
    }
  | { kind: 'rule' }
);

/** The block boundaries used to feed Ink's inline renderer. */
export function* parseInkMarkdownBlocks(
  lines: readonly string[],
  renderVisualBlocks: boolean,
  isPending = false,
  resume?: {
    startIndex: number;
    onStableBoundary(index: number): void;
  },
): Generator<InkMarkdownBlock> {
  let fence: Fence | undefined;
  let codeDelimiter = '';
  let table: Table | undefined;

  const startIndex = resume?.startIndex ?? 0;
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!;
    // A completed blank line outside a fence or table can be resumed with
    // fresh parser state, even when more content arrives later.
    if (
      resume &&
      index > startIndex &&
      lines[index - 1]!.trim().length === 0 &&
      !fence &&
      !table
    ) {
      resume.onStableBoundary(index);
    }
    const codeMatch = CODE_FENCE_RE.exec(line);
    const mathMatch = MATH_FENCE_RE.test(line);
    if (fence) {
      const closed =
        fence.kind === 'code'
          ? isClosingCodeFence(codeMatch, codeDelimiter)
          : mathMatch;
      if (closed) {
        yield { ...fence, index };
        fence = undefined;
      } else {
        fence.content.push(line);
      }
      continue;
    }
    // A fenced block can interrupt a visual table without closing it.
    if (codeMatch) {
      codeDelimiter = codeMatch[1];
      fence = { kind: 'code', info: codeMatch[2], content: [] };
      continue;
    }
    if (renderVisualBlocks && mathMatch) {
      fence = { kind: 'math', content: [] };
      continue;
    }

    if (renderVisualBlocks) {
      const row = TABLE_ROW_RE.exec(line);
      if (table) {
        if (TABLE_SEPARATOR_RE.test(line)) {
          table.aligns = splitMarkdownTableRow(line)
            .filter((cell) => cell.length > 0)
            .map((cell) =>
              cell.startsWith(':') && cell.endsWith(':')
                ? 'center'
                : cell.endsWith(':')
                  ? 'right'
                  : 'left',
            );
          continue;
        }
        const cells = row ? splitMarkdownTableRow(row[1]) : undefined;
        if (
          isPending &&
          index === lines.length - 1 &&
          /^\s*\|/.test(line) &&
          (!cells || cells.length < table.headers.length)
        ) {
          // Hold an incomplete frontier row until it has all its columns.
          continue;
        }
        if (cells) {
          const columns = table.headers.length;
          while (cells.length < columns) cells.push('');
          table.rows.push(cells.slice(0, columns));
          continue;
        }
        if (table.rows.length) yield { ...table, index, frontier: false };
        table = undefined;
        if (line.trim())
          yield { kind: 'text', text: line, index, tableFallback: true };
        continue;
      }
      if (row) {
        const headers = splitMarkdownTableRow(row[1]);
        const separator = lines[index + 1] ?? '';
        if (
          TABLE_SEPARATOR_RE.test(separator) &&
          splitMarkdownTableRow(separator).filter((cell) => cell.length > 0)
            .length === headers.length
        ) {
          table = { kind: 'table', headers, rows: [], aligns: [] };
        } else {
          yield { kind: 'text', text: line, index, tableFallback: true };
        }
        continue;
      }
    }

    const quote = renderVisualBlocks ? QUOTE_RE.exec(line) : null;
    const heading = HEADING_RE.exec(line);
    const unordered = UNORDERED_ITEM_RE.exec(line);
    const item = unordered ?? ORDERED_ITEM_RE.exec(line);
    if (RULE_RE.test(line)) {
      yield { kind: 'rule', index };
    } else if (quote) {
      yield { kind: 'quote', index, text: quote[1] };
    } else if (heading) {
      yield {
        kind: 'heading',
        index,
        level: heading[1].length,
        text: heading[2],
      };
    } else if (item) {
      const task = renderVisualBlocks ? TASK_RE.exec(item[3]) : null;
      yield {
        kind: 'list',
        index,
        text: task ? task[2] : item[3],
        marker: item[2],
        indentation: item[1].length,
        ordered: !unordered,
        checked: task ? task[1].toLowerCase() === 'x' : undefined,
      };
    } else {
      yield { kind: 'text', index, text: line };
    }
  }

  if (fence) yield { ...fence, index: lines.length };
  // Wait for a complete row so the live table can choose its layout on first render.
  if (table?.rows.length)
    yield { ...table, index: lines.length, frontier: true };
}
