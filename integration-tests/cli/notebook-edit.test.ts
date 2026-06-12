/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TestRig,
  createToolCallErrorMessage,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';

type NotebookCell = {
  id?: string;
  cell_type: 'code' | 'markdown' | 'raw';
  metadata: Record<string, unknown>;
  source: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
};

type NotebookContent = {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
};

const sourceText = (source: string | string[]) =>
  Array.isArray(source) ? source.join('') : source;

const promptPath = (filePath: string) => filePath.split(path.sep).join('/');

const readNotebook = (rig: TestRig, fileName: string): NotebookContent =>
  JSON.parse(rig.readFile(fileName)) as NotebookContent;

const baseNotebook = (cells: NotebookCell[]): NotebookContent => ({
  cells,
  metadata: {
    kernelspec: {
      display_name: 'Python 3',
      language: 'python',
      name: 'python3',
    },
    language_info: {
      name: 'python',
    },
  },
  nbformat: 4,
  nbformat_minor: 5,
});

const expectReadThenNotebookEdit = (rig: TestRig, result: string) => {
  const logs = rig.readToolLogs();
  const foundTools = logs.map((t) => t.toolRequest.name);
  const readIndex = foundTools.findIndex((name) => name === 'read_file');
  const notebookEditIndex = foundTools.findIndex(
    (name) => name === 'notebook_edit',
  );

  if (readIndex === -1 || notebookEditIndex === -1) {
    printDebugInfo(rig, result, { foundTools });
  }

  expect(
    readIndex,
    createToolCallErrorMessage('read_file', foundTools, result),
  ).toBeGreaterThanOrEqual(0);
  expect(
    notebookEditIndex,
    createToolCallErrorMessage('notebook_edit', foundTools, result),
  ).toBeGreaterThan(readIndex);
};

const expectNoSuccessfulRawNotebookWrites = (
  rig: TestRig,
  notebookFileName: string,
) => {
  const rawNotebookWrites = rig
    .readToolLogs()
    .filter(
      (log) =>
        ['edit', 'write_file'].includes(log.toolRequest.name) &&
        log.toolRequest.success &&
        log.toolRequest.args.includes(notebookFileName),
    );

  expect(rawNotebookWrites).toEqual([]);
};

describe('notebook_edit integration', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig?.cleanup();
  });

  it('replaces a code cell after reading the notebook and clears stale outputs', async () => {
    rig = new TestRig();
    await rig.setup('notebook edit replace code cell clears outputs');

    const fileName = 'analysis.ipynb';
    const notebookPath = rig.createFile(
      fileName,
      JSON.stringify(
        baseNotebook([
          {
            id: 'intro',
            cell_type: 'markdown',
            metadata: {},
            source: ['# Analysis\n'],
          },
          {
            id: 'load-data',
            cell_type: 'code',
            metadata: {},
            source: ['old_value = 1\n', 'print(old_value)\n'],
            execution_count: 7,
            outputs: [
              {
                output_type: 'stream',
                name: 'stdout',
                text: ['1\n'],
              },
            ],
          },
        ]),
        null,
        1,
      ),
    );

    const prompt = `Read the notebook at ${promptPath(notebookPath)} with read_file first.
Then use notebook_edit, not edit or write_file, to replace the code cell whose id is load-data.
Set the new source exactly to:

result = 41 + 1
print(result)

Do not change any other cell.`;

    const result = await rig.run(prompt);

    expectReadThenNotebookEdit(rig, result);
    expectNoSuccessfulRawNotebookWrites(rig, fileName);
    validateModelOutput(result, null, 'Notebook replace');

    const notebook = readNotebook(rig, fileName);
    const target = notebook.cells.find((cell) => cell.id === 'load-data');

    expect(target).toBeDefined();
    expect(target?.cell_type).toBe('code');
    expect(sourceText(target!.source).trimEnd()).toBe(
      'result = 41 + 1\nprint(result)',
    );
    expect(target?.execution_count).toBeNull();
    expect(target?.outputs).toEqual([]);
    expect(sourceText(notebook.cells[0]!.source)).toBe('# Analysis\n');
  });

  it('inserts a markdown cell and deletes a target cell using notebook_edit', async () => {
    rig = new TestRig();
    await rig.setup('notebook edit insert and delete cells');

    const fileName = 'workflow.ipynb';
    const notebookPath = rig.createFile(
      fileName,
      JSON.stringify(
        baseNotebook([
          {
            id: 'intro',
            cell_type: 'markdown',
            metadata: {},
            source: ['# Workflow\n'],
          },
          {
            id: 'remove-me',
            cell_type: 'markdown',
            metadata: {},
            source: ['This temporary cell should be deleted.\n'],
          },
          {
            id: 'calculate',
            cell_type: 'code',
            metadata: {},
            source: ['value = 10\n'],
            execution_count: null,
            outputs: [],
          },
        ]),
        null,
        1,
      ),
    );

    const insertedMarkdown =
      '## Inserted Note\nThis cell was inserted by NotebookEdit.';
    const prompt = `Read the notebook at ${promptPath(notebookPath)} with read_file first.
Then use notebook_edit, not edit or write_file, for both changes:
1. Insert a markdown cell after the cell whose id is intro. Its source must be exactly:

${insertedMarkdown}

2. Delete the cell whose id is remove-me.
Do not change the calculate code cell.`;

    const result = await rig.run(prompt);

    expectReadThenNotebookEdit(rig, result);
    expectNoSuccessfulRawNotebookWrites(rig, fileName);
    validateModelOutput(result, null, 'Notebook insert/delete');

    const successfulNotebookEdits = rig
      .readToolLogs()
      .filter(
        (log) =>
          log.toolRequest.name === 'notebook_edit' && log.toolRequest.success,
      );
    expect(successfulNotebookEdits.length).toBeGreaterThanOrEqual(2);

    const notebook = readNotebook(rig, fileName);
    const cellIds = notebook.cells.map((cell) => cell.id);
    const insertedCell = notebook.cells.find((cell) =>
      sourceText(cell.source).includes('Inserted Note'),
    );

    expect(cellIds).toHaveLength(3);
    expect(cellIds).not.toContain('remove-me');
    expect(notebook.cells[0]?.id).toBe('intro');
    expect(insertedCell).toBeDefined();
    expect(insertedCell?.cell_type).toBe('markdown');
    expect(sourceText(insertedCell!.source).trimEnd()).toBe(insertedMarkdown);
    expect(notebook.cells.at(-1)?.id).toBe('calculate');
    expect(sourceText(notebook.cells.at(-1)!.source)).toBe('value = 10\n');
  });
});
