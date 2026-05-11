/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReadFileToolParams } from './read-file.js';
import { ReadFileTool } from './read-file.js';
import { ToolErrorType } from './tool-error.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import type { ToolInvocation, ToolResult } from './tools.js';

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

describe('ReadFileTool', () => {
  let tempRootDir: string;
  let tool: ReadFileTool;
  let fileReadCache: FileReadCache;
  const abortSignal = new AbortController().signal;

  beforeEach(async () => {
    // Create a unique temporary root directory for each test run
    tempRootDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'read-file-tool-root-'),
    );
    fileReadCache = new FileReadCache();

    const mockConfigInstance = {
      getFileService: () => new FileDiscoveryService(tempRootDir),
      getFileSystemService: () => new StandardFileSystemService(),
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
      storage: {
        getProjectTempDir: () => path.join(tempRootDir, '.temp'),
        getProjectDir: () => path.join(tempRootDir, '.project'),
        getUserSkillsDirs: () => [path.join(os.homedir(), '.qwen', 'skills')],
      },
      getTruncateToolOutputThreshold: () => 2500,
      getTruncateToolOutputLines: () => 500,
      getContentGeneratorConfig: () => ({
        modalities: { image: true, pdf: true, audio: true, video: true },
      }),
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: () => false,
    } as unknown as Config;
    tool = new ReadFileTool(mockConfigInstance);
  });

  afterEach(async () => {
    // Clean up the temporary root directory
    if (fs.existsSync(tempRootDir)) {
      await fsp.rm(tempRootDir, { recursive: true, force: true });
    }
  });

  describe('build', () => {
    it('should return an invocation for valid params (absolute path within root)', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.txt'),
      };
      const result = tool.build(params);
      expect(typeof result).not.toBe('string');
    });

    it('should throw error if file path is relative', () => {
      const params: ReadFileToolParams = {
        file_path: 'relative/path.txt',
      };
      expect(() => tool.build(params)).toThrow(
        'File path must be absolute, but was relative: relative/path.txt. You must provide an absolute path.',
      );
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        const escapedPath = path.join(tempRootDir, 'my\\ file.txt');
        const params: ReadFileToolParams = {
          file_path: escapedPath,
        };
        const invocation = tool.build(params);
        expect(invocation).toBeDefined();
        expect(invocation.params.file_path).toBe(
          path.join(tempRootDir, 'my file.txt'),
        );
      },
    );

    it('should allow path outside root (external path support)', () => {
      const params: ReadFileToolParams = {
        file_path: '/outside/root.txt',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });

    it('should allow access to files in project temp directory', () => {
      const tempDir = path.join(tempRootDir, '.temp');
      const params: ReadFileToolParams = {
        file_path: path.join(tempDir, 'temp-file.txt'),
      };
      const result = tool.build(params);
      expect(typeof result).not.toBe('string');
    });

    it('should allow access to files in OS temp directory', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(os.tmpdir(), 'pr-review-context.md'),
      };
      const result = tool.build(params);
      expect(typeof result).not.toBe('string');
    });

    it('should allow path completely outside workspace (external path support)', () => {
      const params: ReadFileToolParams = {
        file_path: '/completely/outside/path.txt',
      };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
    });

    it('should throw error if path is empty', () => {
      const params: ReadFileToolParams = {
        file_path: '',
      };
      expect(() => tool.build(params)).toThrow(
        /The 'file_path' parameter must be non-empty./,
      );
    });

    it('should throw error if offset is negative', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.txt'),
        offset: -1,
      };
      expect(() => tool.build(params)).toThrow(
        'Offset must be a non-negative number',
      );
    });

    it('should throw error if limit is zero or negative', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.txt'),
        limit: 0,
      };
      expect(() => tool.build(params)).toThrow(
        'Limit must be a positive number',
      );
    });
  });

  describe('getDefaultPermission', () => {
    it('should return allow for paths within workspace', async () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.txt'),
      };
      const invocation = tool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });

    it('should return ask for paths outside workspace', async () => {
      const params: ReadFileToolParams = {
        file_path: '/outside/workspace/file.txt',
      };
      const invocation = tool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');
    });

    it('should return allow for paths within temp directory', async () => {
      const tempDir = path.join(tempRootDir, '.temp');
      const params: ReadFileToolParams = {
        file_path: path.join(tempDir, 'temp-file.txt'),
      };
      const invocation = tool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });

    it('should return allow for paths within the subagent transcripts dir', async () => {
      const params: ReadFileToolParams = {
        file_path: path.join(
          tempRootDir,
          '.project',
          'subagents',
          'session-1',
          'agent-a.jsonl',
        ),
      };
      const invocation = tool.build(params);
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });
  });

  describe('getDescription', () => {
    it('should return relative path without limit/offset', () => {
      const subDir = path.join(tempRootDir, 'sub', 'dir');
      const params: ReadFileToolParams = {
        file_path: path.join(subDir, 'file.txt'),
      };
      const invocation = tool.build(params);
      expect(typeof invocation).not.toBe('string');
      expect(
        (
          invocation as ToolInvocation<ReadFileToolParams, ToolResult>
        ).getDescription(),
      ).toBe(path.join('sub', 'dir', 'file.txt'));
    });

    it('should handle non-normalized file paths correctly', () => {
      const subDir = path.join(tempRootDir, 'sub', 'dir');
      const params: ReadFileToolParams = {
        file_path: path.join(subDir, '..', 'dir', 'file.txt'),
      };
      const invocation = tool.build(params);
      expect(typeof invocation).not.toBe('string');
      expect(
        (
          invocation as ToolInvocation<ReadFileToolParams, ToolResult>
        ).getDescription(),
      ).toBe(path.join('sub', 'dir', 'file.txt'));
    });

    it('should return . if path is the root directory', () => {
      const params: ReadFileToolParams = { file_path: tempRootDir };
      const invocation = tool.build(params);
      expect(typeof invocation).not.toBe('string');
      expect(
        (
          invocation as ToolInvocation<ReadFileToolParams, ToolResult>
        ).getDescription(),
      ).toBe('.');
    });
  });

  describe('execute', () => {
    it('should return error if file does not exist', async () => {
      const filePath = path.join(tempRootDir, 'nonexistent.txt');
      const params: ReadFileToolParams = { file_path: filePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result).toEqual({
        llmContent:
          'Could not read file because no file was found at the specified path.',
        returnDisplay: 'File not found.',
        error: {
          message: `File not found: ${filePath}`,
          type: ToolErrorType.FILE_NOT_FOUND,
        },
      });
    });

    it('should return success result for a text file', async () => {
      const filePath = path.join(tempRootDir, 'textfile.txt');
      const fileContent = 'This is a test file.';
      await fsp.writeFile(filePath, fileContent, 'utf-8');
      const params: ReadFileToolParams = { file_path: filePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      expect(await invocation.execute(abortSignal)).toEqual({
        llmContent: fileContent,
        returnDisplay: '',
      });
    });

    it.skipIf(process.platform === 'win32')(
      'should read a file with spaces in its name when given an escaped path',
      async () => {
        const realFileName = 'my spaced read.txt';
        const realPath = path.join(tempRootDir, realFileName);
        const fileContent = 'Content with spaces in filename.';
        await fsp.writeFile(realPath, fileContent, 'utf-8');

        // Pass an ESCAPED path (as the LLM might from at-completion)
        const escapedPath = path.join(tempRootDir, 'my\\ spaced\\ read.txt');
        const params: ReadFileToolParams = { file_path: escapedPath };
        const invocation = tool.build(params) as ToolInvocation<
          ReadFileToolParams,
          ToolResult
        >;

        expect(await invocation.execute(abortSignal)).toEqual({
          llmContent: fileContent,
          returnDisplay: '',
        });
      },
    );

    it('should return error if path is a directory', async () => {
      const dirPath = path.join(tempRootDir, 'directory');
      await fsp.mkdir(dirPath);
      const params: ReadFileToolParams = { file_path: dirPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result).toEqual({
        llmContent:
          'Could not read file because the provided path is a directory, not a file.',
        returnDisplay: 'Path is a directory.',
        error: {
          message: `Path is a directory, not a file: ${dirPath}`,
          type: ToolErrorType.TARGET_IS_DIRECTORY,
        },
      });
    });

    it('should return error for a file that is too large', async () => {
      const filePath = path.join(tempRootDir, 'largefile.txt');
      // 11MB of content exceeds 10MB limit
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      await fsp.writeFile(filePath, largeContent, 'utf-8');
      const params: ReadFileToolParams = { file_path: filePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result).toHaveProperty('error');
      expect(result.error?.type).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.error?.message).toContain(
        'File size exceeds the 10MB limit',
      );
    });

    it('should handle text file with lines exceeding maximum length', async () => {
      const filePath = path.join(tempRootDir, 'longlines.txt');
      const longLine = 'a'.repeat(2500); // Exceeds MAX_LINE_LENGTH_TEXT_FILE (2000)
      const fileContent = `Short line\n${longLine}\nAnother short line`;
      await fsp.writeFile(filePath, fileContent, 'utf-8');
      const params: ReadFileToolParams = { file_path: filePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.returnDisplay).toContain(
        'Read lines 1-2 of 3 from longlines.txt (truncated)',
      );
    });

    it('should handle image file and return appropriate content', async () => {
      const imagePath = path.join(tempRootDir, 'image.png');
      // Minimal PNG header
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      await fsp.writeFile(imagePath, pngHeader);
      const params: ReadFileToolParams = { file_path: imagePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toEqual({
        inlineData: {
          data: pngHeader.toString('base64'),
          mimeType: 'image/png',
          displayName: 'image.png',
        },
      });
      expect(result.returnDisplay).toBe('Read image file: image.png');
    });

    it('should handle PDF file and return appropriate content', async () => {
      const pdfPath = path.join(tempRootDir, 'document.pdf');
      // Minimal PDF header
      const pdfHeader = Buffer.from('%PDF-1.4');
      await fsp.writeFile(pdfPath, pdfHeader);
      const params: ReadFileToolParams = { file_path: pdfPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toEqual({
        inlineData: {
          data: pdfHeader.toString('base64'),
          mimeType: 'application/pdf',
          displayName: 'document.pdf',
        },
      });
      expect(result.returnDisplay).toBe('Read pdf file: document.pdf');
    });

    it('should handle binary file and skip content', async () => {
      const binPath = path.join(tempRootDir, 'binary.bin');
      // Binary data with null bytes
      const binaryData = Buffer.from([0x00, 0xff, 0x00, 0xff]);
      await fsp.writeFile(binPath, binaryData);
      const params: ReadFileToolParams = { file_path: binPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toBe(
        'Cannot display content of binary file: binary.bin',
      );
      expect(result.returnDisplay).toBe('Skipped binary file: binary.bin');
    });

    it('should handle SVG file as text', async () => {
      const svgPath = path.join(tempRootDir, 'image.svg');
      const svgContent = '<svg><circle cx="50" cy="50" r="40"/></svg>';
      await fsp.writeFile(svgPath, svgContent, 'utf-8');
      const params: ReadFileToolParams = { file_path: svgPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toBe(svgContent);
      expect(result.returnDisplay).toBe('Read SVG as text: image.svg');
    });

    it('should handle large SVG file', async () => {
      const svgPath = path.join(tempRootDir, 'large.svg');
      // Create SVG content larger than 1MB
      const largeContent = '<svg>' + 'x'.repeat(1024 * 1024 + 1) + '</svg>';
      await fsp.writeFile(svgPath, largeContent, 'utf-8');
      const params: ReadFileToolParams = { file_path: svgPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toBe(
        'Cannot display content of SVG file larger than 1MB: large.svg',
      );
      expect(result.returnDisplay).toBe(
        'Skipped large SVG file (>1MB): large.svg',
      );
    });

    it('should handle empty file', async () => {
      const emptyPath = path.join(tempRootDir, 'empty.txt');
      await fsp.writeFile(emptyPath, '', 'utf-8');
      const params: ReadFileToolParams = { file_path: emptyPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toBe('');
      expect(result.returnDisplay).toBe('');
    });

    it('should handle Jupyter notebook file', async () => {
      const nbPath = path.join(tempRootDir, 'test.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            source: ['print("hello")'],
            execution_count: 1,
            outputs: [{ output_type: 'stream', text: ['hello\n'] }],
            metadata: {},
          },
        ],
        metadata: { language_info: { name: 'python' } },
      };
      await fsp.writeFile(nbPath, JSON.stringify(notebook), 'utf-8');
      const params: ReadFileToolParams = { file_path: nbPath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('Jupyter Notebook');
      expect(result.llmContent).toContain('print("hello")');
      expect(result.llmContent).toContain('hello');
      expect(result.returnDisplay).toBe('Read notebook: test.ipynb');
    });

    it('should reject invalid pages parameter', () => {
      const params: ReadFileToolParams = {
        file_path: '/tmp/test.pdf',
        pages: 'abc',
      };
      expect(() => tool.build(params)).toThrow('Invalid pages parameter');
    });

    it('should reject pages range exceeding 20', () => {
      const params: ReadFileToolParams = {
        file_path: '/tmp/test.pdf',
        pages: '1-25',
      };
      expect(() => tool.build(params)).toThrow(
        'Pages range exceeds maximum of 20',
      );
    });

    it('should reject open-ended pages range', () => {
      const params: ReadFileToolParams = {
        file_path: '/tmp/test.pdf',
        pages: '3-',
      };
      expect(() => tool.build(params)).toThrow('Open-ended page ranges');
    });

    it('should accept valid pages parameter', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.pdf'),
        pages: '1-5',
      };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should treat empty pages parameter as unset', () => {
      const params: ReadFileToolParams = {
        file_path: path.join(tempRootDir, 'test.txt'),
        pages: '',
      };
      expect(() => tool.build(params)).not.toThrow();
    });

    it('should support offset and limit for text files', async () => {
      const filePath = path.join(tempRootDir, 'paginated.txt');
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      const fileContent = lines.join('\n');
      await fsp.writeFile(filePath, fileContent, 'utf-8');

      const params: ReadFileToolParams = {
        file_path: filePath,
        offset: 5, // Start from line 6
        limit: 3,
      };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain(
        'Showing lines 6-8 of 20 total lines',
      );
      expect(result.llmContent).toContain('Line 6');
      expect(result.llmContent).toContain('Line 7');
      expect(result.llmContent).toContain('Line 8');
      expect(result.returnDisplay).toBe(
        'Read lines 6-8 of 20 from paginated.txt',
      );
    });

    it('should successfully read files from project temp directory', async () => {
      const tempDir = path.join(tempRootDir, '.temp');
      await fsp.mkdir(tempDir, { recursive: true });
      const tempFilePath = path.join(tempDir, 'temp-output.txt');
      const tempFileContent = 'This is temporary output content';
      await fsp.writeFile(tempFilePath, tempFileContent, 'utf-8');

      const params: ReadFileToolParams = { file_path: tempFilePath };
      const invocation = tool.build(params) as ToolInvocation<
        ReadFileToolParams,
        ToolResult
      >;

      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toBe(tempFileContent);
      expect(result.returnDisplay).toBe('');
    });

    it('should successfully read files from OS temp directory', async () => {
      const osTempFile = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'read-file-test-'),
      );
      const tempFilePath = path.join(osTempFile, 'pr-review-context.md');
      const tempFileContent = '## PR #123\nFix encoding issues';
      await fsp.writeFile(tempFilePath, tempFileContent, 'utf-8');

      try {
        const params: ReadFileToolParams = { file_path: tempFilePath };
        const invocation = tool.build(params) as ToolInvocation<
          ReadFileToolParams,
          ToolResult
        >;

        const result = await invocation.execute(abortSignal);
        expect(result.llmContent).toBe(tempFileContent);
      } finally {
        await fsp.rm(osTempFile, { recursive: true, force: true });
      }
    });

    describe('with FileReadCache', () => {
      // Helper to build + execute a Read in one shot.
      async function read(
        params: ReadFileToolParams,
        toolOverride: ReadFileTool = tool,
      ): Promise<ToolResult> {
        const invocation = toolOverride.build(params) as ToolInvocation<
          ReadFileToolParams,
          ToolResult
        >;
        return invocation.execute(abortSignal);
      }

      it('returns the file_unchanged placeholder on a second full Read of an unchanged text file', async () => {
        const filePath = path.join(tempRootDir, 'note.txt');
        await fsp.writeFile(filePath, 'hello world', 'utf-8');

        const first = await read({ file_path: filePath });
        expect(first.llmContent).toBe('hello world');

        const second = await read({ file_path: filePath });
        expect(typeof second.llmContent).toBe('string');
        expect(second.llmContent).toMatch(
          /unchanged since last read in this session/,
        );
        // Placeholder must not echo the original content.
        expect(second.llmContent).not.toContain('hello world');
        expect(second.returnDisplay).toMatch(/^Unchanged: /);
      });

      it('serves a fresh full Read after an external modification (stale)', async () => {
        const filePath = path.join(tempRootDir, 'mut.txt');
        await fsp.writeFile(filePath, 'one', 'utf-8');
        await read({ file_path: filePath });

        // Bump mtime well into the future to defeat low-precision filesystems
        // that share the second across rapid writes.
        await fsp.writeFile(filePath, 'two', 'utf-8');
        const future = new Date(Date.now() + 60_000);
        await fsp.utimes(filePath, future, future);

        const after = await read({ file_path: filePath });
        expect(after.llmContent).toBe('two');
      });

      it('forces a full Read after recordWrite even if mtime/size still match', async () => {
        // Models that mix Read with Edit / Write should see the post-write
        // bytes on their next Read, not a placeholder pointing at the
        // pre-write content. The lastReadAt < lastWriteAt branch enforces
        // this even when the file's stats happen to match (which can
        // happen when an Edit is a no-op or filesystems coalesce mtime).
        const filePath = path.join(tempRootDir, 'edited.txt');
        await fsp.writeFile(filePath, 'before', 'utf-8');
        await read({ file_path: filePath });

        const stats = fs.statSync(filePath);
        fileReadCache.recordWrite(filePath, stats);

        const after = await read({ file_path: filePath });
        expect(after.llmContent).toBe('before');
        expect(after.llmContent).not.toMatch(/unchanged since/);
      });

      it('never short-circuits a ranged Read (offset/limit set)', async () => {
        const filePath = path.join(tempRootDir, 'multi.txt');
        await fsp.writeFile(filePath, 'a\nb\nc\nd\ne', 'utf-8');
        await read({ file_path: filePath });

        const ranged = await read({
          file_path: filePath,
          offset: 1,
          limit: 2,
        });
        expect(typeof ranged.llmContent).toBe('string');
        expect(ranged.llmContent).not.toMatch(/unchanged since/);
        expect(ranged.llmContent).toContain('b');
      });

      it('does not arm the placeholder if the first Read was truncated', async () => {
        // Truncation means the model has not seen the full file even
        // though no offset/limit was passed. A follow-up no-args Read
        // must therefore re-emit the truncated window rather than
        // claiming "you've already seen this file".
        const filePath = path.join(tempRootDir, 'long.txt');
        // Write more lines than the mock Config's truncate-lines limit
        // (500) so the read pipeline reports isTruncated = true.
        const bigContent = Array.from(
          { length: 700 },
          (_, i) => `line ${i + 1}`,
        ).join('\n');
        await fsp.writeFile(filePath, bigContent, 'utf-8');

        const first = await read({ file_path: filePath });
        expect(typeof first.llmContent).toBe('string');
        // Truncation kicks in (either by line or character cap depending
        // on Config); we only need the read to actually be truncated,
        // not match a specific line count.
        expect(first.returnDisplay).toMatch(/Read lines .* of 700/);

        const second = await read({ file_path: filePath });
        expect(typeof second.llmContent).toBe('string');
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(second.returnDisplay).toMatch(/Read lines .* of 700/);
      });

      it('does not arm the placeholder if the first Read was ranged', async () => {
        // First Read covers only a slice — lastReadWasFull = false. A
        // follow-up no-args Read must therefore go through the full
        // pipeline, since the cache cannot prove the model has already
        // seen the entire file.
        const filePath = path.join(tempRootDir, 'big.txt');
        await fsp.writeFile(filePath, 'a\nb\nc\nd\ne', 'utf-8');

        await read({ file_path: filePath, offset: 0, limit: 2 });
        const followUp = await read({ file_path: filePath });
        expect(typeof followUp.llmContent).toBe('string');
        expect(followUp.llmContent).not.toMatch(/unchanged since/);
        expect(followUp.llmContent).toContain('e');
      });

      it('does not return the placeholder for binary files', async () => {
        const binPath = path.join(tempRootDir, 'blob.bin');
        await fsp.writeFile(binPath, Buffer.from([0x00, 0xff, 0x00, 0xff]));
        const first = await read({ file_path: binPath });
        expect(typeof first.llmContent).toBe('string');
        expect(first.llmContent).toMatch(/Cannot display content of binary/);

        const second = await read({ file_path: binPath });
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(second.llmContent).toMatch(/Cannot display content of binary/);
      });

      it('records an auto-memory read in the cache so a follow-up Edit can pass enforcement', async () => {
        // Auto-memory files skip the file_unchanged fast-path (they
        // own a per-read freshness `<system-reminder>` that must be
        // re-emitted) but they MUST still be recorded in the cache
        // — otherwise the prior-read enforcement on Edit / WriteFile
        // would refuse to mutate a file the model legitimately just
        // read. Put a file under .qwen/<auto-memory>/ via
        // QWEN_CODE_MEMORY_LOCAL=1 and assert recordRead happened.
        const previousLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
        process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
        try {
          const { getAutoMemoryRoot, clearAutoMemoryRootCache } = await import(
            '../memory/paths.js'
          );
          clearAutoMemoryRootCache();
          const memRoot = getAutoMemoryRoot(tempRootDir);
          await fsp.mkdir(memRoot, { recursive: true });
          const memFile = path.join(memRoot, 'AGENTS.md');
          await fsp.writeFile(memFile, '# memory', 'utf-8');

          const result = await read({ file_path: memFile });
          // Slow path returned the actual content (not a placeholder).
          expect(typeof result.llmContent).toBe('string');
          expect(result.llmContent).not.toMatch(/unchanged since/);
          // The cache must contain the auto-memory file's entry, AND
          // the entry must be in a shape that satisfies prior-read
          // enforcement on Edit / WriteFile (fresh + lastReadAt set +
          // full + cacheable). Asserting only `fresh` would let a
          // future regression that records auto-memory reads as
          // partial/non-cacheable slip through silently — those reads
          // would still report fresh but enforcement would reject
          // every follow-up Edit.
          const status = fileReadCache.check(fs.statSync(memFile));
          expect(status.state).toBe('fresh');
          if (status.state === 'fresh') {
            expect(status.entry.lastReadAt).toBeDefined();
            expect(status.entry.lastReadWasFull).toBe(true);
            expect(status.entry.lastReadCacheable).toBe(true);
          }
        } finally {
          if (previousLocal === undefined) {
            delete process.env['QWEN_CODE_MEMORY_LOCAL'];
          } else {
            process.env['QWEN_CODE_MEMORY_LOCAL'] = previousLocal;
          }
        }
      });

      it('records SVG-as-text reads with cacheable=true so a follow-up Edit passes enforcement', async () => {
        // Pre-fix the SVG branch in fileUtils.ts returned content
        // without `originalLineCount`, which collapsed
        // ReadFileToolInvocation's `cacheable` derivation to
        // false. EditTool's prior-read enforcement then mistook
        // the just-read SVG for a "non-text payload" and rejected
        // a subsequent in-place edit.
        const svgPath = path.join(tempRootDir, 'icon.svg');
        await fsp.writeFile(
          svgPath,
          '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
          'utf-8',
        );

        const result = await read({ file_path: svgPath });
        expect(typeof result.llmContent).toBe('string');
        expect(result.returnDisplay).toMatch(/^Read SVG as text:/);

        // The cache must record this as a full, cacheable read so
        // that prior-read enforcement on Edit / WriteFile would
        // recognise it as the model having seen the bytes.
        const status = fileReadCache.check(fs.statSync(svgPath));
        expect(status.state).toBe('fresh');
        if (status.state === 'fresh') {
          expect(status.entry.lastReadAt).toBeDefined();
          expect(status.entry.lastReadWasFull).toBe(true);
          expect(status.entry.lastReadCacheable).toBe(true);
        }
      });

      it('records partial text reads with lastReadCacheable=true so a follow-up Edit passes enforcement (issue #3964)', async () => {
        // Pre-fix, ReadFileToolInvocation derived `cacheable` as
        // `string && originalLineCount && !isTruncated`. A partial
        // read of a regular text file (offset/limit) sets
        // `isTruncated = true`, which collapsed `cacheable` to false
        // and recorded the entry as `lastReadCacheable: false`.
        // priorReadEnforcement.ts then mistook this for "binary
        // payload" on the next Edit and rejected the call with the
        // misleading "binary / image / audio / video / PDF /
        // notebook payload" error. Decoupling the truncation check
        // from `cacheable` (truncation now lives on
        // `lastReadWasFull`) means partial text reads correctly
        // record as text-cacheable.
        const filePath = path.join(tempRootDir, 'partial.kt');
        const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
        await fsp.writeFile(filePath, lines.join('\n'), 'utf-8');

        await read({ file_path: filePath, offset: 10, limit: 5 });

        const status = fileReadCache.check(fs.statSync(filePath));
        expect(status.state).toBe('fresh');
        if (status.state === 'fresh') {
          expect(status.entry.lastReadAt).toBeDefined();
          // The truncation check moved to `lastReadWasFull`: a
          // ranged read leaves the model without sight of every
          // byte, so this stays false.
          expect(status.entry.lastReadWasFull).toBe(false);
          // The bytes the model saw were text — Edit must accept
          // this read.
          expect(status.entry.lastReadCacheable).toBe(true);
        }
      });

      it('records truncated full reads with lastReadCacheable=true (issue #3964)', async () => {
        // Symmetric regression for the other arm of issue #3964:
        // `read_file(file_path)` without offset/limit but on a file
        // larger than the truncate-tool-output limit. Pre-fix the
        // truncated content collapsed `cacheable` to false; post-fix
        // it stays true (the bytes were text), and only
        // `lastReadWasFull` is false (the model only saw the head).
        const filePath = path.join(tempRootDir, 'long.cpp');
        // Mock Config caps truncate-tool-output-lines at 500.
        const bigContent = Array.from(
          { length: 700 },
          (_, i) => `line ${i + 1}`,
        ).join('\n');
        await fsp.writeFile(filePath, bigContent, 'utf-8');

        const result = await read({ file_path: filePath });
        expect(result.returnDisplay).toMatch(/Read lines .* of 700/);

        const status = fileReadCache.check(fs.statSync(filePath));
        expect(status.state).toBe('fresh');
        if (status.state === 'fresh') {
          // Truncated → model has not seen every byte.
          expect(status.entry.lastReadWasFull).toBe(false);
          // But the bytes are text, so Edit (which accepts partial
          // reads) must not be rejected as "binary payload".
          expect(status.entry.lastReadCacheable).toBe(true);
        }
      });

      it('reads source-code files with binary-looking content as text (encrypted FS, issue #3964)', async () => {
        // Frank-Shaw-FS reports `.cpp` source files on Windows
        // encrypted / DRM-protected file systems being misclassified
        // as binary. The OS surfaces encrypted bytes to `fs.open()`
        // random-access reads, so the 4 KB `isBinaryFile` heuristic
        // sees nulls / non-printables and concludes binary even
        // though the user-visible content is plain text. The
        // extension-based override in detectFileType skips the
        // content sample for known text extensions; verify that
        // routes through `processSingleFileContent` correctly and
        // records the read as text-cacheable so a follow-up Edit
        // passes prior-read enforcement.
        //
        // We can't easily simulate a real encrypted volume in a
        // unit test, so we approximate by writing nominally text
        // content to a `.cpp` file. The test relies on the
        // extension override winning over any future content-side
        // heuristic — there is no isBinaryFile mocking in scope.
        const filePath = path.join(tempRootDir, 'src.cpp');
        await fsp.writeFile(filePath, '#include <iostream>\nint main() {}\n');

        const result = await read({ file_path: filePath });
        expect(typeof result.llmContent).toBe('string');
        expect(result.llmContent).toContain('#include');

        const status = fileReadCache.check(fs.statSync(filePath));
        expect(status.state).toBe('fresh');
        if (status.state === 'fresh') {
          expect(status.entry.lastReadCacheable).toBe(true);
        }
      });

      it('does not return the placeholder for image files', async () => {
        const imagePath = path.join(tempRootDir, 'pic.png');
        const pngHeader = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        await fsp.writeFile(imagePath, pngHeader);

        const first = await read({ file_path: imagePath });
        // Image returns a Part, not a string.
        expect(typeof first.llmContent).not.toBe('string');

        const second = await read({ file_path: imagePath });
        // Must remain a Part — never collapsed to a string placeholder.
        expect(typeof second.llmContent).not.toBe('string');
      });

      it('completely bypasses the cache when getFileReadCacheDisabled() is true', async () => {
        // Build a fresh ReadFileTool with a Config whose cache is
        // disabled. Two consecutive full Reads must both return the
        // file content — never the placeholder, and the cache itself
        // must remain empty so prior-read enforcement (added in a
        // follow-up) cannot accidentally trip on a recorded entry.
        const isolatedCache = new FileReadCache();
        const disabledConfig = {
          getFileService: () => new FileDiscoveryService(tempRootDir),
          getFileSystemService: () => new StandardFileSystemService(),
          getTargetDir: () => tempRootDir,
          getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
          storage: {
            getProjectTempDir: () => path.join(tempRootDir, '.temp'),
            getProjectDir: () => path.join(tempRootDir, '.project'),
            getUserSkillsDirs: () => [
              path.join(os.homedir(), '.qwen', 'skills'),
            ],
          },
          getTruncateToolOutputThreshold: () => 2500,
          getTruncateToolOutputLines: () => 500,
          getContentGeneratorConfig: () => ({
            modalities: { image: true, pdf: true, audio: true, video: true },
          }),
          getFileReadCache: () => isolatedCache,
          getFileReadCacheDisabled: () => true,
        } as unknown as Config;
        const disabledTool = new ReadFileTool(disabledConfig);

        const filePath = path.join(tempRootDir, 'bypass.txt');
        await fsp.writeFile(filePath, 'plain text', 'utf-8');

        const first = await read({ file_path: filePath }, disabledTool);
        const second = await read({ file_path: filePath }, disabledTool);

        expect(first.llmContent).toBe('plain text');
        expect(second.llmContent).toBe('plain text');
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(isolatedCache.size()).toBe(0);
      });
    });

    describe('with .qwenignore', () => {
      beforeEach(async () => {
        await fsp.writeFile(
          path.join(tempRootDir, '.qwenignore'),
          ['foo.*', 'ignored/'].join('\n'),
        );
      });

      it('should throw error if path is ignored by a .qwenignore pattern', async () => {
        const ignoredFilePath = path.join(tempRootDir, 'foo.bar');
        await fsp.writeFile(ignoredFilePath, 'content', 'utf-8');
        const params: ReadFileToolParams = {
          file_path: ignoredFilePath,
        };
        const expectedError = `File path '${ignoredFilePath}' is ignored by .qwenignore pattern(s).`;
        expect(() => tool.build(params)).toThrow(expectedError);
      });

      it('should throw error if file is in an ignored directory', async () => {
        const ignoredDirPath = path.join(tempRootDir, 'ignored');
        await fsp.mkdir(ignoredDirPath, { recursive: true });
        const ignoredFilePath = path.join(ignoredDirPath, 'file.txt');
        await fsp.writeFile(ignoredFilePath, 'content', 'utf-8');
        const params: ReadFileToolParams = {
          file_path: ignoredFilePath,
        };
        const expectedError = `File path '${ignoredFilePath}' is ignored by .qwenignore pattern(s).`;
        expect(() => tool.build(params)).toThrow(expectedError);
      });

      it('should allow reading non-ignored files', async () => {
        const allowedFilePath = path.join(tempRootDir, 'allowed.txt');
        await fsp.writeFile(allowedFilePath, 'content', 'utf-8');
        const params: ReadFileToolParams = {
          file_path: allowedFilePath,
        };
        const invocation = tool.build(params);
        expect(typeof invocation).not.toBe('string');
      });
    });
  });
});
