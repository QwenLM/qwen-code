/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  conflictingStateFiles,
  filterGateOutput,
  ownedStateFiles,
} from '../../scripts/verify-pr-watch-gate.mjs';

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-watch-gate-'));
  tmpDirs.push(dir);
  return dir;
}

describe('filterGateOutput', () => {
  // The scheduler hands every non-empty gate output to the model, so the
  // wrapper is the only place that can keep comment/CI events from waking it.
  it('passes a moved head and a stop, and drops everything else', () => {
    const moved = JSON.stringify({
      headSha: 'b'.repeat(40),
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: 'b'.repeat(40) }],
    });
    const stopped = JSON.stringify({ action: 'stop', reason: 'merged' });
    const fixable = JSON.stringify({
      action: 'fix',
      events: [{ type: 'comment' }],
    });
    const waiting = JSON.stringify({ action: 'wait', events: [] });

    expect(filterGateOutput(moved)).toBe(moved);
    expect(filterGateOutput(stopped)).toBe(stopped);
    expect(filterGateOutput(fixable)).toBe('');
    expect(filterGateOutput(waiting)).toBe('');
  });

  it('leaves a quiet tick quiet', () => {
    expect(filterGateOutput('')).toBe('');
    expect(filterGateOutput('   \n')).toBe('');
  });

  // A probe that changed its output shape must not be mistaken for a quiet
  // tick: forwarding it is loud, swallowing it would hide the breakage.
  it('forwards output it cannot parse instead of swallowing it', () => {
    expect(filterGateOutput('not json')).toBe('not json');
  });
});

describe('conflictingStateFiles', () => {
  it('reports nothing when the PR has no probe state', () => {
    const root = makeRoot();
    expect(conflictingStateFiles(root, 123)).toEqual([]);
  });

  // One cursor serves one watcher: a pre-existing gate cursor means another
  // consumer would take the events this watch needs, stop included.
  it('detects an existing gate cursor', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const [gate] = ownedStateFiles(123);
    writeFileSync(join(root, '.qwen', 'tmp', gate), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([
      join(root, '.qwen', 'tmp', gate),
    ]);
  });

  // A prepared autofix watch records heads in `knownHeads`, which suppresses
  // the head-move a verification watch would otherwise receive.
  it('detects a prepared autofix watch', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const [, state] = ownedStateFiles(123);
    writeFileSync(join(root, '.qwen', 'tmp', state), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([
      join(root, '.qwen', 'tmp', state),
    ]);
  });

  // Another PR's state must not block this one.
  it('ignores state for a different PR', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.qwen', 'tmp', ownedStateFiles(124)[0]), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([]);
  });
});
