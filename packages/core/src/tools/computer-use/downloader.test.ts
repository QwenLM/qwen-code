/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  parseChecksums,
  findInstalled,
  ensureInstalled,
} from './downloader.js';
import { binaryPath, CUA_DRIVER_VERSION } from './constants.js';

describe('parseChecksums', () => {
  it('parses sha256sum lines into a filename -> hash map', () => {
    const body = [
      'a'.repeat(64) + '  cua-driver-rs-0.5.2-darwin-arm64.tar.gz',
      'b'.repeat(64) + '  cua-driver-rs-0.5.2-linux-x86_64.tar.gz',
      '# a comment line',
      '',
    ].join('\n');
    const map = parseChecksums(body);
    expect(map.get('cua-driver-rs-0.5.2-darwin-arm64.tar.gz')).toBe(
      'a'.repeat(64),
    );
    expect(map.size).toBe(2);
  });

  it('tolerates the binary-mode asterisk and stray whitespace', () => {
    const map = parseChecksums(`${'c'.repeat(64)} *file.zip\n`);
    expect(map.get('file.zip')).toBe('c'.repeat(64));
  });
});

describe('findInstalled / ensureInstalled short-circuit', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'qwen-cu-dl-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('findInstalled returns undefined when the binary is absent', async () => {
    expect(await findInstalled(home, 'darwin', 'arm64')).toBeUndefined();
  });

  it('findInstalled returns the path once the binary exists', async () => {
    const p = binaryPath(home, 'darwin', 'arm64');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\n');
    expect(await findInstalled(home, 'darwin', 'arm64')).toBe(p);
  });

  it('ensureInstalled is a no-op (no download) when already installed', async () => {
    const p = binaryPath(home, 'darwin', 'arm64');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\n');

    // fetchImpl throws — proving ensureInstalled never reaches the network.
    const throwingFetch = (() => {
      throw new Error('fetch must not be called when already installed');
    }) as unknown as typeof fetch;

    const result = await ensureInstalled({
      home,
      platform: 'darwin',
      arch: 'arm64',
      version: CUA_DRIVER_VERSION,
      fetchImpl: throwingFetch,
    });
    expect(result).toBe(p);
  });
});

describe('ensureInstalled on Windows (.zip extraction)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'qwen-cu-win-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('downloads + verifies + unzips, resolving cua-driver.exe under the wrapper dir', async () => {
    const asset = `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`;
    const zipBytes = Buffer.from('PK fake-zip-payload');
    const sha = createHash('sha256').update(zipBytes).digest('hex');
    const checksums = `${sha}  ${asset}\n`;

    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('checksums.txt')) return new Response(checksums);
      if (u.endsWith(asset)) return new Response(zipBytes);
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    // Stand in for OS unzip: lay down the wrapper dir + exe the real zip holds.
    let unzipCalled = false;
    const unzipImpl = async (_zip: string, dest: string) => {
      unzipCalled = true;
      const wrapper = join(
        dest,
        `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64`,
      );
      mkdirSync(wrapper, { recursive: true });
      writeFileSync(join(wrapper, 'cua-driver.exe'), 'MZ');
    };

    const result = await ensureInstalled({
      home,
      platform: 'win32',
      arch: 'x64',
      version: CUA_DRIVER_VERSION,
      fetchImpl,
      unzipImpl,
    });

    expect(unzipCalled).toBe(true);
    expect(result).toBe(binaryPath(home, 'win32', 'x64'));
    expect(existsSync(result)).toBe(true);
  });

  it('rejects a checksum mismatch before unzipping', async () => {
    const asset = `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`;
    const checksums = `${'0'.repeat(64)}  ${asset}\n`; // deliberately wrong hash
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('checksums.txt')) return new Response(checksums);
      if (u.endsWith(asset)) return new Response(Buffer.from('payload'));
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    let unzipCalled = false;
    await expect(
      ensureInstalled({
        home,
        platform: 'win32',
        arch: 'x64',
        version: CUA_DRIVER_VERSION,
        fetchImpl,
        unzipImpl: async () => {
          unzipCalled = true;
        },
      }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(unzipCalled).toBe(false);
  });
});
