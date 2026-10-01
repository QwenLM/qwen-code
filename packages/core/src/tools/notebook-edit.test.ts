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
      getLlmClient: vi.fn(),
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
      getMemoryFileCount: () => 0,
      setMemoryFileCount: vi.fn(),
      getToolRegistry: () => ({}) as never,
    } as unknown as Config;
    tool = new NotebookEditTool(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  const edit = (params: Parameters<NotebookEditTool['build']>[0]) =>
    buildInvocation(params).execute(abortSignal);
  const replaceLoadData = (notebook_path: string) =>
    edit({
      notebook_path,
      cell_id: 'load-data',
      new_source: 'x = 2\nprint(x)',
    });
  const editA = (notebook_path: string) =>
    edit({ notebook_path, cell_id: 'a', new_source: 'x = 2' });
  const readNotebook = (filePath: string) =>
    JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  function writeSeeded(name: string, notebook: Record<string, unknown>) {
    const filePath = writeNotebook(name, notebook);
    seedNotebookRead(filePath);
    return filePath;
  }

  // Cell and notebook literals, keys in nbformat order; `id` omitted when
  // undefined (fallback `cell-N` IDs).
  const cell = (
    cell_type: string,
    id: string | undefined,
    source: unknown,
    extra: object = {},
  ) => ({
    cell_type,
    ...(id === undefined ? {} : { id }),
    source,
    ...extra,
    metadata: {},
  });
  const nb45 = (cells: object[], metadata: object = {}) => ({
    nbformat: 4,
    nbformat_minor: 5,
    cells,
    metadata,
  });
  const bareNb = (cells: object[]) => ({ cells, metadata: {} });
  const CODE_A = cell('code', 'a', ['x = 1']);
  const PYTHON = { language_info: { name: 'python' } };
  const NO_OUTPUTS = { execution_count: null, outputs: [] };
  const STALE_OUTPUTS = {
    execution_count: 7,
    outputs: [{ output_type: 'stream', text: ['old\n'] }],
  };
  const SECRET = `token = "ghp_${'a'.repeat(36)}"`;
  // A code cell holding `source` with its execution state cleared.
  const expectFreshCode = (c: Record<string, unknown>, source: string[]) => {
    expect(c['source']).toEqual(source);
    expect(c['execution_count']).toBeNull();
    expect(c['outputs']).toEqual([]);
  };
  const teamMemoryPath = () => {
    fs.mkdirSync(path.join(tempDir, '.qwen', 'team-memory'), {
      recursive: true,
    });
    return path.join('.qwen', 'team-memory', 'analysis.ipynb');
  };

  it('replaces a code cell by real ID and clears stale outputs', async () => {
    const filePath = writeSeeded(
      'analysis.ipynb',
      nb45([cell('code', 'load-data', ['x = 1\n'], STALE_OUTPUTS)], PYTHON),
    );
    const writeSpy = vi.spyOn(
      StandardFileSystemService.prototype,
      'writeTextFile',
    );

    const result = await replaceLoadData(filePath);

    expect(result.error).toBeUndefined();
    expectFreshCode(readNotebook(filePath).cells[0], ['x = 2\n', 'print(x)']);
    expect(result.llmContent).toContain('replace cell load-data');
    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolWriteOrigin: 'notebook_edit' }),
    );
    writeSpy.mockRestore();

    const cacheState = fileReadCache.check(fs.statSync(filePath));
    expect(cacheState.state).toBe('fresh');
    if (cacheState.state === 'fresh') {
      expect(cacheState.entry.lastReadWasFull).toBe(true);
      expect(cacheState.entry.lastReadCacheable).toBe(false);
    }
  });

  it('blocks writing a secret into a team-memory notebook', async () => {
    const filePath = writeSeeded(
      teamMemoryPath(),
      nb45([cell('code', 'load-data', ['x = 1\n'], NO_OUTPUTS)], PYTHON),
    );
    const originalContent = fs.readFileSync(filePath, 'utf-8');

    // Rejected at validate/build time (parity with edit/write-file), before any
    // invocation is created — so the serialized notebook never reaches disk.
    expect(() =>
      buildInvocation({
        notebook_path: filePath,
        cell_id: 'load-data',
        new_source: SECRET,
      }),
    ).toThrow(/shared with all repository collaborators/i);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(originalContent);
  });

  it('blocks a secret in a sibling cell at execute time (full-notebook backstop)', async () => {
    // A team-memory notebook already carries a secret in one cell. Editing a
    // DIFFERENT, clean cell passes the validate-time single-cell scan, so only
    // execute()'s scan of the whole serialized notebook (the backstop
    // edit/write-file can't run on an .ipynb) catches it.
    const filePath = writeSeeded(
      teamMemoryPath(),
      nb45(
        [
          cell('code', 'creds', [SECRET], NO_OUTPUTS),
          cell('code', 'clean', ['x = 1\n'], NO_OUTPUTS),
        ],
        PYTHON,
      ),
    );
    const originalContent = fs.readFileSync(filePath, 'utf-8');

    // new_source is clean, so build() succeeds; the rejection comes from
    // execute()'s full-notebook scan, returned as an error result (not a throw).
    const result = await edit({
      notebook_path: filePath,
      cell_id: 'clean',
      new_source: 'x = 2\n',
    });

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.llmContent).toMatch(
      /shared with all repository collaborators/i,
    );
    // Blocked before any disk write — the notebook is untouched.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(originalContent);
  });

  it('replaces a code cell in a UTF-8 BOM notebook and preserves the BOM', async () => {
    const filePath = path.join(tempDir, 'bom-replace.ipynb');
    const notebook = nb45(
      [cell('code', 'load-data', ['x = 1\n'], STALE_OUTPUTS)],
      PYTHON,
    );
    fs.writeFileSync(
      filePath,
      `\ufeff${JSON.stringify(notebook, null, 1)}`,
      'utf-8',
    );
    seedNotebookRead(filePath);

    const result = await replaceLoadData(filePath);

    expect(result.error).toBeUndefined();
    const updatedBuffer = fs.readFileSync(filePath);
    expect([...updatedBuffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const updated = JSON.parse(updatedBuffer.toString('utf-8').slice(1));
    expectFreshCode(updated.cells[0], ['x = 2\n', 'print(x)']);
  });

  it('replaces by cell-N fallback and converts code to markdown cleanly', async () => {
    const filePath = writeSeeded(
      'convert.ipynb',
      nb45([
        cell('code', undefined, 'print("old")', {
          execution_count: 1,
          outputs: [{ output_type: 'stream', text: 'old\n' }],
        }),
      ]),
    );

    const result = await edit({
      notebook_path: filePath,
      cell_id: 'cell-0',
      cell_type: 'markdown',
      new_source: '# Notes',
    });

    expect(result.error).toBeUndefined();
    const updated = readNotebook(filePath);
    expect(updated.cells[0].cell_type).toBe('markdown');
    expect(updated.cells[0].source).toBe('# Notes');
    expect(updated.cells[0]).not.toHaveProperty('outputs');
    expect(updated.cells[0]).not.toHaveProperty('execution_count');
  });

  it('converts markdown to code with code-only fields', async () => {
    const filePath = writeSeeded(
      'convert-to-code.ipynb',
      nb45([cell('markdown', 'intro', ['# Intro'])]),
    );

    const result = await edit({
      notebook_path: filePath,
      cell_id: 'intro',
      cell_type: 'code',
      new_source: 'print("hi")',
    });

    expect(result.error).toBeUndefined();
    const updated = readNotebook(filePath);
    expect(updated.cells[0].cell_type).toBe('code');
    expectFreshCode(updated.cells[0], ['print("hi")']);
  });

  // Inserts a '## Inserted' markdown cell after `cell_id` via the pure API.
  const insertMarkdown = (cells: object[], cell_id: string) =>
    applyNotebookEdit(JSON.stringify(nb45(cells)), {
      notebook_path: '/tmp/insert.ipynb',
      edit_mode: 'insert',
      cell_id,
      cell_type: 'markdown',
      new_source: '## Inserted',
    });

  it('inserts after a target cell and generates an nbformat 4.5 cell ID', async () => {
    const result = insertMarkdown(
      [cell('markdown', 'cell-1', ['# A']), cell('code', 'cell-2', ['a = 1'])],
      'cell-1',
    );

    const updated = JSON.parse(result.updatedContent);
    expect(updated.cells).toHaveLength(3);
    expect(updated.cells[1].cell_type).toBe('markdown');
    expect(updated.cells[1].source).toEqual(['## Inserted']);
    expect(updated.cells[1].id).toBe('qwen-cell-1');
    expect(result.editedCellId).toBe('qwen-cell-1');
  });

  it('preserves adjacent source style for inserted cells in mixed-format notebooks', async () => {
    const result = insertMarkdown(
      [
        cell('markdown', 'intro', '# Intro'),
        cell('code', 'code', ['value = 1\n']),
      ],
      'intro',
    );
    expect(JSON.parse(result.updatedContent).cells[1].source).toBe(
      '## Inserted',
    );
  });

  it('preserves notebook JSON indentation and trailing newline style on edit', () => {
    const raw = JSON.stringify(
      nb45([cell('markdown', 'intro', '# Intro')]),
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
    const filePath = writeSeeded(
      'ambiguous.ipynb',
      nb45([
        cell('markdown', 'cell-1', ['real id']),
        cell('markdown', undefined, ['fallback id']),
      ]),
    );

    const result = await edit({
      notebook_path: filePath,
      cell_id: 'cell-1',
      new_source: 'updated',
    });

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.llmContent).toContain('ambiguous');
  });

  it('inserts at the beginning when no cell_id is provided', async () => {
    const filePath = writeSeeded('insert-start.ipynb', {
      nbformat: 4,
      nbformat_minor: 4,
      cells: [cell('code', undefined, ['x = 1'])],
      metadata: {},
    });

    const result = await edit({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_type: 'code',
      new_source: 'print("first")',
    });

    expect(result.error).toBeUndefined();
    const updated = readNotebook(filePath);
    expect(updated.cells[0].source).toEqual(['print("first")']);
    expect(updated.cells[0]).not.toHaveProperty('id');
  });

  it('deletes a cell without requiring new_source', async () => {
    const filePath = writeSeeded(
      'delete.ipynb',
      nb45([
        cell('markdown', 'keep', ['keep']),
        cell('markdown', 'drop', ['drop']),
      ]),
    );

    const result = await edit({
      notebook_path: filePath,
      edit_mode: 'delete',
      cell_id: 'drop',
    });

    expect(result.error).toBeUndefined();
    const updated = readNotebook(filePath);
    expect(updated.cells.map((c: { id: string }) => c.id)).toEqual(['keep']);
  });

  it('requires a fresh read after structural edits when fallback IDs can shift', async () => {
    const filePath = writeSeeded(
      'fallback-shift.ipynb',
      nb45([
        cell('markdown', undefined, ['A']),
        cell('markdown', undefined, ['B']),
      ]),
    );

    const result = await edit({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_type: 'markdown',
      new_source: 'inserted',
    });

    expect(result.error).toBeUndefined();
    expect(fileReadCache.check(fs.statSync(filePath)).state).toBe('unknown');
  });

  it('preserves fresh read state after structural edits when all IDs are stable', async () => {
    const filePath = writeSeeded(
      'stable-ids.ipynb',
      nb45([cell('markdown', 'a', ['A']), cell('markdown', 'b', ['B'])]),
    );

    const result = await edit({
      notebook_path: filePath,
      edit_mode: 'insert',
      cell_id: 'a',
      cell_type: 'markdown',
      new_source: 'inserted',
    });

    expect(result.error).toBeUndefined();
    const cacheState = fileReadCache.check(fs.statSync(filePath));
    expect(cacheState.state).toBe('fresh');
    if (cacheState.state === 'fresh') {
      expect(cacheState.entry.lastReadWasFull).toBe(true);
    }
  });

  it('requires a fresh full notebook read before editing', async () => {
    const result = await editA(writeNotebook('unread.ipynb', bareNb([CODE_A])));

    expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
    expect(result.llmContent).toContain('has not been fully read');
  });

  it('rejects a notebook edit terminally when the filesystem reports ino 0', async () => {
    // `ino: 0` (FAT/exFAT, some SMB mounts) makes the prior read
    // unprovable, and re-reading cannot fix it — so the model gets a
    // terminal error instead of the "read it first" instruction.
    const filePath = writeSeeded('zero-inode.ipynb', bareNb([CODE_A]));
    const nativeStat = fs.promises.stat;
    const stat = vi
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async (target: fs.PathLike) => {
        const stats = await nativeStat(target);
        if (target === filePath) {
          Object.defineProperty(stats, 'ino', { value: 0 });
        }
        return stats;
      });

    try {
      const result = await editA(filePath);

      expect(result.error?.type).toBe(
        ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      );
      expect(result.llmContent).toContain('does not provide a verifiable');
      expect(result.llmContent).toContain('Use a different mechanism');
      expect(result.llmContent).not.toContain('has not been fully read');
    } finally {
      stat.mockRestore();
    }
  });

  it('rejects edits after a truncated notebook read', async () => {
    const filePath = writeNotebook(
      'truncated-read.ipynb',
      bareNb([
        cell('code', 'visible', ['x = 1']),
        cell('code', 'tail', ['x = 2']),
      ]),
    );
    fileReadCache.recordRead(filePath, fs.statSync(filePath), {
      full: false,
      cacheable: false,
    });

    const result = await edit({
      notebook_path: filePath,
      cell_id: 'tail',
      new_source: 'x = 3',
    });

    expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
    expect(result.llmContent).toContain('too large for cell-level editing');
    expect(result.llmContent).not.toContain('without offset or limit');
  });

  it('rejects notebook directory targets with TARGET_IS_DIRECTORY', async () => {
    const dirPath = path.join(tempDir, 'directory.ipynb');
    fs.mkdirSync(dirPath);

    const result = await editA(dirPath);

    expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
    expect(result.llmContent).toContain('is a directory');
  });

  it('returns FILE_CHANGED_SINCE_READ when a notebook disappears after content read', async () => {
    const filePath = writeSeeded(
      'disappears-after-read.ipynb',
      bareNb([CODE_A]),
    );
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

    const result = await editA(filePath);

    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(result.llmContent).toContain('disappeared after it was read');
  });

  it('returns PRIOR_READ_VERIFICATION_FAILED when notebook stat verification fails', async () => {
    const filePath = writeSeeded('stat-fails.ipynb', bareNb([CODE_A]));
    const statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
    let result: ToolResult | undefined;

    try {
      result = await editA(filePath);
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

      const result = await editA(fifoPath);

      expect(result.error?.type).toBe(ToolErrorType.TARGET_NOT_REGULAR_FILE);
      expect(result.llmContent).toContain('not a regular file');
    },
  );

  it('rejects stale notebook edits after an external change', async () => {
    const filePath = writeSeeded('stale.ipynb', bareNb([CODE_A]));
    fs.writeFileSync(
      filePath,
      JSON.stringify(bareNb([cell('code', 'a', ['x = 100'])])),
      'utf-8',
    );

    const result = await editA(filePath);

    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
  });

  it('returns structured errors for missing cells and invalid JSON', async () => {
    const missingCellPath = writeSeeded('missing-cell.ipynb', bareNb([CODE_A]));

    const missingCellResult = await edit({
      notebook_path: missingCellPath,
      cell_id: 'missing',
      new_source: 'x = 2',
    });

    expect(missingCellResult.error?.type).toBe(
      ToolErrorType.NOTEBOOK_CELL_NOT_FOUND,
    );

    const invalidPath = path.join(tempDir, 'bad.ipynb');
    fs.writeFileSync(invalidPath, 'not json', 'utf-8');
    seedNotebookRead(invalidPath);

    const invalidResult = await edit({
      notebook_path: invalidPath,
      edit_mode: 'insert',
      new_source: 'x = 1',
    });

    expect(invalidResult.error?.type).toBe(ToolErrorType.NOTEBOOK_INVALID_JSON);
  });

  // Runs the modify-with-editor flow: current and proposed content for the
  // `cell a -> x = 2` edit, optionally rewritten, turned into updated params.
  async function modifiedParams(
    notebook_path: string,
    rewrite: (proposed: string) => string = (proposed) => proposed,
  ) {
    const originalParams = { notebook_path, cell_id: 'a', new_source: 'x = 2' };
    const modifyContext = tool.getModifyContext(abortSignal);
    const currentContent =
      await modifyContext.getCurrentContent(originalParams);
    const proposedContent =
      await modifyContext.getProposedContent(originalParams);
    return structuredClone(
      modifyContext.createUpdatedParams(
        currentContent,
        rewrite(proposedContent),
        originalParams,
      ),
    );
  }

  it('keeps invalid original notebook errors structured for user-modified content', async () => {
    const invalidPath = writeSeeded('bad-original.ipynb', nb45([CODE_A]));
    const updatedParams = await modifiedParams(invalidPath);
    fs.writeFileSync(invalidPath, 'not json', 'utf-8');
    seedNotebookRead(invalidPath);

    const result = await edit(updatedParams);

    expect(result.error?.type).toBe(ToolErrorType.NOTEBOOK_INVALID_JSON);
  });

  it('rejects direct attempts to set internal modified notebook content params', () => {
    const filePath = writeNotebook(
      'injected-modified-content.ipynb',
      nb45([CODE_A]),
    );

    expect(() =>
      tool.build({
        notebook_path: filePath,
        cell_id: 'a',
        new_source: 'x = 2',
        modified_notebook_content: JSON.stringify(bareNb([])),
      } as Parameters<NotebookEditTool['build']>[0]),
    ).toThrow(/additional properties|modified_notebook_content/i);
  });

  it.each([
    [
      'rejects qwenignored notebooks during validation',
      '.qwenignore',
      'ignored.ipynb',
      /ignored by \.qwenignore/,
    ],
    [
      'rejects notebooks ignored by .agentignore during validation',
      '.agentignore',
      'agent-ignored.ipynb',
      /ignored by \.agentignore/,
    ],
  ])('%s', (_title, ignoreFile, name, message) => {
    fs.writeFileSync(path.join(tempDir, ignoreFile), '*.ipynb\n', 'utf-8');
    const filePath = writeNotebook(name, bareNb([]));

    expect(() =>
      tool.build({
        notebook_path: filePath,
        edit_mode: 'insert',
        new_source: 'x = 1',
      }),
    ).toThrow(message);
  });

  it('returns a notebook diff for confirmation', async () => {
    const filePath = writeSeeded('confirm.ipynb', bareNb([CODE_A]));

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
    const filePath = writeSeeded('modified-content.ipynb', nb45([CODE_A]));

    const result = await edit(
      await modifiedParams(filePath, (proposed) =>
        proposed.replace('x = 2', 'x = 99'),
      ),
    );

    expect(result.error).toBeUndefined();
    expect(readNotebook(filePath).cells[0].source).toEqual(['x = 99']);
    expect(result.llmContent).toContain('modified by the user');
    expect(
      CommitAttributionService.getInstance().getFileAttribution(filePath),
    ).toBeUndefined();
  });

  it('uses one current-content snapshot for notebook modify previews', async () => {
    const filePath = writeNotebook('modify-snapshot.ipynb', nb45([CODE_A]));

    const params = {
      notebook_path: filePath,
      cell_id: 'a',
      new_source: 'x = 2',
    };
    const modifyContext = tool.getModifyContext(abortSignal);
    const currentContent = await modifyContext.getCurrentContent(params);
    writeNotebook(
      'modify-snapshot.ipynb',
      nb45([cell('code', 'a', ['x = 999'])]),
    );

    const proposedContent = await modifyContext.getProposedContent(params);

    expect(currentContent).toContain('x = 1');
    expect(proposedContent).toContain('x = 2');
    expect(proposedContent).not.toContain('x = 999');
  });

  it('records AI-originated notebook writes for commit attribution', async () => {
    const filePath = writeSeeded('attribution.ipynb', nb45([CODE_A]));

    const result = await editA(filePath);

    expect(result.error).toBeUndefined();
    const attribution =
      CommitAttributionService.getInstance().getFileAttribution(filePath);
    expect(attribution).toBeDefined();
    expect(attribution!.aiContribution).toBeGreaterThan(0);
    expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
  });

  it('tracks file history before the final freshness check', async () => {
    const filePath = writeSeeded('history-before-check.ipynb', nb45([CODE_A]));
    mockFileHistoryService.trackEdit.mockImplementation(async () => {
      writeNotebook(
        'history-before-check.ipynb',
        nb45([cell('code', 'a', ['x = 100'])]),
      );
    });

    const result = await editA(filePath);

    expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(readNotebook(filePath).cells[0].source).toEqual(['x = 100']);
  });
});
