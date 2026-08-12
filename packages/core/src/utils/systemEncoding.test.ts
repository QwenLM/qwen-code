/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import { detect as chardetDetect } from 'chardet';

// Mock dependencies
vi.mock('child_process');
vi.mock('os');
vi.mock('chardet');

// Import the functions we want to test after refactoring
import {
  getCachedEncodingForBuffer,
  getSystemEncoding,
  windowsCodePageToEncoding,
  detectEncodingFromBuffer,
  resetEncodingCache,
  decodeProcessOutput,
} from './systemEncoding.js';

// Node's Buffer has no 'utf16be' encoding, so build big-endian bytes from the
// little-endian encoding by swapping each 16-bit code unit.
function swapEndian(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

describe('Shell Command Processor - Encoding Functions', () => {
  let mockedExecSync: ReturnType<typeof vi.mocked<typeof execSync>>;
  let mockedOsPlatform: ReturnType<typeof vi.mocked<() => string>>;
  let mockedChardetDetect: ReturnType<typeof vi.mocked<typeof chardetDetect>>;

  beforeEach(() => {
    mockedExecSync = vi.mocked(execSync);
    mockedOsPlatform = vi.mocked(os.platform);
    mockedChardetDetect = vi.mocked(chardetDetect);

    // Reset the encoding cache before each test
    resetEncodingCache();

    // Clear environment variables that might affect tests
    delete process.env['LC_ALL'];
    delete process.env['LC_CTYPE'];
    delete process.env['LANG'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEncodingCache();
  });

  describe('windowsCodePageToEncoding', () => {
    it('should map common Windows code pages correctly', () => {
      expect(windowsCodePageToEncoding(65001)).toBe('utf-8');
      expect(windowsCodePageToEncoding(1252)).toBe('windows-1252');
      expect(windowsCodePageToEncoding(932)).toBe('shift_jis');
      expect(windowsCodePageToEncoding(936)).toBe('gbk');
      expect(windowsCodePageToEncoding(949)).toBe('euc-kr');
      expect(windowsCodePageToEncoding(950)).toBe('big5');
      expect(windowsCodePageToEncoding(1200)).toBe('utf-16le');
      expect(windowsCodePageToEncoding(1201)).toBe('utf-16be');
    });

    it('should return null for 437/850/852 (no WHATWG TextDecoder label)', () => {
      // Node's WHATWG TextDecoder rejects `cp437`/`cp850`/`cp852` with
      // RangeError, so returning these labels would make the system code page
      // authoritative for a label that cannot be decoded and silently fall
      // back to UTF-8 garbage. Null lets detection fall through to chardet.
      expect(windowsCodePageToEncoding(437)).toBe(null);
      expect(windowsCodePageToEncoding(850)).toBe(null);
      expect(windowsCodePageToEncoding(852)).toBe(null);
    });

    it('should return null for unmapped code pages and warn', () => {
      expect(windowsCodePageToEncoding(99999)).toBe(null);
    });

    it('should handle all Windows-specific code pages', () => {
      expect(windowsCodePageToEncoding(874)).toBe('windows-874');
      expect(windowsCodePageToEncoding(1250)).toBe('windows-1250');
      expect(windowsCodePageToEncoding(1251)).toBe('windows-1251');
      expect(windowsCodePageToEncoding(1253)).toBe('windows-1253');
      expect(windowsCodePageToEncoding(1254)).toBe('windows-1254');
      expect(windowsCodePageToEncoding(1255)).toBe('windows-1255');
      expect(windowsCodePageToEncoding(1256)).toBe('windows-1256');
      expect(windowsCodePageToEncoding(1257)).toBe('windows-1257');
      expect(windowsCodePageToEncoding(1258)).toBe('windows-1258');
    });
  });

  describe('detectEncodingFromBuffer', () => {
    it('should detect encoding using chardet successfully', () => {
      const buffer = Buffer.from('test content', 'utf8');
      mockedChardetDetect.mockReturnValue('UTF-8');

      const result = detectEncodingFromBuffer(buffer);
      expect(result).toBe('utf-8');
      expect(mockedChardetDetect).toHaveBeenCalledWith(buffer);
    });

    it('should handle chardet returning mixed case encoding', () => {
      const buffer = Buffer.from('test content', 'utf8');
      mockedChardetDetect.mockReturnValue('ISO-8859-1');

      const result = detectEncodingFromBuffer(buffer);
      expect(result).toBe('iso-8859-1');
    });

    it('should return null when chardet fails', () => {
      const buffer = Buffer.from('test content', 'utf8');
      mockedChardetDetect.mockImplementation(() => {
        throw new Error('Detection failed');
      });

      const result = detectEncodingFromBuffer(buffer);
      expect(result).toBe(null);
    });

    it('should return null when chardet returns null', () => {
      const buffer = Buffer.from('test content', 'utf8');
      mockedChardetDetect.mockReturnValue(null);

      const result = detectEncodingFromBuffer(buffer);
      expect(result).toBe(null);
    });

    it('should return null when chardet returns non-string', () => {
      const buffer = Buffer.from('test content', 'utf8');
      mockedChardetDetect.mockReturnValue([
        'utf-8',
        'iso-8859-1',
      ] as unknown as string);

      const result = detectEncodingFromBuffer(buffer);
      expect(result).toBe(null);
    });

    it('should sample head, middle, and tail for buffers larger than 2x the chardet sample cap', () => {
      // A buffer larger than 2 × CHARDET_SAMPLE_BYTES must feed chardet a
      // bounded head+middle+tail sample, not just head+tail, so foreign content
      // concentrated in the middle of large buffers is still detected. The
      // foreign bytes are placed inside the tail window the sample actually
      // reaches, and the assertion checks the sample CONTAINS them (not just
      // the call shape), so a regression that drops the tail window turns red.
      const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
      const buffer = Buffer.concat([
        chunk,
        chunk,
        Buffer.from('тест', 'utf-8'),
      ]);
      mockedChardetDetect.mockReturnValue('UTF-8');

      detectEncodingFromBuffer(buffer);

      const middleStart =
        Math.floor(buffer.length / 2) - Math.floor((64 * 1024) / 2);
      const expectedSample = Buffer.concat([
        buffer.subarray(0, 64 * 1024),
        buffer.subarray(middleStart, middleStart + 64 * 1024),
        buffer.subarray(buffer.length - 64 * 1024),
      ]);
      expect(mockedChardetDetect).toHaveBeenCalledWith(expectedSample);
      // The tail window must actually carry the foreign bytes.
      expect(
        expectedSample.subarray(expectedSample.length - 8).toString('utf8'),
      ).toBe('тест');
    });
  });

  describe('getSystemEncoding - Windows', () => {
    beforeEach(() => {
      mockedOsPlatform.mockReturnValue('win32');
    });

    it('should parse Windows chcp output correctly', () => {
      mockedExecSync.mockReturnValue('Active code page: 65001');

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
      expect(mockedExecSync).toHaveBeenCalledWith('chcp', { encoding: 'utf8' });
    });

    it('should handle different chcp output formats', () => {
      mockedExecSync.mockReturnValue('Current code page: 1252');

      const result = getSystemEncoding();
      expect(result).toBe('windows-1252');
    });

    it('should handle chcp output with extra whitespace', () => {
      mockedExecSync.mockReturnValue('Active code page:   437   ');

      const result = getSystemEncoding();
      // 437 has no WHATWG TextDecoder label → null.
      expect(result).toBe(null);
    });

    it('should return null when chcp command fails', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('Command failed');
      });

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should return null when chcp output cannot be parsed', () => {
      mockedExecSync.mockReturnValue('Unexpected output format');

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should return null when code page is not a number', () => {
      mockedExecSync.mockReturnValue('Active code page: abc');

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should return null when code page maps to null', () => {
      mockedExecSync.mockReturnValue('Active code page: 99999');

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });
  });

  describe('getSystemEncoding - Unix-like', () => {
    beforeEach(() => {
      mockedOsPlatform.mockReturnValue('linux');
    });

    it('should parse locale from LC_ALL environment variable', () => {
      process.env['LC_ALL'] = 'en_US.UTF-8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should parse locale from LC_CTYPE when LC_ALL is not set', () => {
      process.env['LC_CTYPE'] = 'fr_FR.ISO-8859-1';

      const result = getSystemEncoding();
      expect(result).toBe('iso-8859-1');
    });

    it('should parse locale from LANG when LC_ALL and LC_CTYPE are not set', () => {
      process.env['LANG'] = 'de_DE.UTF-8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should handle locale charmap command when environment variables are empty', () => {
      mockedExecSync.mockReturnValue('UTF-8\n');

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
      expect(mockedExecSync).toHaveBeenCalledWith('locale charmap', {
        encoding: 'utf8',
      });
    });

    it('should handle locale charmap with mixed case', () => {
      mockedExecSync.mockReturnValue('ISO-8859-1\n');

      const result = getSystemEncoding();
      expect(result).toBe('iso-8859-1');
    });

    it('should return null when locale charmap fails', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('Command failed');
      });

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should handle locale without encoding (no dot)', () => {
      process.env['LANG'] = 'C';

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should treat POSIX locale as having no decodable encoding', () => {
      process.env['LANG'] = 'POSIX';

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should normalize the utf8 alias to utf-8', () => {
      // Debian/locale spellings like en_US.utf8 produce the codeset 'utf8',
      // a valid TextDecoder label but NOT the string 'utf-8' — the system
      // gate compares against 'utf-8', so it must be normalized or the gate
      // would wrongly treat a UTF-8 system as non-UTF-8.
      process.env['LANG'] = 'en_US.utf8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should treat ANSI_X3.4-1968 charmap (C locale) as no encoding', () => {
      // LANG unset falls back to `locale charmap`, which on a C/POSIX host
      // reports 'ANSI_X3.4-1968' (plain ASCII). ASCII-family names either
      // have no decodable foreign codepage or resolve to windows-1252 via
      // WHATWG normalization; returning one would make the system gate force
      // a windows-1252 decode of genuinely foreign bytes.
      mockedExecSync.mockReturnValue('ANSI_X3.4-1968\n');

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should handle empty locale environment variables', () => {
      process.env['LC_ALL'] = '';
      process.env['LC_CTYPE'] = '';
      process.env['LANG'] = '';
      mockedExecSync.mockReturnValue('UTF-8');

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should return null when locale format has no codeset', () => {
      process.env['LANG'] = 'invalid_format';

      const result = getSystemEncoding();
      expect(result).toBe(null);
    });

    it('should prioritize LC_ALL over other environment variables', () => {
      process.env['LC_ALL'] = 'en_US.UTF-8';
      process.env['LC_CTYPE'] = 'fr_FR.ISO-8859-1';
      process.env['LANG'] = 'de_DE.CP1252';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should prioritize LC_CTYPE over LANG', () => {
      process.env['LC_CTYPE'] = 'fr_FR.ISO-8859-1';
      process.env['LANG'] = 'de_DE.CP1252';

      const result = getSystemEncoding();
      expect(result).toBe('iso-8859-1');
    });
  });

  describe('getEncodingForBuffer', () => {
    beforeEach(() => {
      mockedOsPlatform.mockReturnValue('linux');
    });

    it('should return utf-8 for valid UTF-8 buffers regardless of system encoding', () => {
      // System encoding is GBK, but buffer is valid UTF-8
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 936');

      const buffer = Buffer.from('Hello 你好', 'utf-8');
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });

    it('should return utf-8 for pure ASCII buffers', () => {
      // ASCII is valid UTF-8 — should return utf-8 immediately
      const buffer = Buffer.from('hello world');
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });

    it('should use cached system encoding on subsequent calls', () => {
      process.env['LANG'] = 'en_US.UTF-8';
      const buffer = Buffer.from('test');

      // First call
      const result1 = getCachedEncodingForBuffer(buffer);
      expect(result1).toBe('utf-8');

      // Change environment (should not affect cached result)
      process.env['LANG'] = 'fr_FR.ISO-8859-1';

      // Second call should use cached value
      const result2 = getCachedEncodingForBuffer(buffer);
      expect(result2).toBe('utf-8');
    });

    it('should fall back to buffer detection when system encoding fails', () => {
      // No environment variables set
      mockedExecSync.mockImplementation(() => {
        throw new Error('locale command failed');
      });

      // Use bytes that are NOT valid UTF-8 so the UTF-8-first check fails
      const buffer = Buffer.from([0x80, 0x81, 0x82]);
      mockedChardetDetect.mockReturnValue('ISO-8859-1');

      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('iso-8859-1');
      expect(mockedChardetDetect).toHaveBeenCalledWith(buffer);
    });

    it('should fall back to utf-8 when both system and buffer detection fail', () => {
      // System encoding fails
      mockedExecSync.mockImplementation(() => {
        throw new Error('locale command failed');
      });

      // Buffer detection fails
      mockedChardetDetect.mockImplementation(() => {
        throw new Error('chardet failed');
      });

      const buffer = Buffer.from('test');
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });

    it('should not cache buffer detection results', () => {
      // System encoding fails initially
      mockedExecSync.mockImplementation(() => {
        throw new Error('locale command failed');
      });

      // Use bytes that are NOT valid UTF-8 so the UTF-8-first check fails
      const buffer1 = Buffer.from([0x80, 0x81]);
      const buffer2 = Buffer.from([0x82, 0x83]);

      mockedChardetDetect
        .mockReturnValueOnce('ISO-8859-1')
        .mockReturnValueOnce('UTF-16');

      const result1 = getCachedEncodingForBuffer(buffer1);
      const result2 = getCachedEncodingForBuffer(buffer2);

      expect(result1).toBe('iso-8859-1');
      expect(result2).toBe('utf-16');
      expect(mockedChardetDetect).toHaveBeenCalledTimes(2);
    });

    it('should handle Windows system encoding', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 1252');

      // Use bytes that are NOT valid UTF-8 so the UTF-8-first check fails
      // and we fall through to system encoding detection
      const buffer = Buffer.from([0x80, 0x81, 0x82]);
      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('windows-1252');
    });

    it('returns system encoding for non-UTF-8 buffer on CP-866 Windows (before chardet)', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      // CP-866 encoded "Ошибка" — NOT valid UTF-8.
      const cp866Buf = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);

      const result = getCachedEncodingForBuffer(cp866Buf);

      // The system code page is authoritative and consulted before chardet,
      // which would otherwise guess windows-1252 (wrong for CP-866).
      expect(result).toBe('cp866');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('consults system encoding before chardet (chardet not called)', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 1252');
      const buffer = Buffer.from([0x80, 0x81, 0x82]);

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('windows-1252');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('returns utf-8 for valid UTF-8 buffer regardless of CP-866 system encoding', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      const utf8Buf = Buffer.from('Привет', 'utf-8');

      const result = getCachedEncodingForBuffer(utf8Buf);

      expect(result).toBe('utf-8');
    });

    it('falls back to chardet when system encoding is utf-8 (chcp 65001)', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 65001');
      mockedChardetDetect.mockReturnValue('ISO-8859-1');
      const buffer = Buffer.from([0x80, 0x81, 0x82]);

      const result = getCachedEncodingForBuffer(buffer);

      // The system encoding is UTF-8, so the `!== 'utf-8'` guard skips it and
      // chardet classifies the genuinely foreign data.
      expect(result).toBe('iso-8859-1');
      expect(mockedChardetDetect).toHaveBeenCalled();
    });

    it('uses chardet on Linux when system encoding is utf-8', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';
      mockedChardetDetect.mockReturnValue('ISO-8859-1');
      const buffer = Buffer.from([0x80, 0x81, 0x82]);

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('iso-8859-1');
      expect(mockedChardetDetect).toHaveBeenCalled();
    });

    it('caches system encoding across calls (chcp not re-run)', () => {
      mockedOsPlatform.mockReturnValue('win32');
      // 'chcp' returns 866 on every call; detection must consult it only once.
      mockedExecSync.mockReturnValue('Active code page: 866');
      const buffer1 = Buffer.from([0x8e, 0xe9, 0xa8]);
      const buffer2 = Buffer.from([0xa1, 0xaa, 0xa0]);

      getCachedEncodingForBuffer(buffer1);
      getCachedEncodingForBuffer(buffer2);

      expect(mockedExecSync).toHaveBeenCalledTimes(1);
    });

    it('should prioritize UTF-8 detection over Windows system encoding', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 936'); // GBK

      const buffer = Buffer.from('test');
      mockedChardetDetect.mockReturnValue('UTF-8');

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('utf-8');
    });

    it('should cache null system encoding result', () => {
      // Reset the cache specifically for this test
      resetEncodingCache();

      // Ensure we're on Unix-like for this test
      mockedOsPlatform.mockReturnValue('linux');

      // System encoding detection returns null
      mockedExecSync.mockImplementation(() => {
        throw new Error('locale command failed');
      });

      // Use bytes that are NOT valid UTF-8 so the UTF-8-first check fails
      const buffer1 = Buffer.from([0x80, 0x81]);
      const buffer2 = Buffer.from([0x82, 0x83]);

      mockedChardetDetect
        .mockReturnValueOnce('ISO-8859-1')
        .mockReturnValueOnce('UTF-16');

      // Clear any previous calls from beforeEach setup or previous tests
      mockedExecSync.mockClear();

      const result1 = getCachedEncodingForBuffer(buffer1);
      const result2 = getCachedEncodingForBuffer(buffer2);

      // System encoding is only checked as fallback after UTF-8 and chardet
      // both fail. Since chardet returns results here, execSync may not be called.
      expect(result1).toBe('iso-8859-1');
      expect(result2).toBe('utf-16');

      // Call a third time to verify chardet is called each time (not cached)
      const buffer3 = Buffer.from([0x84, 0x85]);
      mockedChardetDetect.mockReturnValueOnce('UTF-32');
      const result3 = getCachedEncodingForBuffer(buffer3);

      expect(result3).toBe('utf-32');
    });

    it('returns the system encoding for sparse OEM bytes in a large mostly-ASCII buffer', () => {
      // ~10 KiB ASCII log plus the 7 CP-866 bytes of "Каталог". The OEM bytes
      // are <1% of the buffer, so the replacement-ratio heuristic alone would
      // classify it as utf-8 — but the system code page is authoritative and
      // is consulted before the heuristic, so it must win.
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      const asciiLog = Buffer.alloc(10 * 1024, 0x61); // 'a'
      const cp866Name = Buffer.from([0x8a, 0xa0, 0xe2, 0xa0, 0xab, 0xae, 0xa3]);
      const buffer = Buffer.concat([asciiLog, cp866Name]);

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('cp866');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('returns utf-8 for a short mostly-valid buffer with a single stray byte (absolute allowance)', () => {
      // 1/88 ≈ 0.011 misses the strict <1% ratio, so without the absolute
      // allowance (replacements <= 2 && replacements * 2 < length) this short
      // buffer would be handed to chardet as wholesale non-UTF-8 and mojibake.
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';
      const body = Buffer.from(
        'line: normal utf-8 text here\n'.repeat(3),
        'utf-8',
      );
      const buffer = Buffer.concat([body, Buffer.from([0x93])]);
      expect(buffer.length).toBeLessThanOrEqual(101);
      mockedChardetDetect.mockReturnValue('windows-1252');

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('utf-8');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('detects UTF-16LE BOM output as utf-16, not utf-8', () => {
      // PowerShell 5.1 Out-File / Set-Content emits UTF-16LE with a BOM. The
      // ASCII-range payload (char + NUL) is valid UTF-8, so without the BOM
      // short-circuit the replacement-ratio heuristic would count only the 2
      // invalid BOM bytes and classify the output as utf-8, NUL-interleaving it.
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      const buffer = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Hello', 'utf16le'),
      ]);

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('utf-16');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('detects UTF-16BE BOM output as utf-16be, not utf-16', () => {
      // Big-endian UTF-16 (PowerShell 5.1 Out-File -Encoding BigEndianUnicode,
      // Notepad, MSVC tooling) emits a FE FF BOM. Node's WHATWG TextDecoder
      // treats 'utf-16' as an alias of utf-16le that does NOT read the byte
      // order from the BOM, so returning 'utf-16' here would decode the
      // big-endian payload byte-swapped. The FE FF branch must return the
      // explicit 'utf-16be' label.
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      const buffer = Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        swapEndian(Buffer.from('Hello', 'utf16le')),
      ]);

      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('utf-16be');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });
  });

  describe('Cross-platform behavior', () => {
    it('should work correctly on macOS', () => {
      mockedOsPlatform.mockReturnValue('darwin');
      process.env['LANG'] = 'en_US.UTF-8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should work correctly on other Unix-like systems', () => {
      mockedOsPlatform.mockReturnValue('freebsd');
      process.env['LANG'] = 'en_US.UTF-8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });

    it('should handle unknown platforms as Unix-like', () => {
      mockedOsPlatform.mockReturnValue('unknown' as NodeJS.Platform);
      process.env['LANG'] = 'en_US.UTF-8';

      const result = getSystemEncoding();
      expect(result).toBe('utf-8');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle empty buffer gracefully', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';

      const buffer = Buffer.alloc(0);
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });

    it('should handle very large buffers', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';

      const buffer = Buffer.alloc(1024 * 1024, 'a');
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });

    it('should handle Unicode content', () => {
      mockedOsPlatform.mockReturnValue('linux');
      const unicodeText = '你好世界 🌍 ñoño';

      // System encoding fails
      mockedExecSync.mockImplementation(() => {
        throw new Error('locale command failed');
      });

      mockedChardetDetect.mockReturnValue('UTF-8');

      const buffer = Buffer.from(unicodeText, 'utf8');
      const result = getCachedEncodingForBuffer(buffer);
      expect(result).toBe('utf-8');
    });
  });

  describe('decodeProcessOutput', () => {
    it('decodes a pure ASCII buffer unchanged', () => {
      const buf = Buffer.from('Error: (none)\n');
      expect(decodeProcessOutput(buf)).toBe('Error: (none)\n');
    });

    it('decodes a valid UTF-8 buffer with Cyrillic to the exact text', () => {
      const text = 'Ошибка при создании файла';
      const buf = Buffer.from(text, 'utf-8');
      expect(decodeProcessOutput(buf)).toBe(text);
    });

    it('does NOT detect utf-8 for CP-866 bytes outside ASCII range', () => {
      const cp866Buf = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0, 0x20]);
      mockedChardetDetect.mockReturnValue('ISO-8859-5');
      const encoding = getCachedEncodingForBuffer(cp866Buf);
      expect(encoding).not.toBe('utf-8');
      expect(() => decodeProcessOutput(cp866Buf)).not.toThrow();
    });

    it('decodes complete mixed buffer correctly (ASCII prefix + CP-866)', () => {
      const asciiChunk = Buffer.from('Status: OK\n');
      // CP-866 bytes for "Ошибка". `'cp866'` is a valid WHATWG TextDecoder
      // label, so pin the exact decoded text rather than loose prefix /
      // no-replacement assertions (any single-byte label would pass those).
      const cp866Chunk = Buffer.from([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]);
      const fullBuffer = Buffer.concat([asciiChunk, cp866Chunk]);
      mockedChardetDetect.mockReturnValue('cp866');

      const decoded = decodeProcessOutput(fullBuffer);

      expect(decoded).toBe('Status: OK\nОшибка');
    });

    it('decodes mostly-valid UTF-8 with a stray byte as UTF-8, not a chardet guess', () => {
      // Real shell output can be overwhelmingly valid UTF-8 with an
      // occasional stray byte (mixed-encoding file content, legacy tool
      // banners). isUtf8() rejects the whole buffer on that single byte, so
      // detection must still prefer UTF-8 — decoding the stray byte to
      // U+FFFD while keeping the surrounding multi-byte text intact —
      // instead of handing the buffer to chardet, whose single-byte guess
      // (e.g. windows-1252) would silently mojibake all the valid content.
      // The system encoding is UTF-8 here, so the guard skips it and the
      // replacement-ratio heuristic below decides utf-8.
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';
      const body = 'line: 你好 мир OK\n'.repeat(100);
      const buffer = Buffer.concat([
        Buffer.from(body, 'utf-8'),
        Buffer.from([0x93]),
      ]);
      mockedChardetDetect.mockReturnValue('windows-1252');

      const decoded = decodeProcessOutput(buffer);

      expect(decoded).toContain('你好');
      expect(decoded).toContain('мир');
      expect(decoded).toContain('\uFFFD');
      // Detection short-circuits to utf-8 before consulting chardet.
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('returns an empty string for an empty buffer', () => {
      expect(decodeProcessOutput(Buffer.alloc(0))).toBe('');
    });

    it('falls back to utf-8 when TextDecoder rejects the encoding label', () => {
      mockedChardetDetect.mockReturnValue('CP437');
      const buffer = Buffer.from([0x80, 0x81]);
      expect(() => decodeProcessOutput(buffer)).not.toThrow();
      expect(typeof decodeProcessOutput(buffer)).toBe('string');
    });

    it('decodes valid UTF-8 buffer to exact expected string', () => {
      const text = '你好世界 Hello мир';
      const buf = Buffer.from(text, 'utf-8');
      expect(decodeProcessOutput(buf)).toBe(text);
    });

    it('decodes CP-866 buffer to exact Cyrillic text on CP-866 Windows', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      // "Каталог" in CP-866 — NOT valid UTF-8.
      const cp866Buf = Buffer.from([0x8a, 0xa0, 0xe2, 0xa0, 0xab, 0xae, 0xa3]);

      const decoded = decodeProcessOutput(cp866Buf);

      // Exact-text oracle: the system code page (cp866) is authoritative, so
      // detection must not fall to chardet's windows-1252 wrong guess.
      expect(decoded).toBe('Каталог');
    });

    it('decodes UTF-16LE BOM output to the exact text', () => {
      // BOM'd UTF-16 (PowerShell 5.1, MSVC tooling) must decode via utf-16 and
      // drop the BOM — not be NUL-interleaved by a utf-8 misclassfification.
      const buffer = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('Ошибка чтения файла', 'utf16le'),
      ]);

      expect(decodeProcessOutput(buffer)).toBe('Ошибка чтения файла');
    });

    it('decodes UTF-16BE BOM output to the exact text', () => {
      // Mirrors the UTF-16LE test above for big-endian output (FE FF BOM),
      // where TextDecoder('utf-16') — an implicit utf-16le — would decode
      // the payload byte-swapped with a leading U+FFFE.
      const buffer = Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        swapEndian(Buffer.from('Ошибка чтения файла', 'utf16le')),
      ]);

      expect(decodeProcessOutput(buffer)).toBe('Ошибка чтения файла');
    });

    it('returns string input unchanged (setEncoding guard)', () => {
      expect(decodeProcessOutput('already a string')).toBe('already a string');
    });
  });
});
