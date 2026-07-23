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

import {
  isWithinRoot,
  isBinaryFile,
  detectFileType,
  processSingleFileContent,
  detectBOM,
  decodeBufferWithEncodingInfo,
  readFileWithLineAndLimit,
  readFileWithEncoding,
  readFileWithEncodingInfo,
  detectFileEncoding,
  fileExists,
} from './fileUtils.js';
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
import { VISION_BRIDGE_MAX_IMAGES } from '../services/visionBridge/vision-bridge-constants.js';

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

const mockMimeGetType = mime.getType as Mock;
const mockExecFile = vi.mocked(execFile);
const mockRender = vi.mocked(renderPDFPagesToImages);

function mockExecResult(result: {
  stdout: string;
  stderr: string;
  code: number;
}) {
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
  } as unknown as Config;

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
      const posixPathInside = '/project/root/file.txt';
      const posixPathOutside = '/project/other/file.txt';
      expect(isWithinRoot(posixPathInside, posixRoot)).toBe(true);
      expect(isWithinRoot(posixPathOutside, posixRoot)).toBe(false);
    });

    it('should return false for a root path that is a sub-path of the path to check', () => {
      const pathToCheck = path.resolve('/project/root/sub');
      const rootSub = path.resolve('/project/root');
      expect(isWithinRoot(pathToCheck, rootSub)).toBe(true);

      const pathToCheckSuper = path.resolve('/project/root');
      const rootSuper = path.resolve('/project/root/sub');
      expect(isWithinRoot(pathToCheckSuper, rootSuper)).toBe(false);
    });
  });

  describe('fileExists', () => {
    it('should return true if the file exists', async () => {
      const testFile = path.join(tempRootDir, 'exists.txt');
      actualNodeFs.writeFileSync(testFile, 'content');
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

    it('should return false for an empty file', async () => {
      actualNodeFs.writeFileSync(filePathForBinaryTest, '');
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(false);
    });

    it('should return false for a typical text file', async () => {
      actualNodeFs.writeFileSync(
        filePathForBinaryTest,
        'Hello, world!\nThis is a test file with normal text content.',
      );
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(false);
    });

    it('should return true for a file with many null bytes', async () => {
      const binaryContent = Buffer.from([
        0x48, 0x65, 0x00, 0x6c, 0x6f, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]); // "He\0llo\0\0\0\0\0"
      actualNodeFs.writeFileSync(filePathForBinaryTest, binaryContent);
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(true);
    });

    it('should return true for a file with high percentage of non-printable ASCII', async () => {
      const binaryContent = Buffer.from([
        0x41, 0x42, 0x01, 0x02, 0x03, 0x04, 0x05, 0x43, 0x44, 0x06,
      ]); // AB\x01\x02\x03\x04\x05CD\x06
      actualNodeFs.writeFileSync(filePathForBinaryTest, binaryContent);
      expect(await isBinaryFile(filePathForBinaryTest)).toBe(true);
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
      it('should detect UTF-8 BOM', () => {
        const buf = Buffer.from([
          0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f,
        ]);
        const result = detectBOM(buf);
        expect(result).toEqual({ encoding: 'utf8', bomLength: 3 });
      });

      it('should detect UTF-16 LE BOM', () => {
        const buf = Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x65, 0x00]);
        const result = detectBOM(buf);
        expect(result).toEqual({ encoding: 'utf16le', bomLength: 2 });
      });

      it('should detect UTF-16 BE BOM', () => {
        const buf = Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x65]);
        const result = detectBOM(buf);
        expect(result).toEqual({ encoding: 'utf16be', bomLength: 2 });
      });

      it('should detect UTF-32 LE BOM', () => {
        const buf = Buffer.from([
          0xff, 0xfe, 0x00, 0x00, 0x48, 0x00, 0x00, 0x00,
        ]);
        const result = detectBOM(buf);
        expect(result).toEqual({ encoding: 'utf32le', bomLength: 4 });
      });

      it('should detect UTF-32 BE BOM', () => {
        const buf = Buffer.from([
          0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x48,
        ]);
        const result = detectBOM(buf);
        expect(result).toEqual({ encoding: 'utf32be', bomLength: 4 });
      });

      it('should return null for no BOM', () => {
        const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
        const result = detectBOM(buf);
        expect(result).toBeNull();
      });

      it('should return null for empty buffer', () => {
        const buf = Buffer.alloc(0);
        const result = detectBOM(buf);
        expect(result).toBeNull();
      });

      it('should return null for partial BOM', () => {
        const buf = Buffer.from([0xef, 0xbb]); // Incomplete UTF-8 BOM
        const result = detectBOM(buf);
        expect(result).toBeNull();
      });
    });

    describe('readFileWithEncoding', () => {
      it('should read UTF-8 BOM file correctly', async () => {
        const content = 'Hello, 世界! 🌍';
        const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const utf8Content = Buffer.from(content, 'utf8');
        const fullBuffer = Buffer.concat([utf8Bom, utf8Content]);

        const filePath = path.join(testDir, 'utf8-bom.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should read UTF-16 LE BOM file correctly', async () => {
        const content = 'Hello, 世界! 🌍';
        const utf16leBom = Buffer.from([0xff, 0xfe]);
        const utf16leContent = Buffer.from(content, 'utf16le');
        const fullBuffer = Buffer.concat([utf16leBom, utf16leContent]);

        const filePath = path.join(testDir, 'utf16le-bom.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should read UTF-16 BE BOM file correctly', async () => {
        const content = 'Hello, 世界! 🌍';
        // Manually encode UTF-16 BE: each char as big-endian 16-bit
        const utf16beBom = Buffer.from([0xfe, 0xff]);
        const chars = Array.from(content);
        const utf16beBytes: number[] = [];

        for (const char of chars) {
          const code = char.codePointAt(0)!;
          if (code > 0xffff) {
            // Surrogate pair for emoji
            const surrogate1 = 0xd800 + ((code - 0x10000) >> 10);
            const surrogate2 = 0xdc00 + ((code - 0x10000) & 0x3ff);
            utf16beBytes.push((surrogate1 >> 8) & 0xff, surrogate1 & 0xff);
            utf16beBytes.push((surrogate2 >> 8) & 0xff, surrogate2 & 0xff);
          } else {
            utf16beBytes.push((code >> 8) & 0xff, code & 0xff);
          }
        }

        const utf16beContent = Buffer.from(utf16beBytes);
        const fullBuffer = Buffer.concat([utf16beBom, utf16beContent]);

        const filePath = path.join(testDir, 'utf16be-bom.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should read UTF-32 LE BOM file correctly', async () => {
        const content = 'Hello, 世界! 🌍';
        const utf32leBom = Buffer.from([0xff, 0xfe, 0x00, 0x00]);

        const utf32leBytes: number[] = [];
        for (const char of Array.from(content)) {
          const code = char.codePointAt(0)!;
          utf32leBytes.push(
            code & 0xff,
            (code >> 8) & 0xff,
            (code >> 16) & 0xff,
            (code >> 24) & 0xff,
          );
        }

        const utf32leContent = Buffer.from(utf32leBytes);
        const fullBuffer = Buffer.concat([utf32leBom, utf32leContent]);

        const filePath = path.join(testDir, 'utf32le-bom.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should read UTF-32 BE BOM file correctly', async () => {
        const content = 'Hello, 世界! 🌍';
        const utf32beBom = Buffer.from([0x00, 0x00, 0xfe, 0xff]);

        const utf32beBytes: number[] = [];
        for (const char of Array.from(content)) {
          const code = char.codePointAt(0)!;
          utf32beBytes.push(
            (code >> 24) & 0xff,
            (code >> 16) & 0xff,
            (code >> 8) & 0xff,
            code & 0xff,
          );
        }

        const utf32beContent = Buffer.from(utf32beBytes);
        const fullBuffer = Buffer.concat([utf32beBom, utf32beContent]);

        const filePath = path.join(testDir, 'utf32be-bom.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should read file without BOM as UTF-8', async () => {
        const content = 'Hello, 世界!';
        const filePath = path.join(testDir, 'no-bom.txt');
        await fsPromises.writeFile(filePath, content, 'utf8');

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe(content);
      });

      it('should handle empty file', async () => {
        const filePath = path.join(testDir, 'empty.txt');
        await fsPromises.writeFile(filePath, '');

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe('');
      });

      it('should read GBK-encoded file with Chinese characters correctly', async () => {
        // GBK encoding of "你好世界这是中文内容用于测试编码检测"
        // Needs enough content for chardet to reliably detect the encoding
        const gbkBuffer = Buffer.from([
          0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xd5, 0xe2, 0xca,
          0xc7, 0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xd3, 0xc3,
          0xd3, 0xda, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xe0, 0xc2, 0xeb, 0xbc,
          0xec, 0xb2, 0xe2,
        ]);
        const filePath = path.join(testDir, 'gbk-chinese.txt');
        await fsPromises.writeFile(filePath, gbkBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toBe('你好世界这是中文内容用于测试编码检测');
      });

      it('should read GBK-encoded file with mixed ASCII and Chinese correctly', async () => {
        // GBK encoding of "// 这是注释内容用于测试\nhello你好世界测试中文编码检测\n函数返回值正确"
        // Needs enough Chinese content for chardet to reliably detect as GB18030/GBK
        const gbkBuffer = Buffer.from([
          0x2f, 0x2f, 0x20, 0xd5, 0xe2, 0xca, 0xc7, 0xd7, 0xa2, 0xca, 0xcd,
          0xc4, 0xda, 0xc8, 0xdd, 0xd3, 0xc3, 0xd3, 0xda, 0xb2, 0xe2, 0xca,
          0xd4, 0x0a, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xc4, 0xe3, 0xba, 0xc3,
          0xca, 0xc0, 0xbd, 0xe7, 0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xd0, 0xce,
          0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0xbc, 0xec, 0xb2, 0xe2, 0x0a, 0xba,
          0xaf, 0xca, 0xfd, 0xb7, 0xb5, 0xbb, 0xd8, 0xd6, 0xb5, 0xd5, 0xfd,
          0xc8, 0xb7,
        ]);
        const filePath = path.join(testDir, 'gbk-mixed.txt');
        await fsPromises.writeFile(filePath, gbkBuffer);

        const result = await readFileWithEncoding(filePath);
        expect(result).toContain('hello');
        expect(result).toContain('你好世界');
        expect(result).toContain('函数返回值正确');
      });
    });

    describe('readFileWithEncodingInfo', () => {
      it('should decode plain UTF-8 buffers without reading from a path', () => {
        const result = decodeBufferWithEncodingInfo(
          Buffer.from('Hello', 'utf8'),
        );
        expect(result).toEqual({
          content: 'Hello',
          encoding: 'utf-8',
          bom: false,
        });
      });

      it('should decode UTF-8 BOM buffers without reading from a path', () => {
        const result = decodeBufferWithEncodingInfo(
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('Hello', 'utf8'),
          ]),
        );
        expect(result).toEqual({
          content: 'Hello',
          encoding: 'utf-8',
          bom: true,
        });
      });

      it('should return bom: false and encoding utf-8 for plain UTF-8 file', async () => {
        const filePath = path.join(testDir, 'info-utf8.txt');
        await fsPromises.writeFile(filePath, 'Hello', 'utf8');

        const result = await readFileWithEncodingInfo(filePath);
        expect(result.content).toBe('Hello');
        expect(result.encoding).toBe('utf-8');
        expect(result.bom).toBe(false);
      });

      it('should return bom: true and encoding utf-8 for UTF-8 BOM file', async () => {
        const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const filePath = path.join(testDir, 'info-utf8-bom.txt');
        await fsPromises.writeFile(
          filePath,
          Buffer.concat([utf8Bom, Buffer.from('Hello', 'utf8')]),
        );

        const result = await readFileWithEncodingInfo(filePath);
        expect(result.content).toBe('Hello');
        expect(result.encoding).toBe('utf-8');
        expect(result.bom).toBe(true);
      });

      it('should return bom: true and encoding utf-16le for UTF-16LE BOM file', async () => {
        const utf16leBom = Buffer.from([0xff, 0xfe]);
        const utf16leContent = Buffer.from('Hi', 'utf16le');
        const filePath = path.join(testDir, 'info-utf16le.txt');
        await fsPromises.writeFile(
          filePath,
          Buffer.concat([utf16leBom, utf16leContent]),
        );

        const result = await readFileWithEncodingInfo(filePath);
        expect(result.content).toBe('Hi');
        expect(result.encoding).toBe('utf-16le');
        // Non-UTF-8 BOM should also be flagged so it is preserved on write-back
        expect(result.bom).toBe(true);
      });

      it('should return bom: false for GBK file (no BOM)', async () => {
        const gbkBuffer = Buffer.from([
          0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xd5, 0xe2, 0xca,
          0xc7, 0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xd3, 0xc3,
          0xd3, 0xda, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xe0, 0xc2, 0xeb, 0xbc,
          0xec, 0xb2, 0xe2,
        ]);
        const filePath = path.join(testDir, 'info-gbk.txt');
        await fsPromises.writeFile(filePath, gbkBuffer);

        const result = await readFileWithEncodingInfo(filePath);
        expect(result.bom).toBe(false);
        expect(result.encoding).toBe('gb18030');
        expect(result.content).toBe('你好世界这是中文内容用于测试编码检测');
      });
    });

    describe('detectFileEncoding', () => {
      it('should detect UTF-8 for plain ASCII file', async () => {
        const filePath = path.join(testDir, 'ascii.txt');
        await fsPromises.writeFile(filePath, 'Hello World', 'utf8');

        const encoding = await detectFileEncoding(filePath);
        expect(encoding).toBe('utf-8');
      });

      it('should detect UTF-8 for file with UTF-8 BOM', async () => {
        const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const content = Buffer.from('Hello', 'utf8');
        const filePath = path.join(testDir, 'utf8-bom-detect.txt');
        await fsPromises.writeFile(filePath, Buffer.concat([utf8Bom, content]));

        const encoding = await detectFileEncoding(filePath);
        expect(encoding).toBe('utf-8');
      });

      it('should detect GBK encoding for Chinese text in GBK', async () => {
        // GBK encoding of "你好世界这是中文内容用于测试编码检测"
        // Needs enough content for chardet to reliably detect
        const gbkBuffer = Buffer.from([
          0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xd5, 0xe2, 0xca,
          0xc7, 0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xd3, 0xc3,
          0xd3, 0xda, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xe0, 0xc2, 0xeb, 0xbc,
          0xec, 0xb2, 0xe2,
        ]);
        const filePath = path.join(testDir, 'gbk-detect.txt');
        await fsPromises.writeFile(filePath, gbkBuffer);

        const encoding = await detectFileEncoding(filePath);
        // chardet detects GBK as 'gb18030' (its superset)
        expect(encoding).toBe('gb18030');
      });

      it('should return utf-8 for empty file', async () => {
        const filePath = path.join(testDir, 'empty-detect.txt');
        await fsPromises.writeFile(filePath, '');

        const encoding = await detectFileEncoding(filePath);
        expect(encoding).toBe('utf-8');
      });

      it('should return utf-8 for non-existent file', async () => {
        const filePath = path.join(testDir, 'nonexistent-detect.txt');

        const encoding = await detectFileEncoding(filePath);
        expect(encoding).toBe('utf-8');
      });
    });

    describe('isBinaryFile with BOM awareness', () => {
      it('should not treat UTF-8 BOM file as binary', async () => {
        const content = 'Hello, world!';
        const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const utf8Content = Buffer.from(content, 'utf8');
        const fullBuffer = Buffer.concat([utf8Bom, utf8Content]);

        const filePath = path.join(testDir, 'utf8-bom-test.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(false);
      });

      it('should not treat UTF-16 LE BOM file as binary', async () => {
        const content = 'Hello, world!';
        const utf16leBom = Buffer.from([0xff, 0xfe]);
        const utf16leContent = Buffer.from(content, 'utf16le');
        const fullBuffer = Buffer.concat([utf16leBom, utf16leContent]);

        const filePath = path.join(testDir, 'utf16le-bom-test.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(false);
      });

      it('should not treat UTF-16 BE BOM file as binary', async () => {
        const utf16beBom = Buffer.from([0xfe, 0xff]);
        // Simple ASCII in UTF-16 BE
        const utf16beContent = Buffer.from([
          0x00,
          0x48, // H
          0x00,
          0x65, // e
          0x00,
          0x6c, // l
          0x00,
          0x6c, // l
          0x00,
          0x6f, // o
          0x00,
          0x2c, // ,
          0x00,
          0x20, // space
          0x00,
          0x77, // w
          0x00,
          0x6f, // o
          0x00,
          0x72, // r
          0x00,
          0x6c, // l
          0x00,
          0x64, // d
          0x00,
          0x21, // !
        ]);
        const fullBuffer = Buffer.concat([utf16beBom, utf16beContent]);

        const filePath = path.join(testDir, 'utf16be-bom-test.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(false);
      });

      it('should not treat UTF-32 LE BOM file as binary', async () => {
        const utf32leBom = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
        const utf32leContent = Buffer.from([
          0x48,
          0x00,
          0x00,
          0x00, // H
          0x65,
          0x00,
          0x00,
          0x00, // e
          0x6c,
          0x00,
          0x00,
          0x00, // l
          0x6c,
          0x00,
          0x00,
          0x00, // l
          0x6f,
          0x00,
          0x00,
          0x00, // o
        ]);
        const fullBuffer = Buffer.concat([utf32leBom, utf32leContent]);

        const filePath = path.join(testDir, 'utf32le-bom-test.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(false);
      });

      it('should not treat UTF-32 BE BOM file as binary', async () => {
        const utf32beBom = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
        const utf32beContent = Buffer.from([
          0x00,
          0x00,
          0x00,
          0x48, // H
          0x00,
          0x00,
          0x00,
          0x65, // e
          0x00,
          0x00,
          0x00,
          0x6c, // l
          0x00,
          0x00,
          0x00,
          0x6c, // l
          0x00,
          0x00,
          0x00,
          0x6f, // o
        ]);
        const fullBuffer = Buffer.concat([utf32beBom, utf32beContent]);

        const filePath = path.join(testDir, 'utf32be-bom-test.txt');
        await fsPromises.writeFile(filePath, fullBuffer);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(false);
      });

      it('should still treat actual binary file as binary', async () => {
        // PNG header + some binary data with null bytes
        const pngHeader = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const binaryData = Buffer.from([
          0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        ]); // IHDR chunk with nulls
        const fullContent = Buffer.concat([pngHeader, binaryData]);
        const filePath = path.join(testDir, 'test.png');
        await fsPromises.writeFile(filePath, fullContent);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(true);
      });

      it('should treat file with null bytes (no BOM) as binary', async () => {
        const content = Buffer.from([
          0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64,
        ]);
        const filePath = path.join(testDir, 'null-bytes.bin');
        await fsPromises.writeFile(filePath, content);

        const result = await isBinaryFile(filePath);
        expect(result).toBe(true);
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

    it('should detect typescript type by extension (ts, mts, cts, tsx)', async () => {
      expect(await detectFileType('file.ts')).toBe('text');
      expect(await detectFileType('file.test.ts')).toBe('text');
      expect(await detectFileType('file.mts')).toBe('text');
      expect(await detectFileType('vite.config.mts')).toBe('text');
      expect(await detectFileType('file.cts')).toBe('text');
      expect(await detectFileType('component.tsx')).toBe('text');
    });

    it('should detect image type by extension (png)', async () => {
      mockMimeGetType.mockReturnValueOnce('image/png');
      expect(await detectFileType('file.png')).toBe('image');
    });

    it('should detect image type by extension (jpeg)', async () => {
      mockMimeGetType.mockReturnValueOnce('image/jpeg');
      expect(await detectFileType('file.jpg')).toBe('image');
    });

    it('should detect svg type by extension', async () => {
      expect(await detectFileType('image.svg')).toBe('svg');
      expect(await detectFileType('image.icon.svg')).toBe('svg');
    });

    it('should detect pdf type by extension', async () => {
      mockMimeGetType.mockReturnValueOnce('application/pdf');
      expect(await detectFileType('file.pdf')).toBe('pdf');
    });

    it('should detect audio type by extension', async () => {
      mockMimeGetType.mockReturnValueOnce('audio/mpeg');
      expect(await detectFileType('song.mp3')).toBe('audio');
    });

    it('should detect video type by extension', async () => {
      mockMimeGetType.mockReturnValueOnce('video/mp4');
      expect(await detectFileType('movie.mp4')).toBe('video');
    });

    it('should detect .m4v as video even though mime/lite omits video/x-m4v', async () => {
      // mime/lite's standard database has no .m4v entry, so the real lookup
      // returns null; the override map must still classify it as video rather
      // than letting it fall through to the binary content sampler.
      mockMimeGetType.mockReturnValueOnce(null);
      expect(await detectFileType('tutorial.m4v')).toBe('video');
    });

    it('should detect known binary extensions as binary (e.g. .zip)', async () => {
      mockMimeGetType.mockReturnValueOnce('application/zip');
      expect(await detectFileType('archive.zip')).toBe('binary');
    });
    it('should detect known binary extensions as binary (e.g. .exe)', async () => {
      mockMimeGetType.mockReturnValueOnce('application/octet-stream'); // Common for .exe
      expect(await detectFileType('app.exe')).toBe('binary');
    });

    it('should use isBinaryFile for unknown extensions and detect as binary', async () => {
      mockMimeGetType.mockReturnValueOnce(false); // Unknown mime type
      // Create a file that isBinaryFile will identify as binary
      const binaryContent = Buffer.from([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
      ]);
      actualNodeFs.writeFileSync(filePathForDetectTest, binaryContent);
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
      mockMimeGetType.mockReturnValueOnce(null);
      const filePath = path.join(tempRootDir, 'controller.dat');
      actualNodeFs.writeFileSync(
        filePath,
        '<?php\nfunction handleRequest() {\n  return true;\n}\n',
      );
      try {
        expect(await detectFileType(filePath)).toBe('text');
      } finally {
        actualNodeFs.unlinkSync(filePath);
      }
    });

    it('still treats binary-looking .dat files as binary', async () => {
      mockMimeGetType.mockReturnValueOnce(null);
      const filePath = path.join(tempRootDir, 'payload.dat');
      actualNodeFs.writeFileSync(filePath, Buffer.from([0x00, 0xff, 0x00]));
      try {
        expect(await detectFileType(filePath)).toBe('binary');
      } finally {
        actualNodeFs.unlinkSync(filePath);
      }
    });

    it('returns text for files with a text/* mime even when the content looks binary (issue #3964 encrypted FS)', async () => {
      // Frank-Shaw-FS reports `.cpp` / `.c` / `.h` source files on
      // Windows encrypted / DRM-protected file systems being
      // misclassified as binary. The OS surfaces encrypted bytes
      // to `fs.open()` random-access reads, so the 4 KB
      // `isBinaryFile` heuristic sees nulls / non-printables and
      // concludes binary. The extension already declares a text
      // mime, so we must trust that and skip the content sample.
      mockMimeGetType.mockReturnValueOnce('text/x-c');
      const filePath = path.join(tempRootDir, 'encrypted.cpp');
      // Mimic the encrypted-FS sample: leading nulls and high
      // bytes that would trip isBinaryFile (>30% non-printable
      // and at least one null).
      const fakeEncrypted = Buffer.alloc(64);
      for (let i = 0; i < fakeEncrypted.length; i++) {
        fakeEncrypted[i] = i % 4 === 0 ? 0 : 0xff;
      }
      actualNodeFs.writeFileSync(filePath, fakeEncrypted);
      try {
        expect(await detectFileType(filePath)).toBe('text');
      } finally {
        actualNodeFs.unlinkSync(filePath);
      }
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
      // `mime/lite`'s registry omits most languages: `.py`, `.kt`,
      // `.go`, `.rb`, `.swift`, ... all return null. Without a
      // curated extension override, an encrypted-volume read whose
      // 4 KB sample looks binary would misclassify these as binary
      // even though the extension is unambiguously text.
      const looksBinary = Buffer.alloc(64);
      for (let i = 0; i < looksBinary.length; i++) {
        looksBinary[i] = i % 4 === 0 ? 0 : 0xff;
      }
      for (const ext of ['.py', '.kt', '.go', '.rb', '.swift']) {
        mockMimeGetType.mockReturnValueOnce(null);
        const filePath = path.join(tempRootDir, `encrypted${ext}`);
        actualNodeFs.writeFileSync(filePath, looksBinary);
        try {
          expect(await detectFileType(filePath)).toBe('text');
        } finally {
          actualNodeFs.unlinkSync(filePath);
        }
      }
    });

    it('returns text for extensionless build/config basenames (Dockerfile, Makefile, go.mod, …)', async () => {
      // Build / config / lockfile conventions carry no extension (or
      // only an ambiguous one like .mod). `path.extname` returns `''`,
      // so the extension allowlist misses them, and an encrypted-volume
      // read whose 4 KB sample looks binary would misclassify these as
      // binary even though the basename is unambiguously text.
      const looksBinary = Buffer.alloc(64);
      for (let i = 0; i < looksBinary.length; i++) {
        looksBinary[i] = i % 4 === 0 ? 0 : 0xff;
      }
      for (const basename of [
        'Dockerfile',
        'Makefile',
        'Jenkinsfile',
        'go.mod',
        'package-lock.json',
        '.gitignore',
        'LICENSE',
      ]) {
        mockMimeGetType.mockReturnValueOnce(null);
        const filePath = path.join(tempRootDir, basename);
        actualNodeFs.writeFileSync(filePath, looksBinary);
        try {
          expect(await detectFileType(filePath)).toBe('text');
        } finally {
          actualNodeFs.unlinkSync(filePath);
        }
      }
    });

    it('still classifies files in BINARY_EXTENSIONS as binary even with text-looking content', async () => {
      // The extension overrides win-list must not weaken the
      // existing binary-extension pre-empt. A `.png` whose first
      // bytes happen to be ASCII still gets classified as binary
      // because the extension is in BINARY_EXTENSIONS.
      mockMimeGetType.mockReturnValueOnce(null);
      const filePath = path.join(tempRootDir, 'looksLikeText.png');
      actualNodeFs.writeFileSync(filePath, 'PNGheader plain text');
      try {
        expect(await detectFileType(filePath)).toBe('binary');
      } finally {
        actualNodeFs.unlinkSync(filePath);
      }
    });
  });

  describe('processSingleFileContent', () => {
    beforeEach(() => {
      // Default: renderer unavailable, so PDF reads fall back to the text path
      // unless a test opts into rendering. Set after the global resetAllMocks.
      mockRender.mockResolvedValue({
        success: false,
        error: 'pdftoppm unavailable (test default)',
      });
      // Ensure files exist for statSync checks before readFile might be mocked
      if (actualNodeFs.existsSync(testTextFilePath))
        actualNodeFs.unlinkSync(testTextFilePath);
      if (actualNodeFs.existsSync(testImageFilePath))
        actualNodeFs.unlinkSync(testImageFilePath);
      if (actualNodeFs.existsSync(testPdfFilePath))
        actualNodeFs.unlinkSync(testPdfFilePath);
      if (actualNodeFs.existsSync(testBinaryFilePath))
        actualNodeFs.unlinkSync(testBinaryFilePath);
    });

    it('should read a text file successfully', async () => {
      const content = 'Line 1\\nLine 2\\nLine 3';
      actualNodeFs.writeFileSync(testTextFilePath, content);
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
      );
      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should handle file not found', async () => {
      const result = await processSingleFileContent(
        nonexistentFilePath,
        mockConfig,
      );
      expect(result.error).toContain('File not found');
      expect(result.returnDisplay).toContain('File not found');
    });

    it('should handle read errors for text files', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'content'); // File must exist for initial statSync
      const readError = new Error('Simulated read error');
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce(readError);

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
      );
      expect(result.error).toContain('Simulated read error');
      expect(result.returnDisplay).toContain('Simulated read error');
    });

    it('should surface messages from plain object text read errors', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'content');
      vi.spyOn(fsService, 'readTextFile').mockRejectedValueOnce({
        code: -32603,
        message:
          'path escapes workspace: /root/.qwen/skills/dataworks-di-data-processor/instructions/interaction_norms.md',
        data: {
          errorKind: 'path_outside_workspace',
          status: 400,
        },
      });

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
      );

      expect(result.error).toContain('path escapes workspace');
      expect(result.returnDisplay).toContain('path escapes workspace');
      expect(result.error).not.toContain('[object Object]');
      expect(result.returnDisplay).not.toContain('[object Object]');
    });

    it('should surface messages from plain object notebook read errors', async () => {
      const notebookPath = path.join(tempRootDir, 'analysis.ipynb');
      actualNodeFs.writeFileSync(notebookPath, '{}');
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce({
        code: -32603,
        message: 'notebook is outside allowed roots',
        data: {
          errorKind: 'path_outside_workspace',
          status: 400,
        },
      });

      const result = await processSingleFileContent(notebookPath, mockConfig);

      expect(result.error).toContain('notebook is outside allowed roots');
      expect(result.returnDisplay).toContain('Error reading notebook');
      expect(result.llmContent).toContain('notebook is outside allowed roots');
      expect(result.error).not.toContain('[object Object]');
      expect(result.llmContent).not.toContain('[object Object]');
    });

    it('should handle read errors for image/pdf files', async () => {
      actualNodeFs.writeFileSync(testImageFilePath, 'content'); // File must exist
      mockMimeGetType.mockReturnValue('image/png');
      const readError = new Error('Simulated image read error');
      vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(readError);

      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfig,
      );
      expect(result.error).toContain('Simulated image read error');
      expect(result.returnDisplay).toContain('Simulated image read error');
    });

    it('should process an image file', async () => {
      const fakePngData = Buffer.from('fake png data');
      actualNodeFs.writeFileSync(testImageFilePath, fakePngData);
      mockMimeGetType.mockReturnValue('image/png');
      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfig,
      );
      expect(
        (result.llmContent as { inlineData: unknown }).inlineData,
      ).toBeDefined();
      expect(
        (result.llmContent as { inlineData: { mimeType: string } }).inlineData
          .mimeType,
      ).toBe('image/png');
      expect(
        (result.llmContent as { inlineData: { data: string } }).inlineData.data,
      ).toBe(fakePngData.toString('base64'));
      expect(
        (result.llmContent as { inlineData: { displayName?: string } })
          .inlineData.displayName,
      ).toBe('image.png');
      expect(result.returnDisplay).toContain('Read image file: image.png');
    });

    it('should reject image files when model does not support image', async () => {
      const fakePngData = Buffer.from('fake png data');
      actualNodeFs.writeFileSync(testImageFilePath, fakePngData);
      mockMimeGetType.mockReturnValue('image/png');

      const mockConfigNoImage = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: {} }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfigNoImage,
      );
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('Unsupported image file');
      expect(result.llmContent).toContain('does not support image input');
      expect(result.returnDisplay).toContain('Skipped image file');
    });

    it('keeps image inline when preserveUnsupportedImage is true', async () => {
      const fakePngData = Buffer.from('fake png data');
      actualNodeFs.writeFileSync(testImageFilePath, fakePngData);
      mockMimeGetType.mockReturnValue('image/png');

      const mockConfigNoImage = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: {} }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfigNoImage,
        { preserveUnsupportedImage: true },
      );
      expect(typeof result.llmContent).toBe('object');
      expect(
        (result.llmContent as { inlineData: { mimeType: string } }).inlineData
          .mimeType,
      ).toBe('image/png');
      expect(result.returnDisplay).toContain('Read image file');
    });

    it('still strips image for agent reads without the preserve flag', async () => {
      const fakePngData = Buffer.from('fake png data');
      actualNodeFs.writeFileSync(testImageFilePath, fakePngData);
      mockMimeGetType.mockReturnValue('image/png');

      const mockConfigNoImage = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: {} }),
      } as unknown as Config;

      // No preserve flag (default false) — agent tool read / headless path.
      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfigNoImage,
      );
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('does not support image input');
    });

    it('still strips audio when preserveUnsupportedImage is true', async () => {
      const fakeAudio = Buffer.from('fake audio data');
      const testAudioPath = path.join(tempRootDir, 'clip.mp3');
      actualNodeFs.writeFileSync(testAudioPath, fakeAudio);
      mockMimeGetType.mockReturnValue('audio/mpeg');

      const mockConfigNoAudio = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: {} }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testAudioPath,
        mockConfigNoAudio,
        { preserveUnsupportedImage: true },
      );
      expect(typeof result.llmContent).toBe('string');
      expect(result.llmContent).toContain('does not support audio input');
    });

    it('processes an .m4v video as inline data despite the mime/lite gap', async () => {
      // Regression guard for the /learn local-video path: mime/lite returns
      // null for .m4v, so without the detectFileType override the file fell
      // through to the content sampler and was misclassified as binary,
      // yielding a "Cannot display content of binary file" string instead of
      // an inlineData Part.
      const fakeVideo = Buffer.from('fake m4v data');
      const testVideoPath = path.join(tempRootDir, 'tutorial.m4v');
      actualNodeFs.writeFileSync(testVideoPath, fakeVideo);
      mockMimeGetType.mockReturnValue(null);

      const result = await processSingleFileContent(testVideoPath, mockConfig);

      expect(typeof result.llmContent).toBe('object');
      expect(
        (result.llmContent as { inlineData: { data: string } }).inlineData.data,
      ).toBe(fakeVideo.toString('base64'));
      expect(result.returnDisplay).toContain('Read video file');
    });

    it('should fall back to pdftotext when model does not support PDF', async () => {
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({
          modalities: { image: true },
        }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );
      expect(typeof result.llmContent).toBe('string');
      // When pdftotext is not installed, should return a helpful error
      // rather than silently skipping
      expect(result.llmContent).toContain('Cannot extract text from PDF');
      expect(result.returnDisplay).toContain('Failed to read pdf');
    });

    it('rejects large full-PDF text fallback before extracting text', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          42\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('PDF requires page range');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
      expect(mockExecFile.mock.calls[1]![0]).toBe('pdftotext');
    });

    it('rejects compact PDFs when pdfinfo reports too many pages', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.alloc(64 * 1024));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          42\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain('has 42 pages');
      expect(result.returnDisplay).toContain('PDF requires page range');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
      expect(mockExecFile.mock.calls[1]![0]).toBe('pdftotext');
    });

    it('uses size-heuristic page guidance when pdfinfo is unavailable', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.llmContent).toContain('appears to have about 21 pages');
      expect(result.returnDisplay).toContain('PDF requires page range');
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
      expect(mockExecFile.mock.calls[1]![0]).toBe('pdftotext');
    });

    it('surfaces missing pdftotext before page-range guidance', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          42\n',
        stderr: '',
        code: 0,
      });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );

      expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
      expect(result.llmContent).toContain('pdftotext is not installed');
      expect(result.llmContent).not.toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Failed to read pdf');
      expect(result.stats).toBeDefined();
    });

    it('returns a reference instead of an error for large @-attached PDFs', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          42\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { largePdfBehavior: 'reference' },
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.stats).toBeDefined();
    });

    it('returns a reference for large @-attached PDFs when pdftotext is unavailable', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          42\n',
        stderr: '',
        code: 0,
      });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { largePdfBehavior: 'reference' },
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain("Use the 'pages' parameter");
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.stats).toBeDefined();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile.mock.calls[0]![0]).toBe('pdfinfo');
    });

    it('keeps explicit pages reads on the pdftotext path', async () => {
      actualNodeFs.writeFileSync(
        testPdfFilePath,
        Buffer.alloc(2 * 1024 * 1024),
      );
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'page one text', stderr: '', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { pages: '1' },
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
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');

        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({ modalities: { image: true } }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { pages },
        );

        expect(result.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
        expect(result.llmContent).toContain(expectedMessage);
        expect(mockExecFile).not.toHaveBeenCalled();
      },
    );

    it('rejects overly dense page-range extraction with a short error', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { pages: '1' },
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.llmContent).toContain('too large to return safely');
      expect(result.llmContent).toContain('selected page exceeds');
    });

    it('rejects dense non-ASCII PDF extraction with a short error', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({
        stdout: '\u4e00'.repeat(11_000),
        stderr: '',
        code: 0,
      });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { pages: '1' },
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.llmContent).toContain('too large to return safely');
    });

    it('rejects dense no-pages PDF extraction after exact page count allows full reads', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          2\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.returnDisplay).toContain('PDF text too large');
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(
        mockExecFile.mock.calls.some((call) => call[0] === 'pdfinfo'),
      ).toBe(true);
    });

    it('references dense no-pages PDFs for @ attachments', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          2\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { largePdfBehavior: 'reference' },
      );

      expect(result.error).toBeUndefined();
      expect(result.returnDisplay).toContain('Referenced large PDF');
      expect(result.llmContent).toContain('too large to return safely');
    });

    it('rejects dense page-range PDF extraction for @ attachments', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

      const mockConfigNoPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigNoPdf,
        { pages: '1-5', largePdfBehavior: 'reference' },
      );

      expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
      expect(result.returnDisplay).toContain('PDF text too large');
      expect(String(result.llmContent).length).toBeLessThan(1000);
      expect(result.stats).toBeDefined();
    });

    it('allows full PDF text extraction at the full-text size cap', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({
        stdout: 'Pages:          2\n',
        stderr: '',
        code: 0,
      });
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'full text at cap', stderr: '', code: 0 });
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 100 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({ modalities: { image: true } }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
        );

        expect(result.error).toBeUndefined();
        expect(result.llmContent).toBe('full text at cap');
        expect(mockExecFile).toHaveBeenCalledTimes(3);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('rejects huge no-pages PDFs before returning page guidance', async () => {
      actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
      mockMimeGetType.mockReturnValue('application/pdf');
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 200 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({ modalities: { image: true } }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { largePdfBehavior: 'reference' },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.returnDisplay).toContain('PDF file too large');
        expect(result.llmContent).toContain("Use the 'pages' parameter");
        expect(result.llmContent).toContain('split the document');
        expect(result.stats).toBeDefined();
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }
    });

    it('should skip the 10MB size gate when extracting PDF text by pages', async () => {
      // Tiny file on disk — the fs.stat spy below reports a size >10MB so
      // the upstream size gate would reject if it still ran. With the
      // text-extraction path we want pdftotext to handle oversized PDFs,
      // since it streams the file and the output is capped downstream.
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 15 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({
            modalities: { image: true },
          }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { pages: '1-5' },
        );

        // Must not be rejected by the generic 10MB gate.
        expect(result.error ?? '').not.toContain('10MB limit');
        expect(result.llmContent).not.toMatch(/exceeds the 10MB limit/i);
        // Routed into the pdftotext path — either success or the
        // install-guidance error, never "File size exceeds the 10MB limit".
        expect(result.returnDisplay ?? '').toMatch(/pdf/i);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('allows explicit page ranges at the paged text-extraction size cap', async () => {
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'paged text at cap', stderr: '', code: 0 });

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 512 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({
            modalities: { image: true },
          }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { pages: '1-5' },
        );

        expect(result.error).toBeUndefined();
        expect(result.llmContent).toBe('paged text at cap');
        expect(mockExecFile).toHaveBeenCalledTimes(2);
      } finally {
        statSpy.mockRestore();
      }
    });

    it('rejects explicit page ranges above the paged text-extraction size cap', async () => {
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 600 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({
            modalities: { image: true },
          }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { pages: '1-5' },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain('page-range text extraction');
        expect(result.stats).toBeDefined();
        expect(mockExecFile).not.toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
      }
    });

    it('should still reject oversized PDFs when routing to the native base64 path', async () => {
      // When the model supports PDF modality and no pages arg is provided,
      // the base64 path applies and the 10MB inline-data cap still matters.
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 15 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigWithPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({
            modalities: { image: true, pdf: true },
          }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigWithPdf,
        );

        expect(result.error).toContain('10MB limit');
      } finally {
        statSpy.mockRestore();
      }
    });

    it('should accept PDF files when model supports PDF', async () => {
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const mockConfigWithPdf = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({
          modalities: { image: true, pdf: true },
        }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testPdfFilePath,
        mockConfigWithPdf,
      );
      expect(result.llmContent).toHaveProperty('inlineData');
      expect(
        (result.llmContent as { inlineData: { mimeType: string } }).inlineData
          .mimeType,
      ).toBe('application/pdf');
      expect(result.returnDisplay).toContain('Read pdf file');
    });

    describe('PDF image rendering (vision fallback)', () => {
      const visionConfig = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
      } as unknown as Config;
      const fakeImage = (data: string) => ({ data, mimeType: 'image/jpeg' });
      type MediaPart = { text?: string; inlineData?: { data: string } };

      it('renders the requested page range when text overflows', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('AAA'), fakeImage('BBB')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
          { pages: '1-2' },
        );

        expect(result.error).toBeUndefined();
        expect(Array.isArray(result.llmContent)).toBe(true);
        const parts = result.llmContent as MediaPart[];
        expect(parts).toHaveLength(2);
        expect(parts[0]!.inlineData).toMatchObject({
          data: 'AAA',
          mimeType: 'image/jpeg',
        });
        expect(result.returnDisplay).toContain('image');
        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 1,
          lastPage: 2,
        });
      });

      it('renders the whole document (up to the ceiling) for a no-pages overflow', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          3\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('P1'), fakeImage('P2'), fakeImage('P3')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
        );

        expect(Array.isArray(result.llmContent)).toBe(true);
        expect(result.llmContent).toHaveLength(3);
        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 1,
          lastPage: PDF_MAX_PAGES_PER_READ,
        });
      });

      it('renders images when extraction fails on a scanned PDF', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          2\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('S1'), fakeImage('S2')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
        );

        expect(Array.isArray(result.llmContent)).toBe(true);
        expect(result.llmContent).toHaveLength(2);
      });

      it('still returns page guidance (no render) beyond the page ceiling', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          42\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain("Use the 'pages' parameter");
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('flags truncation (never drops pages silently)', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('ONLY')],
          bytesTruncated: true,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
          { pages: '1-5' },
        );

        const parts = result.llmContent as MediaPart[];
        expect(
          parts.some(
            (p) => typeof p.text === 'string' && /omitted/.test(p.text),
          ),
        ).toBe(true);
      });

      it('notes the page ceiling when a no-pages render fills it (page count unknown)', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        // pdfinfo unavailable -> page count falls back to the size heuristic,
        // which underestimates; the render then fills the 20-page ceiling.
        mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: Array.from({ length: PDF_MAX_PAGES_PER_READ }, (_, i) =>
            fakeImage(`P${i + 1}`),
          ),
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
        );

        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(
          PDF_MAX_PAGES_PER_READ,
        );
        expect(
          parts.some(
            (p) =>
              typeof p.text === 'string' && /per-read maximum/.test(p.text),
          ),
        ).toBe(true);
      });

      it('falls back to text guidance when the renderer is unavailable', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        // mockRender default = failure (renderer unavailable).

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
          { pages: '1' },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain('too large to return safely');
      });

      it('falls back to text guidance when rendering returns no page images', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          visionConfig,
          { pages: '1' },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.llmContent).toContain('too large to return safely');
        expect(Array.isArray(result.llmContent)).toBe(false);
        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 1,
          lastPage: 1,
        });
      });
    });

    describe('PDF vision-bridge rendering (text-only model)', () => {
      const bridgeConfig = {
        ...mockConfig,
        getContentGeneratorConfig: () => ({ modalities: {} }),
      } as unknown as Config;
      const fakeImage = (data: string) => ({ data, mimeType: 'image/jpeg' });
      type MediaPart = { text?: string; inlineData?: { data: string } };

      it('renders up to VISION_BRIDGE_MAX_IMAGES pages for a scanned @ PDF', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          2\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          2\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('B1'), fakeImage('B2')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { preserveUnsupportedImage: true, largePdfBehavior: 'reference' },
        );

        expect(Array.isArray(result.llmContent)).toBe(true);
        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 1,
          lastPage: 2,
        });
        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(2);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('notes how many pages were rendered when more remain', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          10\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          10\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [
            fakeImage('1'),
            fakeImage('2'),
            fakeImage('3'),
            fakeImage('4'),
          ],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { preserveUnsupportedImage: true, largePdfBehavior: 'reference' },
        );

        const parts = result.llmContent as MediaPart[];
        expect(parts.filter((p) => p.inlineData).length).toBe(4);
        expect(
          parts.some(
            (p) =>
              typeof p.text === 'string' &&
              /pages 5-10 were not included/.test(p.text),
          ),
        ).toBe(true);
      });

      it('notes truncation when the render fills the cap and the page count is unknown', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        // pdfinfo unavailable on both the pre-gate probe and the note probe.
        mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
        mockRender.mockResolvedValue({
          success: true,
          images: Array.from({ length: VISION_BRIDGE_MAX_IMAGES }, (_, i) =>
            fakeImage(`B${i + 1}`),
          ),
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { preserveUnsupportedImage: true, largePdfBehavior: 'reference' },
        );

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
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          25\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [
            fakeImage('20'),
            fakeImage('21'),
            fakeImage('22'),
            fakeImage('23'),
          ],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 20,
          lastPage: 23,
        });
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
          continuation: {
            certainty: 'known',
            firstPage: 24,
            lastPage: 25,
          },
        });
      });

      it('clips an explicit range to the actual PDF and does not invent remaining pages', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          6\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('4'), fakeImage('5'), fakeImage('6')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '4-8', preparePdfForVisionBridge: true },
        );

        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 4,
          lastPage: 6,
        });
        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          renderedRange: { firstPage: 4, lastPage: 6 },
        });
        expect(result.pdfVisionBridgeCandidate?.continuation).toBeUndefined();
        expect(JSON.stringify(result.llmContent)).not.toContain('pages 7-8');
      });

      it('treats a short render as EOF when the PDF page count is unavailable', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('4'), fakeImage('5'), fakeImage('6')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '4-8', preparePdfForVisionBridge: true },
        );

        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 4,
          lastPage: 7,
        });
        expect(result.pdfVisionBridgeCandidate?.continuation).toBeUndefined();
        expect(JSON.stringify(result.llmContent)).not.toContain('pages 7-8');
      });

      it('marks continuation as possible when an unknown PDF fills the render cap', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdfinfo missing', code: 1 });
        mockRender.mockResolvedValue({
          success: true,
          images: [
            fakeImage('20'),
            fakeImage('21'),
            fakeImage('22'),
            fakeImage('23'),
          ],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

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
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          6\n', stderr: '', code: 0 });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(mockRender).not.toHaveBeenCalled();
        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('prepares a candidate when an explicit single page still overflows', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          25\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('20')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20', preparePdfForVisionBridge: true },
        );

        expect(mockRender).toHaveBeenCalledWith(testPdfFilePath, {
          firstPage: 20,
          lastPage: 20,
        });
        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          reason: 'single_page_text_overflow',
          renderedRange: { firstPage: 20, lastPage: 20 },
          fallback: { errorType: ToolErrorType.FILE_TOO_LARGE },
        });
      });

      it('renders an actual one-page @ PDF when its text overflows', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          1\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('1')],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { preserveUnsupportedImage: true, largePdfBehavior: 'reference' },
        );

        expect(result.error).toBeUndefined();
        expect(
          (result.llmContent as MediaPart[]).filter((part) => part.inlineData),
        ).toHaveLength(1);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('records unrendered requested pages when the byte budget truncates images', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          25\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [fakeImage('20'), fakeImage('21')],
          bytesTruncated: true,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(result.pdfVisionBridgeCandidate).toMatchObject({
          renderedRange: { firstPage: 20, lastPage: 21 },
          continuation: {
            certainty: 'known',
            firstPage: 22,
            lastPage: 25,
          },
        });
        expect(JSON.stringify(result.llmContent)).toContain(
          'pages 22-25 were not included',
        );
      });

      it('does not render when a multi-page text result overflows', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('does not bridge explicit page overflow for a native PDF model', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });
        const nativePdfConfig = {
          ...bridgeConfig,
          getContentGeneratorConfig: () => ({ modalities: { pdf: true } }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          nativePdfConfig,
          { pages: '20', preparePdfForVisionBridge: true },
        );

        expect(result.errorType).toBe(ToolErrorType.FILE_TOO_LARGE);
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('restores the extraction failure when bridge rendering fails', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          25\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: false,
          error: 'renderer unavailable',
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('restores the extraction failure when rendering returns no page images', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });
        mockExecResult({ stdout: 'Pages:          25\n', stderr: '', code: 0 });
        mockRender.mockResolvedValue({
          success: true,
          images: [],
          bytesTruncated: false,
        });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { pages: '20-25', preparePdfForVisionBridge: true },
        );

        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(result.pdfVisionBridgeCandidate).toBeUndefined();
      });

      it('keeps text-heavy @ PDFs as reference (text-first, no render)', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          2\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: 'x'.repeat(80_000), stderr: '', code: 0 });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
          { preserveUnsupportedImage: true, largePdfBehavior: 'reference' },
        );

        expect(result.error).toBeUndefined();
        expect(result.returnDisplay).toContain('Referenced large PDF');
        expect(result.llmContent).toContain('too large to return safely');
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('does not render without the bridge flag (scanned stays an error)', async () => {
        actualNodeFs.writeFileSync(testPdfFilePath, Buffer.from('%PDF-1.7'));
        mockMimeGetType.mockReturnValue('application/pdf');
        mockExecResult({ stdout: 'Pages:          2\n', stderr: '', code: 0 });
        mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
        mockExecResult({ stdout: '   ', stderr: '', code: 0 });

        const result = await processSingleFileContent(
          testPdfFilePath,
          bridgeConfig,
        );

        expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
        expect(result.llmContent).toContain('Cannot extract text from PDF');
        expect(mockRender).not.toHaveBeenCalled();
      });

      it('does not preserve ordinary images with the PDF-only bridge flag', async () => {
        actualNodeFs.writeFileSync(testImageFilePath, Buffer.from('png'));
        mockMimeGetType.mockReturnValue('image/png');

        const result = await processSingleFileContent(
          testImageFilePath,
          bridgeConfig,
          { preparePdfForVisionBridge: true },
        );

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
      const testSvgFilePath = path.join(tempRootDir, 'test.svg');
      actualNodeFs.writeFileSync(testSvgFilePath, svgContent, 'utf-8');

      mockMimeGetType.mockReturnValue('image/svg+xml');

      const result = await processSingleFileContent(
        testSvgFilePath,
        mockConfig,
      );

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

      const result = await processSingleFileContent(
        testBinaryFilePath,
        mockConfig,
      );
      expect(result.llmContent).toContain(
        'Cannot display content of binary file',
      );
      expect(result.returnDisplay).toContain('Skipped binary file: app.exe');
    });

    it('should read text-looking .dat files as text', async () => {
      const filePath = path.join(tempRootDir, 'legacy-controller.dat');
      const content = '<?php echo "ok";\n';
      actualNodeFs.writeFileSync(filePath, content);
      mockMimeGetType.mockReturnValueOnce(null);

      const result = await processSingleFileContent(filePath, mockConfig);

      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.error).toBeUndefined();
    });

    it('should handle path being a directory', async () => {
      const result = await processSingleFileContent(directoryPath, mockConfig);
      expect(result.error).toContain('Path is a directory');
      expect(result.returnDisplay).toContain('Path is a directory');
    });

    it('should paginate text files correctly (offset and limit)', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 5, limit: 5 },
      ); // Read lines 6-10
      const expectedContent = lines.slice(5, 10).join('\n');

      expect(result.llmContent).toBe(expectedContent);
      expect(result.returnDisplay).toBe('Read lines 6-10 of 20 from test.txt');
      expect(result.isTruncated).toBe(true);
      expect(result.originalLineCount).toBe(20);
      expect(result.linesShown).toEqual([6, 10]);
    });

    it('should preserve legacy positional pagination arguments', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
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
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      // Read from line 11 to 20. The start is not 0, so it's truncated.
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 10, limit: 10 },
      );
      const expectedContent = lines.slice(10, 20).join('\n');

      expect(result.llmContent).toContain(expectedContent);
      expect(result.returnDisplay).toBe('Read lines 11-20 of 20 from test.txt');
      expect(result.isTruncated).toBe(true); // This is the key check for the bug
      expect(result.originalLineCount).toBe(20);
      expect(result.linesShown).toEqual([11, 20]);
    });

    it('should handle limit exceeding file length', async () => {
      const lines = ['Line 1', 'Line 2'];
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 0, limit: 10 },
      );
      const expectedContent = lines.join('\n');

      expect(result.llmContent).toBe(expectedContent);
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
      expect(result.originalLineCount).toBe(2);
      expect(result.linesShown).toEqual([1, 2]);
    });

    it('should preserve default full file-system reads for large text files', async () => {
      const content = `head\n${'x'.repeat(11 * 1024 * 1024)}`;
      actualNodeFs.writeFileSync(testTextFilePath, content);

      const result = await fsService.readTextFile({ path: testTextFilePath });

      expect(result.content).toBe(content);
      expect(result._meta?.originalLineCount).toBe(2);
      expect(result._meta?.originalLineCountExact).toBe(true);
      expect(result._meta?.truncatedByBytes).not.toBe(true);
    });

    it('should stream explicit offset reads for large text files', async () => {
      actualNodeFs.writeFileSync(
        testTextFilePath,
        `skip\n${'line\n'.repeat(3 * 1024 * 1024)}`,
      );

      const result = await fsService.readTextFile({
        path: testTextFilePath,
        line: 1,
      });

      expect(result.content.startsWith('line\n')).toBe(true);
      expect(result.content.startsWith('skip\n')).toBe(false);
      expect(result._meta?.originalLineCountExact).toBe(false);
      expect(result._meta?.truncatedByBytes).toBe(true);
    });

    it('should preserve unbounded explicit line-zero reads below the large-file threshold', async () => {
      const content = `head\n${'body\n'.repeat(6_000)}tail\n`;
      actualNodeFs.writeFileSync(testTextFilePath, content);

      const result = await fsService.readTextFile({
        path: testTextFilePath,
        line: 0,
      });

      expect(result.content).toBe(content);
      expect(result._meta?.truncatedByBytes).not.toBe(true);
    });

    it('should enforce maxOutputBytes for default file-system reads below the large-file threshold', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'x'.repeat(100));

      const result = await fsService.readTextFile({
        path: testTextFilePath,
        maxOutputBytes: 10,
      });

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
      const repeatCount = Math.ceil((11 * 1024 * 1024) / gbkChunk.length);
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

    it('should propagate aborts from unbounded full reads', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'hello\nworld');
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

    it('should propagate aborts before large unbounded full reads', async () => {
      actualNodeFs.writeFileSync(
        testTextFilePath,
        'x'.repeat(11 * 1024 * 1024),
      );
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
      actualNodeFs.writeFileSync(testTextFilePath, content, 'utf-8');

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
      );

      expect(result.llmContent).toBe(content);
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
    });

    it('should truncate long lines in text files', async () => {
      const longLine = 'a'.repeat(2500);
      actualNodeFs.writeFileSync(
        testTextFilePath,
        `Short line\n${longLine}\nAnother short line`,
      );

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
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

    it('should truncate when line count exceeds the limit', async () => {
      const lines = Array.from({ length: 11 }, (_, i) => `Line ${i + 1}`);
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      // Read 5 lines, but there are 11 total
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 0, limit: 5 },
      );

      expect(result.isTruncated).toBe(true);
      expect(result.returnDisplay).toBe('Read lines 1-5 of 11 from test.txt');
    });

    it('should truncate when a line length exceeds the character limit', async () => {
      const longLine = 'b'.repeat(2500);
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      lines.push(longLine); // Total 11 lines
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      // Read all 11 lines, including the long one
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 0, limit: 11 },
      );

      expect(result.isTruncated).toBe(true);
      expect(result.returnDisplay).toBe(
        'Read lines 1-11 of 11 from test.txt (truncated)',
      );
    });

    it('should truncate both line count and line length when both exceed limits', async () => {
      const linesWithLongInMiddle = Array.from(
        { length: 20 },
        (_, i) => `Line ${i + 1}`,
      );
      linesWithLongInMiddle[4] = 'c'.repeat(2500);
      actualNodeFs.writeFileSync(
        testTextFilePath,
        linesWithLongInMiddle.join('\n'),
      );

      // Read 10 lines out of 20, including the long line
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        { offset: 0, limit: 10 },
      );
      expect(result.isTruncated).toBe(true);
      expect(result.returnDisplay).toBe(
        'Read lines 1-5 of 20 from test.txt (truncated)',
      );
    });

    it('should read large text files through bounded truncation instead of the 10MB gate', async () => {
      const lines = Array.from(
        { length: 65_000 },
        (_, index) => `Line ${index + 1} ${'x'.repeat(180)}`,
      );
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
      );

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
      actualNodeFs.writeFileSync(
        testTextFilePath,
        'x'.repeat(11 * 1024 * 1024),
      );
      const noLineLimitConfig = {
        ...mockConfig,
        getTruncateToolOutputLines: () => Number.POSITIVE_INFINITY,
      } as unknown as Config;

      const result = await processSingleFileContent(
        testTextFilePath,
        noLineLimitConfig,
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
      actualNodeFs.writeFileSync(testTextFilePath, 'visible');
      const byteTruncatedConfig = {
        ...mockConfig,
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
      } as unknown as Config;

      const result = await processSingleFileContent(
        testTextFilePath,
        byteTruncatedConfig,
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
      actualNodeFs.writeFileSync(
        testTextFilePath,
        'x'.repeat(11 * 1024 * 1024),
      );
      const missingMetadataConfig = {
        ...mockConfig,
        getFileSystemService: () => ({
          readTextFile: vi.fn().mockResolvedValue({
            content: 'visible\nnext',
          }),
        }),
      } as unknown as Config;

      const result = await processSingleFileContent(
        testTextFilePath,
        missingMetadataConfig,
        { offset: 9, limit: 2 },
      );

      expect(result.originalLineCount).toBe(11);
      expect(result.originalLineCountExact).toBe(false);
      expect(result.returnDisplay).toBe(
        'Read lines 10-11 of at least 11 from test.txt',
      );
    });

    it('should preserve disabled output truncation for large text files', async () => {
      const byteLength = 11 * 1024 * 1024;
      actualNodeFs.writeFileSync(testTextFilePath, 'x'.repeat(byteLength));
      const noCharacterLimitConfig = {
        ...mockConfig,
        getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
      } as unknown as Config;

      const result = await processSingleFileContent(
        testTextFilePath,
        noCharacterLimitConfig,
      );

      expect(typeof result.llmContent).toBe('string');
      const llmContent = result.llmContent as string;
      expect(llmContent).toHaveLength(byteLength);
      expect(llmContent).not.toContain('... [truncated]');
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
    });

    it('should still return an error if an inline media file exceeds 10MB', async () => {
      mockMimeGetType.mockReturnValue('image/png');
      actualNodeFs.writeFileSync(
        testImageFilePath,
        Buffer.alloc(11 * 1024 * 1024),
      );

      const result = await processSingleFileContent(
        testImageFilePath,
        mockConfig,
      );

      expect(result.error).toContain('File size exceeds the 10MB limit');
      expect(result.returnDisplay).toContain(
        'File size exceeds the 10MB limit',
      );
      expect(result.llmContent).toContain('File size exceeds the 10MB limit');
    });

    it('should allow explicit page ranges above the full-PDF text-extraction size cap', async () => {
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');
      mockExecResult({ stdout: '', stderr: 'pdftotext version', code: 0 });
      mockExecResult({ stdout: 'selected page text', stderr: '', code: 0 });

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 200 * 1024 * 1024,
        isDirectory: () => false,
        isFile: () => true,
      } as fs.Stats);

      try {
        const mockConfigNoPdf = {
          ...mockConfig,
          getContentGeneratorConfig: () => ({
            modalities: { image: true },
          }),
        } as unknown as Config;

        const result = await processSingleFileContent(
          testPdfFilePath,
          mockConfigNoPdf,
          { pages: '1-5' },
        );

        expect(result.error).toBeUndefined();
        expect(result.llmContent).toBe('selected page text');
        expect(result.returnDisplay).toContain('Read pdf as text (pages 1-5)');
      } finally {
        statSpy.mockRestore();
      }
    });

    it('should reject non-regular files (FIFOs, devices, sockets)', async () => {
      actualNodeFs.writeFileSync(testTextFilePath, 'placeholder');

      // A FIFO / socket / /dev/zero shows up as a non-file, non-directory
      // stat entry. stats.size is typically 0 or meaningless, so without
      // this guard a caller could accidentally stream /dev/zero through
      // pdftotext until the timeout fires.
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 0,
        isDirectory: () => false,
        isFile: () => false,
      } as fs.Stats);

      try {
        const result = await processSingleFileContent(
          testTextFilePath,
          mockConfig,
        );

        expect(result.error).toMatch(/not a regular file/i);
        expect(result.returnDisplay).toMatch(/not a regular file/i);
      } finally {
        statSpy.mockRestore();
      }
    });
  });
});
