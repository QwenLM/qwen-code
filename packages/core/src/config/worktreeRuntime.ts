/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';
import type { WorktreeEntryRequest } from '../services/worktree/contracts.js';
import { worktreeSessionService } from '../services/worktreeSessionService.js';
import {
  deactivateWorktreeOwnership,
  getWorktreeOwnerClaimId,
} from '../services/worktree-owner-state.js';
import { withWorktreeReservation } from '../services/worktree/creationReservation.js';
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHookWithStatus,
  hasWorktreeCreateHook,
} from '../services/worktreeService.js';

/** 只组装当前会话上下文；锁、持久化和失败补偿仍由 Session Service 负责。 */
export async function enterConfigWorktree(
  config: Config,
  request: WorktreeEntryRequest,
  recordWorktreeState: Config['recordWorktreeState'],
) {
  const sessionId = config.getSessionId();
  const originalCwd = config.getSessionArtifactProjectRoot();
  const hookSystem = config.getHookSystem();
  const removeHookAdapter = hookSystem
    ? {
        executeWorktreeRemoveHook: (worktreePath: string) =>
          executeWorktreeRemoveHookWithStatus(hookSystem, worktreePath),
      }
    : undefined;
  const prepared = await worktreeSessionService.prepare(
    {
      sessionId,
      activeWorktreeSettings: config.getWorktreeSettings(),
      createHookAdapter: hookSystem
        ? {
            hasWorktreeCreateHook: () =>
              hasWorktreeCreateHook({
                getRegistry: () => hookSystem.getRegistry(),
              }),
            executeWorktreeCreateHook: (name: string) =>
              executeWorktreeCreateHook(hookSystem, name),
          }
        : undefined,
      removeHookAdapter,
    },
    request.kind === 'attach'
      ? {
          ...request,
          originalCwd,
          launchRoot: config.getProjectRoot(),
        }
      : {
          ...request,
          originalCwd,
          projectRoot: originalCwd,
          options: {
            ...config.getWorktreeCreationSettings(),
            ...request.options,
            fromCwd: originalCwd,
          },
        },
  );
  const settings = await worktreeSessionService.enter(
    {
      config,
      sessionId,
      phase: 'runtime',
      recordWorktreeState,
      removeHookAdapter,
    },
    prepared,
  );
  // 创建结果只供调用方展示，不进入 Config 状态或 JSONL。
  return { ...settings, created: prepared.created };
}

export function restoreConfigWorktree(
  config: Config,
  state: TranscriptWorktreeSession,
  recordWorktreeState: Config['recordWorktreeState'],
) {
  return worktreeSessionService.restore(
    {
      config,
      sessionId: config.getSessionId(),
      phase: 'restore',
      recordWorktreeState,
    },
    state,
  );
}

export async function releaseConfigWorktreeOwnership(
  config: Config,
): Promise<void> {
  const settings = config.getWorktreeSettings();
  if (settings?.lifecycle !== 'owner' || settings.hookBased) return;
  await withWorktreeReservation(settings.path, () =>
    deactivateWorktreeOwnership(
      settings.path,
      config.getSessionId(),
      getWorktreeOwnerClaimId(config),
    ),
  );
}
