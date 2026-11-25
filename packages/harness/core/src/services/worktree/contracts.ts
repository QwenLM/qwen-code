/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type WorktreeBaseRef = 'fresh' | 'head';

export interface WorktreeCreateOptions {
  /** Pull/merge request number to fetch from origin. */
  prNumber?: number;
  /** Commit source for ordinary named worktrees. Defaults to `fresh`. */
  baseRef?: WorktreeBaseRef;
  /** Checkout whose HEAD should be used when baseRef is `head`. */
  fromCwd?: string;
  /** Repository-relative directories to check out via sparse-checkout cone. */
  sparsePaths?: string[];
  /** Directories from the main checkout to link into a new worktree. */
  symlinkDirectories?: string[];
}

export type WorktreeRequest =
  | {
      kind: 'create';
      name: string;
      originalCwd: string;
      projectRoot: string;
      options?: WorktreeCreateOptions;
    }
  | {
      kind: 'attach';
      path: string;
      originalCwd: string;
      launchRoot: string;
    };

/** 调用方只提供操作意图，项目归属和运行目录由当前 Config 确定。 */
export type WorktreeEntryRequest =
  | {
      kind: 'create';
      name: string;
      options?: Omit<WorktreeCreateOptions, 'fromCwd'>;
    }
  | { kind: 'attach'; path: string };

export interface PreparedWorktree {
  settings: WorktreeSettings;
  created: boolean;
  /** prepare 所属的会话，仅用于阻止跨会话复用，绝不持久化。 */
  preparedForSessionId: string;
}

export type LeaveWorktreeRequest =
  | { action: 'keep' }
  | { action: 'remove'; force: boolean };

export type FinalizeWorktreeRequest =
  | { action: 'inspect' }
  | LeaveWorktreeRequest;

export interface WorktreeInspection {
  changedFiles: number | null;
  commits: number | null;
  owner: boolean;
}

export type LeaveWorktreeResult = {
  action: 'keep' | 'remove';
  worktreePath: string;
  originalCwd: string;
  cleanup?: {
    status: 'partial';
    message?: string;
  };
};

export type FinalizeWorktreeResult =
  | ({ action: 'inspect' } & WorktreeInspection)
  | { action: 'keep' }
  | {
      action: 'remove';
      cleanup?: {
        status: 'partial';
        message?: string;
      };
    };

/**
 * Creation defaults shared by every worktree entry point: the `--worktree`
 * startup flag, the EnterWorktree tool, and worktree-isolated subagents.
 *
 * These only take effect when a worktree is explicitly requested. A session
 * that never asks for one is unaffected, so ACP and remote workers cannot have
 * their working directory changed by configuration alone.
 */
export interface WorktreeCreationSettings {
  /** Commit a new worktree starts from. Defaults to `fresh`. */
  baseRef?: WorktreeBaseRef;
  /** Repository-relative directories to check out via sparse-checkout cone. */
  sparsePaths?: string[];
  /** Repository-relative directories to link in from the main checkout. */
  symlinkDirectories?: string[];
}

export interface WorktreeSettings {
  name: string;
  path: string;
  /** Worktree 会话激活时 CLI 实际执行命令的目录。 */
  worktreeCwd: string;
  baseSha: string;
  /**
   * Whether this CLI session owns the worktree lifecycle or merely started
   * inside an existing managed worktree. Attached sessions must never remove
   * the worktree on exit.
   */
  lifecycle?: 'owner' | 'attached';
  /** Original CWD before entering the worktree. */
  originalCwd?: string;
  /** Worktree branch name. */
  worktreeBranch?: string;
  /** Original branch before entering the worktree. */
  originalBranch?: string;
  /** 创建工作树时的比较起点，跨会话复用时保持不变。 */
  originalHeadCommit?: string;
  /** Session ID that created the worktree. */
  sessionId?: string;
  /** Whether the worktree was created via a hook (not git worktree). */
  hookBased?: boolean;
  /** Whether EnterWorktree attached to a Git worktree that already existed. */
  enteredExisting?: boolean;
  /** 当前会话尚待完成的旧 Worktree owner 释放。 */
  pendingOwnerReleasePath?: string;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  worktreeBranch?: string;
  /** 创建时的比较起点；旧 checkout 无可靠记录时为空，不代表没有提交。 */
  headCommit: string;
  existed: boolean;
  baseBranch?: string;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  baseSha: string;
  /** Whether this process owns cleanup or is attached to an existing worktree. */
  lifecycle?: 'owner' | 'attached';
  /** Whether this invocation created the worktree instead of reusing it. */
  created?: boolean;
  /** Durable owner session id, set only after ownership is verified. */
  sessionId?: string;
  /** Directory the CLI was in before startup switched into the worktree. */
  originalCwd?: string;
  /** Branch checked out in the managed worktree, when Git can report one. */
  worktreeBranch?: string;
  /** Branch checked out before startup switched into the worktree. */
  originalBranch?: string;
  /** HEAD commit used as the clean baseline when the worktree was created. */
  originalHeadCommit?: string;
}

/** Worktree 原语的短生命周期结果，由 Session Service 转换为运行时状态。 */
export interface WorktreeMaterialization {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Slug name of the worktree. */
  worktreeName: string;
  /** Worktree branch name (e.g. worktree-my-feature). */
  worktreeBranch?: string;
  /** Branch the session was on before entering the worktree. */
  originalBranch?: string;
  /** HEAD commit SHA at the time of worktree creation. */
  originalHeadCommit?: string;
  /** Whether the worktree was created via a WorktreeCreate hook (not git). */
  hookBased?: boolean;
  /** 本次调用是否新建了 checkout，用于失败补偿，不代表持久所有权。 */
  created: boolean;
  /** True when EnterWorktree switched into a pre-existing registered worktree. */
  enteredExisting?: boolean;
}

/** Optional lifecycle callbacks for worktree operations. */
export interface WorktreeCallbacks {
  onWorktreeCreate?: (name: string) => void;
  onWorktreeRemove?: (worktreePath: string) => void;
}

export type WorktreeCleanupFailureReason =
  | 'not-owner'
  | 'owner-mismatch'
  | 'missing-context'
  | 'cleanup-failed';

/** Hook 对 Worktree 删除结果的显式确认。 */
export type WorktreeRemoveHookStatus = 'removed' | 'retained' | 'unknown';

export interface WorktreeRemoveHookResult {
  status: WorktreeRemoveHookStatus;
}

export type WorktreeCleanupResult =
  | { removed: true }
  | {
      removed: false;
      reason: WorktreeCleanupFailureReason;
      message?: string;
    };

export interface WorktreeCleanupRequest {
  worktreeSettings: WorktreeSettings;
  currentSessionId: string;
  /** Only an explicit discard action may request force removal. */
  force?: boolean;
}

export interface WorktreeChangeSummary {
  changedFiles: number;
  commits: number;
}
