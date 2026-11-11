/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createToolFileStateCache } from '../utils/fileStateCache.js';
const fileReadState = createToolFileStateCache();
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  NotebookEditTool,
  type NotebookEditToolParams,
} from './notebook-edit.js';
import { ToolErrorType } from './tool-error.js';

vi.mock('./jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
}));

function seedFileStateCache(filePath: string, content: string): void {
  fileReadState.set(filePath, {
    content,
    timestamp: Math.floor(fs.statSync(filePath).mtimeMs),
    offset: undefined,
    limit: undefined,
  });
}

describe('NotebookEditTool', () => {
  let tempDir: string;
  let notebookPath: string;
  let tool: NotebookEditTool;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-edit-test-'));
    notebookPath = path.join(tempDir, 'test.ipynb');
    const content = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          execution_count: null,
          id: 'first',
          metadata: {},
          outputs: [],
          source: ['print("first")\n'],
        },
        {
          cell_type: 'markdown',
          id: 'second',
          metadata: {},
          source: ['second'],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });
    fs.writeFileSync(notebookPath, content);
    seedFileStateCache(notebookPath, content);

    tool = new NotebookEditTool({
      fileReadState,
      getTargetDir: () => tempDir,
      getHookSystem: () => undefined,
    } as unknown as Config);
  });

  afterEach(() => {
    fileReadState.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('does not require new_source in the top-level schema', () => {
    const schema = tool.getSchema().parametersJsonSchema as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };

    expect(schema.required).toEqual(['notebook_path']);
    expect(schema.properties['new_source'].description).toContain(
      'Not required when edit_mode is delete.',
    );
  });

  it('deletes a cell without new_source', async () => {
    const invocation = tool.build({
      notebook_path: notebookPath,
      cell_id: 'first',
      edit_mode: 'delete',
    } as NotebookEditToolParams);

    const result = await invocation.execute(new AbortController().signal);
    const notebook = JSON.parse(fs.readFileSync(notebookPath, 'utf8')) as {
      cells: Array<{ id?: string }>;
    };

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe('Deleted cell first');
    expect(result.fileWrite).toMatchObject({
      filePath: notebookPath,
      workspacePath: tempDir,
      originalContent: expect.stringContaining('"first"'),
      proposedContent: fs.readFileSync(notebookPath, 'utf8'),
      writtenContent: fs.readFileSync(notebookPath, 'utf8'),
    });
    expect(notebook.cells.map((cell) => cell.id)).toEqual(['second']);
  });

  it.each(['utf8', 'utf16le'] as const)(
    'parses and preserves a %s notebook BOM across edits',
    async (encoding) => {
      const originalContent = `\uFEFF${fs.readFileSync(notebookPath, 'utf8')}`;
      fs.writeFileSync(notebookPath, originalContent, encoding);
      seedFileStateCache(notebookPath, originalContent);

      for (const newSource of ['print("刷新")', 'print("再次刷新")']) {
        const result = await tool.build({
          notebook_path: notebookPath,
          cell_id: 'first',
          new_source: newSource,
        }).execute(new AbortController().signal);

        expect(result.error).toBeUndefined();
        const bytes = fs.readFileSync(notebookPath);
        const written = bytes.toString(encoding);
        expect(written.startsWith('\uFEFF')).toBe(true);
        expect(written.startsWith('\uFEFF\uFEFF')).toBe(false);
        const notebook = JSON.parse(written.slice(1)) as { cells: Array<{ source: string }> };
        expect(notebook.cells[0].source).toBe(newSource);
        expect(result.fileWrite?.writtenContent).toBe(written);
      }
    },
  );

  // A notebook whose metadata holds '刷新' encoded as GBK (not valid UTF-8).
  const legacyNotebook = Buffer.concat([
    Buffer.from('{"cells":[],"metadata":{"t":"'),
    Buffer.from([0xcb, 0xa2, 0xd0, 0xc2]),
    Buffer.from('"},"nbformat":4,"nbformat_minor":5}'),
  ]);

  it('refuses a non-UTF-8 notebook during parameter validation', () => {
    fs.writeFileSync(notebookPath, legacyNotebook);

    expect(() =>
      tool.build({
        notebook_path: notebookPath,
        cell_type: 'code',
        edit_mode: 'insert',
        new_source: 'x',
      } as NotebookEditToolParams),
    ).toThrow(/is not valid UTF-8.*so nothing was written/);
    expect(fs.readFileSync(notebookPath)).toEqual(legacyNotebook);
  });

  it('refuses at execution when the notebook turned non-UTF-8 after build', async () => {
    const invocation = tool.build({
      notebook_path: notebookPath,
      cell_id: 'first',
      new_source: 'print("updated")',
    } as NotebookEditToolParams);
    fs.writeFileSync(notebookPath, legacyNotebook);
    seedFileStateCache(notebookPath, legacyNotebook.toString('utf8'));

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
    expect(result.llmContent).toContain('so nothing was written');
    expect(fs.readFileSync(notebookPath)).toEqual(legacyNotebook);
  });

  it('refuses when the notebook turns non-UTF-8 during temporary-file preparation', async () => {
    const invocation = tool.build({
      notebook_path: notebookPath,
      cell_id: 'first',
      new_source: 'print("updated")',
    } as NotebookEditToolParams);
    const writeFile = fs.promises.writeFile;
    const temporaryPathPrefix = `${fs.realpathSync(notebookPath)}.tmp.`;
    let changed = false;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      await writeFile(...args);
      if (String(args[0]).startsWith(temporaryPathPrefix)) {
        changed = true;
        fs.writeFileSync(notebookPath, legacyNotebook);
      }
    });

    try {
      const result = await invocation.execute(new AbortController().signal);

      expect(changed).toBe(true);
      expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_TEXT);
      expect(result.llmContent).toContain('so nothing was written');
      expect(fs.readFileSync(notebookPath)).toEqual(legacyNotebook);
      expect(fs.readdirSync(tempDir)).toEqual(['test.ipynb']);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects an unread notebook before permission is requested', async () => {
    fileReadState.delete(notebookPath);
    const invocation = tool.build({
      notebook_path: notebookPath,
      cell_id: 'first',
      new_source: 'print("updated")',
    } as NotebookEditToolParams);

    const result = await invocation.validateBeforePermission!({
      signal: new AbortController().signal,
      fileReadState,
    });

    expect(result?.error?.message).toContain('File has not been read yet');
  });

  it('passes pre-permission validation after the notebook has been read', async () => {
    const invocation = tool.build({
      notebook_path: notebookPath,
      cell_id: 'first',
      new_source: 'print("updated")',
    } as NotebookEditToolParams);

    const result = await invocation.validateBeforePermission!({
      signal: new AbortController().signal,
      fileReadState,
    });

    expect(result).toBeUndefined();
  });

  it.each([
    ['replace', undefined],
    ['insert', 'code'],
  ] as const)(
    'requires new_source for %s mode',
    (edit_mode, cell_type) => {
      const params = {
        notebook_path: notebookPath,
        cell_id: 'first',
        edit_mode,
        ...(cell_type ? { cell_type } : {}),
      } as NotebookEditToolParams;

      expect(tool.validateToolParams(params)).toBe(
        'New source is required unless using edit_mode=delete.',
      );
    },
  );

  it.each([
    ['replace', undefined],
    ['insert', 'code'],
  ] as const)('accepts an empty new_source for %s mode', (edit_mode, cell_type) => {
    const params: NotebookEditToolParams = {
      notebook_path: notebookPath,
      cell_id: 'first',
      new_source: '',
      edit_mode,
      ...(cell_type ? { cell_type } : {}),
    };

    expect(tool.validateToolParams(params)).toBeNull();
  });
});
