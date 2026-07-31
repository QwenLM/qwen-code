/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

const LARGE_OUTPUT_THRESHOLD = 10000;
const MAX_NOTEBOOK_OUTPUT_CHARS = 100000;

/**
 * Strip ANSI escape sequences so terminal control codes emitted by
 * ipykernel (and any tool that writes to the cell's stdout/stderr) don't
 * leak into the LLM prompt. Covers the four common families:
 *   CSI: ESC [ … final            — colour / cursor / SGR
 *   OSC: ESC ] … BEL or ST        — hyperlinks (`OSC 8`), titles
 *   DCS / APC / PM / SOS: ESC P/_/^/X … ST  — long-form sequences
 *   Lone two-byte escapes in the C1 Fe set (0x40-0x5A, 0x5C-0x5F):
 *     e.g. IND `ESC D`, NEL `ESC E`, HTS `ESC H`, RI `ESC M`.
 *     (CSI's `[` 0x5B is excluded here since it's handled above.)
 * Matching ESC (\x1B) is intentional, so disable no-control-regex here.
 */
// prettier-ignore
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[P_^X][^\x1B]*\x1B\\|[@-Z\\-_])/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, '');
}

// IANA MIME-type grammar: type "/" subtree.subtype with optional
// suffix and parameters. We accept a permissive but ASCII-printable
// shape and reject anything else (newlines, control chars, "[", "]"
// — which would let an attacker-authored notebook break out of the
// `[non-text output: ...]` placeholder and inject prompt-shaped text).
const MIME_TYPE_RE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\+[A-Za-z0-9!#$&^_.+-]+)?$/;
function sanitizeMimeTypes(keys: string[]): string[] {
  return keys.filter((k) => MIME_TYPE_RE.test(k));
}

/**
 * Jupyter Notebook cell output types.
 */
export interface NotebookCellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/**
 * Jupyter Notebook cell.
 */
export type NotebookCellType = 'code' | 'markdown' | 'raw';
export type EditableNotebookCellType = 'code' | 'markdown';

export interface NotebookCell {
  cell_type: NotebookCellType;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: NotebookCellOutput[];
  execution_count?: number | null;
  id?: string;
}

/**
 * Jupyter Notebook top-level structure.
 */
export interface NotebookContent {
  cells: NotebookCell[];
  metadata?: {
    language_info?: { name?: string };
    kernelspec?: { language?: string; display_name?: string };
    [key: string]: unknown;
  };
  nbformat?: number;
  nbformat_minor?: number;
}

export interface NotebookReadResult {
  content: string;
  isTruncated: boolean;
}

export interface NotebookJsonFormat {
  indent?: number | string;
  trailingNewline: boolean;
}

export function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

export function parseNotebook(content: string): NotebookContent {
  const jsonContent =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const parsed = JSON.parse(jsonContent) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid notebook: expected a JSON object');
  }

  const notebook = parsed as NotebookContent;
  if (!Array.isArray(notebook.cells)) {
    throw new Error('Invalid notebook: missing cells array');
  }

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      throw new Error(`Invalid notebook: cell at index ${i} is not an object`);
    }
  }

  return notebook;
}

export function inferNotebookJsonFormat(content: string): NotebookJsonFormat {
  const lineMatch = content.match(/\n([ \t]+)"/);
  const indent = lineMatch?.[1];
  let inferredIndent: number | string | undefined;
  if (indent !== undefined) {
    inferredIndent = /^ +$/.test(indent) ? indent.length : indent;
  }
  return {
    indent: inferredIndent,
    trailingNewline: content.endsWith('\n'),
  };
}

export function serializeNotebook(
  notebook: NotebookContent,
  format: NotebookJsonFormat = { indent: 1, trailingNewline: true },
): string {
  const serialized = JSON.stringify(notebook, null, format.indent);
  return format.trailingNewline ? `${serialized}\n` : serialized;
}

export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (!match?.[1]) {
    return undefined;
  }

  const index = Number.parseInt(match[1], 10);
  return Number.isNaN(index) ? undefined : index;
}

export function getCellDisplayId(cell: NotebookCell, index: number): string {
  return typeof cell.id === 'string' && cell.id.length > 0
    ? cell.id
    : `cell-${index}`;
}

export function hasStableCellIds(notebook: NotebookContent): boolean {
  return notebook.cells.every(
    (cell) => typeof cell.id === 'string' && cell.id.length > 0,
  );
}

export function findCellIndexesByDisplayId(
  notebook: NotebookContent,
  cellId: string,
): number[] {
  const indexes: number[] = [];
  notebook.cells.forEach((cell, index) => {
    if (getCellDisplayId(cell, index) === cellId) {
      indexes.push(index);
    }
  });
  return indexes;
}

export function isAmbiguousCellId(
  notebook: NotebookContent,
  cellId: string,
): boolean {
  return findCellIndexesByDisplayId(notebook, cellId).length > 1;
}

export function findCellIndex(
  notebook: NotebookContent,
  cellId: string,
): number {
  const indexes = findCellIndexesByDisplayId(notebook, cellId);
  return indexes.length === 1 ? indexes[0]! : -1;
}

export function getNotebookLanguage(notebook: NotebookContent): string {
  return (
    notebook.metadata?.language_info?.name ??
    notebook.metadata?.kernelspec?.language ??
    'python'
  );
}

export function shouldGenerateCellIds(notebook: NotebookContent): boolean {
  return (
    (notebook.nbformat ?? 0) > 4 ||
    ((notebook.nbformat ?? 0) === 4 && (notebook.nbformat_minor ?? 0) >= 5)
  );
}

export function makeCellId(notebook: NotebookContent): string | undefined {
  if (!shouldGenerateCellIds(notebook)) {
    return undefined;
  }

  const existingDisplayIds = new Set(
    notebook.cells.map((cell, index) => getCellDisplayId(cell, index)),
  );

  let fallbackIndex = 1;
  let fallback = `qwen-cell-${fallbackIndex}`;
  while (existingDisplayIds.has(fallback)) {
    fallbackIndex++;
    fallback = `qwen-cell-${fallbackIndex}`;
  }
  return fallback;
}

export function inferNotebookSourceArrayStyle(
  notebook: NotebookContent,
): boolean {
  const sourceCell = notebook.cells.find((cell) => cell.source !== undefined);
  return sourceCell ? Array.isArray(sourceCell.source) : true;
}

export function inferInsertedCellSourceArrayStyle(
  notebook: NotebookContent,
  insertAt: number,
): boolean {
  const previousCell = notebook.cells[insertAt - 1];
  if (previousCell?.source !== undefined) {
    return Array.isArray(previousCell.source);
  }

  const nextCell = notebook.cells[insertAt];
  if (nextCell?.source !== undefined) {
    return Array.isArray(nextCell.source);
  }

  return inferNotebookSourceArrayStyle(notebook);
}

export function toNotebookSource(
  source: string,
  preferArray: boolean,
): string | string[] {
  if (!preferArray) {
    return source;
  }

  if (source.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}

export function normalizeEditedCell(
  cell: NotebookCell,
  finalType: NotebookCellType,
): void {
  cell.cell_type = finalType;
  cell.metadata ??= {};

  if (finalType === 'code') {
    cell.execution_count = null;
    cell.outputs = [];
    return;
  }

  delete cell.execution_count;
  delete cell.outputs;
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return '';
  return Array.isArray(text) ? text.join('') : text;
}

/**
 * Process a single cell output into a text representation.
 * Images are skipped since the primary target models are text-only.
 */
function processOutput(output: NotebookCellOutput): string {
  switch (output.output_type) {
    case 'stream':
      return stripAnsi(processOutputText(output.text));
    case 'execute_result':
    case 'display_data': {
      const textData = output.data?.['text/plain'];
      if (typeof textData === 'string') return stripAnsi(textData);
      if (Array.isArray(textData)) return stripAnsi(textData.join(''));
      // Non-textual output (image/png, text/html, application/json, widget
      // views, ...): we don't render the payload but don't silently drop
      // it either — surface a placeholder so the LLM knows something
      // was in the cell. Filter to well-formed MIME types so a malicious
      // notebook can't inject prompt-shaped text via crafted data keys.
      const mimeTypes = output.data
        ? sanitizeMimeTypes(Object.keys(output.data))
        : [];
      if (mimeTypes.length > 0) {
        return `[non-text output: ${mimeTypes.join(', ')}]`;
      }
      return '';
    }
    case 'error': {
      const parts: string[] = [];
      if (output.ename) parts.push(output.ename);
      if (output.evalue) parts.push(output.evalue);
      if (output.traceback?.length) {
        parts.push(output.traceback.join('\n'));
      }
      // ipykernel emits ANSI colour codes in tracebacks by default.
      return stripAnsi(parts.join(': '));
    }
    default:
      return '';
  }
}

/**
 * Format a single notebook cell into a readable text block.
 */
function processCell(
  cell: NotebookCell,
  index: number,
  language: string,
): string {
  const cellId = getCellDisplayId(cell, index);
  const source = normalizeSource(cell.source);
  const parts: string[] = [];

  switch (cell.cell_type) {
    case 'code': {
      const execLabel =
        cell.execution_count != null ? ` [${cell.execution_count}]` : '';
      parts.push(`--- Code Cell ${cellId}${execLabel} ---`);
      parts.push(`\`\`\`${language}`);
      parts.push(source);
      parts.push('```');

      if (cell.outputs?.length) {
        const outputTexts = cell.outputs
          .map(processOutput)
          .filter((t) => t.length > 0);

        if (outputTexts.length > 0) {
          let combined = outputTexts.join('\n');
          if (combined.length > LARGE_OUTPUT_THRESHOLD) {
            combined =
              combined.substring(0, LARGE_OUTPUT_THRESHOLD) +
              `\n... [output truncated, total ${combined.length} chars. Use shell: cat <notebook_path> | jq '.cells[${index}].outputs']`;
          }
          parts.push('Output:');
          parts.push(combined);
        }
      }
      break;
    }
    case 'markdown':
      parts.push(`--- Markdown Cell ${cellId} ---`);
      parts.push(source);
      break;
    case 'raw':
      parts.push(`--- Raw Cell ${cellId} ---`);
      parts.push(source);
      break;
    default:
      parts.push(`--- Cell ${cellId} ---`);
      parts.push(source);
      break;
  }

  return parts.join('\n');
}

/**
 * Read and parse a Jupyter notebook file (.ipynb) into a structured text
 * representation, plus whether the cell listing was truncated.
 */
export async function readNotebookWithMetadata(
  filePath: string,
): Promise<NotebookReadResult> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const notebook = parseNotebook(raw);
  const language = getNotebookLanguage(notebook);

  if (!notebook.cells || notebook.cells.length === 0) {
    return { content: '(empty notebook)', isTruncated: false };
  }

  const header = `Jupyter Notebook (${language}, ${notebook.cells.length} cells)`;
  const cellTexts: string[] = [];
  let totalLength = header.length;
  let isTruncated = false;

  for (let i = 0; i < notebook.cells.length; i++) {
    const cellText = processCell(notebook.cells[i]!, i, language);
    totalLength += cellText.length + 2; // +2 for "\n\n" separator
    if (totalLength > MAX_NOTEBOOK_OUTPUT_CHARS) {
      isTruncated = true;
      cellTexts.push(
        `... [${notebook.cells.length - i} remaining cells truncated, total ${notebook.cells.length} cells. Use shell to inspect: cat <path> | jq '.cells[${i}:]']`,
      );
      break;
    }
    cellTexts.push(cellText);
  }

  return {
    content: `${header}\n\n${cellTexts.join('\n\n')}`,
    isTruncated,
  };
}

/**
 * Read and parse a Jupyter notebook file (.ipynb) into a structured text
 * representation. Returns a formatted string with all cells and their outputs.
 */
export async function readNotebook(filePath: string): Promise<string> {
  return (await readNotebookWithMetadata(filePath)).content;
}
