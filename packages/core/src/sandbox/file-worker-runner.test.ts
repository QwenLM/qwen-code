/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getSandboxFileVersion } from './file-version.js';
import { encodeSandboxWriteRequest } from './file-worker-protocol.js';
import { runFileWorker } from './file-worker-runner.js';

describe('sandbox file worker', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'file-worker-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = async (
    request: Parameters<typeof encodeSandboxWriteRequest>[0],
  ) => {
    let reply = '';
    const exitCode = await runFileWorker(
      Readable.from([encodeSandboxWriteRequest(request)]),
      (value) => {
        reply += value;
      },
    );
    return { exitCode, reply: JSON.parse(reply) as Record<string, unknown> };
  };

  it('creates missing parents and preserves binary bytes', async () => {
    const destination = path.join(root, 'nested', 'file');
    const content = Buffer.from([0, 0xff, 10]);
    await expect(
      run({ operation: 'write', destination, expected: null, content }),
    ).resolves.toEqual({ exitCode: 0, reply: { ok: true } });
    expect(readFileSync(destination)).toEqual(content);
  });

  it('rejects a stale target without changing bytes or leaving a temp file', async () => {
    const destination = path.join(root, 'file');
    writeFileSync(destination, 'first');
    const expected = getSandboxFileVersion(destination);
    writeFileSync(destination, 'external change');
    const result = await run({
      operation: 'write',
      destination,
      expected,
      content: Buffer.from('replacement'),
    });
    expect(result).toMatchObject({
      exitCode: 1,
      reply: { ok: false, code: 'ESTALE' },
    });
    expect(readFileSync(destination, 'utf8')).toBe('external change');
    expect(readdirSync(root)).toEqual(['file']);
  });
});
