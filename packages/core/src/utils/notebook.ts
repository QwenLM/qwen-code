/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

const LARGE_OUTPUT_THRESHOLD = 10000;
const MAX_NOTEBOOK_OUTPUT_CHARS = 100000;

/**
 * Strip ANSI CSI / SGR escape sequences so terminal colour codes emitted
 * by ipykernel (e.g. in error tracebacks) don't leak into the LLM prompt.
 * Uses a conservative pattern that matches the common CSI sequences
 * without trying to be a full ANSI parser. Matching ESC (\x1B) is
 * intentional, so the no-control-regex lint rule is disabled for this
 * expression only.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Jupyter Notebook cell output types.
 */
interface NotebookCellOutput {
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
interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  outputs?: NotebookCellOutput[];
  execution_count?: number | null;
  id?: string;
}

/**
 * Jupyter Notebook top-level structure.
 */
interface NotebookContent {
  cells: NotebookCell[];
  metadata: {
    language_info?: { name?: string };
    kernelspec?: { language?: string; display_name?: string };
  };
}

function normalizeSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
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
      // was in the cell.
      const mimeTypes = output.data ? Object.keys(output.data) : [];
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
  const cellId = cell.id ?? `cell-${index}`;
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
 * representation. Returns a formatted string with all cells and their outputs.
 */
export async function readNotebook(filePath: string): Promise<string> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const notebook: NotebookContent = JSON.parse(raw);

  const language =
    notebook.metadata?.language_info?.name ??
    notebook.metadata?.kernelspec?.language ??
    'python';

  if (!notebook.cells || notebook.cells.length === 0) {
    return '(empty notebook)';
  }

  const header = `Jupyter Notebook (${language}, ${notebook.cells.length} cells)`;
  const cellTexts: string[] = [];
  let totalLength = header.length;

  for (let i = 0; i < notebook.cells.length; i++) {
    const cellText = processCell(notebook.cells[i]!, i, language);
    totalLength += cellText.length + 2; // +2 for "\n\n" separator
    if (totalLength > MAX_NOTEBOOK_OUTPUT_CHARS) {
      cellTexts.push(
        `... [${notebook.cells.length - i} remaining cells truncated, total ${notebook.cells.length} cells. Use shell to inspect: cat <path> | jq '.cells[${i}:]']`,
      );
      break;
    }
    cellTexts.push(cellText);
  }

  return `${header}\n\n${cellTexts.join('\n\n')}`;
}
