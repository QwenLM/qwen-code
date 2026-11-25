/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_WORKTREE_LOCK_DIR_NAME } from '../../config/brand.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { lock } from 'proper-lockfile';
import {
  isFileAccessDeniedError,
  isNodeError,
} from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import { canonicalizeWorktreePath } from './pathIdentity.js';

export interface WorktreeCreationReservation {
  readonly target: string;
  readonly held: boolean;
  assertHeld(): void;
  release(): Promise<void>;
}

/** 覆盖创建、进入、退出和 owner 结算窗口；不是 checkout 使用租约。 */
async function reserveWorktreePath(
  targetPath: string,
  canonicalPath: string,
): Promise<WorktreeCreationReservation> {
  const target = canonicalPath.normalize('NFC').toLowerCase();
  // 大小写不敏感的文件系统也必须互斥；敏感文件系统至多保守地串行同名大小写变体。
  const key = createHash('sha256').update(target).digest('hex');
  // 同一产品、同一系统用户的 Git/Hook 入口共用锁空间，不随站点、HOME、TMPDIR 或配置目录变化。
  // 不在目标附近写入：无效 attach 不创建目录，只读父目录也不影响可写 checkout。
  const lockDir = path.join(
    userInfo().homedir,
    BRAND_WORKTREE_LOCK_DIR_NAME,
    'worktree-locks',
  );
  const lockPath = path.join(lockDir, key);
  let compromised: Error | undefined;
  let released = false;
  let unlock: () => Promise<void>;
  try {
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    unlock = await lock(lockPath, {
      realpath: false,
      // 创建可能包含 fetch/初始化；续期由现有锁库处理，崩溃遗留锁在过期后可重试。
      stale: 60_000,
      retries: 0,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOCKED') {
      throw new Error(
        `Worktree operation is in progress at ${targetPath}. Retry after it finishes. If the previous process exited abnormally, retry after about 60 seconds.`,
      );
    }
    if (isFileAccessDeniedError(error)) {
      throw new Error(
        `Cannot reserve worktree at ${targetPath}. Check write access to the shared lock directory ${lockDir}.`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    target,
    get held() {
      return !compromised && !released;
    },
    assertHeld() {
      if (compromised || released) {
        throw new Error(
          `Worktree reservation was lost; checkout retained at ${targetPath}.`,
          { cause: compromised },
        );
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await unlock();
      } catch (error) {
        // 不把已提交的 Enter 反转成失败；释放失败的短期锁仍可按过期规则回收。
        runLogger.warn(
          '[WorktreeSession] Failed to release creation reservation.',
          error,
        );
      }
    },
  };
}

/** 同一操作可能已锁定 Hook 名称对应的目录；实际路径相同时不重复取锁。 */
export async function addWorktreeReservation(
  reservations: WorktreeCreationReservation[],
  targetPath: string,
): Promise<WorktreeCreationReservation> {
  const canonicalPath = await canonicalizeWorktreePath(targetPath);
  const target = canonicalPath.normalize('NFC').toLowerCase();
  const existing = reservations.find(
    (reservation) => reservation.target === target,
  );
  if (existing) {
    existing.assertHeld();
    return existing;
  }
  const reservation = await reserveWorktreePath(targetPath, canonicalPath);
  reservations.push(reservation);
  return reservation;
}

export async function withWorktreeReservation<T>(
  targetPath: string,
  operation: (reservation: WorktreeCreationReservation) => Promise<T>,
  reservations?: WorktreeCreationReservation[],
): Promise<T> {
  // 仅借用当前操作显式传入的锁；不能复用其他会话或并发操作持有的锁。
  if (reservations) {
    return operation(await addWorktreeReservation(reservations, targetPath));
  }
  const reservation = await reserveWorktreePath(
    targetPath,
    await canonicalizeWorktreePath(targetPath),
  );
  try {
    return await operation(reservation);
  } finally {
    await reservation.release();
  }
}
