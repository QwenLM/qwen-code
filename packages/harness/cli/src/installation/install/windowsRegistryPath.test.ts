/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowsRegistryPath } from './windowsRegistryPath.js';

const header =
  'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n';
function readExport(body: string | Buffer) {
  let file = '';
  try {
    return readWindowsRegistryPath((args) => {
      expect(args.slice(0, 2)).toEqual(['export', 'HKCU\\Environment']);
      file = args[2];
      const prefix =
        process.env['BRAND_REGISTRY_PATH_PREFIX'] || 'qwen-code-registry-path-';
      expect(basename(dirname(file)).startsWith(prefix)).toBe(true);
      writeFileSync(
        file,
        typeof body === 'string'
          ? Buffer.from('\ufeff' + body, 'utf16le')
          : body,
      );
    });
  } finally {
    expect(existsSync(dirname(file))).toBe(false);
  }
}

describe('Unicode registry PATH export', () => {
  it('preserves quoted paths, percent variables, whitespace and non-ACP characters', () => {
    const value = ' C:\\Users\\中文用户\\工具😀;"%USERPROFILE%\\bin"; ';
    expect(
      readExport(header + '"Path"=' + JSON.stringify(value) + '\r\n\r\n'),
    ).toEqual({ value, type: 'REG_SZ' });
  });

  it.each([
    ['1', 'REG_SZ'],
    ['2', 'REG_EXPAND_SZ'],
  ])('reads wrapped hex(%s) without expanding variables', (kind, type) => {
    const value = '\ufeffC:\\Users\\中文用户\\工具😀;%USERPROFILE%\\bin';
    const bytes = [...Buffer.from(value + '\0', 'utf16le')].map((b) =>
      b.toString(16).padStart(2, '0'),
    );
    const hex =
      bytes.slice(0, 8).join(',') + ',\\\r\n  ' + bytes.slice(8).join(',');
    expect(readExport(header + `"pAtH"=hex(${kind}):${hex}\r\n\r\n`)).toEqual({
      value,
      type,
    });
  });

  it('returns null only for a valid export without a user PATH, ignoring subkeys', () => {
    expect(
      readExport(
        header +
          '"Other"="value"\r\n\r\n[HKEY_CURRENT_USER\\Environment\\Child]\r\n"Path"="unrelated"\r\n\r\n',
      ),
    ).toBeNull();
  });

  it.each([
    ['missing BOM', Buffer.from(header + '"Path"="ok"\r\n', 'utf16le')],
    ['legacy ANSI', Buffer.from(header + '"Path"="ok"\r\n', 'utf8')],
    ['incomplete export', header + '"Other"="value"'],
    [
      'malformed PATH name/value separator',
      header + '"Path" : "value"\r\n\r\n',
    ],
    ['odd UTF-16 length', Buffer.from([0xff, 0xfe, 0x43])],
    ['invalid UTF-16', Buffer.from([0xff, 0xfe, 0x00, 0xd8])],
    [
      'wrong root key',
      'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Other]\r\n"Path"="ok"\r\n\r\n',
    ],
    ['unknown type', header + '"Path"=dword:00000001\r\n\r\n'],
    ['truncated hex', header + '"Path"=hex(2):43,00\r\n\r\n'],
    ['malformed hex', header + '"Path"=hex(2):43,00,gg,00,00,00\r\n\r\n'],
    ['invalid hex UTF-16', header + '"Path"=hex(2):00,d8,00,00\r\n\r\n'],
    ['embedded NUL', header + '"Path"=hex(2):43,00,00,00,44,00,00,00\r\n\r\n'],
    ['duplicate PATH', header + '"Path"="a"\r\n"PATH"="b"\r\n\r\n'],
  ])('rejects %s instead of reporting PATH absent', (_name, data) => {
    expect(() => readExport(data)).toThrow();
  });

  it('propagates export errors including localized ERROR messages and removes temp files', () => {
    let file = '';
    expect(() =>
      readWindowsRegistryPath((args) => {
        file = args[2];
        writeFileSync(file, 'partial export');
        throw new Error('ERROR: Access is denied');
      }),
    ).toThrow('Access is denied');
    expect(existsSync(dirname(file))).toBe(false);
  });
});
