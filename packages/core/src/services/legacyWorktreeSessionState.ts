/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';
import { runLogger } from '../utils/runLogger.js';
import { SessionStateDecryptionError } from './session-state-crypto.js';
import type { SessionStateStore } from './session-state-store.js';
import { TranscriptRepository } from './transcript/repository.js';

interface LegacyWorktreeStateReadOptions {
  /** 删除操作必须保留无法解密的 owner 状态；恢复流程仍可兼容忽略。 */
  failOnDecryptionError?: boolean;
}

/** 优先采用 JSONL 的对象/null 状态，仅对尚无状态的历史会话读取 sidecar。 */
export async function resolveSessionWorktreeState(
  sessionPath: string,
  sessionId: string,
  stateStore?: SessionStateStore,
  options: LegacyWorktreeStateReadOptions = {},
): Promise<TranscriptWorktreeSession | null | undefined> {
  const index = await new TranscriptRepository().loadIndex(sessionPath, {
    profile: { kind: 'metadata' },
  });
  const state = index?.metadata.worktreeSessions.get(sessionId);
  if (state !== undefined || !stateStore) {
    return state;
  }
  const legacyState = await getLegacyWorktreeState(stateStore, options);
  return legacyState ? projectLegacyWorktreeState(legacyState) : undefined;
}

const LEGACY_WORKTREE_STATE_SEGMENT_KEY = 'worktreeSession';

/** 旧版本写入 SessionStateStore 的 Worktree sidecar，仅用于兼容读取。 */
export interface PersistedWorktreeState {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  lifecycle?: 'owner';
  worktreeBranch?: string;
  originalBranch?: string;
  originalHeadCommit?: string;
  sessionId: string;
  hookBased?: boolean;
  enteredExisting?: boolean;
}

/** 校验旧 sidecar 的运行时形状，避免损坏数据进入 Worktree 恢复流程。 */
function isPersistedWorktreeState(
  state: unknown,
): state is PersistedWorktreeState {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return false;
  }
  const candidate = state as Record<string, unknown>;
  const hasRequiredString = (key: string) =>
    typeof candidate[key] === 'string' && candidate[key].trim().length > 0;
  const hasOptionalString = (key: string) =>
    candidate[key] === undefined || typeof candidate[key] === 'string';
  const hasOptionalBoolean = (key: string) =>
    candidate[key] === undefined || typeof candidate[key] === 'boolean';

  return (
    hasRequiredString('originalCwd') &&
    hasRequiredString('worktreePath') &&
    hasRequiredString('worktreeName') &&
    hasRequiredString('sessionId') &&
    (candidate['lifecycle'] === undefined ||
      candidate['lifecycle'] === 'owner') &&
    hasOptionalString('worktreeBranch') &&
    hasOptionalString('originalBranch') &&
    hasOptionalString('originalHeadCommit') &&
    hasOptionalBoolean('hookBased') &&
    hasOptionalBoolean('enteredExisting')
  );
}

/** 读取旧 sidecar；新会话不得调用对应写路径。 */
export async function getLegacyWorktreeState(
  store: SessionStateStore,
  options: LegacyWorktreeStateReadOptions = {},
): Promise<PersistedWorktreeState | null> {
  let state: unknown;
  try {
    state = await store.getSegment<unknown>(
      LEGACY_WORKTREE_STATE_SEGMENT_KEY,
    );
  } catch (error) {
    if (
      error instanceof SessionStateDecryptionError &&
      !options.failOnDecryptionError
    ) {
      runLogger.warn(
        '[legacy-worktree-session-state] failed to decrypt legacy worktree sidecar; treating it as unavailable.',
      );
      return null;
    }
    throw error;
  }
  if (state === null || state === undefined) return null;
  if (!isPersistedWorktreeState(state)) {
    throw new Error(
      'Invalid legacy worktree state; the persisted session was left unchanged.',
    );
  }
  return state;
}

/** 将旧 sidecar 投影成 JSONL 状态，worktreeCwd 留给 restore 统一推导。 */
export function projectLegacyWorktreeState(
  state: PersistedWorktreeState,
): TranscriptWorktreeSession {
  return {
    originalCwd: state.originalCwd,
    worktreePath: state.worktreePath,
    worktreeName: state.worktreeName,
    worktreeBranch: state.worktreeBranch,
    originalBranch: state.originalBranch,
    originalHeadCommit: state.originalHeadCommit,
    sessionId: state.sessionId,
    lifecycle: state.lifecycle === 'owner' ? 'owner' : 'attached',
    hookBased: state.hookBased,
    enteredExisting: state.enteredExisting,
  };
}
