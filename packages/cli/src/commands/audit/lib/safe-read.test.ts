/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { streamSha256 } from './safe-read.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-safe-read-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('streamSha256', () => {
  it('hashes a stable regular file byte-identically', () => {
    const file = join(dir, 'stable.txt');
    const content = 'baseline content\n';
    writeFileSync(file, content);
    expect(streamSha256(file)).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
  });

  it('returns undefined for a missing path or a directory', () => {
    expect(streamSha256(join(dir, 'missing.txt'))).toBeUndefined();
    mkdirSync(join(dir, 'subdir'));
    expect(streamSha256(join(dir, 'subdir'))).toBeUndefined();
  });

  // A /proc pseudo-file stats size 0 while read() yields content: the
  // size-at-open bound must stop at the fstat size exactly like
  // readGuarded. A reader to the live EOF would hash the content instead —
  // the same shape a concurrent appender grows without bound, dragging an
  // unbounded loop to EOF forever at every checkpoint.
  it.skipIf(process.platform !== 'linux')(
    'stops at the size-at-open instead of reading to the live EOF',
    () => {
      const probe = join('/proc', String(process.pid), 'cmdline');
      expect(streamSha256(probe)).toBe(createHash('sha256').digest('hex'));
    },
  );
});
