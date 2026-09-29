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
import sharp from 'sharp';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { runWithToolCallSource } from '../code-mode/tool-call-runtime.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import type { ToolResult } from './tools.js';
import type { VisionBridgeNoticeDisplay } from '../services/visionBridge/vision-bridge-service.js';

const visionBridgeMocks = vi.hoisted(() => ({
  runVisionBridge: vi.fn(),
  shouldRunVisionBridge: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => ({
  extractPDFText: vi.fn(),
  getPDFPageCount: vi.fn(),
  isPdftotextAvailable: vi.fn(),
  renderPDFPagesToImages: vi.fn(),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

vi.mock(
  '../services/visionBridge/vision-bridge-service.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../services/visionBridge/vision-bridge-service.js')
      >();
    return {
      ...actual,
      runVisionBridge: visionBridgeMocks.runVisionBridge,
      shouldRunVisionBridge: visionBridgeMocks.shouldRunVisionBridge,
    };
  },
);

vi.mock('../utils/pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/pdf.js')>();
  return {
    ...actual,
    extractPDFText: pdfMocks.extractPDFText,
    getPDFPageCount: pdfMocks.getPDFPageCount,
    isPdftotextAvailable: pdfMocks.isPdftotextAvailable,
    renderPDFPagesToImages: pdfMocks.renderPDFPagesToImages,
  };
});

const nullPagination = { offset: null, limit: null, pages: null };
const allModalities = { image: true, pdf: true, audio: true, video: true };

const numberedLines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n');

const codeCell = (source: string, count: number, output: string) => ({
  cell_type: 'code',
  source: [source],
  execution_count: count,
  outputs: [{ output_type: 'stream', text: [output] }],
  metadata: {},
});
const notebookJson = (cells: object[]) =>
  JSON.stringify({ cells, metadata: { language_info: { name: 'python' } } });

describe('ReadFileTool', () => {
  let tempRootDir: string;
  let tool: ReadFileTool;
  let fileReadCache: FileReadCache;
  const abortSignal = new AbortController().signal;

  // Deliberately has no getEffectiveInputModalities, getPlansDir or
  // storage.getWorkflowRunsDir: configs built without them exercise the
  // optional-call fallbacks. The suite's main config adds all three.
  function makeConfig(
    overrides: Record<string, unknown> = {},
    storage: Record<string, unknown> = {},
  ): Config {
    return {
      getFileService: () => new FileDiscoveryService(tempRootDir),
      getFileSystemService: () => new StandardFileSystemService(),
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
      storage: {
        getProjectTempDir: () => path.join(tempRootDir, '.temp'),
        getProjectDir: () => path.join(tempRootDir, '.project'),
        getUserSkillsDirs: () => [path.join(os.homedir(), '.qwen', 'skills')],
        ...storage,
      },
      getTruncateToolOutputThreshold: () => 2500,
      getTruncateToolOutputLines: () => 500,
      getContentGeneratorConfig: () => ({ modalities: { ...allModalities } }),
      getFileReadCache: () => fileReadCache,
      getFileReadCacheDisabled: () => false,
      ...overrides,
    } as unknown as Config;
  }

  const noMediaModalities = {
    getContentGeneratorConfig: () => ({ modalities: {} }),
  };

  // Relative paths resolve against the temp root; absolute ones pass through.
  const inRoot = (file: string) =>
    path.isAbsolute(file) ? file : path.join(tempRootDir, file);

  async function put(file: string, content: string | Buffer): Promise<string> {
    const filePath = inRoot(file);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
    return filePath;
  }

  async function putPng(file: string, width: number, height: number) {
    const filePath = inRoot(file);
    await sharp({
      create: { width, height, channels: 3, background: '#306090' },
    })
      .png()
      .toFile(filePath);
    return filePath;
  }

  // Builds + executes a Read in one shot; a bare string is the file_path.
  async function read(
    params: string | ReadFileToolParams,
    toolOverride: ReadFileTool = tool,
    signal: AbortSignal = abortSignal,
  ): Promise<ToolResult> {
    const p = typeof params === 'string' ? { file_path: params } : params;
    return toolOverride.build(p).execute(signal);
  }

  function cachedEntry(filePath: string) {
    const status = fileReadCache.check(fs.statSync(filePath));
    expect(status.state).toBe('fresh');
    if (status.state !== 'fresh') throw new Error('missing read record');
    return status.entry;
  }

  beforeEach(async () => {
    visionBridgeMocks.runVisionBridge.mockReset();
    visionBridgeMocks.shouldRunVisionBridge.mockReset().mockReturnValue(false);
    pdfMocks.extractPDFText.mockReset().mockResolvedValue({
      success: false,
      error: 'No extractable text layer.',
    });
    pdfMocks.getPDFPageCount.mockReset().mockResolvedValue(31);
    pdfMocks.isPdftotextAvailable.mockReset().mockResolvedValue(true);
    pdfMocks.renderPDFPagesToImages.mockReset().mockResolvedValue({
      success: false,
      error: 'PDF rendering unavailable.',
    });

    tempRootDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'read-file-tool-root-'),
    );
    fileReadCache = new FileReadCache();
    tool = new ReadFileTool(
      makeConfig(
        {
          getPlansDir: () => path.join(os.homedir(), '.qwen', 'plans'),
          getEffectiveInputModalities: () => ({ ...allModalities }),
        },
        {
          getWorkflowRunsDir: () => path.join(tempRootDir, '.workflow-runs'),
        },
      ),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(tempRootDir, { recursive: true, force: true });
  });

  describe('build', () => {
    it('advertises audio and video support to the model', () => {
      expect(tool.description).toContain('audio, video');
      expect(tool.description).toContain(
        'selected model to support the corresponding modality',
      );
    });

    it('recomputes the schema description from live modalities', () => {
      // The declaration the model actually receives comes from `schema`, which
      // is recomputed on read — so it reflects the current model's modalities.
      expect(tool.schema.description).toContain('audio, video');
      expect(tool.schema.description).toContain('watch a video');
    });

    it('omits audio/video for a text-only model (no false clip-read promise)', () => {
      const textOnlyConfig = {
        getEffectiveInputModalities: () => ({ image: true, pdf: true }),
      } as unknown as Config;
      const textTool = new ReadFileTool(textOnlyConfig);
      for (const desc of [textTool.description, textTool.schema.description]) {
        expect(desc).toContain(
          'text, images (PNG, JPG, GIF, WEBP, SVG, BMP), PDF files',
        );
        expect(desc).not.toContain('audio, video');
        expect(desc).not.toContain('watch a video');
        expect(desc).not.toContain('read_file on the resulting clip');
      }
    });

    it.each([
      [
        'should return an invocation for valid params (absolute path within root)',
        'test.txt',
      ],
      [
        'should allow access to files in project temp directory',
        path.join('.temp', 'temp-file.txt'),
      ],
      [
        'should build an invocation for files in the OS temp directory',
        path.join(os.tmpdir(), 'pr-review-context.md'),
      ],
    ])('%s', (_title, file) => {
      const result = tool.build({ file_path: inRoot(file) });
      expect(typeof result).not.toBe('string');
    });

    it.each<[string, Partial<ReadFileToolParams>]>([
      [
        'should allow path outside root (external path support)',
        { file_path: '/outside/root.txt' },
      ],
      [
        'should allow path completely outside workspace (external path support)',
        { file_path: '/completely/outside/path.txt' },
      ],
      ['should allow zero offset', { offset: 0 }],
    ])('%s', (_title, params) => {
      expect(
        tool.build({ file_path: inRoot('test.txt'), ...params }),
      ).toBeDefined();
    });

    it.each<[string, Partial<ReadFileToolParams>, string | RegExp]>([
      [
        'should throw error if file path is relative',
        { file_path: 'relative/path.txt' },
        'File path must be absolute, but was relative: relative/path.txt. You must provide an absolute path.',
      ],
      [
        'should throw error if path is empty',
        { file_path: '' },
        /The 'file_path' parameter must be non-empty./,
      ],
      [
        'should throw error if offset is negative',
        { offset: -1 },
        'Offset must be a non-negative integer',
      ],
      [
        'should throw error if offset is fractional',
        { offset: 1.5 },
        'params/offset must be integer',
      ],
      [
        'should throw error if limit is not positive (0)',
        { limit: 0 },
        'Limit must be a positive integer',
      ],
      [
        'should throw error if limit is not positive (-1)',
        { limit: -1 },
        'Limit must be a positive integer',
      ],
      [
        'should throw error if limit is fractional (0.5)',
        { limit: 0.5 },
        'params/limit must be integer',
      ],
      [
        'should throw error if limit is fractional (1.5)',
        { limit: 1.5 },
        'params/limit must be integer',
      ],
    ])('%s', (_title, params, error) => {
      expect(() =>
        tool.build({ file_path: inRoot('test.txt'), ...params }),
      ).toThrow(error);
    });

    it.skipIf(process.platform === 'win32')(
      'should unescape shell-escaped spaces in file_path',
      () => {
        const invocation = tool.build({ file_path: inRoot('my\\ file.txt') });
        expect(invocation).toBeDefined();
        expect(invocation.params.file_path).toBe(inRoot('my file.txt'));
      },
    );

    it.each([
      { offset: 0 },
      { offset: -1 },
      { limit: 10 },
      { limit: 0 },
      { limit: -1 },
      { offset: 0, limit: 2000, pages: '' },
      { pages: '1' },
      { pages: 'invalid' },
    ])('gives a nullable notebook retry for %j', (pagination) => {
      const filePath = inRoot('test "quoted".IPYNB');
      const error = tool.validateToolParams({
        file_path: filePath,
        ...pagination,
      });

      expect(error).toContain(
        "For Jupyter notebooks (.ipynb), omit 'offset', 'limit', and 'pages' or set them to null.",
      );
      const retry = JSON.parse(error!.split('Retry with: ')[1]);
      expect(retry).toEqual({ file_path: filePath, ...nullPagination });
      expect(() => tool.build(retry)).not.toThrow();
    });

    it.each([
      { offset: null },
      { limit: null },
      { pages: null },
      nullPagination,
    ])('normalizes nullable notebook pagination %j', (pagination) => {
      const invocation = tool.build({
        file_path: inRoot('test.ipynb'),
        ...pagination,
      });
      expect(invocation.params.offset).toBeUndefined();
      expect(invocation.params.limit).toBeUndefined();
      expect(invocation.params.pages).toBeUndefined();
      expect(invocation.getDescription()).toBe('test.ipynb');
      expect(invocation.toolLocations()).toEqual([
        { path: invocation.params.file_path, line: undefined },
      ]);
    });

    it('accepts null pagination when strict mode requires every property', () => {
      const schema = {
        ...(tool.schema.parametersJsonSchema as Record<string, unknown>),
        required: ['file_path', 'offset', 'limit', 'pages'],
        additionalProperties: false,
      };
      const validate = (file_path: string | null) =>
        SchemaValidator.validate(schema, { file_path, ...nullPagination });
      expect(validate(inRoot('test.ipynb'))).toBeNull();
      expect(validate(null)).not.toBeNull();
    });

    it.each(['', '   '])('allows empty notebook pages (%j)', (pages) => {
      expect(() =>
        tool.build({ file_path: inRoot('test.ipynb'), pages }),
      ).not.toThrow();
    });
  });

  describe('getDefaultPermission', () => {
    it.each([
      ['should return allow for paths within workspace', 'test.txt', 'allow'],
      [
        'should return ask for paths outside workspace',
        '/outside/workspace/file.txt',
        'ask',
      ],
      [
        'should return allow for paths within temp directory',
        path.join('.temp', 'temp-file.txt'),
        'allow',
      ],
      [
        'should return allow for paths within the global qwen temp directory',
        path.join(Storage.getGlobalTempDir(), 'temp-file.txt'),
        'allow',
      ],
      [
        'should return allow for paths within the user extensions directory',
        path.join(Storage.getUserExtensionsDir(), 'my-ext', 'index.js'),
        'allow',
      ],
      [
        'should return allow for saved plan files under the plans directory',
        path.join(os.homedir(), '.qwen', 'plans', 'session-1.md'),
        'allow',
      ],
      [
        'should still return ask for ~/.qwen files outside the plans directory',
        path.join(os.homedir(), '.qwen', 'settings.json'),
        'ask',
      ],
      [
        'should return ask for paths directly under the OS temp directory',
        path.join(os.tmpdir(), 'pr-review-context.md'),
        'ask',
      ],
      [
        'should return allow for paths within the subagent transcripts dir',
        path.join('.project', 'subagents', 'session-1', 'agent-a.jsonl'),
        'allow',
      ],
    ])('%s', async (_title, file, expected) => {
      const invocation = tool.build({ file_path: inRoot(file) });
      expect(await invocation.getDefaultPermission()).toBe(expected);
    });
  });

  describe('getDescription', () => {
    it.each([
      [
        'should return relative path without limit/offset',
        path.join('sub', 'dir', 'file.txt'),
        path.join('sub', 'dir', 'file.txt'),
      ],
      [
        'should handle non-normalized file paths correctly',
        path.join('sub', 'dir', '..', 'dir', 'file.txt'),
        path.join('sub', 'dir', 'file.txt'),
      ],
      ['should return . if path is the root directory', '', '.'],
    ])('%s', (_title, file, expected) => {
      const invocation = tool.build({ file_path: inRoot(file) });
      expect(typeof invocation).not.toBe('string');
      expect(invocation.getDescription()).toBe(expected);
    });
  });

  describe('execute', () => {
    it('should return error if file does not exist', async () => {
      const filePath = inRoot('nonexistent.txt');
      expect(await read(filePath)).toEqual({
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
      const fileContent = 'This is a test file.';
      const filePath = await put('textfile.txt', fileContent);
      expect(await read(filePath)).toEqual({
        llmContent: fileContent,
        returnDisplay: '',
      });
    });

    it.skipIf(process.platform === 'win32')(
      'should read a file with spaces in its name when given an escaped path',
      async () => {
        const fileContent = 'Content with spaces in filename.';
        await put('my spaced read.txt', fileContent);

        // Pass an ESCAPED path (as the LLM might from at-completion)
        expect(await read(inRoot('my\\ spaced\\ read.txt'))).toEqual({
          llmContent: fileContent,
          returnDisplay: '',
        });
      },
    );

    it('should return error if path is a directory', async () => {
      const dirPath = inRoot('directory');
      await fsp.mkdir(dirPath);
      expect(await read(dirPath)).toEqual({
        llmContent:
          'Could not read file because the provided path is a directory, not a file.',
        returnDisplay: 'Path is a directory.',
        error: {
          message: `Path is a directory, not a file: ${dirPath}`,
          type: ToolErrorType.TARGET_IS_DIRECTORY,
        },
      });
    });

    it('should read and truncate a text file larger than 10MB', async () => {
      const filePath = await put('largefile.txt', 'x'.repeat(11 * 1024 * 1024));
      const result = await read(filePath);
      expect(result.error).toBeUndefined();
      expect(result.returnDisplay).toBe(
        'Read lines 1-1 of at least 1 from largefile.txt (truncated)',
      );
      expect(result.llmContent).toContain(
        'Showing lines 1-1 of at least 1 total lines',
      );
      expect(result.llmContent).toContain('... [truncated]');
    });

    it('should propagate an aborted signal before reading', async () => {
      const filePath = await put('abort.txt', 'content');
      const controller = new AbortController();
      controller.abort();

      await expect(read(filePath, tool, controller.signal)).rejects.toThrow(
        /abort/i,
      );
    });

    it('does not cache a read that returns after cancellation', async () => {
      const filePath = path.join(tempRootDir, 'late-read.txt');
      await fsp.writeFile(filePath, 'content', 'utf-8');
      let release!: (result: { content: string }) => void;
      const response = new Promise<{ content: string }>((resolve) => {
        release = resolve;
      });
      const read = vi
        .spyOn(StandardFileSystemService.prototype, 'readTextFile')
        .mockReturnValueOnce(response);
      const recordRead = vi.spyOn(fileReadCache, 'recordRead');
      const controller = new AbortController();
      const running = tool
        .build({ file_path: filePath, offset: 0, limit: 20 })
        .execute(controller.signal)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        controller.abort();
        release({ content: 'late content' });
        expect(await running).toEqual({ error: controller.signal.reason });
        expect(recordRead).not.toHaveBeenCalled();
      } finally {
        release({ content: 'late content' });
        await running;
        read.mockRestore();
      }
    });

    it('should handle text file with lines exceeding maximum length', async () => {
      const longLine = 'a'.repeat(2500); // Exceeds MAX_LINE_LENGTH_TEXT_FILE (2000)
      const filePath = await put(
        'longlines.txt',
        `Short line\n${longLine}\nAnother short line`,
      );
      const result = await read(filePath);
      expect(result.returnDisplay).toContain(
        'Read lines 1-2 of 3 from longlines.txt (truncated)',
      );
    });

    it('returns image content without tool guidance before the registry is available', async () => {
      const result = await read(await putPng('image.png', 20, 10));
      expect(result.llmContent).toEqual([
        {
          // This suite's Config stub exposes no tool registry, so zoom_image is
          // not reachable and the hint is withheld (#12271).
          text: 'Image overview: 20x10; oriented source: 20x10.',
        },
        {
          inlineData: {
            data: expect.any(String),
            mimeType: 'image/jpeg',
            displayName: 'image.png',
          },
        },
      ]);
      expect(result.returnDisplay).toBe('Read image file: image.png');
    });

    it.each([{}, nullPagination])(
      'reads native PDF content with omitted or null pagination (%j)',
      async (pagination) => {
        const pdfHeader = Buffer.from('%PDF-1.4'); // minimal PDF header
        const pdfPath = await put('document.pdf', pdfHeader);
        const result = await read({ file_path: pdfPath, ...pagination });
        expect(result.llmContent).toEqual({
          inlineData: {
            data: pdfHeader.toString('base64'),
            mimeType: 'application/pdf',
            displayName: 'document.pdf',
          },
        });
        expect(result.returnDisplay).toBe('Read pdf file: document.pdf');
      },
    );

    describe('PDF vision bridge fallback', () => {
      const createTextOnlyTool = () =>
        new ReadFileTool(
          makeConfig({
            ...noMediaModalities,
            getModel: () => 'text-only-model',
            getEffectiveInputModalities: () => ({}),
            getDefaultVisionBridgeModel: () => ({
              id: 'qwen3-vl-plus',
              baseUrl: 'https://dashscope.aliyuncs.com/v1',
            }),
          }),
        );

      // Reads pages 20-25 of a scanned PDF with the text-only tool. `bridge`,
      // when given, overrides fields of a successful bridge result.
      async function readCandidate(
        bridge?: Record<string, unknown>,
        signalOverride: AbortSignal = abortSignal,
      ): Promise<ToolResult> {
        if (bridge) {
          visionBridgeMocks.runVisionBridge.mockResolvedValue({
            applied: true,
            status: 'ok',
            convertedCount: 4,
            omittedCount: 0,
            modelId: 'qwen3-vl-plus',
            modelEndpoint: 'dashscope.aliyuncs.com',
            egressOccurred: true,
            ...bridge,
          });
        }
        const pdfPath = await put('scanned.pdf', Buffer.from('%PDF-1.7'));
        return read(
          { file_path: pdfPath, pages: '20-25' },
          createTextOnlyTool(),
          signalOverride,
        );
      }

      function bridgeDisplay(result: ToolResult): VisionBridgeNoticeDisplay {
        expect(result.returnDisplay).toMatchObject({
          type: 'vision_bridge_notice',
        });
        return result.returnDisplay as VisionBridgeNoticeDisplay;
      }

      beforeEach(() => {
        visionBridgeMocks.shouldRunVisionBridge.mockReturnValue(true);
        pdfMocks.renderPDFPagesToImages.mockResolvedValue({
          success: true,
          images: ['20', '21', '22', '23'].map((data) => ({
            data,
            mimeType: 'image/jpeg',
          })),
          bytesTruncated: false,
        });
      });

      it('replaces candidate images with an untrusted transcription before returning', async () => {
        const result = await readCandidate({
          parts: [
            {
              text: '[Untrusted transcription]\nPage 20: heading\nPages 24-25 exist but were not transcribed; call read_file on the original PDF with a later page range to continue.',
            },
          ],
        });

        expect(result.error).toBeUndefined();
        const serialized = JSON.stringify(result.llmContent);
        expect(serialized).not.toContain('inlineData');
        expect(serialized).toContain('Untrusted transcription');
        expect(serialized).toContain(
          'Pages 24-25 exist but were not transcribed',
        );
        expect(serialized).not.toContain('pages 24-25 were not included');
        const display = bridgeDisplay(result);
        expect(display.summary).toContain(
          'transcribed PDF pages 20-23; remaining pages 24-25',
        );
        expect(display.notice).toContain('qwen3-vl-plus');
        expect(display.notice).toContain('dashscope.aliyuncs.com');
        expect(visionBridgeMocks.runVisionBridge).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceContext: {
              displayName: 'scanned.pdf',
              renderedRange: { firstPage: 20, lastPage: 23 },
              continuation: {
                certainty: 'known',
                firstPage: 24,
                lastPage: 25,
              },
            },
          }),
        );
        const sentParts = visionBridgeMocks.runVisionBridge.mock.calls[0][0]
          .parts as Array<{ inlineData?: unknown; text?: string }>;
        expect(sentParts).toHaveLength(4);
        expect(sentParts.every((part) => part.inlineData)).toBe(true);
      });

      it('does not present unknown continuation pages as certain', async () => {
        pdfMocks.getPDFPageCount.mockResolvedValue(null);
        const result = await readCandidate({
          parts: [{ text: '[Untrusted transcription]\nPage 20: heading' }],
        });

        const display = bridgeDisplay(result);
        expect(display.summary).toContain(
          'additional pages may exist from page 24 through page 25',
        );
        expect(display.summary).not.toContain('remaining pages 24-25');
        expect(visionBridgeMocks.runVisionBridge).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceContext: expect.objectContaining({
              continuation: {
                certainty: 'possible',
                firstPage: 24,
                requestedLastPage: 25,
              },
            }),
          }),
        );
      });

      it.each([
        ['request failure', 'the vision model request failed'],
        ['empty response', 'the vision model returned no description'],
        ['timeout', 'timed out after 30000ms'],
        ['model selection changed', 'no image-capable model is available'],
      ])('restores the original PDF error after %s', async (_name, error) => {
        const result = await readCandidate({
          status: 'failed',
          convertedCount: 0,
          error,
        });

        expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.error?.message).toBe('No extractable text layer.');
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
        expect(result.llmContent).not.toContain('Vision bridge');
        const display = bridgeDisplay(result);
        expect(display.summary).toContain(
          'rendered PDF pages 20-23; remaining pages 24-25',
        );
        expect(display.notice).toContain('dashscope.aliyuncs.com');
      });

      it('restores the PDF error for an unusable successful bridge result', async () => {
        const result = await readCandidate({ applied: false });

        expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
        expect(bridgeDisplay(result).notice).toContain(
          'dashscope.aliyuncs.com',
        );
      });

      it.each([
        [
          'inlineData',
          { inlineData: { data: 'unsafe', mimeType: 'application/pdf' } },
        ],
        [
          'fileData',
          {
            fileData: {
              fileUri: 'file:///tmp/unsafe.pdf',
              mimeType: 'application/pdf',
            },
          },
        ],
      ])(
        'fails closed when a successful bridge result still contains %s',
        async (mediaKey, mediaPart) => {
          const result = await readCandidate({ parts: [mediaPart] });

          expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
          expect(result.llmContent).toContain('Cannot extract text from PDF');
          expect(JSON.stringify(result.llmContent)).not.toContain(mediaKey);
          const display = bridgeDisplay(result);
          expect(display.notice).toContain('qwen3-vl-plus');
          expect(display.notice).toContain('dashscope.aliyuncs.com');
          expect(display.notice).toContain('transcription was discarded');
          expect(display.notice).not.toContain('vision model request failed');
        },
      );

      it('restores the PDF error when the bridge omits a rendered page', async () => {
        const result = await readCandidate({
          parts: [{ text: '[Untrusted transcription]\nPages 20-22' }],
          convertedCount: 3,
          omittedCount: 1,
        });

        expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        const notice = () => bridgeDisplay(result).notice;
        expect(notice()).toContain('dashscope.aliyuncs.com');
        expect(notice()).toContain('transcription was discarded');
        expect(notice()).not.toContain('vision model request failed');
        expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
      });

      it('restores the PDF error when the bridge throws before replacement', async () => {
        visionBridgeMocks.runVisionBridge.mockRejectedValue(
          new Error('network failure'),
        );

        const result = await readCandidate();

        expect(result.error?.type).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.error?.message).toBe('No extractable text layer.');
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
        expect(bridgeDisplay(result).notice).toContain(
          'failed before producing a transcription',
        );
      });

      it('propagates cancellation instead of restoring a PDF error', async () => {
        const controller = new AbortController();
        visionBridgeMocks.runVisionBridge.mockImplementation(async () => {
          controller.abort();
          return {
            applied: false,
            status: 'skipped',
            convertedCount: 0,
            omittedCount: 0,
            modelId: 'qwen3-vl-plus',
          };
        });

        await expect(
          readCandidate(undefined, controller.signal),
        ).rejects.toThrow(/abort/i);
      });

      it('preserves ordinary images for the shared tool-result bridge', async () => {
        const imagePath = await putPng('image.png', 8, 8);
        const result = await read(imagePath, createTextOnlyTool());

        // An ordinary decodable image keeps its inline media (the rendered
        // overview) and never routes through the vision bridge.
        const parts = result.llmContent as Array<{
          inlineData?: { mimeType?: string };
        }>;
        expect(
          parts.some((part) => part.inlineData?.mimeType === 'image/jpeg'),
        ).toBe(true);
        expect(visionBridgeMocks.runVisionBridge).not.toHaveBeenCalled();
      });
    });

    const svgContent = '<svg><circle cx="50" cy="50" r="40"/></svg>';
    const tempContent = 'This is temporary output content';
    it.each<[string, string, string | Buffer, string, string]>([
      [
        'should handle binary file and skip content',
        'binary.bin',
        Buffer.from([0x00, 0xff, 0x00, 0xff]), // null bytes
        'Cannot display content of binary file: binary.bin',
        'Skipped binary file: binary.bin',
      ],
      [
        'should handle SVG file as text',
        'image.svg',
        svgContent,
        svgContent,
        'Read SVG as text: image.svg',
      ],
      [
        'should handle large SVG file',
        'large.svg',
        '<svg>' + 'x'.repeat(1024 * 1024 + 1) + '</svg>', // over 1MB
        'Cannot display content of SVG file larger than 1MB: large.svg',
        'Skipped large SVG file (>1MB): large.svg',
      ],
      ['should handle empty file', 'empty.txt', '', '', ''],
      [
        'should successfully read files from project temp directory',
        path.join('.temp', 'temp-output.txt'),
        tempContent,
        tempContent,
        '',
      ],
    ])('%s', async (_title, file, content, llmContent, returnDisplay) => {
      const result = await read(await put(file, content));
      expect(result.llmContent).toBe(llmContent);
      expect(result.returnDisplay).toBe(returnDisplay);
    });

    it('should handle Jupyter notebook file', async () => {
      const nbPath = await put(
        'test.ipynb',
        notebookJson([codeCell('print("hello")', 1, 'hello\n')]),
      );
      const error = tool.validateToolParams({
        file_path: nbPath,
        offset: 0,
        limit: 0,
      });
      expect(error).toContain('Retry with: ');
      const params: ReadFileToolParams = JSON.parse(
        error!.split('Retry with: ')[1],
      );

      const result = await read(params);
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('Jupyter Notebook');
      expect(result.llmContent).toContain('print("hello")');
      expect(result.llmContent).toContain('hello');
      expect(result.returnDisplay).toBe('Read notebook: test.ipynb');
      expect(cachedEntry(nbPath).lastReadWasFull).toBe(true);
    });

    it('records truncated notebook reads as not full', async () => {
      const cells = Array.from({ length: 200 }, (_, i) =>
        codeCell('x = ' + 'a'.repeat(600) + '\n', i + 1, 'result '.repeat(100)),
      );
      const nbPath = await put('large.ipynb', notebookJson(cells));

      const result = await read(nbPath);
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('remaining cells truncated');
      expect(result.llmContent).not.toContain('Showing lines');

      const entry = cachedEntry(nbPath);
      expect(entry.lastReadWasFull).toBe(false);
      expect(entry.lastReadCacheable).toBe(false);
    });

    it.each([
      [
        'should reject invalid pages parameter',
        'abc',
        'Invalid pages parameter',
      ],
      [
        'should reject pages range exceeding 20',
        '1-25',
        'Pages range exceeds maximum of 20',
      ],
      ['should reject open-ended pages range', '3-', 'Open-ended page ranges'],
    ])('%s', (_title, pages, error) => {
      expect(() => tool.build({ file_path: '/tmp/test.pdf', pages })).toThrow(
        error,
      );
    });

    it('should accept valid pages parameter', () => {
      expect(() =>
        tool.build({ file_path: inRoot('test.pdf'), pages: '1-5' }),
      ).not.toThrow();
    });

    it('should treat empty pages parameter as unset', () => {
      const invocation = tool.build({
        file_path: inRoot('test.txt'),
        pages: '',
      });
      expect(invocation.params.pages).toBeUndefined();
    });

    it('should support offset and limit for text files', async () => {
      const filePath = await put('paginated.txt', numberedLines(20, 'Line'));

      const result = await read({
        file_path: filePath,
        offset: 5, // Start from line 6
        limit: 3,
        pages: null,
      });
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

    it('should read OS temp files after the invocation is executed', async () => {
      const osTempFile = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'read-file-test-'),
      );
      const tempFileContent = '## PR #123\nFix encoding issues';
      const tempFilePath = await put(
        path.join(osTempFile, 'pr-review-context.md'),
        tempFileContent,
      );

      try {
        expect((await read(tempFilePath)).llmContent).toBe(tempFileContent);
      } finally {
        await fsp.rm(osTempFile, { recursive: true, force: true });
      }
    });

    describe('with FileReadCache', () => {
      const PLACEHOLDER = /unchanged since last read in this session/;

      it('treats null pagination as a full text read for caching', async () => {
        const filePath = await put('nullable.txt', 'first\nsecond\nthird');
        const result = await read({ file_path: filePath, ...nullPagination });
        expect(result.llmContent).toBe('first\nsecond\nthird');
        expect((await read(filePath)).llmContent).toContain(
          'unchanged since last read',
        );
      });

      it('returns a short error when a text-only model reads a large PDF without pages', async () => {
        const pdfPath = await put('large.pdf', Buffer.alloc(2 * 1024 * 1024));
        const textOnlyTool = new ReadFileTool(makeConfig(noMediaModalities));

        const result = await read(pdfPath, textOnlyTool);

        expect(result.error?.type).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(String(result.llmContent).length).toBeLessThan(1000);
        expect(result.llmContent).toContain('has 31 pages');
        expect(result.llmContent).toContain("Use the 'pages' parameter");
      });

      it('keeps nested reads usable without claiming their bytes reached history', async () => {
        const filePath = await put('program-input.txt', 'program input');
        await read(filePath);
        for (let i = 0; i < 2; i++) {
          const result = await runWithToolCallSource(
            { kind: 'code_mode' },
            () => read(filePath),
          );
          expect(result.llmContent).toBe('program input');
        }
        const entry = cachedEntry(filePath);
        expect(entry.lastReadWasFull).toBe(true);
        expect(entry.lastReadCacheable).toBe(true);
        expect(entry.readResidentInHistory).toBe(false);
        expect((await read(filePath)).llmContent).toBe('program input');
        expect((await read(filePath)).llmContent).toMatch(/unchanged since/);
      });

      it('returns the file_unchanged placeholder on a second full Read of an unchanged text file', async () => {
        const filePath = await put('note.txt', 'hello world');

        const first = await read(filePath);
        expect(first.llmContent).toBe('hello world');

        const second = await read(filePath);
        expect(typeof second.llmContent).toBe('string');
        expect(second.llmContent).toMatch(PLACEHOLDER);
        // Placeholder must not echo the original content.
        expect(second.llmContent).not.toContain('hello world');
        expect(second.returnDisplay).toMatch(/^Unchanged: /);
      });

      it('re-emits bytes (no placeholder) after the read was evicted from history by microcompaction (issue #4239)', async () => {
        const filePath = await put('evicted.txt', 'hello world');

        const first = await read(filePath);
        expect(first.llmContent).toBe('hello world');

        // Idle microcompaction blanked this read's output, so the bytes are no
        // longer quotable from history: re-emit them, never a placeholder.
        fileReadCache.markReadEvictedFromHistory(fs.statSync(filePath));
        const second = await read(filePath);
        expect(second.llmContent).toBe('hello world');
        expect(second.llmContent).not.toMatch(/unchanged since/);

        // And a re-read re-arms the fast-path (bytes are back in history).
        expect((await read(filePath)).llmContent).toMatch(PLACEHOLDER);
      });

      it('a partial read after eviction does NOT re-arm the placeholder (Codex P2)', async () => {
        const filePath = await put(
          'evicted-partial.txt',
          'line1\nline2\nline3\n',
        );

        await read(filePath);
        fileReadCache.markReadEvictedFromHistory(fs.statSync(filePath));

        // A ranged read leaves only a slice resident, so a follow-up full
        // Read must STILL re-emit real bytes.
        const partial = await read({ file_path: filePath, limit: 1 });
        expect(partial.llmContent).not.toMatch(/unchanged since/);
        const full = await read(filePath);
        expect(full.llmContent).toContain('line3');
        expect(full.llmContent).not.toMatch(/unchanged since/);
      });

      it('serves a fresh full Read after an external modification (stale)', async () => {
        const filePath = await put('mut.txt', 'one');
        await read(filePath);

        // Bump mtime well into the future to defeat low-precision filesystems
        // that share the second across rapid writes.
        await put(filePath, 'two');
        const future = new Date(Date.now() + 60_000);
        await fsp.utimes(filePath, future, future);

        expect((await read(filePath)).llmContent).toBe('two');
      });

      it('forces a full Read after recordWrite even if mtime/size still match', async () => {
        // The next Read after Edit / Write must show post-write bytes, not a
        // placeholder for the pre-write content. lastReadAt < lastWriteAt
        // enforces this even when stats match (no-op Edit, coalesced mtime).
        const filePath = await put('edited.txt', 'before');
        await read(filePath);

        fileReadCache.recordWrite(filePath, fs.statSync(filePath));

        const after = await read(filePath);
        expect(after.llmContent).toBe('before');
        expect(after.llmContent).not.toMatch(/unchanged since/);
      });

      it('never short-circuits a ranged Read (offset/limit set)', async () => {
        const filePath = await put('multi.txt', 'a\nb\nc\nd\ne');
        await read(filePath);

        const ranged = await read({ file_path: filePath, offset: 1, limit: 2 });
        expect(typeof ranged.llmContent).toBe('string');
        expect(ranged.llmContent).not.toMatch(/unchanged since/);
        expect(ranged.llmContent).toContain('b');
      });

      it('does not arm the placeholder if the first Read was truncated', async () => {
        // A truncated read has not shown the full file even without
        // offset/limit, so a no-args re-Read must re-emit the window rather
        // than claim "you've already seen this file". 700 lines exceed the
        // mock Config's 500-line cap; the line or character cap may fire.
        const filePath = await put('long.txt', numberedLines(700));

        const first = await read(filePath);
        expect(typeof first.llmContent).toBe('string');
        expect(first.returnDisplay).toMatch(/Read lines .* of 700/);

        const second = await read(filePath);
        expect(typeof second.llmContent).toBe('string');
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(second.returnDisplay).toMatch(/Read lines .* of 700/);
      });

      it('does not arm the placeholder if the first Read was ranged', async () => {
        // A sliced first Read leaves lastReadWasFull = false, so the cache
        // cannot prove the model saw the whole file: run the full pipeline.
        const filePath = await put('big.txt', 'a\nb\nc\nd\ne');

        await read({ file_path: filePath, offset: 0, limit: 2 });
        const followUp = await read(filePath);
        expect(typeof followUp.llmContent).toBe('string');
        expect(followUp.llmContent).not.toMatch(/unchanged since/);
        expect(followUp.llmContent).toContain('e');
      });

      it('does not return the placeholder for binary files', async () => {
        const binPath = await put(
          'blob.bin',
          Buffer.from([0x00, 0xff, 0x00, 0xff]),
        );
        const first = await read(binPath);
        expect(typeof first.llmContent).toBe('string');
        expect(first.llmContent).toMatch(/Cannot display content of binary/);

        const second = await read(binPath);
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(second.llmContent).toMatch(/Cannot display content of binary/);
      });

      it('records an auto-memory read in the cache so a follow-up Edit can pass enforcement', async () => {
        // Auto-memory files skip the file_unchanged fast-path (their
        // per-read freshness `<system-reminder>` must be re-emitted) but MUST
        // still be recorded, or prior-read enforcement on Edit / WriteFile
        // refuses a file the model just read. QWEN_CODE_MEMORY_LOCAL=1 puts
        // the file under .qwen/<auto-memory>/.
        vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '1'); // restored in afterEach
        const { getAutoMemoryRoot, clearAutoMemoryRootCache } = await import(
          '../memory/paths.js'
        );
        clearAutoMemoryRootCache();
        const memFile = await put(
          path.join(getAutoMemoryRoot(tempRootDir), 'AGENTS.md'),
          '# memory',
        );

        const result = await read(memFile);
        expect(typeof result.llmContent).toBe('string');
        expect(result.llmContent).not.toMatch(/unchanged since/);
        // Enforcement needs fresh + lastReadAt + full + cacheable: checking
        // only `fresh` would miss a regression recording auto-memory reads
        // as partial/non-cacheable, which would reject every later Edit.
        const entry = cachedEntry(memFile);
        expect(entry.lastReadAt).toBeDefined();
        expect(entry.lastReadWasFull).toBe(true);
        expect(entry.lastReadCacheable).toBe(true);
      });

      it('records SVG-as-text reads with cacheable=true so a follow-up Edit passes enforcement', async () => {
        // Pre-fix the SVG branch in fileUtils.ts omitted `originalLineCount`,
        // collapsing `cacheable` to false, so EditTool's prior-read
        // enforcement took the SVG for a "non-text payload" and rejected
        // an in-place edit. It must record a full, cacheable read.
        const svgPath = await put(
          'icon.svg',
          '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
        );

        const result = await read(svgPath);
        expect(typeof result.llmContent).toBe('string');
        expect(result.returnDisplay).toMatch(/^Read SVG as text:/);

        const entry = cachedEntry(svgPath);
        expect(entry.lastReadAt).toBeDefined();
        expect(entry.lastReadWasFull).toBe(true);
        expect(entry.lastReadCacheable).toBe(true);
      });

      it('records partial text reads with lastReadCacheable=true so a follow-up Edit passes enforcement (issue #3964)', async () => {
        // Pre-fix `cacheable` was `string && originalLineCount &&
        // !isTruncated`; an offset/limit read sets isTruncated, so it was
        // recorded non-cacheable and priorReadEnforcement.ts rejected the
        // next Edit with the misleading "binary / image / audio / video /
        // PDF / notebook payload" error. Truncation now lives only on
        // `lastReadWasFull`.
        const filePath = await put('partial.kt', numberedLines(50));

        await read({ file_path: filePath, offset: 10, limit: 5 });

        const entry = cachedEntry(filePath);
        expect(entry.lastReadAt).toBeDefined();
        expect(entry.lastReadWasFull).toBe(false); // ranged: not every byte
        expect(entry.lastReadCacheable).toBe(true); // but text: Edit accepts
      });

      it('records truncated full reads with lastReadCacheable=true (issue #3964)', async () => {
        // The other arm of #3964: a no-args Read of a file over the mock
        // Config's 500-line cap. Pre-fix truncation collapsed `cacheable` to
        // false ("binary payload" on Edit); now only `lastReadWasFull` is.
        const filePath = await put('long.cpp', numberedLines(700));

        const result = await read(filePath);
        expect(result.returnDisplay).toMatch(/Read lines .* of 700/);

        const entry = cachedEntry(filePath);
        expect(entry.lastReadWasFull).toBe(false); // model saw only the head
        expect(entry.lastReadCacheable).toBe(true);
      });

      it('reads source-code files with binary-looking content as text (encrypted FS, issue #3964)', async () => {
        // Frank-Shaw-FS: on Windows encrypted / DRM file systems `fs.open()`
        // random-access reads see encrypted bytes, so the 4 KB `isBinaryFile`
        // sample misclassified `.cpp` sources as binary. detectFileType's
        // extension override skips the sample for known text extensions;
        // check it reaches `processSingleFileContent` and records a
        // text-cacheable read. A real encrypted volume is impractical here,
        // so plain `.cpp` text stands in (no isBinaryFile mocking in scope).
        const filePath = await put(
          'src.cpp',
          '#include <iostream>\nint main() {}\n',
        );

        const result = await read(filePath);
        expect(typeof result.llmContent).toBe('string');
        expect(result.llmContent).toContain('#include');

        expect(cachedEntry(filePath).lastReadCacheable).toBe(true);
      });

      it('does not return the placeholder for image files', async () => {
        const imagePath = await putPng('pic.png', 8, 8);

        const first = await read(imagePath);
        // Image returns Parts, not a string.
        expect(typeof first.llmContent).not.toBe('string');

        const second = await read(imagePath);
        // Must remain Parts — never collapsed to a string placeholder.
        expect(typeof second.llmContent).not.toBe('string');
      });

      it('completely bypasses the cache when getFileReadCacheDisabled() is true', async () => {
        // With the cache disabled, two full Reads both return the content,
        // and the cache stays empty so prior-read enforcement (added in a
        // follow-up) cannot trip on a recorded entry.
        const isolatedCache = new FileReadCache();
        const disabledTool = new ReadFileTool(
          makeConfig({
            getFileReadCache: () => isolatedCache,
            getFileReadCacheDisabled: () => true,
          }),
        );

        const filePath = await put('bypass.txt', 'plain text');

        const first = await read(filePath, disabledTool);
        const second = await read(filePath, disabledTool);

        expect(first.llmContent).toBe('plain text');
        expect(second.llmContent).toBe('plain text');
        expect(second.llmContent).not.toMatch(/unchanged since/);
        expect(isolatedCache.size()).toBe(0);
      });
    });

    describe('with .qwenignore', () => {
      beforeEach(async () => {
        await put('.qwenignore', ['foo.*', 'ignored/'].join('\n'));
      });

      it.each([
        [
          'should throw error if path is ignored by a .qwenignore pattern',
          'foo.bar',
        ],
        [
          'should throw error if file is in an ignored directory',
          path.join('ignored', 'file.txt'),
        ],
      ])('%s', async (_title, file) => {
        const ignoredFilePath = await put(file, 'content');
        const expectedError = `File path '${ignoredFilePath}' is ignored by .qwenignore pattern(s).`;
        expect(() => tool.build({ file_path: ignoredFilePath })).toThrow(
          expectedError,
        );
      });

      it('should throw error if path is ignored by .agentignore or .aiignore', async () => {
        await put('.agentignore', 'agent-secret.txt\n');
        await put('.aiignore', 'ai-secret.txt\n');
        const agentIgnoredFilePath = await put('agent-secret.txt', 'content');
        const aiIgnoredFilePath = await put('ai-secret.txt', 'content');

        expect(() => tool.build({ file_path: agentIgnoredFilePath })).toThrow(
          /\.agentignore/,
        );
        expect(() => tool.build({ file_path: aiIgnoredFilePath })).toThrow(
          /\.aiignore/,
        );
      });

      it('should throw error using configured custom ignore file display', async () => {
        await put('.cursorignore', 'cursor-secret.txt\n');
        const customTool = new ReadFileTool(
          makeConfig({
            getFileService: () =>
              new FileDiscoveryService(tempRootDir, ['.cursorignore']),
          }),
        );
        const ignoredFilePath = await put('cursor-secret.txt', 'content');

        expect(() => customTool.build({ file_path: ignoredFilePath })).toThrow(
          /\.cursorignore/,
        );
      });

      it('should allow reading non-ignored files', async () => {
        const allowedFilePath = await put('allowed.txt', 'content');
        const invocation = tool.build({ file_path: allowedFilePath });
        expect(typeof invocation).not.toBe('string');
      });
    });
  });
});
