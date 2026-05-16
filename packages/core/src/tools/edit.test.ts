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
import type { FileDiff, ToolInvocation, ToolResult } from './tools.js';
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

describe('EditTool', () => {
  let tool: EditTool;
  let tempDir: string;
  let rootDir: string;
  let mockConfig: Config;
  let geminiClient: any;
  let baseLlmClient: any;
  let fileReadCache: FileReadCache;
  let fsService: StandardFileSystemService;

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    rootDir = path.join(tempDir, 'root');
    fs.mkdirSync(rootDir);
    fileReadCache = new FileReadCache();
    fsService = new StandardFileSystemService();

    geminiClient = {
      generateJson: mockGenerateJson, // mockGenerateJson is already defined and hoisted
    };

    baseLlmClient = {
      generateJson: vi.fn(),
    };

    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue(geminiClient),
      getBaseLlmClient: vi.fn().mockReturnValue(baseLlmClient),
      getTargetDir: () => rootDir,
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
      getGeminiMdFileCount: () => 0,
      setGeminiMdFileCount: vi.fn(),
      getToolRegistry: () => ({}) as any, // Minimal mock for ToolRegistry
      getDefaultFileEncoding: vi.fn().mockReturnValue('utf-8'),
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    // Reset mocks before each test
    (mockConfig.getApprovalMode as Mock).mockClear();
    // Default to not skipping confirmation
    (mockConfig.getApprovalMode as Mock).mockReturnValue(ApprovalMode.DEFAULT);

    tool = new EditTool(mockConfig);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Simulate the model having read `filePath` earlier in the session,
   * so the EditTool's prior-read enforcement does not reject the
   * subsequent edit. Tests that exercise pure Edit-business behaviour
   * (diffing, encoding, replace_all, etc.) should call this after
   * writing the fixture file and before invoking `tool.execute`.
   */
  function seedPriorRead(filePath: string) {
    const stats = fs.statSync(filePath);
    fileReadCache.recordRead(filePath, stats, {
      full: true,
      cacheable: true,
    });
  }

  describe('applyReplacement', () => {
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
      expect(applyReplacement('hello old world old', 'old', 'new', false)).toBe(
        'hello new world new',
      );
    });

    it('should return currentContent if oldString is empty and not a new file', () => {
      expect(applyReplacement('hello world', '', 'new', false)).toBe(
        'hello world',
      );
    });

    it('should treat $ literally and not as replacement pattern', () => {
      const current = "price is $100 and pattern end is ' '";
      const oldStr = 'price is $100';
      const newStr = 'price is $200';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe("price is $200 and pattern end is ' '");
    });

    it("should treat $' literally and not as a replacement pattern", () => {
      const current = 'foo';
      const oldStr = 'foo';
      const newStr = "bar$'baz";
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe("bar$'baz");
    });

    it('should treat $& literally and not as a replacement pattern', () => {
      const current = 'hello world';
      const oldStr = 'hello';
      const newStr = '$&-replacement';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('$&-replacement world');
    });

    it('should treat $` literally and not as a replacement pattern', () => {
      const current = 'prefix-middle-suffix';
      const oldStr = 'middle';
      const newStr = 'new$`content';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('prefix-new$`content-suffix');
    });

    it('should treat $1, $2 capture groups literally', () => {
      const current = 'test string';
      const oldStr = 'test';
      const newStr = '$1$2replacement';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('$1$2replacement string');
    });

    it('should use replaceAll for normal strings without problematic $ sequences', () => {
      const current = 'normal text replacement';
      const oldStr = 'text';
      const newStr = 'string';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('normal string replacement');
    });

    it('should handle multiple occurrences with problematic $ sequences', () => {
      const current = 'foo bar foo baz';
      const oldStr = 'foo';
      const newStr = "test$'end";
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe("test$'end bar test$'end baz");
    });

    it('should handle complex regex patterns with $ at end', () => {
      const current = "| select('match', '^[sv]d[a-z]$')";
      const oldStr = "'^[sv]d[a-z]$'";
      const newStr = "'^[sv]d[a-z]$' # updated";
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe("| select('match', '^[sv]d[a-z]$' # updated)");
    });

    it('should handle empty replacement with problematic $ in newString', () => {
      const current = 'test content';
      const oldStr = 'nothing';
      const newStr = "replacement$'text";
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('test content'); // No replacement because oldStr not found
    });

    it('should handle $$ (escaped dollar) correctly', () => {
      const current = 'price value';
      const oldStr = 'value';
      const newStr = '$$100';
      const result = applyReplacement(current, oldStr, newStr, false);
      expect(result).toBe('price $$100');
    });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'test.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('should return error for relative path', () => {
      const params: EditToolParams = {
        file_path: 'test.txt',
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toMatch(
        /File path must be absolute/,
      );
    });

    it('should allow path outside root (external path support)', () => {
      const params: EditToolParams = {
        file_path: path.join(tempDir, 'outside-root.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      const error = tool.validateToolParams(params);
      expect(error).toBeNull();
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        const escapedPath = path.join(rootDir, 'my\\ file.txt');
        const params: EditToolParams = {
          file_path: escapedPath,
          old_string: 'old',
          new_string: 'new',
        };
        expect(tool.validateToolParams(params)).toBeNull();
        expect(params.file_path).toBe(path.join(rootDir, 'my file.txt'));
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should unescape multiple shell-escaped characters in file_path',
      () => {
        const escapedPath = path.join(
          rootDir,
          'project\\ \\(v2\\)\\ \\&\\ more.txt',
        );
        const params: EditToolParams = {
          file_path: escapedPath,
          old_string: 'old',
          new_string: 'new',
        };
        expect(tool.validateToolParams(params)).toBeNull();
        expect(params.file_path).toBe(
          path.join(rootDir, 'project (v2) & more.txt'),
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'should preserve literal backslashes in file_path',
      () => {
        // On Windows, backslashes are path separators, and unescapePath is a
        // no-op. This test only validates literal-backslash preservation on
        // platforms where backslashes are not path separators.
        const pathWithBackslash = path.join(
          rootDir,
          'path\\\\with\\\\slashes.txt',
        );
        const params: EditToolParams = {
          file_path: pathWithBackslash,
          old_string: 'old',
          new_string: 'new',
        };
        expect(tool.validateToolParams(params)).toBeNull();
        // Double backslashes (literal) should be preserved
        expect(params.file_path).toBe(pathWithBackslash);
      },
    );
  });

  describe('getConfirmationDetails', () => {
    const testFile = 'edit_me.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should throw an error if params are invalid', async () => {
      const params: EditToolParams = {
        file_path: 'relative.txt',
        old_string: 'old',
        new_string: 'new',
      };
      expect(() => tool.build(params)).toThrow();
    });

    it('should request confirmation for valid edit', async () => {
      fs.writeFileSync(filePath, 'some old content here');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Edit: ${testFile}`,
          fileName: testFile,
          fileDiff: expect.any(String),
        }),
      );
    });

    it('should throw if old_string is not found', async () => {
      fs.writeFileSync(filePath, 'some content here');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'not_found',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      await expect(
        invocation.getConfirmationDetails(new AbortController().signal),
      ).rejects.toThrow();
    });

    it('should throw if multiple occurrences of old_string are found', async () => {
      fs.writeFileSync(filePath, 'old old content here');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      await expect(
        invocation.getConfirmationDetails(new AbortController().signal),
      ).rejects.toThrow();
    });

    it('should request confirmation for creating a new file (empty old_string)', async () => {
      const newFileName = 'new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: 'new file content',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Edit: ${newFileName}`,
          fileName: newFileName,
          fileDiff: expect.any(String),
        }),
      );
    });

    it('should rethrow calculateEdit errors when the abort signal is triggered', async () => {
      const filePath = path.join(rootDir, 'abort-confirmation.txt');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const abortController = new AbortController();
      const abortError = new Error('Abort requested');

      const calculateSpy = vi
        .spyOn(invocation as any, 'calculateEdit')
        .mockImplementation(async () => {
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          throw abortError;
        });

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
      const params: EditToolParams = {
        file_path: 'relative.txt',
        old_string: 'old',
        new_string: 'new',
      };
      expect(() => tool.build(params)).toThrow(/File path must be absolute/);
    });

    it('should throw error if file path is empty', async () => {
      const params: EditToolParams = {
        file_path: '',
        old_string: 'old',
        new_string: 'new',
      };
      expect(() => tool.build(params)).toThrow(
        /The 'file_path' parameter must be non-empty./,
      );
    });

    it('should reject when calculateEdit fails after an abort signal', async () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'abort-execute.txt'),
        old_string: 'old',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const abortController = new AbortController();
      const abortError = new Error('Abort requested during execute');

      const calculateSpy = vi
        .spyOn(invocation as any, 'calculateEdit')
        .mockImplementation(async () => {
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          throw abortError;
        });

      await expect(invocation.execute(abortController.signal)).rejects.toBe(
        abortError,
      );

      calculateSpy.mockRestore();
    });

    it('should edit an existing file and return diff with fileName', async () => {
      const initialContent = 'This is some old text.';
      const newContent = 'This is some new text.'; // old -> new
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file:/,
      );
      expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(initialContent);
      expect(display.fileDiff).toMatch(newContent);
      expect(display.fileName).toBe(testFile);
    });

    // The Edit tool feeds the commit-attribution singleton on success so
    // commit notes can later report per-file AI/human ratios. Service-
    // level tests for `recordEdit` already exist; these guard against
    // the wiring at the tool boundary regressing (e.g. someone moves
    // the call out of the success path).
    describe('commit-attribution wiring', () => {
      beforeEach(() => {
        CommitAttributionService.resetInstance();
      });

      it('records AI-originated edits in the attribution service', async () => {
        const initial = 'old line';
        const updated = 'new line';
        fs.writeFileSync(filePath, initial, 'utf8');
        // Prior-read enforcement (origin/main #3774) requires the file
        // to have been Read before Edit can mutate it.
        seedPriorRead(filePath);
        const invocation = tool.build({
          file_path: filePath,
          old_string: 'old',
          new_string: 'new',
        });

        await invocation.execute(new AbortController().signal);

        const attribution =
          CommitAttributionService.getInstance().getFileAttribution(filePath);
        expect(attribution).toBeDefined();
        // The actual char count is implementation detail of
        // computeCharContribution; we only assert the entry exists
        // with a positive contribution.
        expect(attribution!.aiContribution).toBeGreaterThan(0);
        // Length sanity: contribution is bounded by the new content.
        expect(attribution!.aiContribution).toBeLessThanOrEqual(updated.length);
      });

      it('skips attribution when the edit is modified_by_user', async () => {
        fs.writeFileSync(filePath, 'old line', 'utf8');
        seedPriorRead(filePath);
        const invocation = tool.build({
          file_path: filePath,
          old_string: 'old',
          new_string: 'new',
          modified_by_user: true,
        });

        await invocation.execute(new AbortController().signal);

        expect(
          CommitAttributionService.getInstance().getFileAttribution(filePath),
        ).toBeUndefined();
      });
    });

    it('should create a new file if old_string is empty and file does not exist, and return created message', async () => {
      const newFileName = 'brand_new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const fileContent = 'Content for the new file.';
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: fileContent,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(/Created new file/);
      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file:/,
      );
      expect(fs.existsSync(newFilePath)).toBe(true);
      expect(fs.readFileSync(newFilePath, 'utf8')).toBe(fileContent);

      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(/\+Content for the new file\./);
      expect(display.fileName).toBe(newFileName);
      expect((result.returnDisplay as FileDiff).diffStat).toStrictEqual({
        model_added_lines: 1,
        model_removed_lines: 0,
        model_added_chars: 25,
        model_removed_chars: 0,
        user_added_lines: 0,
        user_removed_lines: 0,
        user_added_chars: 0,
        user_removed_chars: 0,
      });
    });

    it('should create new file with BOM when defaultFileEncoding is utf-8-bom', async () => {
      // Change config to use utf-8-bom
      (mockConfig.getDefaultFileEncoding as Mock).mockReturnValue('utf-8-bom');

      const newFileName = 'bom_new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const fileContent = 'Content for BOM file.';
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: fileContent,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      // Verify file has BOM
      const fileBuffer = fs.readFileSync(newFilePath);
      expect(fileBuffer[0]).toBe(0xef);
      expect(fileBuffer[1]).toBe(0xbb);
      expect(fileBuffer[2]).toBe(0xbf);
      expect(fileBuffer.toString('utf8')).toContain(fileContent);
    });

    it('should create new file without BOM when defaultFileEncoding is utf-8', async () => {
      // Config defaults to utf-8
      const newFileName = 'no_bom_new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const fileContent = 'Content without BOM.';
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: fileContent,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      // Verify file does not have BOM
      const fileBuffer = fs.readFileSync(newFilePath);
      expect(fileBuffer[0]).not.toBe(0xef);
      expect(fileBuffer.toString('utf8')).toBe(fileContent);
    });

    it('should preserve BOM character in content when editing existing file', async () => {
      const bomFilePath = path.join(rootDir, 'existing_bom.txt');
      // Create file with BOM (BOM is \ufeff character in string)
      const originalContent = '\ufeff// Original line\nconst x = 1;';
      fs.writeFileSync(bomFilePath, originalContent, 'utf8');
      seedPriorRead(bomFilePath);

      const params: EditToolParams = {
        file_path: bomFilePath,
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      // Verify file still has BOM and new content
      const resultContent = fs.readFileSync(bomFilePath, 'utf8');
      expect(resultContent.charCodeAt(0)).toBe(0xfeff); // BOM preserved
      expect(resultContent).toContain('const x = 2;');
    });

    it('should return error if old_string is not found in file', async () => {
      fs.writeFileSync(filePath, 'Some content.', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'nonexistent',
        new_string: 'replacement',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(
        /0 occurrences found for old_string in/,
      );
      expect(result.returnDisplay).toMatch(
        /Failed to edit, could not find the string to replace./,
      );
    });

    it('should return error if multiple occurrences of old_string are found and replace_all is false', async () => {
      fs.writeFileSync(filePath, 'multiple old old strings', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/replace_all was not enabled/);
      expect(result.returnDisplay).toMatch(
        /Failed to edit because the text matches multiple locations/,
      );
    });

    it('should successfully replace multiple occurrences when replace_all is true', async () => {
      fs.writeFileSync(filePath, 'old text\nold text\nold text', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        replace_all: true,
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toMatch(
        /Showing lines \d+-\d+ of \d+ from the edited file/,
      );
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'new text\nnew text\nnew text',
      );
      const display = result.returnDisplay as FileDiff;

      expect(display.fileDiff).toMatch(/-old text\n-old text\n-old text/);
      expect(display.fileDiff).toMatch(/\+new text\n\+new text\n\+new text/);
      expect(display.fileName).toBe(testFile);
      expect((result.returnDisplay as FileDiff).diffStat).toStrictEqual({
        model_added_lines: 3,
        model_removed_lines: 3,
        model_added_chars: 24,
        model_removed_chars: 24,
        user_added_lines: 0,
        user_removed_lines: 0,
        user_added_chars: 0,
        user_removed_chars: 0,
      });
    });

    it('should return error if trying to create a file that already exists (empty old_string)', async () => {
      fs.writeFileSync(filePath, 'Existing content', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: '',
        new_string: 'new content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/File already exists, cannot create/);
      expect(result.returnDisplay).toMatch(
        /Attempted to create a file that already exists/,
      );
    });

    it('should not include modification message when proposed content is not modified', async () => {
      const initialContent = 'This is some old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        modified_by_user: false,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should not include modification message when modified_by_user is not provided', async () => {
      const initialContent = 'This is some old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should return error if old_string and new_string are identical', async () => {
      const initialContent = 'This is some identical text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'identical',
        new_string: 'identical',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(/No changes to apply/);
      expect(result.returnDisplay).toMatch(/No changes to apply/);
    });

    it('should return EDIT_NO_CHANGE error if replacement results in identical content', async () => {
      // This can happen if the literal string replacement with `replaceAll` results in no change.
      const initialContent = 'line 1\nline  2\nline 3'; // Note the double space
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        // old_string has a single space, so it won't be found by replaceAll
        old_string: 'line 1\nline 2\nline 3',
        new_string: 'line 1\nnew line 2\nline 3',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
      expect(result.returnDisplay).toMatch(
        /Failed to edit, could not find the string to replace./,
      );
      // Ensure the file was not actually changed
      expect(fs.readFileSync(filePath, 'utf8')).toBe(initialContent);
    });
  });

  describe('Error Scenarios', () => {
    const testFile = 'error_test.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should return FILE_NOT_FOUND error', async () => {
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'any',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
    });

    it('should return ATTEMPT_TO_CREATE_EXISTING_FILE error', async () => {
      fs.writeFileSync(filePath, 'existing content', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: '',
        new_string: 'new content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(
        ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
      );
    });

    it('should return NO_OCCURRENCE_FOUND error', async () => {
      fs.writeFileSync(filePath, 'content', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'not-found',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
    });

    it('should return EXPECTED_OCCURRENCE_MISMATCH error when replace_all is false and text is not unique', async () => {
      fs.writeFileSync(filePath, 'one one two', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'one',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(
        ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      );
    });

    it('should return NO_CHANGE error', async () => {
      fs.writeFileSync(filePath, 'content', 'utf8');
      seedPriorRead(filePath);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'content',
        new_string: 'content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_CHANGE);
    });

    it('should throw INVALID_PARAMETERS error for relative path', async () => {
      const params: EditToolParams = {
        file_path: 'relative/path.txt',
        old_string: 'a',
        new_string: 'b',
      };
      expect(() => tool.build(params)).toThrow();
    });

    it('should return FILE_WRITE_FAILURE on write error', async () => {
      fs.writeFileSync(filePath, 'content', 'utf8');
      seedPriorRead(filePath);

      vi.spyOn(fsService, 'writeTextFile').mockRejectedValueOnce(
        new Error('Simulated write error'),
      );

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'content',
        new_string: 'new content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
    });
  });

  describe('getDescription', () => {
    it('should return "No file changes to..." if old_string and new_string are the same', () => {
      const testFileName = 'test.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'identical_string',
        new_string: 'identical_string',
      };
      const invocation = tool.build(params);
      // shortenPath will be called internally, resulting in just the file name
      expect(invocation.getDescription()).toBe(
        `No file changes to ${testFileName}`,
      );
    });

    it('should return a snippet of old and new strings if they are different', () => {
      const testFileName = 'test.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'this is the old string value',
        new_string: 'this is the new string value',
      };
      const invocation = tool.build(params);
      // shortenPath will be called internally, resulting in just the file name
      // The snippets are truncated at 30 chars + '...'
      expect(invocation.getDescription()).toBe(
        `${testFileName}: this is the old string value => this is the new string value`,
      );
    });

    it('should handle very short strings correctly in the description', () => {
      const testFileName = 'short.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(`${testFileName}: old => new`);
    });

    it('should truncate long strings in the description', () => {
      const testFileName = 'long.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string:
          'this is a very long old string that will definitely be truncated',
        new_string:
          'this is a very long new string that will also be truncated',
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        `${testFileName}: this is a very long old string... => this is a very long new string...`,
      );
    });
  });

  describe('FileReadCache integration', () => {
    it('records a write into the cache so a follow-up Read sees lastWriteAt', async () => {
      // Without this hook, ReadFile's `(lastWriteAt === undefined ||
      // lastReadAt > lastWriteAt)` guard would let a post-edit Read
      // return the pre-edit placeholder when the filesystem's mtime
      // resolution is too coarse to detect the edit.
      const filePath = path.join(rootDir, 'cached.txt');
      fs.writeFileSync(filePath, 'old content');

      // Simulate the model having Read the file before Edit fires.
      const preEditStats = fs.statSync(filePath);
      fileReadCache.recordRead(filePath, preEditStats, {
        full: true,
        cacheable: true,
      });
      const beforeRead = fileReadCache.check(preEditStats);
      expect(beforeRead.state).toBe('fresh');
      if (beforeRead.state === 'fresh') {
        expect(beforeRead.entry.lastWriteAt).toBeUndefined();
      }

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old content',
        new_string: 'new content',
      };
      const invocation = tool.build(params) as ToolInvocation<
        EditToolParams,
        ToolResult
      >;
      const abortSignal = new AbortController().signal;
      const result = await invocation.execute(abortSignal);
      expect(result.error).toBeUndefined();

      const postEditStats = fs.statSync(filePath);
      const after = fileReadCache.check(postEditStats);
      // After the edit, the cache entry's mtime+size match the new
      // file state and lastWriteAt has been stamped.
      expect(after.state).toBe('fresh');
      if (after.state === 'fresh') {
        expect(after.entry.lastWriteAt).toBeDefined();
        // lastReadAt was set by the simulated pre-edit Read; the
        // post-write timestamp must dominate it so subsequent Reads
        // do not return the placeholder.
        expect(after.entry.lastWriteAt!).toBeGreaterThanOrEqual(
          after.entry.lastReadAt!,
        );
      }
    });
  });

  describe('prior-read enforcement', () => {
    const abortSignal = new AbortController().signal;
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, 'enforce_target.txt');
    });

    it('rejects an edit when the file has not been read in this session', async () => {
      fs.writeFileSync(filePath, 'untouched content', 'utf8');
      // No seedPriorRead call — simulate the model trying to Edit a
      // file it has never received via ReadFile.
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'untouched',
        new_string: 'modified',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.message).toMatch(
        /has not been read in this session/,
      );
      // File must remain untouched.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('untouched content');
    });

    it('allows an edit after a ranged (offset/limit) read', async () => {
      // A partial read still counts as a prior read: requiring the
      // model to re-read multi-thousand-line files just to change one
      // line is wasteful, and the existing `0 occurrences` failure
      // mode catches the case the full-read requirement was meant to
      // defend against (a fabricated old_string that misses the
      // actual bytes). This matches Claude Code's `readFileState`
      // contract, which also accepts partial reads.
      fs.writeFileSync(filePath, 'line a\nline b\nline c\n', 'utf8');
      const stats = fs.statSync(filePath);
      fileReadCache.recordRead(filePath, stats, {
        full: false,
        cacheable: true,
      });
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );

      const result = await tool
        .build({ file_path: filePath, old_string: 'line a', new_string: 'X' })
        .execute(abortSignal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('X\nline b\nline c\n');
    });

    it('rejects an edit when the previous read was non-cacheable (binary / pdf / image)', async () => {
      // ReadFile records every successful read into the cache,
      // including binary / PDF / image reads that produce a
      // structured payload rather than text. lastReadCacheable=false
      // marks those — Edit must not accept them.
      fs.writeFileSync(filePath, 'pretend this is binary', 'utf8');
      const stats = fs.statSync(filePath);
      fileReadCache.recordRead(filePath, stats, {
        full: true,
        cacheable: false,
      });

      const result = await tool
        .build({
          file_path: filePath,
          old_string: 'pretend',
          new_string: 'X',
        })
        .execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      // Telling the model to re-read with read_file would loop the
      // agent forever: a binary/image/PDF read also leaves
      // lastReadCacheable=false. The message must explain the dead
      // end instead of asking for another read.
      expect(result.error?.message).toMatch(
        /binary \/ image \/ audio \/ video \/ PDF \/ notebook payload/,
      );
      expect(result.error?.message).not.toMatch(/Use the read_file tool first/);
      // EditTool's verb is "edit", not "overwrite" — using the
      // wrong one here would be confusing for in-place edits.
      expect(result.error?.message).toMatch(/if you need to edit it\./);
      expect(result.error?.message).not.toMatch(
        /if you need to overwrite it\./,
      );
    });

    it('rejects an edit on a directory with TARGET_IS_DIRECTORY', async () => {
      // Pre-fix, the directory exemption returned ok:true and
      // readTextFile would either throw EISDIR (caught by execute as
      // EDIT_PREPARATION_FAILURE) or — in WriteFile.getConfirmationDetails —
      // collapse into UNHANDLED_EXCEPTION. The structured rejection
      // here gives a stable error code regardless of where the call
      // hits in the pipeline.
      const dirPath = path.join(rootDir, 'enforce-dir');
      fs.mkdirSync(dirPath);
      const result = await tool
        .build({
          file_path: dirPath,
          old_string: 'foo',
          new_string: 'bar',
        })
        .execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
      expect(result.error?.message).toMatch(/is a directory/);
    });

    it('rejects an edit with a stat failure other than ENOENT (fail-closed)', async () => {
      // Symmetric with WriteFile's EACCES test. checkPriorRead is
      // shared today, but if a future change adds an Edit-side
      // fallback that downgrades a real verify failure to
      // EDIT_REQUIRES_PRIOR_READ, only the write path would catch
      // it without this test.
      fs.writeFileSync(filePath, 'untouched', 'utf8');
      const statSpy = vi
        .spyOn(fs.promises, 'stat')
        .mockRejectedValueOnce(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );

      const result = await tool
        .build({
          file_path: filePath,
          old_string: 'untouched',
          new_string: 'modified',
        })
        .execute(abortSignal);

      expect(result.error?.type).toBe(
        ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      );
      expect(result.error?.message).toMatch(/Could not stat .*\(EACCES\)/);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('untouched');

      statSpy.mockRestore();
    });

    it('does not let an unread file be probed via NO_OCCURRENCE_FOUND', async () => {
      // Regression for the read-less content oracle: pre-fix, a model
      // could call Edit with candidate old_strings on an unread file
      // and observe NO_OCCURRENCE_FOUND vs OCCURRENCE_MATCH to
      // reverse-engineer the contents. With enforcement before
      // calculateEdit, the call must be rejected with the prior-read
      // error code regardless of whether the candidate string would
      // have matched.
      fs.writeFileSync(filePath, 'sensitive token: hunter2', 'utf8');

      const result = await tool
        .build({
          file_path: filePath,
          old_string: 'hunter2',
          new_string: 'redacted',
        })
        .execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.type).not.toBe(
        ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      );
    });

    it('rejects confirmation requests on an unread file before showing a diff', async () => {
      // The user must not see a diff computed from current bytes the
      // model never received — they would approve under a false
      // assumption that the model worked from those bytes.
      fs.writeFileSync(filePath, 'unread content', 'utf8');
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'unread',
        new_string: 'modified',
      });
      await expect(
        invocation.getConfirmationDetails(abortSignal),
      ).rejects.toThrow(/has not been read in this session/);
    });

    it('rejects an edit when the file has been modified since the last read', async () => {
      fs.writeFileSync(filePath, 'one', 'utf8');
      seedPriorRead(filePath);
      // Simulate an out-of-band modification: change content + bump
      // mtime far enough into the future that even coarse-resolution
      // filesystems detect the change.
      fs.writeFileSync(filePath, 'two with more bytes', 'utf8');
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(filePath, future, future);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'two',
        new_string: 'three',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(result.error?.message).toMatch(/has been modified since/);
      // File must remain at the externally-modified content.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('two with more bytes');
    });

    it('exempts new-file creation from prior-read enforcement', async () => {
      // old_string === '' on a non-existent path is the new-file
      // creation idiom in EditTool. The model has nothing to read
      // first, so enforcement must not trigger.
      const newPath = path.join(rootDir, 'brand-new-edit.txt');
      const params: EditToolParams = {
        file_path: newPath,
        old_string: '',
        new_string: 'fresh creation',
      };
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(newPath, 'utf8')).toBe('fresh creation');
    });

    it('allows a create-then-edit-then-edit chain without an intervening read', async () => {
      // The author of a brand-new file has, by definition, "seen"
      // the bytes it just wrote. Without recordWrite seeding read
      // metadata, the second edit would be rejected because
      // lastReadWasFull / lastReadCacheable would still be unset on
      // the entry recordWrite created during the create step.
      const newPath = path.join(rootDir, 'create-then-edit.txt');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );

      const created = await tool
        .build({
          file_path: newPath,
          old_string: '',
          new_string: 'first content\n',
        })
        .execute(abortSignal);
      expect(created.error).toBeUndefined();

      const edited = await tool
        .build({
          file_path: newPath,
          old_string: 'first',
          new_string: 'second',
        })
        .execute(abortSignal);
      expect(edited.error).toBeUndefined();
      expect(fs.readFileSync(newPath, 'utf8')).toBe('second content\n');
    });

    it('allows Edit after Write→partial-Read', async () => {
      // The Write authors the bytes (recordWrite seeds the cache), and
      // a follow-up partial Read at the same fingerprint must not
      // disqualify the next Edit. After dropping the `lastReadWasFull`
      // requirement from prior-read enforcement, this is just the
      // generic "partial read counts" path; pre-fix it failed for a
      // different reason (the partial read overwrote the full-read
      // flag recordWrite had stamped, and enforcement still required
      // that flag).
      const newPath = path.join(rootDir, 'write-then-partial-read.txt');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );

      const created = await tool
        .build({
          file_path: newPath,
          old_string: '',
          new_string: 'line one\nline two\nline three\n',
        })
        .execute(abortSignal);
      expect(created.error).toBeUndefined();

      // Simulate a partial follow-up Read (offset/limit). Pre-fix
      // this overwrote lastReadWasFull/lastReadCacheable to false.
      fileReadCache.recordRead(newPath, fs.statSync(newPath), {
        full: false,
        cacheable: true,
      });

      const edited = await tool
        .build({
          file_path: newPath,
          old_string: 'line two',
          new_string: 'second line',
        })
        .execute(abortSignal);
      expect(edited.error).toBeUndefined();
      expect(fs.readFileSync(newPath, 'utf8')).toBe(
        'line one\nsecond line\nline three\n',
      );
    });

    it('allows a chain of edits without re-reading between them', async () => {
      // After the first Edit, recordWrite stamps `lastWriteAt`. The
      // second Edit's stat will still match the cache entry (because
      // recordWrite refreshed the fingerprint), so it is `fresh` and
      // proceeds without requiring an intervening Read.
      fs.writeFileSync(filePath, 'alpha', 'utf8');
      seedPriorRead(filePath);

      const first = await tool
        .build({ file_path: filePath, old_string: 'alpha', new_string: 'beta' })
        .execute(abortSignal);
      expect(first.error).toBeUndefined();

      const second = await tool
        .build({ file_path: filePath, old_string: 'beta', new_string: 'gamma' })
        .execute(abortSignal);
      expect(second.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('gamma');
    });

    it('bypasses enforcement entirely when fileReadCacheDisabled is true', async () => {
      fs.writeFileSync(filePath, 'untouched', 'utf8');
      // No seed: with the cache disabled, the model is on the
      // pre-cache contract — Edit must succeed without a prior Read.
      // Use mockReturnValue (not mockReturnValueOnce): calculateEdit
      // now calls getFileReadCacheDisabled twice — once before
      // readTextFile and once after, for the post-read TOCTOU
      // re-check — and both must see disabled=true to actually bypass.
      (mockConfig.getFileReadCacheDisabled as Mock).mockReturnValue(true);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'untouched',
        new_string: 'modified',
      };
      const result = await tool.build(params).execute(abortSignal);
      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('modified');
    });

    it('attaches a structured ToolErrorType when getConfirmationDetails rejects', async () => {
      // Without an `errorType` field on the thrown Error, the tool
      // scheduler reports every confirmation-time rejection as
      // UNHANDLED_EXCEPTION — losing the EDIT_REQUIRES_PRIOR_READ /
      // FILE_CHANGED_SINCE_READ contract this PR introduces.
      fs.writeFileSync(filePath, 'unread content', 'utf8');
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'unread',
        new_string: 'modified',
      });
      let caught: unknown;
      try {
        await invocation.getConfirmationDetails(abortSignal);
      } catch (err) {
        caught = err;
      }
      expect((caught as { errorType?: string })?.errorType).toBe(
        ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      );
    });
  });

  describe.skipIf(process.platform === 'win32')(
    'escaped paths with spaces (end-to-end)',
    () => {
      it('should read and edit a file whose name contains spaces when given an escaped path', async () => {
        // Create a file with spaces in its name on disk
        const realFileName = 'my spaced file.txt';
        const realPath = path.join(rootDir, realFileName);
        fs.writeFileSync(realPath, 'Hello old world!', 'utf8');
        // The Edit's prior-read enforcement is keyed off the
        // *unescaped* path that EditTool resolves internally; seed
        // the cache against that real path so this test exercises
        // the escape-handling, not the enforcement layer.
        seedPriorRead(realPath);

        // Pass an ESCAPED path (as the LLM might from at-completion)
        const escapedPath = path.join(rootDir, 'my\\ spaced\\ file.txt');
        const params: EditToolParams = {
          file_path: escapedPath,
          old_string: 'old',
          new_string: 'new',
        };

        (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
          ApprovalMode.AUTO_EDIT,
        );

        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        // Should succeed — not fail with file-not-found
        expect(result.llmContent).toMatch(/Showing lines \d+-\d+ of \d+/);
        expect(fs.readFileSync(realPath, 'utf8')).toBe('Hello new world!');
      });

      it('should fail gracefully when escaped path points to nonexistent file', async () => {
        const escapedPath = path.join(rootDir, 'nonexistent\\ file.txt');
        const params: EditToolParams = {
          file_path: escapedPath,
          old_string: 'old',
          new_string: 'new',
        };

        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        // Should report file-not-found (unescaped path used, file truly doesn't exist)
        expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
      });
    },
  );

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      const validPath = {
        file_path: path.join(rootDir, 'file.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(validPath)).toBeNull();
    });

    it('should allow paths outside workspace root (external path support)', () => {
      const externalPath = {
        file_path: '/etc/passwd',
        old_string: 'root',
        new_string: 'hacked',
      };
      const error = tool.validateToolParams(externalPath);
      expect(error).toBeNull();
    });
  });
});
