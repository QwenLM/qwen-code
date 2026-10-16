/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

import * as actualNodeFs from 'node:fs'; // For setup/teardown
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import mime from 'mime/lite';
import type { Part } from '@google/genai';
import sharp, { type PngOptions } from 'sharp';

import {
  isWithinRoot,
  isBinaryFile,
  detectFileType,
  processSingleFileContent,
  detectBOM,
  readFileWithLineAndLimit,
  readFileWithEncoding,
  readFileWithEncodingInfo,
  detectFileEncoding,
  fileExists,
  type ProcessedFileReadResult,
  type ProcessSingleFileContentOptions,
} from './fileUtils.js';
import { decodeBufferWithEncodingInfo } from '../services/sync-file-encoding.js';
import { iconvEncode } from './iconvHelper.js';
import { LargeNonUtf8TextError } from './read-text-range.js';
import type { Config } from '../config/config.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { ToolErrorType } from '../tools/tool-error.js';
import {
  PDF_MAX_PAGES_PER_READ,
  renderPDFPagesToImages,
  resetPdftotextCache,
} from './pdf.js';
import { VISION_BRIDGE_MAX_IMAGES } from './vision-bridge-constants.js';

vi.mock('mime/lite', () => ({
  default: { getType: vi.fn() },
  getType: vi.fn(),
}));

// Mock execFile so isPdftotextAvailable does not spawn a real process.
// On platforms where pdftotext is not installed (e.g. Windows CI),
// the 5-second execFile timeout can exceed the default 5s test timeout.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _command: string,
        _args: string[],
        _optionsOrCallback: unknown,
        _callback?: unknown,
      ) => {
        // Resolve the callback (supports both signatures of execFile)
        const cb =
          typeof _optionsOrCallback === 'function'
            ? _optionsOrCallback
            : _callback;
        const error = Object.assign(new Error('Command not found'), {
          code: 'ENOENT',
        });
        if (typeof cb === 'function') {
          setImmediate(() => cb(error, '', ''));
        }
        return {
          kill: vi.fn(),
          on: vi.fn(),
        } as unknown as import('node:child_process').ChildProcess;
      },
    ),
  };
});

// Keep the real pdf.js (extractPDFText, page-count gates, etc. drive the
// text path via the mocked execFile above) but stub out the image renderer so
// tests don't shell out to poppler / touch the filesystem. pdf.test.ts covers
// renderPDFPagesToImages itself.
vi.mock('./pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdf.js')>();
  return { ...actual, renderPDFPagesToImages: vi.fn() };
});

// Config lazily loads the Omni module for processSingleFileContent;
// vitest intercepts dynamic imports too, so a registry mock is what stubs
// the delivery pipeline. Safe for every non-omni test: the cheap
// `config.isOmniEnabled?.()` gate runs BEFORE the import, and the default
// mockConfig has no isOmniEnabled.
const omniGateMocks = vi.hoisted(() => ({
  isOmniDeliveryActive: vi.fn(),
  sniffFileModality: vi.fn(),
  readMediaViaOmniDelivery: vi.fn(),
}));
vi.mock('../omni/index.js', () => omniGateMocks);

const mockMimeGetType = mime.getType as Mock;
const mockExecFile = vi.mocked(execFile);
const mockRender = vi.mocked(renderPDFPagesToImages);

type ExecResult = { stdout: string; stderr: string; code: number };

function mockExecResult(result: ExecResult) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (result.code !== 0) {
        const err = new Error('command failed') as Error & { code: number };
        err.code = result.code;
        callback(err, result.stdout, result.stderr);
      } else {
        callback(null, result.stdout, result.stderr);
      }
      return {
        kill: vi.fn(),
        on: vi.fn(),
      } as unknown as import('node:child_process').ChildProcess;
    },
  );
}

// Canned exec results, queued in call order by mockExecResult: pdfinfo page
// counts, the pdftotext version probe, and pdftotext output.
const execOk = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  code: 0,
});
const pdfinfo = (pages: number) => execOk(`Pages:          ${pages}\n`);
const NO_PDFINFO = { stdout: '', stderr: 'pdfinfo missing', code: 1 };
const PDFTOTEXT = { stdout: '', stderr: 'pdftotext version', code: 0 };
const DENSE = execOk('x'.repeat(80_000));
const BLANK = execOk('   ');

const MB = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// A real, decodable two-frame GIF.
const TWO_FRAME_GIF = Buffer.from(
  '47494638396101000100800000000000ffffff21f90400010000002c000000000100010000020244010021f90400010000002c00000000010001000002024c01003b',
  'hex',
);
// Needs enough GBK content for chardet to reliably detect the encoding.
const GBK_TEXT = '你好世界这是中文内容用于测试编码检测';
const GBK_BYTES = iconvEncode(GBK_TEXT, 'gbk');

describe('fileUtils', () => {
  let tempRootDir: string;
  const originalProcessCwd = process.cwd;

  let testTextFilePath: string;
  let testImageFilePath: string;
  let testPdfFilePath: string;
  let testBinaryFilePath: string;
  let nonexistentFilePath: string;
  let directoryPath: string;

  const fsService = new StandardFileSystemService();

  const mockConfig = {
    getTruncateToolOutputThreshold: () => 2500,
    getTruncateToolOutputLines: () => 500,
    getTargetDir: () => tempRootDir,
    getModel: () => 'qwen3.5-plus',
    getContentGeneratorConfig: () => ({
      modalities: { image: true, video: true },
    }),
    getFileSystemService: () => fsService,
    getToolRegistry: () => ({
      getFunctionDeclarations: () => [
        { name: 'read_file' },
        { name: 'tool_search' },
      ],
      getDeferredToolSummary: () => [{ name: 'zoom_image' }],
      getCodeModeBindingPlan: () => ({
        bindings: [{ name: 'zoom_image' }],
        collisions: [],
      }),
    }),
  } as unknown as Config;

  const writeTemp = (name: string, data: string | Buffer) => {
    const filePath = path.join(tempRootDir, name);
    actualNodeFs.writeFileSync(filePath, data);
    return filePath;
  };

  beforeEach(() => {
    vi.resetAllMocks(); // Reset all mocks, including mime.getType
    resetPdftotextCache();

    tempRootDir = actualNodeFs.mkdtempSync(
      path.join(os.tmpdir(), 'fileUtils-test-'),
    );
    process.cwd = vi.fn(() => tempRootDir); // Mock cwd if necessary for relative path logic within tests

    testTextFilePath = path.join(tempRootDir, 'test.txt');
    testImageFilePath = path.join(tempRootDir, 'image.png');
    testPdfFilePath = path.join(tempRootDir, 'document.pdf');
    testBinaryFilePath = path.join(tempRootDir, 'app.exe');
    nonexistentFilePath = path.join(tempRootDir, 'nonexistent.txt');
    directoryPath = path.join(tempRootDir, 'subdir');

    actualNodeFs.mkdirSync(directoryPath, { recursive: true }); // Ensure subdir exists
  });

  afterEach(() => {
    if (actualNodeFs.existsSync(tempRootDir)) {
      actualNodeFs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    process.cwd = originalProcessCwd;
    vi.restoreAllMocks(); // Restore any spies
  });

  describe('isWithinRoot', () => {
    const root = path.resolve('/project/root');

    it('should return true for paths directly within the root', () => {
      expect(isWithinRoot(path.join(root, 'file.txt'), root)).toBe(true);
      expect(isWithinRoot(path.join(root, 'subdir', 'file.txt'), root)).toBe(
        true,
      );
    });

    it('should return true for the root path itself', () => {
      expect(isWithinRoot(root, root)).toBe(true);
    });

    it('should return false for paths outside the root', () => {
      expect(
        isWithinRoot(path.resolve('/project/other', 'file.txt'), root),
      ).toBe(false);
      expect(isWithinRoot(path.resolve('/unrelated', 'file.txt'), root)).toBe(
        false,
      );
    });

    it('should return false for paths that only partially match the root prefix', () => {
      expect(
        isWithinRoot(
          path.resolve('/project/root-but-actually-different'),
          root,
        ),
      ).toBe(false);
    });

    it('should handle paths with trailing slashes correctly', () => {
      expect(isWithinRoot(path.join(root, 'file.txt') + path.sep, root)).toBe(
        true,
      );
      expect(isWithinRoot(root + path.sep, root)).toBe(true);
    });

    it('should handle different path separators (POSIX vs Windows)', () => {
      const posixRoot = '/project/root';
      expect(isWithinRoot('/project/root/file.txt', posixRoot)).toBe(true);
      expect(isWithinRoot('/project/other/file.txt', posixRoot)).toBe(false);
    });

    it('should return false for a root path that is a sub-path of the path to check', () => {
      const parent = path.resolve('/project/root');
      const child = path.resolve('/project/root/sub');
      expect(isWithinRoot(child, parent)).toBe(true);
      expect(isWithinRoot(parent, child)).toBe(false);
    });
  });

  describe('fileExists', () => {
    it('should return true if the file exists', async () => {
      const testFile = writeTemp('exists.txt', 'content');
      await expect(fileExists(testFile)).resolves.toBe(true);
    });

    it('should return false if the file does not exist', async () => {
      const testFile = path.join(tempRootDir, 'does-not-exist.txt');
      await expect(fileExists(testFile)).resolves.toBe(false);
    });

    it('should return true for a directory that exists', async () => {
      const testDir = path.join(tempRootDir, 'exists-dir');
      actualNodeFs.mkdirSync(testDir);
      await expect(fileExists(testDir)).resolves.toBe(true);
    });
  });

  describe('isBinaryFile', () => {
    let filePathForBinaryTest: string;

    beforeEach(() => {
      filePathForBinaryTest = path.join(tempRootDir, 'binaryCheck.tmp');
    });

    afterEach(() => {
      if (actualNodeFs.existsSync(filePathForBinaryTest)) {
        actualNodeFs.unlinkSync(filePathForBinaryTest);
      }
    });

    it.each<[string, string | Buffer, boolean]>([
      ['should return false for an empty file', '', false],
      [
        'should return false for a typical text file',
        'Hello, world!\nThis is a test file with normal text content.',
        false,
      ],
      [
        'should return true for a file with many null bytes',
        // "He\0llo\0\0\0\0\0"
        Buffer.from([
          0x48, 0x65, 0x00, 0x6c, 0x6f, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]),
        true,
      ],
      [
        'should return true for a file with high percentage of non-printable ASCII',
        // AB\x01\x02\x03\x04\x05CD\x06
        Buffer.from([
          0x41, 0x42, 0x01, 0x02, 0x03, 0x04, 0x05, 0x43, 0x44, 0x06,
        ]),
        true,
      ],
    ])('%s', async (_title, content, expected) => {
      actualNodeFs.writeFileSync(filePathForBinaryTest, content);
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(expected);
    });

    it('should return false if file access fails (e.g., ENOENT)', async () => {
      // Ensure the file does not exist
      if (actualNodeFs.existsSync(filePathForBinaryTest)) {
        actualNodeFs.unlinkSync(filePathForBinaryTest);
      }
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(false);
    });
  });

  describe('BOM detection and encoding', () => {
    let testDir: string;
    const BOM = {
      utf8: [0xef, 0xbb, 0xbf],
      utf16le: [0xff, 0xfe],
      utf16be: [0xfe, 0xff],
      utf32le: [0xff, 0xfe, 0x00, 0x00],
      utf32be: [0x00, 0x00, 0xfe, 0xff],
    };
    const withBom = (bom: number[], body: Buffer) =>
      Buffer.concat([Buffer.from(bom), body]);
    // Node has no UTF-16 BE / UTF-32 codecs: encode by hand (surrogate pairs
    // included for the emoji).
    const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
    const utf32 = (text: string, littleEndian: boolean) => {
      const codePoints = Array.from(text, (char) => char.codePointAt(0)!);
      const buf = Buffer.alloc(codePoints.length * 4);
      codePoints.forEach((cp, i) =>
        littleEndian
          ? buf.writeUInt32LE(cp, i * 4)
          : buf.writeUInt32BE(cp, i * 4),
      );
      return buf;
    };
    const writeTestFile = async (name: string, data: string | Buffer) => {
      const filePath = path.join(testDir, name);
      await fsPromises.writeFile(filePath, data);
      return filePath;
    };

    beforeEach(async () => {
      testDir = await fsPromises.mkdtemp(
        path.join(
          await fsPromises.realpath(os.tmpdir()),
          'fileUtils-bom-test-',
        ),
      );
    });

    afterEach(async () => {
      if (testDir) {
        await fsPromises.rm(testDir, { recursive: true, force: true });
      }
    });

    describe('detectBOM', () => {
      it.each<[string, number[], ReturnType<typeof detectBOM>]>([
        [
          'should detect UTF-8 BOM',
          [0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f],
          { encoding: 'utf8', bomLength: 3 },
        ],
        [
          'should detect UTF-16 LE BOM',
          [0xff, 0xfe, 0x48, 0x00, 0x65, 0x00],
          { encoding: 'utf16le', bomLength: 2 },
        ],
        [
          'should detect UTF-16 BE BOM',
          [0xfe, 0xff, 0x00, 0x48, 0x00, 0x65],
          { encoding: 'utf16be', bomLength: 2 },
        ],
        [
          'should detect UTF-32 LE BOM',
          [0xff, 0xfe, 0x00, 0x00, 0x48, 0x00, 0x00, 0x00],
          { encoding: 'utf32le', bomLength: 4 },
        ],
        [
          'should detect UTF-32 BE BOM',
          [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x48],
          { encoding: 'utf32be', bomLength: 4 },
        ],
        ['should return null for no BOM', [0x48, 0x65, 0x6c, 0x6c, 0x6f], null],
        ['should return null for empty buffer', [], null],
        ['should return null for partial BOM', [0xef, 0xbb], null], // Incomplete UTF-8 BOM
      ])('%s', (_title, bytes, expected) => {
        expect(detectBOM(Buffer.from(bytes))).toEqual(expected);
      });
    });

    describe('readFileWithEncoding', () => {
      const text = 'Hello, 世界! 🌍';

      it.each<[string, string, string | Buffer, string]>([
        [
          'should read UTF-8 BOM file correctly',
          'utf8-bom.txt',
          withBom(BOM.utf8, Buffer.from(text, 'utf8')),
          text,
        ],
        [
          'should read UTF-16 LE BOM file correctly',
          'utf16le-bom.txt',
          withBom(BOM.utf16le, Buffer.from(text, 'utf16le')),
          text,
        ],
        [
          'should read UTF-16 BE BOM file correctly',
          'utf16be-bom.txt',
          withBom(BOM.utf16be, utf16be(text)),
          text,
        ],
        [
          'should read UTF-32 LE BOM file correctly',
          'utf32le-bom.txt',
          withBom(BOM.utf32le, utf32(text, true)),
          text,
        ],
        [
          'should read UTF-32 BE BOM file correctly',
          'utf32be-bom.txt',
          withBom(BOM.utf32be, utf32(text, false)),
          text,
        ],
        [
          'should read file without BOM as UTF-8',
          'no-bom.txt',
          'Hello, 世界!',
          'Hello, 世界!',
        ],
        ['should handle empty file', 'empty.txt', '', ''],
        [
          'should read GBK-encoded file with Chinese characters correctly',
          'gbk-chinese.txt',
          GBK_BYTES,
          GBK_TEXT,
        ],
      ])('%s', async (_title, name, data, expected) => {
        const filePath = await writeTestFile(name, data);
        expect(await readFileWithEncoding(filePath)).toBe(expected);
      });

      it('should read GBK-encoded file with mixed ASCII and Chinese correctly', async () => {
        // Needs enough Chinese content for chardet to reliably detect as GB18030/GBK
        const filePath = await writeTestFile(
          'gbk-mixed.txt',
          iconvEncode(
            '// 这是注释内容用于测试\nhello你好世界测试中文编码检测\n函数返回值正确',
            'gbk',
          ),
        );

        const result = await readFileWithEncoding(filePath);
        expect(result).toContain('hello');
        expect(result).toContain('你好世界');
        expect(result).toContain('函数返回值正确');
      });
    });

    describe('readFileWithEncodingInfo', () => {
      it.each<[string, Buffer, boolean]>([
        [
          'should decode plain UTF-8 buffers without reading from a path',
          Buffer.from('Hello', 'utf8'),
          false,
        ],
        [
          'should decode UTF-8 BOM buffers without reading from a path',
          withBom(BOM.utf8, Buffer.from('Hello', 'utf8')),
          true,
        ],
      ])('%s', (_title, buffer, bom) => {
        expect(decodeBufferWithEncodingInfo(buffer)).toEqual({
          content: 'Hello',
          encoding: 'utf-8',
          bom,
        });
      });

      it.each<[string, string, string | Buffer, string, string, boolean]>([
        [
          'should return bom: false and encoding utf-8 for plain UTF-8 file',
          'info-utf8.txt',
          'Hello',
          'Hello',
          'utf-8',
          false,
        ],
        [
          'should return bom: true and encoding utf-8 for UTF-8 BOM file',
          'info-utf8-bom.txt',
          withBom(BOM.utf8, Buffer.from('Hello', 'utf8')),
          'Hello',
          'utf-8',
          true,
        ],
        [
          // Non-UTF-8 BOM should also be flagged so it is preserved on write-back
          'should return bom: true and encoding utf-16le for UTF-16LE BOM file',
          'info-utf16le.txt',
          withBom(BOM.utf16le, Buffer.from('Hi', 'utf16le')),
          'Hi',
          'utf-16le',
          true,
        ],
        [
          'should return bom: false for GBK file (no BOM)',
          'info-gbk.txt',
          GBK_BYTES,
          GBK_TEXT,
          'gb18030',
          false,
        ],
      ])('%s', async (_title, name, data, content, encoding, bom) => {
        const filePath = await writeTestFile(name, data);
        const result = await readFileWithEncodingInfo(filePath);
        expect(result.content).toBe(content);
        expect(result.encoding).toBe(encoding);
        expect(result.bom).toBe(bom);
      });
    });

    describe('detectFileEncoding', () => {
      // `null` data: the file is never created.
      it.each<[string, string, string | Buffer | null, string]>([
        [
          'should detect UTF-8 for plain ASCII file',
          'ascii.txt',
          'Hello World',
          'utf-8',
        ],
        [
          'should detect UTF-8 for file with UTF-8 BOM',
          'utf8-bom-detect.txt',
          withBom(BOM.utf8, Buffer.from('Hello', 'utf8')),
          'utf-8',
        ],
        [
          // chardet detects GBK as 'gb18030' (its superset)
          'should detect GBK encoding for Chinese text in GBK',
          'gbk-detect.txt',
          GBK_BYTES,
          'gb18030',
        ],
        ['should return utf-8 for empty file', 'empty-detect.txt', '', 'utf-8'],
        [
          'should return utf-8 for non-existent file',
          'nonexistent-detect.txt',
          null,
          'utf-8',
        ],
      ])('%s', async (_title, name, data, expected) => {
        const filePath =
          data === null
            ? path.join(testDir, name)
            : await writeTestFile(name, data);
        expect(await detectFileEncoding(filePath)).toBe(expected);
      });
    });

    describe('isBinaryFile with BOM awareness', () => {
      it.each<[string, string, Buffer, boolean]>([
        [
          'should not treat UTF-8 BOM file as binary',
          'utf8-bom-test.txt',
          withBom(BOM.utf8, Buffer.from('Hello, world!', 'utf8')),
          false,
        ],
        [
          'should not treat UTF-16 LE BOM file as binary',
          'utf16le-bom-test.txt',
          withBom(BOM.utf16le, Buffer.from('Hello, world!', 'utf16le')),
          false,
        ],
        [
          'should not treat UTF-16 BE BOM file as binary',
          'utf16be-bom-test.txt',
          withBom(BOM.utf16be, utf16be('Hello, world!')),
          false,
        ],
        [
          'should not treat UTF-32 LE BOM file as binary',
          'utf32le-bom-test.txt',
          withBom(BOM.utf32le, utf32('Hello', true)),
          false,
        ],
        [
          'should not treat UTF-32 BE BOM file as binary',
          'utf32be-bom-test.txt',
          withBom(BOM.utf32be, utf32('Hello', false)),
          false,
        ],
        [
          // PNG header + an IHDR chunk with null bytes
          'should still treat actual binary file as binary',
          'test.png',
          Buffer.concat([
            PNG_SIGNATURE,
            Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
          ]),
          true,
        ],
        [
          'should treat file with null bytes (no BOM) as binary',
          'null-bytes.bin',
          Buffer.from([
            0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64,
          ]),
          true,
        ],
      ])('%s', async (_title, name, data, expected) => {
        const filePath = await writeTestFile(name, data);
        expect(await isBinaryFile(filePath)).toBe(expected);
      });
    });
  });

  describe('detectFileType', () => {
    let filePathForDetectTest: string;

    beforeEach(() => {
      filePathForDetectTest = path.join(tempRootDir, 'detectType.tmp');
      // Default: create as a text file for isBinaryFile fallback
      actualNodeFs.writeFileSync(filePathForDetectTest, 'Plain text content');
    });

    afterEach(() => {
      if (actualNodeFs.existsSync(filePathForDetectTest)) {
        actualNodeFs.unlinkSync(filePathForDetectTest);
      }
      vi.restoreAllMocks(); // Restore spies on actualNodeFs
    });

    // Mocks the next mime lookup, writes the file, classifies it, removes it.
    async function detectWritten(
      name: string,
      data: string | Buffer,
      mimeType: string | null,
    ) {
      mockMimeGetType.mockReturnValueOnce(mimeType);
      const filePath = writeTemp(name, data);
      try {
        return await detectFileType(filePath);
      } finally {
        actualNodeFs.unlinkSync(filePath);
      }
    }
    // Encrypted-volume sample: leading nulls and high bytes that trip
    // isBinaryFile (>30% non-printable and at least one null).
    const looksBinary = () =>
      Buffer.from(
        Array.from({ length: 64 }, (_, i) => (i % 4 === 0 ? 0 : 0xff)),
      );

    it('should detect typescript type by extension (ts, mts, cts, tsx)', async () => {
      expect(await detectFileType('file.ts')).toBe('text');
      expect(await detectFileType('file.test.ts')).toBe('text');
      expect(await detectFileType('file.mts')).toBe('text');
      expect(await detectFileType('vite.config.mts')).toBe('text');
      expect(await detectFileType('file.cts')).toBe('text');
      expect(await detectFileType('component.tsx')).toBe('text');
    });

    it.each<[string, string, string, string | Buffer]>([
      [
        'should detect image type by extension (png)',
        'image/png',
        'file.png',
        PNG_SIGNATURE,
      ],
      [
        'should keep empty image files classified as images',
        'image/png',
        'empty.png',
        '',
      ],
      [
        'should detect image type by extension (jpeg)',
        'image/jpeg',
        'file.jpg',
        Buffer.from([0xff, 0xd8, 0xff]),
      ],
      [
        'should detect a canonical image saved with a different image extension',
        'image/jpeg',
        'photo.jpg',
        PNG_SIGNATURE,
      ],
    ])('%s', async (_title, mimeType, name, data) => {
      expect(await detectWritten(name, data, mimeType)).toBe('image');
    });

    it('should preserve image classification when image sniffing cannot open the file', async () => {
      const imagePath = path.join(tempRootDir, 'unreadable.png');
      mockMimeGetType.mockReturnValueOnce('image/png');
      vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      expect(await detectFileType(imagePath)).toBe('image');
    });

    it('should detect svg type by extension', async () => {
      expect(await detectFileType('image.svg')).toBe('svg');
      expect(await detectFileType('image.icon.svg')).toBe('svg');
    });

    it.each<[string, string | null, string, string]>([
      [
        'should detect pdf type by extension',
        'application/pdf',
        'file.pdf',
        'pdf',
      ],
      [
        'should detect audio type by extension',
        'audio/mpeg',
        'song.mp3',
        'audio',
      ],
      [
        'should detect video type by extension',
        'video/mp4',
        'movie.mp4',
        'video',
      ],
      [
        // mime/lite's standard database has no .m4v entry, so the real lookup
        // returns null; the override map must still classify it as video
        // rather than letting it fall through to the binary content sampler.
        'should detect .m4v as video even though mime/lite omits video/x-m4v',
        null,
        'tutorial.m4v',
        'video',
      ],
      [
        'should detect known binary extensions as binary (e.g. .zip)',
        'application/zip',
        'archive.zip',
        'binary',
      ],
      [
        'should detect known binary extensions as binary (e.g. .exe)',
        'application/octet-stream', // Common for .exe
        'app.exe',
        'binary',
      ],
    ])('%s', async (_title, mimeType, fileName, expected) => {
      mockMimeGetType.mockReturnValueOnce(mimeType);
      expect(await detectFileType(fileName)).toBe(expected);
    });

    it.each([
      ['movie.mkv', 'video'],
      ['clip.avi', 'video'],
      ['song.flac', 'audio'],
      ['stream.aac', 'audio'],
    ] as const)(
      'should detect %s via the mime/lite override map as %s',
      async (fileName, expected) => {
        // Same mime/lite gap as .m4v: the standard database returns null for
        // these container extensions, so only the override map keeps a real
        // media file out of the binary content sampler.
        mockMimeGetType.mockReturnValueOnce(null);
        expect(await detectFileType(fileName)).toBe(expected);
      },
    );

    it('should use isBinaryFile for unknown extensions and detect as binary', async () => {
      mockMimeGetType.mockReturnValueOnce(false); // Unknown mime type
      // Create a file that isBinaryFile will identify as binary
      actualNodeFs.writeFileSync(
        filePathForDetectTest,
        Buffer.from([
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        ]),
      );
      expect(await detectFileType(filePathForDetectTest)).toBe('binary');
    });

    it('should detect .ipynb as notebook', async () => {
      expect(await detectFileType('analysis.ipynb')).toBe('notebook');
    });

    it('should default to text if mime type is unknown and content is not binary', async () => {
      mockMimeGetType.mockReturnValueOnce(false); // Unknown mime type
      // filePathForDetectTest is already a text file by default from beforeEach
      expect(await detectFileType(filePathForDetectTest)).toBe('text');
    });

    it('uses content detection for text-looking .dat files', async () => {
      const php = '<?php\nfunction handleRequest() {\n  return true;\n}\n';
      expect(await detectWritten('controller.dat', php, null)).toBe('text');
    });

    it('still treats binary-looking .dat files as binary', async () => {
      const data = Buffer.from([0x00, 0xff, 0x00]);
      expect(await detectWritten('payload.dat', data, null)).toBe('binary');
    });

    it('returns text for files with a text/* mime even when the content looks binary (issue #3964 encrypted FS)', async () => {
      // Frank-Shaw-FS reports `.cpp` / `.c` / `.h` source files on Windows
      // encrypted / DRM-protected file systems being misclassified as binary:
      // the OS surfaces encrypted bytes to `fs.open()` random-access reads, so
      // the 4 KB `isBinaryFile` heuristic sees nulls / non-printables. The
      // extension already declares a text mime, so trust it and skip the
      // content sample.
      expect(
        await detectWritten('encrypted.cpp', looksBinary(), 'text/x-c'),
      ).toBe('text');
    });

    it('returns text for application/javascript and similar text-like application mimes', async () => {
      mockMimeGetType.mockReturnValueOnce('application/javascript');
      expect(await detectFileType('script.js')).toBe('text');
      mockMimeGetType.mockReturnValueOnce('application/json');
      expect(await detectFileType('data.json')).toBe('text');
      mockMimeGetType.mockReturnValueOnce('application/toml');
      expect(await detectFileType('config.toml')).toBe('text');
    });

    it('returns text for +xml and +json structured-data mime suffixes', async () => {
      // Covers e.g. application/atom+xml, application/ld+json,
      // application/rls-services+xml (Rust's registered mime).
      mockMimeGetType.mockReturnValueOnce('application/rls-services+xml');
      expect(await detectFileType('lib.rs')).toBe('text');
      mockMimeGetType.mockReturnValueOnce('application/ld+json');
      expect(await detectFileType('schema.jsonld')).toBe('text');
    });

    it('returns text for known source-code extensions even when content looks binary (mime/lite gap)', async () => {
      // `mime/lite`'s registry omits most languages (`.py`, `.kt`, `.go`,
      // `.rb`, `.swift`, ... return null). Without a curated extension
      // override, an encrypted-volume read whose 4 KB sample looks binary
      // would misclassify these even though the extension is unambiguous.
      for (const ext of ['.py', '.kt', '.go', '.rb', '.swift']) {
        expect(
          await detectWritten(`encrypted${ext}`, looksBinary(), null),
        ).toBe('text');
      }
    });

    it('returns text for extensionless build/config basenames (Dockerfile, Makefile, go.mod, …)', async () => {
      // Build / config / lockfile conventions carry no extension (or only an
      // ambiguous one like .mod): `path.extname` returns `''`, so the
      // extension allowlist misses them, and an encrypted-volume read whose
      // 4 KB sample looks binary would misclassify these even though the
      // basename is unambiguously text.
      for (const basename of [
        'Dockerfile',
        'Makefile',
        'Jenkinsfile',
        'go.mod',
        'package-lock.json',
        '.gitignore',
        'LICENSE',
      ]) {
        expect(await detectWritten(basename, looksBinary(), null)).toBe('text');
      }
    });

    it('still classifies files in BINARY_EXTENSIONS as binary even with text-looking content', async () => {
      // The extension overrides win-list must not weaken the existing
      // binary-extension pre-empt: a `.png` whose first bytes happen to be
      // ASCII is still binary because the extension is in BINARY_EXTENSIONS.
      expect(
        await detectWritten('looksLikeText.png', 'PNGheader plain text', null),
      ).toBe('binary');
    });
  });

  describe('processSingleFileContent', () => {
    type MediaPart = { text?: string; inlineData?: { data: string } };
    const withConfig = (overrides: Record<string, unknown>) =>
      ({ ...mockConfig, ...overrides }) as unknown as Config;
    const withModalities = (modalities: Record<string, boolean>) =>
      withConfig({ getContentGeneratorConfig: () => ({ modalities }) });
    const noModalities = withModalities({});
    // Vision without native PDF input: PDFs take the pdftotext path.
    const imageOnly = withModalities({ image: true });
    const nativePdf = withModalities({ image: true, pdf: true });

    const read = (
      filePath: string,
      config: Config = mockConfig,
      options?: ProcessSingleFileContentOptions,
    ) => processSingleFileContent(filePath, config, options);
    const readText = (
      content: string,
      config?: Config,
      options?: ProcessSingleFileContentOptions,
    ) => {
      actualNodeFs.writeFileSync(testTextFilePath, content);
      return read(testTextFilePath, config, options);
    };
    // Writes a temp file behind a sticky mime lookup, then reads it.
    const readMedia = (
      name: string,
      data: string | Buffer,
      mimeType: string | null,
      config?: Config,
      options?: ProcessSingleFileContentOptions,
    ) => {
      const filePath = writeTemp(name, data);
      mockMimeGetType.mockReturnValue(mimeType);
      return read(filePath, config, options);
    };
    const readFakePng = (
      config?: Config,
      options?: ProcessSingleFileContentOptions,
    ) => readMedia('image.png', PNG_SIGNATURE, 'image/png', config, options);
    const writePng = (
      filePath: string,
      width: number,
      height: number,
      options?: PngOptions,
    ) =>
      sharp({ create: { width, height, channels: 3, background: '#306090' } })
        .png(options)
        .toFile(filePath);
    const expectInline = (
      result: ProcessedFileReadResult,
      bytes: string | Buffer,
      mimeType: string,
      displayName: string,
    ) =>
      expect(result.llmContent).toEqual({
        inlineData: {
          data: Buffer.from(bytes).toString('base64'),
          mimeType,
          displayName,
        },
      });
    const expectSkippedBinary = (
      result: ProcessedFileReadResult,
      name: string,
    ) => {
      expect(result.llmContent).toContain(
        'Cannot display content of binary file',
      );
      expect(result.returnDisplay).toContain(`Skipped binary file: ${name}`);
      expect(result.error).toBeUndefined();
    };

    beforeEach(() => {
      // Default: renderer unavailable, so PDF reads fall back to the text path
      // unless a test opts into rendering. Set after the global resetAllMocks.
      mockRender.mockResolvedValue({
        success: false,
        error: 'pdftoppm unavailable (test default)',
      });
      // Ensure files exist for statSync checks before readFile might be mocked
      for (const filePath of [
        testTextFilePath,
        testImageFilePath,
        testPdfFilePath,
        testBinaryFilePath,
      ]) {
        if (actualNodeFs.existsSync(filePath))
          actualNodeFs.unlinkSync(filePath);
      }
    });

    it.each([undefined, '1-2'])(
      'rejects sandbox PDF processing before invoking host helpers (pages=%s)',
      async (pages) => {
        actualNodeFs.writeFileSync(testPdfFilePath, '%PDF-1.4\n');
        const config = withConfig({
          getShellExecutionSandbox: () => ({
            workspace: tempRootDir,
            installation: '/installation',
            state: '/state',
            filesystem: 'workspace-write',
            network: 'closed',
          }),
        });
        const result = await read(testPdfFilePath, config, {
          fileType: 'pdf',
          pages,
        });
        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.error).toContain('sandboxed Shell');
        expect(execFile).not.toHaveBeenCalled();
        expect(mockRender).not.toHaveBeenCalled();
      },
    );

    it('should read a text file successfully', async () => {
      const content = 'Line 1\\nLine 2\\nLine 3';
      const result = await readText(content);
      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should handle file not found', async () => {
      const result = await read(nonexistentFilePath);
      expect(result.error).toContain('File not found');
      expect(result.returnDisplay).toContain('File not found');
    });

    it('should handle read errors for text files', async () => {
      const readError = new Error('Simulated read error');
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce(readError);

      // File must exist for the initial stat
      const result = await readText('content');
      expect(result.error).toContain('Simulated read error');
      expect(result.returnDisplay).toContain('Simulated read error');
    });

    it('should surface messages from plain object text read errors', async () => {
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce({
        code: -32603,
        message:
          'path escapes workspace: /root/.qwen/skills/dataworks-di-data-processor/instructions/interaction_norms.md',
        data: { errorKind: 'path_outside_workspace', status: 400 },
      });

      const result = await readText('content');

      expect(result.error).toContain('path escapes workspace');
      expect(result.returnDisplay).toContain('path escapes workspace');
      expect(result.error).not.toContain('[object Object]');
      expect(result.returnDisplay).not.toContain('[object Object]');
    });

    it('should surface messages from plain object notebook read errors', async () => {
      const notebookPath = writeTemp('analysis.ipynb', '{}');
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce({
        code: -32603,
        message: 'notebook is outside allowed roots',
        data: { errorKind: 'path_outside_workspace', status: 400 },
      });

      const result = await read(notebookPath);

      expect(result.error).toContain('notebook is outside allowed roots');
      expect(result.returnDisplay).toContain('Error reading notebook');
      expect(result.llmContent).toContain('notebook is outside allowed roots');
      expect(result.error).not.toContain('[object Object]');
      expect(result.llmContent).not.toContain('[object Object]');
    });

    it('should handle read errors for image/pdf files', async () => {
      const readError = new Error('Simulated image read error');
      vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(readError);

      const result = await readFakePng();
      expect(result.error).toContain('Simulated image read error');
      expect(result.returnDisplay).toContain('Simulated image read error');
    });

    it('honors an explicitly provided file type without re-detecting content', async () => {
      const result = await readMedia(
        'image.png',
        'plain text content',
        'image/png',
        mockConfig,
        { fileType: 'image' },
      );

      expect(result.llmContent).not.toBe('plain text content');
      expect(result.error).toBeUndefined();
    });

    it('omits provider-unsupported image formats instead of forwarding raw bytes (#9291)', async () => {
      // A MIME type the endpoint cannot safely consume (image/heic on
      // Responses-compatible routes) must not be forwarded verbatim: the
      // provider's 400 aborts the whole session. The read must stay in-band —
      // a text notice, no inline image, no error.
      const bytes = 'not decodable heic bytes';
      const result = await readMedia('photo.heic', bytes, 'image/heic');

      expect(result.error).toBeUndefined();
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('image/heic');
      expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
    });

    it.each([
      [
        'keeps provider-unsupported images inline for the vision bridge',
        'photo.heic',
        'heic bytes for bridge',
        'image/heic',
      ],
      [
        'keeps undecodable images inline for the vision bridge',
        'corrupt.png',
        'not a png',
        'image/png',
      ],
      [
        'keeps corrupt GIF bytes inline for the vision bridge',
        'broken.gif',
        'not a real gif',
        'image/gif',
      ],
    ])('%s', async (_title, name, bytes, mimeType) => {
      const result = await readMedia(name, bytes, mimeType, noModalities, {
        preserveUnsupportedImage: true,
      });
      expectInline(result, bytes, mimeType, name);
    });

    it('should process an image file', async () => {
      await writePng(testImageFilePath, 20, 10);
      mockMimeGetType.mockReturnValue('image/png');
      const result = await read(testImageFilePath);
      const parts = result.llmContent as Part[];
      expect(parts[0]).toEqual({
        // The shared stub declares tool_search and defers zoom_image, so the
        // hint takes the bridge form: review through tool_search, invoke
        // through tool_call.
        text:
          'Image overview: 20x10; oriented source: 20x10.' +
          ' If details are too small, review zoom_image with tool_search and' +
          ' invoke it through tool_call, with coordinates normalized from 0 to 1000.',
      });
      expect(parts[1]).toEqual({
        inlineData: {
          mimeType: 'image/jpeg',
          data: expect.any(String),
          displayName: 'image.png',
        },
      });
      const metadata = await sharp(
        Buffer.from(parts[1]!.inlineData!.data!, 'base64'),
      ).metadata();
      expect(metadata).toMatchObject({ width: 20, height: 10 });
      expect(result.returnDisplay).toContain('Read image file: image.png');
    });

    it.each<{
      codeModeOnly: boolean;
      declared: string[];
      deferred: string[];
      bindings: string[];
      hint: string;
    }>([
      {
        codeModeOnly: false,
        declared: ['read_file', 'tool_search'],
        deferred: [],
        bindings: [],
        hint: '',
      },
      {
        codeModeOnly: false,
        declared: ['read_file', 'tool_search'],
        deferred: ['zoom_image'],
        bindings: [],
        hint:
          ' If details are too small, review zoom_image with tool_search and' +
          ' invoke it through tool_call, with coordinates normalized from 0 to 1000.',
      },
      {
        codeModeOnly: false,
        declared: ['read_file', 'zoom_image'],
        deferred: [],
        bindings: [],
        hint: ' If details are too small, call zoom_image with coordinates normalized from 0 to 1000.',
      },
      {
        codeModeOnly: true,
        declared: ['exec'],
        deferred: [],
        bindings: [],
        hint: '',
      },
      {
        codeModeOnly: true,
        declared: ['exec'],
        deferred: [],
        bindings: ['zoom_image'],
        hint: ' If details are too small, call tools.zoom_image with coordinates normalized from 0 to 1000.',
      },
    ])(
      'uses only exposed tools for image guidance: $declared, code mode $codeModeOnly',
      async ({ codeModeOnly, declared, deferred, bindings, hint }) => {
        await writePng(testImageFilePath, 20, 10);
        mockMimeGetType.mockReturnValue('image/png');
        const result = await read(
          testImageFilePath,
          withConfig({
            getCodeModeOnly: () => codeModeOnly,
            getToolRegistry: () => ({
              getFunctionDeclarations: () => declared.map((name) => ({ name })),
              getDeferredToolSummary: () => deferred.map((name) => ({ name })),
              getCodeModeBindingPlan: () => ({
                bindings: bindings.map((name) => ({ name })),
                collisions: [],
              }),
            }),
          }),
        );
        const parts = result.llmContent as Part[];
        expect(parts[0]).toEqual({
          text: `Image overview: 20x10; oriented source: 20x10.${hint}`,
        });
        expect(parts[1].inlineData?.mimeType).toBe('image/jpeg');
      },
    );

    it('points the zoom hint at tools.zoom_image in CodeModeOnly', async () => {
      await writePng(testImageFilePath, 20, 10);
      mockMimeGetType.mockReturnValue('image/png');

      const result = await read(
        testImageFilePath,
        withConfig({ getCodeModeOnly: () => true }),
      );

      const parts = result.llmContent as Part[];
      expect(parts[0]).toEqual({
        text:
          'Image overview: 20x10; oriented source: 20x10. ' +
          'If details are too small, call tools.zoom_image with ' +
          'coordinates normalized from 0 to 1000.',
      });
    });

    it('returns a bounded overview when a PNG exceeds the old data URI limit', async () => {
      const largeImagePath = path.join(tempRootDir, 'large.png');
      await writePng(largeImagePath, 2200, 1800, { compressionLevel: 0 });
      expect(actualNodeFs.statSync(largeImagePath).size).toBeGreaterThan(
        9.9 * MB,
      );
      mockMimeGetType.mockReturnValue('image/png');

      const result = await read(largeImagePath);

      expect(result.error).toBeUndefined();
      const parts = result.llmContent as Part[];
      const overview = parts[1]!.inlineData!;
      const metadata = await sharp(
        Buffer.from(overview.data!, 'base64'),
      ).metadata();
      expect(overview.mimeType).toBe('image/jpeg');
      expect(Buffer.from(overview.data!, 'base64').length).toBeLessThanOrEqual(
        9 * MB,
      );
      expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(
        1568,
      );
      expect(
        Math.ceil(metadata.width! / 28) * Math.ceil(metadata.height! / 28),
      ).toBeLessThanOrEqual(1568);
    });

    it('rejects canonical image sources above 100 MB before decoding', async () => {
      const oversizedPath = path.join(tempRootDir, 'oversized.png');
      const handle = await fsPromises.open(oversizedPath, 'w');
      await handle.truncate(100 * MB + 1);
      await handle.close();
      mockMimeGetType.mockReturnValue('image/png');

      const result = await read(oversizedPath);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain('100 MB source limit');
    });

    it('reads text-looking corrupt canonical image content as text', async () => {
      const text = 'not a real png';
      const result = await readMedia('corrupt.png', text, 'image/png');

      expect(result.llmContent).toBe(text);
      expect(result.error).toBeUndefined();
    });

    it('forwards an animated canonical image verbatim instead of failing the read', async () => {
      const animatedPath = path.join(tempRootDir, 'animated.webp');
      await sharp(TWO_FRAME_GIF, { animated: true })
        .webp()
        .toFile(animatedPath);
      mockMimeGetType.mockReturnValue('image/webp');

      const result = await read(animatedPath);

      const onDisk = await fsPromises.readFile(animatedPath);
      expect(result.error).toBeUndefined();
      expectInline(result, onDisk, 'image/webp', 'animated.webp');
      expect(result.returnDisplay).toContain('Read image file: animated.webp');
    });

    it.each<[string, string, string | Buffer]>([
      [
        'omits non-canonical content behind a canonical extension (#9291)',
        'mismatch.png',
        TWO_FRAME_GIF,
      ],
      [
        'rejects unrecognized binary content behind an image extension',
        'garbage.png',
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
      ],
      [
        'rejects two-byte content behind an image extension as binary',
        'tiny.png',
        'hi',
      ],
    ])('%s', async (_title, name, data) => {
      expectSkippedBinary(await readMedia(name, data, 'image/png'), name);
    });

    it('rejects ZIP containers behind an image extension', async () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const result = await readMedia('archive.png', zip, 'image/png');

      expectSkippedBinary(result, 'archive.png');
      expect(typeof result.llmContent).toBe('string');
      expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
    });

    const imageExtensions = [
      { extension: 'png', mimeType: 'image/png' },
      { extension: 'jpg', mimeType: 'image/jpeg' },
      { extension: 'gif', mimeType: 'image/gif' },
      { extension: 'webp', mimeType: 'image/webp' },
    ];

    it.each(imageExtensions)(
      'reads text content behind a .$extension extension as text',
      async ({ extension, mimeType }) => {
        const json = '{"meta":{"format":"png"},"data":"not-a-real-image"}';
        const name = `screenshot.${extension}`;
        const result = await readMedia(name, json, mimeType);

        expect(result.llmContent).toBe(json);
        expect(result.returnDisplay).toBe('');
        expect(result.error).toBeUndefined();
      },
    );

    it.each(imageExtensions)(
      'reads BOM-prefixed UTF-16 text behind a .$extension extension as text',
      async ({ extension, mimeType }) => {
        const text = 'text saved with the wrong extension';
        const result = await readMedia(
          `notes.${extension}`,
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(text, 'utf16le'),
          ]),
          mimeType,
        );

        expect(result.llmContent).toBe(text);
        expect(result.returnDisplay).toBe('');
        expect(result.error).toBeUndefined();
      },
    );

    it('applies EXIF orientation before describing and rendering an overview', async () => {
      const orientedPath = path.join(tempRootDir, 'oriented.jpg');
      await sharp({
        create: { width: 60, height: 40, channels: 3, background: '#306090' },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(orientedPath);
      mockMimeGetType.mockReturnValue('image/jpeg');

      const result = await read(orientedPath);
      const parts = result.llmContent as Part[];
      const metadata = await sharp(
        Buffer.from(parts[1]!.inlineData!.data!, 'base64'),
      ).metadata();

      expect(parts[0]?.text).toContain('oriented source: 40x60');
      expect(metadata).toMatchObject({ width: 40, height: 60 });
    });

    it('flattens transparent overview pixels onto white', async () => {
      const transparentPath = path.join(tempRootDir, 'transparent.webp');
      await sharp({
        create: {
          width: 20,
          height: 20,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .webp()
        .toFile(transparentPath);
      mockMimeGetType.mockReturnValue('image/webp');

      const result = await read(transparentPath);
      const parts = result.llmContent as Part[];
      const { data, info } = await sharp(
        Buffer.from(parts[1]!.inlineData!.data!, 'base64'),
      )
        .raw()
        .toBuffer({ resolveWithObject: true });
      const center =
        (Math.floor(info.height / 2) * info.width +
          Math.floor(info.width / 2)) *
        info.channels;

      expect(Array.from(data.subarray(center, center + 3))).toEqual([
        255, 255, 255,
      ]);
    });

    it('keeps animated GIF image bytes unchanged', async () => {
      // A real, decodable GIF: forwarded verbatim (never re-encoded).
      const result = await readMedia(
        'animation.gif',
        TWO_FRAME_GIF,
        'image/gif',
      );
      expectInline(result, TWO_FRAME_GIF, 'image/gif', 'animation.gif');
    });

    it('omits a corrupt GIF instead of forwarding undecodable bytes (#9291)', async () => {
      const gif = 'not a real gif';
      const result = await readMedia('broken.gif', gif, 'image/gif');

      expect(result.error).toBeUndefined();
      expect(typeof result.llmContent).toBe('string');
      expect(JSON.stringify(result.llmContent)).not.toContain('inlineData');
    });

    it('omits BMP image bytes the provider cannot safely consume (#9291)', async () => {
      const bytes = 'unchanged image bytes';
      const result = await readMedia('bitmap.bmp', bytes, 'image/bmp');

      expect(result.error).toBeUndefined();
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('image/bmp');
    });

    it('should reject image files when model does not support image', async () => {
      const result = await readFakePng(noModalities);
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('Unsupported image file');
      expect(result.llmContent).toContain('does not support image input');
      expect(result.returnDisplay).toContain('Skipped image file');
    });

    describe('omni delivery gating', () => {
      // Exercises the omni-vs-legacy decision in processSingleFileContent:
      // enablement gate → delivery-active gate → content pre-sniff → per-
      // modality config. The pipeline itself is mocked (index.test.ts owns
      // it); what is pinned here is WHICH path a file takes.
      function omniConfig(overrides: Record<string, unknown> = {}): Config {
        return withConfig({
          isOmniEnabled: () => true,
          loadOmniMediaReader: () => import('../omni/index.js'),
          getContentGeneratorConfig: () => ({
            modalities: { image: true, audio: true, video: true },
          }),
          ...overrides,
        });
      }
      const readClip = (bytes: string, config = omniConfig()) =>
        readMedia('clip.mp4', bytes, 'video/mp4', config);

      beforeEach(() => {
        omniGateMocks.isOmniDeliveryActive.mockReturnValue(true);
        omniGateMocks.readMediaViaOmniDelivery.mockResolvedValue({
          llmContent: {
            fileData: { fileUri: 'oss://bucket/key', mimeType: 'video/mp4' },
          },
          returnDisplay: 'Delivered via omni upload.',
        });
      });

      it('routes a sniff-confirmed video through readMediaViaOmniDelivery', async () => {
        omniGateMocks.sniffFileModality.mockResolvedValue('video');

        const result = await readClip('fake mp4');

        expect(omniGateMocks.readMediaViaOmniDelivery).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: path.join(tempRootDir, 'clip.mp4'),
            expectedModality: 'video',
          }),
        );
        expect(result.returnDisplay).toBe('Delivered via omni upload.');
      });

      it('falls back to the legacy inline path when the sniff disagrees with the extension', async () => {
        // A file whose bytes sniff as a DIFFERENT modality than its
        // extension suggests must take the legacy path (inline under its
        // extension-derived type), not the fail-closed pipeline.
        omniGateMocks.sniffFileModality.mockResolvedValue(null);

        const result = await readClip('small bytes');

        expect(omniGateMocks.readMediaViaOmniDelivery).not.toHaveBeenCalled();
        const content = result.llmContent as Part;
        expect(content.inlineData?.mimeType).toBe('video/mp4');
      });

      it('never sniffs or delivers when the modality is disabled in config', async () => {
        const result = await readClip(
          'fake mp4',
          omniConfig({
            getContentGeneratorConfig: () => ({
              modalities: { video: false },
            }),
          }),
        );

        expect(omniGateMocks.sniffFileModality).not.toHaveBeenCalled();
        expect(omniGateMocks.readMediaViaOmniDelivery).not.toHaveBeenCalled();
        expect(result.returnDisplay).toContain('Skipped video file');
      });

      it('takes the legacy path when omni delivery is not active for the endpoint', async () => {
        omniGateMocks.isOmniDeliveryActive.mockReturnValue(false);

        const result = await readClip('small bytes');

        expect(omniGateMocks.readMediaViaOmniDelivery).not.toHaveBeenCalled();
        const content = result.llmContent as Part;
        expect(content.inlineData?.mimeType).toBe('video/mp4');
      });

      it('bypasses the 100 MB image source cap when omni takes the file', async () => {
        // The cap protects the overview DECODER; the omni path uploads
        // original bytes without decoding and enforces its own ceiling, so
        // an over-cap image must delegate to omni delivery instead of being
        // rejected. Sparse file: only the stat size matters — the mocked
        // pipeline never reads the bytes.
        const imagePath = writeTemp('huge.png', Buffer.alloc(0));
        actualNodeFs.truncateSync(imagePath, 101 * MB);
        mockMimeGetType.mockReturnValue('image/png');
        omniGateMocks.sniffFileModality.mockResolvedValue('image');
        omniGateMocks.readMediaViaOmniDelivery.mockResolvedValue({
          llmContent: {
            fileData: { fileUri: 'oss://bucket/key', mimeType: 'image/png' },
          },
          returnDisplay: 'Delivered via omni upload.',
        });

        const result = await read(imagePath, omniConfig());

        expect(result.error).toBeUndefined();
        expect(result.returnDisplay).toBe('Delivered via omni upload.');
        expect(omniGateMocks.readMediaViaOmniDelivery).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: imagePath,
            expectedModality: 'image',
          }),
        );
      });
    });

    it('keeps image inline when preserveUnsupportedImage is true', async () => {
      await writePng(testImageFilePath, 8, 8);
      mockMimeGetType.mockReturnValue('image/png');

      const result = await read(testImageFilePath, noModalities, {
        preserveUnsupportedImage: true,
      });
      expect(typeof result.llmContent).toBe('object');
      const parts = result.llmContent as Part[];
      expect(parts[0]?.text).toContain('Image overview');
      expect(parts[1]?.inlineData).toMatchObject({
        mimeType: 'image/jpeg',
        data: expect.any(String),
        displayName: 'image.png',
      });
      expect(result.returnDisplay).toContain('Read image file');
    });

    it('still strips image for agent reads without the preserve flag', async () => {
      // No preserve flag (default false) — agent tool read / headless path.
      const result = await readFakePng(noModalities);
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('does not support image input');
    });

    it('still strips audio when preserveUnsupportedImage is true', async () => {
      const result = await readMedia(
        'clip.mp3',
        'fake audio data',
        'audio/mpeg',
        noModalities,
        { preserveUnsupportedImage: true },
      );
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('does not support audio input');
    });

    it('keeps supported audio bytes unchanged', async () => {
      const audioBytes = 'fake audio data';
      const result = await readMedia(
        'clip.mp3',
        audioBytes,
        'audio/mpeg',
        withModalities({ image: true, audio: true, video: true }),
      );

      expectInline(result, audioBytes, 'audio/mpeg', 'clip.mp3');
    });

    // Regression guards for the /learn local-video path: mime/lite has no
    // .m4v / .mkv entry, so without the detectFileType override map these
    // fell through to the content sampler (misclassified as binary: "Cannot
    // display content of binary file" instead of an inlineData Part) or the
    // binary/size-cap path instead of the media pipeline.
    it.each([
      [
        'processes an .m4v video as inline data despite the mime/lite gap',
        'tutorial.m4v',
        'fake m4v data',
        'video/x-m4v',
      ],
      [
        'processes an .mkv video as inline data despite the mime/lite gap',
        'movie.mkv',
        'fake mkv data',
        'video/x-matroska',
      ],
    ])('%s', async (_title, name, fakeVideo, mimeType) => {
      const result = await readMedia(name, fakeVideo, null);
      const inline = (
        result.llmContent as { inlineData: { data: string; mimeType: string } }
      ).inlineData;

      expect(typeof result.llmContent).toBe('object');
      expect(inline.data).toBe(Buffer.from(fakeVideo).toString('base64'));
      expect(inline.mimeType).toBe(mimeType);
      expect(result.returnDisplay).toContain('Read video file');
    });

    const PDF_BYTES = Buffer.from('%PDF-1.7');
    const FAKE_PDF = Buffer.from('fake pdf data');
    const LARGE_PDF = Buffer.alloc(2 * MB);
    const REFERENCE = { largePdfBehavior: 'reference' } as const;
    // The tiny FAKE_PDF behind a faked stat size.
    const fakePdf = (statSize: number) => ({ data: FAKE_PDF, statSize });
    const fakeStat = (size: number, isFile = true) =>
      vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size,
        isDirectory: () => false,
        isFile: () => isFile,
      } as fs.Stats);
    type PdfRead = ProcessSingleFileContentOptions & {
      config?: Config;
      data?: Buffer;
      statSize?: number;
    };
    // Writes the test PDF, queues the exec results in call order and reads it
    // (by default as a vision model without native PDF input); `statSize`
    // fakes the stat size for this read only.
    async function readPdf(
      {
        config = imageOnly,
        data = PDF_BYTES,
        statSize,
        ...options
      }: PdfRead = {},
      ...execs: ExecResult[]
    ) {
      actualNodeFs.writeFileSync(testPdfFilePath, data);
      mockMimeGetType.mockReturnValue('application/pdf');
      for (const exec of execs) mockExecResult(exec);
      const statSpy = statSize === undefined ? undefined : fakeStat(statSize);
      try {
        return await read(testPdfFilePath, config, options);
      } finally {
        statSpy?.mockRestore();
      }
    }
    const renderPages = (pages: string[], bytesTruncated = false) =>
      mockRender.mockResolvedValue({
        success: true,
        images: pages.map((data) => ({ data, mimeType: 'image/jpeg' })),
        bytesTruncated,
      });
    const expectRendered = (firstPage: number, lastPage: number) =>
      expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
        firstPage,
        lastPage,
      });
    const hasText = (parts: MediaPart[], pattern: RegExp) =>
      parts.some((p) => typeof p.text === 'string' && pattern.test(p.text));

    it('should fall back to pdftotext when model does not support PDF', async () => {
      const result = await readPdf({ data: FAKE_PDF });
      expect(typeof result.llmContent).toBe('string');
      // When pdftotext is not installed, should return a helpful error
      // rather than silently skipping
      expect(result.llmContent).toContain('Cannot extract text from PDF');
      expect(result.returnDisplay).toContain('Failed to read pdf');
    });

    it.each<[string, Buffer, ExecResult, string]>([
      [
        'rejects large full-PDF text fallback before extracting text',
        LARGE_PDF,
        pdfinfo(42),
        "Use the 'pages' parameter",
      ],
      [
        'rejects compact PDFs when pdfinfo reports too many pages',
        Buffer.alloc(64 * 1024),
        pdfinfo(42),
        'has 42 pages',
      ],
      [
        'uses size-heuristic page guidance when pdfinfo is unavailable',
        LARGE_PDF,
        NO_PDFINFO,
        'appears to have about 21 pages',
      ],
    ])('%s', async (_title, data, info, guidance) => {
      const result = await readPdf({ data }, info, PDFTOTEXT);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain(guidance);
      expect(result.returnDisplay).toContain('PDF requires page range');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
      expect(mockExecFile.mock.calls[1]![0]).toBe('pdftotext');
    });

    it('surfaces missing pdftotext before page-range guidance', async () => {
      const result = await readPdf({ data: LARGE_PDF }, pdfinfo(42));

      expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
      expect(result.llmContent).toContain('pdftotext is not installed');
      expect(result.llmContent).not.toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Failed to read pdf');
      expect(result.stats).toBeDefined();
    });

    it('returns a reference instead of an error for large @-attached PDFs', async () => {
      const result = await readPdf(
        { ...REFERENCE, data: LARGE_PDF },
        pdfinfo(42),
        PDFTOTEXT,
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.stats).toBeDefined();
    });

    it('returns a reference for large @-attached PDFs when pdftotext is unavailable', async () => {
      const result = await readPdf(
        { ...REFERENCE, data: LARGE_PDF },
        pdfinfo(42),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.stats).toBeDefined();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
    });

    it('keeps explicit pages reads on the pdftotext path', async () => {
      const result = await readPdf(
        { pages: '1', data: LARGE_PDF },
        PDFTOTEXT,
        execOk('page one text'),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBe('page one text');
      expect(
        mockExecFile.mock.calls.some((call) => call[0] === 'pdftotext'),
      ).toBe(true);
    });

    it.each([
      ['abc', 'Invalid pages parameter'],
      ['1-', 'Open-ended page ranges'],
      ['1-21', 'Pages range exceeds maximum of 20'],
    ])(
      'rejects unsafe internal pages value %s before extracting text',
      async (pages, expectedMessage) => {
        const result = await readPdf({ pages });

        expect(result.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
        expect(result.llmContent).toContain(expectedMessage);
        expect(mockExecFile).not.toHaveBeenCalled();
      },
    );

    it('rejects overly dense page-range extraction with a short error', async () => {
      const result = await readPdf({ pages: '1' }, PDFTOTEXT, DENSE);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.llmContent).toContain('too large to return safely');
      expect(result.llmContent).toContain('selected page exceeds');
    });

    it('rejects dense non-ASCII PDF extraction with a short error', async () => {
      const cjk = execOk('一'.repeat(11_000));
      const result = await readPdf({ pages: '1' }, PDFTOTEXT, cjk);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.llmContent).toContain('too large to return safely');
    });

    it('rejects dense no-pages PDF extraction after exact page count allows full reads', async () => {
      const result = await readPdf({}, pdfinfo(2), PDFTOTEXT, DENSE);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.returnDisplay).toContain('PDF text too large');
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(
        mockExecFile.mock.calls.some((call) => call[0] === 'pdfinfo'),
      ).toBe(true);
    });

    it('references dense no-pages PDFs for @ attachments', async () => {
      const result = await readPdf(REFERENCE, pdfinfo(2), PDFTOTEXT, DENSE);

      expect(result.error).toBeUndefined();
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.llmContent).toContain('too large to return safely');
    });

    it('rejects dense page-range PDF extraction for @ attachments', async () => {
      const options = { ...REFERENCE, pages: '1-5' };
      const result = await readPdf(options, PDFTOTEXT, DENSE);

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.returnDisplay).toContain('PDF text too large');
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.stats).toBeDefined();
    });

    it('allows full PDF text extraction at the full-text size cap', async () => {
      const result = await readPdf(
        { statSize: 100 * MB },
        pdfinfo(2),
        PDFTOTEXT,
        execOk('full text at cap'),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBe('full text at cap');
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });

    it('rejects huge no-pages PDFs before returning page guidance', async () => {
      const result = await readPdf({ ...REFERENCE, statSize: 200 * MB });

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.returnDisplay).toContain('PDF file too large');
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.llmContent).toContain('split the document');
      expect(result.stats).toBeDefined();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should skip the 10MB size gate when extracting PDF text by pages', async () => {
      // The faked >10MB stat would trip the upstream size gate if it still ran;
      // pdftotext streams oversized PDFs and its output is capped downstream.
      const result = await readPdf({ ...fakePdf(15 * MB), pages: '1-5' });

      // Must not be rejected by the generic 10MB gate.
      expect(result.error ?? '').not.toContain('10MB limit');
      expect(result.llmContent).not.toMatch(/exceeds the 10MB limit/i);
      // Routed into the pdftotext path — either success or the
      // install-guidance error, never "File size exceeds the 10MB limit".
      expect(result.returnDisplay ?? '').toMatch(/pdf/i);
    });

    it('allows explicit page ranges at the paged text-extraction size cap', async () => {
      const result = await readPdf(
        { ...fakePdf(512 * MB), pages: '1-5' },
        PDFTOTEXT,
        execOk('paged text at cap'),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBe('paged text at cap');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('rejects explicit page ranges above the paged text-extraction size cap', async () => {
      const result = await readPdf({ ...fakePdf(600 * MB), pages: '1-5' });

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain('page-range text extraction');
      expect(result.stats).toBeDefined();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should still reject oversized PDFs when routing to the native base64 path', async () => {
      // When the model supports PDF modality and no pages arg is provided,
      // the base64 path applies and the 10MB inline-data cap still matters.
      const result = await readPdf({ ...fakePdf(15 * MB), config: nativePdf });

      expect(result.error).toContain('10MB limit');
    });

    it('should accept PDF files when model supports PDF', async () => {
      const result = await readPdf({ config: nativePdf, data: FAKE_PDF });
      expect(result.llmContent).toHaveProperty('inlineData');
      expect(
        (result.llmContent as { inlineData: { mimeType: string } }).inlineData
          .mimeType,
      ).toBe('application/pdf');
      expect(result.returnDisplay).toContain('Read pdf file');
    });

    describe('PDF image rendering (vision fallback)', () => {
      it('renders the requested page range when text overflows', async () => {
        renderPages(['AAA', 'BBB']);

        const result = await readPdf({ pages: '1-2' }, PDFTOTEXT, DENSE);

        expect(result.error).toBeUndefined();
        expect(Array.isArray(result.llmContent)).toBe(true);
        const parts = result.llmContent as MediaPart[];
        expect(parts).toHaveLength(2);
        expect(parts[0]!.inlineData).toMatchObject({
          data: 'AAA',
          mimeType: 'image/jpeg',
        });
        expect(result.returnDisplay).toContain('image');
        expectRendered(1, 2);
      });

      it('renders the whole document (up to the ceiling) for a no-pages overflow', async () => {
        renderPages(['P1', 'P2', 'P3']);

        const result = await readPdf({}, pdfinfo(3), PDFTOTEXT, DENSE);

        expect(Array.isArray(result.llmContent)).toBe(true);
        expect(result.llmContent).toHaveLength(3);
        expectRendered(1, PDF_MAX_PAGES_PER_READ);
      });

      it('renders images when extraction fails on a scanned PDF', async () => {
        renderPages(['S1', 'S2']);

        const result = await readPdf({}, pdfinfo(2), PDFTOTEXT, BLANK);

        expect(Array.isArray(result.llmContent)).toBe(true);
        expect(result.llmContent).toHaveLength(2);
      });

      it('still returns page guidance (no render) beyond the page ceiling', async () => {
        const result = await readPdf({}, pdfinfo(42), PDFTOTEXT);

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain("Use the 'pages' parameter");
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('flags truncation (never drops pages silently)', async () => {
        renderPages(['ONLY'], true);

        const result = await readPdf({ pages: '1-5' }, PDFTOTEXT, DENSE);

        expect(hasText(result.llmContent as MediaPart[], /omitted/)).toBe(true);
      });

      it('notes the page ceiling when a no-pages render fills it (page count unknown)', async () => {
        // pdfinfo unavailable -> page count falls back to the size heuristic,
        // which underestimates; the render then fills the 20-page ceiling.
        renderPages(
          Array.from({ length: PDF_MAX_PAGES_PER_READ }, (_, i) => `P${i + 1}`),
        );

        const result = await readPdf({}, NO_PDFINFO, PDFTOTEXT, DENSE);

        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(
          PDF_MAX_PAGES_PER_READ,
        );
        expect(hasText(parts, /per-read maximum/)).toBe(true);
      });

      it('falls back to text guidance when the renderer is unavailable', async () => {
        // mockRender default = failure (renderer unavailable).
        const result = await readPdf({ pages: '1' }, PDFTOTEXT, DENSE);

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain('too large to return safely');
      });

      it('falls back to text guidance when rendering returns no page images', async () => {
        renderPages([]);

        const result = await readPdf({ pages: '1' }, PDFTOTEXT, DENSE);

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain('too large to return safely');
        expect(Array.isArray(result.llmContent)).toBe(false);
        expectRendered(1, 1);
      });
    });

    describe('PDF vision-bridge rendering (text-only model)', () => {
      // An @-attachment read, and an explicit-range read preparing a bridge
      // candidate, both on a text-only model.
      const readAt = (...execs: ExecResult[]) =>
        readPdf(
          {
            config: noModalities,
            preserveUnsupportedImage: true,
            ...REFERENCE,
          },
          ...execs,
        );
      const readBridge = (
        pages: string,
        config: Config,
        ...execs: ExecResult[]
      ) =>
        readPdf({ config, pages, preparePdfForVisionBridge: true }, ...execs);
      const bridge = (pages: string, ...execs: ExecResult[]) =>
        readBridge(pages, noModalities, ...execs);

      it('renders up to VISION_BRIDGE_MAX_IMAGES pages for a scanned @ PDF', async () => {
        renderPages(['B1', 'B2']);

        const result = await readAt(pdfinfo(2), PDFTOTEXT, BLANK, pdfinfo(2));

        expect(Array.isArray(result.llmContent)).toBe(true);
        expectRendered(1, 2);
        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(2);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('notes how many pages were rendered when more remain', async () => {
        renderPages(['1', '2', '3', '4']);

        const result = await readAt(pdfinfo(10), PDFTOTEXT, BLANK, pdfinfo(10));

        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(4);
        expect(hasText(parts, /pages 5-10 were not included/)).toBe(true);
      });

      it('notes truncation when the render fills the cap and the page count is unknown', async () => {
        renderPages(
          Array.from(
            { length: VISION_BRIDGE_MAX_IMAGES },
            (_, i) => `B${i + 1}`,
          ),
        );

        // pdfinfo unavailable on both the pre-gate probe and the note probe.
        const result = await readAt(NO_PDFINFO, PDFTOTEXT, BLANK, NO_PDFINFO);

        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(
          VISION_BRIDGE_MAX_IMAGES,
        );
        // No exact count is known, so no "of N", but truncation is still noted.
        const note = parts.find(
          (p) =>
            typeof p.text === 'string' && /later pages may remain/.test(p.text),
        );
        expect(note).toBeDefined();
        expect(note!.text).not.toMatch(/pages \d+-\d+ were not included/);
      });

      it('renders from the requested start page and records the remaining range', async () => {
        renderPages(['20', '21', '22', '23']);

        const result = await bridge('20-25', PDFTOTEXT, BLANK, pdfinfo(25));

        expectRendered(20, 23);
        const parts = result.llmContent as Part[];
        expect(
          parts
            .filter((part) => part.inlineData)
            .map((part) => part.inlineData?.displayName),
        ).toEqual([
          'document.pdf (page 20)',
          'document.pdf (page 21)',
          'document.pdf (page 22)',
          'document.pdf (page 23)',
        ]);
        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          reason: 'text_extraction_failed',
          renderedRange: { firstPage: 20, lastPage: 23 },
          continuation: { certainty: 'known', firstPage: 24, lastPage: 25 },
        });
      });

      it('clips an explicit range to the actual PDF and does not invent remaining pages', async () => {
        renderPages(['4', '5', '6']);

        const result = await bridge('4-8', PDFTOTEXT, BLANK, pdfinfo(6));

        expectRendered(4, 6);
        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          renderedRange: { firstPage: 4, lastPage: 6 },
        });
        expect(result.pdfVisionBridgeCandidate?.continuation).toBeUndefined();
        expect(JSON.stringify(result.llmContent)).not.toContain('pages 7-8');
      });

      it('treats a short render as EOF when the PDF page count is unavailable', async () => {
        renderPages(['4', '5', '6']);

        const result = await bridge('4-8', PDFTOTEXT, BLANK, NO_PDFINFO);

        expectRendered(4, 7);
        expect(result.pdfVisionBridgeCandidate?.continuation).toBeUndefined();
        expect(JSON.stringify(result.llmContent)).not.toContain('pages 7-8');
      });

      it('marks continuation as possible when an unknown PDF fills the render cap', async () => {
        renderPages(['20', '21', '22', '23']);

        const result = await bridge('20-25', PDFTOTEXT, BLANK, NO_PDFINFO);

        expect(result.pdfVisionBridgeCandidate?.continuation).toEqual({
          certainty: 'possible',
          firstPage: 24,
          requestedLastPage: 25,
        });
        expect(JSON.stringify(result.llmContent)).toContain(
          'additional requested pages may exist from page 24 through page 25',
        );
      });

      it('does not render when an explicit range starts past the PDF end', async () => {
        const result = await bridge('20-25', PDFTOTEXT, BLANK, pdfinfo(6));

        expect(mockRender).not.toHaveBeenCalled();
        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('prepares a candidate when an explicit single page still overflows', async () => {
        renderPages(['20']);

        const result = await bridge('20', PDFTOTEXT, DENSE, pdfinfo(25));

        expectRendered(20, 20);
        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          reason: 'single_page_text_overflow',
          renderedRange: { firstPage: 20, lastPage: 20 },
          fallback: { errorType: ToolErrorType.FILE_TOO_LARGE },
        });
      });

      it('renders an actual one-page @ PDF when its text overflows', async () => {
        renderPages(['1']);

        const result = await readAt(pdfinfo(1), PDFTOTEXT, DENSE);

        expect(result.error).toBeUndefined();
        expect(
          (result.llmContent as MediaPart[]).filter((part) => part.inlineData),
        ).toHaveLength(1);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('records unrendered requested pages when the byte budget truncates images', async () => {
        renderPages(['20', '21'], true);

        const result = await bridge('20-25', PDFTOTEXT, BLANK, pdfinfo(25));

        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          renderedRange: { firstPage: 20, lastPage: 21 },
          continuation: { certainty: 'known', firstPage: 22, lastPage: 25 },
        });
        expect(JSON.stringify(result.llmContent)).toContain(
          'pages 22-25 were not included',
        );
      });

      it.each([
        [
          'does not render when a multi-page text result overflows',
          '20-25',
          noModalities,
        ],
        [
          'does not bridge explicit page overflow for a native PDF model',
          '20',
          withModalities({ pdf: true }),
        ],
      ])('%s', async (_title, pages, config) => {
        const result = await readBridge(pages, config, PDFTOTEXT, DENSE);

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
        expect(mockRender).not.toHaveBeenCalled();
      });

      it.each([
        [
          'restores the extraction failure when bridge rendering fails',
          () =>
            mockRender.mockResolvedValue({
              success: false,
              error: 'renderer unavailable',
            }),
        ],
        [
          'restores the extraction failure when rendering returns no page images',
          () => renderPages([]),
        ],
      ])('%s', async (_title, setupRender) => {
        setupRender();

        const result = await bridge('20-25', PDFTOTEXT, BLANK, pdfinfo(25));

        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('keeps text-heavy @ PDFs as reference (text-first, no render)', async () => {
        const result = await readAt(pdfinfo(2), PDFTOTEXT, DENSE);

        expect(result.error).toBeUndefined();
        expect(result.returnDisplay).toContain('Referenced large PDF');
        expect(result.llmContent).toContain('too large to return safely');
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('does not render without the bridge flag (scanned stays an error)', async () => {
        const options = { config: noModalities };
        const result = await readPdf(options, pdfinfo(2), PDFTOTEXT, BLANK);

        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('does not preserve ordinary images with the PDF-only bridge flag', async () => {
        const result = await readFakePng(noModalities, {
          preparePdfForVisionBridge: true,
        });

        expect(result.llmContent).toContain('Unsupported image file');
        expect(Array.isArray(result.llmContent)).toBe(false);
      });
    });

    it('should read an SVG file as text when under 1MB', async () => {
      const svgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect width="100" height="100" fill="blue" />
    </svg>
  `;
      const result = await readMedia('test.svg', svgContent, 'image/svg+xml');

      expect(result.llmContent).toBe(svgContent);
      expect(result.returnDisplay).toContain('Read SVG as text');
    });

    it('should skip binary files', async () => {
      actualNodeFs.writeFileSync(
        testBinaryFilePath,
        Buffer.from([0x00, 0x01, 0x02]),
      );
      mockMimeGetType.mockReturnValueOnce('application/octet-stream');
      // isBinaryFile will operate on the real file.

      const result = await read(testBinaryFilePath);
      expect(result.llmContent).toContain(
        'Cannot display content of binary file',
      );
      expect(result.returnDisplay).toContain('Skipped binary file: app.exe');
    });

    it('should read text-looking .dat files as text', async () => {
      const content = '<?php echo "ok";\n';
      const filePath = writeTemp('legacy-controller.dat', content);
      mockMimeGetType.mockReturnValueOnce(null);

      const result = await read(filePath);

      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should handle path being a directory', async () => {
      const result = await read(directoryPath);
      expect(result.error).toContain('Path is a directory');
      expect(result.returnDisplay).toContain('Path is a directory');
    });

    const fsRead = (
      content: string,
      request: { line?: number; maxOutputBytes?: number } = {},
    ) => {
      actualNodeFs.writeFileSync(testTextFilePath, content);
      return fsService.readTextFile({ path: testTextFilePath, ...request });
    };
    const numberedLines = (count: number) =>
      Array.from({ length: count }, (_, i) => `Line ${i + 1}`);

    it('should paginate text files correctly (offset and limit)', async () => {
      const lines = numberedLines(20);
      const result = await readText(lines.join('\n'), mockConfig, {
        offset: 5,
        limit: 5,
      }); // Read lines 6-10

      expect(result.llmContent).toBe(lines.slice(5, 10).join('\n'));
      expect(result.returnDisplay).toBe('Read lines 6-10 of 20 from test.txt');
      expect(result.isTruncated).toBe(true);
      expect(result.originalLineCount).toBe(20);
      expect(result.linesShown).toEqual([6, 10]);
    });

    it('should preserve legacy positional pagination arguments', async () => {
      const lines = numberedLines(20);
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        5,
        5,
      );

      expect(result.llmContent).toBe(lines.slice(5, 10).join('\n'));
      expect(result.returnDisplay).toBe('Read lines 6-10 of 20 from test.txt');
      expect(result.linesShown).toEqual([6, 10]);
    });

    it('should identify truncation when reading the end of a file', async () => {
      const lines = numberedLines(20);
      // Read from line 11 to 20. The start is not 0, so it's truncated.
      const result = await readText(lines.join('\n'), mockConfig, {
        offset: 10,
        limit: 10,
      });

      expect(result.llmContent).toContain(lines.slice(10, 20).join('\n'));
      expect(result.returnDisplay).toBe('Read lines 11-20 of 20 from test.txt');
      expect(result.isTruncated).toBe(true); // This is the key check for the bug
      expect(result.originalLineCount).toBe(20);
      expect(result.linesShown).toEqual([11, 20]);
    });

    it('should handle limit exceeding file length', async () => {
      const content = ['Line 1', 'Line 2'].join('\n');
      const result = await readText(content, mockConfig, {
        offset: 0,
        limit: 10,
      });

      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
      expect(result.originalLineCount).toBe(2);
      expect(result.linesShown).toEqual([1, 2]);
    });

    it('should preserve default full file-system reads for large text files', async () => {
      const content = `head\n${'x'.repeat(11 * MB)}`;
      const result = await fsRead(content);

      expect(result.content).toBe(content);
      expect(result._meta?.originalLineCount).toBe(2);
      expect(result._meta?.originalLineCountExact).toBe(true);
      expect(result._meta?.truncatedByBytes).not.toBe(true);
    });

    it('should stream explicit offset reads for large text files', async () => {
      const content = `skip\n${'line\n'.repeat(3 * MB)}`;
      const result = await fsRead(content, { line: 1 });

      expect(result.content.startsWith('line\n')).toBe(true);
      expect(result.content.startsWith('skip\n')).toBe(false);
      expect(result._meta?.originalLineCountExact).toBe(false);
      expect(result._meta?.truncatedByBytes).toBe(true);
    });

    it('should preserve unbounded explicit line-zero reads below the large-file threshold', async () => {
      const content = `head\n${'body\n'.repeat(6_000)}tail\n`;
      const result = await fsRead(content, { line: 0 });

      expect(result.content).toBe(content);
      expect(result._meta?.truncatedByBytes).not.toBe(true);
    });

    it('should enforce maxOutputBytes for default file-system reads below the large-file threshold', async () => {
      const result = await fsRead('x'.repeat(100), { maxOutputBytes: 10 });

      expect(result.content).toBe('x'.repeat(10));
      expect(result._meta?.originalLineCount).toBe(1);
      expect(result._meta?.originalLineCountExact).toBe(true);
      expect(result._meta?.truncatedByBytes).toBe(true);
    });

    it('should propagate large non-UTF-8 errors through bounded reads', async () => {
      const gbkLine = iconvEncode('中文日志行\n', 'gbk');
      const gbkChunk = Buffer.concat(
        Array.from({ length: 1024 }, () => gbkLine),
      );
      const repeatCount = Math.ceil((11 * MB) / gbkChunk.length);
      actualNodeFs.writeFileSync(
        testTextFilePath,
        Buffer.concat(Array.from({ length: repeatCount }, () => gbkChunk)),
      );

      await expect(
        readFileWithLineAndLimit({
          path: testTextFilePath,
          limit: 10,
          maxOutputBytes: 10_000,
        }),
      ).rejects.toThrow(LargeNonUtf8TextError);
    });

    it.each([
      ['should propagate aborts from unbounded full reads', 'hello\nworld'],
      [
        'should propagate aborts before large unbounded full reads',
        'x'.repeat(11 * MB),
      ],
    ])('%s', async (_title, content) => {
      actualNodeFs.writeFileSync(testTextFilePath, content);
      const controller = new AbortController();
      controller.abort();

      await expect(
        readFileWithLineAndLimit({
          path: testTextFilePath,
          limit: Number.POSITIVE_INFINITY,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/abort/i);
    });

    it('reports lineEnding and truncatedByBytes on an unbounded read', async () => {
      actualNodeFs.writeFileSync(
        testTextFilePath,
        'alpha\r\nbravo\r\ncharlie\r\n',
      );

      const whole = await readFileWithLineAndLimit({
        path: testTextFilePath,
        limit: Number.POSITIVE_INFINITY,
      });
      const range = await readFileWithLineAndLimit({
        path: testTextFilePath,
        limit: 3,
      });

      expect(whole.lineEnding).toBe('crlf');
      expect(whole.truncatedByBytes).toBe(false);
      expect(whole.lineEnding).toBe(range.lineEnding);
      expect(whole.truncatedByBytes).toBe(range.truncatedByBytes);
    });

    it('should use provided stats when reading with line and byte limits', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'hello\nworld');
      const stats = actualNodeFs.statSync(testTextFilePath);
      const statSpy = vi
        .spyOn(fs.promises, 'stat')
        .mockRejectedValueOnce(new Error('unexpected stat'));

      try {
        const result = await readFileWithLineAndLimit({
          path: testTextFilePath,
          limit: 1,
          maxOutputBytes: 100,
          stats,
        });

        expect(result.content).toBe('hello');
        expect(statSpy).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }
    });

    it('should not byte-truncate multibyte text before the character limit', async () => {
      const content = '你'.repeat(1000);
      const result = await readText(content);

      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
    });

    it('should truncate long lines in text files', async () => {
      const longLine = 'a'.repeat(2500);
      const result = await readText(
        `Short line\n${longLine}\nAnother short line`,
      );

      expect(result.llmContent).toContain('Short line');
      expect(result.llmContent).toContain(
        longLine.substring(0, 2000) + '... [truncated]',
      );
      expect(result.llmContent).not.toContain('Another short line');
      expect(result.returnDisplay).toBe(
        'Read lines 1-2 of 3 from test.txt (truncated)',
      );
      expect(result.isTruncated).toBe(true);
    });

    it.each<[string, string[], number, string]>([
      [
        'should truncate when line count exceeds the limit',
        numberedLines(11), // Read 5 lines, but there are 11 total
        5,
        'Read lines 1-5 of 11 from test.txt',
      ],
      [
        'should truncate when a line length exceeds the character limit',
        [...numberedLines(10), 'b'.repeat(2500)], // Read all 11, including the long one
        11,
        'Read lines 1-11 of 11 from test.txt (truncated)',
      ],
      [
        'should truncate both line count and line length when both exceed limits',
        // Read 10 lines out of 20, including the long 5th line
        numberedLines(20).map((line, i) => (i === 4 ? 'c'.repeat(2500) : line)),
        10,
        'Read lines 1-5 of 20 from test.txt (truncated)',
      ],
    ])('%s', async (_title, lines, limit, display) => {
      const result = await readText(lines.join('\n'), mockConfig, {
        offset: 0,
        limit,
      });

      expect(result.isTruncated).toBe(true);
      expect(result.returnDisplay).toBe(display);
    });

    it('should read large text files through bounded truncation instead of the 10MB gate', async () => {
      const lines = Array.from(
        { length: 65_000 },
        (_, index) => `Line ${index + 1} ${'x'.repeat(180)}`,
      );
      const result = await readText(lines.join('\n'));

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Line 1');
      expect(result.returnDisplay).toContain('Read lines 1-');
      expect(result.isTruncated).toBe(true);
      expect(result.originalLineCount).toBeGreaterThanOrEqual(
        result.linesShown?.[1] ?? 1,
      );
      expect(result.originalLineCount).toBeLessThan(65_000);
      expect(result.originalLineCountExact).toBe(false);
      expect(result.linesShown?.[0]).toBe(1);
    });

    it('should stream large text files when line truncation is disabled', async () => {
      const result = await readText(
        'x'.repeat(11 * MB),
        withConfig({
          getTruncateToolOutputLines: () => Number.POSITIVE_INFINITY,
        }),
      );

      expect(result.error).toBeUndefined();
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('... [truncated]');
      expect(result.returnDisplay).toBe(
        'Read lines 1-1 of at least 1 from test.txt (truncated)',
      );
      expect(result.isTruncated).toBe(true);
      expect(result.originalLineCountExact).toBe(false);
    });

    it('should mark byte truncation metadata without character truncation', async () => {
      const result = await readText(
        'visible',
        withConfig({
          getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
          getFileSystemService: () => ({
            readTextFile: vi.fn().mockResolvedValue({
              content: 'visible',
              _meta: {
                originalLineCount: 1,
                originalLineCountExact: false,
                truncatedByBytes: true,
              },
            }),
          }),
        }),
      );

      expect(typeof result.llmContent).toBe('string');
      const llmContent = result.llmContent as string;
      expect(llmContent).toBe('visible\n... [truncated]');
      expect(llmContent.match(/\.\.\. \[truncated\]/g)).toHaveLength(1);
      expect(result.returnDisplay).toBe(
        'Read lines 1-1 of at least 1 from test.txt (truncated)',
      );
      expect(result.isTruncated).toBe(true);
    });

    it('should use selected range as a lower bound when large file metadata is missing', async () => {
      const result = await readText(
        'x'.repeat(11 * MB),
        withConfig({
          getFileSystemService: () => ({
            readTextFile: vi
              .fn()
              .mockResolvedValue({ content: 'visible\nnext' }),
          }),
        }),
        { offset: 9, limit: 2 },
      );

      expect(result.originalLineCount).toBe(11);
      expect(result.originalLineCountExact).toBe(false);
      expect(result.returnDisplay).toBe(
        'Read lines 10-11 of at least 11 from test.txt',
      );
    });

    it('should preserve disabled output truncation for large text files', async () => {
      const byteLength = 11 * MB;
      const result = await readText(
        'x'.repeat(byteLength),
        withConfig({
          getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
        }),
      );

      expect(typeof result.llmContent).toBe('string');
      const llmContent = result.llmContent as string;
      expect(llmContent).toHaveLength(byteLength);
      expect(llmContent).not.toContain('... [truncated]');
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
    });

    it('should still return an error if an inline media file exceeds 10MB', async () => {
      const gif = Buffer.alloc(11 * MB);
      const result = await readMedia('large.gif', gif, 'image/gif');

      expect(result.error).toContain('File size exceeds the 10MB limit');
      expect(result.returnDisplay).toContain(
        'File size exceeds the 10MB limit',
      );
      expect(result.llmContent).toContain('File size exceeds the 10MB limit');
    });

    it('should allow explicit page ranges above the full-PDF text-extraction size cap', async () => {
      const result = await readPdf(
        { ...fakePdf(200 * MB), pages: '1-5' },
        PDFTOTEXT,
        execOk('selected page text'),
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBe('selected page text');
      expect(result.returnDisplay).toContain('Read pdf as text (pages 1-5)');
    });

    it('should reject non-regular files (FIFOs, devices, sockets)', async () => {
      // A FIFO / socket / /dev/zero shows up as a non-file, non-directory
      // stat entry. stats.size is typically 0 or meaningless, so without
      // this guard a caller could accidentally stream /dev/zero through
      // pdftotext until the timeout fires.
      const statSpy = fakeStat(0, false);

      try {
        const result = await readText('placeholder');

        expect(result.error).toMatch(/not a regular file/i);
        expect(result.returnDisplay).toMatch(/not a regular file/i);
      } finally {
        statSpy.mockRestore();
      }
    });
  });
});
