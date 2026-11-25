/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BRAND_NAME, BRAND_WORKTREE_OWNER_FILE } from '../config/brand.js';
import type { Config } from '../config/config.js';
import { clearSessionPromptCaches } from '../context/system-context.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';
import type { TranscriptWriterHandle } from './transcript/writer-handle.js';
import {
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
  hasIsolatedShellSession,
  runWithShellSession,
} from '../utils/Shell.js';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { isMissingPathError } from '../utils/errors.js';
import { isFsTouchUnsafePath } from '../utils/pathShape.js';
import { runWithWorkspaceTransition } from '../utils/workspaceTransition.js';
import type {
  FinalizeWorktreeRequest,
  FinalizeWorktreeResult,
  LeaveWorktreeRequest,
  LeaveWorktreeResult,
  PreparedWorktree,
  WorktreeRequest,
  WorktreeInspection,
  WorktreeMaterialization,
  WorktreeRemoveHookResult,
  WorktreeSettings,
} from './worktree/contracts.js';
import {
  cleanupWorktreeSession,
  cleanupCreatedWorktreeForSession,
  countWorktreeChanges,
  readWorktreeBaseCommit,
  createWorktreeForSession,
  findProjectRootForWorktree,
  resolveExistingWorktreeForSession,
  WorktreeRepositoryNotFoundError,
} from './worktreeService.js';
import { validateWorktreeSlug, worktreePathFor } from './worktree/naming.js';
import { canonicalizeWorktreePath } from './worktree/pathIdentity.js';
import {
  addWorktreeReservation,
  withWorktreeReservation,
  type WorktreeCreationReservation,
} from './worktree/creationReservation.js';
import {
  claimWorktreeOwnership,
  claimReusableWorktreeOwnership,
  getWorktreeEntryOwnership,
  getWorktreeOwnerClaimId,
  rollbackReusableWorktreeOwnership,
  hasRegisteredWorktree,
  inspectWorktreeOwnership,
  isWorktreeOwnedBySession,
  prepareHookWorktreeOwnershipRelease,
  readWorktreeOwnerState,
  releaseWorktreeOwnershipForHandoff,
  releaseWorktreeOwnership,
  type WorktreeOwnerState,
} from './worktree-owner-state.js';

export interface WorktreeCreateHookAdapter {
  hasWorktreeCreateHook: () => boolean;
  executeWorktreeCreateHook: (name: string) => Promise<{ worktreePath: string }>;
}

export interface WorktreeRemoveHookAdapter {
  executeWorktreeRemoveHook: (
    worktreePath: string,
  ) => Promise<WorktreeRemoveHookResult | boolean>;
}

/** 仅在 prepare 调用期间存在，不写入 Config 或 JSONL。 */
export interface WorktreePrepareContext {
  sessionId: string;
  activeWorktreeSettings?: WorktreeSettings;
  createHookAdapter?: WorktreeCreateHookAdapter;
  removeHookAdapter?: WorktreeRemoveHookAdapter;
}

export interface WorktreeSessionContext {
  config: Config;
  sessionId: string;
  phase: 'runtime' | 'restore';
  /** 所有入口均在 Writer 就绪后执行，不能绕过持久化。 */
  recordWorktreeState: (
    state: TranscriptWorktreeSession | null,
    discardLegacyFileHistorySnapshots?: boolean,
  ) => Promise<void>;
  removeHookAdapter?: WorktreeRemoveHookAdapter;
}

export type WorktreeRestoreResult =
  | { status: 'restored'; settings: WorktreeSettings }
  | { status: 'fallback'; pendingCleanup?: string }
  | {
      status: 'failed';
      message: string;
    };

export type WorktreeEnterResult = WorktreeSettings & {
  /** 目标状态已提交，但补偿未完整完成时返回给调用方的瞬时警告。 */
  entryWarning?: string;
};

export interface WorktreeSessionService {
  prepare(
    context: WorktreePrepareContext,
    request: WorktreeRequest,
  ): Promise<PreparedWorktree>;
  enter(
    context: WorktreeSessionContext,
    prepared: PreparedWorktree,
  ): Promise<WorktreeEnterResult>;
  restore(
    context: WorktreeSessionContext,
    state: TranscriptWorktreeSession,
  ): Promise<WorktreeRestoreResult>;
  leave(
    context: WorktreeSessionContext,
    request: LeaveWorktreeRequest,
  ): Promise<LeaveWorktreeResult>;
  finalize(
    context: WorktreeSessionContext,
    request: FinalizeWorktreeRequest,
  ): Promise<FinalizeWorktreeResult>;
}

interface RuntimeSnapshot {
  targetDir: string;
  workingDir: string;
  shellOriginalCwd: string;
  workspaceDirectories: readonly string[];
  worktreeSettings: WorktreeSettings | undefined;
  processCwd: string;
}

// 预占只绑定本次 prepare 结果，不增加 PreparedWorktree/Config/JSONL 状态字段。
const creationReservations = new WeakMap<
  PreparedWorktree,
  WorktreeCreationReservation[]
>();

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function assertRecordedWorktreePathIdentity(
  worktreePath: string,
  worktreeCwd: string | undefined,
): Promise<void> {
  if (!worktreeCwd) return;
  const checkoutRoot = await canonicalizeWorktreePath(worktreePath);
  const runtimeCwd = await canonicalizeWorktreePath(worktreeCwd);
  // 历史 Hook 可能持久化符号链接别名；别名失效后，不能把查不到注册当作 owner 已释放。
  if (!isInsidePath(checkoutRoot, runtimeCwd)) {
    throw new Error(
      `Cannot verify worktree path ${worktreePath} against recorded working directory ${worktreeCwd}. Restore the checkout path before retrying; ownership state was preserved.`,
    );
  }
}

async function removeWorktreeRuntimeDirectories(
  directories: readonly string[],
  settings: Pick<WorktreeSettings, 'path'> | undefined,
): Promise<readonly string[]> {
  if (!settings) {
    return directories;
  }
  const checkoutRoot = await canonicalizeWorktreePath(settings.path);
  // WorkspaceContext 保存真实路径；Hook 的别名路径必须先解析再移除整个 checkout。
  return directories.filter(
    (directory) => !isInsidePath(checkoutRoot, path.resolve(directory)),
  );
}

async function removeOriginalWorkspaceDirectory(
  directories: readonly string[],
  originalCwd: string | undefined,
): Promise<readonly string[]> {
  if (!originalCwd) return directories;
  const canonicalOriginalCwd = await canonicalizeWorktreePath(originalCwd);
  // WorkspaceContext 已规范化目录；仅比较身份，不改写会话及产物的原始归属。
  return directories.filter(
    (directory) => path.relative(canonicalOriginalCwd, directory) !== '',
  );
}

async function resolveCheckoutRoot(
  request: WorktreeRequest,
  hookBased: boolean,
): Promise<string> {
  const discovered = await findProjectRootForWorktree(request.originalCwd);
  if (!discovered && request.kind === 'create' && !hookBased) {
    throw new WorktreeRepositoryNotFoundError(request.originalCwd);
  }
  // 普通工作区也能进入其内嵌套仓库的 checkout；合法性由 Attach 校验负责。
  return fs.realpath(
    discovered ??
      (request.kind === 'create' ? request.projectRoot : request.originalCwd),
  );
}

async function resolveWorktreeCwd(
  checkoutRoot: string,
  originalCwd: string,
  worktreePath: string,
): Promise<string> {
  const canonicalOriginalCwd = await fs.realpath(originalCwd);
  const relativeProjectPath = path.relative(checkoutRoot, canonicalOriginalCwd);
  if (
    path.isAbsolute(relativeProjectPath) ||
    relativeProjectPath === '..' ||
    relativeProjectPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Cannot prepare worktree: ${originalCwd} is outside the source checkout.`,
    );
  }

  const canonicalWorktreePath = await fs.realpath(worktreePath);
  const candidate = path.resolve(worktreePath, relativeProjectPath);
  const canonicalCandidatePath = path.resolve(
    canonicalWorktreePath,
    relativeProjectPath,
  );
  if (!isInsidePath(canonicalWorktreePath, canonicalCandidatePath)) {
    throw new Error(
      `Cannot prepare worktree: relative project path escapes ${worktreePath}.`,
    );
  }

  const target = await fs.stat(candidate).catch(() => undefined);
  if (!target?.isDirectory()) {
    throw new Error(
      `Cannot prepare worktree: ${candidate} does not exist as a directory.`,
    );
  }

  const canonicalCandidate = await fs.realpath(candidate);
  if (!isInsidePath(canonicalWorktreePath, canonicalCandidate)) {
    throw new Error(
      `Cannot prepare worktree: ${candidate} resolves outside the worktree.`,
    );
  }
  return canonicalCandidate;
}

function toWorktreeSettings(
  session: WorktreeMaterialization,
  originalCwd: string,
  worktreeCwd: string,
): WorktreeSettings {
  return {
    name: session.worktreeName,
    path: session.worktreePath,
    worktreeCwd,
    baseSha: session.originalHeadCommit ?? '',
    originalCwd,
    worktreeBranch: session.worktreeBranch,
    originalBranch: session.originalBranch,
    originalHeadCommit: session.originalHeadCommit,
    hookBased: session.hookBased,
    enteredExisting: session.enteredExisting,
  };
}

function captureRuntimeSnapshot(config: Config): RuntimeSnapshot {
  return {
    targetDir: config.getTargetDir(),
    workingDir: config.getWorkingDir(),
    shellOriginalCwd: getOriginalCwd(),
    workspaceDirectories: config.getWorkspaceContext().getDirectories(),
    worktreeSettings: config.getWorktreeSettings(),
    processCwd: process.cwd(),
  };
}

function applyWorktreeRuntimeState(
  config: Config,
  snapshot: RuntimeSnapshot,
): void {
  // 先执行可能失败的进程目录切换，避免失败时先安装部分 Config/Shell 状态。
  if (!hasIsolatedShellSession(config) && process.cwd() !== snapshot.processCwd) {
    process.chdir(snapshot.processCwd);
  }
  config.setWorktreeSettings(snapshot.worktreeSettings);
  config.setTargetDir(snapshot.targetDir);
  config.setWorkingDir(snapshot.workingDir);
  setCwd(snapshot.workingDir);
  setOriginalCwd(snapshot.shellOriginalCwd);
  config.getWorkspaceContext().setDirectories(snapshot.workspaceDirectories);
  config.refreshRuntimeWorkspaceServices();
  config.synchronizeWorktreeRuntimeState(
    snapshot.worktreeSettings
      ? toTranscriptWorktreeSession(
          snapshot.worktreeSettings,
          config.getSessionId(),
        )
      : null,
  );
  clearSessionPromptCaches(config);
}

/** 仅在运行目录与 JSONL 状态均已提交后，才丢弃旧 checkout 的内存快照。 */
function commitFileHistoryRuntimeCwd(
  config: Config,
  snapshot: RuntimeSnapshot,
): void {
  config.getFileHistoryManager()?.rebaseCwd(snapshot.workingDir);
}

function buildRuntimeSnapshot(
  worktreeSettings: WorktreeSettings | undefined,
  cwd: string,
  retainedDirectories: readonly string[],
): RuntimeSnapshot {
  return {
    targetDir: cwd,
    workingDir: cwd,
    shellOriginalCwd: cwd,
    workspaceDirectories: [cwd, ...retainedDirectories.filter((dir) => dir !== cwd)],
    worktreeSettings,
    processCwd: cwd,
  };
}

export function toTranscriptWorktreeSession(
  settings: WorktreeSettings,
  sessionId: string,
): TranscriptWorktreeSession {
  if (!settings.originalCwd) {
    throw new Error('Cannot persist a worktree session without originalCwd.');
  }
  const originalHeadCommit =
    settings.originalHeadCommit || settings.baseSha || undefined;
  return {
    originalCwd: settings.originalCwd,
    worktreePath: settings.path,
    worktreeCwd: settings.worktreeCwd,
    worktreeName: settings.name,
    worktreeBranch: settings.worktreeBranch,
    originalBranch: settings.originalBranch,
    ...(originalHeadCommit ? { originalHeadCommit } : {}),
    sessionId: settings.sessionId ?? sessionId,
    lifecycle: settings.lifecycle,
    hookBased: settings.hookBased,
    enteredExisting: settings.enteredExisting,
    pendingOwnerReleasePath: settings.pendingOwnerReleasePath,
  };
}

/** Fork 可以继续使用当前 checkout，但不能继承父会话的清理权限。 */
export function toAttachedForkWorktreeSession(
  source: WorktreeSettings | TranscriptWorktreeSession,
  forkSessionId: string,
): TranscriptWorktreeSession {
  const { pendingOwnerReleasePath: _pendingOwnerReleasePath, ...session } =
    'worktreePath' in source
      ? source
      : toTranscriptWorktreeSession(source, forkSessionId);
  return {
    ...session,
    sessionId: forkSessionId,
    lifecycle: 'attached',
  };
}

/** 复用 Writer 初始化流程，为新会话写入明确的对象或 null 三态。 */
export async function recordInitialWorktreeTranscriptState(
  config: {
    getWorktreeSettings(): WorktreeSettings | undefined;
    getSessionId(): string;
  },
  writer: Pick<TranscriptWriterHandle, 'recordWorktreeState'>,
): Promise<void> {
  const settings = config.getWorktreeSettings();
  await writer.recordWorktreeState(
    settings
      ? toTranscriptWorktreeSession(settings, config.getSessionId())
      : null,
  );
}

async function persistWorktreeState(
  context: WorktreeSessionContext,
  state: TranscriptWorktreeSession | null,
  discardLegacyFileHistorySnapshots = false,
): Promise<void> {
  if (discardLegacyFileHistorySnapshots) {
    await context.recordWorktreeState(state, true);
  } else {
    await context.recordWorktreeState(state);
  }
}

function assertEnterPersistence(context: WorktreeSessionContext): void {
  if (context.phase === 'restore') {
    throw new Error('Cannot enter a worktree while restoring a session.');
  }
  assertPersistence(context);
}

function assertPersistence(context: WorktreeSessionContext): void {
  if (typeof context.recordWorktreeState !== 'function') {
    throw new Error('Worktree operations require immediate transcript persistence.');
  }
}

function pathsReferToSameWorktree(
  first: string,
  second: string,
): Promise<boolean> {
  return Promise.all([
    fs.realpath(first).catch(() => undefined),
    fs.realpath(second).catch(() => undefined),
  ]).then(([canonicalFirst, canonicalSecond]) =>
    canonicalFirst !== undefined && canonicalFirst === canonicalSecond,
  );
}

async function resolvePreviousOwnerPathForSwitch(
  context: WorktreeSessionContext,
  previous: WorktreeSettings | undefined,
  next: Pick<WorktreeSettings, 'path'>,
): Promise<string | undefined> {
  if (
    previous?.lifecycle !== 'owner' ||
    previous.sessionId !== context.sessionId ||
    !previous.path ||
    (await pathsReferToSameWorktree(previous.path, next.path))
  ) {
    return undefined;
  }

  await assertRecordedWorktreePathIdentity(previous.path, previous.worktreeCwd);
  const ownership = await inspectWorktreeOwnership(
    previous.path,
    context.sessionId,
    previous.hookBased === true,
    previous.originalCwd,
  );
  if (ownership === 'owned-by-session') {
    return previous.path;
  }
  if (ownership === 'not-owned' || ownership === 'owned-by-another-session') {
    return undefined;
  }
  throw new Error(
    'Cannot verify previous worktree ownership before switching worktrees.',
  );
}

async function releaseWorktreeOwnershipOrThrow(
  worktreePath: string,
  sessionId: string,
  hookBased: boolean,
): Promise<void> {
  if (!(await releaseWorktreeOwnership(worktreePath, sessionId, hookBased))) {
    throw new Error(
      `Failed to release worktree ownership for session ${sessionId}.`,
    );
  }
}

async function releasePendingOwnerHandoff(
  sessionId: string,
  previousOwnerPath: string,
  originalCwd: string | undefined,
  reservations?: WorktreeCreationReservation[],
): Promise<Awaited<ReturnType<typeof releaseWorktreeOwnershipForHandoff>>> {
  let outcome: Awaited<ReturnType<typeof releaseWorktreeOwnershipForHandoff>>;
  try {
    outcome = await withWorktreeReservation(
      previousOwnerPath,
      async () => {
        const result = await releaseWorktreeOwnershipForHandoff(
          previousOwnerPath,
          sessionId,
          originalCwd,
        );
        if (result === 'owned-by-another-session') {
          const owner = await readWorktreeOwnerState(previousOwnerPath, false);
          if (
            owner?.ownerPid !== undefined &&
            owner.ownerSessionId !== sessionId
          )
            return 'already-released';
        }
        return result;
      },
      reservations,
    );
  } catch (error) {
    runLogger.warn(
      '[WorktreeSession] 旧 Worktree owner 交接释放异常，保留交接状态等待恢复重试。',
      error,
    );
    outcome = 'unavailable';
  }

  return outcome;
}

interface PendingOwnerHandoffSettlement {
  settings: WorktreeSettings;
  completed: boolean;
}

/**
 * 结算旧 checkout 的 owner 交接，不改变当前 checkout 的生命周期权限。
 *
 * attached Worktree 也可能携带旧 owner 的交接债务；此处只移除该债务，
 * 绝不能借此赋予当前 Worktree 删除权限。
 */
async function settlePendingOwnerHandoff(
  context: WorktreeSessionContext,
  settings: WorktreeSettings,
  reservations?: WorktreeCreationReservation[],
): Promise<PendingOwnerHandoffSettlement> {
  const previousOwnerPath = settings.pendingOwnerReleasePath;
  if (!previousOwnerPath) {
    return { settings, completed: true };
  }

  const outcome = await releasePendingOwnerHandoff(
    context.sessionId,
    previousOwnerPath,
    settings.originalCwd,
    reservations,
  );

  if (outcome !== 'released' && outcome !== 'already-released') {
    runLogger.warn(
      `[WorktreeSession] 旧 Worktree owner 交接尚未完成，结果=${outcome}。`,
    );
    return { settings, completed: false };
  }

  const { pendingOwnerReleasePath: _pendingOwnerReleasePath, ...settled } =
    settings;
  context.config.setWorktreeSettings(settled);
  try {
    await persistWorktreeState(
      context,
      toTranscriptWorktreeSession(settled, context.sessionId),
    );
  } catch (error) {
    context.config.setWorktreeSettings(settings);
    runLogger.warn(
      '[WorktreeSession] 旧 Worktree owner 已释放，但交接状态确认写入失败，将在恢复时重试。',
      error,
    );
    return { settings, completed: false };
  }
  return { settings: settled, completed: true };
}

async function completePendingOwnerHandoff(
  context: WorktreeSessionContext,
  settings: WorktreeSettings,
  reservations?: WorktreeCreationReservation[],
): Promise<WorktreeSettings> {
  const settlement = await settlePendingOwnerHandoff(
    context,
    settings,
    reservations,
  );
  if (!settlement.completed) {
    throw new Error('Cannot complete the pending worktree owner handoff.');
  }
  return settlement.settings;
}

async function resolveRestoreWorktreeCwd(
  state: TranscriptWorktreeSession,
  canonicalWorktreePath: string,
): Promise<{ worktreeCwd?: string; error?: string }> {
  if (state.worktreeCwd !== undefined) {
    if (typeof state.worktreeCwd !== 'string' || state.worktreeCwd.length === 0) {
      return { error: 'Persisted worktreeCwd is invalid.' };
    }
    try {
      const canonicalCwd = await fs.realpath(state.worktreeCwd);
      const stat = await fs.stat(canonicalCwd);
      if (!stat.isDirectory() || !isInsidePath(canonicalWorktreePath, canonicalCwd)) {
        return { error: 'Persisted worktreeCwd is outside the worktree.' };
      }
      return { worktreeCwd: canonicalCwd };
    } catch {
      return { error: 'Persisted worktreeCwd is not an accessible directory.' };
    }
  }

  try {
    const sourceLayout = await resolveGitRepositoryLayout(state.originalCwd);
    if (
      sourceLayout &&
      (state.hookBased ||
        (await findProjectRootForWorktree(canonicalWorktreePath)) ===
          path.dirname(sourceLayout.commonDir))
    ) {
      return {
        worktreeCwd: await resolveWorktreeCwd(
          await fs.realpath(sourceLayout.worktreeRoot),
          state.originalCwd,
          canonicalWorktreePath,
        ),
      };
    }
  } catch {
    // 历史状态无法精确映射时，Worktree 根仍可提供连续恢复能力。
  }
  return { worktreeCwd: canonicalWorktreePath };
}

function isValidTranscriptWorktreeState(
  state: TranscriptWorktreeSession,
): boolean {
  const isSafeAbsolutePath = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    path.isAbsolute(candidate) &&
    !isFsTouchUnsafePath(candidate);
  return (
    isSafeAbsolutePath(state.worktreePath) &&
    (state.worktreeCwd === undefined ||
      isSafeAbsolutePath(state.worktreeCwd)) &&
    typeof state.worktreeName === 'string' &&
    state.worktreeName.length > 0 &&
    isSafeAbsolutePath(state.originalCwd) &&
    typeof state.sessionId === 'string' &&
    state.sessionId.length > 0 &&
    (state.pendingExit === undefined || state.pendingExit === true) &&
    (state.pendingOwnerReleasePath === undefined ||
      isSafeAbsolutePath(state.pendingOwnerReleasePath))
  );
}

async function hasMatchingRepositoryIdentity(
  state: Pick<TranscriptWorktreeSession, 'originalCwd' | 'hookBased'>,
  worktreePath: string,
  allowNestedRepository = false,
): Promise<boolean> {
  if (state.hookBased) {
    // Hook 可返回非 Git 目录，但遗留注册证明它原本是 Git checkout。
    // 指针损坏时不能降为 attached，也不能创建新的根目录 owner 标记。
    if (await hasRegisteredWorktree(state.originalCwd, worktreePath)) {
      return false;
    }
    const owner = await readWorktreeOwnerState(worktreePath, true);
    if (!owner?.originalCwd) {
      // 历史 attached 会话在原 owner 退出后可能没有外部标记，仍以已选 transcript 为恢复依据。
      return true;
    }
    if (isFsTouchUnsafePath(owner.originalCwd)) {
      return false;
    }
    const [recordedOrigin, ownerOrigin] = await Promise.all([
      canonicalizeWorktreePath(state.originalCwd),
      canonicalizeWorktreePath(owner.originalCwd),
    ]);
    return recordedOrigin === ownerOrigin;
  }
  const [sourceLayout, worktreeLayout] = await Promise.all([
    resolveGitRepositoryLayout(state.originalCwd),
    resolveGitRepositoryLayout(worktreePath),
  ]);
  if (
    !worktreeLayout?.isWorktree ||
    (await fs.realpath(worktreeLayout.worktreeRoot)) !== worktreePath
  ) {
    return false;
  }
  if (
    sourceLayout &&
    path.normalize(sourceLayout.commonDir).normalize('NFC') ===
      path.normalize(worktreeLayout.commonDir).normalize('NFC')
  ) {
    return true;
  }
  // 与首次 Attach 相同：允许原项目下的嵌套仓库，但不是任意其他仓库。
  // 命名创建仍要求同仓库，不能把目标路径上的嵌套 checkout 当作创建结果复用。
  if (!allowNestedRepository) return false;
  const originalRoot = await fs.realpath(state.originalCwd);
  const repositoryRoot = path.dirname(worktreeLayout.commonDir);
  return (
    repositoryRoot !== originalRoot &&
    isInsidePath(originalRoot, repositoryRoot)
  );
}

/**
 * 验证持久化的 owner 交接只会指向原项目或其嵌套仓库中的 linked Worktree。
 *
 * 已删除的旧 checkout 仍须通过注册或 owner 证据结算；无法验证时保留交接。
 * 仍存在的路径必须完整验证，避免损坏 JSONL 清除当前或其他仓库的 owner。
 */
async function resolveValidatedPendingOwnerReleasePath(
  state: TranscriptWorktreeSession,
  canonicalCurrentWorktreePath?: string,
  reservations?: WorktreeCreationReservation[],
): Promise<string | undefined> {
  const pendingOwnerReleasePath = state.pendingOwnerReleasePath;
  if (!pendingOwnerReleasePath) {
    return undefined;
  }

  if (
    path.resolve(pendingOwnerReleasePath) === path.resolve(state.worktreePath)
  ) {
    throw new Error(
      'Pending worktree owner handoff cannot target the current worktree.',
    );
  }

  let pendingStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    pendingStat = await fs.stat(pendingOwnerReleasePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return pendingOwnerReleasePath;
    }
    throw new Error(
      `Pending worktree owner handoff path cannot be accessed: ${toError(error).message}`,
    );
  }
  if (!pendingStat.isDirectory()) {
    throw new Error('Pending worktree owner handoff path is not a directory.');
  }

  const canonicalPendingPath = await fs.realpath(pendingOwnerReleasePath);
  if (
    canonicalCurrentWorktreePath !== undefined &&
    isInsidePath(canonicalCurrentWorktreePath, canonicalPendingPath)
  ) {
    throw new Error(
      'Pending worktree owner handoff cannot target the current worktree or its child directories.',
    );
  }

  const pendingOwner = await readWorktreeOwnerState(canonicalPendingPath);
  const matchesHookSource =
    pendingOwner?.ownerSessionId === state.sessionId &&
    pendingOwner.originalCwd !== undefined &&
    (pendingOwner.originalCwd === path.resolve(state.originalCwd) ||
      (await pathsReferToSameWorktree(
        pendingOwner.originalCwd,
        state.originalCwd,
      )));
  if (
    !matchesHookSource &&
    !(await hasMatchingRepositoryIdentity(
      // 当前目标可能是 Hook Worktree，不能因此跳过旧 Git checkout 的身份校验。
      { originalCwd: state.originalCwd },
      canonicalPendingPath,
      true,
    )) &&
    !(await hasRegisteredWorktree(state.originalCwd, canonicalPendingPath))
  ) {
    // 非 Git Hook 的来源证明随 owner 一起删除。确认写入中断后，
    // 在锁内确认 owner 已不存在即可结束交接，不再尝试释放此路径。
    const ownership = await withWorktreeReservation(
      canonicalPendingPath,
      () =>
        inspectWorktreeOwnership(
          canonicalPendingPath,
          state.sessionId,
          true,
          state.originalCwd,
        ),
      reservations,
    );
    if (
      ownership === 'not-owned' &&
      // 不能把当前 checkout 的普通子目录当作已完成交接的另一个 checkout。
      (canonicalCurrentWorktreePath === undefined ||
        !isInsidePath(canonicalCurrentWorktreePath, canonicalPendingPath))
    ) {
      return undefined;
    }
    if (ownership === 'unavailable') {
      throw new Error('Cannot verify pending worktree owner handoff metadata.');
    }
    throw new Error(
      'Pending worktree owner handoff belongs to a different Git repository.',
    );
  }

  return canonicalPendingPath;
}

/**
 * 在销毁 transcript 前完成其中记录的 owner 交接。
 *
 * 此函数不会修改 transcript：释放成功后保留的交接标记可在后续恢复时
 * 被幂等地结算；释放失败则调用方必须保留 transcript，避免永久丢失重试
 * 所需的持久化信息。
 */
export async function releasePersistedWorktreeOwnerHandoff(
  state: TranscriptWorktreeSession,
  sessionId: string,
  reservations?: WorktreeCreationReservation[],
): Promise<void> {
  if (!state.pendingOwnerReleasePath) {
    return;
  }
  if (state.sessionId !== sessionId) {
    throw new Error(
      'Pending worktree owner handoff belongs to a different session.',
    );
  }

  let canonicalCurrentWorktreePath: string | undefined;
  try {
    canonicalCurrentWorktreePath = await fs.realpath(state.worktreePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new Error(
        `Current worktree path cannot be accessed: ${toError(error).message}`,
      );
    }
  }

  const previousOwnerPath = await resolveValidatedPendingOwnerReleasePath(
    state,
    canonicalCurrentWorktreePath,
    reservations,
  );
  if (!previousOwnerPath) {
    return;
  }

  const outcome = await releasePendingOwnerHandoff(
    sessionId,
    previousOwnerPath,
    state.originalCwd,
    reservations,
  );
  if (outcome !== 'released' && outcome !== 'already-released') {
    throw new Error(
      `Cannot complete the pending worktree owner handoff: ${outcome}.`,
    );
  }
}

/**
 * 在删除 transcript 前结算当前会话拥有的 Worktree 及其遗留交接。
 *
 * owner metadata 是 Worktree 生命周期权限的唯一持久化来源；若先删除
 * transcript 而不释放它，后续会话无法再安全地接管该 checkout。
 */
export async function releasePersistedWorktreeSessionOwnership(
  state: TranscriptWorktreeSession,
  sessionId: string,
): Promise<void> {
  await withWorktreeReservation(state.worktreePath, () =>
    releaseReservedSessionOwnership(state, sessionId),
  );
}

class PendingHookOwnershipError extends Error {}

/** 调用方已锁定当前 checkout；pending handoff 另行锁定其旧 checkout。 */
async function releaseReservedSessionOwnership(
  state: TranscriptWorktreeSession,
  sessionId: string,
  reservations?: WorktreeCreationReservation[],
): Promise<void> {
  const releasesCurrentOwner = state.lifecycle === 'owner';
  if (!releasesCurrentOwner && !state.pendingOwnerReleasePath) {
    return;
  }
  if (state.sessionId !== sessionId) {
    throw new Error('Persisted worktree state belongs to a different session.');
  }

  if (releasesCurrentOwner) {
    await assertRecordedWorktreePathIdentity(
      state.worktreePath,
      state.worktreeCwd,
    );
  }
  await releasePersistedWorktreeOwnerHandoff(state, sessionId, reservations);

  if (releasesCurrentOwner) {
    let originalCwd =
      state.pendingExit || state.hookBased ? state.originalCwd : undefined;
    if (!originalCwd) {
      try {
        await fs.stat(state.worktreePath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        // checkout 消失不代表 Git 私有目录中的 owner 已释放。
        originalCwd = state.originalCwd;
      }
    }
    const outcome = await releaseWorktreeOwnershipForHandoff(
      state.worktreePath,
      sessionId,
      originalCwd,
      state.hookBased === true,
    );
    if (outcome === 'missing-hook-checkout') {
      throw new PendingHookOwnershipError(
        `The Hook worktree at ${state.worktreePath} is missing and ownership cleanup could not be verified. Restore the checkout and its Git pointer before deleting this session or entering another worktree.`,
      );
    }
    if (outcome === 'owned-by-another-session' && !state.hookBased) {
      const currentOwner = await readWorktreeOwnerState(
        state.worktreePath,
        false,
      );
      // 同名会话已经接管；删除旧记录不能释放新 owner，也不必再结算旧权限。
      if (
        currentOwner?.ownerPid !== undefined &&
        currentOwner.ownerSessionId !== sessionId
      )
        return;
    }
    if (outcome !== 'released' && outcome !== 'already-released') {
      throw new Error(
        `Cannot release worktree ownership before deleting its transcript: ${outcome}.`,
      );
    }
  }
}

async function enter(
  context: WorktreeSessionContext,
  prepared: PreparedWorktree,
): Promise<WorktreeEnterResult> {
  assertEnterPersistence(context);
  if (prepared.preparedForSessionId !== context.sessionId) {
    throw new Error(
      'Cannot enter a worktree prepared for a different session.',
    );
  }

  let previousRuntime = captureRuntimeSnapshot(context.config);
  const { settings: preparedSettings } = prepared;
  const namedGitWorktree =
    !preparedSettings.hookBased && !preparedSettings.enteredExisting;
  let ownsLifecycle = false;
  let claimedForThisAttempt = false;
  let reclaimedForThisAttempt = false;
  let previousOwner: WorktreeOwnerState | null = null;
  let didPersistNextState = false;
  let didRestorePreviousPersistedState = false;
  let retainClaimEvidence = false;
  let runtimeTransitionAttempted = false;
  let canCleanupCreatedWorktree = prepared.created;
  const reservations = creationReservations.get(prepared) ?? [];
  creationReservations.set(prepared, reservations);

  try {
    for (const reservation of reservations) reservation.assertHeld();
    // 部分退出已清空运行态，但 JSONL 仍可能持有未结算的 owner；不能直接覆盖。
    const index = await context.config
      .getTranscriptStore()
      .repository()
      .loadIndex(context.config.getActiveSessionTranscriptPath(), {
        consistency: 'flush-pending',
        profile: { kind: 'metadata' },
      });
    const persistedState = index?.metadata.worktreeSessions.get(
      context.sessionId,
    );
    if (persistedState?.pendingExit) {
      await addWorktreeReservation(reservations, persistedState.worktreePath);
      const outcome = await restore(context, persistedState, reservations);
      if (outcome.status === 'failed') {
        throw new Error(outcome.message);
      }
      // 退出已完成，后续 Enter 失败只能回到该已提交的普通状态。
      previousRuntime = captureRuntimeSnapshot(context.config);
    }
    // 单个交接标记只能承载一笔债务；再次切换前先结算，失败则保留原会话。
    if (previousRuntime.worktreeSettings?.pendingOwnerReleasePath) {
      previousRuntime.worktreeSettings = await completePendingOwnerHandoff(
        context,
        previousRuntime.worktreeSettings,
        reservations,
      );
    }
    const previousOwnerPath = await resolvePreviousOwnerPathForSwitch(
      context,
      previousRuntime.worktreeSettings,
      preparedSettings,
    );

    if (prepared.created) {
      // 先持久化认领目标；恢复时仍以 owner metadata 校验实际删除权限。
      ownsLifecycle = true;
    } else if (namedGitWorktree) {
      const ownership = await getWorktreeEntryOwnership(
        preparedSettings.path,
        context.sessionId,
      );
      if (ownership === 'unavailable') {
        throw new Error(
          'Cannot verify worktree ownership; existing checkout left unchanged.',
        );
      }
      ownsLifecycle = ownership === 'claim';
    } else {
      const ownership = await inspectWorktreeOwnership(
        preparedSettings.path,
        context.sessionId,
        preparedSettings.hookBased === true,
      );
      if (
        ownership === 'owned-by-another-session' ||
        ownership === 'unavailable'
      ) {
        throw new Error(
          ownership === 'owned-by-another-session'
            ? `Cannot enter worktree: it is owned by another active ${BRAND_NAME} session.`
            : `Cannot verify worktree ownership; runtime state was left unchanged. Inspect ${path.join(preparedSettings.path, '.' + BRAND_WORKTREE_OWNER_FILE)} and the Git private owner metadata; see the diagnostic log for details.`,
        );
      }
      ownsLifecycle = ownership === 'owned-by-session';
      if (
        ownsLifecycle &&
        preparedSettings.hookBased &&
        (await claimWorktreeOwnership(
          preparedSettings.path,
          context.sessionId,
          preparedSettings.originalCwd,
        )) !== 'owned'
      ) {
        throw new Error(
          'Cannot protect legacy hook ownership metadata; runtime state was left unchanged.',
        );
      }
    }

    const settings: WorktreeSettings = {
      ...preparedSettings,
      lifecycle: ownsLifecycle ? 'owner' : 'attached',
      ...(ownsLifecycle ? { sessionId: context.sessionId } : {}),
    };
    const pendingSettings = previousOwnerPath
      ? { ...settings, pendingOwnerReleasePath: previousOwnerPath }
      : settings;
    const nextRuntime = buildRuntimeSnapshot(
      pendingSettings,
      pendingSettings.worktreeCwd,
      await removeWorktreeRuntimeDirectories(
        await removeOriginalWorkspaceDirectory(
          previousRuntime.workspaceDirectories,
          pendingSettings.originalCwd,
        ),
        previousRuntime.worktreeSettings,
      ),
    );
    runtimeTransitionAttempted = true;
    applyWorktreeRuntimeState(context.config, nextRuntime);
    await persistWorktreeState(
      context,
      toTranscriptWorktreeSession(pendingSettings, context.sessionId),
    );
    didPersistNextState = true;
    for (const reservation of reservations) reservation.assertHeld();
    if (prepared.created) {
      const ownerBeforeClaim = await readWorktreeOwnerState(
        preparedSettings.path,
        preparedSettings.hookBased === true,
      );
      // owner 一旦落盘，JSONL 已能定位它；认领前中断则由现有 restore 恢复为 attached。
      canCleanupCreatedWorktree = false;
      const ownership = await claimWorktreeOwnership(
        preparedSettings.path,
        context.sessionId,
        preparedSettings.hookBased ? preparedSettings.originalCwd : undefined,
        preparedSettings.hookBased
          ? undefined
          : getWorktreeOwnerClaimId(context.config),
      );
      retainClaimEvidence = ownership === 'cleanup-pending';
      if (ownership !== 'owned') {
        throw new Error(
          ownership === 'owned-by-another-session'
            ? `Cannot enter worktree: it is owned by another active ${BRAND_NAME} session.`
            : `Cannot verify worktree ownership; checkout retained at ${preparedSettings.path}. Inspect ${path.join(preparedSettings.path, '.' + BRAND_WORKTREE_OWNER_FILE)} and the Git private owner metadata; restore access or repair conflicting/malformed metadata before retrying.`,
        );
      }
      canCleanupCreatedWorktree = true;
      claimedForThisAttempt =
        ownerBeforeClaim?.ownerSessionId !== context.sessionId;
    } else if (namedGitWorktree && ownsLifecycle) {
      previousOwner = await readWorktreeOwnerState(
        preparedSettings.path,
        false,
      );
      if (
        (await claimReusableWorktreeOwnership(
          preparedSettings.path,
          context.sessionId,
          getWorktreeOwnerClaimId(context.config),
        )) !== 'owned'
      ) {
        throw new Error(
          'Cannot verify worktree ownership; existing checkout left unchanged.',
        );
      }
      reclaimedForThisAttempt = true;
    }
    commitFileHistoryRuntimeCwd(context.config, nextRuntime);

    if (!previousOwnerPath) {
      return settings;
    }

    return (
      await settlePendingOwnerHandoff(context, pendingSettings, reservations)
    ).settings;
  } catch (error) {
    const recoveryErrors: Error[] = [];
    const committedRuntime = captureRuntimeSnapshot(context.config);
    try {
      if (runtimeTransitionAttempted && !retainClaimEvidence) {
        applyWorktreeRuntimeState(context.config, previousRuntime);
        if (didPersistNextState) {
          await persistWorktreeState(
            context,
            previousRuntime.worktreeSettings
              ? toTranscriptWorktreeSession(
                  previousRuntime.worktreeSettings,
                  context.sessionId,
                )
              : null,
          );
          didRestorePreviousPersistedState = true;
        }
      }
    } catch (recoveryError) {
      recoveryErrors.push(toError(recoveryError));
    }

    if (didPersistNextState && !didRestorePreviousPersistedState) {
      // 回写失败或 owner 清理未确认时保留目标及其恢复依据，不能删除 checkout。
      let didRestoreCommittedRuntime = false;
      try {
        await runWithWorkspaceTransition(context.config, async () => {
          applyWorktreeRuntimeState(context.config, committedRuntime);
          commitFileHistoryRuntimeCwd(context.config, committedRuntime);
        });
        didRestoreCommittedRuntime = true;
      } catch (recoveryError) {
        recoveryErrors.push(toError(recoveryError));
      }
      const recoveryMessage = retainClaimEvidence
        ? 'Owner cleanup could not be confirmed; the persisted target was retained for recovery.'
        : 'Previous worktree state could not be restored.';
      const recoveryDetails =
        recoveryErrors.length > 0
          ? ` Recovery also failed: ${recoveryErrors.map((failure) => failure.message).join('; ')}`
          : '';
      const entryWarning =
        `${toError(error).message} ${recoveryMessage} ` +
        `Checkout retained at ${preparedSettings.path}.${recoveryDetails}`;
      const retainedSettings = committedRuntime.worktreeSettings;
      if (!retainedSettings || !didRestoreCommittedRuntime) {
        throw new Error(entryWarning);
      }
      runLogger.warn(`[WorktreeSession] ${entryWarning}`);
      return { ...retainedSettings, entryWarning };
    }

    try {
      if (reclaimedForThisAttempt) {
        await rollbackReusableWorktreeOwnership(
          preparedSettings.path,
          context.sessionId,
          previousOwner,
          getWorktreeOwnerClaimId(context.config),
        );
      }
      if (claimedForThisAttempt) {
        await releaseWorktreeOwnershipOrThrow(
          preparedSettings.path,
          context.sessionId,
          preparedSettings.hookBased === true,
        );
      }
    } catch (recoveryError) {
      if (reclaimedForThisAttempt) {
        // 回滚写入失败时保留目标运行态，Config 关闭后仍能释放本次占用。
        applyWorktreeRuntimeState(context.config, committedRuntime);
      }
      recoveryErrors.push(toError(recoveryError));
    }

    // 新状态已成功回滚后，同样可以安全补偿本次刚创建的资源。
    if (
      canCleanupCreatedWorktree &&
      reservations.every((reservation) => reservation.held) &&
      (!didPersistNextState || didRestorePreviousPersistedState)
    ) {
      try {
        await cleanupCreatedWorktreeForSession(
          {
            worktreePath: preparedSettings.path,
            hookBased: preparedSettings.hookBased,
          },
          preparedSettings.originalCwd!,
          context.removeHookAdapter,
        );
      } catch (recoveryError) {
        recoveryErrors.push(toError(recoveryError));
      }
    }

    if (prepared.created && reservations.some((reservation) => !reservation.held)) {
      recoveryErrors.push(new Error(`Checkout retained at ${preparedSettings.path} because its reservation was lost.`));
    }
    if (recoveryErrors.length > 0) {
      throw new Error(
        `${toError(error).message} Recovery also failed: ${recoveryErrors
          .map((recoveryError) => recoveryError.message)
          .join('; ')}`,
      );
    }
    throw error;
  }
}

async function restoreOriginalRuntime(
  context: WorktreeSessionContext,
  state: TranscriptWorktreeSession,
  previousRuntime: RuntimeSnapshot,
  reservations?: WorktreeCreationReservation[],
): Promise<WorktreeRestoreResult> {
  try {
    await resolveValidatedPendingOwnerReleasePath(
      state,
      undefined,
      reservations,
    );
  } catch (error) {
    return {
      status: 'failed',
      message: toError(error).message,
    };
  }
  try {
    const originalStat = await fs.stat(state.originalCwd);
    if (!originalStat.isDirectory()) {
      return {
        status: 'failed',
        message: 'Persisted original working directory is not a directory.',
      };
    }
    await fs.realpath(state.originalCwd);
  } catch (originalError) {
    return {
      status: 'failed',
      message: `Persisted worktree is unavailable and original working directory cannot be accessed: ${toError(originalError).message}`,
    };
  }

  const fallbackRuntime = buildRuntimeSnapshot(
    undefined,
    state.originalCwd,
    await removeWorktreeRuntimeDirectories(
      previousRuntime.workspaceDirectories,
      previousRuntime.worktreeSettings ?? { path: state.worktreePath },
    ),
  );
  let pendingCleanup: string | undefined;
  try {
    await releaseReservedSessionOwnership(
      state,
      context.sessionId,
      reservations,
    );
  } catch (error) {
    if (
      context.phase === 'restore' &&
      error instanceof PendingHookOwnershipError
    ) {
      pendingCleanup = `Returned to the original project and retained the session recovery record. ${error.message}`;
    } else {
      return {
        status: 'failed',
        message: toError(error).message,
      };
    }
  }
  try {
    if (!state.pendingExit || pendingCleanup) {
      // sidecar-only 会话可能一直留在旧 bucket。先保留已确认的项目归属，
      // 再写普通状态；中断后复用既有退出恢复流程，不重新进入 checkout。
      await persistWorktreeState(
        context,
        {
          ...state,
          sessionId: context.sessionId,
          pendingOwnerReleasePath: undefined,
          pendingExit: true,
        },
        pendingCleanup !== undefined,
      );
    }
    applyWorktreeRuntimeState(context.config, fallbackRuntime);
    // 无法确认外置 owner 时只恢复对话，不销毁用于后续结算的退出意图。
    if (!pendingCleanup) await persistWorktreeState(context, null, true);
    commitFileHistoryRuntimeCwd(context.config, fallbackRuntime);
    return {
      status: 'fallback',
      ...(pendingCleanup ? { pendingCleanup } : {}),
    };
  } catch (error) {
    applyWorktreeRuntimeState(context.config, previousRuntime);
    throw error;
  }
}

async function restore(
  context: WorktreeSessionContext,
  state: TranscriptWorktreeSession,
  reservations?: WorktreeCreationReservation[],
): Promise<WorktreeRestoreResult> {
  assertPersistence(context);
  if (!isValidTranscriptWorktreeState(state)) {
    return {
      status: 'failed',
      message: 'Persisted worktree state is incomplete.',
    };
  }
  if (
    (state.pendingOwnerReleasePath !== undefined || state.pendingExit) &&
    state.sessionId !== context.sessionId
  ) {
    return {
      status: 'failed',
      message: 'Pending worktree owner handoff belongs to a different session.',
    };
  }

  const previousRuntime = captureRuntimeSnapshot(context.config);
  let canonicalWorktreePath: string;
  try {
    const worktreeStat = await fs.stat(state.worktreePath);
    if (!worktreeStat.isDirectory()) {
      return {
        status: 'failed',
        message: 'Persisted worktree path is not a directory.',
      };
    }
    canonicalWorktreePath = await fs.realpath(state.worktreePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return {
        status: 'failed',
        message: `Persisted worktree path cannot be accessed: ${toError(error).message}`,
      };
    }
    return restoreOriginalRuntime(
      context,
      state,
      previousRuntime,
      reservations,
    );
  }

  // 退出恢复不再进入 checkout；通过原仓库结算 owner，允许 .git 已被部分清理。
  if (state.pendingExit) {
    return restoreOriginalRuntime(
      context,
      state,
      previousRuntime,
      reservations,
    );
  }

  if (
    !(await hasMatchingRepositoryIdentity(state, canonicalWorktreePath, true))
  ) {
    return {
      status: 'failed',
      message:
        'Persisted worktree path has missing or mismatched Git repository metadata.',
    };
  }

  let pendingOwnerReleasePath: string | undefined;
  try {
    pendingOwnerReleasePath = await resolveValidatedPendingOwnerReleasePath(
      state,
      canonicalWorktreePath,
      reservations,
    );
  } catch (error) {
    return {
      status: 'failed',
      message: toError(error).message,
    };
  }

  const resolved = await resolveRestoreWorktreeCwd(
    state,
    canonicalWorktreePath,
  );
  if (!resolved.worktreeCwd) {
    return {
      status: 'failed',
      message: resolved.error ?? 'Persisted worktree CWD is invalid.',
    };
  }

  let ownsLifecycle = false;
  if (state.lifecycle === 'owner' && state.sessionId === context.sessionId) {
    const ownership = await inspectWorktreeOwnership(
      canonicalWorktreePath,
      context.sessionId,
      state.hookBased === true,
    );
    if (
      ownership === 'unavailable' ||
      (ownership === 'owned-by-session' &&
        state.hookBased &&
        (await claimWorktreeOwnership(
          canonicalWorktreePath,
          context.sessionId,
          state.originalCwd,
        )) !== 'owned')
    ) {
      return {
        status: 'failed',
        message: `Cannot verify worktree ownership. Restore left the persisted state unchanged. Inspect ${path.join(canonicalWorktreePath, '.' + BRAND_WORKTREE_OWNER_FILE)} and the Git private owner metadata; see the diagnostic log for conflicting paths and repair malformed metadata manually.`,
      };
    }
    ownsLifecycle =
      ownership === 'owned-by-session' &&
      (state.hookBased ||
        (await getWorktreeEntryOwnership(
          canonicalWorktreePath,
          context.sessionId,
        )) === 'claim');
  }
  // 旧版本的 transcript 可能把重入时的 HEAD 存为起点；Git checkout 以独立记录为准。
  const originalHeadCommit = state.hookBased
    ? state.originalHeadCommit
    : await readWorktreeBaseCommit(canonicalWorktreePath);
  const settings: WorktreeSettings = {
    name: state.worktreeName,
    path: canonicalWorktreePath,
    worktreeCwd: resolved.worktreeCwd,
    baseSha: originalHeadCommit ?? '',
    lifecycle: ownsLifecycle ? 'owner' : 'attached',
    originalCwd: state.originalCwd,
    worktreeBranch: state.worktreeBranch,
    originalBranch: state.originalBranch,
    originalHeadCommit,
    ...(ownsLifecycle ? { sessionId: context.sessionId } : {}),
    hookBased: state.hookBased,
    enteredExisting: state.enteredExisting,
    ...(pendingOwnerReleasePath ? { pendingOwnerReleasePath } : {}),
  };
  const nextRuntime = buildRuntimeSnapshot(
    settings,
    settings.worktreeCwd,
    await removeWorktreeRuntimeDirectories(
      await removeOriginalWorkspaceDirectory(
        previousRuntime.workspaceDirectories,
        settings.originalCwd,
      ),
      previousRuntime.worktreeSettings,
    ),
  );

  let claimedOwner = false;
  let previousOwner: WorktreeOwnerState | null = null;
  try {
    applyWorktreeRuntimeState(context.config, nextRuntime);
    const settledSettings = await completePendingOwnerHandoff(
      context,
      settings,
      reservations,
    );
    if (!settings.pendingOwnerReleasePath) {
      await persistWorktreeState(
        context,
        toTranscriptWorktreeSession(settledSettings, context.sessionId),
      );
    }
    if (ownsLifecycle && !state.hookBased) {
      previousOwner = await readWorktreeOwnerState(
        canonicalWorktreePath,
        false,
      );
      if (
        (await claimReusableWorktreeOwnership(
          canonicalWorktreePath,
          context.sessionId,
          getWorktreeOwnerClaimId(context.config),
        )) !== 'owned'
      )
        throw new Error('Cannot restore worktree ownership.');
      claimedOwner = true;
    }
    commitFileHistoryRuntimeCwd(context.config, nextRuntime);
    return { status: 'restored', settings: settledSettings };
  } catch (error) {
    if (claimedOwner) {
      try {
        await rollbackReusableWorktreeOwnership(
          canonicalWorktreePath,
          context.sessionId,
          previousOwner,
          getWorktreeOwnerClaimId(context.config),
        );
      } catch (rollbackError) {
        // 保留已提交的运行态，关闭时仍能释放本次占用。
        throw new AggregateError(
          [error, rollbackError],
          'Worktree ownership rollback failed; target runtime retained for cleanup.',
        );
      }
    }
    applyWorktreeRuntimeState(context.config, previousRuntime);
    throw error;
  }
}

function getActiveWorktreeSettings(
  context: WorktreeSessionContext,
): WorktreeSettings {
  const settings = context.config.getWorktreeSettings();
  if (!settings?.originalCwd) {
    throw new Error('The current session is not in a worktree.');
  }
  return settings;
}

async function validateWorktreePaths(settings: WorktreeSettings): Promise<void> {
  const [canonicalPath, canonicalCwd] = await Promise.all([
    fs.realpath(settings.path),
    fs.realpath(settings.worktreeCwd),
  ]);
  const cwdStat = await fs.stat(canonicalCwd);
  if (!cwdStat.isDirectory() || !isInsidePath(canonicalPath, canonicalCwd)) {
    throw new Error('Worktree runtime path does not belong to the worktree root.');
  }
}

async function inspectWorktree(
  settings: WorktreeSettings,
  sessionId: string,
): Promise<WorktreeInspection> {
  let validPaths = true;
  try {
    await validateWorktreePaths(settings);
  } catch {
    validPaths = false;
  }
  const owner =
    validPaths &&
    settings.lifecycle === 'owner' &&
    settings.sessionId === sessionId &&
    (await isWorktreeOwnedBySession(
      settings.path,
      sessionId,
      settings.hookBased === true,
    ));
  const changes = validPaths
    ? await countWorktreeChanges(
        settings.path,
        settings.hookBased
          ? settings.baseSha
          : await readWorktreeBaseCommit(settings.path),
      )
    : null;
  return {
    changedFiles: changes?.changedFiles ?? null,
    commits: changes?.commits ?? null,
    owner,
  };
}

async function assertRemovableWorktree(
  context: WorktreeSessionContext,
  settings: WorktreeSettings,
  force: boolean,
): Promise<void> {
  await validateWorktreePaths(settings);
  if (
    settings.lifecycle !== 'owner' ||
    settings.sessionId !== context.sessionId ||
    !(await isWorktreeOwnedBySession(
      settings.path,
      context.sessionId,
      settings.hookBased === true,
    ))
  ) {
    throw new Error(
      'Only the current worktree owner can remove this checkout.',
    );
  }
  if (force) {
    return;
  }
  const changes = await countWorktreeChanges(
    settings.path,
    settings.hookBased
      ? settings.baseSha
      : await readWorktreeBaseCommit(settings.path),
  );
  if (changes === null) {
    throw new Error('Cannot verify worktree changes without explicit force.');
  }
  if (changes.changedFiles > 0 || changes.commits > 0) {
    throw new Error('Worktree contains changes and cannot be removed without force.');
  }
}

async function buildOriginalRuntime(
  settings: WorktreeSettings,
  previousRuntime: RuntimeSnapshot,
): Promise<RuntimeSnapshot> {
  return buildRuntimeSnapshot(
    undefined,
    settings.originalCwd!,
    await removeWorktreeRuntimeDirectories(
      previousRuntime.workspaceDirectories,
      settings,
    ),
  );
}

async function leave(
  context: WorktreeSessionContext,
  request: LeaveWorktreeRequest,
): Promise<LeaveWorktreeResult> {
  return withWorktreeReservation(getActiveWorktreeSettings(context).path,
    (reservation) => leaveReserved(context, request, reservation));
}

async function leaveReserved(
  context: WorktreeSessionContext,
  request: LeaveWorktreeRequest,
  reservation: WorktreeCreationReservation,
): Promise<LeaveWorktreeResult> {
  assertEnterPersistence(context);
  const activeSettings = getActiveWorktreeSettings(context);
  const settings = await completePendingOwnerHandoff(context, activeSettings);
  const previousRuntime = captureRuntimeSnapshot(context.config);
  const originalRuntime = await buildOriginalRuntime(
    settings,
    previousRuntime,
  );

  if (request.action === 'remove') {
    await assertRemovableWorktree(context, settings, request.force);
  }

  const releaseHookOwner =
    request.action === 'remove' && settings.hookBased
      ? await prepareHookWorktreeOwnershipRelease(
          settings.path,
          context.sessionId,
        )
      : undefined;
  const activeState = toTranscriptWorktreeSession(settings, context.sessionId);
  let didPersistExitIntent = false;
  let cleanupAttempted = false;
  let canRestorePreviousRuntime = true;
  try {
    await persistWorktreeState(context, {
      ...activeState,
      pendingExit: true,
    });
    didPersistExitIntent = true;
    reservation.assertHeld();
    applyWorktreeRuntimeState(
      context.config,
      originalRuntime,
    );
    if (request.action === 'keep') {
      if (settings.lifecycle === 'owner') {
        await releaseWorktreeOwnershipOrThrow(
          settings.path,
          context.sessionId,
          settings.hookBased === true,
        );
      }
    } else {
      cleanupAttempted = true;
      const cleanup = await cleanupWorktreeSession(
        {
          worktreeSettings: settings,
          currentSessionId: context.sessionId,
          force: request.force,
        },
        context.removeHookAdapter,
      );
      if (!cleanup.removed) {
        throw new Error(
          cleanup.message ?? `Worktree cleanup was refused: ${cleanup.reason}.`,
        );
      }
      // Hook 可以清理外部资源而保留目录；完成后仍须释放 CLI 的 owner 标记。
      // Hook 已确认完成，此后的 owner/JSONL 失败只能保留退出意图，不能回滚为活动 owner。
      canRestorePreviousRuntime = false;
      if (releaseHookOwner) {
        reservation.assertHeld();
        const outcome = await releaseHookOwner();
        if (outcome !== 'released' && outcome !== 'already-released') {
          throw new Error(
            `Cannot release Hook worktree ownership after removal: ${outcome}.`,
          );
        }
      }
    }
    canRestorePreviousRuntime = false;
    await persistWorktreeState(context, null);
    commitFileHistoryRuntimeCwd(context.config, originalRuntime);
    return {
      action: request.action,
      worktreePath: settings.path,
      originalCwd: settings.originalCwd!,
    };
  } catch (error) {
    let failure = toError(error);
    if (
      cleanupAttempted &&
      canRestorePreviousRuntime &&
      !settings.hookBased &&
      !(await hasMatchingRepositoryIdentity(activeState, settings.path, true))
    ) {
      // Git 删除可能已注销 checkout，却留下目录；不能回滚成活动 Worktree。
      canRestorePreviousRuntime = false;
      try {
        await releaseReservedSessionOwnership(
          {
            ...activeState,
            pendingExit: true,
          },
          context.sessionId,
        );
        await persistWorktreeState(context, null);
      } catch (settlementError) {
        failure = new AggregateError(
          [error, settlementError],
          `${failure.message} Exit confirmation failed: ${toError(settlementError).message}`,
        );
      }
    }
    // 已完成的副作用不能回滚为 owner；未完成的退出优先恢复旧运行态。
    if (canRestorePreviousRuntime) {
      try {
        // 回写失败仍保留退出意图供下次恢复重试。
        applyWorktreeRuntimeState(context.config, previousRuntime);
        if (didPersistExitIntent) {
          await persistWorktreeState(context, activeState);
        }
      } catch (recoveryError) {
        let checkoutMissing = false;
        try {
          await fs.stat(settings.path);
        } catch (statError) {
          checkoutMissing = isMissingPathError(statError);
        }
        if (!checkoutMissing) {
          throw new AggregateError(
            [error, recoveryError],
            `${toError(error).message} Worktree exit rollback also failed: ${toError(recoveryError).message}`,
          );
        }
        canRestorePreviousRuntime = false;
      }
      if (canRestorePreviousRuntime) throw error;
    }
    applyWorktreeRuntimeState(context.config, originalRuntime);
    commitFileHistoryRuntimeCwd(context.config, originalRuntime);
    // 确认失败时 JSONL 保留 pendingExit；Resume 幂等结算，不会再次删除目录。
    return {
      action: request.action,
      worktreePath: settings.path,
      originalCwd: settings.originalCwd!,
      cleanup: { status: 'partial', message: failure.message },
    };
  }
}

async function finalize(
  context: WorktreeSessionContext,
  request: FinalizeWorktreeRequest,
): Promise<FinalizeWorktreeResult> {
  assertEnterPersistence(context);
  const activeSettings = getActiveWorktreeSettings(context);
  if (request.action === 'inspect') {
    return {
      action: 'inspect',
      ...(await inspectWorktree(activeSettings, context.sessionId)),
    };
  }
  if (request.action === 'remove') {
    const result = await leave(context, request);
    return {
      action: 'remove',
      ...(result.cleanup ? { cleanup: result.cleanup } : {}),
    };
  }
  await completePendingOwnerHandoff(context, activeSettings);
  return { action: 'keep' };
}

async function prepare(
  context: WorktreePrepareContext,
  request: WorktreeRequest,
): Promise<PreparedWorktree> {
  const hookBased =
    request.kind === 'create' &&
    context.createHookAdapter?.hasWorktreeCreateHook();
  const checkoutRoot = await resolveCheckoutRoot(request, hookBased === true);
  if (request.kind === 'create') validateWorktreeSlug(request.name);
  const targetPath =
    request.kind === 'create'
      ? worktreePathFor(checkoutRoot, request.name)
      : path.resolve(
          context.activeWorktreeSettings?.worktreeCwd ?? request.originalCwd,
          request.path,
        );
  const reservations: WorktreeCreationReservation[] = [];
  await addWorktreeReservation(reservations, targetPath);
  try {
    let preparedRequest = request;
    if (request.kind === 'create' && !hookBased) {
      const ownership = await assertNamedWorktreeReusable(
        context.sessionId,
        request,
        targetPath,
      );
      if (ownership === 'attached') {
        // 附着期间使用原 checkout；不能按新会话的配置修改其他会话的 sparse cone。
        preparedRequest = {
          ...request,
          options: { ...request.options, sparsePaths: [] },
        };
      }
    }
    const prepared = await prepareReservedWorktree(
      context,
      preparedRequest,
      checkoutRoot,
      reservations,
    );
    for (const reservation of reservations) reservation.assertHeld();
    creationReservations.set(prepared, reservations);
    return prepared;
  } catch (error) {
    await Promise.all(reservations.map((reservation) => reservation.release()));
    throw error;
  }
}

/** 在预占锁内验证已有 checkout，避免拒绝进入前 sparse-checkout 已修改其他会话的文件。 */
async function assertNamedWorktreeReusable(
  sessionId: string,
  request: Pick<WorktreeRequest, 'originalCwd'>,
  targetPath: string,
): Promise<'claim' | 'attached'> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) return 'claim';
    throw error;
  }
  // Git 允许在预先创建的空目录中创建 Worktree，保留该行为。
  if ((await fs.readdir(canonicalPath)).length === 0) return 'claim';
  if (!(await hasMatchingRepositoryIdentity(request, canonicalPath))) {
    throw new Error(
      'Cannot reuse worktree: path is not a linked worktree of the original Git repository.',
    );
  }
  const ownership = await getWorktreeEntryOwnership(canonicalPath, sessionId);
  if (ownership === 'unavailable') {
    throw new Error(
      'Cannot verify worktree ownership; existing checkout left unchanged.',
    );
  }
  return ownership;
}

async function prepareReservedWorktree(
  context: WorktreePrepareContext,
  request: WorktreeRequest,
  checkoutRoot: string,
  reservations: WorktreeCreationReservation[],
): Promise<PreparedWorktree> {
  const session =
    request.kind === 'create'
      ? await createWorktreeForSession(
          request.name,
          checkoutRoot,
          context.createHookAdapter,
          request.options,
          request.originalCwd,
        )
      : await resolveExistingWorktreeForSession(
          context.sessionId,
          request.path,
          request.launchRoot,
          context.activeWorktreeSettings,
          request.originalCwd,
        );
  if (session.hookBased) {
    // Hook 的实际路径只有执行后才知道；不同名称也不能共同拥有同一目录。
    // 获取锁或校验 owner 失败时绝不能调用 remove hook，返回的可能是其他会话的目录。
    await addWorktreeReservation(reservations, session.worktreePath);
    const ownership = await inspectWorktreeOwnership(
      session.worktreePath,
      context.sessionId,
      true,
    );
    if (ownership === 'owned-by-another-session' || ownership === 'unavailable') {
      throw new Error(ownership === 'owned-by-another-session'
        ? `Cannot enter worktree: it is owned by another active ${BRAND_NAME} session.`
        : `Cannot verify worktree ownership; checkout retained at ${session.worktreePath}.`);
    }
    if (ownership === 'owned-by-session') session.created = false;
  }
  let worktreeCwd: string;
  try {
    // 持久化已验证的 checkout 根，而非 Hook 别名；项目子目录仍由 worktreeCwd 单独表达。
    session.worktreePath = await fs.realpath(session.worktreePath);
    const sourceLayout = await resolveGitRepositoryLayout(request.originalCwd);
    const enteringNestedRepository =
      request.kind === 'attach' &&
      (await findProjectRootForWorktree(session.worktreePath)) !==
        (sourceLayout ? path.dirname(sourceLayout.commonDir) : undefined);
    worktreeCwd = await resolveWorktreeCwd(
      // 创建位置属于仓库，子目录映射则必须相对于启动所在的 checkout。
      // 嵌套仓库没有外层仓库的相对项目目录，首次进入其 checkout 根即可。
      // 非 Git Hook 没有仓库相对目录，不能用之前的运行根推导项目位置。
      await fs.realpath(
        enteringNestedRepository
          ? request.originalCwd
          : (sourceLayout?.worktreeRoot ??
            (session.hookBased ? request.originalCwd : checkoutRoot)),
      ),
      request.originalCwd,
      session.worktreePath,
    );
  } catch (error) {
    if (session.created && reservations.every((reservation) => reservation.held)) {
      try {
        await cleanupCreatedWorktreeForSession(
          session,
          checkoutRoot,
          context.removeHookAdapter,
        );
      } catch (cleanupError) {
        throw new Error(
          `${toError(error).message} Cleanup of newly created worktree also failed at ${session.worktreePath}: ${toError(cleanupError).message}`,
        );
      }
    }
    throw error;
  }

  return {
    settings: toWorktreeSettings(session, request.originalCwd, worktreeCwd),
    created: session.created,
    preparedForSessionId: context.sessionId,
  };
}

export const worktreeSessionService: WorktreeSessionService = {
  prepare,
  enter: (context, prepared) =>
    runWithShellSession(context.config, async () => {
      try {
        return await runWithWorkspaceTransition(context.config, () =>
          enter(context, prepared),
        );
      } finally {
        await Promise.all(
          (creationReservations.get(prepared) ?? []).map((reservation) =>
            reservation.release(),
          ),
        );
        creationReservations.delete(prepared);
      }
    }),
  restore: (context, state) =>
    runWithShellSession(context.config, () =>
      runWithWorkspaceTransition(context.config, () =>
        isValidTranscriptWorktreeState(state)
          ? withWorktreeReservation(state.worktreePath, () => restore(context, state))
          : restore(context, state)),
    ),
  leave: (context, request) =>
    runWithShellSession(context.config, () =>
      runWithWorkspaceTransition(context.config, () => leave(context, request)),
    ),
  finalize: (context, request) =>
    runWithShellSession(context.config, () =>
      runWithWorkspaceTransition(context.config, () => finalize(context, request)),
    ),
};
