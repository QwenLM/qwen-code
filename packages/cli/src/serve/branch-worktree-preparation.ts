/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitWorktreeService,
  WORKTREE_SESSION_FILE,
  clearWorktreeSessionDurable,
  readWorktreeSession,
  readWorktreeSessionMarker,
  worktreeBranchForSlug,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import type { BridgeSessionExecutionSnapshot } from '@qwen-code/acp-bridge/bridgeTypes';
import { getHeadCommit } from './server/git-branch-ops.js';

const execFileAsync = promisify(execFile);
const BRANCH_WORKTREE_JOURNAL_MAX_BYTES = 64 * 1024;

export interface BranchWorktreeBaseCheckout {
  repoTop: string;
  checkoutCwd: string;
  headCommit: string;
  branch: string;
}

export type BranchWorktreePreparationPhase =
  | 'planned'
  | 'worktree-created'
  | 'marker-created'
  | 'sidecar-ready'
  | 'mutation-dispatched'
  | 'cleanup-intent'
  | 'worktree-removed'
  | 'branch-deleted'
  | 'branch-preserved';

export interface BranchWorktreePreparationJournal {
  version: 1;
  ownerToken: string;
  pid: number;
  hostname: string;
  createdAt: string;
  targetSessionId: string;
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  repoTop: string;
  baseCommit: string;
  sidecarPath: string;
  markerCreated: boolean;
  sidecarCreated: boolean;
  phase: BranchWorktreePreparationPhase;
}

const PREPARATION_PHASES = new Set<BranchWorktreePreparationPhase>([
  'planned',
  'worktree-created',
  'marker-created',
  'sidecar-ready',
  'mutation-dispatched',
  'cleanup-intent',
  'worktree-removed',
  'branch-deleted',
  'branch-preserved',
]);

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs
    .lstat(filePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
}

async function writeExclusiveFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let openedStat: Awaited<ReturnType<typeof handle.stat>> | undefined;
  let completed = false;
  try {
    openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1) {
      throw new Error('Branch worktree journal must be a regular file');
    }
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    const finalStat = await fs.lstat(filePath);
    if (
      !finalStat.isFile() ||
      finalStat.nlink !== 1 ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino
    ) {
      throw new Error('Branch worktree journal path changed');
    }
    completed = true;
  } finally {
    await handle.close();
    if (!completed && openedStat) {
      await fs
        .lstat(filePath)
        .then(async (pathStat) => {
          if (
            pathStat.isFile() &&
            pathStat.nlink === 1 &&
            pathStat.dev === openedStat!.dev &&
            pathStat.ino === openedStat!.ino
          ) {
            await fs.unlink(filePath);
          }
        })
        .catch(() => {});
    }
  }
}

async function readStrictFile(filePath: string): Promise<string> {
  const pathStat = await fs.lstat(filePath);
  if (!pathStat.isFile() || pathStat.nlink !== 1) {
    throw new Error('Branch worktree journal must be a regular file');
  }
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size > BRANCH_WORKTREE_JOURNAL_MAX_BYTES
    ) {
      throw new Error('Branch worktree journal path changed');
    }
    const buffer = Buffer.alloc(BRANCH_WORKTREE_JOURNAL_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > BRANCH_WORKTREE_JOURNAL_MAX_BYTES) {
      throw new Error('Branch worktree journal is too large');
    }
    const contents = buffer.subarray(0, bytesRead).toString('utf8');
    const finalStat = await fs.lstat(filePath);
    if (
      !finalStat.isFile() ||
      finalStat.nlink !== 1 ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino
    ) {
      throw new Error('Branch worktree journal path changed');
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export function getBranchWorktreeJournalPath(
  sidecarPath: string,
  targetSessionId: string,
): string {
  return path.join(
    path.dirname(sidecarPath),
    `.branch-worktree-${targetSessionId}.json`,
  );
}

export async function createBranchWorktreeJournal(args: {
  journalPath: string;
  targetSessionId: string;
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  repoTop: string;
  baseCommit: string;
  sidecarPath: string;
}): Promise<BranchWorktreePreparationJournal> {
  const journal: BranchWorktreePreparationJournal = {
    version: 1,
    ownerToken: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    targetSessionId: args.targetSessionId,
    slug: args.slug,
    worktreePath: args.worktreePath,
    worktreeBranch: args.worktreeBranch,
    repoTop: args.repoTop,
    baseCommit: args.baseCommit,
    sidecarPath: args.sidecarPath,
    markerCreated: false,
    sidecarCreated: false,
    phase: 'planned',
  };
  await fs.mkdir(path.dirname(args.journalPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeExclusiveFile(args.journalPath, `${JSON.stringify(journal)}\n`);
  await fsyncDirectory(path.dirname(args.journalPath));
  return journal;
}

export async function updateBranchWorktreeJournal(
  journalPath: string,
  current: BranchWorktreePreparationJournal,
  phase: BranchWorktreePreparationPhase,
): Promise<BranchWorktreePreparationJournal> {
  const onDisk = JSON.parse(
    await readStrictFile(journalPath),
  ) as BranchWorktreePreparationJournal;
  if (
    onDisk.version !== 1 ||
    onDisk.ownerToken !== current.ownerToken ||
    onDisk.pid !== current.pid ||
    onDisk.hostname !== current.hostname ||
    onDisk.createdAt !== current.createdAt ||
    onDisk.targetSessionId !== current.targetSessionId ||
    onDisk.slug !== current.slug ||
    onDisk.worktreePath !== current.worktreePath ||
    onDisk.worktreeBranch !== current.worktreeBranch ||
    onDisk.repoTop !== current.repoTop ||
    onDisk.baseCommit !== current.baseCommit ||
    onDisk.sidecarPath !== current.sidecarPath ||
    onDisk.markerCreated !== current.markerCreated ||
    onDisk.sidecarCreated !== current.sidecarCreated ||
    onDisk.phase !== current.phase
  ) {
    throw new Error('Branch worktree journal ownership changed');
  }
  const next = {
    ...current,
    phase,
    markerCreated:
      current.markerCreated ||
      phase === 'marker-created' ||
      phase === 'sidecar-ready' ||
      phase === 'mutation-dispatched',
    sidecarCreated:
      current.sidecarCreated ||
      phase === 'sidecar-ready' ||
      phase === 'mutation-dispatched',
  };
  const tempPath = `${journalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeExclusiveFile(tempPath, `${JSON.stringify(next)}\n`);
  try {
    await fs.rename(tempPath, journalPath);
    await fsyncDirectory(path.dirname(journalPath));
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
  return next;
}

export async function clearBranchWorktreeJournalDurable(
  journalPath: string,
): Promise<void> {
  await fs.unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fsyncDirectory(path.dirname(journalPath)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
}

async function clearTerminalMetadata(
  journalPath: string,
  journal: BranchWorktreePreparationJournal,
  warn?: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  if (journal.sidecarCreated) {
    await clearWorktreeSessionDurable(journal.sidecarPath);
  } else if (await pathExists(journal.sidecarPath)) {
    warn?.('branch worktree recovery sidecar ownership is unknown', {
      targetSessionId: journal.targetSessionId,
    });
    return;
  }
  await clearBranchWorktreeJournalDurable(journalPath);
}

const recoveryByChatsDir = new Map<string, Promise<void>>();
const RECOVERY_REQUEST_AGE_MS = 2 * 60_000;

function ownerProcessIsAlive(journal: BranchWorktreePreparationJournal) {
  if (journal.hostname !== os.hostname()) return true;
  try {
    process.kill(journal.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isPreparationJournal(
  value: unknown,
): value is BranchWorktreePreparationJournal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['ownerToken'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record['ownerToken'],
    ) &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['hostname'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['targetSessionId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record['targetSessionId'],
    ) &&
    typeof record['slug'] === 'string' &&
    GitWorktreeService.validateUserWorktreeSlug(record['slug']) === null &&
    typeof record['worktreePath'] === 'string' &&
    path.isAbsolute(record['worktreePath']) &&
    typeof record['worktreeBranch'] === 'string' &&
    typeof record['repoTop'] === 'string' &&
    path.isAbsolute(record['repoTop']) &&
    typeof record['baseCommit'] === 'string' &&
    /^[0-9a-f]{40,64}$/i.test(record['baseCommit']) &&
    typeof record['sidecarPath'] === 'string' &&
    path.isAbsolute(record['sidecarPath']) &&
    typeof record['markerCreated'] === 'boolean' &&
    typeof record['sidecarCreated'] === 'boolean' &&
    typeof record['phase'] === 'string' &&
    PREPARATION_PHASES.has(record['phase'] as BranchWorktreePreparationPhase)
  );
}

export function recoverBranchWorktreePreparations(args: {
  workspaceCwd: string;
  sessionService: SessionService;
  assertGenerationOpen?: () => void;
  isWorktreeOccupied?: (worktreePath: string) => boolean;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  const probeSidecar = args.sessionService.getWorktreeSessionPath(
    '00000000-0000-4000-8000-000000000000',
  );
  const chatsDir = path.dirname(probeSidecar);
  const current = recoveryByChatsDir.get(chatsDir);
  if (current) return current;
  const recovery = (async () => {
    const entries = await fs.readdir(chatsDir).catch(() => []);
    if (!entries.some((name) => name.startsWith('.branch-worktree-'))) return;
    const workspaceCwd = await fs.realpath(args.workspaceCwd).catch(() => null);
    const discoveredRepoTop = workspaceCwd
      ? await new GitWorktreeService(workspaceCwd)
          .getRepoTopLevel()
          .catch(() => null)
      : null;
    const runtimeRepoTop = discoveredRepoTop
      ? await fs.realpath(discoveredRepoTop).catch(() => null)
      : null;
    if (runtimeRepoTop === null) {
      args.warn?.('branch worktree recovery workspace is unavailable', {
        workspace: args.workspaceCwd,
      });
      return;
    }
    for (const name of entries) {
      if (!/^\.branch-worktree-[0-9a-f-]{36}\.json$/i.test(name)) continue;
      args.assertGenerationOpen?.();
      const journalPath = path.join(chatsDir, name);
      let journal: BranchWorktreePreparationJournal;
      try {
        const parsed: unknown = JSON.parse(await readStrictFile(journalPath));
        if (!isPreparationJournal(parsed)) throw new Error('invalid shape');
        journal = parsed;
      } catch (error) {
        args.warn?.('invalid branch worktree recovery journal preserved', {
          journalPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const expectedJournalPath = getBranchWorktreeJournalPath(
        journal.sidecarPath,
        journal.targetSessionId,
      );
      const worktreeService = new GitWorktreeService(runtimeRepoTop);
      const journalRepoTop = await fs
        .realpath(journal.repoTop)
        .catch(() => null);
      if (
        expectedJournalPath !== journalPath ||
        journal.sidecarPath !==
          args.sessionService.getWorktreeSessionPath(journal.targetSessionId) ||
        journalRepoTop !== runtimeRepoTop ||
        path.resolve(journal.repoTop, '.qwen', 'worktrees', journal.slug) !==
          path.resolve(journal.worktreePath) ||
        journal.worktreeBranch !== worktreeBranchForSlug(journal.slug)
      ) {
        args.warn?.('branch worktree recovery journal identity mismatch', {
          targetSessionId: journal.targetSessionId,
        });
        continue;
      }
      if (
        await args.sessionService.sessionExistsInAnyState(
          journal.targetSessionId,
        )
      ) {
        await clearBranchWorktreeJournalDurable(journalPath);
        continue;
      }
      if (!journal.sidecarCreated && (await pathExists(journal.sidecarPath))) {
        args.warn?.('branch worktree recovery sidecar ownership is unknown', {
          targetSessionId: journal.targetSessionId,
        });
        continue;
      }
      if (
        journal.phase === 'branch-deleted' ||
        journal.phase === 'branch-preserved'
      ) {
        await clearTerminalMetadata(journalPath, journal, args.warn);
        continue;
      }
      if (journal.phase === 'mutation-dispatched') {
        args.warn?.('branch worktree outcome remains unknown; resources kept', {
          targetSessionId: journal.targetSessionId,
        });
        continue;
      }
      const createdAt = Date.parse(journal.createdAt);
      if (
        !Number.isFinite(createdAt) ||
        Date.now() - createdAt < RECOVERY_REQUEST_AGE_MS ||
        ownerProcessIsAlive(journal)
      ) {
        continue;
      }
      if (journal.phase === 'planned') {
        if (!(await pathExists(journal.worktreePath))) {
          await clearBranchWorktreeJournalDurable(journalPath);
        } else {
          args.warn?.('planned branch worktree residue preserved', {
            targetSessionId: journal.targetSessionId,
          });
        }
        continue;
      }
      if (journal.phase === 'worktree-removed') {
        args.assertGenerationOpen?.();
        const finalized =
          await worktreeService.finalizePreparedUserWorktreeBranch(
            journal.slug,
            journal.baseCommit,
          );
        if (!finalized.success) {
          args.warn?.('branch worktree recovery could not finalize branch', {
            targetSessionId: journal.targetSessionId,
            error: finalized.error,
          });
          continue;
        }
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          finalized.branchPreserved ? 'branch-preserved' : 'branch-deleted',
        );
        if (finalized.branchPreserved) {
          args.warn?.('branch worktree recovery preserved branch', {
            targetSessionId: journal.targetSessionId,
            branch: journal.worktreeBranch,
          });
        }
        await clearTerminalMetadata(journalPath, journal, args.warn);
        continue;
      }
      let occupied = false;
      try {
        occupied = args.isWorktreeOccupied?.(journal.worktreePath) ?? false;
      } catch (error) {
        args.warn?.('branch worktree live occupancy is unknown', {
          targetSessionId: journal.targetSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (occupied) {
        args.warn?.('branch worktree is still occupied by a live session', {
          targetSessionId: journal.targetSessionId,
        });
        continue;
      }
      if (journal.phase !== 'cleanup-intent') {
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          'cleanup-intent',
        );
      }
      if (await pathExists(journal.worktreePath)) {
        const markerOwner = await readWorktreeSessionMarker(
          journal.worktreePath,
        );
        if (
          (journal.markerCreated && markerOwner !== journal.targetSessionId) ||
          (markerOwner !== null && markerOwner !== journal.targetSessionId)
        ) {
          args.warn?.('branch worktree recovery marker owner changed', {
            targetSessionId: journal.targetSessionId,
          });
          continue;
        }
        args.assertGenerationOpen?.();
        const removed = await worktreeService.removePreparedUserWorktree(
          journal.slug,
          journal.markerCreated || markerOwner === journal.targetSessionId
            ? journal.targetSessionId
            : null,
          journal.baseCommit,
          async () => {
            journal = await updateBranchWorktreeJournal(
              journalPath,
              journal,
              'worktree-removed',
            );
            args.assertGenerationOpen?.();
          },
        );
        if (!removed.success) {
          args.warn?.('branch worktree recovery refused cleanup', {
            targetSessionId: journal.targetSessionId,
            error: removed.error,
          });
          continue;
        }
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          removed.branchPreserved ? 'branch-preserved' : 'branch-deleted',
        );
      } else {
        const registered = await worktreeService
          .isPreparedUserWorktreeRegistered(journal.slug)
          .catch(() => undefined);
        if (registered !== false) {
          args.warn?.('branch worktree registry state remains unknown', {
            targetSessionId: journal.targetSessionId,
          });
          continue;
        }
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          'worktree-removed',
        );
        args.assertGenerationOpen?.();
        const finalized =
          await worktreeService.finalizePreparedUserWorktreeBranch(
            journal.slug,
            journal.baseCommit,
          );
        if (!finalized.success) {
          args.warn?.('branch worktree recovery could not finalize branch', {
            targetSessionId: journal.targetSessionId,
            error: finalized.error,
          });
          continue;
        }
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          finalized.branchPreserved ? 'branch-preserved' : 'branch-deleted',
        );
        if (finalized.branchPreserved) {
          args.warn?.('branch worktree recovery preserved branch', {
            targetSessionId: journal.targetSessionId,
            branch: journal.worktreeBranch,
          });
        }
      }
      await clearTerminalMetadata(journalPath, journal, args.warn);
    }
  })().finally(() => {
    recoveryByChatsDir.delete(chatsDir);
  });
  recoveryByChatsDir.set(chatsDir, recovery);
  return recovery;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return await fs.realpath(path.resolve(cwd, stdout.trim()));
  } catch {
    return null;
  }
}

export async function resolveBranchWorktreeBaseCheckout(args: {
  workspaceCwd: string;
  sessionId: string;
  snapshot: BridgeSessionExecutionSnapshot;
  sidecarPath: string;
}): Promise<BranchWorktreeBaseCheckout | null> {
  const workspaceCwd = await fs.realpath(args.workspaceCwd).catch(() => null);
  const snapshotWorkspace = await fs
    .realpath(args.snapshot.workspaceCwd)
    .catch(() => null);
  const effectiveCwd = await fs
    .realpath(args.snapshot.effectiveCwd)
    .catch(() => null);
  if (
    workspaceCwd === null ||
    snapshotWorkspace !== workspaceCwd ||
    effectiveCwd === null
  ) {
    return null;
  }

  const workspaceGit = new GitWorktreeService(workspaceCwd);
  if (!(await workspaceGit.isGitRepository())) return null;
  const repoTop = await workspaceGit.getRepoTopLevel().catch(() => null);
  if (repoTop === null) return null;
  const canonicalRepoTop = await fs.realpath(repoTop).catch(() => null);
  if (canonicalRepoTop === null) return null;

  const effectiveGit = new GitWorktreeService(effectiveCwd);
  if (!(await effectiveGit.isGitRepository())) return null;
  const checkoutTop = await effectiveGit.getRepoTopLevel().catch(() => null);
  if (checkoutTop === null) return null;
  const canonicalCheckoutTop = await fs.realpath(checkoutTop).catch(() => null);
  if (canonicalCheckoutTop === null) return null;

  if (canonicalCheckoutTop !== canonicalRepoTop) {
    const [workspaceCommonDir, checkoutCommonDir] = await Promise.all([
      resolveGitCommonDir(canonicalRepoTop),
      resolveGitCommonDir(canonicalCheckoutTop),
    ]);
    const sidecar = await readWorktreeSession(args.sidecarPath).catch(
      () => null,
    );
    const sidecarPath = sidecar
      ? await fs.realpath(sidecar.worktreePath).catch(() => null)
      : null;
    const snapshotPath = args.snapshot.worktree
      ? await fs.realpath(args.snapshot.worktree.path).catch(() => null)
      : null;
    const managedRoot = path.join(canonicalRepoTop, '.qwen', 'worktrees');
    const markerOwner = await readWorktreeSessionMarker(canonicalCheckoutTop);
    if (
      workspaceCommonDir === null ||
      checkoutCommonDir !== workspaceCommonDir ||
      sidecar === null ||
      sidecarPath !== canonicalCheckoutTop ||
      snapshotPath !== canonicalCheckoutTop ||
      markerOwner !== args.sessionId ||
      !isWithinRoot(canonicalCheckoutTop, managedRoot)
    ) {
      return null;
    }
  } else if (!isWithinRoot(effectiveCwd, canonicalRepoTop)) {
    return null;
  }

  const headCommit = await getHeadCommit(canonicalCheckoutTop);
  if (!headCommit) return null;
  const branch = await effectiveGit.getCurrentBranch().catch(() => 'HEAD');
  return {
    repoTop: canonicalRepoTop,
    checkoutCwd: canonicalCheckoutTop,
    headCommit,
    branch: branch || 'HEAD',
  };
}

export async function isBranchWorktreeCreationSupported(
  base: BranchWorktreeBaseCheckout,
): Promise<boolean> {
  const qwenDir = path.join(base.repoTop, '.qwen');
  try {
    let writableTarget = base.repoTop;
    for (const candidate of [qwenDir, path.join(qwenDir, 'worktrees')]) {
      const stat = await fs
        .lstat(candidate)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (stat === null) break;
      if (!stat.isDirectory()) return false;
      writableTarget = candidate;
    }
    await fs.access(writableTarget, 2);
    const [, trackedMarker] = await Promise.all([
      execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: base.checkoutCwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(
        'git',
        [
          'ls-tree',
          '-z',
          '--name-only',
          base.headCommit,
          '--',
          WORKTREE_SESSION_FILE,
        ],
        {
          cwd: base.checkoutCwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      ),
    ]);
    return trackedMarker.stdout.length === 0;
  } catch {
    return false;
  }
}
