/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  encodeSandboxWriteRequest,
  readSandboxWriteRequest,
  MAX_FILE_HEADER_BYTES,
} from './file-worker-protocol.js';
import {
  getSandboxFileVersion,
  assertSandboxFileVersion,
} from './file-version.js';

describe('sandbox file protocol and versions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'file-protocol-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preserves raw bytes beyond 1 MiB across a split header', async () => {
    const request = {
      operation: 'write' as const,
      destination: path.join(root, '世界.txt'),
      expected: null,
      content: Buffer.alloc(2 * 1024 * 1024, 0xff),
    };
    request.content[0] = 0;
    request.content[1] = 10;
    const encoded = encodeSandboxWriteRequest(request);
    const split = encoded.indexOf(10);
    const decoded = await readSandboxWriteRequest(
      Readable.from([
        encoded.subarray(0, 1),
        encoded.subarray(1, split),
        encoded.subarray(split),
      ]),
    );
    expect(decoded).toEqual(request);
  });

  it('rejects an oversized header before consuming the body', async () => {
    let consumedBody = false;
    async function* input() {
      yield Buffer.alloc(MAX_FILE_HEADER_BYTES + 1, 0x20);
      consumedBody = true;
      yield Buffer.from('body');
    }
    await expect(readSandboxWriteRequest(input())).rejects.toThrow('16 KiB');
    expect(consumedBody).toBe(false);
  });

  it.each([
    {},
    { operation: 'write', destination: 'relative', expected: null },
    { operation: 'write', destination: '/absolute', expected: {} },
    { operation: 'write', destination: '/absolute' },
  ])('rejects malformed metadata %j', async (header) => {
    await expect(
      readSandboxWriteRequest(
        Readable.from([Buffer.from(JSON.stringify(header) + '\n')]),
      ),
    ).rejects.toThrow('Invalid write request');
  });

  it.each(['changed', 'replaced', 'removed'] as const)(
    'detects a %s target',
    (change) => {
      const target = path.join(root, 'file');
      writeFileSync(target, 'old');
      const version = getSandboxFileVersion(target);
      expect(Object.isFrozen(version)).toBe(true);
      expect(() => assertSandboxFileVersion(target, version)).not.toThrow();
      if (change === 'changed') writeFileSync(target, 'longer');
      if (change === 'replaced') {
        const next = path.join(root, 'next');
        writeFileSync(next, 'old');
        renameSync(next, target);
      }
      if (change === 'removed') unlinkSync(target);
      expect(() => assertSandboxFileVersion(target, version)).toThrow(
        expect.objectContaining({ code: 'ESTALE' }),
      );
    },
  );

  it('detects a file appearing after preparation and rejects directories', () => {
    const target = path.join(root, 'file');
    expect(getSandboxFileVersion(target)).toBeNull();
    writeFileSync(target, 'external');
    expect(() => assertSandboxFileVersion(target, null)).toThrow(
      expect.objectContaining({ code: 'ESTALE' }),
    );
    expect(() => getSandboxFileVersion(root)).toThrow(
      expect.objectContaining({ code: 'EISDIR' }),
    );
  });
});
