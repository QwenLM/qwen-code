/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownershipLockKeyForWorktreeForTesting as restoreKey } from '../routes/session.js';
import { canonicalPathForTesting as cleanupKey } from './worktree-orphan-cleanup.js';

// The rule stated in `server/worktree-ownership-op.ts`: every caller derives
// the lock key as JS `fs.realpathSync` of the recorded worktree path; the
// restore and the cleanup fall back to the raw path, and the reset refuses
// a checkout that does not resolve. Derivations that drift apart stop
// excluding each other on one checkout. The reset derives its key inline in
// `resolveWorktreeOwnershipTarget`; the `fs.realpathSync` assertions below
// restate that rule rather than run it. The `..` route-level cases in
// `routes/session-worktree-reset.test.ts` run the reset's and the restore's
// inline derivations.
describe('worktree ownership lock key', () => {
  let root: string;
  let checkout: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-lock-key-')),
    );
    checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is the checkout path itself for a canonical path', () => {
    expect(restoreKey(checkout)).toBe(checkout);
    expect(cleanupKey(checkout)).toBe(checkout);
    expect(fs.realpathSync(checkout)).toBe(checkout);
  });

  it('resolves a path recorded through a symlink, as the reset does', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(
      checkout,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(restoreKey(link)).toBe(checkout);
    expect(cleanupKey(link)).toBe(checkout);
    expect(fs.realpathSync(link)).toBe(checkout);
  });

  it('resolves a `..` segment before walking the path, as JS realpathSync does', () => {
    // On POSIX, `fs.realpathSync.native` and `fs.promises.realpath` walk
    // the missing `nowhere` on disk and fail, so they would fall back to the
    // raw spelling; the JS implementation reaches the checkout. Win32 path
    // normalisation folds `..` first, so all three agree there.
    const spelled = [root, 'nowhere', '..', 'checkout'].join(path.sep);

    expect(restoreKey(spelled)).toBe(checkout);
    expect(cleanupKey(spelled)).toBe(checkout);
    expect(fs.realpathSync(spelled)).toBe(checkout);
  });

  it('falls back to the raw path for a checkout that does not resolve', () => {
    // Spelled with a `..` segment, so normalising it would change the key.
    const missing = [root, 'nowhere', '..', 'missing'].join(path.sep);

    expect(restoreKey(missing)).toBe(missing);
    expect(cleanupKey(missing)).toBe(missing);
    // The reset refuses such a checkout instead of locking it.
    expect(() => fs.realpathSync(missing)).toThrow();
  });
});
