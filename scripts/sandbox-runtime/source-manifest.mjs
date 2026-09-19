/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const hashFile = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');

export function readSourceIdentity(root) {
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== '',
  };
}

export async function verifySourceManifest(root, manifest) {
  const canonicalRoot = await fs.realpath(root);
  const actualInputs = {};
  for (const name of Object.keys(manifest.inputs)) {
    if (path.isAbsolute(name)) {
      throw new Error(`Source manifest input must be relative: ${name}`);
    }
    const file = path.resolve(canonicalRoot, name);
    const relative = path.relative(canonicalRoot, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Source manifest input escapes the source root: ${name}`);
    }
    actualInputs[name] = await hashFile(file);
  }
  const identity = readSourceIdentity(canonicalRoot);
  assert.equal(
    identity.revision,
    manifest.revision,
    'Source revision differs from the candidate build',
  );
  assert.deepEqual(
    actualInputs,
    manifest.inputs,
    'Source inputs differ from the candidate build',
  );
  assert.equal(
    identity.dirty,
    manifest.dirty,
    'Source worktree dirtiness differs from the candidate build',
  );
  return { ...identity, inputs: actualInputs };
}
