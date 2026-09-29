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
} from './systemEncoding.js';

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
      expect(windowsCodePageToEncoding(866)).toBe('ibm866');
      expect(windowsCodePageToEncoding(65001)).toBe('utf-8');
      expect(windowsCodePageToEncoding(1252)).toBe('windows-1252');
      expect(windowsCodePageToEncoding(932)).toBe('shift_jis');
      expect(windowsCodePageToEncoding(936)).toBe('gbk');
      expect(windowsCodePageToEncoding(949)).toBe('euc-kr');
      expect(windowsCodePageToEncoding(950)).toBe('big5');
      expect(windowsCodePageToEncoding(1200)).toBe('utf-16le');
      expect(windowsCodePageToEncoding(1201)).toBe('utf-16be');
    });

    it('should return null for DOS code pages TextDecoder does not support (437/850/852)', () => {
      // WHATWG has no cp437/cp850/cp852; returning null lets callers fall
      // back to chardet/UTF-8 instead of throwing in `new TextDecoder(...)`.
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
      mockedExecSync.mockReturnValue('Active code page:   1252   ');

      const result = getSystemEncoding();
      expect(result).toBe('windows-1252');
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

    it('should return null for a locale label TextDecoder cannot decode (LANG=C)', () => {
      process.env['LANG'] = 'C';

      // 'c' is not a valid WHATWG encoding label; handing it to consumers
      // that call `new TextDecoder(encoding)` would throw RangeError.
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

    it('should return null when locale format has no dot and the label is undecodable', () => {
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
  });

  describe('detection order (issue #8278)', () => {
    it('should prefer a non-UTF-8 system code page over chardet for non-UTF-8 bytes (CP-866 regression)', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 866');
      // chardet misclassifies CP-866 Cyrillic as windows-1252 (see issue table)
      mockedChardetDetect.mockReturnValue('windows-1252');

      // "Ощибка" in CP-866 (verified via TextDecoder('ibm866') on Node 24)
      const buffer = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('ibm866');
      expect(mockedChardetDetect).not.toHaveBeenCalled();
    });

    it('should fall through to chardet (never an undecodable label) on Unix when LANG=C', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'C'; // 'c' is not a valid TextDecoder label
      // chardet misclassifies CP-866 Cyrillic as windows-1252 (see issue table)
      mockedChardetDetect.mockReturnValue('windows-1252');

      // "Ощибка" in CP-866 (verified via TextDecoder('ibm866') on Node 24)
      const buffer = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
      const result = getCachedEncodingForBuffer(buffer);

      expect(result).not.toBe('c');
      expect(result).toBe('windows-1252');
      // Consumers call `new TextDecoder(encoding)` unguarded in places
      // (decodeBufferedOutput); the returned label must always be valid.
      expect(() => new TextDecoder(result)).not.toThrow();
      expect(mockedChardetDetect).toHaveBeenCalledWith(buffer);
    });

    it('should still use chardet for non-UTF-8 bytes when the system encoding is UTF-8', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 65001'); // UTF-8
      mockedChardetDetect.mockReturnValue('windows-1251');

      const buffer = Buffer.from([0x80, 0x81, 0x82]); // not valid UTF-8
      const result = getCachedEncodingForBuffer(buffer);

      expect(result).toBe('windows-1251');
      expect(mockedChardetDetect).toHaveBeenCalledWith(buffer);
    });

    it('should gracefully fall back to UTF-8 (never throw) when chcp=437, which TextDecoder does not support', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 437');
      mockedChardetDetect.mockReturnValue(null); // even chardet gives up

      const buffer = Buffer.from([0x80, 0x81, 0x82]); // not valid UTF-8
      const encoding = getCachedEncodingForBuffer(buffer);

      expect(encoding).toBe('utf-8');
      // Consumers call `new TextDecoder(encoding)` unguarded in places
      // (decodeBufferedOutput); the returned label must always be valid.
      expect(() => new TextDecoder(encoding)).not.toThrow();
    });

    it('should map code page 866 to the WHATWG ibm866 label and decode CP-866 bytes correctly', () => {
      const label = windowsCodePageToEncoding(866);
      expect(label).toBe('ibm866');
      const bytes = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
      expect(new TextDecoder(label!).decode(bytes)).toBe('Ощибка');
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
});
