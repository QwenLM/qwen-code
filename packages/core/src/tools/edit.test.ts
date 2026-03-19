/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGenerateJson = vi.hoisted(() => vi.fn());
const mockOpenDiff = vi.hoisted(() => vi.fn());

import { IdeClient } from '../ide/ide-client.js';

vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn(),
  },
}));

vi.mock('../utils/editor.js', () => ({
  openDiff: mockOpenDiff,
}));

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
  logEditStrategy: vi.fn(),
}));

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EditToolParams } from './edit.js';
import { applyReplacement, calculateReplacement, EditTool } from './edit.js';
import type { FileDiff } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';

describe('EditTool', () => {
  let tool: EditTool;
  let tempDir: string;
  let rootDir: string;
  let mockConfig: Config;
  let geminiClient: any;
  let baseLlmClient: any;
  let fileSystemService: StandardFileSystemService;

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    rootDir = path.join(tempDir, 'root');
    fs.mkdirSync(rootDir);

    geminiClient = {
      generateJson: mockGenerateJson, // mockGenerateJson is already defined and hoisted
    };

    baseLlmClient = {
      generateJson: vi.fn(),
    };

    fileSystemService = new StandardFileSystemService();

    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue(geminiClient),
      getBaseLlmClient: vi.fn().mockReturnValue(baseLlmClient),
      getTargetDir: () => rootDir,
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getWorkspaceContext: () => createMockWorkspaceContext(rootDir),
      getFileSystemService: vi.fn().mockReturnValue(fileSystemService),
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

  // ---------------------------------------------------------------------------
  // calculateReplacement — strategy pipeline
  // ---------------------------------------------------------------------------

  describe('calculateReplacement', () => {
    const abortSignal = new AbortController().signal;
    const ctx = (
      content: string,
      old_string: string,
      new_string: string,
      replace_all = false,
    ) => ({
      params: { file_path: 'test.ts', old_string, new_string, replace_all },
      currentContent: content,
      abortSignal,
    });

    it('returns 0 occurrences for empty old_string without touching content', async () => {
      const result = await calculateReplacement(
        mockConfig,
        ctx('hello', '', 'x'),
      );
      expect(result.occurrences).toBe(0);
      expect(result.newContent).toBe('hello');
    });

    describe('exact strategy', () => {
      it('replaces a single occurrence', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('hello world', 'world', 'moon'),
        );
        expect(result.newContent).toBe('hello moon');
        expect(result.occurrences).toBe(1);
      });

      it('replaces all occurrences when replace_all is true', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('foo foo foo', 'foo', 'bar', true),
        );
        expect(result.newContent).toBe('bar bar bar');
        expect(result.occurrences).toBe(3);
      });

      it('returns occurrences > 1 without replacing when replace_all is false', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('foo foo', 'foo', 'bar', false),
        );
        expect(result.occurrences).toBe(2);
        expect(result.newContent).toBe('foo foo'); // unchanged
      });

      it('normalises CRLF in old_string before matching', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('line1\nline2', 'line1\r\nline2', 'replaced'),
        );
        expect(result.occurrences).toBe(1);
        expect(result.newContent).toBe('replaced');
      });

      it('preserves trailing newline after replacement', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('foo\n', 'foo', 'bar'),
        );
        expect(result.newContent).toBe('bar\n');
      });

      it('does not add trailing newline when original lacked one', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('foo', 'foo', 'bar'),
        );
        expect(result.newContent).toBe('bar');
      });
    });

    describe('flexible strategy', () => {
      it('matches when only leading/trailing whitespace per line differs', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('  hello\n    world\n', 'hello\nworld', 'goodbye\nmoon'),
        );
        expect(result.newContent).toBe('  goodbye\n  moon\n');
        expect(result.occurrences).toBe(1);
      });

      it('rebases indentation without double-indenting', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx(
            '    if (a) {\n        foo();\n    }\n',
            'if (a) {\n    foo();\n}',
            'if (a) {\n    bar();\n}',
          ),
        );
        expect(result.occurrences).toBe(1);
        expect(result.newContent).toBe('    if (a) {\n        bar();\n    }\n');
      });

      it('does not insert extra newlines when old_string starts with blank line', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx(
            '  // comment\n\n  function old() {}',
            '\nfunction old() {}',
            '\n  function new_() {}',
          ),
        );
        expect(result.newContent).toBe('  // comment\n\n  function new_() {}');
      });
    });

    describe('regex strategy', () => {
      it('matches when intra-line whitespace differs (triggers regex, not flexible)', async () => {
        const content = '  function  myFunc( a, b ) {\n    return a + b;\n  }';
        const result = await calculateReplacement(
          mockConfig,
          ctx(content, 'function myFunc(a, b) {', 'const f = (a, b) => {'),
        );
        expect(result.occurrences).toBe(1);
        expect(result.newContent).toBe(
          '  const f = (a, b) => {\n    return a + b;\n  }',
        );
      });

      it('does not insert extra newlines when block is preceded by a blank line', async () => {
        const content = '\n  function oldFunc() {\n    // code\n  }';
        const result = await calculateReplacement(
          mockConfig,
          ctx(
            content,
            'function  oldFunc() {\n    // code\n  }',
            'function newFunc() {\n  // new\n}',
          ),
        );
        expect(result.newContent).toBe(
          '\n  function newFunc() {\n    // new\n  }',
        );
      });
    });

    describe('fuzzy strategy', () => {
      it('matches when a single character is missing (typo)', async () => {
        const content =
          'const myConfig = {\n  enableFeature: true,\n  retries: 3\n};';
        const oldString =
          'const myConfig = {\n  enableFeature: true\n  retries: 3\n};'; // missing comma
        const newString =
          'const myConfig = {\n  enableFeature: false,\n  retries: 5\n};';
        const result = await calculateReplacement(
          mockConfig,
          ctx(content, oldString, newString),
        );
        expect(result.occurrences).toBe(1);
        expect(result.strategy).toBe('fuzzy');
        expect(result.newContent).toBe(newString);
      });

      it('sets matchRanges on fuzzy result', async () => {
        const content =
          'const myConfig = {\n  enableFeature: true,\n  retries: 3\n};';
        const oldString =
          'const myConfig = {\n  enableFeature: true\n  retries: 3\n};';
        const result = await calculateReplacement(
          mockConfig,
          ctx(
            content,
            oldString,
            'const myConfig = {\n  enableFeature: false,\n  retries: 5\n};',
          ),
        );
        expect(result.matchRanges).toBeDefined();
        expect(result.matchRanges!.length).toBe(1);
        expect(result.matchRanges![0].start).toBeGreaterThan(0);
      });

      it('rebases indentation in fuzzy match', async () => {
        const content =
          '    const myConfig = {\n      enableFeature: true,\n      retries: 3\n    };';
        const fuzzyOld =
          'const myConfig = {\n  enableFeature: true\n  retries: 3\n};';
        const fuzzyNew =
          'const myConfig = {\n  enableFeature: false,\n  retries: 5\n};';
        const result = await calculateReplacement(
          mockConfig,
          ctx(content, fuzzyOld, fuzzyNew),
        );
        expect(result.strategy).toBe('fuzzy');
        expect(result.newContent).toBe(
          '    const myConfig = {\n      enableFeature: false,\n      retries: 5\n    };',
        );
      });

      it('replaces multiple fuzzy matches', async () => {
        const content =
          '\nfunction doIt() {\n  console.log("hello");\n}\n\nfunction doIt() {\n  console.log("hello");\n}\n';
        const oldString = "function doIt() {\n  console.log('hello');\n}"; // single quotes vs double
        const newString = 'function doIt() {\n  console.log("bye");\n}';
        const result = await calculateReplacement(
          mockConfig,
          ctx(content, oldString, newString),
        );
        expect(result.occurrences).toBe(2);
        expect(result.newContent).toBe(
          '\nfunction doIt() {\n  console.log("bye");\n}\n\nfunction doIt() {\n  console.log("bye");\n}\n',
        );
      });

      it('does not fuzzy-match when old_string is shorter than 10 chars', async () => {
        const result = await calculateReplacement(
          mockConfig,
          ctx('short txt', 'shor txt', 'new'),
        );
        expect(result.occurrences).toBe(0);
      });

      it('does not fuzzy-match when similarity is below threshold', async () => {
        const content =
          'const myConfig = {\n  enableFeature: true,\n  retries: 3\n};';
        const result = await calculateReplacement(
          mockConfig,
          ctx(
            content,
            'function somethingElse() {\n  return false;\n}',
            'replaced',
          ),
        );
        expect(result.occurrences).toBe(0);
        expect(result.newContent).toBe(content);
      });

      it('does not fuzzy-match when complexity exceeds the guard', async () => {
        const longString = 'a'.repeat(2000);
        const content = Array(200).fill(longString).join('\n');
        const result = await calculateReplacement(
          mockConfig,
          ctx(content, longString + 'c', 'replacement'),
        );
        expect(result.occurrences).toBe(0);
        expect(result.newContent).toBe(content);
      });
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

    it('should return error for path outside root', () => {
      const params: EditToolParams = {
        file_path: path.join(tempDir, 'outside-root.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      const error = tool.validateToolParams(params);
      expect(error).toContain(
        'File path must be within one of the workspace directories',
      );
    });
  });

  describe('shouldConfirmExecute', () => {
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
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
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

    it('should return false and skip confirmation when approval mode is AUTO_EDIT', async () => {
      fs.writeFileSync(filePath, 'some old content here');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(confirmation).toBe(false);
    });

    it('should return false and skip confirmation when approval mode is YOLO', async () => {
      fs.writeFileSync(filePath, 'some old content here');
      (mockConfig.getApprovalMode as Mock).mockReturnValue(ApprovalMode.YOLO);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(confirmation).toBe(false);
    });

    it('should return false if old_string is not found', async () => {
      fs.writeFileSync(filePath, 'some content here');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'not_found',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(confirmation).toBe(false);
    });

    it('should return false if multiple occurrences of old_string are found', async () => {
      fs.writeFileSync(filePath, 'old old content here');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(confirmation).toBe(false);
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
      const confirmation = await invocation.shouldConfirmExecute(
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
        invocation.shouldConfirmExecute(abortController.signal),
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

    it('should match via flexible strategy when old_string differs only in intra-line whitespace', async () => {
      // The flexible strategy strips per-line whitespace before comparing,
      // so it finds the match that the exact strategy misses.
      const initialContent = 'line 1\nline  2\nline 3'; // Note the double space
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'line 1\nline 2\nline 3',
        new_string: 'line 1\nnew line 2\nline 3',
      };

      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'line 1\nnew line 2\nline 3',
      );
    });

    it('should return EDIT_NO_CHANGE when replacement produces content identical to current', async () => {
      // The flexible strategy rebases indentation, so "new" content can end up
      // identical to the original when old and new strings map to the same output.
      const initialContent = 'foo\n';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'foo',
        new_string: 'foo', // same text — pipeline catches this via finalOldString === finalNewString
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_NO_CHANGE);
    });

    it('should include modification message when modified_by_user is true', async () => {
      fs.writeFileSync(filePath, 'some old text', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        modified_by_user: true,
      };
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.llmContent).toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should include fuzzy match feedback in llmContent when fuzzy strategy is used', async () => {
      const initialContent =
        'const myConfig = {\n  enableFeature: true,\n  retries: 3\n};';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string:
          'const myConfig = {\n  enableFeature: true\n  retries: 3\n};', // missing comma
        new_string:
          'const myConfig = {\n  enableFeature: false,\n  retries: 5\n};',
      };
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/Applied fuzzy match at line/);
    });

    it('should return EDIT_PREPARATION_FAILURE for unexpected non-abort errors from calculateEdit', async () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'prepare-fail.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);
      const unexpectedError = new Error('unexpected disk error');

      vi.spyOn(invocation as any, 'calculateEdit').mockRejectedValueOnce(
        unexpectedError,
      );

      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_PREPARATION_FAILURE);
      expect(result.llmContent).toMatch(/unexpected disk error/);
    });

    it('should create parent directories if they do not exist', async () => {
      const deepPath = path.join(rootDir, 'a', 'b', 'c', 'new.txt');
      const params: EditToolParams = {
        file_path: deepPath,
        old_string: '',
        new_string: 'hello',
      };
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);
      expect(fs.existsSync(deepPath)).toBe(true);
      expect(fs.readFileSync(deepPath, 'utf8')).toBe('hello');
    });

    it('should use ai_proposed_content for diffStat when provided', async () => {
      // ai_proposed_content represents what the AI originally proposed;
      // new_string is what was actually written (user-modified).
      // diffStat should measure the diff between current file and ai_proposed_content.
      const initialContent = 'original line\n';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const aiProposed = 'ai proposed line\n';
      const userModified = 'user modified line\n';
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'original line',
        new_string: 'user modified line',
        ai_proposed_content: aiProposed,
        modified_by_user: true,
      };
      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      const display = result.returnDisplay as FileDiff;
      // The file on disk should reflect new_string (user-modified)
      expect(fs.readFileSync(filePath, 'utf8')).toBe(userModified);
      // diffStat compares original content with ai_proposed_content
      expect(display.diffStat).toBeDefined();
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
      // Use a service spy rather than chmod, which is ineffective when running as root.
      const failingService = new StandardFileSystemService();
      vi.spyOn(failingService, 'writeTextFile').mockRejectedValueOnce(
        new Error('EACCES: permission denied'),
      );
      (
        mockConfig.getFileSystemService as ReturnType<typeof vi.fn>
      ).mockReturnValue(failingService);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'content',
        new_string: 'new content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
    });

    it('should return READ_CONTENT_FAILURE when file exists but readTextFile returns null content', async () => {
      fs.writeFileSync(filePath, 'content', 'utf8');
      const failingService = new StandardFileSystemService();
      // Simulate a read that succeeds structurally but returns null-ish content
      vi.spyOn(failingService, 'readTextFile').mockResolvedValueOnce({
        content: null as any,
        _meta: { bom: false, encoding: 'utf-8' },
      });
      (
        mockConfig.getFileSystemService as ReturnType<typeof vi.fn>
      ).mockReturnValueOnce(failingService);

      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'content',
        new_string: 'new content',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
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

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      const validPath = {
        file_path: path.join(rootDir, 'file.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(validPath)).toBeNull();
    });

    it('should reject paths outside workspace root', () => {
      const invalidPath = {
        file_path: '/etc/passwd',
        old_string: 'root',
        new_string: 'hacked',
      };
      const error = tool.validateToolParams(invalidPath);
      expect(error).toContain(
        'File path must be within one of the workspace directories',
      );
      expect(error).toContain(rootDir);
    });
  });

  describe('IDE mode', () => {
    const testFile = 'edit_me.txt';
    let filePath: string;
    let ideClient: any;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
      ideClient = {
        openDiff: vi.fn(),
        isDiffingEnabled: vi.fn().mockReturnValue(true),
      };
      vi.mocked(IdeClient.getInstance).mockResolvedValue(ideClient);
      (mockConfig as any).getIdeMode = () => true;
    });

    it('should call ideClient.openDiff and update params on confirmation', async () => {
      const initialContent = 'some old content here';
      const newContent = 'some new content here';
      const modifiedContent = 'some modified content here';
      fs.writeFileSync(filePath, initialContent);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      ideClient.openDiff.mockResolvedValueOnce({
        status: 'accepted',
        content: modifiedContent,
      });

      const invocation = tool.build(params);
      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(ideClient.openDiff).toHaveBeenCalledWith(filePath, newContent);

      if (confirmation && 'onConfirm' in confirmation) {
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }

      expect(params.old_string).toBe(initialContent);
      expect(params.new_string).toBe(modifiedContent);
    });
  });

  // ---------------------------------------------------------------------------
  // getDescription — Create branch
  // ---------------------------------------------------------------------------

  describe('getDescription (create branch)', () => {
    it('should return "Create <file>" when old_string is empty', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'brand_new.ts'),
        old_string: '',
        new_string: 'console.log("hello");',
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe('Create brand_new.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // replace_all parametrised matrix
  // ---------------------------------------------------------------------------

  describe('replace_all', () => {
    const testFile = 'replacements_test.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it.each([
      {
        name: 'succeed when replace_all is true and there are multiple occurrences',
        content: 'foo foo foo',
        replace_all: true as const,
        shouldSucceed: true,
        finalContent: 'bar bar bar',
      },
      {
        name: 'succeed when replace_all is true and there is exactly 1 occurrence',
        content: 'foo',
        replace_all: true as const,
        shouldSucceed: true,
        finalContent: 'bar',
      },
      {
        name: 'fail when replace_all is false and there are multiple occurrences',
        content: 'foo foo foo',
        replace_all: false as const,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      },
      {
        name: 'default to 1 expected replacement if replace_all not specified',
        content: 'foo foo',
        replace_all: undefined,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      },
      {
        name: 'succeed when replace_all is false and there is exactly 1 occurrence',
        content: 'foo',
        replace_all: false as const,
        shouldSucceed: true,
        finalContent: 'bar',
      },
      {
        name: 'fail when replace_all is true but there are 0 occurrences',
        content: 'baz',
        replace_all: true as const,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      },
      {
        name: 'fail when replace_all is false but there are 0 occurrences',
        content: 'baz',
        replace_all: false as const,
        shouldSucceed: false,
        expectedError: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      },
    ])(
      'should $name',
      async ({
        content,
        replace_all,
        shouldSucceed,
        finalContent,
        expectedError,
      }) => {
        fs.writeFileSync(filePath, content, 'utf8');
        const params: EditToolParams = {
          file_path: filePath,
          old_string: 'foo',
          new_string: 'bar',
          ...(replace_all !== undefined && { replace_all }),
        };
        const invocation = tool.build(params);
        const result = await invocation.execute(new AbortController().signal);

        if (shouldSucceed) {
          expect(result.error).toBeUndefined();
          if (finalContent)
            expect(fs.readFileSync(filePath, 'utf8')).toBe(finalContent);
        } else {
          expect(result.error?.type).toBe(expectedError);
        }
      },
    );
  });

  // ---------------------------------------------------------------------------
  // shouldConfirmExecute — ProceedAlways sets AUTO_EDIT
  // ---------------------------------------------------------------------------

  describe('shouldConfirmExecute (ProceedAlways)', () => {
    it('should call setApprovalMode(AUTO_EDIT) when outcome is ProceedAlways', async () => {
      const filePath = path.join(rootDir, 'confirm_always.txt');
      fs.writeFileSync(filePath, 'some old content');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);

      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(confirmation).not.toBe(false);

      if (confirmation && 'onConfirm' in confirmation) {
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedAlways);
      }

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.AUTO_EDIT,
      );
    });

    it('should NOT call setApprovalMode when outcome is ProceedOnce', async () => {
      const filePath = path.join(rootDir, 'confirm_once.txt');
      fs.writeFileSync(filePath, 'some old content');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      const invocation = tool.build(params);

      const confirmation = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      if (confirmation && 'onConfirm' in confirmation) {
        await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }
      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // toolLocations
  // ---------------------------------------------------------------------------

  describe('toolLocations', () => {
    it('should return the file_path as the tool location', () => {
      const filePath = path.join(rootDir, 'location.txt');
      const invocation = tool.build({
        file_path: filePath,
        old_string: 'a',
        new_string: 'b',
      });
      expect(invocation.toolLocations()).toEqual([{ path: filePath }]);
    });
  });

  // ---------------------------------------------------------------------------
  // getModifyContext
  // ---------------------------------------------------------------------------

  describe('getModifyContext', () => {
    const signal = new AbortController().signal;

    it('getFilePath returns file_path from params', () => {
      const filePath = path.join(rootDir, 'ctx.txt');
      const ctx = tool.getModifyContext(signal);
      expect(
        ctx.getFilePath({
          file_path: filePath,
          old_string: '',
          new_string: '',
        }),
      ).toBe(filePath);
    });

    it('getCurrentContent returns empty string when file does not exist', async () => {
      const ctx = tool.getModifyContext(signal);
      const result = await ctx.getCurrentContent({
        file_path: path.join(rootDir, 'nonexistent.txt'),
        old_string: '',
        new_string: '',
      });
      expect(result).toBe('');
    });

    it('getCurrentContent returns file content when file exists', async () => {
      const filePath = path.join(rootDir, 'ctx_read.txt');
      fs.writeFileSync(filePath, 'hello content', 'utf8');
      const ctx = tool.getModifyContext(signal);
      const result = await ctx.getCurrentContent({
        file_path: filePath,
        old_string: '',
        new_string: '',
      });
      expect(result).toBe('hello content');
    });

    it('getProposedContent returns empty string when file does not exist', async () => {
      const ctx = tool.getModifyContext(signal);
      const result = await ctx.getProposedContent({
        file_path: path.join(rootDir, 'nonexistent.txt'),
        old_string: 'x',
        new_string: 'y',
      });
      expect(result).toBe('');
    });

    it('getProposedContent returns content with replacement applied', async () => {
      const filePath = path.join(rootDir, 'ctx_proposed.txt');
      fs.writeFileSync(filePath, 'hello old world', 'utf8');
      const ctx = tool.getModifyContext(signal);
      const result = await ctx.getProposedContent({
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      });
      expect(result).toBe('hello new world');
    });

    it('getProposedContent treats empty file + empty old_string as new file creation', async () => {
      const filePath = path.join(rootDir, 'ctx_new.txt');
      fs.writeFileSync(filePath, '', 'utf8');
      const ctx = tool.getModifyContext(signal);
      const result = await ctx.getProposedContent({
        file_path: filePath,
        old_string: '',
        new_string: 'brand new content',
      });
      expect(result).toBe('brand new content');
    });

    it('createUpdatedParams builds correct params with modified_by_user flag', () => {
      const ctx = tool.getModifyContext(signal);
      const original: EditToolParams = {
        file_path: path.join(rootDir, 'f.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      const updated = ctx.createUpdatedParams(
        'full old content',
        'full new content',
        original,
      );
      expect(updated.old_string).toBe('full old content');
      expect(updated.new_string).toBe('full new content');
      expect(updated.ai_proposed_content).toBe('full old content');
      expect(updated.modified_by_user).toBe(true);
      expect(updated.file_path).toBe(original.file_path);
    });
  });
});
