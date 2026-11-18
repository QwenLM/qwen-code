/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
  moveSessionTitleSidecar,
  readSessionTitleSidecar,
  removeSessionTitleSidecar,
  sessionTitleSidecarPath,
  writeSessionTitleSidecar,
} from './session-title-sidecar.js';

describe('session title sidecar', () => {
  let dir: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'qwen-title-sidecar-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a display name with its source', () => {
    const filePath = sessionTitleSidecarPath(dir, sessionId);
    expect(
      writeSessionTitleSidecar(filePath, '  CI 验证与复验  ', 'manual'),
    ).toBe(true);

    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(stored).toMatchObject({
      version: 1,
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
    expect(readSessionTitleSidecar(filePath)).toMatchObject({
      displayName: 'CI 验证与复验',
      source: 'manual',
    });
  });

  it('rejects empty names and unknown sources', () => {
    const filePath = sessionTitleSidecarPath(dir, sessionId);
    expect(writeSessionTitleSidecar(filePath, '   ', 'prompt')).toBe(false);

    for (const record of [
      { version: 1, displayName: 'x', source: 'other' },
      { version: 2, displayName: 'x', source: 'manual' },
      { displayName: 'x', source: 'manual' },
      'not an object',
    ]) {
      writeFileSync(filePath, JSON.stringify(record));
      expect(readSessionTitleSidecar(filePath)).toBeUndefined();
    }
  });

  it('treats a broken sidecar as absent', () => {
    const filePath = sessionTitleSidecarPath(dir, sessionId);
    writeFileSync(filePath, '{"version":1,"displayName":');
    expect(readSessionTitleSidecar(filePath)).toBeUndefined();
  });

  it('moves the sidecar and removes it with the session', () => {
    const from = sessionTitleSidecarPath(path.join(dir, 'chats'), sessionId);
    const toDir = path.join(dir, 'chats', 'archive');
    const to = sessionTitleSidecarPath(toDir, sessionId);
    writeSessionTitleSidecar(from, 'kept', 'prompt');
    mkdirSync(toDir, { recursive: true });

    moveSessionTitleSidecar(from, to);
    expect(readSessionTitleSidecar(from)).toBeUndefined();
    expect(readSessionTitleSidecar(to)?.displayName).toBe('kept');

    removeSessionTitleSidecar(to);
    expect(readSessionTitleSidecar(to)).toBeUndefined();
  });
});
