/**
 * Utilities for reading and processing Jupyter notebook (.ipynb) files.
 */

import fs from 'node:fs';

// --- Notebook JSON types ---------------------------------------------------

export interface NotebookContent {
  cells: NotebookCell[];
  metadata: {
    language_info?: {
      name: string;
    };
    [key: string]: unknown;
  };
  nbformat: number;
  nbformat_minor: number;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  id?: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookCellOutput[];
}

export interface NotebookCellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

// --- Processed cell types --------------------------------------------------

export interface ProcessedCell {
  cellType: string;
  source: string;
  cell_id: string;
  language?: string;
  execution_count?: number;
  outputs?: ProcessedCellOutput[];
}

export interface ProcessedCellOutput {
  output_type: string;
  text?: string;
}

// --- Constants -------------------------------------------------------------

const LARGE_OUTPUT_THRESHOLD = 10_000;

// --- Processing helpers ----------------------------------------------------

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return '';
  return Array.isArray(text) ? text.join('') : text;
}

function processOutput(output: NotebookCellOutput): ProcessedCellOutput {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      };
    case 'execute_result':
    case 'display_data': {
      const textData = output.data?.['text/plain'];
      return {
        output_type: output.output_type,
        text: processOutputText(
          typeof textData === 'string' || Array.isArray(textData)
            ? (textData as string | string[])
            : undefined,
        ),
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
      return { output_type: output.output_type };
  }
}

function isLargeOutputs(outputs: ProcessedCellOutput[]): boolean {
  let size = 0;
  for (const o of outputs) {
    size += o.text?.length ?? 0;
    if (size > LARGE_OUTPUT_THRESHOLD) return true;
  }
  return false;
}

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): ProcessedCell {
  const cellId = cell.id ?? `cell-${index}`;
  const processed: ProcessedCell = {
    cellType: cell.cell_type,
    source: joinSource(cell.source),
    cell_id: cellId,
  };

  if (cell.cell_type === 'code') {
    processed.language = codeLanguage;
    if (cell.execution_count != null) {
      processed.execution_count = cell.execution_count;
    }
  }

  if (cell.cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput);
    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      processed.outputs = [
        {
          output_type: 'stream',
          text: `[Outputs too large to display. Use run_shell_command with: cat <notebook_path> | jq '.cells[${index}].outputs']`,
        },
      ];
    } else {
      processed.outputs = outputs;
    }
  }

  return processed;
}

// --- Public API ------------------------------------------------------------

/**
 * Parse raw notebook JSON string into a NotebookContent object.
 * Throws if the content is not valid JSON.
 */
export function parseNotebook(content: string): NotebookContent {
  return JSON.parse(content) as NotebookContent;
}

/**
 * Read and parse a Jupyter notebook file, returning processed cell data.
 * If `cellId` is specified, returns only that cell.
 */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<ProcessedCell[]> {
  const content = await fs.promises.readFile(notebookPath, 'utf-8');
  const notebook = parseNotebook(content);
  const language = notebook.metadata.language_info?.name ?? 'python';

  if (cellId) {
    const index = findCellIndex(notebook, cellId);
    if (index === -1) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`);
    }
    return [processCell(notebook.cells[index]!, index, language, true)];
  }

  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  );
}

/**
 * Format processed cells as a readable text representation for the LLM.
 */
export function formatNotebookForLLM(cells: ProcessedCell[]): string {
  const parts: string[] = [];

  for (const cell of cells) {
    const metaParts: string[] = [];
    if (cell.cellType !== 'code') {
      metaParts.push(`<cell_type>${cell.cellType}</cell_type>`);
    }
    if (
      cell.language &&
      cell.language !== 'python' &&
      cell.cellType === 'code'
    ) {
      metaParts.push(`<language>${cell.language}</language>`);
    }
    const meta = metaParts.join('');
    parts.push(`<cell id="${cell.cell_id}">${meta}\n${cell.source}\n</cell>`);

    if (cell.outputs?.length) {
      const outputTexts = cell.outputs
        .filter((o) => o.text)
        .map((o) => o.text!);
      if (outputTexts.length > 0) {
        parts.push(`<output>\n${outputTexts.join('\n')}\n</output>`);
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * Parse a cell ID in the "cell-N" numeric format.
 * Returns the numeric index or undefined if the format doesn't match.
 */
export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (match?.[1]) {
    const index = parseInt(match[1], 10);
    return isNaN(index) ? undefined : index;
  }
  return undefined;
}

/**
 * Find a cell's index in the notebook by cell ID or "cell-N" format.
 * Returns -1 if not found.
 */
export function findCellIndex(
  notebook: NotebookContent,
  cellId: string,
): number {
  // Try actual cell ID first
  const idx = notebook.cells.findIndex((c) => c.id === cellId);
  if (idx !== -1) return idx;

  // Try "cell-N" numeric format
  const parsed = parseCellId(cellId);
  if (parsed !== undefined && parsed >= 0 && parsed < notebook.cells.length) {
    return parsed;
  }

  return -1;
}
