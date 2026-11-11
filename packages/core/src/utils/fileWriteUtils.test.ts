/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectLineEndingsForString,
  detectFileEncoding,
  detectLineEndings,
  detectNotText,
  notTextReadNote,
  notTextWriteRefusal,
  preserveBOM,
  resolveSymlink,
  resolveSymlinkWithInfo,
  writeFileSyncAtomic,
  writeFileAtomic,
  writeTextContent,
  readFileWithMetadata,
  type SyncAtomicWriteDiagnostic,
} from './fileWriteUtils.js';

// '// 刷新时间' encoded as GBK (CP936), which is not valid UTF-8.
const GBK_COMMENT = Buffer.from([
  0x2f, 0x2f, 0x20, 0xcb, 0xa2, 0xd0, 0xc2, 0xca, 0xb1, 0xbc, 0xe4,
]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

describe('fileWriteUtils', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
    vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileWriteUtils-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('detectLineEndingsForString', () => {
    it('should detect LF line endings', () => {
      expect(detectLineEndingsForString('line1\nline2\nline3\n')).toBe('LF');
    });

    it('should detect CRLF line endings', () => {
      expect(detectLineEndingsForString('line1\r\nline2\r\nline3\r\n')).toBe(
        'CRLF',
      );
    });

    it('should return LF for empty string', () => {
      expect(detectLineEndingsForString('')).toBe('LF');
    });

    it('should return LF for string without line endings', () => {
      expect(detectLineEndingsForString('no newlines')).toBe('LF');
    });

    it('should detect dominant style in mixed content', () => {
      // 2 CRLF vs 1 LF → CRLF
      expect(detectLineEndingsForString('a\r\nb\r\nc\n')).toBe('CRLF');
      // 1 CRLF vs 2 LF → LF
      expect(detectLineEndingsForString('a\r\nb\nc\n')).toBe('LF');
    });
  });

  describe('detectFileEncoding', () => {
    it('should detect utf8 for plain text file', () => {
      const filePath = path.join(tempDir, 'plain.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf8');
      expect(detectFileEncoding(filePath)).toBe('utf8');
    });

    it('should detect utf8 for file with UTF-8 BOM', () => {
      const filePath = path.join(tempDir, 'utf8bom.txt');
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from('hello', 'utf8');
      fs.writeFileSync(filePath, Buffer.concat([bom, content]));
      expect(detectFileEncoding(filePath)).toBe('utf8');
    });

    it('should detect utf16le for file with UTF-16 LE BOM', () => {
      const filePath = path.join(tempDir, 'utf16le.txt');
      const bom = Buffer.from([0xff, 0xfe]);
      const content = Buffer.from('hello', 'utf16le');
      fs.writeFileSync(filePath, Buffer.concat([bom, content]));
      expect(detectFileEncoding(filePath)).toBe('utf16le');
    });

    it('should return utf8 for non-existent file', () => {
      expect(detectFileEncoding('/nonexistent/file.txt')).toBe('utf8');
    });
  });

  describe('detectLineEndings', () => {
    it('should detect LF from file', () => {
      const filePath = path.join(tempDir, 'lf.txt');
      fs.writeFileSync(filePath, 'a\nb\nc\n');
      expect(detectLineEndings(filePath)).toBe('LF');
    });

    it('should detect CRLF from file', () => {
      const filePath = path.join(tempDir, 'crlf.txt');
      fs.writeFileSync(filePath, 'a\r\nb\r\nc\r\n');
      expect(detectLineEndings(filePath)).toBe('CRLF');
    });
  });

  describe('resolveSymlink', () => {
    it('should return the path itself for regular files', () => {
      const filePath = path.join(tempDir, 'regular.txt');
      fs.writeFileSync(filePath, 'content');
      expect(resolveSymlink(filePath)).toBe(filePath);
    });

    it('should resolve symlink to target', () => {
      const targetPath = path.join(tempDir, 'target.txt');
      const linkPath = path.join(tempDir, 'link.txt');
      fs.writeFileSync(targetPath, 'content');
      fs.symlinkSync(targetPath, linkPath);
      expect(resolveSymlink(linkPath)).toBe(targetPath);
    });

    it('should return path as-is for non-existent files', () => {
      const nonexistent = path.join(tempDir, 'nonexistent.txt');
      expect(resolveSymlink(nonexistent)).toBe(nonexistent);
    });
  });

  describe('resolveSymlinkWithInfo', () => {
    it('should return isSymlink: false for regular files', () => {
      const filePath = path.join(tempDir, 'regular.txt');
      fs.writeFileSync(filePath, 'content');
      const result = resolveSymlinkWithInfo(filePath);
      expect(result.isSymlink).toBe(false);
      expect(result.resolvedPath).toBe(filePath);
    });

    it('should return isSymlink: true for symlinks', () => {
      const targetPath = path.join(tempDir, 'target.txt');
      const linkPath = path.join(tempDir, 'link.txt');
      fs.writeFileSync(targetPath, 'content');
      fs.symlinkSync(targetPath, linkPath);
      const result = resolveSymlinkWithInfo(linkPath);
      expect(result.isSymlink).toBe(true);
      expect(result.resolvedPath).toBe(targetPath);
    });
  });

  describe('writeFileSyncAtomic', () => {
    it('诊断记录写入边界且不泄露文件路径或内容', () => {
      const filePath = path.join(tempDir, 'state.json');
      fs.writeFileSync(filePath, 'old');
      const before = fs.statSync(filePath);
      const events: SyncAtomicWriteDiagnostic[] = [];
      writeFileSyncAtomic(filePath, '私密内容', {
        encoding: 'utf8',
        onDiagnostic: (event) => events.push(event),
      });
      expect(events).toEqual([
        expect.objectContaining({
          event: 'begin',
          stage: 'write-temp',
          previousByteLength: before.size,
          previousMtimeMs: before.mtimeMs,
          byteLength: Buffer.byteLength('私密内容'),
        }),
        expect.objectContaining({ event: 'complete', stage: 'rename' }),
      ]);
      expect(JSON.stringify(events)).not.toContain(filePath);
      expect(JSON.stringify(events)).not.toContain('私密内容');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('私密内容');
    });

    it('进入直接覆盖前记录原始失败并保留成功回退语义', () => {
      const filePath = path.join(tempDir, 'state.json');
      fs.writeFileSync(filePath, 'old');
      const events: SyncAtomicWriteDiagnostic[] = [];
      vi.mocked(renameSync).mockImplementation(() => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      });
      const originalWrite = fs.writeFileSync;
      vi.mocked(writeFileSync).mockImplementation((target, data, options) => {
        if (target === filePath) {
          expect(events).toContainEqual(
            expect.objectContaining({
              event: 'fallback',
              stage: 'rename',
              errorCode: 'EBUSY',
            }),
          );
        }
        return originalWrite(target, data, options);
      });
      writeFileSyncAtomic(filePath, 'new', {
        encoding: 'utf8',
        onDiagnostic: (event) => events.push(event),
      });
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'complete', stage: 'write-direct' }),
      );
      expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
    });

    it('最终失败记录覆盖阶段并原样传播异常', () => {
      const filePath = path.join(tempDir, 'state.json');
      fs.writeFileSync(filePath, 'old');
      const events: SyncAtomicWriteDiagnostic[] = [];
      const failure = Object.assign(new Error('full'), { code: 'ENOSPC' });
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw failure;
      });
      expect(() =>
        writeFileSyncAtomic(filePath, 'new', {
          encoding: 'utf8',
          onDiagnostic: (event) => events.push(event),
        }),
      ).toThrow(failure);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'fallback',
          stage: 'write-temp',
          errorCode: 'ENOSPC',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'failed',
          stage: 'write-direct',
          errorCode: 'ENOSPC',
        }),
      );
    });

    it('诊断异常不触发回退或改变写入结果', () => {
      const filePath = path.join(tempDir, 'state.json');
      const rename = vi.mocked(renameSync);
      writeFileSyncAtomic(filePath, 'new', {
        encoding: 'utf8',
        onDiagnostic: () => {
          throw new Error('logger failed');
        },
      });
      expect(rename).toHaveBeenCalled();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
    });

    it('should write a new file', () => {
      const filePath = path.join(tempDir, 'new.txt');
      writeFileSyncAtomic(filePath, 'hello');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
    });

    it('should overwrite an existing file', () => {
      const filePath = path.join(tempDir, 'existing.txt');
      fs.writeFileSync(filePath, 'old');
      writeFileSyncAtomic(filePath, 'new');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
    });

    it('should preserve file permissions', () => {
      const filePath = path.join(tempDir, 'perms.txt');
      fs.writeFileSync(filePath, 'content');
      fs.chmodSync(filePath, 0o755);
      writeFileSyncAtomic(filePath, 'updated');
      const mode = fs.statSync(filePath).mode;
      expect(mode & 0o111).toBe(0o111); // execute bits preserved
    });

    it('should write through symlink to target', () => {
      const targetPath = path.join(tempDir, 'target.txt');
      const linkPath = path.join(tempDir, 'link.txt');
      fs.writeFileSync(targetPath, 'original');
      fs.symlinkSync(targetPath, linkPath);
      writeFileSyncAtomic(linkPath, 'via symlink');
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('via symlink');
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });
  });

  describe('writeFileAtomic', () => {
    it('creates a new file with the requested mode, and keeps an existing file\'s', async () => {
      const created = path.join(tempDir, 'secret.json');
      await writeFileAtomic(created, '{}', { encoding: 'utf8', mode: 0o600 });
      expect(fs.statSync(created).mode & 0o777).toBe(0o600);

      const existing = path.join(tempDir, 'shared.json');
      fs.writeFileSync(existing, 'old', { mode: 0o644 });
      fs.chmodSync(existing, 0o644);
      await writeFileAtomic(existing, 'new', { encoding: 'utf8', mode: 0o600 });
      expect(fs.statSync(existing).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(existing, 'utf8')).toBe('new');
    });

    it.each([
      new Error('content changed'),
      Object.assign(new Error('read denied'), { code: 'EACCES' }),
      Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    ])('does not retry a failed write guard: %s', async (error) => {
      const filePath = path.join(tempDir, 'guarded.txt');
      fs.writeFileSync(filePath, 'original');
      const rename = vi.spyOn(fs.promises, 'rename');
      const beforeWrite = vi
        .fn()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockImplementation(() => {});

      await expect(
        writeFileAtomic(filePath, 'replacement', {
          encoding: 'utf8',
          beforeWrite,
        }),
      ).rejects.toBe(error);

      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
      expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
      expect(fs.readdirSync(tempDir)).toEqual(['guarded.txt']);
    });

    it.each(['EXDEV', 'EPERM', 'EEXIST', 'EBUSY'])(
      'rechecks before falling back from rename %s',
      async (code) => {
        const filePath = path.join(tempDir, 'fallback.txt');
        fs.writeFileSync(filePath, 'original');
        vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
          Object.assign(new Error('rename failed'), { code }),
        );
        const beforeWrite = vi.fn();
        await writeFileAtomic(filePath, 'replacement', {
          encoding: 'utf8',
          beforeWrite,
        });
        expect(beforeWrite).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('replacement');
        expect(fs.readdirSync(tempDir)).toEqual(['fallback.txt']);
      },
    );

    it('preserves external changes when the fallback guard fails', async () => {
      const filePath = path.join(tempDir, 'fallback-conflict.txt');
      fs.writeFileSync(filePath, 'original');
      vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
        fs.writeFileSync(filePath, 'external');
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      });
      const conflict = new Error('changed before fallback');
      await expect(
        writeFileAtomic(filePath, 'replacement', {
          encoding: 'utf8',
          beforeWrite() {
            if (fs.readFileSync(filePath, 'utf8') !== 'original')
              throw conflict;
          },
        }),
      ).rejects.toBe(conflict);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('external');
      expect(fs.readdirSync(tempDir)).toEqual(['fallback-conflict.txt']);
    });

    it.each(['ENOSPC', 'EIO', 'EACCES'])(
      'does not truncate the target after rename %s',
      async (code) => {
        const filePath = path.join(tempDir, 'failed.txt');
        fs.writeFileSync(filePath, 'original');
        const error = Object.assign(new Error('rename failed'), { code });
        vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(error);
        await expect(writeFileAtomic(filePath, 'replacement')).rejects.toBe(
          error,
        );
        expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
        expect(fs.readdirSync(tempDir)).toEqual(['failed.txt']);
      },
    );

    it.each([true, false])(
      'only falls back from staging EACCES for an existing file (exists=%s)',
      async (exists) => {
        const filePath = path.join(tempDir, 'staging.txt');
        if (exists) fs.writeFileSync(filePath, 'original');
        const error = Object.assign(new Error('staging denied'), {
          code: 'EACCES',
        });
        vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(error);
        const beforeWrite = vi.fn();
        const writing = writeFileAtomic(filePath, 'replacement', {
          encoding: 'utf8',
          beforeWrite,
        });
        if (exists) {
          await writing;
          expect(beforeWrite).toHaveBeenCalledTimes(1);
          expect(fs.readFileSync(filePath, 'utf8')).toBe('replacement');
        } else {
          await expect(writing).rejects.toBe(error);
          expect(beforeWrite).not.toHaveBeenCalled();
          expect(fs.existsSync(filePath)).toBe(false);
        }
      },
    );

    it('does not fall back after a partial staging write fails', async () => {
      const filePath = path.join(tempDir, 'partial.txt');
      fs.writeFileSync(filePath, 'original');
      const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(
        async (temp) => {
          fs.writeFileSync(String(temp), 'partial');
          throw error;
        },
      );
      await expect(writeFileAtomic(filePath, 'replacement')).rejects.toBe(
        error,
      );
      expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
      expect(fs.readdirSync(tempDir)).toEqual(['partial.txt']);
    });

    it('should write a new file', async () => {
      const filePath = path.join(tempDir, 'new_async.txt');
      await writeFileAtomic(filePath, 'hello async');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('hello async');
    });

    it('should preserve file permissions', async () => {
      const filePath = path.join(tempDir, 'perms_async.txt');
      fs.writeFileSync(filePath, 'content');
      fs.chmodSync(filePath, 0o755);
      await writeFileAtomic(filePath, 'updated');
      const mode = fs.statSync(filePath).mode;
      expect(mode & 0o111).toBe(0o111);
    });
  });

  describe('writeTextContent', () => {
    it('should write LF content as-is', async () => {
      const filePath = path.join(tempDir, 'lf_write.txt');
      await writeTextContent(filePath, 'a\nb\nc\n', 'utf8', 'LF');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('a\nb\nc\n');
    });

    it('should convert LF to CRLF when endings is CRLF', async () => {
      const filePath = path.join(tempDir, 'crlf_write.txt');
      await writeTextContent(filePath, 'a\nb\nc\n', 'utf8', 'CRLF');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('a\r\nb\r\nc\r\n');
    });

    it('should not double-convert existing CRLF in content', async () => {
      const filePath = path.join(tempDir, 'double_crlf.txt');
      // Content already has some CRLF — should normalize first, then convert
      await writeTextContent(filePath, 'a\r\nb\nc\n', 'utf8', 'CRLF');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('a\r\nb\r\nc\r\n');
    });
  });

  describe('readFileWithMetadata', () => {
    it('should read utf8 file with LF endings', () => {
      const filePath = path.join(tempDir, 'read_lf.txt');
      fs.writeFileSync(filePath, 'a\nb\nc\n');
      const result = readFileWithMetadata(filePath);
      expect(result.content).toBe('a\nb\nc\n');
      expect(result.encoding).toBe('utf8');
      expect(result.lineEndings).toBe('LF');
    });

    it('should read file with CRLF and normalize to LF', () => {
      const filePath = path.join(tempDir, 'read_crlf.txt');
      fs.writeFileSync(filePath, 'a\r\nb\r\nc\r\n');
      const result = readFileWithMetadata(filePath);
      expect(result.content).toBe('a\nb\nc\n'); // CRLF normalized to LF
      expect(result.lineEndings).toBe('CRLF'); // But detected as CRLF
    });

    it('should resolve symlink and read target', () => {
      const targetPath = path.join(tempDir, 'target_read.txt');
      const linkPath = path.join(tempDir, 'link_read.txt');
      fs.writeFileSync(targetPath, 'target content\n');
      fs.symlinkSync(targetPath, linkPath);
      const result = readFileWithMetadata(linkPath);
      expect(result.content).toBe('target content\n');
    });

    it('flags BOM-less legacy bytes but keeps UTF-8 and UTF-16LE text', () => {
      const legacy = path.join(tempDir, 'legacy.cs');
      fs.writeFileSync(legacy, Buffer.concat([GBK_COMMENT, Buffer.from('\r\n')]));
      expect(readFileWithMetadata(legacy).notText).toBe('not_utf8');

      const utf8 = path.join(tempDir, 'utf8.cs');
      fs.writeFileSync(utf8, '\uFEFF// 刷新时间\r\n');
      expect(readFileWithMetadata(utf8)).toEqual({
        content: '\uFEFF// 刷新时间\n',
        encoding: 'utf8',
        lineEndings: 'CRLF',
      });

      const utf16 = path.join(tempDir, 'utf16.cs');
      fs.writeFileSync(utf16, Buffer.from('\uFEFF// 刷新时间\r\n', 'utf16le'));
      expect(readFileWithMetadata(utf16)).toEqual({
        content: '\uFEFF// 刷新时间\n',
        encoding: 'utf16le',
        lineEndings: 'CRLF',
      });
    });
  });

  describe('detectNotText', () => {
    it.each([
      ['GBK bytes', GBK_COMMENT, 'not_utf8'],
      ['UTF-16BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x61]), 'utf16be'],
      ['NUL in the head', Buffer.from('a\0b'), 'nul'],
      ['empty file', Buffer.alloc(0), undefined],
      ['UTF-8 with BOM', Buffer.from('\uFEFF刷新时间'), undefined],
      ['UTF-16LE BOM', Buffer.from('\uFEFF\0a', 'utf16le'), undefined],
    ] as const)('classifies %s', (_name, bytes, expected) => {
      expect(detectNotText(bytes)).toBe(expected);
    });

    it('ignores NUL bytes after the first 8000 bytes', () => {
      const bytes = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]);
      expect(detectNotText(bytes)).toBeUndefined();
    });
  });

  describe('preserveBOM', () => {
    it.each([
      ['\uFEFForiginal', 'replacement', '\uFEFFreplacement'],
      ['\uFEFForiginal', '\uFEFFreplacement', '\uFEFFreplacement'],
      ['\uFEFForiginal', '', ''],
      ['original', 'replacement', 'replacement'],
      ['', 'replacement', 'replacement'],
    ])('preserves the original BOM without adding it to empty content', (original, content, expected) => {
      expect(preserveBOM(original, content)).toBe(expected);
    });
  });

  describe('not-text messages', () => {
    it('tells the model nothing was written and how to proceed', () => {
      expect(notTextWriteRefusal('not_utf8')).toBe(
        "File is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.",
      );
    });

    it('mentions U+FFFD in the Read note only for undecodable bytes', () => {
      expect(notTextReadNote('not_utf8')).toBe(
        '[This file is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. Its undecodable bytes show above as U+FFFD. Edit and Write will refuse it: change it with a shell command that keeps its encoding, or ask the user whether to convert it to UTF-8.]',
      );
      expect(notTextReadNote('utf16be')).toBe(
        '[This file is UTF-16 big-endian (it starts FE FF), which these tools cannot write. Edit and Write will refuse it: change it with a shell command that keeps its encoding, or ask the user whether to convert it to UTF-8.]',
      );
    });
  });
});
