/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService, Storage } from '@qwen-code/qwen-code-core';
import {
  SessionArchivedError,
  SessionConflictError,
} from '../acp-session-bridge.js';
import { assertSessionLoadable } from './session-archive.js';

describe('assertSessionLoadable', () => {
  let runtimeDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-archive-test-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects archived sessions without reading JSONL heads', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const getLocationSpy = vi.spyOn(
      SessionService.prototype,
      'getSessionLocation',
    );

    expect(() => assertSessionLoadable(workspaceDir, sessionId)).toThrow(
      SessionArchivedError,
    );
    expect(getLocationSpy).not.toHaveBeenCalled();
  });

  it('rejects active/archive conflicts without reading JSONL heads', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440001';
    writeSessionFile(workspaceDir, sessionId, 'active');
    writeSessionFile(workspaceDir, sessionId, 'archived');
    const getLocationSpy = vi.spyOn(
      SessionService.prototype,
      'getSessionLocation',
    );

    expect(() => assertSessionLoadable(workspaceDir, sessionId)).toThrow(
      SessionConflictError,
    );
    expect(getLocationSpy).not.toHaveBeenCalled();
  });
});

function writeSessionFile(
  workspaceDir: string,
  sessionId: string,
  state: 'active' | 'archived',
): void {
  const chatsDir = path.join(
    new Storage(workspaceDir).getProjectDir(),
    'chats',
  );
  const targetDir =
    state === 'archived' ? path.join(chatsDir, 'archive') : chatsDir;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, `${sessionId}.jsonl`), '{}\n');
}
