/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGuarded, streamSha256, writeFileGuarded } from './safe-read.js';

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

  it('never hashes through a symlink', () => {
    // The walk-time lstat cannot speak for the open moment, and an fd's own
    // fstat describes the symlink's TARGET: without O_NOFOLLOW a mid-window
    // swap puts an out-of-tree file's hash into the baseline and every later
    // checkpoint reads "unchanged".
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'out of tree\n');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    expect(streamSha256(link)).toBeUndefined();
  });

  it('mixes the size in only when the read was truncated', () => {
    const file = join(dir, 'capped.txt');
    writeFileSync(file, 'x'.repeat(100));
    // At or under the bound the digest stays the file's own sha256 …
    expect(streamSha256(file, 100)).toBe(
      createHash('sha256').update('x'.repeat(100)).digest('hex'),
    );
    // … and past it the size rides along, so growth beyond the bound cannot
    // read as "no drift" on an identical prefix.
    const truncated = streamSha256(file, 50);
    writeFileSync(file, 'x'.repeat(140));
    expect(streamSha256(file, 50)).not.toBe(truncated);
  });
});

describe('readGuarded', () => {
  it('refuses a symlink even when its target is a readable regular file', () => {
    const target = join(dir, 'real.ts');
    writeFileSync(target, 'const a = 1;\n');
    symlinkSync(target, join(dir, 'link.ts'));
    expect(readGuarded(join(dir, 'link.ts'), 1024)).toBeNull();
    expect(readGuarded(target, 1024)?.toString('utf8')).toBe('const a = 1;\n');
  });
});

describe('writeFileGuarded', () => {
  it('writes a regular file, creating and truncating it', () => {
    const file = join(dir, 'out.json');
    writeFileGuarded(file, 'first-and-longer', 'the artifact');
    writeFileGuarded(file, 'second', 'the artifact');
    expect(readFileSync(file, 'utf8')).toBe('second');
  });

  it('refuses a symlink instead of rewriting its target', () => {
    // The check-then-use shape this replaces let a planted link redirect the
    // whole write into a host file the auditor chose nothing about.
    const decoy = join(dir, 'decoy.txt');
    writeFileSync(decoy, 'do not touch\n');
    const path = join(dir, 'artifact.json');
    symlinkSync(decoy, path);
    expect(() => writeFileGuarded(path, 'payload', 'the artifact')).toThrow(
      /cannot write the artifact/,
    );
    expect(readFileSync(decoy, 'utf8')).toBe('do not touch\n');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a writer-less FIFO instead of blocking forever',
    () => {
      // The remedy for a failed artifact write is re-running the same
      // command against the same path, so a hang here greets every retry.
      const path = join(dir, 'fifo.json');
      execFileSync('mkfifo', [path]);
      expect(() => writeFileGuarded(path, 'payload', 'the artifact')).toThrow(
        /cannot write the artifact/,
      );
    },
  );
});
