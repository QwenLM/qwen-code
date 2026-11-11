/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jupyter notebook (.ipynb) reading and parsing utilities.
 */

import fs from 'node:fs';
import { truncateString } from './textUtils.js';
import { detectEncodingFromBytes } from './fileWriteUtils.js';
import { stripBOM } from './stripBom.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotebookOutputImage {
  image_data: string;
  media_type: 'image/png' | 'image/jpeg';
}

export interface NotebookCellSourceOutput {
  output_type: string;
  text?: string;
  image?: NotebookOutputImage;
}

export interface NotebookCellSource {
  cellType: string;
  source: string;
  execution_count?: number;
  cell_id: string;
  language?: string;
  outputs?: NotebookCellSourceOutput[];
}

export interface NotebookCellOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  id?: string;
  cell_type: string;
  source: string | string[];
  outputs?: NotebookCellOutput[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

export interface NotebookContent {
  cells: NotebookCell[];
  metadata: {
    language_info?: {
      name?: string;
    };
  };
  nbformat: number;
  nbformat_minor: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LARGE_OUTPUT_THRESHOLD = 10000;

/**
 * Maximum characters for truncating a single cell output text.
 * The upstream formatOutput from BashTool truncates at ~160KB.
 * We use truncateString as the equivalent.
 */
const MAX_OUTPUT_TEXT_LENGTH = 160 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLargeOutputs(
  outputs: Array<NotebookCellSourceOutput | undefined>,
): boolean {
  let size = 0;
  for (const o of outputs) {
    if (!o) continue;
    size += (o.text?.length ?? 0) + (o.image?.image_data.length ?? 0);
    if (size > LARGE_OUTPUT_THRESHOLD) return true;
  }
  return false;
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return '';
  const rawText = Array.isArray(text) ? text.join('') : text;
  return truncateString(rawText, MAX_OUTPUT_TEXT_LENGTH);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringOrStringArray(value: unknown): value is string | string[] {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  const pngData = data['image/png'];
  if (isString(pngData)) {
    return {
      image_data: pngData.replace(/\s/g, ''),
      media_type: 'image/png',
    };
  }
  const jpegData = data['image/jpeg'];
  if (isString(jpegData)) {
    return {
      image_data: jpegData.replace(/\s/g, ''),
      media_type: 'image/jpeg',
    };
  }
  return undefined;
}

function processOutput(
  output: NotebookCellOutput,
): NotebookCellSourceOutput | undefined {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      };
    case 'execute_result':
    case 'display_data': {
      const rawTextPlain = output.data?.['text/plain'];
      const textPlain = isStringOrStringArray(rawTextPlain)
        ? rawTextPlain
        : undefined;
      return {
        output_type: output.output_type,
        text: processOutputText(textPlain),
        image: output.data ? extractImage(output.data) : undefined,
      };
    }
    case 'error':
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename ?? 'Error'}: ${output.evalue ?? ''}\n${(output.traceback ?? []).join('\n')}`,
        ),
      };
    default:
      return undefined;
  }
}

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): NotebookCellSource {
  const cellId = cell.id ?? `cell-${index}`;
  const cellData: NotebookCellSource = {
    cellType: cell.cell_type,
    source: getCellSourceText(cell),
    execution_count:
      cell.cell_type === 'code' ? cell.execution_count || undefined : undefined,
    cell_id: cellId,
  };
  // Avoid giving text cells the code language.
  if (cell.cell_type === 'code') {
    cellData.language = codeLanguage;
  }

  if (cell.cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs
      .map(processOutput)
      .filter((o): o is NotebookCellSourceOutput => o !== undefined);
    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      cellData.outputs = [
        {
          output_type: 'stream',
          text: `Outputs are too large to include. Use the available shell tool with: cat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ];
    } else {
      cellData.outputs = outputs;
    }
  }

  return cellData;
}

// ---------------------------------------------------------------------------
// Formatting — convert cells to text/image parts
// ---------------------------------------------------------------------------

/**
 * Converts a processed cell into an XML-like text block.
 */
export function cellContentToText(cell: NotebookCellSource): string {
  const metadata = [];
  if (cell.cellType !== 'code') {
    metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
  }
  if (cell.language !== 'python' && cell.cellType === 'code') {
    metadata.push(`<language>${cell.language}</language>`);
  }
  return `<cell id="${cell.cell_id}">${metadata.join('')}${cell.source}</cell id="${cell.cell_id}">`;
}

/**
 * Formats cell outputs to text strings.
 */
export function cellOutputToText(
  output: NotebookCellSourceOutput,
): string | null {
  if (output.text) {
    return `\n${output.text}`;
  }
  // Images are returned separately via getNotebookImageParts
  return null;
}

/**
 * Returns image data from a cell's outputs.
 */
export function getNotebookImageParts(
  cell: NotebookCellSource,
): NotebookOutputImage[] {
  if (!cell.outputs) return [];
  return cell.outputs.filter((o) => o.image !== undefined).map((o) => o.image!);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw parsed notebook object, filling in missing top-level
 * fields with sensible defaults so downstream code never hits `undefined`.
 *
 * This is the single place where we clean up external JSON — every code path
 * that parses a .ipynb file should call this instead of casting directly.
 */
export function normalizeNotebook(
  raw: Partial<NotebookContent>,
): NotebookContent {
  return {
    cells: raw.cells ?? [],
    metadata: raw.metadata ?? {},
    nbformat: raw.nbformat ?? 4,
    nbformat_minor: raw.nbformat_minor ?? 0,
  };
}

/**
 * Reads and parses a Jupyter notebook file into processed cell data.
 *
 * @param notebookPath — absolute path to the .ipynb file
 * @param cellId — optional single-cell ID to extract
 */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<NotebookCellSource[]> {
  const buffer = await fs.promises.readFile(notebookPath);
  const content = buffer.toString(detectEncodingFromBytes(buffer));
  const notebook = normalizeNotebook(JSON.parse(stripBOM(content)));
  const language = notebook.metadata.language_info?.name ?? 'python';
  if (cellId) {
    const cell = notebook.cells.find((c) => c.id === cellId);
    if (!cell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`);
    }
    return [processCell(cell, notebook.cells.indexOf(cell), language, true)];
  }
  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  );
}

export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (match?.[1]) {
    const index = parseInt(match[1], 10);
    return isNaN(index) ? undefined : index;
  }
  return undefined;
}

/**
 * Normalizes a cell's source field (string | string[]) into a single string.
 */
export function getCellSourceText(cell: Pick<NotebookCell, 'source'>): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

/**
 * Finds a notebook cell by its ID or cell-N index format.
 * Returns the cell and its index, or undefined if not found.
 */
export function findCellByIdOrIndex(
  cells: NotebookCell[],
  cellId: string,
): { cell: NotebookCell; index: number } | undefined {
  const byIdIndex = cells.findIndex((c) => c.id === cellId);
  if (byIdIndex !== -1) return { cell: cells[byIdIndex], index: byIdIndex };

  const parsedIndex = parseCellId(cellId);
  if (parsedIndex !== undefined && cells[parsedIndex]) {
    return { cell: cells[parsedIndex], index: parsedIndex };
  }

  return undefined;
}
