/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import { detect as chardetDetect } from 'chardet';

vi.mock('child_process');
vi.mock('os');
vi.mock('chardet');

import {
  getCachedEncodingForBuffer,
  getSystemEncoding,
  windowsCodePageToEncoding,
  detectEncodingFromBuffer,
  resetEncodingCache,
} from './systemEncoding.js';

/** Bytes that are NOT valid UTF-8, so the UTF-8-first check fails. */
const notUtf8 = (...bytes: number[]) => Buffer.from(bytes);

/** Makes a mocked call (execSync or chardet) throw `message`. */
function throwOnCall(
  mock: { mockImplementation(fn: () => never): unknown },
  message: string,
) {
  mock.mockImplementation(() => {
    throw new Error(message);
  });
}

describe('Shell Command Processor - Encoding Functions', () => {
  let mockedExecSync: ReturnType<typeof vi.mocked<typeof execSync>>;
  let mockedOsPlatform: ReturnType<typeof vi.mocked<() => string>>;
  let mockedChardetDetect: ReturnType<typeof vi.mocked<typeof chardetDetect>>;

  /** System encoding while `chcp` / `locale charmap` prints `output`. */
  const encodingFromExec = (output: string) => {
    mockedExecSync.mockReturnValue(output);
    return getSystemEncoding();
  };

  /** Sets locale variables, then reads the system encoding. */
  const encodingWithEnv = (env: Record<string, string>) => {
    Object.assign(process.env, env);
    return getSystemEncoding();
  };

  beforeEach(() => {
    mockedExecSync = vi.mocked(execSync);
    mockedOsPlatform = vi.mocked(os.platform);
    mockedChardetDetect = vi.mocked(chardetDetect);

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
      for (const cp of [874, 1250, 1251, 1253, 1254, 1255, 1256, 1257, 1258]) {
        expect(windowsCodePageToEncoding(cp)).toBe(`windows-${cp}`);
      }
    });
  });

  describe('detectEncodingFromBuffer', () => {
    const detect = () =>
      detectEncodingFromBuffer(Buffer.from('test content', 'utf8'));

    it('should detect encoding using chardet successfully', () => {
      mockedChardetDetect.mockReturnValue('UTF-8');
      expect(detect()).toBe('utf-8');
      expect(mockedChardetDetect).toHaveBeenCalledWith(
        Buffer.from('test content', 'utf8'),
      );
    });

    it('should handle chardet returning mixed case encoding', () => {
      mockedChardetDetect.mockReturnValue('ISO-8859-1');
      expect(detect()).toBe('iso-8859-1');
    });

    it('should return null when chardet fails', () => {
      throwOnCall(mockedChardetDetect, 'Detection failed');
      expect(detect()).toBe(null);
    });

    it('should return null when chardet returns null', () => {
      mockedChardetDetect.mockReturnValue(null);
      expect(detect()).toBe(null);
    });

    it('should return null when chardet returns non-string', () => {
      mockedChardetDetect.mockReturnValue([
        'utf-8',
        'iso-8859-1',
      ] as unknown as string);
      expect(detect()).toBe(null);
    });
  });

  describe('getSystemEncoding - Windows', () => {
    beforeEach(() => {
      mockedOsPlatform.mockReturnValue('win32');
    });

    it('should parse Windows chcp output correctly', () => {
      expect(encodingFromExec('Active code page: 65001')).toBe('utf-8');
      expect(mockedExecSync).toHaveBeenCalledWith('chcp', { encoding: 'utf8' });
    });

    it('should handle different chcp output formats', () => {
      expect(encodingFromExec('Current code page: 1252')).toBe('windows-1252');
    });

    it('should handle chcp output with extra whitespace', () => {
      expect(encodingFromExec('Active code page:   1252   ')).toBe(
        'windows-1252',
      );
    });

    it('should return null when chcp command fails', () => {
      throwOnCall(mockedExecSync, 'Command failed');
      expect(getSystemEncoding()).toBe(null);
    });

    it('should return null when chcp output cannot be parsed', () => {
      expect(encodingFromExec('Unexpected output format')).toBe(null);
    });

    it('should return null when code page is not a number', () => {
      expect(encodingFromExec('Active code page: abc')).toBe(null);
    });

    it('should return null when code page maps to null', () => {
      expect(encodingFromExec('Active code page: 99999')).toBe(null);
    });
  });

  describe('getSystemEncoding - Unix-like', () => {
    beforeEach(() => {
      mockedOsPlatform.mockReturnValue('linux');
    });

    it('should parse locale from LC_ALL environment variable', () => {
      expect(encodingWithEnv({ LC_ALL: 'en_US.UTF-8' })).toBe('utf-8');
    });

    it('should parse locale from LC_CTYPE when LC_ALL is not set', () => {
      expect(encodingWithEnv({ LC_CTYPE: 'fr_FR.ISO-8859-1' })).toBe(
        'iso-8859-1',
      );
    });

    it('should parse locale from LANG when LC_ALL and LC_CTYPE are not set', () => {
      expect(encodingWithEnv({ LANG: 'de_DE.UTF-8' })).toBe('utf-8');
    });

    it('should handle locale charmap command when environment variables are empty', () => {
      expect(encodingFromExec('UTF-8\n')).toBe('utf-8');
      expect(mockedExecSync).toHaveBeenCalledWith('locale charmap', {
        encoding: 'utf8',
      });
    });

    it('should handle locale charmap with mixed case', () => {
      expect(encodingFromExec('ISO-8859-1\n')).toBe('iso-8859-1');
    });

    it('should return null when locale charmap fails', () => {
      throwOnCall(mockedExecSync, 'Command failed');
      expect(getSystemEncoding()).toBe(null);
    });

    it('should return null for a locale label TextDecoder cannot decode (LANG=C)', () => {
      // 'c' is not a valid WHATWG encoding label; handing it to consumers
      // that call `new TextDecoder(encoding)` would throw RangeError.
      expect(encodingWithEnv({ LANG: 'C' })).toBe(null);
    });

    it('should handle empty locale environment variables', () => {
      Object.assign(process.env, { LC_ALL: '', LC_CTYPE: '', LANG: '' });
      expect(encodingFromExec('UTF-8')).toBe('utf-8');
    });

    it('should return null when locale format has no dot and the label is undecodable', () => {
      expect(encodingWithEnv({ LANG: 'invalid_format' })).toBe(null);
    });

    it('should prioritize LC_ALL over other environment variables', () => {
      process.env['LC_ALL'] = 'en_US.UTF-8';
      process.env['LC_CTYPE'] = 'fr_FR.ISO-8859-1';
      process.env['LANG'] = 'de_DE.CP1252';
      expect(getSystemEncoding()).toBe('utf-8');
    });

    it('should prioritize LC_CTYPE over LANG', () => {
      process.env['LC_CTYPE'] = 'fr_FR.ISO-8859-1';
      process.env['LANG'] = 'de_DE.CP1252';
      expect(getSystemEncoding()).toBe('iso-8859-1');
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
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');
    });

    it('should return utf-8 for pure ASCII buffers', () => {
      // ASCII is valid UTF-8 — should return utf-8 immediately
      const buffer = Buffer.from('hello world');
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');
    });

    it('should use cached system encoding on subsequent calls', () => {
      process.env['LANG'] = 'en_US.UTF-8';
      const buffer = Buffer.from('test');
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');

      // Changing the environment must not affect the cached result
      process.env['LANG'] = 'fr_FR.ISO-8859-1';
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');
    });

    it('should fall back to buffer detection when system encoding fails', () => {
      throwOnCall(mockedExecSync, 'locale command failed');
      const buffer = notUtf8(0x80, 0x81, 0x82);
      mockedChardetDetect.mockReturnValue('ISO-8859-1');

      expect(getCachedEncodingForBuffer(buffer)).toBe('iso-8859-1');
      expect(mockedChardetDetect).toHaveBeenCalledWith(buffer);
    });

    it('should fall back to utf-8 when both system and buffer detection fail', () => {
      throwOnCall(mockedExecSync, 'locale command failed');
      throwOnCall(mockedChardetDetect, 'chardet failed');
      expect(getCachedEncodingForBuffer(Buffer.from('test'))).toBe('utf-8');
    });

    it('should not cache buffer detection results', () => {
      throwOnCall(mockedExecSync, 'locale command failed');
      mockedChardetDetect
        .mockReturnValueOnce('ISO-8859-1')
        .mockReturnValueOnce('UTF-16');

      const result1 = getCachedEncodingForBuffer(notUtf8(0x80, 0x81));
      const result2 = getCachedEncodingForBuffer(notUtf8(0x82, 0x83));

      expect(result1).toBe('iso-8859-1');
      expect(result2).toBe('utf-16');
      expect(mockedChardetDetect).toHaveBeenCalledTimes(2);
    });

    it('should handle Windows system encoding', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 1252');
      // Non-UTF-8 bytes fall through to system encoding detection
      const buffer = notUtf8(0x80, 0x81, 0x82);
      expect(getCachedEncodingForBuffer(buffer)).toBe('windows-1252');
    });

    it('should prioritize UTF-8 detection over Windows system encoding', () => {
      mockedOsPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('Active code page: 936'); // GBK
      mockedChardetDetect.mockReturnValue('UTF-8');
      expect(getCachedEncodingForBuffer(Buffer.from('test'))).toBe('utf-8');
    });

    it('should cache null system encoding result', () => {
      resetEncodingCache();
      mockedOsPlatform.mockReturnValue('linux');
      throwOnCall(mockedExecSync, 'locale command failed');
      mockedChardetDetect
        .mockReturnValueOnce('ISO-8859-1')
        .mockReturnValueOnce('UTF-16');
      mockedExecSync.mockClear(); // drop calls from earlier setup or tests

      const result1 = getCachedEncodingForBuffer(notUtf8(0x80, 0x81));
      const result2 = getCachedEncodingForBuffer(notUtf8(0x82, 0x83));

      // System encoding is only a fallback after UTF-8 and chardet both fail;
      // chardet returns results here, so execSync may not be called.
      expect(result1).toBe('iso-8859-1');
      expect(result2).toBe('utf-16');

      // A third call shows chardet runs every time (not cached)
      mockedChardetDetect.mockReturnValueOnce('UTF-32');
      expect(getCachedEncodingForBuffer(notUtf8(0x84, 0x85))).toBe('utf-32');
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
    it.each([
      ['should work correctly on macOS', 'darwin'],
      ['should work correctly on other Unix-like systems', 'freebsd'],
      ['should handle unknown platforms as Unix-like', 'unknown'],
    ])('%s', (_title, platform) => {
      mockedOsPlatform.mockReturnValue(platform as NodeJS.Platform);
      process.env['LANG'] = 'en_US.UTF-8';
      expect(getSystemEncoding()).toBe('utf-8');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle empty buffer gracefully', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';
      expect(getCachedEncodingForBuffer(Buffer.alloc(0))).toBe('utf-8');
    });

    it('should handle very large buffers', () => {
      mockedOsPlatform.mockReturnValue('linux');
      process.env['LANG'] = 'en_US.UTF-8';
      const buffer = Buffer.alloc(1024 * 1024, 'a');
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');
    });

    it('should handle Unicode content', () => {
      mockedOsPlatform.mockReturnValue('linux');
      throwOnCall(mockedExecSync, 'locale command failed');
      mockedChardetDetect.mockReturnValue('UTF-8');
      const buffer = Buffer.from('你好世界 🌍 ñoño', 'utf8');
      expect(getCachedEncodingForBuffer(buffer)).toBe('utf-8');
    });
  });
});
