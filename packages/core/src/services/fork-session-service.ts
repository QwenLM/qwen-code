/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import {
  beginResumeRead,
  type ResumeReadAttempt,
} from './transcript/resume-read-budget.js';
import * as path from 'node:path';
import type {
  SessionWriterStateSnapshot,
  TranscriptStore,
} from './transcript/store.js';
import type { SessionWriterForkSnapshot } from './transcript/session-writer.js';
import {
  countDisplayMessages,
  countUserMessages,
  getFirstUserMessage,
  getSessionWorkspaceDirectories,
  isSafeSessionFileStem,
  listTranscriptSessions,
  type TranscriptSessionInfo,
} from './transcriptSessionService.js';
import { getSessionTranscriptPath } from './transcript-paths.js';
import { SessionStateStore } from './session-state-store.js';
import {
  isTranscriptMessage,
  type ContentReplacementEntry,
  type CustomTitleEntry,
  type Entry,
  type ModeEntry,
  type RuntimeConfigEntry,
  type SessionMode,
  type TagEntry,
  type TranscriptMessage,
  type TranscriptWorktreeSession,
} from '../protocol/transcript/entry.js';
import {
  copyFileHistoryBackupFiles,
  deleteFileCheckpointSession,
  resolveFileCheckpointRoot,
  type FileHistorySnapshot,
} from '../file-history/file-history.js';
import type { Message } from '../protocol/transcript/message.js';
import { getDisplayablePromptText } from '../protocol/transcript/message-utils.js';
import { getErrorMessage } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import { isValidSessionIdUuid } from '../utils/sessionIdValidation.js';
import { assertResumeDropsTurn } from './resumeSessionAt.js';
import { projectTranscriptMessages } from './transcript/resume-projector.js';
import { selectHistoricalLineage } from './transcript/historical-lineage.js';
import {
  TranscriptRepository,
  type TranscriptResumeReadState,
} from './transcript/repository.js';

export class ForkSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkSessionError';
  }
}

export interface ForkSessionInput {
  /** 新 Fork 的 transcript 与 SessionState 归属根。 */
  projectRoot: string;
  /** 新 Fork 的运行目录；默认与 artifact 根相同。 */
  targetCwd?: string;
  sourceSessionId: string;
  /** Exact resolved source path for historical and cross-worktree forks. */
  sourceSessionPath?: string;
  /** Project root that owns sourceSessionPath. Defaults to projectRoot. */
  sourceProjectRoot?: string;
  sourceSessionInfo?: TranscriptSessionInfo;
  targetSessionId: string;
  /** Keep the source chain only through this entry UUID. */
  resumeSessionAt?: string;
  /** Refuse the truncation unless the discarded range belongs to this turn. */
  resumeDropsTurn?: string;
  targetTitle?: string;
  /** Effective worktree state for the new session; null means target cwd. */
  targetWorktreeSession?: TranscriptWorktreeSession | null;
  /**
   * Authoritative state owned by a currently running session.
   *
   * Interactive branching must not rediscover its own conversation through
   * the session catalog: the active writer may still have pending entries, and
   * macOS can deny a second open of a long-lived transcript even though the
   * process still owns the live conversation. Historical-session forks omit
   * this snapshot and continue to load the source transcript from disk.
   */
  runtimeSnapshot?: ForkSessionRuntimeSnapshot;
  /**
   * Fail the fork when any checkpoint backup blob cannot be copied. Defaults to
   * false: a missing source blob must not block branching; the copy reports it
   * and the fork keeps the snapshots it could migrate.
   */
  strictFileHistoryRestore?: boolean;
}

export interface ForkSessionRuntimeSnapshot extends SessionWriterForkSnapshot {
  directories?: readonly string[];
  fileHistorySnapshots?: readonly FileHistorySnapshot[];
}

export interface CaptureActiveForkSnapshotInput {
  projectRoot: string;
  sourceSessionId: string;
  /** 已解析的活动 Writer 路径，兼容历史会话的实际归属。 */
  sourceSessionPath?: string;
  messages: readonly Message[];
  directories?: readonly string[];
  fileHistorySnapshots?: readonly FileHistorySnapshot[];
  runtimeConfig?: Omit<RuntimeConfigEntry, 'type' | 'sessionId' | 'timestamp'>;
}

export interface ForkSessionResult {
  /** Exact newly written entries, including metadata, for initial mirroring. */
  entries: readonly Entry[];
  sessionId: string;
  sessionPath: string;
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
  runtimeConfig?: RuntimeConfigEntry;
  directories?: string[];
  sourceSessionInfo: TranscriptSessionInfo;
  worktreeSession: TranscriptWorktreeSession | null;
  forkedFrom: {
    sessionId: string;
    messageUuid: string;
  };
  /** Target transcript's freshly written writer state; lets resume skip re-reading it. */
  resumeState: TranscriptResumeReadState;
}

interface ForkSourceState {
  transcriptChain: TranscriptMessage[];
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
  runtimeConfig?: RuntimeConfigEntry;
  directories?: string[];
  contentReplacements: ReadonlyArray<
    ContentReplacementEntry['replacements'][number]
  >;
  mode?: SessionMode;
  tag?: string;
  sourceSessionInfo: TranscriptSessionInfo;
}

function buildForkWriterState(
  entries: readonly Entry[],
  mainParentUuid: string,
): SessionWriterStateSnapshot {
  const customTitle = entries.find(
    (entry): entry is CustomTitleEntry => entry.type === 'custom-title',
  );
  const tag = entries.find((entry): entry is TagEntry => entry.type === 'tag');
  const mode = entries.find(
    (entry): entry is ModeEntry => entry.type === 'mode',
  );
  const runtimeConfig = entries.find(
    (entry): entry is RuntimeConfigEntry => entry.type === 'runtime-config',
  );
  const contentReplacements = entries.find(
    (entry): entry is ContentReplacementEntry =>
      entry.type === 'content-replacement',
  );
  return {
    messageUuids: entries
      .filter((entry): entry is TranscriptMessage => isTranscriptMessage(entry))
      .map((entry) => entry.uuid),
    mainParentUuid,
    ...(customTitle ? { customTitle: customTitle.customTitle } : {}),
    ...(tag ? { tag: tag.tag } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(mode ? { mode: mode.mode } : {}),
    ...(contentReplacements
      ? { contentReplacements: contentReplacements.replacements }
      : {}),
  };
}

export class ForkSessionService {
  constructor(private readonly store: TranscriptStore) {}

  async captureActiveSessionSnapshot(
    input: CaptureActiveForkSnapshotInput,
  ): Promise<ForkSessionRuntimeSnapshot> {
    assertSafeSourceSessionId(input.sourceSessionId);
    const sourceSessionPath =
      input.sourceSessionPath ??
      getSessionTranscriptPath(input.projectRoot, input.sourceSessionId);
    const writer = await this.store.acquireExistingSessionWriter({
      filePath: sourceSessionPath,
      sessionId: input.sourceSessionId,
    });
    if (!writer) {
      throw new ForkSessionError(
        `Active transcript writer for session "${input.sourceSessionId}" is unavailable.`,
      );
    }

    let attempt: ResumeReadAttempt | undefined;
    try {
      // 先准入再进入追加顺序域，避免持锁等待另一恢复读取的 flush。
      attempt = await beginResumeRead();
      const snapshot = await writer.createForkSnapshot(input.messages);
      const historical = await writer.withTranscriptRead((filePath) =>
        new TranscriptRepository().readForResume(filePath, {
          sessionId: input.sourceSessionId,
          attempt: attempt!,
          view: 'historical',
        }),
      );
      if (!historical)
        throw new ForkSessionError(
          'Active transcript disappeared during fork.',
        );
      const runtimeConfig =
        snapshot.runtimeConfig ??
        (input.runtimeConfig
          ? {
              type: 'runtime-config' as const,
              ...input.runtimeConfig,
              sessionId: input.sourceSessionId,
              timestamp: Date.now(),
            }
          : undefined);
      return {
        ...snapshot,
        transcriptChain: [...historical.chain],
        ...(runtimeConfig ? { runtimeConfig } : {}),
        directories: snapshot.workspaceDirectories
          ? [...snapshot.workspaceDirectories]
          : input.directories
            ? [...input.directories]
            : undefined,
        fileHistorySnapshots: [...(input.fileHistorySnapshots ?? [])],
      };
    } finally {
      attempt?.finish();
      await writer.close();
    }
  }

  async createFork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const forkStartedAt = Date.now();
    const phase = async <T>(
      name: string,
      run: () => Promise<T>,
      details?: Record<string, unknown>,
    ): Promise<T> => {
      const startedAt = Date.now();
      runLogger.log('[fork]', {
        phase: name,
        event: 'started',
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        ...details,
      });
      try {
        const value = await run();
        runLogger.log('[fork]', {
          phase: name,
          event: 'finished',
          durationMs: Date.now() - startedAt,
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          ...details,
        });
        return value;
      } catch (error) {
        runLogger.log('[fork]', {
          phase: name,
          event: 'failed',
          durationMs: Date.now() - startedAt,
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          error: getErrorMessage(error),
          ...details,
        });
        throw error;
      }
    };
    const { sourceSessionPath, sourceProjectRoot } =
      resolveSourceLocation(input);
    const targetSessionPath = getSessionTranscriptPath(
      input.projectRoot,
      input.targetSessionId,
    );

    if (!isValidSessionIdUuid(input.targetSessionId)) {
      throw new ForkSessionError(
        `Target session "${input.targetSessionId}" must be a valid UUID.`,
      );
    }
    if (input.targetSessionId === input.sourceSessionId) {
      throw new ForkSessionError(
        `Target session "${input.targetSessionId}" must be different from the source session.`,
      );
    }
    const loadedSource = await phase('load_source', () =>
      input.runtimeSnapshot
        ? Promise.resolve(this.readRuntimeSnapshot(input))
        : this.readPersistedSource(input, sourceSessionPath, sourceProjectRoot),
    );
    const source = selectForkSourceAt(
      loadedSource,
      input.resumeSessionAt,
      input.resumeDropsTurn,
      input.sourceSessionId,
    );
    const transcriptChain = source.transcriptChain;
    if (transcriptChain.length === 0) {
      throw new ForkSessionError('No conversation to branch.');
    }

    const messages = source.messages;
    if (
      !messages.some(
        (message) => message.type === 'user' || message.type === 'assistant',
      )
    ) {
      throw new ForkSessionError('No conversation to branch.');
    }

    const forkedFrom = {
      sessionId: input.sourceSessionId,
      messageUuid: transcriptChain.at(-1)!.uuid,
    };
    const directories = source.directories;

    const buildEntriesStartedAt = Date.now();
    const { entries, fileHistorySnapshots } = this.buildForkEntries({
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      transcriptChain,
      fileHistorySnapshots: source.fileHistorySnapshots,
      contentReplacements: source.contentReplacements,
      runtimeConfig: source.runtimeConfig,
      mode: source.mode,
      tag: source.tag,
      title: input.targetTitle,
      targetCwd: input.targetCwd ?? input.projectRoot,
      targetWorktreeSession: input.targetWorktreeSession ?? null,
    });
    runLogger.log('[fork]', {
      phase: 'build_entries',
      event: 'finished',
      durationMs: Date.now() - buildEntriesStartedAt,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      entries: entries.length,
      snapshots: fileHistorySnapshots.length,
    });

    const targetStateStore = new SessionStateStore({
      projectRoot: input.projectRoot,
      sessionId: input.targetSessionId,
    });
    let transcriptCreated = false;
    let stateCreated = false;
    let fileHistoryAttempted = false;
    try {
      // Create the target transcript first: createExclusive is the ownership
      // gate, so a duplicate target id never reaches the checkpoint copy below
      // and cannot clobber the existing session's backups.
      await phase('write_transcript', () =>
        this.store.createForkTranscript(targetSessionPath, entries),
      );
      transcriptCreated = true;
      // Fork owns all checkpoint work: copy every referenced blob now, so
      // resuming the new session never writes or copies again.
      if (fileHistorySnapshots.length > 0) {
        fileHistoryAttempted = true;
        await phase(
          'copy_checkpoints',
          () =>
            copyFileHistoryBackupFiles({
              checkpointRoot: resolveFileCheckpointRoot(),
              sourceSessionId: input.sourceSessionId,
              targetSessionId: input.targetSessionId,
              snapshots: fileHistorySnapshots,
              strict: input.strictFileHistoryRestore === true,
            }),
          { snapshots: fileHistorySnapshots.length },
        );
      }
      await phase('create_state', () =>
        targetStateStore.createExclusive(directories),
      );
      stateCreated = true;
    } catch (error) {
      if (transcriptCreated || stateCreated || fileHistoryAttempted) {
        await this.rollbackForkArtifacts({
          projectRoot: input.projectRoot,
          sessionId: input.targetSessionId,
          sessionPath: targetSessionPath,
          originalError: error,
          deleteTranscript: transcriptCreated,
          deleteState: stateCreated,
          deleteFileHistory: fileHistoryAttempted,
        });
      }
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new ForkSessionError(
          `Target session "${input.targetSessionId}" already exists.`,
        );
      }
      throw error;
    }

    runLogger.log('[fork]', {
      phase: 'total',
      event: 'finished',
      durationMs: Date.now() - forkStartedAt,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      entries: entries.length,
      snapshots: fileHistorySnapshots.length,
    });
    const targetFileStat = await stat(targetSessionPath);
    const resumeState: TranscriptResumeReadState = {
      filePath: targetSessionPath,
      sessionId: input.targetSessionId,
      snapshot: {
        device: targetFileStat.dev,
        inode: targetFileStat.ino,
        size: targetFileStat.size,
        modifiedTimeMs: targetFileStat.mtimeMs,
        changedTimeMs: targetFileStat.ctimeMs,
      },
      writerState: buildForkWriterState(entries, forkedFrom.messageUuid),
      runtimeTailUuid: messages.at(-1)?.uuid ?? null,
      worktreeStates:
        input.targetWorktreeSession?.sessionId === input.targetSessionId
          ? [input.targetWorktreeSession]
          : [],
    };
    return {
      sessionId: input.targetSessionId,
      sessionPath: targetSessionPath,
      entries,
      messages,
      fileHistorySnapshots,
      runtimeConfig: source.runtimeConfig,
      directories,
      sourceSessionInfo: source.sourceSessionInfo,
      worktreeSession: input.targetWorktreeSession ?? null,
      forkedFrom,
      resumeState,
    };
  }

  async deleteForkArtifacts(input: {
    projectRoot: string;
    sessionId: string;
    sessionPath: string;
    originalError?: unknown;
  }): Promise<void> {
    const expectedPath = getSessionTranscriptPath(
      input.projectRoot,
      input.sessionId,
    );
    if (path.resolve(input.sessionPath) !== path.resolve(expectedPath)) {
      throw new ForkSessionError(
        `Fork transcript path does not belong to session "${input.sessionId}".`,
      );
    }
    await this.rollbackForkArtifacts({
      ...input,
      deleteFileHistory: true,
    });
  }

  private readRuntimeSnapshot(input: ForkSessionInput): ForkSourceState {
    const snapshot = input.runtimeSnapshot!;
    const transcriptChain = [...snapshot.transcriptChain];
    const sourceProjectRoot = input.sourceProjectRoot ?? input.projectRoot;
    const sourceSessionPath = getSessionTranscriptPath(
      sourceProjectRoot,
      input.sourceSessionId,
    );
    const directories = snapshot.directories
      ? [...snapshot.directories]
      : snapshot.workspaceDirectories
        ? [...snapshot.workspaceDirectories]
        : undefined;
    const sourceSessionInfo =
      input.sourceSessionInfo ??
      buildSourceSessionInfo({
        sessionId: input.sourceSessionId,
        sessionPath: sourceSessionPath,
        projectRoot: sourceProjectRoot,
        transcriptChain,
        directories,
        customTitle: snapshot.customTitle,
        aiTitle: snapshot.aiTitle,
        lastPrompt: snapshot.lastPrompt,
        isCurrentSession: true,
      });

    return {
      transcriptChain,
      messages: [...projectTranscriptMessages(transcriptChain, 'runtime')],
      fileHistorySnapshots: [...(snapshot.fileHistorySnapshots ?? [])],
      runtimeConfig: snapshot.runtimeConfig,
      directories,
      contentReplacements: (snapshot.contentReplacements ?? []).map(
        (replacement) => ({ ...replacement }),
      ),
      mode: snapshot.mode,
      tag: snapshot.tag,
      sourceSessionInfo,
    };
  }

  private async readPersistedSource(
    input: ForkSessionInput,
    sourceSessionPath: string,
    sourceProjectRoot: string,
  ): Promise<ForkSourceState> {
    // The transcript and the session state file are independent reads; the
    // state store only needs the source identity, so overlap the two.
    const [loadResult, stateDirectories] = await Promise.all([
      this.store
        .repository()
        .readForFork(sourceSessionPath, input.sourceSessionId),
      // Legacy transcript metadata remains a valid fallback when encrypted
      // session state is unavailable.
      getSessionWorkspaceDirectories(sourceProjectRoot, input.sourceSessionId),
    ]);
    if (!loadResult) {
      throw new ForkSessionError(
        `Source session "${input.sourceSessionId}" does not exist.`,
      );
    }

    const persistedDirectories = loadResult.metadata.workspaceDirectories.get(
      input.sourceSessionId,
    );
    const directories =
      stateDirectories ??
      (persistedDirectories ? [...persistedDirectories] : undefined);

    const sourceSessionInfo =
      input.sourceSessionInfo ??
      buildSourceSessionInfo({
        sessionId: input.sourceSessionId,
        sessionPath: sourceSessionPath,
        projectRoot: sourceProjectRoot,
        transcriptChain: [...loadResult.chain],
        directories,
        customTitle: loadResult.metadata.customTitles.get(
          input.sourceSessionId,
        ),
        aiTitle: loadResult.metadata.aiTitles.get(input.sourceSessionId),
        lastPrompt: loadResult.metadata.lastPrompts.get(input.sourceSessionId),
        isCurrentSession: false,
      });

    return {
      transcriptChain: [...loadResult.chain],
      messages: [...projectTranscriptMessages(loadResult.chain, 'runtime')],
      fileHistorySnapshots: [...loadResult.fileHistorySnapshots],
      runtimeConfig: loadResult.metadata.runtimeConfigs.get(
        input.sourceSessionId,
      ),
      directories,
      contentReplacements:
        loadResult.contentReplacements.get(input.sourceSessionId) ?? [],
      mode: loadResult.metadata.modes.get(input.sourceSessionId),
      tag: loadResult.metadata.tags.get(input.sourceSessionId),
      sourceSessionInfo,
    };
  }

  async generateUniqueBranchTitle(
    projectRoot: string,
    baseTitle: string,
    options: { excludeSessionIds?: readonly string[] } = {},
  ): Promise<string> {
    const sessions = await listTranscriptSessions(projectRoot, undefined, {
      excludeSessionIds: options.excludeSessionIds,
      lightweight: true,
    });
    const candidate = `${baseTitle} (Branch)`;
    if (!sessions.some((session) => session.displayName === candidate)) {
      return candidate;
    }

    const usedNumbers = new Set<number>([1]);
    const pattern = new RegExp(
      `^${escapeRegExp(baseTitle)} \\(Branch(?: (\\d+))?\\)$`,
    );

    for (const session of sessions) {
      const match = session.displayName.match(pattern);
      if (!match) {
        continue;
      }
      usedNumbers.add(match[1] ? Number.parseInt(match[1], 10) : 1);
    }

    let nextNumber = 2;
    while (usedNumbers.has(nextNumber)) {
      nextNumber += 1;
    }

    return `${baseTitle} (Branch ${nextNumber})`;
  }

  private buildForkEntries(input: {
    sourceSessionId: string;
    targetSessionId: string;
    transcriptChain: TranscriptMessage[];
    fileHistorySnapshots: readonly FileHistorySnapshot[];
    contentReplacements: ReadonlyArray<
      ContentReplacementEntry['replacements'][number]
    >;
    runtimeConfig?: RuntimeConfigEntry;
    mode?: SessionMode;
    tag?: string;
    title?: string;
    targetCwd: string;
    targetWorktreeSession: TranscriptWorktreeSession | null;
  }): { entries: Entry[]; fileHistorySnapshots: FileHistorySnapshot[] } {
    const entries: Entry[] = input.transcriptChain.map((entry) => {
      const commonForkFields = {
        sessionId: input.targetSessionId,
        isSidechain: false,
        forkedFrom: {
          sessionId: input.sourceSessionId,
          messageUuid: entry.uuid,
        },
      };
      const forkedEntry: TranscriptMessage = {
        ...entry,
        ...commonForkFields,
      };
      return forkedEntry;
    });

    // 快照随 fork transcript 一次性落盘，resume 不再逐条补写（每条会撞上
    // AppendChannel 的批量刷盘窗口）。截断点之后的快照没有对应 messageId，丢弃。
    const liveMessageIds = new Set(
      input.transcriptChain.map((entry) => entry.uuid),
    );
    const fileHistorySnapshots = input.fileHistorySnapshots.filter((snapshot) =>
      liveMessageIds.has(snapshot.messageId),
    );
    for (const snapshot of fileHistorySnapshots) {
      entries.push({
        type: 'file-history-snapshot',
        messageId: snapshot.messageId,
        snapshot,
        isSnapshotUpdate: false,
      });
    }

    entries.push(
      {
        type: 'relocated',
        sessionId: input.targetSessionId,
        relocatedCwd: input.targetCwd,
      },
      {
        type: 'worktree-state',
        sessionId: input.targetSessionId,
        worktreeSession: input.targetWorktreeSession,
      },
    );

    if (input.mode) {
      entries.push({
        type: 'mode',
        sessionId: input.targetSessionId,
        mode: input.mode,
      });
    }

    if (input.tag) {
      entries.push({
        type: 'tag',
        sessionId: input.targetSessionId,
        tag: input.tag,
      });
    }

    if (input.runtimeConfig) {
      entries.push({
        ...input.runtimeConfig,
        sessionId: input.targetSessionId,
        timestamp: Date.now(),
      });
    }

    if (input.title?.trim()) {
      entries.push({
        type: 'custom-title',
        sessionId: input.targetSessionId,
        customTitle: input.title.trim(),
      });
    }

    if (input.contentReplacements.length > 0) {
      entries.push({
        type: 'content-replacement',
        sessionId: input.targetSessionId,
        replacements: input.contentReplacements.map((replacement) => ({
          ...replacement,
        })),
      });
    }

    // The fork copies message records, not the source's active-leaf commits.
    // Commit the latest ordinary Compact boundary in the target session so a
    // fresh bounded resume can safely discard its pre-Compact history.
    const latestCompactBoundary = input.transcriptChain.findLast(
      (entry) =>
        entry.type === 'system' &&
        entry.subtype === 'compact_boundary' &&
        !entry.compactMetadata?.preservedSegment,
    );
    entries.push({
      type: 'active-leaf',
      sessionId: input.targetSessionId,
      ...(latestCompactBoundary
        ? { compactBoundaryUuid: latestCompactBoundary.uuid }
        : {}),
      leafUuid: input.transcriptChain.at(-1)!.uuid,
      explicit: false,
      timestamp: Date.now(),
    });

    return { entries, fileHistorySnapshots };
  }

  private async rollbackForkArtifacts(input: {
    projectRoot: string;
    sessionId: string;
    sessionPath: string;
    originalError?: unknown;
    deleteTranscript?: boolean;
    deleteState?: boolean;
    deleteFileHistory?: boolean;
  }): Promise<void> {
    const operations: Array<Promise<void>> = [];
    if (input.deleteTranscript !== false) {
      operations.push(this.store.deleteTranscript(input.sessionPath));
    }
    if (input.deleteState !== false) {
      operations.push(
        new SessionStateStore({
          projectRoot: input.projectRoot,
          sessionId: input.sessionId,
        }).delete(),
      );
    }
    if (input.deleteFileHistory === true) {
      operations.push(
        deleteFileCheckpointSession(
          resolveFileCheckpointRoot(),
          input.sessionId,
        ),
      );
    }
    const results = await Promise.allSettled(operations);
    const cleanupErrors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        cleanupErrors.push(result.reason as unknown);
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupDetails = cleanupErrors.map(getErrorMessage).join('; ');
      throw new AggregateError(
        input.originalError
          ? [input.originalError, ...cleanupErrors]
          : cleanupErrors,
        input.originalError
          ? `Failed to remove incomplete fork session "${input.sessionId}" after "${getErrorMessage(input.originalError)}": ${cleanupDetails}`
          : `Failed to remove incomplete fork session "${input.sessionId}": ${cleanupDetails}`,
      );
    }
  }
}

function selectForkSourceAt(
  source: ForkSourceState,
  resumeSessionAt: string | undefined,
  resumeDropsTurn: string | undefined,
  sourceSessionId: string,
): ForkSourceState {
  if (!resumeSessionAt) {
    return source;
  }
  const selection = selectHistoricalLineage(
    source.transcriptChain,
    resumeSessionAt,
    'through-target',
  );
  if (!selection) {
    throw new ForkSessionError(
      `Resume point "${resumeSessionAt}" was not found in session "${sourceSessionId}".`,
    );
  }

  assertResumeDropsTurn(selection.discardedChain, resumeDropsTurn);
  const transcriptChain = [...selection.retainedChain];
  const liveMessageIds = new Set(transcriptChain.map((entry) => entry.uuid));
  return {
    ...source,
    transcriptChain,
    messages: [...selection.runtimeMessages],
    fileHistorySnapshots: [...source.fileHistorySnapshots],
    contentReplacements: source.contentReplacements.filter((replacement) =>
      liveMessageIds.has(replacement.messageUuid),
    ),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveSourceLocation(input: ForkSessionInput): {
  sourceSessionPath: string;
  sourceProjectRoot: string;
} {
  assertSafeSourceSessionId(input.sourceSessionId);
  const sourceProjectRoot = input.sourceProjectRoot ?? input.projectRoot;
  const expectedPath = getSessionTranscriptPath(
    sourceProjectRoot,
    input.sourceSessionId,
  );
  const sourceSessionPath = input.sourceSessionPath ?? expectedPath;
  if (path.resolve(sourceSessionPath) !== path.resolve(expectedPath)) {
    throw new ForkSessionError(
      `Source transcript path does not belong to session "${input.sourceSessionId}".`,
    );
  }
  return { sourceSessionPath, sourceProjectRoot };
}

function assertSafeSourceSessionId(sessionId: string): void {
  if (!isSafeSessionFileStem(sessionId)) {
    throw new ForkSessionError(`Source session "${sessionId}" is invalid.`);
  }
}

function buildSourceSessionInfo(input: {
  sessionId: string;
  sessionPath: string;
  projectRoot: string;
  transcriptChain: readonly TranscriptMessage[];
  directories?: readonly string[];
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  isCurrentSession: boolean;
}): TranscriptSessionInfo {
  const messages = input.transcriptChain;
  const firstUserMessage = getFirstUserMessage(messages);
  const displayableLastPrompt = getDisplayablePromptText(input.lastPrompt);
  const displayName =
    input.customTitle ??
    input.aiTitle ??
    displayableLastPrompt ??
    firstUserMessage;
  const now = new Date().toISOString();
  return {
    id: input.sessionId,
    file: input.sessionId,
    fileName: path.basename(input.sessionPath),
    sessionPath: input.sessionPath,
    startTime: messages[0]?.timestamp ?? now,
    lastUpdated: messages.at(-1)?.timestamp ?? now,
    messageCount: countDisplayMessages(messages),
    userMessageCount: countUserMessages(messages),
    displayName,
    firstUserMessage,
    isCurrentSession: input.isCurrentSession,
    index: 0,
    ...(input.customTitle ? { customTitle: input.customTitle } : {}),
    ...(input.aiTitle ? { aiTitle: input.aiTitle } : {}),
    ...(displayableLastPrompt ? { lastPrompt: displayableLastPrompt } : {}),
    ...(input.directories ? { directories: [...input.directories] } : {}),
    transcriptProjectRoot: input.projectRoot,
    transcriptProjectDir: path.dirname(input.sessionPath),
  };
}
