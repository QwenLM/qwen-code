/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  moveSessionBranchSidecar,
  readSessionBranchSidecar,
  removeSessionBranchSidecar,
  sessionBranchSidecarPath,
  writeSessionBranchSidecar,
} from './session-branch-sidecar.js';

describe('session branch sidecar', () => {
  let dir: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const baseCommit = 'a'.repeat(40);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'qwen-branch-sidecar-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the recorded branch point', () => {
    const filePath = sessionBranchSidecarPath(dir, sessionId);
    expect(writeSessionBranchSidecar(filePath, `  ${baseCommit}  `)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      version: 1,
      baseCommit,
    });
    expect(readSessionBranchSidecar(filePath)).toEqual({
      version: 1,
      baseCommit,
    });
  });

  it('rejects an empty base commit and a missing or malformed file', () => {
    const filePath = sessionBranchSidecarPath(dir, sessionId);
    expect(writeSessionBranchSidecar(filePath, '   ')).toBe(false);
    expect(readSessionBranchSidecar(filePath)).toBeUndefined();
    expect(
      readSessionBranchSidecar(path.join(dir, 'absent.branch.json')),
    ).toBeUndefined();
  });

  it('rejects malformed JSON, a wrong version, and a missing base commit', () => {
    const filePath = sessionBranchSidecarPath(dir, sessionId);
    writeFileSync(filePath, '{not json', 'utf8');
    expect(readSessionBranchSidecar(filePath)).toBeUndefined();
    writeFileSync(filePath, JSON.stringify({ version: 2, baseCommit }), 'utf8');
    expect(readSessionBranchSidecar(filePath)).toBeUndefined();
    writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');
    expect(readSessionBranchSidecar(filePath)).toBeUndefined();
  });

  it('moves across archive states and removes best-effort', () => {
    const from = sessionBranchSidecarPath(dir, sessionId);
    const archivedDir = path.join(dir, 'archived');
    mkdirSync(archivedDir, { recursive: true });
    const to = sessionBranchSidecarPath(archivedDir, sessionId);
    writeSessionBranchSidecar(from, baseCommit);
    moveSessionBranchSidecar(from, to);
    expect(existsSync(from)).toBe(false);
    expect(readSessionBranchSidecar(to)).toEqual({ version: 1, baseCommit });
    // A missing source is a no-op, not a throw.
    moveSessionBranchSidecar(from, to);
    removeSessionBranchSidecar(to);
    expect(existsSync(to)).toBe(false);
    removeSessionBranchSidecar(to);
  });
});
