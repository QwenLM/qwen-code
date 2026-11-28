/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registryPathPrefix =
  process.env['BRAND_REGISTRY_PATH_PREFIX'] || 'qwen-code-registry-path-';

export interface RegistryPathEntry {
  value: string;
  type: 'REG_SZ' | 'REG_EXPAND_SZ';
}

/**
 * reg query writes in the active code page, not necessarily UTF-8. Export uses
 * a BOM-marked UTF-16LE file, including unexpanded variables and the value type.
 * Keep this reader independent of the CLI so npm postinstall uses it too.
 * The caller supplies reg execution (and any timeout/retry policy).
 */
export function readWindowsRegistryPath(
  runReg: (args: string[]) => unknown,
): RegistryPathEntry | null {
  const directory = mkdtempSync(join(tmpdir(), registryPathPrefix));
  try {
    const file = join(directory, 'environment.reg');
    runReg(['export', 'HKCU\\Environment', file, '/y']);
    return parseRegistryPathExport(readFileSync(file));
  } finally {
    // The export may include other user environment variables. Never retain it.
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseRegistryPathExport(bytes: Buffer): RegistryPathEntry | null {
  if (bytes.length % 2 !== 0 || bytes[0] !== 0xff || bytes[1] !== 0xfe) {
    throw new Error('Registry export is not BOM-marked UTF-16LE');
  }
  const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (
    !text.startsWith('Windows Registry Editor Version 5.00\r\n') ||
    !text.endsWith('\r\n\r\n')
  ) {
    throw new Error('Unexpected registry export header');
  }
  const lines = text.replace(/\\\r?\n[ \t]*/g, '').split(/\r?\n/);
  let inEnvironment = false;
  let foundEnvironment = false;
  let entry: RegistryPathEntry | null = null;
  for (const line of lines) {
    if (line.startsWith('[')) {
      inEnvironment = /^\[HKEY_CURRENT_USER\\Environment\]$/i.test(line);
      foundEnvironment ||= inEnvironment;
      continue;
    }
    if (!inEnvironment || !/^"Path"/i.test(line)) continue;
    if (!/^"Path"=/i.test(line)) {
      throw new Error('Malformed PATH entry in registry export');
    }
    if (entry !== null) throw new Error('Duplicate PATH in registry export');
    const data = line.slice('"Path"='.length);
    if (data.startsWith('"')) {
      const value: unknown = JSON.parse(data);
      if (typeof value !== 'string' || value.includes('\0')) {
        throw new Error('Invalid registry PATH string');
      }
      entry = { value, type: 'REG_SZ' };
      continue;
    }
    const hex = /^hex\(([12])\):((?:[0-9a-f]{2},)*[0-9a-f]{2})$/i.exec(data);
    if (!hex) throw new Error('Unsupported or malformed registry PATH value');
    const valueBytes = Buffer.from(hex[2].replace(/,/g, ''), 'hex');
    if (
      valueBytes.length < 2 ||
      valueBytes.length % 2 !== 0 ||
      valueBytes.readUInt16LE(valueBytes.length - 2) !== 0
    ) {
      throw new Error('Invalid registry PATH string terminator');
    }
    // Do not consume a leading U+FEFF in a value as an encoding marker.
    const value = new TextDecoder('utf-16le', {
      fatal: true,
      ignoreBOM: true,
    }).decode(valueBytes.subarray(0, -2));
    if (value.includes('\0')) throw new Error('Invalid registry PATH string');
    entry = { value, type: hex[1] === '2' ? 'REG_EXPAND_SZ' : 'REG_SZ' };
  }
  if (!foundEnvironment) throw new Error('Registry export omitted Environment');
  return entry;
}
