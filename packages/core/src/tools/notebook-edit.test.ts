/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { CommitAttributionService } from '../services/commitAttribution.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { applyNotebookEdit, NotebookEditTool } from './notebook-edit.js';

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

describe('NotebookEditTool', () => {
  let tempDir: string;
  let fileReadCache: FileReadCache;
  let config: Config;
  let tool: NotebookEditTool;
  let mockFileHistoryService: { trackEdit: ReturnType<typeof vi.fn> };
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    CommitAttributionService.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-edit-test-'));
    fileReadCache = new FileReadCache();
    mockFileHistoryService = { trackEdit: vi.fn() };
    config = {
      getTargetDir: () => tempDir,
      getProjectRoot: () => tempDir,
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      setApprovalMode: vi.fn(),
      getWorkspaceContext: () => createMockWorkspaceContext(tempDir),
      getFileService: () => new FileDiscoveryService(tempDir),
      getFileSystemService: () => new StandardFileSystemService(),
      getDefaultFileEncoding: () => 'utf-8',
      getFileReadCache: () => fileReadCache,
      getFileHistoryService: () => mockFileHistoryService,
      getFileReadCacheDisabled: () => false,
      getGeminiClient: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getIdeMode: () => false,
      getApiKey: () => 'test-api-key',
      getModel: () => 'test-model',
      getSandbox: () => false,
      getDebugMode: () => false,
      getQuestion: () => undefined,
      getFullContext: () => false,
      getToolDiscoveryCommand: () => undefined,
      getToolCallCommand: () => undefined,
      getMcpServerCommand: () => undefined,
      getMcpServers: () => undefined,
      getUserAgent: () => 'test-agent',
      getUserMemory: () => '',
      setUserMemory: vi.fn(),
      getGeminiMdFileCount: () => 0,
      setGeminiMdFileCount: vi.fn(),
      getToolRegistry: () => ({}) as never,
    } as unknown as Config;
    tool = new NotebookEditTool(config);
  });

  afterEach(() => {
    CommitAttributionService.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeNotebook(name: string, notebook: Record<string, unknown>) {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, JSON.stringify(notebook, null, 1), 'utf-8');
    return filePath;
  }

  function seedNotebookRead(filePath: string) {
    fileReadCache.recordRead(filePath, fs.statSync(filePath), {
      full: true,
      cacheable: false,
    });
  }

  function buildInvocation(params: Parameters<NotebookEditTool['build']>[0]) {
    return tool.build(params) as ToolInvocation<
      Parameters<NotebookEditTool['build']>[0],
      ToolResult
    >;
  }

  it('replaces a code cell by real ID and clears stale outputs', async () => {
    const filePath = writeNotebook('analysis.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        {
          cell_type: 'code',
          id: 'load-data',
          source: ['x = 1\n'],
          execution_count: 7,
          outputs: [{ output_type: 'stream', text: ['old\n'] }],
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'load-data',
      new_source: 'x = 2\nprint(x)',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].source).toEqual(['x = 2\n', 'print(x)']);
    expect(updated.cells[0].execution_count).toBeNull();
    expect(updated.cells[0].outputs).toEqual([]);
    expect(result.llmContent).toContain('replace cell load-data');

    const cacheState = fileReadCache.check(fs.statSync(filePath));
    expect(cacheState.state).toBe('fresh');
    if (cacheState.state === 'fresh') {
      expect(cacheState.entry.lastReadWasFull).toBe(true);
      expect(cacheState.entry.lastReadCacheable).toBe(false);
    }
  });

  it('replaces a code cell in a UTF-8 BOM notebook and preserves the BOM', async () => {
    const filePath = path.join(tempDir, 'bom-replace.ipynb');
    fs.writeFileSync(
      filePath,
      `\ufeff${JSON.stringify(
        {
          nbformat: 4,
          nbformat_minor: 5,
          cells: [
            {
              cell_type: 'code',
              id: 'load-data',
              source: ['x = 1\n'],
              execution_count: 7,
              outputs: [{ output_type: 'stream', text: ['old\n'] }],
              metadata: {},
            },
          ],
          metadata: { language_info: { name: 'python' } },
        },
        null,
        1,
      )}`,
      'utf-8',
    );
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'load-data',
      new_source: 'x = 2\nprint(x)',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updatedBuffer = fs.readFileSync(filePath);
    expect([...updatedBuffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const updated = JSON.parse(updatedBuffer.toString('utf-8').slice(1));
    expect(updated.cells[0].source).toEqual(['x = 2\n', 'print(x)']);
    expect(updated.cells[0].execution_count).toBeNull();
    expect(updated.cells[0].outputs).toEqual([]);
  });

  it('replaces by cell-N fallback and converts code to markdown cleanly', async () => {
    const filePath = writeNotebook('convert.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        {
          cell_type: 'code',
          source: 'print("old")',
          execution_count: 1,
          outputs: [{ output_type: 'stream', text: 'old\n' }],
          metadata: {},
        },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'cell-0',
      cell_type: 'markdown',
      new_source: '# Notes',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].cell_type).toBe('markdown');
    expect(updated.cells[0].source).toBe('# Notes');
    expect(updated.cells[0]).not.toHaveProperty('outputs');
    expect(updated.cells[0]).not.toHaveProperty('execution_count');
  });

  it('converts markdown to code with code-only fields', async () => {
    const filePath = writeNotebook('convert-to-code.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro',
          source: ['# Intro'],
          metadata: {},
        },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'intro',
      cell_type: 'code',
      new_source: 'print("hi")',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].cell_type).toBe('code');
    expect(updated.cells[0].source).toEqual(['print("hi")']);
    expect(updated.cells[0].execution_count).toBeNull();
    expect(updated.cells[0].outputs).toEqual([]);
  });

  it('inserts after a target cell and generates an nbformat 4.5 cell ID', async () => {
    const raw = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: 'markdown', id: 'cell-1', source: ['# A'], metadata: {} },
        { cell_type: 'code', id: 'cell-2', source: ['a = 1'], metadata: {} },
      ],
      metadata: {},
    });

    const result = applyNotebookEdit(raw, {
      notebook_path: '/tmp/insert.ipynb',
      edit_mode: 'insert',
      cell_id: 'cell-1',
      cell_type: 'markdown',
      new_source: '## Inserted',
    });

    const updated = JSON.parse(result.updatedContent);
    expect(updated.cells).toHaveLength(3);
    expect(updated.cells[1].cell_type).toBe('markdown');
    expect(updated.cells[1].source).toEqual(['## Inserted']);
    expect(updated.cells[1].id).toBe('qwen-cell-1');
    expect(result.editedCellId).toBe('qwen-cell-1');
  });

  it('preserves adjacent source style for inserted cells in mixed-format notebooks', async () => {
    const raw = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: 'markdown', id: 'intro', source: '# Intro', metadata: {} },
        {
          cell_type: 'code',
          id: 'code',
          source: ['value = 1\n'],
          metadata: {},
        },
      ],
      metadata: {},
    });

    const result = applyNotebookEdit(raw, {
      notebook_path: '/tmp/insert.ipynb',
      edit_mode: 'insert',
      cell_id: 'intro',
      cell_type: 'markdown',
      new_source: '## Inserted',
    });

    const updated = JSON.parse(result.updatedContent);
    expect(updated.cells[1].source).toBe('## Inserted');
  });

  it('preserves notebook JSON indentation and trailing newline style on edit', () => {
    const raw = JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        cells: [
          {
            cell_type: 'markdown',
            id: 'intro',
            source: '# Intro',
            metadata: {},
          },
        ],
        metadata: {},
      },
      null,
      2,
    );

    const result = applyNotebookEdit(raw, {
      notebook_path: '/tmp/format.ipynb',
      cell_id: 'intro',
      new_source: '# Updated',
    });

    expect(result.updatedContent).toContain('\n  "cells"');
    expect(result.updatedContent.endsWith('\n')).toBe(false);
  });

  it('rejects ambiguous fallback-like cell IDs', async () => {
    const filePath = writeNotebook('ambiguous.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        {
          cell_type: 'markdown',
          id: 'cell-1',
          source: ['real id'],
          metadata: {},
        },
        {
          cell_type: 'markdown',
          source: ['fallback id'],
          metadata: {},
        },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'cell-1',
      new_source: 'updated',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.llmContent).toContain('ambiguous');
  });

  it('inserts at the beginning when no cell_id is provided', async () => {
    const filePath = writeNotebook('insert-start.ipynb', {
      nbformat: 4,
      nbformat_minor: 4,
      cells: [{ cell_type: 'code', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_type: 'code',
      new_source: 'print("first")',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].source).toEqual(['print("first")']);
    expect(updated.cells[0]).not.toHaveProperty('id');
  });

  it('deletes a cell without requiring new_source', async () => {
    const filePath = writeNotebook('delete.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: 'markdown', id: 'keep', source: ['keep'], metadata: {} },
        { cell_type: 'markdown', id: 'drop', source: ['drop'], metadata: {} },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      edit_mode: 'delete',
      cell_id: 'drop',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells.map((cell: { id: string }) => cell.id)).toEqual([
      'keep',
    ]);
  });

  it('requires a fresh read after structural edits when fallback IDs can shift', async () => {
    const filePath = writeNotebook('fallback-shift.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: 'markdown', source: ['A'], metadata: {} },
        { cell_type: 'markdown', source: ['B'], metadata: {} },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_type: 'markdown',
      new_source: 'inserted',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    expect(fileReadCache.check(fs.statSync(filePath)).state).toBe('unknown');
  });

  it('preserves fresh read state after structural edits when all IDs are stable', async () => {
    const filePath = writeNotebook('stable-ids.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: 'markdown', id: 'a', source: ['A'], metadata: {} },
        { cell_type: 'markdown', id: 'b', source: ['B'], metadata: {} },
      ],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_id: 'a',
      cell_type: 'markdown',
      new_source: 'inserted',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const cacheState = fileReadCache.check(fs.statSync(filePath));
    expect(cacheState.state).toBe('fresh');
    if (cacheState.state === 'fresh') {
      expect(cacheState.entry.lastReadWasFull).toBe(true);
    }
  });

  it('requires a fresh full notebook read before editing', async () => {
    const filePath = writeNotebook('unread.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
    expect(result.llmContent).toContain('has not been fully read');
  });

  it('rejects edits after a truncated notebook read', async () => {
    const filePath = writeNotebook('truncated-read.ipynb', {
      cells: [
        { cell_type: 'code', id: 'visible', source: ['x = 1'], metadata: {} },
        { cell_type: 'code', id: 'tail', source: ['x = 2'], metadata: {} },
      ],
      metadata: {},
    });
    fileReadCache.recordRead(filePath, fs.statSync(filePath), {
      full: false,
      cacheable: false,
    });

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'tail',
      new_source: 'x = 3',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
    expect(result.llmContent).toContain('too large for cell-level editing');
    expect(result.llmContent).not.toContain('without offset or limit');
  });

  it('rejects notebook directory targets with TARGET_IS_DIRECTORY', async () => {
    const dirPath = path.join(tempDir, 'directory.ipynb');
    fs.mkdirSync(dirPath);

    const result = await buildInvocation({
      notebook_path: dirPath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.llmContent).toContain('is a directory');
  });

  it('returns FILE_CHANGED_SINCE_READ when a notebook disappears after content read', async () => {
    const filePath = writeNotebook('disappears-after-read.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);
    const realFileSystemService = new StandardFileSystemService();
    const fileSystemService = new StandardFileSystemService();
    vi.spyOn(fileSystemService, 'readTextFile').mockImplementation(
      async (args) => {
        const result = await realFileSystemService.readTextFile(args);
        fs.unlinkSync(filePath);
        return result;
      },
    );
    vi.spyOn(config, 'getFileSystemService').mockReturnValue(fileSystemService);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(result.llmContent).toContain('disappeared after it was read');
  });

  it('returns PRIOR_READ_VERIFICATION_FAILED when notebook stat verification fails', async () => {
    const filePath = writeNotebook('stat-fails.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);
    const statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    let result: ToolResult | undefined;

    try {
      result = await buildInvocation({
        notebook_path: filePath,
        cell_id: 'a',
        new_source: 'x = 2',
      }).execute(abortSignal);
    } finally {
      statSpy.mockRestore();
    }

    expect(result?.error?.type).toBe(
      ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
    );
    expect(result?.llmContent).toContain('Could not stat');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects non-regular notebook paths with a dedicated error type',
    async () => {
      const fifoPath = path.join(tempDir, 'notebook-fifo.ipynb');
      execFileSync('mkfifo', [fifoPath]);

      const result = await buildInvocation({
        notebook_path: fifoPath,
        cell_id: 'a',
        new_source: 'x = 2',
      }).execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.TARGET_NOT_REGULAR_FILE);
      expect(result.llmContent).toContain('not a regular file');
    },
  );

  it('rejects stale notebook edits after an external change', async () => {
    const filePath = writeNotebook('stale.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        cells: [
          { cell_type: 'code', id: 'a', source: ['x = 100'], metadata: {} },
        ],
        metadata: {},
      }),
      'utf-8',
    );

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
  });

  it('returns structured errors for missing cells and invalid JSON', async () => {
    const missingCellPath = writeNotebook('missing-cell.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(missingCellPath);

    const missingCellResult = await buildInvocation({
      notebook_path: missingCellPath,
      cell_id: 'missing',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(missingCellResult.error?.type).toBe(
      ToolErrorType.NOTEBOOK_CELL_NOT_FOUND,
    );

    const invalidPath = path.join(tempDir, 'bad.ipynb');
    fs.writeFileSync(invalidPath, 'not json', 'utf-8');
    seedNotebookRead(invalidPath);

    const invalidResult = await buildInvocation({
      notebook_path: invalidPath,
      edit_mode: 'insert',
      new_source: 'x = 1',
    }).execute(abortSignal);

    expect(invalidResult.error?.type).toBe(ToolErrorType.NOTEBOOK_INVALID_JSON);
  });

  it('keeps invalid original notebook errors structured for user-modified content', async () => {
    const invalidPath = writeNotebook('bad-original.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(invalidPath);
    const originalParams = {
      notebook_path: invalidPath,
      cell_id: 'a',
      new_source: 'x = 2',
    };
    const modifyContext = tool.getModifyContext(abortSignal);
    const currentContent =
      await modifyContext.getCurrentContent(originalParams);
    const proposedContent =
      await modifyContext.getProposedContent(originalParams);
    const updatedParams = modifyContext.createUpdatedParams(
      currentContent,
      proposedContent,
      originalParams,
    );
    fs.writeFileSync(invalidPath, 'not json', 'utf-8');
    seedNotebookRead(invalidPath);

    const result = await buildInvocation(
      structuredClone(updatedParams),
    ).execute(abortSignal);

    expect(result.error?.type).toBe(ToolErrorType.NOTEBOOK_INVALID_JSON);
  });

  it('rejects direct attempts to set internal modified notebook content params', () => {
    const filePath = writeNotebook('injected-modified-content.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });

    expect(() =>
      tool.build({
        notebook_path: filePath,
        cell_id: 'a',
        new_source: 'x = 2',
        modified_notebook_content: JSON.stringify({
          cells: [],
          metadata: {},
        }),
      } as Parameters<NotebookEditTool['build']>[0]),
    ).toThrow(/additional properties|modified_notebook_content/i);
  });

  it('rejects qwenignored notebooks during validation', () => {
    fs.writeFileSync(path.join(tempDir, '.qwenignore'), '*.ipynb\n', 'utf-8');
    const filePath = writeNotebook('ignored.ipynb', {
      cells: [],
      metadata: {},
    });

    expect(() =>
      tool.build({
        notebook_path: filePath,
        edit_mode: 'insert',
        new_source: 'x = 1',
      }),
    ).toThrow(/ignored by \.qwenignore/);
  });

  it('rejects notebooks ignored by .agentignore during validation', () => {
    fs.writeFileSync(path.join(tempDir, '.agentignore'), '*.ipynb\n', 'utf-8');
    const filePath = writeNotebook('agent-ignored.ipynb', {
      cells: [],
      metadata: {},
    });

    expect(() =>
      tool.build({
        notebook_path: filePath,
        edit_mode: 'insert',
        new_source: 'x = 1',
      }),
    ).toThrow(/\.qwenignore, \.agentignore, \.aiignore/);
  });

  it('returns a notebook diff for confirmation', async () => {
    const filePath = writeNotebook('confirm.ipynb', {
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const details = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).getConfirmationDetails(abortSignal);

    const editDetails = details as Extract<typeof details, { type: 'edit' }>;
    expect(editDetails.fileDiff).toContain('-    "x = 1"');
    expect(editDetails.fileDiff).toContain('+    "x = 2"');
    expect((editDetails as { originalContent: string }).originalContent).toBe(
      fs.readFileSync(filePath, 'utf-8'),
    );
  });

  it('applies IDE or inline modified full-notebook content instead of the original cell proposal', async () => {
    const filePath = writeNotebook('modified-content.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const originalParams = {
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    };
    const modifyContext = tool.getModifyContext(abortSignal);
    const currentContent =
      await modifyContext.getCurrentContent(originalParams);
    const proposedContent =
      await modifyContext.getProposedContent(originalParams);
    const modifiedContent = proposedContent.replace('x = 2', 'x = 99');
    const updatedParams = modifyContext.createUpdatedParams(
      currentContent,
      modifiedContent,
      originalParams,
    );

    const result = await buildInvocation(
      structuredClone(updatedParams),
    ).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].source).toEqual(['x = 99']);
    expect(result.llmContent).toContain('modified by the user');
    expect(
      CommitAttributionService.getInstance().getFileAttribution(filePath),
    ).toBeUndefined();
  });

  it('uses one current-content snapshot for notebook modify previews', async () => {
    const filePath = writeNotebook('modify-snapshot.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });

    const params = {
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    };
    const modifyContext = tool.getModifyContext(abortSignal);
    const currentContent = await modifyContext.getCurrentContent(params);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          nbformat: 4,
          nbformat_minor: 5,
          cells: [
            { cell_type: 'code', id: 'a', source: ['x = 999'], metadata: {} },
          ],
          metadata: {},
        },
        null,
        1,
      ),
      'utf-8',
    );

    const proposedContent = await modifyContext.getProposedContent(params);

    expect(currentContent).toContain('x = 1');
    expect(proposedContent).toContain('x = 2');
    expect(proposedContent).not.toContain('x = 999');
  });

  it('records AI-originated notebook writes for commit attribution', async () => {
    const filePath = writeNotebook('attribution.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(result.error).toBeUndefined();
    const attribution =
      CommitAttributionService.getInstance().getFileAttribution(filePath);
    expect(attribution).toBeDefined();
    expect(attribution!.aiContribution).toBeGreaterThan(0);
    expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
  });

  it('tracks file history before the final freshness check', async () => {
    const filePath = writeNotebook('history-before-check.ipynb', {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {} }],
      metadata: {},
    });
    seedNotebookRead(filePath);
    mockFileHistoryService.trackEdit.mockImplementation(async () => {
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            nbformat: 4,
            nbformat_minor: 5,
            cells: [
              { cell_type: 'code', id: 'a', source: ['x = 100'], metadata: {} },
            ],
            metadata: {},
          },
          null,
          1,
        ),
        'utf-8',
      );
    });

    const result = await buildInvocation({
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    }).execute(abortSignal);

    expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(updated.cells[0].source).toEqual(['x = 100']);
  });
});
