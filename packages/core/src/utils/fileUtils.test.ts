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
import path from 'node:path';
import os from 'node:os';
import mime from 'mime/lite';

import {
  isWithinRoot,
  isBinaryFile,
  detectFileType,
  processSingleFileContent,
  detectBOM,
  readFileWithEncoding,
  readFileWithEncodingInfo,
  detectFileEncoding,
  fileExists,
} from './fileUtils.js';
import type { Config } from '../config/config.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';

vi.mock('mime/lite', () => ({
  default: { getType: vi.fn() },
  getType: vi.fn(),
}));

const mockMimeGetType = mime.getType as Mock;

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
  });

  describe('processSingleFileContent', () => {
    beforeEach(() => {
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
          undefined,
          undefined,
          '1-5',
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

    it('should still reject oversized PDFs when routing to the native base64 path', async () => {
      // When the model supports PDF modality and no pages arg is provided,
      // the base64 path applies and the 10MB inline-data cap still matters.
      const fakePdfData = Buffer.from('fake pdf data');
      actualNodeFs.writeFileSync(testPdfFilePath, fakePdfData);
      mockMimeGetType.mockReturnValue('application/pdf');

      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 15 * 1024 * 1024,
        isDirectory: () => false,
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
        5,
        5,
      ); // Read lines 6-10
      const expectedContent = lines.slice(5, 10).join('\n');

      expect(result.llmContent).toBe(expectedContent);
      expect(result.returnDisplay).toBe('Read lines 6-10 of 20 from test.txt');
      expect(result.isTruncated).toBe(true);
      expect(result.originalLineCount).toBe(20);
      expect(result.linesShown).toEqual([6, 10]);
    });

    it('should identify truncation when reading the end of a file', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      actualNodeFs.writeFileSync(testTextFilePath, lines.join('\n'));

      // Read from line 11 to 20. The start is not 0, so it's truncated.
      const result = await processSingleFileContent(
        testTextFilePath,
        mockConfig,
        10,
        10,
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
        0,
        10,
      );
      const expectedContent = lines.join('\n');

      expect(result.llmContent).toBe(expectedContent);
      expect(result.returnDisplay).toBe('');
      expect(result.isTruncated).toBe(false);
      expect(result.originalLineCount).toBe(2);
      expect(result.linesShown).toEqual([1, 2]);
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
        0,
        5,
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
        0,
        11,
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
        0,
        10,
      );
      expect(result.isTruncated).toBe(true);
      expect(result.returnDisplay).toBe(
        'Read lines 1-5 of 20 from test.txt (truncated)',
      );
    });

    it('should return an error if the file size exceeds 10MB', async () => {
      // Create a small test file
      actualNodeFs.writeFileSync(testTextFilePath, 'test content');

      // Spy on fs.promises.stat to return a large file size
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 11 * 1024 * 1024,
        isDirectory: () => false,
      } as fs.Stats);

      try {
        const result = await processSingleFileContent(
          testTextFilePath,
          mockConfig,
        );

        expect(result.error).toContain('File size exceeds the 10MB limit');
        expect(result.returnDisplay).toContain(
          'File size exceeds the 10MB limit',
        );
        expect(result.llmContent).toContain('File size exceeds the 10MB limit');
      } finally {
        statSpy.mockRestore();
      }
    });
  });
});
