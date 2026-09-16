/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalEvidenceArtifact } from './goal-evidence-artifact.js';

describe('frozen Goal evidence artifacts', () => {
  let directory: string;
  let root: string;
  let output: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'goal-artifact-'));
    root = join(directory, 'artifacts');
    mkdirSync(root);
    output = join(root, 'output.txt');
    writeFileSync(output, 'first');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('reads bounded ranges across files without duplicating repeated paths', () => {
    const second = join(root, 'second.txt');
    writeFileSync(second, 'second');
    const artifact = new GoalEvidenceArtifact(root, [output, second, output]);

    expect(artifact.totalBytes).toBe(11);
    expect(artifact.read(3, 5).toString()).toBe('stsec');
    expect(artifact.read(8, 99).toString()).toBe('ond');
    expect(artifact.read(11, 4)).toHaveLength(0);
  });

  it.each(['parent path', 'symlink'])('rejects an escaping %s', (kind) => {
    const outside = join(directory, 'outside.txt');
    writeFileSync(outside, 'outside secret');
    const path = kind === 'symlink' ? join(root, 'escape.txt') : outside;
    if (kind === 'symlink') symlinkSync(outside, path);

    expect(() => new GoalEvidenceArtifact(root, [path])).toThrow(/outside/);
  });

  it('rejects directories instead of opening them as evidence files', () => {
    const nested = join(root, 'nested');
    mkdirSync(nested);
    expect(() => new GoalEvidenceArtifact(root, [nested])).toThrow(
      /regular file/,
    );
  });

  it.each(['modified', 'replaced', 'removed'])(
    'rejects a %s frozen file',
    (kind) => {
      const artifact = new GoalEvidenceArtifact(root, [output]);
      if (kind === 'modified') writeFileSync(output, 'different output');
      if (kind === 'replaced') {
        const replacement = join(root, 'replacement.txt');
        writeFileSync(replacement, 'first');
        renameSync(replacement, output);
      }
      if (kind === 'removed') rmSync(output);

      expect(() => artifact.assertUnchanged()).toThrow();
      expect(() => artifact.read(0, 4)).toThrow();
    },
  );

  it('rejects a frozen path replaced by a symlink outside the root', () => {
    const artifact = new GoalEvidenceArtifact(root, [output]);
    const outside = join(directory, 'outside.txt');
    writeFileSync(outside, 'outside secret');
    rmSync(output);
    symlinkSync(outside, output);

    expect(() => artifact.read(0, 4)).toThrow(/changed/);
  });
});
