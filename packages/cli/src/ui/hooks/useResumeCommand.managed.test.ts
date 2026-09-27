/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  Storage,
  SessionService,
  type Config,
} from '@qwen-code/qwen-code-core';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { useResumeCommand } from './useResumeCommand.js';
import type { LoadedSettings } from '../../config/settings.js';

it('rejects in-session Managed resume before changing the active session', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'qwen-managed-switch-review-')),
  );
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  Storage.setRuntimeBaseDir(runtime);
  let unmount: (() => void) | undefined;
  try {
    const storage = new Storage(workspace, runtime);
    const targetId = randomUUID();
    const oldId = randomUUID();
    let currentId: string = oldId;
    const transcriptPath = path.join(
      storage.getProjectDir(),
      'chats',
      `${targetId}.jsonl`,
    );
    const options = {
      runtimeBaseDir: runtime,
      sessionId: targetId,
      transcriptPath,
      sessionKey: {
        tenantId: 'review',
        workspaceId: 'review',
        sessionId: targetId,
      },
      cwd: workspace,
      version: 'test',
      workerId: 'review',
      activationLeaseDurationMs: 60000,
    };
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    const ref = (kind: string) => ({
      resourceId: randomUUID(),
      kind,
      schemaVersion: 1,
      byteLength: 2,
      digest: '9'.repeat(64),
    });
    const session = await openManagedSession({
      ...options,
      create: {
        definitionRef: ref('definition'),
        rootSnapshotRef: ref('root'),
        createdBy: 'review',
      },
    });
    await session.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: targetId,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      version: 'test',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'Managed history' }] },
    });
    await session.close();
    const before = await readFile(transcriptPath);
    const addItem = vi.fn();
    const switchUi = vi.fn();
    const llm = {
      beginTelemetrySwap: () => true,
      commitTelemetrySwap: vi.fn(),
      abortTelemetrySwap: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    const idleRegistry = {
      hasRunningTasks: () => false,
      hasRunningEntries: () => false,
      getRunning: () => [],
      reset: vi.fn(),
      abortAll: vi.fn(),
    };
    const config = {
      storage,
      getSessionId: () => currentId,
      getTargetDir: () => workspace,
      getProjectRoot: () => workspace,
      getCliVersion: () => 'test',
      getResumedSessionData: () => undefined,
      getSessionService: () => new SessionService(workspace),
      getLlmClient: () => llm,
      startNewSession: vi.fn((id: string) => {
        currentId = id;
      }),
      getGoalRuntimeReady: async () => ({}),
      getBackgroundTaskRegistry: () => idleRegistry,
      getBackgroundShellRegistry: () => idleRegistry,
      getMonitorRegistry: () => idleRegistry,
      getWorkflowRunRegistry: () => idleRegistry,
      loadPausedBackgroundAgents: async () => [],
      getChatRecordingService: () => undefined,
      getToolRegistry: () => ({ getTool: () => undefined }),
      getDebugLogger: () => ({ warn: vi.fn() }),
    } as unknown as Config;
    const hook = renderHook(() =>
      useResumeCommand({
        config,
        settings: { merged: {} } as LoadedSettings,
        historyManager: { addItem, clearItems: vi.fn(), loadHistory: vi.fn() },
        startNewSession: switchUi,
      }),
    );
    unmount = hook.unmount;
    await act(async () => {
      await hook.result.current.handleResume(targetId);
    });
    expect(currentId).toBe(oldId);
    expect(config.startNewSession).not.toHaveBeenCalled();
    expect(switchUi).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('belongs to managed'),
      }),
      expect.any(Number),
    );
    expect(await readFile(transcriptPath)).toEqual(before);
  } finally {
    unmount?.();
    Storage.setRuntimeBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});
