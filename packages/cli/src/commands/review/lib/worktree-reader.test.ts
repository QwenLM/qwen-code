/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real filesystem. The bug this locks down lives in the kernel's path
// resolution, and a mocked `fs` would happily "pass" against a fiction —
// which is exactly how the lexically-inside form got through the first gate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedWorktreeReader } from './worktree-reader.js';

let root: string;
let wt: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-reader-')));
  wt = join(root, 'worktree');
  outside = join(root, 'outside');
  mkdirSync(wt);
  mkdirSync(outside);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('containedWorktreeReader', () => {
  it('reads an ordinary file inside the worktree', () => {
    writeFileSync(join(wt, 'a.ts'), "import './b.js';\n");
    expect(containedWorktreeReader(wt)('a.ts')).toBe("import './b.js';\n");
  });

  it('refuses a path whose ANCESTOR is a symlink out of the worktree', () => {
    // The bypass the final-component gate cannot see. `lnk` is ordinary git
    // content — a standard checkout materializes it — so the PR under review
    // plants it, and `lnk/victim` stays lexically inside the worktree while
    // the kernel resolves it outside. The reader's answer is content-derived
    // and reaches `scope.interaction` in the published report, so this is a
    // read of an arbitrary file AND a channel out.
    writeFileSync(join(outside, 'victim.ts'), 'CANARY\n');
    symlinkSync(outside, join(wt, 'lnk'));
    const read = containedWorktreeReader(wt);

    expect(read('lnk/victim.ts')).toBeNull();
    // …and the final-component form stays refused too.
    symlinkSync(join(outside, 'victim.ts'), join(wt, 'direct.ts'));
    expect(read('direct.ts')).toBeNull();
  });

  it('refuses a path that climbs out with ..', () => {
    writeFileSync(join(outside, 'victim.ts'), 'CANARY\n');
    expect(
      containedWorktreeReader(wt)(join('..', 'outside', 'victim.ts')),
    ).toBeNull();
  });

  it('refuses anything that is not a regular file', () => {
    // A fifo would block the synchronous read forever and a device would grow
    // the buffer until SIGKILL — neither throws, so the lease is never freed.
    mkdirSync(join(wt, 'adir'));
    const read = containedWorktreeReader(wt);
    expect(read('adir')).toBeNull();
    expect(read('missing.ts')).toBeNull();
  });

  it('fails every read closed when the root itself does not resolve', () => {
    const read = containedWorktreeReader(join(root, 'no-such-worktree'));
    expect(read('a.ts')).toBeNull();
  });

  it('still reads through a symlinked worktree ROOT', () => {
    // Containment is against the root's OWN real location, so a worktree
    // reached through a symlink (a `/tmp` that is really `/private/tmp`, a
    // linked checkout) is not mistaken for an escape.
    writeFileSync(join(wt, 'a.ts'), 'inside\n');
    const alias = join(root, 'alias');
    symlinkSync(wt, alias);
    expect(containedWorktreeReader(alias)('a.ts')).toBe('inside\n');
  });
});
