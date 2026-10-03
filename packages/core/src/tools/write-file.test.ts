/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mocked,
} from 'vitest';
import type { WriteFileToolParams } from './write-file.js';
import {
  WriteFileTool,
  buildRecordArtifactReminder,
  buildWorkspaceArtifactMetadata,
} from './write-file.js';
import { ToolErrorType } from './tool-error.js';
import type {
  FileDiff,
  ToolEditConfirmationDetails,
  ToolResult,
} from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import { clearAutoMemoryRootCache } from '../memory/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { LlmClient } from '../core/client.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

// A unique per-run root: a fixed path under os.tmpdir() breaks whenever a
// previous run by another user (e.g. a sandboxed root run on a shared CI
// runner) leaves the directory behind, EACCES-ing every write into it.
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-code-test-root-'));
const p = (...segments: string[]) => path.join(rootDir, ...segments);

// --- MOCKS ---
vi.mock('../core/client.js');

let mockLlmClientInstance: Mocked<LlmClient>;

// Mock Config
const fsService = new StandardFileSystemService();
const fileReadCache = new FileReadCache();
const mockFileHistoryService = { trackEdit: vi.fn() };
const mockConfigInternal = {
  getTargetDir: () => rootDir,
  getProjectRoot: () => rootDir,
  getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
  setApprovalMode: vi.fn(),
  getLlmClient: vi.fn(), // Initialize as a plain mock function
  getBaseLlmClient: vi.fn(), // Initialize as a plain mock function
  getFileSystemService: () => fsService,
  getWorkspaceContext: () => createMockWorkspaceContext(rootDir),
  getApiKey: () => 'test-key',
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
  getToolRegistry: () =>
    ({
      registerTool: vi.fn(),
      discoverTools: vi.fn(),
    }) as unknown as ToolRegistry,
  getDefaultFileEncoding: () => 'utf-8',
  getFileReadCache: () => fileReadCache,
  getFileReadCacheDisabled: () => false,
  getFileHistoryService: () => mockFileHistoryService,
  isRecordArtifactEnabled: vi.fn(() => false),
};
const mockConfig = mockConfigInternal as unknown as Config;

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

// --- END MOCKS ---

type ReadOpts = { full: boolean; cacheable: boolean };
const errno = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const CREATED = /Successfully created and wrote to new file/;
const html = (body: string) =>
  `<!doctype html><html><body>${body}</body></html>`;
// Kept verbatim from the original assertions (the pattern only matches a
// special character followed by `\]`, so it rarely changes anything).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
const utf8Meta = (bom: boolean) => ({
  bom,
  encoding: 'utf-8',
  lineEnding: 'lf',
});
const newFileMeta = (bom: boolean) => ({ bom, encoding: undefined });
const writeCall = (filePath: string, content: string, _meta: object) => ({
  path: filePath,
  content,
  toolWriteOrigin: 'write_file',
  _meta,
});

describe('WriteFileTool', () => {
  let tool: WriteFileTool;
  let tempDir: string;
  // Never aborted, so one signal serves every invocation.
  const abortSignal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    // fileReadCache is module-scope and shared by every test here, so clear
    // it to start each test from an empty cache. CI surfaced the leak on
    // Linux only because file-creation order across tests differs by platform.
    fileReadCache.clear();
    // A unique directory for files created outside the root.
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'write-file-test-external-'),
    );
    fs.mkdirSync(rootDir, { recursive: true });

    mockLlmClientInstance = new (vi.mocked(LlmClient))(
      mockConfig,
    ) as Mocked<LlmClient>;
    vi.mocked(LlmClient).mockImplementation(() => mockLlmClientInstance);
    mockConfigInternal.getLlmClient.mockReturnValue(mockLlmClientInstance);

    tool = new WriteFileTool(mockConfig);

    mockConfigInternal.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    mockConfigInternal.setApprovalMode.mockClear();
    mockConfigInternal.isRecordArtifactEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Simulates the model having read `filePath` earlier in the session (by
  // default fully) so prior-read enforcement does not reject the subsequent
  // overwrite. New-file creation paths do not need this.
  function seedPriorRead(
    filePath: string,
    opts: ReadOpts = { full: true, cacheable: true },
  ) {
    fileReadCache.recordRead(filePath, fs.statSync(filePath), opts);
  }

  /** Writes `name` under the root without recording a read of it. */
  function unread(name: string, content: string) {
    const filePath = p(name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Like {@link unread}, then seeds a prior read (default: full). */
  function seeded(name: string, content: string, opts?: ReadOpts) {
    const filePath = unread(name, content);
    seedPriorRead(filePath, opts);
    return filePath;
  }

  const build = (filePath: string, content: string) =>
    tool.build({ file_path: filePath, content });
  const run = (
    filePath: string,
    content: string,
    extra?: Partial<WriteFileToolParams>,
  ) =>
    tool.build({ file_path: filePath, content, ...extra }).execute(abortSignal);

  /** Builds, approves the confirmation when it offers one, then executes. */
  async function confirmAndRun(filePath: string, content: string) {
    const invocation = build(filePath, content);
    const confirmDetails = await invocation.getConfirmationDetails(abortSignal);
    if (
      typeof confirmDetails === 'object' &&
      'onConfirm' in confirmDetails &&
      confirmDetails.onConfirm
    ) {
      await confirmDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    }
    return invocation.execute(abortSignal);
  }

  const readBack = async (filePath: string) =>
    (await fsService.readTextFile({ path: filePath })).content;

  describe('description', () => {
    it('requires uncertain targets to be read before writing', () => {
      for (const phrase of [
        'A request to create or generate a file does not establish that the target path is new.',
        "Unless the target's absence or current text contents have already been established in this session",
        'MUST use the read_file tool first',
        'if the file does not exist, then create it',
        'With prior-read enforcement enabled, blind overwrites are rejected.',
      ]) {
        expect(tool.schema.description).toContain(phrase);
      }
    });
  });

  describe('build', () => {
    it('should return an invocation for a valid absolute path within root', () => {
      const params = { file_path: p('test.txt'), content: 'hello' };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('should throw an error for a relative path', () => {
      const params = { file_path: 'test.txt', content: 'hello' };
      expect(() => tool.build(params)).toThrow(/File path must be absolute/);
    });

    it('should allow a path outside root (external path support)', () => {
      const outsidePath = path.resolve(tempDir, 'outside-root.txt');
      const invocation = build(outsidePath, 'hello');
      expect(invocation).toBeDefined();
    });

    it('should throw an error if path is a directory', () => {
      const dirAsFilePath = p('a_directory');
      fs.mkdirSync(dirAsFilePath);
      expect(() => build(dirAsFilePath, 'hello')).toThrow(
        `Path is a directory, not a file: ${dirAsFilePath}`,
      );
    });

    it('should coerce null content into an empty string', () => {
      const params = {
        file_path: p('test.txt'),
        content: null,
      } as unknown as WriteFileToolParams; // Intentionally non-conforming
      expect(() => tool.build(params)).toBeDefined();
    });

    it('should throw error if the file_path is empty', () => {
      fs.mkdirSync(p('a_directory'));
      const params = { file_path: '', content: '' };
      expect(() => tool.build(params)).toThrow(`Missing or empty "file_path"`);
    });

    // On Windows, unescapePath is a no-op and backslashes are path
    // separators, so the expected unescape behavior doesn't apply.
    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        const invocation = build(p('my\\ file.txt'), 'hello');
        expect(invocation).toBeDefined();
        expect(invocation.params.file_path).toBe(p('my file.txt'));
      },
    );
  });

  describe('shouldConfirmExecute', () => {
    /** Asserts the confirmation's title, file name and proposed content. */
    async function expectWriteConfirmation(filePath: string, content: string) {
      const confirmation = (await build(
        filePath,
        content,
      ).getConfirmationDetails(abortSignal)) as ToolEditConfirmationDetails;
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Write: ${path.basename(filePath)}`,
          fileName: path.basename(filePath),
          fileDiff: expect.stringContaining(content),
        }),
      );
      return confirmation;
    }

    it('should always return ask from getDefaultPermission', async () => {
      const params = {
        file_path: p('confirm_permission_file.txt'),
        content: 'test content',
      };
      const permission = await tool.build(params).getDefaultPermission();
      expect(permission).toBe('ask');
    });

    it('auto-allows private memory writes but proposes team memory writes', async () => {
      const prev = process.env['QWEN_CODE_MEMORY_LOCAL'];
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      clearAutoMemoryRootCache();
      try {
        const permissionFor = (filePath: string) =>
          build(filePath, 'c').getDefaultPermission();
        expect(await permissionFor(p('.qwen', 'memory', 'user', 'x.md'))).toBe(
          'allow',
        );
        expect(
          await permissionFor(p('.qwen', 'team-memory', 'feedback', 'x.md')),
        ).toBe('ask');
      } finally {
        if (prev === undefined) {
          delete process.env['QWEN_CODE_MEMORY_LOCAL'];
        } else {
          process.env['QWEN_CODE_MEMORY_LOCAL'] = prev;
        }
        clearAutoMemoryRootCache();
      }
    });

    it('blocks writing a secret to a team-memory path', () => {
      const params = {
        file_path: p('.qwen', 'team-memory', 'feedback.md'),
        content: `token = ghp_${'a'.repeat(36)}`,
      };
      expect(() => tool.build(params)).toThrow(
        /shared with all repository collaborators/i,
      );
    });

    it('blocks a secret added to team-memory content before execute', async () => {
      const filePath = p('.qwen', 'team-memory', 'feedback.md');
      const invocation = build(filePath, 'clean content');
      invocation.params.content = `token = ghp_${'a'.repeat(36)}`;

      const result = await invocation.execute(abortSignal);

      expect(JSON.stringify(result)).toMatch(
        /shared with all repository collaborators/i,
      );
      // The blocked write must carry an `error` field so the framework
      // treats it as a failure, not a silent success.
      expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
      expect(result.error?.message).toMatch(
        /shared with all repository collaborators/i,
      );
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should throw if _getCorrectedFileContent returns an error', async () => {
      const filePath = p('confirm_error_file.txt');
      fs.writeFileSync(filePath, 'original', { mode: 0o000 });
      seedPriorRead(filePath);
      const readError = new Error('Simulated read error for confirmation');
      vi.spyOn(fsService, 'readTextFile').mockImplementationOnce(() =>
        Promise.reject(readError),
      );

      const invocation = build(filePath, 'test content');
      await expect(
        invocation.getConfirmationDetails(abortSignal),
      ).rejects.toThrow('Error reading existing file for confirmation');

      fs.chmodSync(filePath, 0o600);
    });

    it('should request confirmation with diff for a new file', async () => {
      const confirmation = await expectWriteConfirmation(
        p('confirm_new_file.txt'),
        'Proposed new content for confirmation.',
      );
      expect(confirmation.fileDiff).toMatch(
        /--- confirm_new_file.txt\tCurrent/,
      );
      expect(confirmation.fileDiff).toMatch(
        /\+\+\+ confirm_new_file.txt\tProposed/,
      );
    });

    it('should request confirmation with diff for an existing file', async () => {
      const originalContent = 'Original content for confirmation.';
      const filePath = seeded('confirm_existing_file.txt', originalContent);
      const confirmation = await expectWriteConfirmation(
        filePath,
        'Proposed replacement for confirmation.',
      );
      expect(confirmation.fileDiff).toMatch(escapeRe(originalContent));
    });
  });

  describe('execute', () => {
    /** Enables artifact recording, then writes `content` to `filePath`. */
    function writeArtifact(
      filePath: string,
      content: string,
      extra?: Partial<WriteFileToolParams>,
    ) {
      mockConfigInternal.isRecordArtifactEnabled.mockReturnValue(true);
      return run(filePath, content, extra);
    }

    function expectRecordedHint(result: ToolResult, workspacePath: string) {
      expect(result.llmContent).toContain('automatically recorded');
      expect(result.llmContent).toContain(`workspacePath "${workspacePath}"`);
    }

    /** `created` also asserts the write reported a new file. */
    function expectNotRecorded(result: ToolResult, created: boolean) {
      if (created) expect(result.llmContent).toContain('Successfully created');
      expect(result.llmContent).not.toContain('automatically recorded');
      expect(result.artifacts).toBeUndefined();
    }

    it('should return error if _getCorrectedFileContent returns an error during execute', async () => {
      const filePath = p('execute_error_file.txt');
      fs.writeFileSync(filePath, 'original', { mode: 0o000 });
      seedPriorRead(filePath);
      vi.spyOn(fsService, 'readTextFile').mockImplementationOnce(() => {
        const readError = new Error('Simulated read error for execute');
        return Promise.reject(readError);
      });

      const result = await run(filePath, 'test content');
      expect(result.llmContent).toContain('Error checking existing file');
      expect(result.returnDisplay).toMatch(
        /Error checking existing file: Simulated read error for execute/,
      );
      expect(result.error).toEqual({
        message:
          'Error checking existing file: Simulated read error for execute',
        type: ToolErrorType.FILE_WRITE_FAILURE,
      });

      fs.chmodSync(filePath, 0o600);
    });

    it('should write a new file and return diff', async () => {
      const filePath = p('execute_new_file.txt');
      const proposedContent = 'Proposed new content for execute.';

      const result = await confirmAndRun(filePath, proposedContent);

      expect(result.llmContent).toMatch(CREATED);
      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(await readBack(filePath)).toBe(proposedContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_new_file.txt');
      expect(display.filePath).toBe(filePath);
      expect(display.fileDiff).toMatch(/--- execute_new_file.txt\tOriginal/);
      expect(display.fileDiff).toMatch(/\+\+\+ execute_new_file.txt\tWritten/);
      expect(display.fileDiff).toMatch(escapeRe(proposedContent));
    });

    it('records artifact-like workspace files in the tool result', async () => {
      const content = html('Weather');
      const result = await writeArtifact(p('reports', 'weather.html'), content);

      expectRecordedHint(result, 'reports/weather.html');
      expect(result.artifacts).toEqual([
        {
          title: 'weather.html',
          kind: 'html',
          storage: 'workspace',
          workspacePath: 'reports/weather.html',
          mimeType: 'text/html',
          sizeBytes: Buffer.byteLength(content),
        },
      ]);
    });

    it('records case-insensitive artifact extensions', async () => {
      const result = await writeArtifact(
        p('reports', 'dashboard.HTML'),
        html('Dashboard'),
      );

      expectRecordedHint(result, 'reports/dashboard.HTML');
      expect(result.artifacts?.[0]).toMatchObject({
        title: 'dashboard.HTML',
        kind: 'html',
        storage: 'workspace',
        workspacePath: 'reports/dashboard.HTML',
        mimeType: 'text/html',
      });
    });

    it.each([
      ['page.htm', 'html'],
      ['notebook.ipynb', 'notebook'],
      ['paper.pdf', 'pdf'],
      ['photo.png', 'image'],
      ['photo.jpeg', 'image'],
      ['photo.jpg', 'image'],
      ['diagram.svg', 'image'],
      ['photo.webp', 'image'],
      ['table.csv', 'file'],
      ['table.xlsx', 'document'],
      ['brief.docx', 'document'],
      ['deck.pptx', 'document'],
    ])('infers artifact kind for %s as %s', async (fileName, expectedKind) => {
      const result = await writeArtifact(
        p('reports', fileName),
        'artifact content',
      );

      expect(result.artifacts?.[0]).toMatchObject({
        title: fileName,
        kind: expectedKind,
        storage: 'workspace',
        workspacePath: `reports/${fileName}`,
      });
    });

    it('sets application/x-ipynb+json mimeType for notebooks', async () => {
      const result = await writeArtifact(
        p('notes', 'analysis.ipynb'),
        '{"cells":[]}',
      );

      expect(result.artifacts?.[0]).toMatchObject({
        kind: 'notebook',
        mimeType: 'application/x-ipynb+json',
      });
    });

    it('does not record intermediate files when record_as_artifact is false', async () => {
      const result = await writeArtifact(p('alibaba.html'), html('Alibaba'), {
        record_as_artifact: false,
      });
      expectNotRecorded(result, true);
    });

    it('does not record intermediate files written under .qwen/tmp', async () => {
      const result = await writeArtifact(
        p('.qwen', 'tmp', 'alibaba.html'),
        html('Alibaba'),
      );
      expectNotRecorded(result, true);
    });

    it('does not record artifact-like files when artifact recording is disabled', async () => {
      mockConfigInternal.isRecordArtifactEnabled.mockReturnValue(false);
      const result = await run(p('reports', 'weather.html'), html('Weather'));
      expectNotRecorded(result, false);
    });

    it('does not record artifacts whose filename contains unsafe markup', async () => {
      const result = await writeArtifact(
        p('reports', 'chart onerror=alert(1).html'),
        html('XSS'),
      );
      expectNotRecorded(result, true);
    });

    it('does not record artifacts whose title exceeds 200 characters', async () => {
      const result = await writeArtifact(
        p('reports', 'a'.repeat(196) + '.html'),
        html('Long'),
      );
      expectNotRecorded(result, true);
    });

    it('does not record artifacts whose workspace path contains unsafe markup', async () => {
      fs.mkdirSync(p('Q&amp;A'), { recursive: true });
      const result = await writeArtifact(
        p('Q&amp;A', 'summary.html'),
        html('Summary'),
      );
      expectNotRecorded(result, true);
    });

    it('does not record ordinary source files as artifacts', async () => {
      const result = await writeArtifact(
        p('src', 'index.ts'),
        'export const value = 1;\n',
      );
      expectNotRecorded(result, false);
    });

    it('does not record files outside the workspace as artifacts', async () => {
      const result = await writeArtifact(
        path.join(tempDir, 'outside.html'),
        html('Outside'),
      );
      expectNotRecorded(result, false);
    });

    it('records workspace-root-relative path inside a worktree', async () => {
      const worktreeDir = p('.qwen', 'worktrees', 'my-feature');
      fs.mkdirSync(worktreeDir, { recursive: true });
      const originalGetTargetDir = mockConfigInternal.getTargetDir;
      mockConfigInternal.getTargetDir = () => worktreeDir;
      try {
        const result = await writeArtifact(
          path.join(worktreeDir, 'report.html'),
          html('Report'),
        );

        expectRecordedHint(result, '.qwen/worktrees/my-feature/report.html');
        expect(result.artifacts?.[0]).toMatchObject({
          title: 'report.html',
          kind: 'html',
          storage: 'workspace',
          workspacePath: '.qwen/worktrees/my-feature/report.html',
          mimeType: 'text/html',
        });
      } finally {
        mockConfigInternal.getTargetDir = originalGetTargetDir;
      }
    });

    // trackEdit is best-effort: a FileHistoryService failure (disk full,
    // permissions, corrupted state) must never break the write_file tool.
    it('completes the write even when trackEdit throws', async () => {
      const filePath = p('write_when_trackedit_fails.txt');
      const proposedContent = 'Content that survives trackEdit failure.';
      mockFileHistoryService.trackEdit.mockRejectedValueOnce(
        new Error('disk full'),
      );

      const result = await confirmAndRun(filePath, proposedContent);

      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      expect(result.llmContent).toMatch(CREATED);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(await readBack(filePath)).toBe(proposedContent);
    });

    // Pins the upstream-aligned ordering: trackEdit MUST run before the
    // pre-write checkPriorRead. Upstream `claude-code/src/tools/FileEditTool`:
    // "These awaits must stay OUTSIDE the critical section below — a yield
    // between the staleness check and writeTextContent lets concurrent edits
    // interleave." A multi-hundred-ms trackEdit between checkPriorRead and
    // writeTextFile widens the stat-then-write race window. Here trackEdit
    // mutates the file; only the correct order catches it (the broken order
    // checks pre-mutation stats, then silently clobbers the change).
    // Asserting `result.error` pins the invariant, not a call-order proxy, so
    // it survives refactors that shift the number of `cache.check` calls.
    it('backs up before the pre-write freshness check (TOCTOU ordering)', async () => {
      const initialContent = 'pre-existing content';
      const filePath = seeded('toctou_ordering.txt', initialContent);

      mockFileHistoryService.trackEdit.mockImplementation(async () => {
        // An external write landing while trackEdit copies the file. +5 s
        // is reliably "newer" under the cache's ~1 s macOS mtime granularity.
        const newTime = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, newTime, newTime);
      });

      const result = await confirmAndRun(filePath, 'new content');

      // trackEdit fired, the pre-write check caught its mutation (proving
      // the order), and the file was rejected rather than overwritten.
      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(initialContent);
    });

    it('should overwrite an existing file and return diff', async () => {
      const initialContent = 'Initial content for execute.';
      const proposedContent = 'Proposed overwrite for execute.';
      const filePath = seeded('execute_existing_file.txt', initialContent);

      const result = await confirmAndRun(filePath, proposedContent);

      expect(result.llmContent).toMatch(/Successfully overwrote file/);
      expect(await readBack(filePath)).toBe(proposedContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_existing_file.txt');
      expect(display.filePath).toBe(filePath);
      expect(display.fileDiff).toMatch(escapeRe(initialContent));
      expect(display.fileDiff).toMatch(escapeRe(proposedContent));
    });

    it('should treat metadata ENOENT as new file when readTextFile returned empty content', async () => {
      const filePath = p('execute_acp_like_missing_file.txt');
      const proposedContent = 'content from acp-like flow';
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');
      // The file does not exist and readTextFile throws ENOENT.
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce(
        errno('File not found', 'ENOENT'),
      );

      const result = await run(filePath, proposedContent);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(CREATED);
      expect(writeSpy).toHaveBeenCalledWith(
        writeCall(filePath, proposedContent, newFileMeta(false)),
      );
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(proposedContent);
    });

    it('should create directory if it does not exist', async () => {
      const dirPath = p('new_dir_for_write');
      const filePath = path.join(dirPath, 'file_in_new_dir.txt');
      const content = 'Content in new directory';

      await confirmAndRun(filePath, content);

      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('should include modification message when proposed content is modified', async () => {
      const result = await run(
        p('new_file_modified.txt'),
        'New file content modified by user',
        { modified_by_user: true },
      );
      expect(result.llmContent).toMatch(/User modified the `content`/);
    });

    it('should not include modification message when proposed content is not modified', async () => {
      const result = await run(
        p('new_file_unmodified.txt'),
        'New file content not modified',
        { modified_by_user: false },
      );
      expect(result.llmContent).not.toMatch(/User modified the `content`/);
    });

    it('should not include modification message when modified_by_user is not provided', async () => {
      const result = await run(
        p('new_file_unmodified.txt'),
        'New file content not modified',
      );
      expect(result.llmContent).not.toMatch(/User modified the `content`/);
    });

    // On Windows, unescapePath is a no-op and backslashes are path
    // separators, so shell-escaping behavior doesn't apply.
    it.skipIf(process.platform === 'win32')(
      'should write to a file with spaces in its name when given an escaped path',
      async () => {
        const realPath = p('my spaced write.txt');
        const content = 'Written via escaped path.';

        const result = await confirmAndRun(
          p('my\\ spaced\\ write.txt'),
          content,
        );

        // Succeeds, creating the file at the unescaped (real) path.
        expect(result.llmContent).toMatch(/Successfully created and wrote/);
        expect(fs.existsSync(realPath)).toBe(true);
        expect(fs.readFileSync(realPath, 'utf8')).toBe(content);
      },
    );
  });

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      const params = { file_path: p('file.txt'), content: 'test content' };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should allow paths outside workspace root (external path support)', () => {
      const invocation = build('/etc/passwd', 'test');
      expect(invocation).toBeDefined();
    });
  });

  describe('specific error types for write failures', () => {
    /** Makes the next writeTextFile reject with `error`, then writes. */
    function runWithWriteError(filePath: string, error: unknown) {
      vi.spyOn(fsService, 'writeTextFile').mockRejectedValueOnce(error);
      return run(filePath, 'test content');
    }

    async function expectWriteFailure(
      filePath: string,
      error: unknown,
      type: ToolErrorType,
      message: string,
    ) {
      const result = await runWithWriteError(filePath, error);
      expect(result.error?.type).toBe(type);
      expect(result.llmContent).toContain(message);
      expect(result.returnDisplay).toContain(message);
    }

    it('should return PERMISSION_DENIED error when write fails with EACCES', async () => {
      const filePath = p('permission_denied_file.txt');
      await expectWriteFailure(
        filePath,
        errno('Permission denied', 'EACCES'),
        ToolErrorType.PERMISSION_DENIED,
        `Permission denied writing to file: ${filePath} (EACCES)`,
      );
    });

    it('should return NO_SPACE_LEFT error when write fails with ENOSPC', async () => {
      const filePath = p('no_space_file.txt');
      await expectWriteFailure(
        filePath,
        errno('No space left on device', 'ENOSPC'),
        ToolErrorType.NO_SPACE_LEFT,
        `No space left on device: ${filePath} (ENOSPC)`,
      );
    });

    it('should return TARGET_IS_DIRECTORY error when write fails with EISDIR', async () => {
      const dirPath = p('test_directory');
      // Pretend the directory doesn't exist to bypass validation.
      const originalExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((target) =>
        target === dirPath ? false : originalExistsSync(target as string),
      );

      await expectWriteFailure(
        dirPath,
        errno('Is a directory', 'EISDIR'),
        ToolErrorType.TARGET_IS_DIRECTORY,
        `Target is a directory, not a file: ${dirPath} (EISDIR)`,
      );

      vi.spyOn(fs, 'existsSync').mockImplementation(originalExistsSync);
    });

    it('should return FILE_WRITE_FAILURE for generic write errors', async () => {
      // Ensure fs.existsSync is not mocked for this test
      vi.restoreAllMocks();
      await expectWriteFailure(
        p('generic_error_file.txt'),
        new Error('Generic write error'),
        ToolErrorType.FILE_WRITE_FAILURE,
        'Error writing to file: Generic write error',
      );
    });

    it('should include cause details for non-Node write errors', async () => {
      vi.restoreAllMocks();
      const cause = errno('', 'ECONNREFUSED');
      await expectWriteFailure(
        p('write_error_with_cause.txt'),
        new TypeError('fetch failed', { cause }),
        ToolErrorType.FILE_WRITE_FAILURE,
        'Error writing to file: fetch failed (cause: ECONNREFUSED)',
      );
    });

    it('should surface plain object write error messages without object stringification', async () => {
      vi.restoreAllMocks();
      const result = await runWithWriteError(p('plain_object_error_file.txt'), {
        message: 'Plain object write error',
      });

      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
      expect(result.llmContent).toContain(
        'Error writing to file: Plain object write error',
      );
      expect(result.llmContent).not.toContain('[object Object]');
    });
  });

  describe('BOM preservation (Issue #1672)', () => {
    /** Writes 'new content' and asserts writeTextFile received `_meta`. */
    async function expectWrittenWithMeta(filePath: string, _meta: object) {
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');
      await run(filePath, 'new content');
      expect(writeSpy).toHaveBeenCalledWith(
        writeCall(filePath, 'new content', _meta),
      );
    }

    it('should preserve BOM when overwriting existing file with BOM', async () => {
      // U+FEFF is written as the UTF-8 BOM bytes EF BB BF.
      const filePath = seeded('bom_file.txt', '\ufefforiginal content');
      await expectWrittenWithMeta(filePath, utf8Meta(true));
    });

    it('should not add BOM when overwriting existing file without BOM', async () => {
      const filePath = seeded('no_bom_file.txt', 'original content');
      await expectWrittenWithMeta(filePath, utf8Meta(false));
    });

    it('should use default encoding for new files', async () => {
      // The default is utf-8, so no BOM.
      await expectWrittenWithMeta(p('new_file.txt'), newFileMeta(false));
    });

    it('should use BOM for new files when defaultFileEncoding is utf-8-bom', async () => {
      const originalGetDefaultFileEncoding =
        mockConfigInternal.getDefaultFileEncoding;
      mockConfigInternal.getDefaultFileEncoding = () => 'utf-8-bom';

      await expectWrittenWithMeta(p('new_file_bom.txt'), newFileMeta(true));

      mockConfigInternal.getDefaultFileEncoding =
        originalGetDefaultFileEncoding;
    });

    it('records a write into the FileReadCache', async () => {
      // Symmetric with EditTool's "records a write" test: ReadFile's
      // post-write guard must observe lastWriteAt and skip the
      // file_unchanged placeholder for files these tools just mutated.
      fileReadCache.clear();
      const filePath = p('cache-marker.txt');

      const result = await run(filePath, 'fresh bytes');
      expect(result.error).toBeUndefined();

      const status = fileReadCache.check(fs.statSync(filePath));
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastWriteAt).toBeDefined();
      }
    });
  });

  // Same as edit.test's wiring guard: the WriteFileTool feeds the
  // commit-attribution singleton on success. recordEdit distinguishes a
  // true file creation (`null` old content) from overwriting an existing
  // empty file (`''` old content); these tests pin both shapes so the
  // distinction can't drift silently.
  describe('commit-attribution wiring', () => {
    beforeEach(() => {
      CommitAttributionService.resetInstance();
    });

    const attributionFor = (filePath: string) =>
      CommitAttributionService.getInstance().getFileAttribution(filePath);

    it('records AI-originated writes in the attribution service', async () => {
      const filePath = p('attr_write.txt');
      await run(filePath, 'fresh content');

      const attribution = attributionFor(filePath);
      expect(attribution).toBeDefined();
      expect(attribution!.aiContribution).toBeGreaterThan(0);
      // A truly new file is flagged so later deletions in the session can
      // be reconciled.
      expect(attribution!.aiCreated).toBe(true);

      fs.unlinkSync(filePath);
    });

    it('skips attribution when modified_by_user', async () => {
      const filePath = p('attr_skip.txt');
      await run(filePath, 'human-edited', { modified_by_user: true });

      expect(attributionFor(filePath)).toBeUndefined();

      fs.unlinkSync(filePath);
    });

    it('marks aiCreated=false when overwriting an existing empty file', async () => {
      // Overwriting an empty existing file must NOT count as a creation,
      // even though both old contents are length-0. The seeded read
      // satisfies prior-read enforcement (origin/main #3774).
      const filePath = seeded('attr_existing_empty.txt', '');
      await run(filePath, 'overwrite content');

      const attribution = attributionFor(filePath);
      expect(attribution).toBeDefined();
      expect(attribution!.aiCreated).toBe(false);

      fs.unlinkSync(filePath);
    });
  });

  describe('prior-read enforcement', () => {
    it('rejects a write that would overwrite an unread existing file', async () => {
      // No seedPriorRead: the model has not Read this file in the session.
      const filePath = unread('enforce-overwrite.txt', 'untouched bytes');
      // Enforcement must run *before* any I/O against the file's contents
      // (see the L4 review comment).
      const readSpy = vi.spyOn(fsService, 'readTextFile');

      const result = await run(filePath, 'clobber attempt');

      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.message).toMatch(
        /has not been read in this session/,
      );
      // The file keeps its content and was never slurped into memory.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('untouched bytes');
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
    });

    it('rejects an overwrite terminally when the filesystem reports ino 0', async () => {
      // As in the EditTool case: `ino: 0` means the cache cannot prove which
      // file was read, and re-reading cannot change that, so the rejection
      // must be terminal rather than an instruction to re-read.
      const filePath = seeded('enforce-zero-inode.txt', 'untouched bytes');
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
        const result = await run(filePath, 'clobber attempt');

        expect(result.error?.type).toBe(
          ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
        );
        expect(result.error?.message).toMatch(/does not provide a verifiable/);
        expect(result.error?.message).toMatch(/overwrite this file/);
        expect(result.error?.message).not.toMatch(/Re-read it with/);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('untouched bytes');
      } finally {
        stat.mockRestore();
      }
    });

    it('allows a write after a ranged (offset/limit) read', async () => {
      // Aligns WriteFile with EditTool and Claude Code's `readFileState`:
      // any prior read clears enforcement. Requiring a full read for
      // overwrite deadlocked files larger than the truncate-tool-output
      // limit, where read_file without offset/limit still truncates and the
      // "fully read" precondition was unsatisfiable (issue #3945). The
      // mtime/size drift check distinguishes "model has seen current bytes"
      // from "older bytes", identically for Edit and WriteFile.
      const filePath = seeded('enforce-ranged.txt', 'unchanged', {
        full: false,
        cacheable: true,
      });

      const result = await run(filePath, 'clobber');
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('clobber');
    });

    it('allows a write after a truncated full read (issue #3945 deadlock fix)', async () => {
      // Pre-fix, read_file without offset/limit past the truncate-tool-output
      // limit recorded `lastReadWasFull: false` (the model saw only the
      // head), WriteFile's `requireFullRead: true` rejected the overwrite
      // ("only been partially read … re-read without offset / limit /
      // pages"), and a re-read truncated again: deadlock. With it dropped
      // (aligning with Claude Code) the truncated read clears enforcement;
      // the mtime/size drift check still separates current from older bytes.
      // This seeds the cache directly: mockConfig lacks the ReadFileTool
      // wiring (getFileService, getTruncateToolOutputLines/Threshold,
      // getContentGeneratorConfig). read-file.test.ts "records truncated full
      // reads with lastReadCacheable=true (issue #3964)" covers the side that
      // produces `{ full: false, cacheable: true }`; a cache-entry schema
      // change must update both halves to keep the guarantee end-to-end.
      const filePath = seeded('enforce-truncated-full.txt', 'unchanged', {
        // What a truncated full read records
        // (read-file.ts: `full: isFullRead && !result.isTruncated`).
        full: false,
        cacheable: true,
      });

      const result = await run(filePath, 'rewritten');
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('rewritten');
    });

    it('rejects a write when the previous read was non-cacheable', async () => {
      const filePath = seeded('enforce-noncacheable.txt', 'pretend binary', {
        full: true,
        cacheable: false,
      });

      const result = await run(filePath, 'clobber');
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.message).toContain('notebook_edit');
      // The dead-end guidance's verb must fit overwrite (WriteFile), not
      // "edit".
      expect(result.error?.message).toMatch(/if you need to overwrite it\./);

      fs.unlinkSync(filePath);
    });

    it('confirmation falls back to a new-file diff when the file disappears mid-flight', async () => {
      // isFilefileExists() saw the file, then an external process deleted
      // it before getConfirmationDetails' readTextFile. Pre-fix the ENOENT
      // collapsed the confirmation into UNHANDLED_EXCEPTION; the catch now
      // falls back to fileExists=false so the user sees a new-file diff.
      const filePath = seeded('enforce-disappear.txt', 'will disappear');
      const readSpy = vi
        .spyOn(fsService, 'readTextFile')
        .mockRejectedValueOnce(errno('ENOENT', 'ENOENT'));

      const confirmation = await build(
        filePath,
        'new content',
      ).getConfirmationDetails(abortSignal);
      // A confirmation diff (not a throw) proposing the new content.
      expect(confirmation).toEqual(
        expect.objectContaining({
          type: 'edit',
          newContent: 'new content',
        }),
      );

      readSpy.mockRestore();
    });

    it('rejects confirmation requests on an unread existing file before showing a diff', async () => {
      const filePath = unread('enforce-confirm.txt', 'unread current bytes');
      const invocation = build(filePath, 'replacement content');
      await expect(
        invocation.getConfirmationDetails(abortSignal),
      ).rejects.toThrow(/has not been read in this session/);

      fs.unlinkSync(filePath);
    });

    it('attaches a structured ToolErrorType when getConfirmationDetails rejects', async () => {
      // The thrown error must carry `errorType` so the scheduler surfaces
      // EDIT_REQUIRES_PRIOR_READ instead of UNHANDLED_EXCEPTION on
      // approval-required flows.
      const filePath = unread(
        'enforce-confirm-type.txt',
        'unread current bytes',
      );
      const invocation = build(filePath, 'replacement content');
      let caught: unknown;
      try {
        await invocation.getConfirmationDetails(abortSignal);
      } catch (err) {
        caught = err;
      }
      expect((caught as { errorType?: string })?.errorType).toBe(
        ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      );
      fs.unlinkSync(filePath);
    });

    it('rejects a write with a stat failure other than ENOENT (fail-closed)', async () => {
      // checkPriorRead must NOT default to ok:true when stat fails for
      // reasons other than a disappearance race (EACCES, EBUSY, NFS hiccup,
      // ...): that reopens the blind-write path on transient metadata errors.
      const filePath = unread('enforce-stat-fail.txt', 'untouched');
      const statSpy = vi
        .spyOn(fs.promises, 'stat')
        .mockRejectedValueOnce(errno('EACCES', 'EACCES'));

      const result = await run(filePath, 'clobber');
      // A distinct code: the model may have read the file, we just cannot
      // verify it; EDIT_REQUIRES_PRIOR_READ would imply "definitely not read".
      expect(result.error?.type).toBe(
        ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      );
      expect(result.error?.message).toMatch(/Could not stat .*\(EACCES\)/);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('untouched');

      statSpy.mockRestore();
    });

    it('rejects a write when the file has been modified since the last read', async () => {
      const filePath = seeded('enforce-stale.txt', 'one');
      fs.writeFileSync(filePath, 'two with more bytes', 'utf-8');
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(filePath, future, future);

      const result = await run(filePath, 'clobber the stale file');

      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(result.error?.message).toMatch(/has been modified since/);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('two with more bytes');
    });

    it('exempts new-file creation from prior-read enforcement', async () => {
      // The file does not exist; the model has nothing to read first.
      const filePath = p('enforce-new.txt');
      const result = await run(filePath, 'fresh content');

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('fresh content');
    });

    it('bypasses enforcement entirely when fileReadCacheDisabled is true', async () => {
      const filePath = unread('enforce-bypass.txt', 'untouched');
      const original = mockConfigInternal.getFileReadCacheDisabled;
      mockConfigInternal.getFileReadCacheDisabled = () => true;

      try {
        const result = await run(filePath, 'clobbered');
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('clobbered');
      } finally {
        mockConfigInternal.getFileReadCacheDisabled = original;
      }
    });
  });
});

describe('workspace artifact metadata guard', () => {
  beforeEach(() => {
    mockConfigInternal.isRecordArtifactEnabled.mockReturnValue(true);
  });

  /** Links root/`linkName` to data/payload.csv; identity follows the target. */
  function expectTargetIdentity(linkName: string) {
    fs.mkdirSync(p('data'), { recursive: true });
    const target = p('data', 'payload.csv');
    const link = p(linkName);
    fs.writeFileSync(target, 'a,b\n');
    fs.symlinkSync(target, link);
    try {
      expect(buildWorkspaceArtifactMetadata(mockConfig, link)).toMatchObject({
        title: 'payload.csv',
        kind: 'file',
        workspacePath: 'data/payload.csv',
      });
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(p('data'), { recursive: true, force: true });
    }
  }

  // Pins the delegation: buildRecordArtifactReminder must agree with
  // buildWorkspaceArtifactMetadata. A reminder that computed the path
  // independently (without the safety guard) would still hint for this
  // markup-bearing filename while the artifact is correctly skipped,
  // reintroducing the false "automatically recorded" claim.
  it('keeps the reminder and the artifact in lockstep when the guard rejects', () => {
    const rejected = path.resolve(
      rootDir,
      'reports',
      'chart onerror=alert(1).html',
    );
    expect(buildWorkspaceArtifactMetadata(mockConfig, rejected)).toBeNull();
    expect(buildRecordArtifactReminder(mockConfig, rejected)).toBeNull();
  });

  it('skips artifacts whose workspace path exceeds the store limit', () => {
    // A short filename in a deep directory: the workspace path passes the
    // 500-char store limit while the title stays well under its own, so
    // this exercises the path-length clause on its own.
    const filePath = path.resolve(rootDir, 'a'.repeat(510), 'x.html');
    expect(buildWorkspaceArtifactMetadata(mockConfig, filePath)).toBeNull();
  });

  it('derives auto-record identity from the realpath target', () => {
    expectTargetIdentity('report.csv');
  });

  it('infers kind from the realpath target, not the link name', () => {
    expectTargetIdentity('preview.png');
  });

  it('skips auto-record when the realpath target is not a whitelisted kind', () => {
    const target = p('dropped.bin');
    const link = p('report.csv');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(target, 'bin');
    fs.symlinkSync(target, link);
    try {
      expect(buildWorkspaceArtifactMetadata(mockConfig, link)).toBeNull();
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it('does not auto-record a file whose realpath is outside the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-out-'));
    const linkDir = p('output');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.symlinkSync(outside, linkDir);
    const filePath = path.join(linkDir, 'report.csv');
    fs.writeFileSync(filePath, 'a,b\n');
    try {
      expect(buildWorkspaceArtifactMetadata(mockConfig, filePath)).toBeNull();
    } finally {
      fs.rmSync(linkDir, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips artifacts whose workspace path contains a control character', () => {
    // The control character sits in a directory segment, not the basename:
    // the title is path.basename(filePath), so a control character in the
    // title would also appear in the path and could not prove the path-side
    // check on its own.
    const filePath = path.resolve(rootDir, 'reports\u000b', 'chart.html');
    expect(buildWorkspaceArtifactMetadata(mockConfig, filePath)).toBeNull();
  });
});
