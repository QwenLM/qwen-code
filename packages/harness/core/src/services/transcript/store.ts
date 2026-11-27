/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  WriterCoordinator,
  type WriterCoordinatorOptions,
} from './append-coordinator.js';
import type {
  TranscriptCommitEntry,
  TranscriptCommitObserver,
} from './append-channel.js';
import type { Entry } from '../../protocol/transcript/entry.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  SessionTranscriptWriter,
  type RelocateSessionTranscriptOptions,
  type SessionWriterMetadataSnapshot,
  type SessionTranscriptWriterOptions,
} from './session-writer.js';
import * as fs from 'node:fs/promises';
import { matchesTranscriptSnapshot } from './snapshot.js';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { isNodeError } from '../../utils/errors.js';
import {
  TranscriptRepository,
  createBoundedResumeReadState,
  type ResumeTranscriptResult,
  type TranscriptResumeReadState,
} from './repository.js';
import {
  beginResumeRead,
  ResumeReadError,
  type ResumeReadAttempt,
} from './resume-read-budget.js';
import { TranscriptWriterHandle } from './writer-handle.js';

export interface SessionWriterStateSnapshot
  extends SessionWriterMetadataSnapshot {
  readonly messageUuids: readonly string[];
  readonly mainParentUuid?: string | null;
}

export interface SessionWriterStateSource {
  loadSessionWriterState(
    filePath: string,
    sessionId: string,
  ): Promise<SessionWriterStateSnapshot>;
}

export interface TranscriptStoreOptions {
  readonly stateSource?: SessionWriterStateSource;
  readonly repository?: TranscriptRepository;
  readonly coordinator?: WriterCoordinator;
  readonly coordinatorOptions?: WriterCoordinatorOptions;
}

export interface AcquireSessionWriterOptions
  extends Omit<SessionTranscriptWriterOptions, 'channel'> {
  filePath: string;
  initialWorkspaceDirectories?: readonly string[];
  /** 显式磁盘冷恢复身份；种子缺失或绑定失效时也不能共享已有 Writer。 */
  coldResume?: { readonly attempt: ResumeReadAttempt };
  /** 仅用于恢复同一 Session 的同一文件；刷新先异步准备，再同步提交。 */
  resume?: {
    readonly state: TranscriptResumeReadState;
    readonly finishOnAccept?: boolean;
    readonly onRefresh: (
      session: ResumeTranscriptResult,
      state: TranscriptResumeReadState,
    ) => (() => void) | Promise<() => void>;
  };
}

export interface AcquireExistingSessionWriterOptions {
  filePath: string;
  sessionId: string;
}

export interface ManagedSessionWriterState {
  key: string;
  readonly writer: SessionTranscriptWriter;
  filePath: string;
  retain(): boolean;
  release(): Promise<boolean>;
  forceClose(): Promise<void>;
}

class SessionWriterState implements ManagedSessionWriterState {
  references = 0;
  lifecycle: 'open' | 'closing' | 'closed' = 'open';
  closePromise: Promise<void> | undefined;

  constructor(
    public key: string,
    public filePath: string,
    readonly writer: SessionTranscriptWriter,
  ) {}

  retain(): boolean {
    if (this.lifecycle !== 'open') {
      return false;
    }
    this.references++;
    return true;
  }

  async release(): Promise<boolean> {
    if (this.references > 0) {
      this.references--;
    }
    if (this.references > 0 || this.lifecycle !== 'open') {
      return false;
    }
    await this.forceClose();
    return true;
  }

  async forceClose(): Promise<void> {
    if (this.lifecycle === 'closed') {
      return;
    }
    if (this.lifecycle === 'closing') {
      return this.closePromise;
    }
    this.lifecycle = 'closing';
    this.closePromise = this.writer.close().finally(() => {
      this.lifecycle = 'closed';
    });
    return this.closePromise;
  }
}

/** Process-scoped composition root for transcript writer state and file order. */
export class TranscriptStore {
  private readonly stateSource: SessionWriterStateSource | undefined;
  private readonly coordinator: WriterCoordinator;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly states = new Map<
    string,
    Promise<ManagedSessionWriterState>
  >();
  private closed = false;

  constructor(options: TranscriptStoreOptions = {}) {
    this.coordinator =
      options.coordinator ?? new WriterCoordinator(options.coordinatorOptions);
    this.transcriptRepository =
      options.repository ??
      new TranscriptRepository({
        beforeStrongRead: (filePath) => this.coordinator.barrier(filePath),
      });
    // 注入缝仅保留给普通 Writer；生产缺省状态读取统一走有界恢复入口。
    this.stateSource = options.stateSource;
  }

  repository(): TranscriptRepository {
    return this.transcriptRepository;
  }

  addCommitObserver(observer: TranscriptCommitObserver): () => void {
    this.assertOpen();
    return this.coordinator.addCommitObserver(observer);
  }

  async publishCommittedEntries(
    filePath: string,
    entries: readonly TranscriptCommitEntry[],
  ): Promise<void> {
    this.assertOpen();
    try {
      await this.coordinator.publishCommittedEntries(filePath, entries);
    } catch (error) {
      runLogger.warn(
        `[Transcript] post-commit observer failed for ${filePath}`,
        error,
      );
    }
  }

  async acquireSessionWriter(
    options: AcquireSessionWriterOptions,
  ): Promise<TranscriptWriterHandle> {
    this.assertOpen();
    const attempt =
      options.coldResume?.attempt ?? options.resume?.state.attempt;
    const coldResume = options.coldResume !== undefined || options.resume?.state.attempt !== undefined;
    attempt?.check();
    if (
      options.coldResume &&
      options.resume?.state.attempt &&
      options.resume.state.attempt !== options.coldResume.attempt
    ) {
      throw new ResumeReadError('unsafe');
    }
    const channel = await this.coordinator.acquire(options.filePath);
    const key = makeWriterStateKey(options.sessionId, channel.filePath);
    let statePromise: Promise<ManagedSessionWriterState>;
    try {
      this.assertOpen();
      attempt?.check();
      const existing = this.states.get(key);
      if (existing) {
        if (coldResume) throw new ResumeReadError('conflict');
        statePromise = existing;
        await channel.release();
      } else {
        // 检查与登记间不 await，自己创建的 promise 不进入共享冲突分支。
        statePromise = this.createState(
          key,
          channel.filePath,
          channel,
          options,
        );
        this.states.set(key, statePromise);
        void statePromise.catch(() => {
          if (this.states.get(key) === statePromise) {
            this.states.delete(key);
          }
        });
      }
    } catch (error) {
      await channel.release().catch(() => undefined);
      throw error;
    }

    const state = await statePromise;
    if (!state.retain()) {
      // 冷恢复只能获取一次，不能递归等待自己的状态或改动他人的关闭流程。
      if (coldResume) throw new ResumeReadError('conflict');
      await state.forceClose();
      if (this.states.get(key) === statePromise) {
        this.states.delete(key);
      }
      return this.acquireSessionWriter(options);
    }
    if (options.resume?.finishOnAccept) attempt?.finish();
    return new TranscriptWriterHandle(this, state);
  }

  /**
   * Retains a writer that is already active without loading transcript state.
   *
   * Active-session operations use this path when a second open of the same
   * transcript is unsafe or would omit pending in-memory entries.
   */
  async acquireExistingSessionWriter(
    options: AcquireExistingSessionWriterOptions,
  ): Promise<TranscriptWriterHandle | undefined> {
    this.assertOpen();
    const canonicalPath = await this.coordinator.canonicalizePath(
      options.filePath,
    );
    const key = makeWriterStateKey(options.sessionId, canonicalPath);

    const statePromise = this.states.get(key);
    if (!statePromise) {
      return undefined;
    }

    const state = await statePromise;
    if (this.states.get(key) !== statePromise || !state.retain()) {
      return undefined;
    }
    return new TranscriptWriterHandle(this, state);
  }

  acquireSubagentWriter(
    options: AcquireSessionWriterOptions,
  ): Promise<TranscriptWriterHandle> {
    return this.acquireSessionWriter(options);
  }

  async releaseWriter(state: ManagedSessionWriterState): Promise<void> {
    // A throwing release still leaves the writer closed, so evict either way.
    let closed = true;
    try {
      closed = await state.release();
    } finally {
      if (closed) {
        await this.deleteStateIfCurrent(state);
      }
    }
  }

  async relocateWriter(
    state: ManagedSessionWriterState,
    options: RelocateSessionTranscriptOptions,
  ): Promise<void> {
    this.assertOpen();
    const targetFilePath = await this.coordinator.canonicalizePath(
      options.filePath,
    );
    const targetKey = makeWriterStateKey(
      state.writer.getSessionId(),
      targetFilePath,
    );
    const existingTarget = this.states.get(targetKey);
    if (existingTarget && targetKey !== state.key) {
      throw new Error(
        `Cannot relocate transcript: target writer is already active at ${targetFilePath}`,
      );
    }

    const sourceKey = state.key;
    let resolveTargetReservation:
      | ((value: ManagedSessionWriterState) => void)
      | undefined;
    let rejectTargetReservation: ((reason: unknown) => void) | undefined;
    let targetReservation: Promise<ManagedSessionWriterState> | undefined;
    if (sourceKey !== targetKey) {
      targetReservation = new Promise<ManagedSessionWriterState>(
        (resolve, reject) => {
          resolveTargetReservation = resolve;
          rejectTargetReservation = reject;
        },
      );
      // Reserve the target key before touching the filesystem so a concurrent
      // acquire cannot construct a second writer for the destination bucket.
      this.states.set(targetKey, targetReservation);
      void targetReservation.catch(() => undefined);
    }

    try {
      await state.writer.relocate(
        { ...options, filePath: targetFilePath },
        async (sourceFilePath, preparedTargetPath, sourceFileMayBeMissing) => {
          const targetChannel =
            await this.coordinator.acquire(preparedTargetPath);
          try {
            await moveTranscriptFileExclusive(
              sourceFilePath,
              preparedTargetPath,
              sourceFileMayBeMissing,
            );
            return targetChannel;
          } catch (error) {
            await targetChannel.release().catch(() => undefined);
            throw error;
          }
        },
      );
    } catch (error) {
      // The physical move and the context markers are two separate I/O
      // stages. If the move succeeded but appending `relocated` or
      // `worktree-state` failed, the writer has already switched channels.
      // Keep the store keyed to the writer's real path so a later acquire
      // cannot create a second independent writer for the same JSONL.
      if (
        sourceKey !== targetKey &&
        state.writer.getSessionFilePath() === targetFilePath
      ) {
        await this.commitRelocatedState(
          state,
          sourceKey,
          targetKey,
          targetFilePath,
          targetReservation,
          resolveTargetReservation,
        );
        throw error;
      }
      if (
        targetReservation &&
        this.states.get(targetKey) === targetReservation
      ) {
        this.states.delete(targetKey);
      }
      rejectTargetReservation?.(error);
      throw error;
    }

    if (sourceKey !== targetKey) {
      await this.commitRelocatedState(
        state,
        sourceKey,
        targetKey,
        targetFilePath,
        targetReservation,
        resolveTargetReservation,
      );
    }
  }

  private async commitRelocatedState(
    state: ManagedSessionWriterState,
    sourceKey: string,
    targetKey: string,
    targetFilePath: string,
    targetReservation: Promise<ManagedSessionWriterState> | undefined,
    resolveTargetReservation:
      | ((value: ManagedSessionWriterState) => void)
      | undefined,
  ): Promise<void> {
    const sourceState = this.states.get(sourceKey);
    if (sourceState && (await sourceState.catch(() => undefined)) === state) {
      this.states.delete(sourceKey);
    }
    state.key = targetKey;
    state.filePath = targetFilePath;
    if (
      targetReservation &&
      this.states.get(targetKey) === targetReservation
    ) {
      resolveTargetReservation?.(state);
    } else {
      this.states.set(targetKey, Promise.resolve(state));
    }
  }

  private async deleteStateIfCurrent(
    state: ManagedSessionWriterState,
  ): Promise<void> {
    const current = this.states.get(state.key);
    // Swallow a rejected state promise: it is already self-evicting via the
    // catch installed in acquireSessionWriter, and rethrowing here would mask
    // whichever error brought us into release.
    if (current && (await current.catch(() => undefined)) === state) {
      this.states.delete(state.key);
    }
  }

  async deleteTranscript(filePath: string): Promise<void> {
    this.assertOpen();
    const probe = await this.coordinator.acquire(filePath);
    const canonicalPath = probe.filePath;
    await probe.release();
    const matchingStates = await Promise.all(
      [...this.states.values()].map((state) => state),
    );
    await Promise.all(
      matchingStates
        .filter((state) => state.filePath === canonicalPath)
        .map((state) => state.forceClose()),
    );
    for (const state of matchingStates) {
      if (state.filePath === canonicalPath) {
        this.states.delete(state.key);
      }
    }
    await this.coordinator.deleteFile(canonicalPath);
  }

  createForkTranscript(
    filePath: string,
    entries: readonly Entry[],
  ): Promise<void> {
    this.assertOpen();
    return this.coordinator.createFileExclusive(filePath, entries);
  }

  flushAll(): Promise<void> {
    this.assertOpen();
    return this.coordinator.flushAll();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const states = await Promise.allSettled([...this.states.values()]);
    const initializedStates = states.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const writerResults = await Promise.allSettled(
      initializedStates.map((state) => state.forceClose()),
    );
    this.states.clear();
    const coordinatorResult = await Promise.allSettled([
      this.coordinator.close(),
    ]);
    const rejected = [...writerResults, ...coordinatorResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
  }

  private async createState(
    key: string,
    canonicalPath: string,
    channel: Awaited<ReturnType<WriterCoordinator['acquire']>>,
    options: AcquireSessionWriterOptions,
  ): Promise<SessionWriterState> {
    const borrowedAttempt =
      options.coldResume?.attempt ?? options.resume?.state.attempt;
    const hydrate = (snapshot: SessionWriterStateSnapshot) => {
      const writer = new SessionTranscriptWriter({
        channel,
        sessionId: options.sessionId,
        cwd: options.cwd,
        entrypoint: options.entrypoint,
        ...(options.userType ? { userType: options.userType } : {}),
        ...(options.version ? { version: options.version } : {}),
        ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
      });
      // 已存在但尚无消息的 JSONL 也已物化；显式 null parent 表示空的持久化链。
      if (
        snapshot.messageUuids.length > 0 ||
        snapshot.mainParentUuid !== undefined
      ) {
        writer.initializeExistingTranscript(
          snapshot.messageUuids,
          snapshot.mainParentUuid,
        );
      }
      writer.hydrateSessionMetadata(snapshot);
      if (options.initialWorkspaceDirectories) {
        writer.primeWorkspaceDirectories(options.initialWorkspaceDirectories);
      }
      return writer;
    };
    try {
      const writer = await this.loadWriterState(
        canonicalPath,
        channel,
        options,
        borrowedAttempt,
        hydrate,
      );
      return new SessionWriterState(key, canonicalPath, writer);
    } catch (error) {
      // 仅释放本次 channel，清理失败不能盖掉恢复失败的稳定原因。
      await channel.release().catch(() => undefined);
      throw error;
    }
  }

  private async loadWriterState(
    filePath: string,
    channel: Awaited<ReturnType<WriterCoordinator['acquire']>>,
    options: AcquireSessionWriterOptions,
    borrowedAttempt: ResumeReadAttempt | undefined,
    hydrate: (snapshot: SessionWriterStateSnapshot) => SessionTranscriptWriter,
  ): Promise<SessionTranscriptWriter> {
    const resume = options.resume;
    const validResume =
      resume &&
      resume.state.sessionId === options.sessionId &&
      (await this.coordinator.canonicalizePath(resume.state.filePath)) ===
        filePath
        ? resume
        : undefined;
    const accept = (
      state: TranscriptResumeReadState | undefined,
      attempt: ResumeReadAttempt | undefined,
      commit?: () => void,
    ) =>
      channel.withExclusiveRead(async () => {
        attempt?.check();
        if (!(await matchesTranscriptSnapshot(filePath, state?.snapshot))) {
          return undefined;
        }
        this.assertOpen();
        attempt?.check();
        // 最终校验后没有 await：Writer hydration 与已接线数据同步接管。
        const writer = hydrate(state?.writerState ?? { messageUuids: [] });
        attempt?.check();
        commit?.();
        return writer;
      });

    if (validResume && validResume.state.snapshot.inode !== 0) {
      const writer = borrowedAttempt
        ? await borrowedAttempt.run(() =>
            accept(validResume.state, borrowedAttempt),
          )
        : await accept(validResume.state, undefined);
      if (writer) return writer;
    } else if (
      !validResume &&
      this.stateSource &&
      !options.coldResume &&
      !borrowedAttempt
    ) {
      // 兼容普通 Writer 的测试注入；冷恢复/携带 attempt 的状态不能走此旁路。
      const snapshot = await this.stateSource.loadSessionWriterState(
        filePath,
        options.sessionId,
      );
      return channel.withExclusiveRead(async () => {
        this.assertOpen();
        return hydrate(snapshot);
      });
    }

    if (!validResume && !options.coldResume && !borrowedAttempt) {
      const emptyWriter = await accept(undefined, undefined);
      if (emptyWriter) return emptyWriter;
    }
    const attempt = borrowedAttempt ?? await beginResumeRead();
    try {
    return await attempt.run(async () => {
      if (validResume) attempt.retrySnapshot();
      // 读取和接管共用重读额度，不能在每一层各重试一次。
      const maxReads = validResume ? 1 : 2;
      for (let read = 0; read < maxReads; read++) {
        attempt.check();
        const fresh = await this.transcriptRepository.readForResume(filePath, {
          sessionId: options.sessionId,
          attempt,
          consistency: 'flush-pending',
          resumeSessionAt: validResume?.state.resumeSessionAt,
          resumeDropsTurn: validResume?.state.resumeDropsTurn,
        });
        // 仅首次无种子读取允许不存在的新会话，失效后的缺失不能伪装为空 Writer。
        if (!fresh && (options.coldResume || validResume || read > 0)) {
          throw new ResumeReadError('snapshot');
        }
        const state = fresh ? createBoundedResumeReadState(fresh) : undefined;
        // legacy/workspace 查询及所有异步回调均留在追加域外，不先修改 messages。
        const commit =
          fresh && validResume
            ? await validResume.onRefresh(fresh, state!)
            : undefined;
        attempt.check();
        const writer = await accept(state, attempt, commit);
        if (writer) return writer;
        attempt.retrySnapshot();
      }
      throw new ResumeReadError('snapshot');
    });
    } finally {
      if (!borrowedAttempt) attempt.finish();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('TranscriptStore is closed');
    }
  }
}

function makeWriterStateKey(sessionId: string, canonicalPath: string): string {
  return `${sessionId}\0${canonicalPath}`;
}

/** Moves one transcript without ever replacing an existing target session. */
async function moveTranscriptFileExclusive(
  sourceFilePath: string,
  targetFilePath: string,
  sourceFileMayBeMissing: boolean,
): Promise<void> {
  if (sourceFilePath === targetFilePath) {
    return;
  }
  await fs.mkdir(path.dirname(targetFilePath), {
    recursive: true,
    mode: 0o700,
  });

  try {
    await fs.link(sourceFilePath, targetFilePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      const [sourceStat, targetStat] = await Promise.all([
        fs.stat(sourceFilePath),
        fs.stat(targetFilePath),
      ]);
      if (
        Number.isSafeInteger(sourceStat.ino) &&
        sourceStat.ino > 0 &&
        sourceStat.dev === targetStat.dev &&
        sourceStat.ino === targetStat.ino
      ) {
        // 仅可靠 inode 可证明硬链接迁移已完成；零值或精度丢失不能作为删源依据。
        // 两个路径确指同一文件时，可继续上次进程未完成的 unlink。
        await fs.unlink(sourceFilePath);
        return;
      }
    }
    if (
      sourceFileMayBeMissing &&
      isNodeError(error) &&
      error.code === 'ENOENT'
    ) {
      const handle = await fs.open(targetFilePath, 'wx', 0o600);
      await handle.close();
      return;
    }
    if (!isNodeError(error) || error.code !== 'EXDEV') {
      throw error;
    }
    await fs.copyFile(
      sourceFilePath,
      targetFilePath,
      fsConstants.COPYFILE_EXCL,
    );
  }

  try {
    await fs.unlink(sourceFilePath);
  } catch (error) {
    await fs.rm(targetFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
