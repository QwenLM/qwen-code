/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { drainTranscriptSteps, runTranscriptSteps } from './cooperative.js';
import { isNodeError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  applyTranscriptCompatibility,
  applyTranscriptCompatibilitySteps,
} from './compatibility.js';
import {
  resolveTranscriptChainSteps,
  resolveTranscriptChain,
  isMessageInAgentScope,
  type ResolvedTranscriptChain,
  TranscriptConsistencyError,
  type TranscriptGraphView,
  type LeafSelectionPolicy,
} from './graph-resolver.js';
import { buildTranscriptIndex, type TranscriptIndex } from './index.js';
import {
  projectContentReplacements,
  projectTranscriptSession,
  type ProjectedTranscriptSession,
  type TranscriptProjectionView,
} from './resume-projector.js';
import {
  EntryScanner,
  scanTranscriptBuffer,
  type ScanProfile,
} from './scanner.js';
import type {
  SessionWriterStateSnapshot,
  SessionWriterStateSource,
} from './store.js';
import type { TranscriptWorktreeSession } from '../../protocol/transcript/entry.js';
import type { TranscriptFileSnapshot } from './scanner.js';
import type { TranscriptMetadataView } from './index.js';
import {
  beginResumeRead,
  isResumeReadError,
  ResumeReadError,
  type ResumeReadAttempt,
} from './resume-read-budget.js';
import {
  readBoundedTranscript,
  readBoundedTranscriptIndex,
} from './resume-reader.js';
import { selectHistoricalLineage } from './historical-lineage.js';
import { assertResumeDropsTurn } from '../resumeSessionAt.js';

/** 两阶段恢复的明确结果；局部 index 不跨越读取边界。 */
export interface ResumeTranscriptResult {
  readonly filePath: string;
  readonly sessionId: string;
  readonly snapshot: TranscriptFileSnapshot;
  readonly metadata: TranscriptMetadataView;
  readonly messages: ProjectedTranscriptSession['messages'];
  readonly chain: ProjectedTranscriptSession['chain'];
  readonly fileHistorySnapshots: ProjectedTranscriptSession['fileHistorySnapshots'];
  readonly contentReplacements: ProjectedTranscriptSession['contentReplacements'];
  readonly worktreeStates: readonly TranscriptWorktreeSession[];
  readonly originalCwd?: string;
  readonly writerState: SessionWriterStateSnapshot;
  readonly runtimeTailUuid: string | null;
  readonly attempt: ResumeReadAttempt;
  readonly retainedEntries: number;
  readonly retainedMessageCount: number;
  readonly hasCompactBoundary: boolean;
  readonly resumeSessionAt?: string;
  readonly resumeDropsTurn?: string;
}

export interface ResumeTranscriptReadOptions {
  /** Fork 需要完整历史，禁止 compact 尾段裁剪。 */
  readonly view?: 'historical';
  readonly sessionId: string;
  readonly attempt: ResumeReadAttempt;
  readonly consistency?: 'disk-snapshot' | 'flush-pending';
  readonly resumeSessionAt?: string;
  readonly resumeDropsTurn?: string;
}

/** 转交同一 attempt，生命周期仍由恢复编排层负责。 */
export function createBoundedResumeReadState(
  result: ResumeTranscriptResult,
): TranscriptResumeReadState {
  return {
    filePath: result.filePath,
    sessionId: result.sessionId,
    snapshot: result.snapshot,
    writerState: result.writerState,
    runtimeTailUuid: result.runtimeTailUuid,
    worktreeStates: result.worktreeStates,
    attempt: result.attempt,
    resumeSessionAt: result.resumeSessionAt,
    resumeDropsTurn: result.resumeDropsTurn,
  };
}

/** 完整恢复读取派生的 Writer 初始化状态和历史目录，不保留完整 index。 */
export interface TranscriptResumeReadState {
  readonly filePath: string;
  readonly sessionId: string;
  readonly snapshot: TranscriptFileSnapshot;
  readonly writerState: SessionWriterStateSnapshot;
  /** 普通恢复投影的尾节点；可能与保留未完成工具调用的持久化尾不同。 */
  readonly runtimeTailUuid: string | null;
  readonly worktreeStates: readonly TranscriptWorktreeSession[];
  readonly attempt?: ResumeReadAttempt;
  readonly resumeSessionAt?: string;
  readonly resumeDropsTurn?: string;
}

export interface TranscriptReadOptions {
  readonly profile?: ScanProfile;
  readonly consistency?: 'disk-snapshot' | 'flush-pending';
}

export interface ResolveSessionOptions extends TranscriptReadOptions {
  readonly sessionId?: string;
  readonly leafUuid?: string | null;
  readonly leafPolicy?: LeafSelectionPolicy;
  /** Defaults to runtime; historical operations must opt in explicitly. */
  readonly view?: TranscriptProjectionView;
}

export interface TranscriptRepositoryOptions {
  readonly scanner?: EntryScanner;
  readonly beforeStrongRead?: (filePath: string) => Promise<void>;
}

/** High-level read boundary for indexes, resume projection and writer hydration. */
export class TranscriptRepository implements SessionWriterStateSource {
  private readonly scanner: EntryScanner;
  private readonly beforeStrongRead?: (filePath: string) => Promise<void>;

  constructor(options: TranscriptRepositoryOptions = {}) {
    this.scanner = options.scanner ?? new EntryScanner();
    this.beforeStrongRead = options.beforeStrongRead;
  }

  /** Fork 消费完整历史投影；读取名额由本方法持有并释放，不转交 Writer。 */
  async readForFork(
    filePath: string,
    sessionId: string,
  ): Promise<Pick<
    ResumeTranscriptResult,
    'chain' | 'metadata' | 'fileHistorySnapshots' | 'contentReplacements'
  > | null> {
    const attempt = await beginResumeRead();
    try {
      const result = await this.readForResume(filePath, {
        sessionId,
        attempt,
        view: 'historical',
        consistency: 'flush-pending',
      });
      if (!result) return null;
      const { chain, metadata, fileHistorySnapshots, contentReplacements } =
        result;
      return { chain, metadata, fileHistorySnapshots, contentReplacements };
    } finally {
      attempt.finish();
    }
  }

  /** 专用恢复读取借用 attempt；不改变 full/historical 的默认职责。 */
  async readForResume(
    filePath: string,
    options: ResumeTranscriptReadOptions,
  ): Promise<ResumeTranscriptResult | null> {
    const started = performance.now();
    runLogger.debug('[transcript.resume.read.started]', {
      session_id: options.sessionId,
    });
    try {
      return await options.attempt.run(async () => {
        if (options.consistency === 'flush-pending') {
          await this.beforeStrongRead?.(filePath);
        }
        options.attempt.check();
        const read = () =>
          readBoundedTranscript(
            filePath,
            options,
            this.scanner,
            async (index, messageUuids, retainedEntries) => {
              const session = await runTranscriptSteps(
                this.projectIndexSteps(index, {
                  sessionId: options.sessionId,
                  view:
                    options.resumeSessionAt || options.view === 'historical'
                      ? 'historical'
                      : 'runtime',
                }),
                options.attempt,
              );
              const selection = options.resumeSessionAt
                ? selectHistoricalLineage(
                    session.chain,
                    options.resumeSessionAt,
                    'through-target',
                  )
                : undefined;
              if (options.resumeSessionAt && !selection)
                throw new ResumeReadError('unsafe');
              if (selection)
                assertResumeDropsTurn(
                  selection.discardedChain,
                  options.resumeDropsTurn,
                );
              const messages = selection?.runtimeMessages ?? session.messages;
              const chain = selection?.retainedChain ?? session.chain;
              const replacements = selection
                ? projectContentReplacements(index, chain)
                : session.contentReplacements;
              const state = this.createResumeReadState(
                session,
                options.sessionId,
                this.writerStateFromChain(
                  index,
                  options.sessionId,
                  session.resolved,
                ),
              );
              const lastWorktree = index.entriesInFileOrder.findLast(
                ({ entry }) =>
                  entry.type === 'worktree-state' &&
                  entry.sessionId === options.sessionId &&
                  entry.worktreeSession !== null,
              )?.entry;
              const originalCwd =
                lastWorktree?.type === 'worktree-state'
                  ? lastWorktree.worktreeSession?.originalCwd
                  : undefined;
              return {
                filePath,
                sessionId: options.sessionId,
                snapshot: index.snapshot,
                metadata: index.metadata,
                messages,
                chain,
                fileHistorySnapshots: session.fileHistorySnapshots,
                contentReplacements: replacements,
                worktreeStates: state.worktreeStates,
                ...(originalCwd ? { originalCwd } : {}),
                writerState: {
                  ...state.writerState,
                  messageUuids,
                  ...(selection
                    ? {
                        mainParentUuid: selection.retainedLeafUuid,
                        contentReplacements: [
                          ...(replacements.get(options.sessionId) ?? []),
                        ],
                      }
                    : {}),
                },
                runtimeTailUuid: messages.at(-1)?.uuid ?? null,
                attempt: options.attempt,
                retainedEntries,
                retainedMessageCount: index.messagesByUuid.size,
                hasCompactBoundary: session.compatible.hasCompactBoundary,
                resumeSessionAt: options.resumeSessionAt,
                resumeDropsTurn: options.resumeDropsTurn,
              };
            },
          );
        for (;;) {
          try {
            return await read();
          } catch (error) {
            if (!isResumeReadError(error) || error.reason !== 'snapshot')
              throw error;
            // 失效重读不退还 bytesRead：同一 attempt 的累计 I/O 预算仍生效。
            // 默认 8 GiB 覆盖不超过 4 GiB 的候选文件完整重读一次；更大的文件
            // 若持续变化，第二次扫描按 budget 失败而不是无限追赶。
            options.attempt.retrySnapshot();
          }
        }
      });
    } catch (error) {
      runLogger.warn('[transcript.resume.read.failed]', {
        session_id: options.sessionId,
        reason: isResumeReadError(error) ? error.reason : 'io',
        elapsedMs: Math.round(performance.now() - started),
        ...options.attempt.stats,
      });
      throw error;
    }
  }

  /** Complete index, including inactive branches, under an owned read budget. */
  async loadBoundedIndex(
    filePath: string,
    options: Pick<TranscriptReadOptions, 'consistency'> & {
      signal?: AbortSignal;
    } = {},
  ): Promise<TranscriptIndex | null> {
    return this.withBoundedIndex(filePath, options, async (index) => index);
  }

  /** Projection and full-index verification share one snapshot and read budget. */
  async resolveBoundedSession(
    filePath: string,
    options: ResolveSessionOptions & { signal?: AbortSignal } = {},
  ): Promise<ProjectedTranscriptSession | null> {
    return this.withBoundedIndex(filePath, options, (index, attempt) =>
      runTranscriptSteps(this.projectIndexSteps(index, options), attempt),
    );
  }

  private async withBoundedIndex<T>(
    filePath: string,
    options: Pick<TranscriptReadOptions, 'consistency'> & {
      signal?: AbortSignal;
    },
    project: (index: TranscriptIndex, attempt: ResumeReadAttempt) => Promise<T>,
  ): Promise<T | null> {
    const attempt = await beginResumeRead({ signal: options.signal });
    try {
      return await attempt.run(async () => {
        if (options.consistency === 'flush-pending')
          await this.beforeStrongRead?.(filePath);
        for (;;) {
          try {
            return await readBoundedTranscriptIndex(
              filePath,
              attempt,
              this.scanner,
              (index) => project(index, attempt),
            );
          } catch (error) {
            if (!isResumeReadError(error) || error.reason !== 'snapshot')
              throw error;
            attempt.retrySnapshot();
          }
        }
      });
    } finally {
      attempt.finish();
    }
  }

  async loadIndex(
    filePath: string,
    options: TranscriptReadOptions = {},
  ): Promise<TranscriptIndex | null> {
    if (options.consistency === 'flush-pending') {
      await this.beforeStrongRead?.(filePath);
    }
    try {
      const started = performance.now();
      const profile = options.profile ?? { kind: 'full' };
      const scanned = await this.scanner.scan(filePath, profile);
      const index = buildTranscriptIndex(scanned);
      runLogger.debug('[transcript.read]', {
        profile: profile.kind,
        bytesRead: scanned.bytesRead,
        retainedEntries: scanned.lines.length,
        elapsedMs: Math.round(performance.now() - started),
      });
      return index;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async resolveSession(
    filePath: string,
    options: ResolveSessionOptions = {},
  ): Promise<ProjectedTranscriptSession | null> {
    const view = options.view ?? 'runtime';
    const index = await this.loadIndex(filePath, {
      ...(options.consistency ? { consistency: options.consistency } : {}),
      ...(view === 'historical'
        ? { profile: { kind: 'full' } as const }
        : options.profile
          ? { profile: options.profile }
          : {}),
    });
    if (!index) {
      return null;
    }
    return this.projectIndex(index, options);
  }

  /** Resolves bytes captured through an active writer's append order domain. */
  resolveBuffer(
    filePath: string,
    buffer: Buffer,
    options: ResolveSessionOptions = {},
  ): ProjectedTranscriptSession {
    return this.projectIndex(
      buildTranscriptIndex(scanTranscriptBuffer(filePath, buffer)),
      options,
    );
  }

  private projectIndex(
    index: TranscriptIndex,
    options: ResolveSessionOptions,
  ): ProjectedTranscriptSession {
    return drainTranscriptSteps(this.projectIndexSteps(index, options));
  }

  private *projectIndexSteps(
    index: TranscriptIndex,
    options: ResolveSessionOptions,
  ): Generator<void, ProjectedTranscriptSession> {
    const view = options.view ?? 'runtime';
    const compatible = yield* applyTranscriptCompatibilitySteps(index, {
      retainPreCompactHistory: view === 'historical',
    });
    const marker = options.sessionId
      ? index.metadata.activeLeaves.get(options.sessionId)
      : index.metadata.latestActiveLeaf;
    const expectedSessionId = options.sessionId ?? marker?.sessionId;
    let effectiveLeaf = options.leafUuid;
    if (effectiveLeaf !== undefined) {
      assertLeafBelongsToSession(compatible, effectiveLeaf, expectedSessionId);
    } else {
      effectiveLeaf = resolvePersistedActiveLeaf(
        compatible,
        marker,
        expectedSessionId,
        options.leafPolicy,
      );
    }
    const resolved = yield* resolveTranscriptChainSteps(
      compatible,
      effectiveLeaf,
      options.leafPolicy,
      view,
    );
    yield;
    return projectTranscriptSession(index, compatible, resolved, view);
  }

  async loadSessionWriterState(
    filePath: string,
    sessionId: string,
  ): Promise<SessionWriterStateSnapshot> {
    const index = await this.loadIndex(filePath, {
      consistency: 'flush-pending',
    });
    if (!index) {
      return { messageUuids: [] };
    }
    return this.buildSessionWriterState(index, sessionId);
  }

  createResumeReadState(
    session: ProjectedTranscriptSession,
    sessionId: string,
    writerState?: SessionWriterStateSnapshot,
  ): TranscriptResumeReadState {
    const index = session.index;
    const worktreeStates: TranscriptWorktreeSession[] = [];
    const artifactPaths = new Set<string>();
    for (
      let offset = index.entriesInFileOrder.length - 1;
      offset >= 0;
      offset--
    ) {
      const entry = index.entriesInFileOrder[offset].entry;
      if (
        entry.type === 'worktree-state' &&
        entry.sessionId === sessionId &&
        entry.worktreeSession?.sessionId === sessionId
      ) {
        const state = entry.worktreeSession;
        const key = JSON.stringify([
          state.originalCwd,
          state.worktreePath,
          state.worktreeCwd,
        ]);
        // 历史产物只需要路径候选，重复进入同一 checkout 不保留重复状态。
        if (!artifactPaths.has(key)) {
          artifactPaths.add(key);
          worktreeStates.push(state);
        }
      }
    }
    return {
      filePath: index.filePath,
      sessionId,
      snapshot: index.snapshot,
      writerState:
        writerState ?? this.buildSessionWriterState(index, sessionId),
      runtimeTailUuid: session.messages.at(-1)?.uuid ?? null,
      worktreeStates,
    };
  }

  private buildSessionWriterState(
    index: TranscriptIndex,
    sessionId: string,
  ): SessionWriterStateSnapshot {
    const compatible = applyTranscriptCompatibility(index);
    const marker = index.metadata.activeLeaves.get(sessionId);
    const activeLeaf = resolvePersistedActiveLeaf(
      compatible,
      marker,
      sessionId,
    );
    const resolved = resolveTranscriptChain(compatible, activeLeaf);
    return this.writerStateFromChain(index, sessionId, resolved);
  }

  private writerStateFromChain(
    index: TranscriptIndex,
    sessionId: string,
    resolved: ResolvedTranscriptChain,
  ): SessionWriterStateSnapshot {
    const mainParentUuid = resolved.leafUuid ?? null;
    const metadata = index.metadata;
    const customTitle = metadata.customTitles.get(sessionId);
    const aiTitle = metadata.aiTitles.get(sessionId);
    const lastPrompt = metadata.lastPrompts.get(sessionId);
    const tag = metadata.tags.get(sessionId);
    const workspaceDirectories = metadata.workspaceDirectories.get(sessionId);
    const runtimeConfig = metadata.runtimeConfigs.get(sessionId);
    const mode = metadata.modes.get(sessionId);
    const contentReplacements = projectContentReplacements(
      index,
      resolved.messages,
    ).get(sessionId);
    return {
      messageUuids: [...index.messagesByUuid.keys()],
      mainParentUuid,
      ...(customTitle ? { customTitle } : {}),
      ...(aiTitle ? { aiTitle } : {}),
      ...(lastPrompt ? { lastPrompt } : {}),
      ...(tag ? { tag } : {}),
      ...(workspaceDirectories
        ? { workspaceDirectories: [...workspaceDirectories] }
        : {}),
      ...(runtimeConfig ? { runtimeConfig } : {}),
      ...(mode ? { mode } : {}),
      contentReplacements: [...(contentReplacements ?? [])],
    };
  }
}

function resolvePersistedActiveLeaf(
  graph: TranscriptGraphView,
  marker:
    | { readonly sessionId: string; readonly leafUuid: string | null }
    | undefined,
  expectedSessionId: string | undefined,
  leafPolicy?: LeafSelectionPolicy,
): string | null | undefined {
  if (!marker || marker.leafUuid === null) {
    return marker?.leafUuid;
  }

  const leafUuid = marker.leafUuid;
  const leaf = graph.messagesByUuid.get(leafUuid);
  if (!leaf) {
    logInvalidActiveLeaf(
      { sessionId: marker.sessionId, leafUuid },
      expectedSessionId,
      'missing',
    );
    return undefined;
  }
  if (expectedSessionId && leaf.sessionId !== expectedSessionId) {
    logInvalidActiveLeaf(
      { sessionId: marker.sessionId, leafUuid },
      expectedSessionId,
      'session-mismatch',
    );
    return undefined;
  }
  if (!isMessageInAgentScope(leaf, leafPolicy?.agentId)) {
    logInvalidActiveLeaf(
      { sessionId: marker.sessionId, leafUuid },
      expectedSessionId,
      'agent-mismatch',
    );
    return undefined;
  }
  return leafUuid;
}

function logInvalidActiveLeaf(
  marker: { readonly sessionId: string; readonly leafUuid: string },
  expectedSessionId: string | undefined,
  reason: 'missing' | 'session-mismatch' | 'agent-mismatch',
): void {
  runLogger.warn(
    'transcript.active_leaf.invalid',
    `session=${expectedSessionId ?? marker.sessionId}`,
    `leaf=${marker.leafUuid}`,
    `reason=${reason}`,
    'fallback=default-leaf',
  );
}

function assertLeafBelongsToSession(
  graph: TranscriptGraphView,
  leafUuid: string | null | undefined,
  sessionId: string | undefined,
): void {
  if (!leafUuid || !sessionId) {
    return;
  }
  const leaf = graph.messagesByUuid.get(leafUuid);
  if (leaf && leaf.sessionId !== sessionId) {
    throw new TranscriptConsistencyError(
      leafUuid,
      `Active transcript leaf ${leafUuid} does not belong to session ${sessionId}.`,
    );
  }
}
