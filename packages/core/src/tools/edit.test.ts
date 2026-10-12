/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGenerateJson = vi.hoisted(() => vi.fn());

vi.mock('../utils/editor.js', () => ({
  openDiff: vi.fn(),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EditToolParams } from './edit.js';
import { applyReplacement, EditTool } from './edit.js';
import type { FileDiff } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

const readText = (filePath: string) => fs.readFileSync(filePath, 'utf8');

const edit = (
  file_path: string,
  old_string = 'old',
  new_string = 'new',
  extra: Partial<EditToolParams> = {},
): EditToolParams => ({ file_path, old_string, new_string, ...extra });

/** A model-only diffStat: [added lines, removed lines, added chars, removed chars]. */
const modelDiffStat = (
  addedLines: number,
  removedLines: number,
  addedChars: number,
  removedChars: number,
) => ({
  model_added_lines: addedLines,
  model_removed_lines: removedLines,
  model_added_chars: addedChars,
  model_removed_chars: removedChars,
  user_added_lines: 0,
  user_removed_lines: 0,
  user_added_chars: 0,
  user_removed_chars: 0,
});

describe('EditTool', () => {
  let tool: EditTool;
  let tempDir: string;
  let rootDir: string;
  let mockConfig: Config;
  let llmClient: any;
  let baseLlmClient: any;
  let fileReadCache: FileReadCache;
  let mockFileHistoryService: { trackEdit: ReturnType<typeof vi.fn> };
  let fsService: StandardFileSystemService;

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    rootDir = path.join(tempDir, 'root');
    fs.mkdirSync(rootDir);
    fileReadCache = new FileReadCache();
    mockFileHistoryService = { trackEdit: vi.fn() };
    fsService = new StandardFileSystemService();
    llmClient = { generateJson: mockGenerateJson };
    baseLlmClient = { generateJson: vi.fn() };

    mockConfig = {
      getLlmClient: vi.fn().mockReturnValue(llmClient),
      getBaseLlmClient: vi.fn().mockReturnValue(baseLlmClient),
      getTargetDir: () => rootDir,
      getProjectRoot: () => rootDir,
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getWorkspaceContext: () => createMockWorkspaceContext(rootDir),
      getFileSystemService: () => fsService,
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
      getToolRegistry: () => ({}) as any, // Minimal mock for ToolRegistry
      getDefaultFileEncoding: vi.fn().mockReturnValue('utf-8'),
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: vi.fn().mockReturnValue(false),
      getFileHistoryService: () => mockFileHistoryService,
    } as unknown as Config;

    // Default to not skipping confirmation
    (mockConfig.getApprovalMode as Mock).mockClear();
    (mockConfig.getApprovalMode as Mock).mockReturnValue(ApprovalMode.DEFAULT);

    tool = new EditTool(mockConfig);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Simulate the model having read `filePath` earlier in the session so
   * prior-read enforcement does not reject the edit. Tests of pure Edit
   * behaviour (diffing, encoding, replace_all, etc.) call this after writing
   * the fixture file and before invoking `tool.execute`.
   */
  function seedPriorRead(filePath: string, full = true, cacheable = true) {
    const stats = fs.statSync(filePath);
    fileReadCache.recordRead(filePath, stats, { full, cacheable });
    return stats;
  }

  /** Writes the fixture file and seeds a prior full read of it. */
  function seedFile(filePath: string, content: string) {
    fs.writeFileSync(filePath, content, 'utf8');
    seedPriorRead(filePath);
  }

  const run = (params: EditToolParams) =>
    tool.build(params).execute(new AbortController().signal);
  const confirm = (params: EditToolParams) =>
    tool.build(params).getConfirmationDetails(new AbortController().signal);
  const autoEditOnce = () =>
    (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
      ApprovalMode.AUTO_EDIT,
    );

  /** An invocation whose calculateEdit aborts `controller`, then throws `error`. */
  const abortingInvocation = (
    fileName: string,
    controller: AbortController,
    error: Error,
  ) => {
    const invocation = tool.build(edit(path.join(rootDir, fileName)));
    const calculateSpy = vi
      .spyOn(invocation as any, 'calculateEdit')
      .mockImplementation(async () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        throw error;
      });
    return { invocation, calculateSpy };
  };

  describe('applyReplacement', () => {
    const replace = (current: string, oldStr: string, newStr: string) =>
      applyReplacement(current, oldStr, newStr, false);

    it('should return newString if isNewFile is true', () => {
      expect(applyReplacement(null, 'old', 'new', true)).toBe('new');
      expect(applyReplacement('existing', 'old', 'new', true)).toBe('new');
    });

    it('should return newString if currentContent is null and oldString is empty (defensive)', () => {
      expect(applyReplacement(null, '', 'new', false)).toBe('new');
    });

    it('should return empty string if currentContent is null and oldString is not empty (defensive)', () => {
      expect(applyReplacement(null, 'old', 'new', false)).toBe('');
    });

    it('should replace oldString with newString in currentContent', () => {
      expect(replace('hello old world old', 'old', 'new')).toBe(
        'hello new world new',
      );
    });

    it('should return currentContent if oldString is empty and not a new file', () => {
      expect(replace('hello world', '', 'new')).toBe('hello world');
    });

    it('should treat $ literally and not as replacement pattern', () => {
      expect(
        replace(
          "price is $100 and pattern end is ' '",
          'price is $100',
          'price is $200',
        ),
      ).toBe("price is $200 and pattern end is ' '");
    });

    it("should treat $' literally and not as a replacement pattern", () => {
      expect(replace('foo', 'foo', "bar$'baz")).toBe("bar$'baz");
    });

    it('should treat $& literally and not as a replacement pattern', () => {
      expect(replace('hello world', 'hello', '$&-replacement')).toBe(
        '$&-replacement world',
      );
    });

    it('should treat $` literally and not as a replacement pattern', () => {
      expect(replace('prefix-middle-suffix', 'middle', 'new$`content')).toBe(
        'prefix-new$`content-suffix',
      );
    });

    it('should treat $1, $2 capture groups literally', () => {
      expect(replace('test string', 'test', '$1$2replacement')).toBe(
        '$1$2replacement string',
      );
    });

    it('should use replaceAll for normal strings without problematic $ sequences', () => {
      expect(replace('normal text replacement', 'text', 'string')).toBe(
        'normal string replacement',
      );
    });

    it('should handle multiple occurrences with problematic $ sequences', () => {
      expect(replace('foo bar foo baz', 'foo', "test$'end")).toBe(
        "test$'end bar test$'end baz",
      );
    });

    it('should handle complex regex patterns with $ at end', () => {
      expect(
        replace(
          "| select('match', '^[sv]d[a-z]$')",
          "'^[sv]d[a-z]$'",
          "'^[sv]d[a-z]$' # updated",
        ),
      ).toBe("| select('match', '^[sv]d[a-z]$' # updated)");
    });

    it('should handle empty replacement with problematic $ in newString', () => {
      // No replacement because oldStr is not found
      expect(replace('test content', 'nothing', "replacement$'text")).toBe(
        'test content',
      );
    });

    it('should handle $$ (escaped dollar) correctly', () => {
      expect(replace('price value', 'value', '$$100')).toBe('price $$100');
    });
  });

  describe('team memory', () => {
    const teamFile = () =>
      path.join(rootDir, '.qwen', 'team-memory', 'feedback', 'x.md');
    // Prior-read enforcement off so the test can edit an existing file directly.
    const writeTeamFile = (content: string) => {
      (mockConfig.getFileReadCacheDisabled as Mock).mockReturnValue(true);
      const file = teamFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };

    it('blocks a secret written to a team-memory path via new_string', () => {
      expect(
        tool.validateToolParams(
          edit(teamFile(), '', `token = ghp_${'a'.repeat(36)}`),
        ),
      ).toMatch(/shared with all repository collaborators/i);
    });

    it('allows clean content on a team-memory path', () => {
      expect(
        tool.validateToolParams(
          edit(teamFile(), '', 'Use real DBs in integration tests.'),
        ),
      ).toBeNull();
    });

    it('proposes (asks) team writes — never auto-allowed like private memory', async () => {
      const permission = await tool
        .build({ file_path: teamFile(), old_string: '', new_string: 'x' })
        .getDefaultPermission();
      expect(permission).toBe('ask');
    });

    it('blocks a secret assembled across edits (scans full result, not just new_string)', async () => {
      // Existing content holds only the prefix (body < 36 → no match alone).
      const file = writeTeamFile(`ghp_${'a'.repeat(10)}`);
      // new_string has no `ghp_` prefix, so the validate-time scan passes;
      // only the merged result `ghp_` + 36 chars is a real token.
      const result = await run(edit(file, 'a'.repeat(10), 'a'.repeat(36)));
      expect(JSON.stringify(result)).toMatch(
        /shared with all repository collaborators/i,
      );
    });

    it('reports the pre-existing-secret message and leaves the file untouched', async () => {
      // Seed the on-disk file with a FULL detectable token so currentContent
      // itself trips the scanner — exercises the preExisting branch.
      const original = `secret = ghp_${'a'.repeat(36)}\nkeep`;
      const file = writeTeamFile(original);
      // Edit a clean line; the committed secret survives in the merged result.
      const result = await run(edit(file, 'keep', 'kept'));
      expect(JSON.stringify(result)).toMatch(
        /secret already exists in the current file content/i,
      );
      // The blocked edit must not have written anything.
      expect(readText(file)).toBe(original);
    });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params', () => {
      expect(
        tool.validateToolParams(edit(path.join(rootDir, 'test.txt'))),
      ).toBeNull();
    });

    it('should return error for relative path', () => {
      expect(tool.validateToolParams(edit('test.txt'))).toMatch(
        /File path must be absolute/,
      );
    });

    it('should allow path outside root (external path support)', () => {
      const error = tool.validateToolParams(
        edit(path.join(tempDir, 'outside-root.txt')),
      );
      expect(error).toBeNull();
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        const params = edit(path.join(rootDir, 'my\\ file.txt'));
        expect(tool.validateToolParams(params)).toBeNull();
        expect(params.file_path).toBe(path.join(rootDir, 'my file.txt'));
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should unescape multiple shell-escaped characters in file_path',
      () => {
        const params = edit(
          path.join(rootDir, 'project\\ \\(v2\\)\\ \\&\\ more.txt'),
        );
        expect(tool.validateToolParams(params)).toBeNull();
        expect(params.file_path).toBe(
          path.join(rootDir, 'project (v2) & more.txt'),
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should preserve literal backslashes in file_path',
      () => {
        // On Windows, backslashes are path separators and unescapePath is a
        // no-op, so this only validates literal-backslash preservation where
        // backslashes are not path separators.
        const pathWithBackslash = path.join(
          rootDir,
          'path\\\\with\\\\slashes.txt',
        );
        const params = edit(pathWithBackslash);
        expect(tool.validateToolParams(params)).toBeNull();
        // Double backslashes (literal) should be preserved
        expect(params.file_path).toBe(pathWithBackslash);
      },
    );
  });

  describe('getConfirmationDetails', () => {
    const testFile = 'edit_me.txt';
    let filePath: string;
    const confirmationFor = (fileName: string) =>
      expect.objectContaining({
        title: `Confirm Edit: ${fileName}`,
        fileName,
        fileDiff: expect.any(String),
      });

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should throw an error if params are invalid', async () => {
      expect(() => tool.build(edit('relative.txt'))).toThrow();
    });

    it('should request confirmation for valid edit', async () => {
      seedFile(filePath, 'some old content here');
      expect(await confirm(edit(filePath))).toEqual(confirmationFor(testFile));
    });

    it('should throw if old_string is not found', async () => {
      seedFile(filePath, 'some content here');
      await expect(confirm(edit(filePath, 'not_found'))).rejects.toThrow();
    });

    it('should throw if multiple occurrences of old_string are found', async () => {
      seedFile(filePath, 'old old content here');
      await expect(confirm(edit(filePath))).rejects.toThrow();
    });

    it('should surface plain object read errors without object stringification', async () => {
      seedFile(filePath, 'some old content here');
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce({
        message: 'Plain object read error',
      });

      const err = await confirm(edit(filePath)).catch(
        (error: unknown) => error,
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        'Error preparing edit: Plain object read error',
      );
      expect((err as Error).message).not.toContain('[object Object]');
    });

    it('should request confirmation for creating a new file (empty old_string)', async () => {
      const newFileName = 'new_file.txt';
      const params = edit(
        path.join(rootDir, newFileName),
        '',
        'new file content',
      );
      expect(await confirm(params)).toEqual(confirmationFor(newFileName));
    });

    it('should rethrow calculateEdit errors when the abort signal is triggered', async () => {
      const abortController = new AbortController();
      const abortError = new Error('Abort requested');
      const { invocation, calculateSpy } = abortingInvocation(
        'abort-confirmation.txt',
        abortController,
        abortError,
      );

      await expect(
        invocation.getConfirmationDetails(abortController.signal),
      ).rejects.toBe(abortError);

      calculateSpy.mockRestore();
    });
  });

  describe('execute', () => {
    const testFile = 'execute_me.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should throw error if file path is not absolute', async () => {
      expect(() => tool.build(edit('relative.txt'))).toThrow(
        /File path must be absolute/,
      );
    });

    it('should throw error if file path is empty', async () => {
      expect(() => tool.build(edit(''))).toThrow(
        /The 'file_path' parameter must be non-empty./,
      );
    });

    it('should reject when calculateEdit fails after an abort signal', async () => {
      const abortController = new AbortController();
      const abortError = new Error('Abort requested during execute');
      const { invocation, calculateSpy } = abortingInvocation(
        'abort-execute.txt',
        abortController,
        abortError,
      );

      await expect(invocation.execute(abortController.signal)).rejects.toBe(
        abortError,
      );

      calculateSpy.mockRestore();
    });

    it('should edit an existing file and return diff with fileName', async () => {
      const initialContent = 'This is some old text.';
      const newContent = 'This is some new text.'; // old -> new
      seedFile(filePath, initialContent);
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const result = await run(edit(filePath));

      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file:/,
      );
      expect(readText(filePath)).toBe(newContent);
      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(initialContent);
      expect(display.fileDiff).toMatch(newContent);
      expect(display.fileName).toBe(testFile);
      // `filePath` must carry the full path: UI consumers (e.g. the VSCode
      // companion) cannot resolve a clickable location from `fileName`
      // alone once the file is outside the workspace root.
      expect(display.filePath).toBe(filePath);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolWriteOrigin: 'edit' }),
      );
    });

    // trackEdit is best-effort: a FileHistoryService failure (disk full,
    // permissions, corrupted state) must never break the edit tool.
    it('completes the edit even when trackEdit throws', async () => {
      seedFile(filePath, 'This is some old text.');
      mockFileHistoryService.trackEdit.mockRejectedValueOnce(
        new Error('disk full'),
      );

      const result = await run(edit(filePath));

      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      expect(readText(filePath)).toBe('This is some new text.');
      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file:/,
      );
    });

    // Pins the upstream-aligned ordering: trackEdit MUST run before the
    // pre-write checkPriorRead. Upstream `claude-code/src/tools/FileEditTool`
    // says of the equivalent block: "These awaits must stay OUTSIDE the
    // critical section below — a yield between the staleness check and
    // writeTextContent lets concurrent edits interleave." Otherwise the
    // multi-hundred-ms `trackEdit` sits between checkPriorRead and
    // writeTextFile, widening the stat-then-write race from microseconds to
    // seconds.
    //
    // Strategy: a `trackEdit` mock bumps the file's mtime. Only if trackEdit
    // runs BEFORE the pre-write check does that check see the mutation; the
    // broken order would check first (passing on pre-mutation stats), then
    // mutate, then silently clobber the external change on write. Asserting
    // on `result.error` tests the invariant rather than a call-order proxy,
    // so it survives refactors that change the number of `cache.check` calls.
    it('backs up before the pre-write freshness check (TOCTOU ordering)', async () => {
      const initialContent = 'This is some old text.';
      seedFile(filePath, initialContent);

      mockFileHistoryService.trackEdit.mockImplementation(async () => {
        // An external write landing while trackEdit copies the file to the
        // backup directory. +5 s is reliably "newer" under the cache's ~1 s
        // comparison granularity on macOS.
        const newTime = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, newTime, newTime);
      });

      const result = await run(edit(filePath));

      // trackEdit must have actually fired.
      expect(mockFileHistoryService.trackEdit).toHaveBeenCalledWith(filePath);
      // The pre-write check caught the in-trackEdit mutation, proving
      // trackEdit ran BEFORE it.
      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      // The file on disk is unchanged (rejected, not overwritten).
      expect(readText(filePath)).toBe(initialContent);
    });

    // The Edit tool feeds the commit-attribution singleton on success so
    // commit notes can later report per-file AI/human ratios. Service-level
    // tests for `recordEdit` exist; these guard the wiring at the tool
    // boundary (e.g. someone moving the call out of the success path).
    describe('commit-attribution wiring', () => {
      beforeEach(() => {
        CommitAttributionService.resetInstance();
      });

      it('records AI-originated edits in the attribution service', async () => {
        const updated = 'new line';
        // Prior-read enforcement (origin/main #3774) requires the file
        // to have been Read before Edit can mutate it.
        seedFile(filePath, 'old line');

        await run(edit(filePath));

        const attribution =
          CommitAttributionService.getInstance().getFileAttribution(filePath);
        expect(attribution).toBeDefined();
        // The exact char count is a computeCharContribution detail; only
        // assert the entry exists with a positive contribution.
        expect(attribution!.aiContribution).toBeGreaterThan(0);
        // Length sanity: contribution is bounded by the new content.
        expect(attribution!.aiContribution).toBeLessThanOrEqual(updated.length);
      });

      it('skips attribution when the edit is modified_by_user', async () => {
        seedFile(filePath, 'old line');

        await run(edit(filePath, 'old', 'new', { modified_by_user: true }));

        expect(
          CommitAttributionService.getInstance().getFileAttribution(filePath),
        ).toBeUndefined();
      });
    });

    it('should create a new file if old_string is empty and file does not exist, and return created message', async () => {
      const newFileName = 'brand_new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const fileContent = 'Content for the new file.';
      autoEditOnce();
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const result = await run(edit(newFilePath, '', fileContent));

      expect(result.llmContent).toMatch(/Created new file/);
      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file:/,
      );
      expect(fs.existsSync(newFilePath)).toBe(true);
      expect(readText(newFilePath)).toBe(fileContent);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolWriteOrigin: 'edit' }),
      );

      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(/\+Content for the new file\./);
      expect(display.fileName).toBe(newFileName);
      expect(display.diffStat).toStrictEqual(modelDiffStat(1, 0, 25, 0));
    });

    it('should create new file with BOM when defaultFileEncoding is utf-8-bom', async () => {
      (mockConfig.getDefaultFileEncoding as Mock).mockReturnValue('utf-8-bom');
      const newFilePath = path.join(rootDir, 'bom_new_file.txt');
      const fileContent = 'Content for BOM file.';
      autoEditOnce();

      await run(edit(newFilePath, '', fileContent));

      const fileBuffer = fs.readFileSync(newFilePath);
      expect(fileBuffer[0]).toBe(0xef);
      expect(fileBuffer[1]).toBe(0xbb);
      expect(fileBuffer[2]).toBe(0xbf);
      expect(fileBuffer.toString('utf8')).toContain(fileContent);
    });

    it('should create new file without BOM when defaultFileEncoding is utf-8', async () => {
      // Config defaults to utf-8
      const newFilePath = path.join(rootDir, 'no_bom_new_file.txt');
      const fileContent = 'Content without BOM.';
      autoEditOnce();

      await run(edit(newFilePath, '', fileContent));

      const fileBuffer = fs.readFileSync(newFilePath);
      expect(fileBuffer[0]).not.toBe(0xef);
      expect(fileBuffer.toString('utf8')).toBe(fileContent);
    });

    it('should preserve BOM character in content when editing existing file', async () => {
      const bomFilePath = path.join(rootDir, 'existing_bom.txt');
      // BOM is the \ufeff character in a string
      seedFile(bomFilePath, '\ufeff// Original line\nconst x = 1;');
      autoEditOnce();

      await run(edit(bomFilePath, 'const x = 1;', 'const x = 2;'));

      const resultContent = readText(bomFilePath);
      expect(resultContent.charCodeAt(0)).toBe(0xfeff); // BOM preserved
      expect(resultContent).toContain('const x = 2;');
    });

    it('should return error if old_string is not found in file', async () => {
      seedFile(filePath, 'Some content.');
      const result = await run(edit(filePath, 'nonexistent', 'replacement'));
      expect(result.llmContent).toMatch(
        /0 occurrences found for old_string in/,
      );
      expect(result.returnDisplay).toMatch(
        /Failed to edit, could not find the string to replace./,
      );
    });

    it('should return error if multiple occurrences of old_string are found and replace_all is false', async () => {
      seedFile(filePath, 'multiple old old strings');
      const result = await run(edit(filePath));
      expect(result.llmContent).toMatch(/replace_all was not enabled/);
      expect(result.returnDisplay).toMatch(
        /Failed to edit because the text matches multiple locations/,
      );
    });

    it('should successfully replace multiple occurrences when replace_all is true', async () => {
      seedFile(filePath, 'old text\nold text\nold text');

      const result = await run(
        edit(filePath, 'old', 'new', { replace_all: true }),
      );

      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file/,
      );
      expect(readText(filePath)).toBe('new text\nnew text\nnew text');
      const display = result.returnDisplay as FileDiff;

      expect(display.fileDiff).toMatch(/-old text\n-old text\n-old text/);
      expect(display.fileDiff).toMatch(/\+new text\n\+new text\n\+new text/);
      expect(display.fileName).toBe(testFile);
      expect(display.diffStat).toStrictEqual(modelDiffStat(3, 3, 24, 24));
    });

    it('should return error if trying to create a file that already exists (empty old_string)', async () => {
      seedFile(filePath, 'Existing content');
      const result = await run(edit(filePath, '', 'new content'));
      expect(result.llmContent).toMatch(/File already exists, cannot create/);
      expect(result.returnDisplay).toMatch(
        /Attempted to create a file that already exists/,
      );
    });

    it('should not include modification message when proposed content is not modified', async () => {
      fs.writeFileSync(filePath, 'This is some old text.', 'utf8');
      autoEditOnce();

      const result = await run(
        edit(filePath, 'old', 'new', { modified_by_user: false }),
      );

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should not include modification message when modified_by_user is not provided', async () => {
      fs.writeFileSync(filePath, 'This is some old text.', 'utf8');
      autoEditOnce();

      const result = await run(edit(filePath));

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should return error if old_string and new_string are identical', async () => {
      seedFile(filePath, 'This is some identical text.');
      const result = await run(edit(filePath, 'identical', 'identical'));
      expect(result.llmContent).toMatch(/No changes to apply/);
      expect(result.returnDisplay).toMatch(/No changes to apply/);
    });

    it('should return EDIT_NO_CHANGE error if replacement results in identical content', async () => {
      // This can happen if the literal string replacement with `replaceAll` results in no change.
      const initialContent = 'line 1\nline  2\nline 3'; // Note the double space
      seedFile(filePath, initialContent);

      const result = await run(
        edit(
          filePath,
          // old_string has a single space, so it won't be found by replaceAll
          'line 1\nline 2\nline 3',
          'line 1\nnew line 2\nline 3',
        ),
      );

      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
      expect(result.returnDisplay).toMatch(
        /Failed to edit, could not find the string to replace./,
      );
      // Ensure the file was not actually changed
      expect(readText(filePath)).toBe(initialContent);
    });
  });

  describe('Error Scenarios', () => {
    const testFile = 'error_test.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should return FILE_NOT_FOUND error', async () => {
      const result = await run(edit(filePath, 'any'));
      expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    });

    it('should return ATTEMPT_TO_CREATE_EXISTING_FILE error', async () => {
      seedFile(filePath, 'existing content');
      const result = await run(edit(filePath, '', 'new content'));
      expect(result.error?.type).toBe(
        ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
      );
    });

    it('should return NO_OCCURRENCE_FOUND error', async () => {
      seedFile(filePath, 'content');
      const result = await run(edit(filePath, 'not-found'));
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
    });

    it('should return EXPECTED_OCCURRENCE_MISMATCH error when replace_all is false and text is not unique', async () => {
      seedFile(filePath, 'one one two');
      const result = await run(edit(filePath, 'one'));
      expect(result.error?.type).toBe(
        ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      );
    });

    it('should return NO_CHANGE error', async () => {
      seedFile(filePath, 'content');
      const result = await run(edit(filePath, 'content', 'content'));
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_CHANGE);
    });

    it('should return EDIT_PREPARATION_FAILURE with plain object read error messages', async () => {
      seedFile(filePath, 'content');
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce({
        message: 'Plain object read error',
      });

      const result = await run(edit(filePath, 'content', 'new content'));

      expect(result.error?.type).toBe(ToolErrorType.EDIT_PREPARATION_FAILURE);
      expect(result.llmContent).toContain(
        'Error preparing edit: Plain object read error',
      );
      expect(result.llmContent).not.toContain('[object Object]');
    });

    it('should throw INVALID_PARAMETERS error for relative path', async () => {
      expect(() => tool.build(edit('relative/path.txt', 'a', 'b'))).toThrow();
    });

    it('should return FILE_WRITE_FAILURE on write error', async () => {
      seedFile(filePath, 'content');
      vi.spyOn(fsService, 'writeTextFile').mockRejectedValueOnce(
        new Error('Simulated write error'),
      );

      const result = await run(edit(filePath, 'content', 'new content'));
      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
    });

    it('should surface plain object write error messages without object stringification', async () => {
      seedFile(filePath, 'content');
      vi.spyOn(fsService, 'writeTextFile').mockRejectedValueOnce({
        message: 'Plain object edit error',
      });

      const result = await run(edit(filePath, 'content', 'new content'));

      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
      expect(result.llmContent).toContain(
        'Error executing edit: Plain object edit error',
      );
      expect(result.llmContent).not.toContain('[object Object]');
    });
  });

  describe('getDescription', () => {
    const descriptionOf = (fileName: string, oldStr: string, newStr: string) =>
      tool
        .build(edit(path.join(rootDir, fileName), oldStr, newStr))
        .getDescription();

    it('should return "No file changes to..." if old_string and new_string are the same', () => {
      // shortenPath will be called internally, resulting in just the file name
      expect(
        descriptionOf('test.txt', 'identical_string', 'identical_string'),
      ).toBe('No file changes to test.txt');
    });

    it('should return the file path when old and new strings differ', () => {
      expect(
        descriptionOf(
          'test.txt',
          'this is the old string value',
          'this is the new string value',
        ),
      ).toBe('test.txt');
    });

    it('should return the file path for short strings', () => {
      expect(descriptionOf('short.txt', 'old', 'new')).toBe('short.txt');
    });
  });

  describe('FileReadCache integration', () => {
    it('records a write into the cache so a follow-up Read sees lastWriteAt', async () => {
      // Without this hook, ReadFile's `(lastWriteAt === undefined ||
      // lastReadAt > lastWriteAt)` guard would let a post-edit Read return
      // the pre-edit placeholder when the filesystem's mtime resolution is
      // too coarse to detect the edit.
      const filePath = path.join(rootDir, 'cached.txt');
      fs.writeFileSync(filePath, 'old content');

      // Simulate the model having Read the file before Edit fires.
      const beforeRead = fileReadCache.check(seedPriorRead(filePath));
      expect(beforeRead.state).toBe('fresh');
      if (beforeRead.state === 'fresh') {
        expect(beforeRead.entry.lastWriteAt).toBeUndefined();
      }

      const result = await run(edit(filePath, 'old content', 'new content'));
      expect(result.error).toBeUndefined();

      const after = fileReadCache.check(fs.statSync(filePath));
      // After the edit, the cache entry's mtime+size match the new
      // file state and lastWriteAt has been stamped.
      expect(after.state).toBe('fresh');
      if (after.state === 'fresh') {
        expect(after.entry.lastWriteAt).toBeDefined();
        // lastReadAt was set by the simulated pre-edit Read; the post-write
        // timestamp must dominate it so later Reads skip the placeholder.
        expect(after.entry.lastWriteAt!).toBeGreaterThanOrEqual(
          after.entry.lastReadAt!,
        );
      }
    });
  });

  describe('prior-read enforcement', () => {
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, 'enforce_target.txt');
    });

    it('rejects an edit when the file has not been read in this session', async () => {
      fs.writeFileSync(filePath, 'untouched content', 'utf8');
      // No seedPriorRead: the model tries to Edit a file it never received
      // via ReadFile.
      const result = await run(edit(filePath, 'untouched', 'modified'));

      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.message).toMatch(
        /has not been read in this session/,
      );
      // File must remain untouched.
      expect(readText(filePath)).toBe('untouched content');
    });

    it('rejects an edit terminally when the filesystem reports ino 0', async () => {
      // FAT/exFAT and some SMB mounts report `ino: 0` for every file, so
      // the cache cannot prove the model read *this* file. Re-reading
      // would not help, so the model must be told to stop rather than be
      // sent round the "re-read it first" loop forever.
      seedFile(filePath, 'untouched content');
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
        const result = await run(edit(filePath, 'untouched', 'modified'));

        expect(result.error?.type).toBe(
          ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
        );
        expect(result.error?.message).toMatch(/does not provide a verifiable/);
        expect(result.error?.message).toMatch(/use a different mechanism/i);
        // Not the message that tells the model to re-read — that would
        // loop, because the re-read cannot change the inode.
        expect(result.error?.message).not.toMatch(/Re-read it with/);
        expect(readText(filePath)).toBe('untouched content');
      } finally {
        stat.mockRestore();
      }
    });

    it('allows an edit after a ranged (offset/limit) read', async () => {
      // A partial read counts as a prior read: forcing a re-read of a
      // multi-thousand-line file to change one line is wasteful, and the
      // `0 occurrences` failure already catches what the full-read rule
      // defended against (a fabricated old_string that misses the actual
      // bytes). Matches Claude Code's `readFileState`, which also accepts
      // partial reads.
      fs.writeFileSync(filePath, 'line a\nline b\nline c\n', 'utf8');
      seedPriorRead(filePath, false);
      autoEditOnce();

      const result = await run(edit(filePath, 'line a', 'X'));
      expect(result.error).toBeUndefined();
      expect(readText(filePath)).toBe('X\nline b\nline c\n');
    });

    it('allows editing a large text file after a ranged read', async () => {
      const initialContent = [
        'target',
        'context 1',
        'context 2',
        'context 3',
        'context 4',
        'x'.repeat(11 * 1024 * 1024),
      ].join('\n');
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedPriorRead(filePath, false);
      autoEditOnce();

      const result = await run(edit(filePath, 'target', 'updated'));

      expect(result.error).toBeUndefined();
      expect(readText(filePath).startsWith('updated\n')).toBe(true);
    });

    it('rejects an edit when the previous read was non-cacheable (binary / pdf / image)', async () => {
      // ReadFile records every successful read, including binary / PDF /
      // image reads that produce a structured payload rather than text;
      // lastReadCacheable=false marks those and Edit must not accept them.
      fs.writeFileSync(filePath, 'pretend this is binary', 'utf8');
      seedPriorRead(filePath, true, false);

      const result = await run(edit(filePath, 'pretend', 'X'));
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      // Asking for another read_file would loop the agent forever (such a
      // read also leaves lastReadCacheable=false), so the message must
      // explain the dead end instead.
      expect(result.error?.message).toMatch(
        /binary \/ image \/ audio \/ video \/ PDF \/ notebook payload/,
      );
      expect(result.error?.message).toContain('notebook_edit');
      expect(result.error?.message).not.toMatch(/Use the read_file tool first/);
      // EditTool's verb is "edit", not "overwrite" — the wrong one would
      // confuse in-place edits.
      expect(result.error?.message).toMatch(/if you need to edit it\./);
      expect(result.error?.message).not.toMatch(
        /if you need to overwrite it\./,
      );
    });

    it('rejects an edit on a directory with TARGET_IS_DIRECTORY', async () => {
      // Pre-fix, the directory exemption returned ok:true and readTextFile
      // would either throw EISDIR (caught by execute as
      // EDIT_PREPARATION_FAILURE) or — in WriteFile.getConfirmationDetails —
      // collapse into UNHANDLED_EXCEPTION. The structured rejection gives a
      // stable error code wherever the call hits the pipeline.
      const dirPath = path.join(rootDir, 'enforce-dir');
      fs.mkdirSync(dirPath);
      const result = await run(edit(dirPath, 'foo', 'bar'));
      expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
      expect(result.error?.message).toMatch(/is a directory/);
    });

    it('rejects an edit with a stat failure other than ENOENT (fail-closed)', async () => {
      // Symmetric with WriteFile's EACCES test. checkPriorRead is shared
      // today, but if a future Edit-side fallback downgraded a real verify
      // failure to EDIT_REQUIRES_PRIOR_READ, only the write path would
      // catch it without this test.
      fs.writeFileSync(filePath, 'untouched', 'utf8');
      const statSpy = vi
        .spyOn(fs.promises, 'stat')
        .mockRejectedValueOnce(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );

      const result = await run(edit(filePath, 'untouched', 'modified'));

      expect(result.error?.type).toBe(
        ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      );
      expect(result.error?.message).toMatch(/Could not stat .*\(EACCES\)/);
      expect(readText(filePath)).toBe('untouched');

      statSpy.mockRestore();
    });

    it('does not let an unread file be probed via NO_OCCURRENCE_FOUND', async () => {
      // Regression for the read-less content oracle: pre-fix, a model could
      // call Edit with candidate old_strings on an unread file and tell
      // NO_OCCURRENCE_FOUND from OCCURRENCE_MATCH to reverse-engineer the
      // contents. With enforcement before calculateEdit, the call must get
      // the prior-read error whether or not the candidate would have matched.
      fs.writeFileSync(filePath, 'sensitive token: hunter2', 'utf8');

      const result = await run(edit(filePath, 'hunter2', 'redacted'));
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.type).not.toBe(
        ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      );
    });

    it('rejects confirmation requests on an unread file before showing a diff', async () => {
      // The user must not see a diff computed from current bytes the model
      // never received — they would approve assuming the model worked from
      // those bytes.
      fs.writeFileSync(filePath, 'unread content', 'utf8');
      await expect(
        confirm(edit(filePath, 'unread', 'modified')),
      ).rejects.toThrow(/has not been read in this session/);
    });

    it('rejects an edit when the file has been modified since the last read', async () => {
      seedFile(filePath, 'one');
      // Out-of-band modification: change content and bump mtime far enough
      // ahead that even coarse-resolution filesystems detect it.
      fs.writeFileSync(filePath, 'two with more bytes', 'utf8');
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(filePath, future, future);

      const result = await run(edit(filePath, 'two', 'three'));

      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(result.error?.message).toMatch(/has been modified since/);
      // File must remain at the externally-modified content.
      expect(readText(filePath)).toBe('two with more bytes');
    });

    it('exempts new-file creation from prior-read enforcement', async () => {
      // old_string === '' on a non-existent path is EditTool's new-file
      // idiom; there is nothing to read first, so enforcement must not fire.
      const newPath = path.join(rootDir, 'brand-new-edit.txt');
      autoEditOnce();

      const result = await run(edit(newPath, '', 'fresh creation'));

      expect(result.error).toBeUndefined();
      expect(readText(newPath)).toBe('fresh creation');
    });

    it('allows a create-then-edit-then-edit chain without an intervening read', async () => {
      // The author of a brand-new file has, by definition, "seen" the bytes
      // it just wrote. Without recordWrite seeding read metadata, the second
      // edit would be rejected because lastReadWasFull / lastReadCacheable
      // would still be unset on the entry recordWrite created.
      const newPath = path.join(rootDir, 'create-then-edit.txt');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );

      const created = await run(edit(newPath, '', 'first content\n'));
      expect(created.error).toBeUndefined();

      const edited = await run(edit(newPath, 'first', 'second'));
      expect(edited.error).toBeUndefined();
      expect(readText(newPath)).toBe('second content\n');
    });

    it('allows Edit after Write→partial-Read', async () => {
      // The Write authors the bytes (recordWrite seeds the cache), and a
      // follow-up partial Read at the same fingerprint must not disqualify
      // the next Edit. With `lastReadWasFull` no longer required this is the
      // generic "partial read counts" path; pre-fix it failed because the
      // partial read overwrote the full-read flag recordWrite had stamped,
      // and enforcement still required that flag.
      const newPath = path.join(rootDir, 'write-then-partial-read.txt');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );

      const created = await run(
        edit(newPath, '', 'line one\nline two\nline three\n'),
      );
      expect(created.error).toBeUndefined();

      // Partial follow-up Read (offset/limit); pre-fix this overwrote
      // lastReadWasFull/lastReadCacheable to false.
      seedPriorRead(newPath, false);

      const edited = await run(edit(newPath, 'line two', 'second line'));
      expect(edited.error).toBeUndefined();
      expect(readText(newPath)).toBe('line one\nsecond line\nline three\n');
    });

    it('allows a chain of edits without re-reading between them', async () => {
      // The first Edit's recordWrite stamps `lastWriteAt` and refreshes the
      // fingerprint, so the second Edit's stat is `fresh` and proceeds
      // without an intervening Read.
      seedFile(filePath, 'alpha');

      const first = await run(edit(filePath, 'alpha', 'beta'));
      expect(first.error).toBeUndefined();

      const second = await run(edit(filePath, 'beta', 'gamma'));
      expect(second.error).toBeUndefined();
      expect(readText(filePath)).toBe('gamma');
    });

    it('bypasses enforcement entirely when fileReadCacheDisabled is true', async () => {
      fs.writeFileSync(filePath, 'untouched', 'utf8');
      // No seed: with the cache disabled the model is on the pre-cache
      // contract, so Edit must succeed without a prior Read. mockReturnValue,
      // not ...Once: calculateEdit calls getFileReadCacheDisabled twice
      // (before readTextFile and in the post-read TOCTOU re-check) and both
      // must see disabled=true to actually bypass.
      (mockConfig.getFileReadCacheDisabled as Mock).mockReturnValue(true);
      const result = await run(edit(filePath, 'untouched', 'modified'));
      expect(result.error).toBeUndefined();
      expect(readText(filePath)).toBe('modified');
    });

    it('attaches a structured ToolErrorType when getConfirmationDetails rejects', async () => {
      // Without an `errorType` on the thrown Error, the tool scheduler
      // reports every confirmation-time rejection as UNHANDLED_EXCEPTION —
      // losing the EDIT_REQUIRES_PRIOR_READ / FILE_CHANGED_SINCE_READ
      // contract this PR introduces.
      fs.writeFileSync(filePath, 'unread content', 'utf8');
      const caught = await confirm(edit(filePath, 'unread', 'modified')).catch(
        (err: unknown) => err,
      );
      expect((caught as { errorType?: string })?.errorType).toBe(
        ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      );
    });
  });

  describe.skipIf(process.platform === 'win32')(
    'escaped paths with spaces (end-to-end)',
    () => {
      it('should read and edit a file whose name contains spaces when given an escaped path', async () => {
        const realPath = path.join(rootDir, 'my spaced file.txt');
        // Prior-read enforcement is keyed off the *unescaped* path EditTool
        // resolves internally; seed that real path so this test exercises
        // the escape handling, not the enforcement layer.
        seedFile(realPath, 'Hello old world!');
        autoEditOnce();

        // Pass an ESCAPED path (as the LLM might from at-completion)
        const result = await run(
          edit(path.join(rootDir, 'my\\ spaced\\ file.txt')),
        );

        // Should succeed — not fail with file-not-found
        expect(result.llmContent).toMatch(/Showing lines \d+-\d+ of \d+/);
        expect(readText(realPath)).toBe('Hello new world!');
      });

      it('should fail gracefully when escaped path points to nonexistent file', async () => {
        const result = await run(
          edit(path.join(rootDir, 'nonexistent\\ file.txt')),
        );

        // Should report file-not-found (unescaped path used, file truly doesn't exist)
        expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
      });
    },
  );

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      expect(
        tool.validateToolParams(edit(path.join(rootDir, 'file.txt'))),
      ).toBeNull();
    });

    it('should allow paths outside workspace root (external path support)', () => {
      const error = tool.validateToolParams(
        edit('/etc/passwd', 'root', 'hacked'),
      );
      expect(error).toBeNull();
    });
  });
});
