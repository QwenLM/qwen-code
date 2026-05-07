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
import { WriteFileTool } from './write-file.js';
import { ToolErrorType } from './tool-error.js';
import type { FileDiff, ToolEditConfirmationDetails } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { GeminiClient } from '../core/client.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';

const rootDir = path.resolve(os.tmpdir(), 'qwen-code-test-root');

// --- MOCKS ---
vi.mock('../core/client.js');

let mockGeminiClientInstance: Mocked<GeminiClient>;

// Mock Config
const fsService = new StandardFileSystemService();
const fileReadCache = new FileReadCache();
const mockConfigInternal = {
  getTargetDir: () => rootDir,
  getProjectRoot: () => rootDir,
  getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
  setApprovalMode: vi.fn(),
  getGeminiClient: vi.fn(), // Initialize as a plain mock function
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
  getGeminiMdFileCount: () => 0,
  setGeminiMdFileCount: vi.fn(),
  getToolRegistry: () =>
    ({
      registerTool: vi.fn(),
      discoverTools: vi.fn(),
    }) as unknown as ToolRegistry,
  getDefaultFileEncoding: () => 'utf-8',
  getFileReadCache: () => fileReadCache,
  getFileReadCacheDisabled: () => false,
};
const mockConfig = mockConfigInternal as unknown as Config;

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

// --- END MOCKS ---

describe('WriteFileTool', () => {
  let tool: WriteFileTool;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // The fileReadCache is module-scope (declared at L41) and shared
    // across every test in this file, so state from one test leaks
    // into the next. Clear it before each test so every test starts
    // from a known-empty cache. CI surfaced this on Linux only because
    // file-creation order across tests differs by platform.
    fileReadCache.clear();
    // Create a unique temporary directory for files created outside the root
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'write-file-test-external-'),
    );
    // Ensure the rootDir for the tool exists
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    // Setup GeminiClient mock
    mockGeminiClientInstance = new (vi.mocked(GeminiClient))(
      mockConfig,
    ) as Mocked<GeminiClient>;
    vi.mocked(GeminiClient).mockImplementation(() => mockGeminiClientInstance);

    // Now that mockGeminiClientInstance is initialized, set the mock implementation for getGeminiClient
    mockConfigInternal.getGeminiClient.mockReturnValue(
      mockGeminiClientInstance,
    );

    tool = new WriteFileTool(mockConfig);

    // Reset mocks before each test
    mockConfigInternal.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    mockConfigInternal.setApprovalMode.mockClear();
  });

  afterEach(() => {
    // Clean up the temporary directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  /**
   * Simulate the model having read `filePath` earlier in the session,
   * so the WriteFileTool's prior-read enforcement does not reject the
   * subsequent overwrite. New-file creation paths do not need this.
   */
  function seedPriorRead(filePath: string) {
    const stats = fs.statSync(filePath);
    fileReadCache.recordRead(filePath, stats, {
      full: true,
      cacheable: true,
    });
  }

  describe('build', () => {
    it('should return an invocation for a valid absolute path within root', () => {
      const params = {
        file_path: path.join(rootDir, 'test.txt'),
        content: 'hello',
      };
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
      const params = {
        file_path: outsidePath,
        content: 'hello',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });

    it('should throw an error if path is a directory', () => {
      const dirAsFilePath = path.join(rootDir, 'a_directory');
      fs.mkdirSync(dirAsFilePath);
      const params = {
        file_path: dirAsFilePath,
        content: 'hello',
      };
      expect(() => tool.build(params)).toThrow(
        `Path is a directory, not a file: ${dirAsFilePath}`,
      );
    });

    it('should coerce null content into an empty string', () => {
      const params = {
        file_path: path.join(rootDir, 'test.txt'),
        content: null,
      } as unknown as WriteFileToolParams; // Intentionally non-conforming
      expect(() => tool.build(params)).toBeDefined();
    });

    it('should throw error if the file_path is empty', () => {
      const dirAsFilePath = path.join(rootDir, 'a_directory');
      fs.mkdirSync(dirAsFilePath);
      const params = {
        file_path: '',
        content: '',
      };
      expect(() => tool.build(params)).toThrow(`Missing or empty "file_path"`);
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        // On Windows, unescapePath is a no-op and backslashes are path
        // separators, so the expected unescape behavior doesn't apply.
        const escapedPath = path.join(rootDir, 'my\\ file.txt');
        const params = {
          file_path: escapedPath,
          content: 'hello',
        };
        const invocation = tool.build(params);
        expect(invocation).toBeDefined();
        expect(invocation.params.file_path).toBe(
          path.join(rootDir, 'my file.txt'),
        );
      },
    );
  });

  describe('shouldConfirmExecute', () => {
    const abortSignal = new AbortController().signal;

    it('should always return ask from getDefaultPermission', async () => {
      const filePath = path.join(rootDir, 'confirm_permission_file.txt');
      const params = { file_path: filePath, content: 'test content' };
      const invocation = tool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');
    });

    it('should throw if _getCorrectedFileContent returns an error', async () => {
      const filePath = path.join(rootDir, 'confirm_error_file.txt');
      const params = { file_path: filePath, content: 'test content' };
      fs.writeFileSync(filePath, 'original', { mode: 0o000 });
      seedPriorRead(filePath);

      const readError = new Error('Simulated read error for confirmation');
      vi.spyOn(fsService, 'readTextFile').mockImplementationOnce(() =>
        Promise.reject(readError),
      );

      const invocation = tool.build(params);
      await expect(
        invocation.getConfirmationDetails(abortSignal),
      ).rejects.toThrow('Error reading existing file for confirmation');

      fs.chmodSync(filePath, 0o600);
    });

    it('should request confirmation with diff for a new file', async () => {
      const filePath = path.join(rootDir, 'confirm_new_file.txt');
      const proposedContent = 'Proposed new content for confirmation.';

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);
      const confirmation = (await invocation.getConfirmationDetails(
        abortSignal,
      )) as ToolEditConfirmationDetails;

      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Write: ${path.basename(filePath)}`,
          fileName: 'confirm_new_file.txt',
          fileDiff: expect.stringContaining(proposedContent),
        }),
      );
      expect(confirmation.fileDiff).toMatch(
        /--- confirm_new_file.txt\tCurrent/,
      );
      expect(confirmation.fileDiff).toMatch(
        /\+\+\+ confirm_new_file.txt\tProposed/,
      );
    });

    it('should request confirmation with diff for an existing file', async () => {
      const filePath = path.join(rootDir, 'confirm_existing_file.txt');
      const originalContent = 'Original content for confirmation.';
      const proposedContent = 'Proposed replacement for confirmation.';
      fs.writeFileSync(filePath, originalContent, 'utf8');
      seedPriorRead(filePath);

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);
      const confirmation = (await invocation.getConfirmationDetails(
        abortSignal,
      )) as ToolEditConfirmationDetails;

      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Write: ${path.basename(filePath)}`,
          fileName: 'confirm_existing_file.txt',
          fileDiff: expect.stringContaining(proposedContent),
        }),
      );
      expect(confirmation.fileDiff).toMatch(
        originalContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
    });
  });

  describe('execute', () => {
    const abortSignal = new AbortController().signal;

    it('should return error if _getCorrectedFileContent returns an error during execute', async () => {
      const filePath = path.join(rootDir, 'execute_error_file.txt');
      const params = { file_path: filePath, content: 'test content' };
      fs.writeFileSync(filePath, 'original', { mode: 0o000 });
      seedPriorRead(filePath);

      vi.spyOn(fsService, 'readTextFile').mockImplementationOnce(() => {
        const readError = new Error('Simulated read error for execute');
        return Promise.reject(readError);
      });

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);
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
      const filePath = path.join(rootDir, 'execute_new_file.txt');
      const proposedContent = 'Proposed new content for execute.';

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);

      const confirmDetails =
        await invocation.getConfirmationDetails(abortSignal);
      if (
        typeof confirmDetails === 'object' &&
        'onConfirm' in confirmDetails &&
        confirmDetails.onConfirm
      ) {
        await confirmDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }

      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toMatch(
        /Successfully created and wrote to new file/,
      );
      expect(fs.existsSync(filePath)).toBe(true);
      const { content: writtenContent } = await fsService.readTextFile({
        path: filePath,
      });
      expect(writtenContent).toBe(proposedContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_new_file.txt');
      expect(display.fileDiff).toMatch(/--- execute_new_file.txt\tOriginal/);
      expect(display.fileDiff).toMatch(/\+\+\+ execute_new_file.txt\tWritten/);
      expect(display.fileDiff).toMatch(
        proposedContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
    });

    it('should overwrite an existing file and return diff', async () => {
      const filePath = path.join(rootDir, 'execute_existing_file.txt');
      const initialContent = 'Initial content for execute.';
      const proposedContent = 'Proposed overwrite for execute.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      seedPriorRead(filePath);

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);

      const confirmDetails =
        await invocation.getConfirmationDetails(abortSignal);
      if (
        typeof confirmDetails === 'object' &&
        'onConfirm' in confirmDetails &&
        confirmDetails.onConfirm
      ) {
        await confirmDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }

      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toMatch(/Successfully overwrote file/);
      const { content: writtenContent } = await fsService.readTextFile({
        path: filePath,
      });
      expect(writtenContent).toBe(proposedContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileName).toBe('execute_existing_file.txt');
      expect(display.fileDiff).toMatch(
        initialContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
      expect(display.fileDiff).toMatch(
        proposedContent.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'),
      );
    });

    it('should treat metadata ENOENT as new file when readTextFile returned empty content', async () => {
      const filePath = path.join(rootDir, 'execute_acp_like_missing_file.txt');
      const proposedContent = 'content from acp-like flow';
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      // Simulate ENOENT: file does not exist, readTextFile throws ENOENT.
      const enoentError = new Error('File not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce(enoentError);

      const params = { file_path: filePath, content: proposedContent };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(
        /Successfully created and wrote to new file/,
      );
      expect(writeSpy).toHaveBeenCalledWith({
        path: filePath,
        content: proposedContent,
        _meta: {
          bom: false,
          encoding: undefined,
        },
      });
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(proposedContent);
    });

    it('should create directory if it does not exist', async () => {
      const dirPath = path.join(rootDir, 'new_dir_for_write');
      const filePath = path.join(dirPath, 'file_in_new_dir.txt');
      const content = 'Content in new directory';

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);
      // Simulate confirmation if your logic requires it before execute, or remove if not needed for this path
      const confirmDetails =
        await invocation.getConfirmationDetails(abortSignal);
      if (
        typeof confirmDetails === 'object' &&
        'onConfirm' in confirmDetails &&
        confirmDetails.onConfirm
      ) {
        await confirmDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }

      await invocation.execute(abortSignal);

      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('should include modification message when proposed content is modified', async () => {
      const filePath = path.join(rootDir, 'new_file_modified.txt');
      const content = 'New file content modified by user';

      const params = {
        file_path: filePath,
        content,
        modified_by_user: true,
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toMatch(/User modified the `content`/);
    });

    it('should not include modification message when proposed content is not modified', async () => {
      const filePath = path.join(rootDir, 'new_file_unmodified.txt');
      const content = 'New file content not modified';

      const params = {
        file_path: filePath,
        content,
        modified_by_user: false,
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).not.toMatch(/User modified the `content`/);
    });

    it('should not include modification message when modified_by_user is not provided', async () => {
      const filePath = path.join(rootDir, 'new_file_unmodified.txt');
      const content = 'New file content not modified';

      const params = {
        file_path: filePath,
        content,
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).not.toMatch(/User modified the `content`/);
    });

    it.skipIf(process.platform === 'win32')(
      'should write to a file with spaces in its name when given an escaped path',
      async () => {
        // On Windows, unescapePath is a no-op and backslashes are path
        // separators, so shell-escaping behavior doesn't apply.
        const realPath = path.join(rootDir, 'my spaced write.txt');
        const escapedPath = path.join(rootDir, 'my\\ spaced\\ write.txt');
        const content = 'Written via escaped path.';

        const params = { file_path: escapedPath, content };
        const invocation = tool.build(params);

        const confirmDetails =
          await invocation.getConfirmationDetails(abortSignal);
        if (
          typeof confirmDetails === 'object' &&
          'onConfirm' in confirmDetails &&
          confirmDetails.onConfirm
        ) {
          await confirmDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
        }

        const result = await invocation.execute(abortSignal);

        // Should succeed — file created at the unescaped (real) path
        expect(result.llmContent).toMatch(/Successfully created and wrote/);
        expect(fs.existsSync(realPath)).toBe(true);
        expect(fs.readFileSync(realPath, 'utf8')).toBe(content);
      },
    );
  });

  describe('workspace boundary validation', () => {
    it('should validate paths are within workspace root', () => {
      const params = {
        file_path: path.join(rootDir, 'file.txt'),
        content: 'test content',
      };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should allow paths outside workspace root (external path support)', () => {
      const params = {
        file_path: '/etc/passwd',
        content: 'test',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });
  });

  describe('specific error types for write failures', () => {
    const abortSignal = new AbortController().signal;

    it('should return PERMISSION_DENIED error when write fails with EACCES', async () => {
      const filePath = path.join(rootDir, 'permission_denied_file.txt');
      const content = 'test content';

      // Mock FileSystemService writeTextFile to throw EACCES error
      vi.spyOn(fsService, 'writeTextFile').mockImplementationOnce(() => {
        const error = new Error('Permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        return Promise.reject(error);
      });

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.PERMISSION_DENIED);
      expect(result.llmContent).toContain(
        `Permission denied writing to file: ${filePath} (EACCES)`,
      );
      expect(result.returnDisplay).toContain(
        `Permission denied writing to file: ${filePath} (EACCES)`,
      );
    });

    it('should return NO_SPACE_LEFT error when write fails with ENOSPC', async () => {
      const filePath = path.join(rootDir, 'no_space_file.txt');
      const content = 'test content';

      // Mock FileSystemService writeTextFile to throw ENOSPC error
      vi.spyOn(fsService, 'writeTextFile').mockImplementationOnce(() => {
        const error = new Error(
          'No space left on device',
        ) as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        return Promise.reject(error);
      });

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.NO_SPACE_LEFT);
      expect(result.llmContent).toContain(
        `No space left on device: ${filePath} (ENOSPC)`,
      );
      expect(result.returnDisplay).toContain(
        `No space left on device: ${filePath} (ENOSPC)`,
      );
    });

    it('should return TARGET_IS_DIRECTORY error when write fails with EISDIR', async () => {
      const dirPath = path.join(rootDir, 'test_directory');
      const content = 'test content';

      // Mock fs.existsSync to return false to bypass validation
      const originalExistsSync = fs.existsSync;
      vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
        if (path === dirPath) {
          return false; // Pretend directory doesn't exist to bypass validation
        }
        return originalExistsSync(path as string);
      });

      // Mock FileSystemService writeTextFile to throw EISDIR error
      vi.spyOn(fsService, 'writeTextFile').mockImplementationOnce(() => {
        const error = new Error('Is a directory') as NodeJS.ErrnoException;
        error.code = 'EISDIR';
        return Promise.reject(error);
      });

      const params = { file_path: dirPath, content };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.TARGET_IS_DIRECTORY);
      expect(result.llmContent).toContain(
        `Target is a directory, not a file: ${dirPath} (EISDIR)`,
      );
      expect(result.returnDisplay).toContain(
        `Target is a directory, not a file: ${dirPath} (EISDIR)`,
      );

      vi.spyOn(fs, 'existsSync').mockImplementation(originalExistsSync);
    });

    it('should return FILE_WRITE_FAILURE for generic write errors', async () => {
      const filePath = path.join(rootDir, 'generic_error_file.txt');
      const content = 'test content';

      // Ensure fs.existsSync is not mocked for this test
      vi.restoreAllMocks();

      // Mock FileSystemService writeTextFile to throw generic error
      vi.spyOn(fsService, 'writeTextFile').mockImplementationOnce(() =>
        Promise.reject(new Error('Generic write error')),
      );

      const params = { file_path: filePath, content };
      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.FILE_WRITE_FAILURE);
      expect(result.llmContent).toContain(
        'Error writing to file: Generic write error',
      );
      expect(result.returnDisplay).toContain(
        'Error writing to file: Generic write error',
      );
    });
  });

  describe('BOM preservation (Issue #1672)', () => {
    const abortSignal = new AbortController().signal;

    it('should preserve BOM when overwriting existing file with BOM', async () => {
      const filePath = path.join(rootDir, 'bom_file.txt');
      const originalContent = 'original content';
      const newContent = 'new content';

      // Create file with BOM
      fs.writeFileSync(
        filePath,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(originalContent, 'utf-8'),
        ]),
      );
      seedPriorRead(filePath);

      // Spy on writeTextFile to verify BOM option
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const params = { file_path: filePath, content: newContent };
      const invocation = tool.build(params);
      await invocation.execute(abortSignal);

      // Verify writeTextFile was called with bom: true
      expect(writeSpy).toHaveBeenCalledWith({
        path: filePath,
        content: newContent,
        _meta: { bom: true, encoding: 'utf-8', lineEnding: 'lf' },
      });

      // Cleanup
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    it('should not add BOM when overwriting existing file without BOM', async () => {
      const filePath = path.join(rootDir, 'no_bom_file.txt');
      const originalContent = 'original content';
      const newContent = 'new content';

      // Create file without BOM
      fs.writeFileSync(filePath, originalContent, 'utf-8');
      seedPriorRead(filePath);

      // Spy on writeTextFile to verify BOM option
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const params = { file_path: filePath, content: newContent };
      const invocation = tool.build(params);
      await invocation.execute(abortSignal);

      // Verify writeTextFile was called with bom: false
      expect(writeSpy).toHaveBeenCalledWith({
        path: filePath,
        content: newContent,
        _meta: { bom: false, encoding: 'utf-8', lineEnding: 'lf' },
      });

      // Cleanup
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    it('should use default encoding for new files', async () => {
      const filePath = path.join(rootDir, 'new_file.txt');
      const newContent = 'new content';

      // Ensure file does not exist
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // Spy on writeTextFile to verify BOM option
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const params = { file_path: filePath, content: newContent };
      const invocation = tool.build(params);
      await invocation.execute(abortSignal);

      // Verify writeTextFile was called with bom: false (default is utf-8)
      expect(writeSpy).toHaveBeenCalledWith({
        path: filePath,
        content: newContent,
        _meta: { bom: false, encoding: undefined },
      });

      // Cleanup
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    it('should use BOM for new files when defaultFileEncoding is utf-8-bom', async () => {
      const filePath = path.join(rootDir, 'new_file_bom.txt');
      const newContent = 'new content';

      // Ensure file does not exist
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // Mock config to return utf-8-bom
      const originalGetDefaultFileEncoding =
        mockConfigInternal.getDefaultFileEncoding;
      mockConfigInternal.getDefaultFileEncoding = () => 'utf-8-bom';

      // Spy on writeTextFile to verify BOM option
      const writeSpy = vi.spyOn(fsService, 'writeTextFile');

      const params = { file_path: filePath, content: newContent };
      const invocation = tool.build(params);
      await invocation.execute(abortSignal);

      // Verify writeTextFile was called with bom: true
      expect(writeSpy).toHaveBeenCalledWith({
        path: filePath,
        content: newContent,
        _meta: { bom: true, encoding: undefined },
      });

      // Restore mock
      mockConfigInternal.getDefaultFileEncoding =
        originalGetDefaultFileEncoding;

      // Cleanup
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    it('records a write into the FileReadCache', async () => {
      // Symmetric with EditTool's "records a write" test: ensures
      // ReadFile's post-write guard observes lastWriteAt and skips
      // the file_unchanged placeholder for files this PR's tools just
      // mutated.
      fileReadCache.clear();
      const filePath = path.join(rootDir, 'cache-marker.txt');
      const params = { file_path: filePath, content: 'fresh bytes' };

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.error).toBeUndefined();

      const stats = fs.statSync(filePath);
      const status = fileReadCache.check(stats);
      expect(status.state).toBe('fresh');
      if (status.state === 'fresh') {
        expect(status.entry.lastWriteAt).toBeDefined();
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  });

  describe('prior-read enforcement', () => {
    const abortSignal = new AbortController().signal;

    it('rejects a write that would overwrite an unread existing file', async () => {
      const filePath = path.join(rootDir, 'enforce-overwrite.txt');
      fs.writeFileSync(filePath, 'untouched bytes', 'utf-8');
      // No seedPriorRead — model has not Read this file in the session.

      // Spy on readTextFile to assert enforcement runs *before* any
      // I/O against the file's contents — see the L4 review comment.
      const readSpy = vi.spyOn(fsService, 'readTextFile');

      const params = { file_path: filePath, content: 'clobber attempt' };
      const result = await tool.build(params).execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(result.error?.message).toMatch(
        /has not been fully read in this session/,
      );
      // File must remain at its pre-call content, and the tool must
      // not have slurped the existing bytes into memory before
      // rejecting.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('untouched bytes');
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
      fs.unlinkSync(filePath);
    });

    it('rejects a write when the previous read was ranged (offset/limit)', async () => {
      const filePath = path.join(rootDir, 'enforce-ranged.txt');
      fs.writeFileSync(filePath, 'unchanged', 'utf-8');
      const stats = fs.statSync(filePath);
      fileReadCache.recordRead(filePath, stats, {
        full: false,
        cacheable: true,
      });

      const result = await tool
        .build({ file_path: filePath, content: 'clobber' })
        .execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('unchanged');

      fs.unlinkSync(filePath);
    });

    it('rejects a write when the previous read was non-cacheable', async () => {
      const filePath = path.join(rootDir, 'enforce-noncacheable.txt');
      fs.writeFileSync(filePath, 'pretend binary', 'utf-8');
      const stats = fs.statSync(filePath);
      fileReadCache.recordRead(filePath, stats, {
        full: true,
        cacheable: false,
      });

      const result = await tool
        .build({ file_path: filePath, content: 'clobber' })
        .execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.EDIT_REQUIRES_PRIOR_READ);
      // Verb in the dead-end guidance must read correctly for
      // overwrite (the WriteFile path), not "edit".
      expect(result.error?.message).toMatch(/if you need to overwrite it\./);

      fs.unlinkSync(filePath);
    });

    it('confirmation falls back to a new-file diff when the file disappears mid-flight', async () => {
      // isFilefileExists() saw the file. Between that and the
      // readTextFile inside getConfirmationDetails, an external
      // process deletes it. Pre-fix, readTextFile threw ENOENT and
      // the confirmation collapsed into UNHANDLED_EXCEPTION; the new
      // catch falls back to fileExists=false so the user sees the
      // brand-new-file diff instead.
      const filePath = path.join(rootDir, 'enforce-disappear.txt');
      fs.writeFileSync(filePath, 'will disappear', 'utf-8');
      seedPriorRead(filePath);
      const readSpy = vi
        .spyOn(fsService, 'readTextFile')
        .mockRejectedValueOnce(
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );

      const invocation = tool.build({
        file_path: filePath,
        content: 'new content',
      });
      const confirmation = await invocation.getConfirmationDetails(abortSignal);
      // Should produce a confirmation diff (not throw), with the
      // new content as the proposed value.
      expect(confirmation).toEqual(
        expect.objectContaining({
          type: 'edit',
          newContent: 'new content',
        }),
      );

      readSpy.mockRestore();
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    it('rejects confirmation requests on an unread existing file before showing a diff', async () => {
      const filePath = path.join(rootDir, 'enforce-confirm.txt');
      fs.writeFileSync(filePath, 'unread current bytes', 'utf-8');
      const invocation = tool.build({
        file_path: filePath,
        content: 'replacement content',
      });
      await expect(
        invocation.getConfirmationDetails(abortSignal),
      ).rejects.toThrow(/has not been fully read in this session/);

      fs.unlinkSync(filePath);
    });

    it('attaches a structured ToolErrorType when getConfirmationDetails rejects', async () => {
      // The thrown error must carry `errorType` so the scheduler
      // surfaces EDIT_REQUIRES_PRIOR_READ instead of
      // UNHANDLED_EXCEPTION on approval-required flows.
      const filePath = path.join(rootDir, 'enforce-confirm-type.txt');
      fs.writeFileSync(filePath, 'unread current bytes', 'utf-8');
      const invocation = tool.build({
        file_path: filePath,
        content: 'replacement content',
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
      fs.unlinkSync(filePath);
    });

    it('rejects a write with a stat failure other than ENOENT (fail-closed)', async () => {
      // checkPriorRead must NOT default to ok:true when stat fails
      // for reasons other than disappearance race (EACCES, EBUSY,
      // NFS hiccup, ...). Doing so reopens the blind-write path on
      // transient metadata errors.
      const filePath = path.join(rootDir, 'enforce-stat-fail.txt');
      fs.writeFileSync(filePath, 'untouched', 'utf-8');
      const statSpy = vi
        .spyOn(fs.promises, 'stat')
        .mockRejectedValueOnce(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );

      const result = await tool
        .build({ file_path: filePath, content: 'clobber' })
        .execute(abortSignal);
      // Distinct error code: the model may have legitimately read the
      // file — we just cannot verify because stat itself failed.
      // EDIT_REQUIRES_PRIOR_READ would imply "definitely not read".
      expect(result.error?.type).toBe(
        ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      );
      expect(result.error?.message).toMatch(/Could not stat .*\(EACCES\)/);
      // File untouched.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('untouched');

      statSpy.mockRestore();
      fs.unlinkSync(filePath);
    });

    it('rejects a write when the file has been modified since the last read', async () => {
      const filePath = path.join(rootDir, 'enforce-stale.txt');
      fs.writeFileSync(filePath, 'one', 'utf-8');
      seedPriorRead(filePath);
      fs.writeFileSync(filePath, 'two with more bytes', 'utf-8');
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(filePath, future, future);

      const params = {
        file_path: filePath,
        content: 'clobber the stale file',
      };
      const result = await tool.build(params).execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(result.error?.message).toMatch(/has been modified since/);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('two with more bytes');

      fs.unlinkSync(filePath);
    });

    it('exempts new-file creation from prior-read enforcement', async () => {
      const filePath = path.join(rootDir, 'enforce-new.txt');
      // File does not exist; model has nothing to read first.
      const params = { file_path: filePath, content: 'fresh content' };
      const result = await tool.build(params).execute(abortSignal);

      expect(result.error).toBeUndefined();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('fresh content');

      fs.unlinkSync(filePath);
    });

    it('bypasses enforcement entirely when fileReadCacheDisabled is true', async () => {
      const filePath = path.join(rootDir, 'enforce-bypass.txt');
      fs.writeFileSync(filePath, 'untouched', 'utf-8');
      const original = mockConfigInternal.getFileReadCacheDisabled;
      mockConfigInternal.getFileReadCacheDisabled = () => true;

      try {
        const params = { file_path: filePath, content: 'clobbered' };
        const result = await tool.build(params).execute(abortSignal);
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('clobbered');
      } finally {
        mockConfigInternal.getFileReadCacheDisabled = original;
        fs.unlinkSync(filePath);
      }
    });
  });
});
