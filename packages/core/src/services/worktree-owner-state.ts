/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_WORKTREE_OWNER_FILE } from '../config/brand.js';

/**
 * Git Worktree 的 owner 保存在经校验的私有 Git 目录；非 Git Hook 目录使用
 * 根目录下的隐藏标记。两者共用独占写入与会话身份校验，不从 cwd 推断权限。
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { isMissingPathError } from '../utils/errors.js';
import { canonicalizeWorktreePath } from './worktree/pathIdentity.js';

const WORKTREE_OWNER_FILE = BRAND_WORKTREE_OWNER_FILE;
const ownerClaimIds = new WeakMap<object, string>();

/** 配置对象的本次占用身份；不进入 Config 公共接口或会话记录。 */
export function getWorktreeOwnerClaimId(config: object): string {
  let claimId = ownerClaimIds.get(config);
  if (!claimId) {
    claimId = randomUUID();
    ownerClaimIds.set(config, claimId);
  }
  return claimId;
}

export interface WorktreeOwnerState {
  version: 1;
  ownerSessionId: string;
  /** 0 表示会话已关闭；缺失表示旧格式，不能据此接管其他会话。 */
  ownerPid?: number;
  ownerClaimId?: string;
  /** Hook 可返回非 Git 或外部仓库；交接时用创建来源校验身份。 */
  originalCwd?: string;
}

export type WorktreeOwnershipClaimResult =
  | 'owned'
  | 'owned-by-another-session'
  | 'unavailable'
  /** 本次独占创建的 metadata 未能清理，调用方必须保留 JSONL 恢复依据。 */
  | 'cleanup-pending';

export type WorktreeHandoffReleaseResult =
  | 'released'
  | 'already-released'
  | 'missing-hook-checkout'
  | 'owned-by-another-session'
  | 'unavailable';

/** 交接前对旧 Worktree owner 的可验证性检查结果。 */
export type WorktreeOwnershipInspection =
  | 'owned-by-session'
  | 'owned-by-another-session'
  | 'not-owned'
  | 'unavailable';

function parseOwnerState(value: unknown): WorktreeOwnerState | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('ownerSessionId' in value) ||
    typeof value.ownerSessionId !== 'string' ||
    value.ownerSessionId.length === 0
  ) {
    return null;
  }
  if (
    'ownerPid' in value &&
    (!Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) < 0)
  )
    return null;
  if (
    'ownerClaimId' in value &&
    (typeof value.ownerClaimId !== 'string' ||
      !value.ownerClaimId ||
      !('ownerPid' in value))
  )
    return null;

  return {
    version: 1,
    ownerSessionId: value.ownerSessionId,
    ...('ownerPid' in value ? { ownerPid: value.ownerPid as number } : {}),
    ...('ownerClaimId' in value
      ? { ownerClaimId: value.ownerClaimId as string }
      : {}),
    ...('originalCwd' in value &&
    typeof value.originalCwd === 'string' &&
    path.isAbsolute(value.originalCwd)
      ? { originalCwd: value.originalCwd }
      : {}),
  };
}

/** 仅不存在可按缺失处理，访问错误不能切换 owner 的存储位置。 */
async function hasOwnerControlPath(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** 只标识本次独占写入留下且未能清理的文件，不用于接管历史残缺 metadata。 */
class IncompleteOwnerMetadataError extends AggregateError {}

/** checkout 和原仓库注册都已消失，无法排除仍存在外置 Git owner。 */
class MissingHookCheckoutError extends Error {}

async function writeOwnerMetadataExclusive(
  statePath: string,
  contents: string | Buffer,
): Promise<void> {
  // wx 在 try 外：未取得独占创建权时，绝不能删除已存在的文件。
  const handle = await fs.open(statePath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    try {
      await fs.unlink(statePath);
    } catch (cleanupError) {
      if (!isMissingPathError(cleanupError)) {
        throw new IncompleteOwnerMetadataError(
          [error, cleanupError],
          `Incomplete worktree ownership metadata retained at ${statePath}. Restore access and verify ownership before repairing the file.`,
        );
      }
    }
    throw error;
  }
}

async function syncOwnerDirectory(directory: string): Promise<void> {
  // Windows 不支持通过 Node 的目录句柄提供同等保证；不承诺跨平台断电事务。
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // 部分挂载不支持目录 fsync；真实 I/O 或权限错误仍须保留源标记并阻断迁移。
    if (
      !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error;
    runLogger.warn(
      `Directory sync is unsupported at ${directory}; worktree ownership migration does not guarantee power-loss durability.`,
    );
  }
}

async function resolveWorktreeOwnerStatePath(
  worktreePath: string,
  allowHookDirectory = true,
  mutationSessionId?: string,
  originalCwd?: string,
): Promise<string | null> {
  const canonicalPath = await canonicalizeWorktreePath(worktreePath);
  const hookOwnerPath = path.join(canonicalPath, `.${WORKTREE_OWNER_FILE}`);
  // 只检查当前根的 Git 标记；子目录不能借用父 checkout 的 owner。
  if (await hasOwnerControlPath(path.join(canonicalPath, '.git'))) {
    const layout = await resolveGitRepositoryLayout(canonicalPath);
    if (!layout || layout.worktreeRoot !== canonicalPath) {
      throw new Error('Cannot verify Git identity for worktree ownership.');
    }
    if (layout.isWorktree || allowHookDirectory) {
      const gitOwnerPath = path.join(layout.gitDir, WORKTREE_OWNER_FILE);
      if (await hasOwnerControlPath(hookOwnerPath)) {
        if (!layout.isWorktree) {
          const legacyStat = await fs.lstat(hookOwnerPath);
          const hasPrivateOwner = await hasOwnerControlPath(gitOwnerPath);
          const privateStat = hasPrivateOwner
            ? await fs.lstat(gitOwnerPath)
            : undefined;
          const legacyContents = legacyStat.isFile()
            ? await fs.readFile(hookOwnerPath)
            : undefined;
          // 不依赖 inode（某些文件系统恒为 0）；仅内容完全一致的两份有效证据可收敛。
          if (
            !legacyContents ||
            (privateStat &&
              (!privateStat.isFile() ||
                !legacyContents.equals(await fs.readFile(gitOwnerPath))))
          ) {
            throw new Error(
              `Conflicting Git and hook worktree ownership metadata: ${hookOwnerPath} and ${gitOwnerPath}. Both files were preserved. Verify their ownership and repair the conflicting or incomplete metadata before retrying.`,
            );
          }
          if (mutationSessionId) {
            const owner = parseOwnerState(
              JSON.parse(legacyContents.toString('utf8')),
            );
            if (!owner)
              throw new Error(
                `Invalid legacy hook ownership metadata: ${hookOwnerPath}.`,
              );
            if (owner.ownerSessionId === mutationSessionId) {
              // 独占建立私有位置后才删除旧标记；无法证明归属的历史残片仍保守保留。
              try {
                let fileSynced = false;
                if (!hasPrivateOwner) {
                  try {
                    await fs.link(hookOwnerPath, gitOwnerPath);
                  } catch (error) {
                    if (
                      ![
                        'EXDEV',
                        'EPERM',
                        'ENOTSUP',
                        'EOPNOTSUPP',
                        'ENOSYS',
                      ].includes((error as NodeJS.ErrnoException).code ?? '')
                    )
                      throw error;
                    // 小型 owner 文档使用已验证的字节独占写入；可捕获的失败只补偿本次创建的文件。
                    await writeOwnerMetadataExclusive(
                      gitOwnerPath,
                      legacyContents,
                    );
                    fileSynced = true;
                  }
                }
                if (!legacyContents.equals(await fs.readFile(gitOwnerPath))) {
                  throw new Error(
                    `Worktree owner changed during migration: ${hookOwnerPath} and ${gitOwnerPath}.`,
                  );
                }
                if (!fileSynced) {
                  // FlushFileBuffers 要求写权限；r+ 不截断文件。独占复制已同步，无需再次打开。
                  const handle = await fs.open(gitOwnerPath, 'r+');
                  try {
                    await handle.sync();
                  } finally {
                    await handle.close();
                  }
                }
                await syncOwnerDirectory(layout.gitDir);
                await fs.unlink(hookOwnerPath);
                return gitOwnerPath;
              } catch (error) {
                throw new Error(
                  `Worktree ownership migration from ${hookOwnerPath} to ${gitOwnerPath} is incomplete. Inspect both metadata paths. Check permissions and file locks, then retry; if the files conflict, verify ownership before manual repair.`,
                  { cause: error },
                );
              }
            }
          }
          return hookOwnerPath;
        }
        throw new Error(
          `Conflicting Git and hook worktree ownership metadata: ${hookOwnerPath} and ${gitOwnerPath}. Remove the stale checkout marker only after verifying ownership.`,
        );
      }
      return gitOwnerPath;
    }
  }
  if (!allowHookDirectory) return null;
  if (originalCwd) {
    // 交接状态没有旧 checkout 的 Hook 类型，不能把损坏的 Git 指针误判成已释放的 Hook。
    const registeredPath = await resolveRegisteredOwnerFallback(
      originalCwd,
      canonicalPath,
    );
    if (registeredPath) return registeredPath;
    if (!(await hasOwnerControlPath(canonicalPath))) {
      // Hook clone 的私有 Git 目录可能独立存在；checkout 消失不能证明 owner 已删除。
      throw new MissingHookCheckoutError(
        `Cannot verify Hook worktree ownership at ${worktreePath}. Restore the checkout and its Git pointer before retrying; ownership recovery state was preserved.`,
      );
    }
  }
  return hookOwnerPath;
}

export async function readWorktreeOwnerState(
  worktreePath: string,
  allowHookDirectory = true,
): Promise<WorktreeOwnerState | null> {
  try {
    const statePath = await resolveWorktreeOwnerStatePath(
      worktreePath,
      allowHookDirectory,
    );
    if (!statePath) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return parseOwnerState(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      runLogger.debug(
        `Failed to read worktree owner metadata at ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/** Agent 复用与清理只接受同仓库的有效 Git Worktree，且不能存在任何 owner 证据。 */
export async function isUnownedGitWorktree(
  worktreePath: string,
  repositoryRoot: string,
): Promise<boolean> {
  try {
    const [source, target] = await Promise.all([
      resolveGitRepositoryLayout(repositoryRoot),
      resolveGitRepositoryLayout(worktreePath),
    ]);
    if (!source || !target || source.commonDir !== target.commonDir) {
      return false;
    }
    const statePath = await resolveWorktreeOwnerStatePath(worktreePath, false);
    return statePath !== null && !(await hasOwnerControlPath(statePath));
  } catch {
    // 残缺标记、路径损坏或访问失败都不能当作可删除。
    return false;
  }
}

/**
 * Atomically claims a newly-created worktree for a session.
 *
 * Existing metadata is never overwritten. A concurrent or earlier owner wins,
 * and the caller must attach without cleanup authority.
 */
export async function claimWorktreeOwnership(
  worktreePath: string,
  ownerSessionId: string,
  hookOriginalCwd?: string,
  ownerClaimId?: string,
): Promise<WorktreeOwnershipClaimResult> {
  if (!ownerSessionId) return 'unavailable';

  let statePath: string | null;
  let state: WorktreeOwnerState;
  try {
    state = {
      version: 1,
      ownerSessionId,
      ...(!hookOriginalCwd ? { ownerPid: process.pid } : {}),
      ...(!hookOriginalCwd && ownerClaimId ? { ownerClaimId } : {}),
      ...(hookOriginalCwd
        ? { originalCwd: await fs.realpath(hookOriginalCwd) }
        : {}),
    };
    statePath = await resolveWorktreeOwnerStatePath(
      worktreePath,
      hookOriginalCwd !== undefined,
      ownerSessionId,
    );
  } catch (error) {
    runLogger.warn(
      `Cannot resolve worktree owner metadata at ${worktreePath}.`,
      error,
    );
    return 'unavailable';
  }
  if (!statePath) return 'unavailable';

  try {
    await writeOwnerMetadataExclusive(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
    return 'owned';
  } catch (error) {
    if (error instanceof IncompleteOwnerMetadataError) {
      runLogger.warn(error.message, error);
      return 'cleanup-pending';
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
      runLogger.debug(
        `Failed to write worktree owner metadata at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'unavailable';
    }
  }

  const existing = await readWorktreeOwnerState(
    worktreePath,
    hookOriginalCwd !== undefined,
  );
  if (!existing) return 'unavailable';
  return existing.ownerSessionId === ownerSessionId
    ? 'owned'
    : 'owned-by-another-session';
}

export async function isWorktreeOwnedBySession(
  worktreePath: string,
  sessionId: string,
  allowHookDirectory = true,
): Promise<boolean> {
  if (!sessionId) return false;
  const state = await readWorktreeOwnerState(worktreePath, allowHookDirectory);
  return state?.ownerSessionId === sessionId;
}

/** 调用方持有路径预占锁；删除权限与其他会话的目录使用权分别判断。 */
export async function getWorktreeEntryOwnership(
  worktreePath: string,
  sessionId: string,
): Promise<'claim' | 'attached' | 'unavailable'> {
  const ownership = await inspectWorktreeOwnership(
    worktreePath,
    sessionId,
    false,
  );
  if (ownership === 'unavailable') return 'unavailable';
  if (ownership === 'not-owned') return 'claim';
  const state = await readWorktreeOwnerState(worktreePath, false);
  if (!state) return 'unavailable';
  if (state.ownerPid === undefined) {
    // 旧记录仍允许使用；只有原会话 Resume 才能恢复其删除权限。
    return state.ownerSessionId === sessionId ? 'claim' : 'attached';
  }
  if (state.ownerPid === 0) return 'claim';
  if (state.ownerPid === process.pid && state.ownerSessionId === sessionId)
    return 'claim';
  try {
    process.kill(state.ownerPid, 0);
    return 'attached';
  } catch (error) {
    // 权限错误或未知错误不能证明原进程已经退出。PID 被其他进程复用时保守附着。
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'claim'
      : 'attached';
  }
}

async function replaceOwnerState(
  statePath: string,
  state: WorktreeOwnerState,
): Promise<void> {
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  await writeOwnerMetadataExclusive(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
  );
  try {
    await fs.rename(temporaryPath, statePath);
  } catch (error) {
    // rename 成功即提交；只在失败时清理仍属于本次写入的临时文件。
    await fs.unlink(temporaryPath).catch((cleanupError: unknown) => {
      if (!isMissingPathError(cleanupError))
        runLogger.warn(
          'Failed to remove temporary worktree ownership metadata.',
          cleanupError,
        );
    });
    throw error;
  }
}

/** 目标状态已持久化后再接管；调用方持有路径预占锁。 */
export async function claimReusableWorktreeOwnership(
  worktreePath: string,
  sessionId: string,
  ownerClaimId: string,
): Promise<WorktreeOwnershipClaimResult> {
  const ownership = await getWorktreeEntryOwnership(worktreePath, sessionId);
  if (ownership === 'attached') return 'owned-by-another-session';
  if (ownership !== 'claim') return 'unavailable';
  const previous = await readWorktreeOwnerState(worktreePath, false);
  if (!previous)
    return claimWorktreeOwnership(
      worktreePath,
      sessionId,
      undefined,
      ownerClaimId,
    );
  const statePath = await resolveWorktreeOwnerStatePath(worktreePath, false);
  if (!statePath) return 'unavailable';
  await replaceOwnerState(statePath, {
    ...previous,
    ownerSessionId: sessionId,
    ownerPid: process.pid,
    ownerClaimId,
  });
  return 'owned';
}

/** 进入失败时恢复原权限；只能补偿当前进程刚写入的记录。 */
export async function rollbackReusableWorktreeOwnership(
  worktreePath: string,
  sessionId: string,
  previous: WorktreeOwnerState | null,
  ownerClaimId: string,
): Promise<void> {
  const statePath = await resolveWorktreeOwnerStatePath(worktreePath, false);
  const current = await readWorktreeOwnerState(worktreePath, false);
  if (
    !statePath ||
    current?.ownerSessionId !== sessionId ||
    current.ownerPid !== process.pid ||
    current.ownerClaimId !== ownerClaimId
  ) {
    throw new Error('Cannot verify worktree ownership during entry rollback.');
  }
  if (previous) await replaceOwnerState(statePath, previous);
  else await fs.unlink(statePath);
}

/** 会话关闭时保留可恢复的所有权，但不再把该会话视为运行中。 */
export async function deactivateWorktreeOwnership(
  worktreePath: string,
  sessionId: string,
  ownerClaimId: string,
): Promise<void> {
  const statePath = await resolveWorktreeOwnerStatePath(worktreePath, false);
  const current = await readWorktreeOwnerState(worktreePath, false);
  if (
    !statePath ||
    current?.ownerSessionId !== sessionId ||
    current.ownerPid !== process.pid ||
    current.ownerClaimId !== ownerClaimId
  )
    return;
  await replaceOwnerState(statePath, { ...current, ownerPid: 0 });
}

/**
 * 严格检查某个 Worktree 是否仍由当前会话拥有。
 *
 * 普通 boolean 查询会将无法读取 metadata 的情况压缩为 false，不适合决定
 * 是否可以丢弃 owner 交接标记。交接流程必须保留不可验证状态以便恢复重试。
 */
export async function inspectWorktreeOwnership(
  worktreePath: string,
  sessionId: string,
  allowHookDirectory = true,
  originalCwd?: string,
): Promise<WorktreeOwnershipInspection> {
  if (!sessionId) return 'unavailable';

  let checkoutMissing = false;
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) return 'unavailable';
  } catch (error) {
    if (!isMissingPathError(error)) return 'unavailable';
    if (!originalCwd) return 'not-owned';
    checkoutMissing = true;
  }

  let statePath: string | null;
  try {
    // checkout 被手工删除后，私有 Git 注册仍可能持有 owner，不能据此跳过交接。
    statePath =
      checkoutMissing && originalCwd && !allowHookDirectory
        ? await resolveRegisteredWorktreeOwnerStatePath(
            originalCwd,
            worktreePath,
          )
        : await resolveWorktreeOwnerStatePath(
            worktreePath,
            allowHookDirectory,
            undefined,
            originalCwd,
          );
  } catch (error) {
    runLogger.warn(
      `Cannot inspect worktree owner metadata at ${worktreePath}.`,
      error,
    );
    return 'unavailable';
  }
  if (!statePath) return checkoutMissing ? 'not-owned' : 'unavailable';

  let state: WorktreeOwnerState | null;
  try {
    state = parseOwnerState(JSON.parse(await fs.readFile(statePath, 'utf8')));
  } catch (error) {
    return isMissingPathError(error) ? 'not-owned' : 'unavailable';
  }
  if (!state) return 'unavailable';
  return state.ownerSessionId === sessionId
    ? 'owned-by-session'
    : 'owned-by-another-session';
}

/**
 * Release lifecycle authority without touching the worktree itself.
 *
 * This is used when an owning session explicitly switches into another
 * existing worktree. The compare-before-delete check prevents one session
 * from clearing another session's ownership metadata.
 */
export async function releaseWorktreeOwnership(
  worktreePath: string,
  sessionId: string,
  allowHookDirectory = true,
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const statePath = await resolveWorktreeOwnerStatePath(
      worktreePath,
      allowHookDirectory,
      sessionId,
    );
    if (!statePath) return false;
    const state = await readWorktreeOwnerState(
      worktreePath,
      allowHookDirectory,
    );
    if (state?.ownerSessionId !== sessionId) return false;
    await fs.unlink(statePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      runLogger.warn(
        `Failed to release worktree owner metadata at ${worktreePath}.`,
        error,
      );
    }
    return false;
  }
}

/**
 * 以可恢复的交接语义释放旧 Worktree owner。
 *
 * 与普通 leave 不同，交接时 owner 文件已被删除表示此前步骤已完成；其他
 * 无法验证的情况必须保守保留交接标记，等待后续恢复重试。
 */
export async function releaseWorktreeOwnershipForHandoff(
  worktreePath: string,
  sessionId: string,
  /** 提供原项目以识别遗留 Git 注册；非 Hook 退出恢复只使用此注册表。 */
  originalCwd?: string,
  allowHookDirectory = true,
): Promise<WorktreeHandoffReleaseResult> {
  if (!sessionId) return 'unavailable';

  if (!originalCwd) {
    try {
      const stat = await fs.stat(worktreePath);
      if (!stat.isDirectory()) return 'unavailable';
    } catch (error) {
      return isMissingPathError(error) ? 'already-released' : 'unavailable';
    }
  }

  let statePath: string | null;
  try {
    statePath =
      originalCwd && !allowHookDirectory
        ? await resolveRegisteredWorktreeOwnerStatePath(
            originalCwd,
            worktreePath,
          )
        : await resolveWorktreeOwnerStatePath(
            worktreePath,
            allowHookDirectory,
            sessionId,
            originalCwd,
          );
  } catch (error) {
    if (error instanceof MissingHookCheckoutError)
      return 'missing-hook-checkout';
    if (!isMissingPathError(error)) {
      runLogger.warn(
        `Cannot resolve pending worktree ownership at ${worktreePath}.`,
        error,
      );
    }
    return !originalCwd && isMissingPathError(error)
      ? 'already-released'
      : 'unavailable';
  }
  if (!statePath)
    return originalCwd && !allowHookDirectory
      ? 'already-released'
      : 'unavailable';

  return releaseOwnerStateFile(statePath, sessionId);
}

/**
 * 在同一 checkout 预占锁内，先定位 owner，再执行 Hook，最后按原位置核对并释放。
 * 仅用于本次已确认的删除，不持久化路径，也不能用于推断重启后的历史 owner 位置。
 */
export async function prepareHookWorktreeOwnershipRelease(
  worktreePath: string,
  sessionId: string,
): Promise<() => Promise<WorktreeHandoffReleaseResult>> {
  const statePath = await resolveWorktreeOwnerStatePath(
    worktreePath,
    true,
    sessionId,
  );
  if (!sessionId || !statePath) {
    throw new Error(`Cannot verify Hook worktree ownership at ${worktreePath}.`);
  }
  return () => releaseOwnerStateFile(statePath, sessionId);
}

async function releaseOwnerStateFile(
  statePath: string,
  sessionId: string,
): Promise<WorktreeHandoffReleaseResult> {
  let state: WorktreeOwnerState | null;
  try {
    state = parseOwnerState(JSON.parse(await fs.readFile(statePath, 'utf8')));
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? 'already-released'
      : 'unavailable';
  }
  if (!state) return 'unavailable';
  if (state.ownerSessionId !== sessionId) {
    return 'owned-by-another-session';
  }

  try {
    await fs.unlink(statePath);
    return 'released';
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? 'already-released'
      : 'unavailable';
  }
}

/** 缺失的 checkout 指针可用原仓库注册证明；不能覆盖仍存在的另一套 Git 身份。 */
export async function hasRegisteredWorktree(
  originalCwd: string,
  worktreePath: string,
): Promise<boolean> {
  return (
    (await resolveRegisteredOwnerFallback(originalCwd, worktreePath)) !== null
  );
}

/** 共享注册回退的前置条件；释放时仍在锁内重新定位、读取并核对 owner。 */
async function resolveRegisteredOwnerFallback(
  originalCwd: string,
  worktreePath: string,
): Promise<string | null> {
  if (
    (await hasOwnerControlPath(path.join(worktreePath, '.git'))) ||
    (await hasOwnerControlPath(
      path.join(worktreePath, `.${WORKTREE_OWNER_FILE}`),
    ))
  )
    return null;
  return resolveRegisteredWorktreeOwnerStatePath(
    originalCwd,
    worktreePath,
    true,
  );
}

/** 退出中断后 .git 指针可能已消失；只从原仓库的注册记录定位旧 owner。 */
async function resolveRegisteredWorktreeOwnerStatePath(
  originalCwd: string,
  worktreePath: string,
  allowNonGitSource = false,
): Promise<string | null> {
  const layout = await resolveGitRepositoryLayout(originalCwd);
  if (!layout) {
    if (allowNonGitSource) {
      let directory = await fs.realpath(originalCwd);
      // 无 Git 的 Hook 来源可以没有注册表；存在 Git 标记却无法解析时必须保守失败。
      while (!(await hasOwnerControlPath(path.join(directory, '.git')))) {
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
      }
    }
    throw new Error('Cannot resolve the original Git repository.');
  }
  const canonicalize = async (directory: string) =>
    (await canonicalizeWorktreePath(directory)).normalize('NFC');
  const target = await canonicalize(worktreePath);
  const registrationsDir = path.join(layout.commonDir, 'worktrees');
  const entries = await fs
    .readdir(registrationsDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    });
  let ownerPath: string | null = null;
  let incompleteRegistration: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gitDir = path.join(registrationsDir, entry.name);
    const backlinkPath = path.join(gitDir, 'gitdir');
    let backlink: string;
    try {
      backlink = await fs.readFile(backlinkPath, 'utf8');
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      incompleteRegistration ??= backlinkPath;
      continue;
    }
    const marker = path.resolve(gitDir, backlink.trim());
    if (!backlink.trim() || path.basename(marker) !== '.git') {
      incompleteRegistration ??= backlinkPath;
      continue;
    }
    if ((await canonicalize(path.dirname(marker))) !== target) continue;
    if (ownerPath) throw new Error('Ambiguous worktree registrations.');
    ownerPath = path.join(gitDir, WORKTREE_OWNER_FILE);
  }
  // 已找到唯一匹配时，无关的损坏注册不阻断它；没有匹配时不能据此声称已释放。
  if (!ownerPath && incompleteRegistration) {
    throw new Error(
      `Cannot verify worktree registration for ${worktreePath}: incomplete record at ${incompleteRegistration}.`,
    );
  }
  return ownerPath;
}
