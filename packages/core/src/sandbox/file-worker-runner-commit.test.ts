/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getSandboxFileVersion } from './file-version.js';
import { encodeSandboxWriteRequest } from './file-worker-protocol.js';

const mockAtomicWriteFile = vi.hoisted(() => vi.fn());

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: mockAtomicWriteFile,
}));

import { runFileWorker } from './file-worker-runner.js';

describe('sandbox file worker commit check', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rechecks the target immediately before commit', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'file-worker-commit-'));
    const destination = path.join(root, 'file');
    writeFileSync(destination, 'first');
    const expected = getSandboxFileVersion(destination);
    mockAtomicWriteFile.mockImplementation(
      async (_destination, _content, options) => {
        writeFileSync(destination, 'concurrent change');
        options.assertCanCommit();
      },
    );
    let reply = '';
    const exitCode = await runFileWorker(
      Readable.from([
        encodeSandboxWriteRequest({
          operation: 'write',
          destination,
          expected,
          content: Buffer.from('replacement'),
        }),
      ]),
      (value) => {
        reply += value;
      },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(reply)).toMatchObject({ ok: false, code: 'ESTALE' });
    expect(readFileSync(destination, 'utf8')).toBe('concurrent change');
  });
});
