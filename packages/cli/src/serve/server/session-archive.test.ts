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
import {
  archiveDaemonSessions,
  assertSessionLoadable,
  SessionArchiveCoordinator,
} from './session-archive.js';

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

describe('archiveDaemonSessions', () => {
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

  it('deduplicates ids and archives one active session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440002';
    writeSessionFile(workspaceDir, sessionId, 'active');
    const service = new SessionService(workspaceDir);
    const closeSession = vi.fn().mockResolvedValue(undefined);

    const result = await archiveDaemonSessions({
      sessionIds: [sessionId, sessionId],
      service,
      bridge: { closeSession },
      coordinator: new SessionArchiveCoordinator(),
    });

    expect(result).toEqual({
      archived: [sessionId],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionPath(workspaceDir, sessionId, 'active'))).toBe(
      false,
    );
    expect(
      fs.existsSync(sessionPath(workspaceDir, sessionId, 'archived')),
    ).toBe(true);
  });

  it('does not lock ids that are already archived or missing', async () => {
    const archivedId = '550e8400-e29b-41d4-a716-446655440003';
    const missingId = '550e8400-e29b-41d4-a716-446655440004';
    writeSessionFile(workspaceDir, archivedId, 'archived');
    const service = new SessionService(workspaceDir);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SessionArchiveCoordinator();

    await coordinator.runSharedMany([archivedId, missingId], async () => {
      const result = await archiveDaemonSessions({
        sessionIds: [archivedId, missingId],
        service,
        bridge: { closeSession },
        coordinator,
      });

      expect(result).toEqual({
        archived: [],
        alreadyArchived: [archivedId],
        notFound: [missingId],
        errors: [],
      });
    });
    expect(closeSession).not.toHaveBeenCalled();
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
  fs.writeFileSync(
    path.join(targetDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      uuid: 'record-1',
      parentUuid: null,
      sessionId,
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd: workspaceDir,
      version: '1.0.0',
    })}\n`,
  );
}

function sessionPath(
  workspaceDir: string,
  sessionId: string,
  state: 'active' | 'archived',
): string {
  const chatsDir = path.join(
    new Storage(workspaceDir).getProjectDir(),
    'chats',
  );
  return path.join(
    state === 'archived' ? path.join(chatsDir, 'archive') : chatsDir,
    `${sessionId}.jsonl`,
  );
}
