/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ActiveLeafEntry,
  AiTitleEntry,
  ContentReplacementEntry,
  CustomTitleEntry,
  Entry,
  FileHistorySnapshotEntry,
  LastPromptEntry,
  RuntimeConfigEntry,
  SessionMode,
  SummaryMessage,
  TagEntry,
  TokenStatsEntry,
  TranscriptWorktreeSession,
  TranscriptMessage,
  WorktreeStateEntry,
  WorkspaceDirectoriesEntry,
} from '../../protocol/transcript/entry.js';
import type {
  Message,
  UserMessage,
} from '../../protocol/transcript/message.js';
import {
  getRealUserPromptText,
  isTaskLifecycleSubtype,
} from '../../protocol/transcript/message-utils.js';
import { shouldExposeTokenUsage } from '../../protocol/token-usage-visibility.js';
import { CUSTOM_PROVIDER_SOURCE } from '../../provider/custom/types.js';
import { cloneUsageForSdkOutput } from '../../engine/headless-projection.js';
import { projectFileToolResultForExternalUse } from '../../tools/file-tool-result-projection.js';
import {
  selectMcpResultMeta,
  selectToolResultSideChannel,
} from '../../protocol/transcript/tool-result-side-channel.js';
import { runLogger } from '../../utils/runLogger.js';
import { emitSessionPhaseFinished } from '../../utils/diagnosticInterceptors.js';
import { CODE_MODE_RESULT_TYPE } from '../../codemode/types.js';
import { isRecord } from '../../utils/markdownUtils.js';
import { countResumeEntryItems } from './resume-read-budget.js';
import type { AppendChannelLease } from './append-coordinator.js';

export interface SessionTranscriptWriterOptions {
  channel: AppendChannelLease;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  userType?: string;
  version?: string;
  gitBranch?: string;
}

export interface RelocateSessionTranscriptOptions {
  readonly filePath: string;
  readonly cwd: string;
  readonly gitBranch?: string;
  readonly worktreeSession: TranscriptWorktreeSession | null;
}

export type PrepareTranscriptRelocation = (
  sourceFilePath: string,
  targetFilePath: string,
  sourceFileMayBeMissing: boolean,
) => Promise<AppendChannelLease>;

export interface RecordActiveLeafOptions {
  explicit: boolean;
  rewound?: boolean;
  durable?: boolean;
}

export interface SessionWriterMetadataSnapshot {
  readonly customTitle?: string;
  readonly aiTitle?: string;
  readonly lastPrompt?: string;
  readonly tag?: string;
  readonly workspaceDirectories?: readonly string[];
  readonly runtimeConfig?: RuntimeConfigEntry;
  readonly mode?: SessionMode;
  readonly contentReplacements?: ReadonlyArray<
    ContentReplacementEntry['replacements'][number]
  >;
}

export interface SessionWriterForkSnapshot
  extends SessionWriterMetadataSnapshot {
  readonly transcriptChain: readonly TranscriptMessage[];
}

export interface TranscriptMessageProjectionOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly entrypoint: string;
  readonly userType?: string;
  readonly version?: string;
  readonly gitBranch?: string;
  readonly isSidechain?: boolean;
  readonly agentId?: string;
  readonly startingParentUuid?: string | null;
  readonly preserveTimestamps?: boolean;
}

export interface TranscriptMessageProjection {
  readonly messages: TranscriptMessage[];
  readonly lastChainUuid: string | null;
  readonly latestCompactBoundaryUuid?: string;
}

interface PendingAssistantFragments {
  messages: Message[];
  startingParentUuid: string | null;
}

const TRANSIENT_TASK_SYSTEM_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_notification',
  'permission_mode_transient',
]);

/**
 * Transcript writer for persisted session history.
 *
 * The writer accepts runtime `Message[]`, filters them to loggable transcript
 * entries, deduplicates already-written prefixes, then appends JSONL entries
 * with parent-chain metadata.
 */
export class SessionTranscriptWriter {
  private filePath: string;
  private channel: AppendChannelLease;
  private readonly sessionId: string;
  private cwd: string;
  private readonly homeCwd: string;
  private readonly entrypoint: string;
  private readonly userType: string;
  private readonly version: string;
  private gitBranch?: string;
  private readonly homeGitBranch?: string;
  private currentSessionLastPrompt?: string;
  private currentSessionTitle?: string;
  private currentSessionAiTitle?: string;
  private currentSessionTag?: string;
  private currentWorkspaceDirectories?: string[];
  private currentRuntimeConfig?: RuntimeConfigEntry;
  private currentSessionMode?: SessionMode;
  private currentContentReplacements: Array<
    ContentReplacementEntry['replacements'][number]
  > = [];
  private currentSessionActiveLeaf?: ActiveLeafEntry;

  private readonly messageSet = new Set<string>();
  private pendingEntriesBeforeMaterialization: Entry[] = [];
  private operationChain: Promise<void> = Promise.resolve();
  private hasMaterializedTranscript = false;
  private metadataTailDirty = false;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | undefined;
  private readonly pendingAssistantFragments = new Map<
    string,
    PendingAssistantFragments
  >();
  private readonly parentCursorByScope = new Map<string, string | null>();

  constructor(options: SessionTranscriptWriterOptions) {
    this.channel = options.channel;
    this.filePath = options.channel.filePath;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.homeCwd = options.cwd;
    this.entrypoint = options.entrypoint;
    this.userType = options.userType ?? 'external';
    this.version = options.version ?? 'unknown';
    this.gitBranch = options.gitBranch;
    this.homeGitBranch = options.gitBranch;
    runLogger.log(
      'transcript.writer.initialized',
      `session=${this.sessionId}`,
      `path=${this.filePath}`,
      `cwd=${this.cwd}`,
      `version=${this.version}`,
    );
    emitSessionPhaseFinished({
      sessionId: this.sessionId,
      phase: 'transcript.writer.initialized',
      success: true,
      data: {
        path: this.filePath,
        cwd: this.cwd,
        entrypoint: this.entrypoint,
        user_type: this.userType,
        version: this.version,
      },
    });
  }

  getSessionFilePath(): string {
    return this.filePath;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Move the active transcript to another project bucket and switch the
   * context stamped on every subsequently persisted message.
   *
   * The operation is serialized with message writes. The caller prepares the
   * target channel and moves the file without overwriting an existing session.
   */
  relocate(
    options: RelocateSessionTranscriptOptions,
    prepareTarget: PrepareTranscriptRelocation,
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      await this.channel.flush();
      await this.appendCachedMetadataEntriesToTail();
      await this.channel.flush();

      const sourceFilePath = this.filePath;
      let targetChannel: AppendChannelLease | undefined;
      if (sourceFilePath !== options.filePath) {
        targetChannel = await prepareTarget(
          sourceFilePath,
          options.filePath,
          !this.hasMaterializedTranscript,
        );
        await this.channel.release();
        this.channel = targetChannel;
        this.filePath = targetChannel.filePath;
      }

      this.cwd = options.cwd;
      this.gitBranch = options.gitBranch;
      // A host may relocate immediately after writer creation, before the
      // first user/assistant message materializes buffered startup metadata.
      // Flush that buffer into the target bucket before recording the move.
      await this.materializeTranscript();
      await this.appendEntriesImmediately([
        {
          type: 'relocated',
          sessionId: this.sessionId,
          relocatedCwd: options.cwd,
        },
        {
          type: 'worktree-state',
          sessionId: this.sessionId,
          worktreeSession: options.worktreeSession,
        },
      ]);
      this.metadataTailDirty = true;
      runLogger.log(
        'transcript.writer.relocated',
        `session=${this.sessionId}`,
        `from=${sourceFilePath}`,
        `to=${this.filePath}`,
        `cwd=${this.cwd}`,
      );
    });
  }

  /** Worktree 切换状态在返回前落盘；尚未物化的普通空会话只缓冲初始 null。 */
  recordWorktreeState(
    worktreeSession: TranscriptWorktreeSession | null,
    discardLegacyFileHistorySnapshots = false,
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      const entry: WorktreeStateEntry = {
        type: 'worktree-state',
        sessionId: this.sessionId,
        worktreeSession,
        ...(discardLegacyFileHistorySnapshots
          ? { discardLegacyFileHistorySnapshots: true as const }
          : {}),
      };
      if (
        worktreeSession ||
        discardLegacyFileHistorySnapshots ||
        this.hasMaterializedTranscript
      ) {
        await this.materializeTranscript();
        await this.appendEntriesImmediately([entry]);
      } else {
        await this.writeOrBuffer([entry]);
      }
      this.synchronizeWorktreeRuntimeState(worktreeSession);
    });
  }

  /** 运行目录投影与落盘分离，失败补偿期间的消息仍使用实际执行上下文。 */
  synchronizeWorktreeRuntimeState(
    state: TranscriptWorktreeSession | null,
  ): void {
    this.assertOpen();
    this.cwd = state?.pendingExit
      ? state.originalCwd
      : (state?.worktreeCwd ?? state?.worktreePath ?? this.homeCwd);
    this.gitBranch = state?.pendingExit
      ? (state.originalBranch ?? this.homeGitBranch)
      : state
        ? state.worktreeBranch
        : this.homeGitBranch;
    this.metadataTailDirty = true;
  }

  hasMessageUuid(messageUuid: string): boolean {
    this.assertOpen();
    return this.messageSet.has(messageUuid);
  }

  initializeExistingTranscript(
    messageUuids: Iterable<string> = [],
    mainParentUuid?: string | null,
  ): void {
    this.assertOpen();
    let adoptedMessages = 0;
    for (const messageUuid of messageUuids) {
      this.messageSet.add(messageUuid);
      adoptedMessages++;
    }
    if (mainParentUuid !== undefined) {
      this.parentCursorByScope.set(
        getTranscriptScopeKey(false),
        mainParentUuid,
      );
    }
    this.hasMaterializedTranscript = true;
    runLogger.log(
      'transcript.writer.adopted_existing',
      `session=${this.sessionId}`,
      `messages=${adoptedMessages}`,
      `path=${this.filePath}`,
    );
  }

  /**
   * Aligns the in-memory main-chain cursor with a runtime projection selected
   * by the caller. This does not append metadata; the next normal write will
   * persist the resulting active leaf through the regular writer pipeline.
   */
  adoptMainParentUuid(parentUuid: string | null): void {
    this.assertOpen();
    this.parentCursorByScope.set(getTranscriptScopeKey(false), parentUuid);
  }

  primeWorkspaceDirectories(directories: readonly string[]): void {
    this.assertOpen();
    this.currentWorkspaceDirectories = [...directories];
  }

  hydrateSessionMetadata(snapshot: SessionWriterMetadataSnapshot): void {
    this.assertOpen();
    this.currentSessionTitle = snapshot.customTitle || undefined;
    this.currentSessionAiTitle = snapshot.aiTitle || undefined;
    this.currentSessionLastPrompt = snapshot.lastPrompt || undefined;
    this.currentSessionTag = snapshot.tag || undefined;
    this.currentWorkspaceDirectories = snapshot.workspaceDirectories
      ? [...snapshot.workspaceDirectories]
      : undefined;
    this.currentRuntimeConfig = snapshot.runtimeConfig
      ? { ...snapshot.runtimeConfig }
      : undefined;
    this.currentSessionMode = snapshot.mode;
    this.currentContentReplacements = (snapshot.contentReplacements ?? []).map(
      (replacement) => ({ ...replacement }),
    );
  }

  createForkSnapshot(
    messages: readonly Message[],
  ): Promise<SessionWriterForkSnapshot> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      const projection = projectMessagesForTranscript(messages, {
        sessionId: this.sessionId,
        cwd: this.cwd,
        entrypoint: this.entrypoint,
        userType: this.userType,
        version: this.version,
        ...(this.gitBranch ? { gitBranch: this.gitBranch } : {}),
        preserveTimestamps: true,
      });
      return {
        transcriptChain: projection.messages,
        ...(this.currentSessionTitle
          ? { customTitle: this.currentSessionTitle }
          : {}),
        ...(this.currentSessionAiTitle
          ? { aiTitle: this.currentSessionAiTitle }
          : {}),
        ...(this.currentSessionLastPrompt
          ? { lastPrompt: this.currentSessionLastPrompt }
          : {}),
        ...(this.currentSessionTag ? { tag: this.currentSessionTag } : {}),
        ...(this.currentWorkspaceDirectories
          ? { workspaceDirectories: [...this.currentWorkspaceDirectories] }
          : {}),
        ...(this.currentRuntimeConfig
          ? { runtimeConfig: { ...this.currentRuntimeConfig } }
          : {}),
        ...(this.currentSessionMode ? { mode: this.currentSessionMode } : {}),
        contentReplacements: this.currentContentReplacements.map(
          (replacement) => ({ ...replacement }),
        ),
      };
    });
  }

  /** 调用方须先取得读取名额；回调不可重新排入此 Writer/Channel。 */
  withTranscriptRead<T>(read: (filePath: string) => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.enqueueOperation(() =>
      this.channel.withExclusiveRead(() => read(this.channel.filePath)),
    );
  }

  /** Reads committed transcript bytes through the writer's append order domain. */
  readTranscriptSnapshot(): Promise<Buffer> {
    this.assertOpen();
    return this.enqueueOperation(() => this.channel.readAll());
  }

  /**
   * Serializes this batch with other writer operations. AppendChannel rolls
   * back failed appends before allowing storage-exhaustion retries. Metadata
   * tail writes may fail after messages commit; retry deduplicates their UUIDs.
   */
  async recordMessages(
    messages: readonly Message[],
    startingParentUuidHint?: string | null,
    options: {
      /**
       * 立即落盘（append + barrier），不等 100ms 批量定时器。仅用于「写盘位于
       * 用户可见延迟链路前方」的调用点（如会话提交的用户消息），其余路径保持批量，
       * 避免工具密集轮次写放大。
       */
      immediate?: boolean;
    } = {},
  ): Promise<string | null> {
    this.assertOpen();
    return this.recordTranscriptInternal(messages, {
      startingParentUuidHint,
      immediate: options.immediate,
    });
  }

  async recordSidechainMessages(
    messages: readonly Message[],
    agentId?: string,
    startingParentUuidHint?: string | null,
  ): Promise<string | null> {
    this.assertOpen();
    return this.recordTranscriptInternal(messages, {
      isSidechain: true,
      agentId,
      startingParentUuidHint,
    });
  }

  private async recordTranscriptInternal(
    messages: readonly Message[],
    options: {
      isSidechain?: boolean;
      agentId?: string;
      startingParentUuidHint?: string | null;
      immediate?: boolean;
    } = {},
  ): Promise<string | null> {
    return this.enqueueOperation(async () => {
      const scopeKey = getTranscriptScopeKey(
        options.isSidechain ?? false,
        options.agentId,
      );
      this.applyTombstonesToPendingFragments(messages, scopeKey);
      const cleaned = cleanMessagesForLogging(messages);

      let startingParentUuid =
        options.startingParentUuidHint !== undefined
          ? options.startingParentUuidHint
          : (this.parentCursorByScope.get(scopeKey) ?? null);
      let seenNewMessage = false;
      let newMessages: Message[] = [];

      for (const message of cleaned) {
        if (
          !seenNewMessage &&
          this.messageSet.has(message.uuid) &&
          isChainParticipant(message)
        ) {
          // A replayed prefix only deduplicates messages; it must not select
          // an older branch and detach messages written after that prefix.
          continue;
        } else {
          seenNewMessage = true;
          newMessages.push(message);
        }
      }

      const previousFragments = this.pendingAssistantFragments.get(scopeKey);
      const staged = this.stageAssistantFragmentsForInsert(
        newMessages,
        scopeKey,
        startingParentUuid,
      );
      newMessages = staged.messages;
      startingParentUuid = staged.startingParentUuid;

      if (newMessages.length === 0) {
        if (!seenNewMessage && cleaned.length > 0) {
          await this.appendCachedMetadataEntriesToTail();
        }
        this.parentCursorByScope.set(scopeKey, startingParentUuid);
        return startingParentUuid;
      }

      try {
        return await this.insertMessageChain(
          newMessages,
          options.isSidechain ?? false,
          options.agentId,
          startingParentUuid,
          options.immediate === true,
        );
      } catch (error) {
        // Staging a terminal assistant consumes earlier streaming fragments.
        // Keep them available when the append failed before committing them.
        if (
          !newMessages.every((message) => this.messageSet.has(message.uuid))
        ) {
          if (previousFragments) {
            this.pendingAssistantFragments.set(scopeKey, previousFragments);
          } else {
            this.pendingAssistantFragments.delete(scopeKey);
          }
        }
        throw error;
      }
    });
  }

  private applyTombstonesToPendingFragments(
    messages: readonly Message[],
    scopeKey: string,
  ): void {
    const pending = this.pendingAssistantFragments.get(scopeKey);
    if (!pending) {
      return;
    }

    const tombstonedUuids = new Set(
      messages
        .map(extractTombstoneTargetUuid)
        .filter((uuid): uuid is string => typeof uuid === 'string'),
    );
    if (tombstonedUuids.size === 0) {
      return;
    }

    const remaining = pending.messages.filter(
      (message) => !tombstonedUuids.has(message.uuid),
    );
    if (remaining.length === 0) {
      this.pendingAssistantFragments.delete(scopeKey);
      return;
    }

    this.pendingAssistantFragments.set(scopeKey, {
      ...pending,
      messages: remaining,
    });
  }

  private stageAssistantFragmentsForInsert(
    messages: readonly Message[],
    scopeKey: string,
    startingParentUuid: string | null,
  ): { messages: Message[]; startingParentUuid: string | null } {
    let staged = [...messages];
    const pending = this.pendingAssistantFragments.get(scopeKey);
    let pendingRun: Message[] = [];
    let pendingRunStartingParentUuid = startingParentUuid;
    let effectiveStartingParentUuid = startingParentUuid;
    let currentParentUuid = startingParentUuid;

    if (pending) {
      staged = stripLeadingPendingFragments(staged, pending.messages);
      pendingRun = [...pending.messages];
      pendingRunStartingParentUuid = pending.startingParentUuid;
      effectiveStartingParentUuid = pending.startingParentUuid;
      currentParentUuid = pending.startingParentUuid;
      this.pendingAssistantFragments.delete(scopeKey);
    }

    const output: Message[] = [];
    const appendOutput = (message: Message): void => {
      output.push(message);
      if (isChainParticipant(message)) {
        currentParentUuid = message.uuid;
      }
    };

    for (const message of staged) {
      if (isPendingAssistantFragment(message)) {
        if (pendingRun.length === 0) {
          pendingRunStartingParentUuid = currentParentUuid;
        }
        pendingRun.push(message);
        continue;
      }

      if (pendingRun.length > 0) {
        if (message.type === 'assistant') {
          for (const pendingMessage of pendingRun) {
            appendOutput(pendingMessage);
          }
        }
        pendingRun = [];
      }

      appendOutput(message);
    }

    if (pendingRun.length > 0) {
      this.pendingAssistantFragments.set(scopeKey, {
        messages: pendingRun,
        startingParentUuid: pendingRunStartingParentUuid,
      });
    }

    return {
      messages: output,
      startingParentUuid: effectiveStartingParentUuid,
    };
  }

  flush(): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      await this.materializeTranscript();
      await this.channel.flush();
      await this.appendCachedMetadataEntriesToTail();
      await this.channel.flush();
    });
  }

  async close(): Promise<void> {
    if (this.lifecycle === 'closed') {
      return;
    }
    if (this.lifecycle === 'closing') {
      return this.closePromise;
    }
    this.lifecycle = 'closing';
    this.closePromise = this.enqueueOperation(async () => {
      // Release the lease even if the final flush failed, and settle on
      // 'closed' either way so a failed close cannot wedge the writer in
      // 'closing'. The first error wins — a flush failure describes the
      // underlying problem better than the release that follows it.
      let failure: unknown;
      try {
        // Closing an unmaterialized writer must not create a metadata-only
        // transcript. SDK startup can initialize and then release a session
        // before the first user message; persisting the buffered initial
        // worktree state here would make the same session id unavailable to
        // the real query that follows. Durable worktree transitions already
        // materialize eagerly, while initial metadata is flushed together
        // with the first real message.
        await this.channel.flush();
        await this.appendCachedMetadataEntriesToTail();
        await this.channel.flush();
      } catch (error) {
        failure = error;
      }
      try {
        await this.channel.release();
      } catch (error) {
        failure ??= error;
      } finally {
        this.lifecycle = 'closed';
      }
      if (failure !== undefined) {
        throw failure;
      }
    });
    return this.closePromise;
  }

  recordLastPrompt(lastPrompt: string): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      this.currentSessionLastPrompt = lastPrompt;
      await this.appendMetadataEntry({
        type: 'last-prompt',
        sessionId: this.sessionId,
        lastPrompt,
      });
    });
  }

  recordCustomTitle(customTitle: string): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      this.currentSessionTitle = customTitle;
      await this.appendMetadataEntry({
        type: 'custom-title',
        sessionId: this.sessionId,
        customTitle,
      });
    });
  }

  recordAiTitle(aiTitle: string): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      this.currentSessionAiTitle = aiTitle;
      await this.appendNonCachedEntry({
        type: 'ai-title',
        sessionId: this.sessionId,
        aiTitle,
      });
    });
  }

  recordSummary(leafUuid: string, summary: string): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      await this.appendNonCachedEntry({
        type: 'summary',
        leafUuid,
        summary,
      });
    });
  }

  recordTag(tag: string | null): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      this.currentSessionTag = tag ?? undefined;
      await this.appendMetadataEntry({
        type: 'tag',
        sessionId: this.sessionId,
        tag: tag ?? '',
      });
    });
  }

  recordWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      this.currentWorkspaceDirectories = [...directories];
      await this.appendMetadataEntry({
        type: 'workspace-directories',
        sessionId: this.sessionId,
        directories: [...directories],
      });
    });
  }

  recordRuntimeConfig(
    config: Omit<RuntimeConfigEntry, 'type' | 'sessionId' | 'timestamp'>,
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      const entry: RuntimeConfigEntry = {
        type: 'runtime-config',
        sessionId: this.sessionId,
        ...config,
        timestamp: Date.now(),
      };
      this.currentRuntimeConfig = entry;
      await this.appendMetadataEntry(entry);
    });
  }

  /**
   * Persist the latest prompt token count so session resume can restore the
   * context window progress bar without waiting for a new API call.
   */
  recordTokenStats(promptTokenCount: number): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      const entry: TokenStatsEntry = {
        type: 'token-stats',
        sessionId: this.sessionId,
        promptTokenCount,
        timestamp: Date.now(),
      };
      await this.appendNonCachedEntry(entry);
    });
  }

  recordFileHistorySnapshot(
    entry: Omit<FileHistorySnapshotEntry, 'type'>,
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      await this.appendNonCachedEntry({
        type: 'file-history-snapshot',
        messageId: entry.messageId,
        snapshot: entry.snapshot,
        isSnapshotUpdate: entry.isSnapshotUpdate,
      });
    });
  }

  recordContentReplacement(
    replacements: ContentReplacementEntry['replacements'],
    agentId?: string,
  ): Promise<void> {
    this.assertOpen();
    if (replacements.length === 0) {
      return Promise.resolve();
    }
    return this.enqueueOperation(async () => {
      await this.appendNonCachedEntry({
        type: 'content-replacement',
        sessionId: this.sessionId,
        ...(agentId ? { agentId } : {}),
        replacements,
      });
      this.currentContentReplacements.push(
        ...replacements.map((replacement) => ({ ...replacement })),
      );
    });
  }

  recordActiveLeaf(
    leafUuid: string | null,
    options: RecordActiveLeafOptions,
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      const entry: ActiveLeafEntry = {
        type: 'active-leaf',
        sessionId: this.sessionId,
        leafUuid,
        explicit: options.explicit,
        ...(options.rewound !== undefined ? { rewound: options.rewound } : {}),
        timestamp: Date.now(),
      };
      if (options.durable) {
        await this.appendEntriesImmediately([entry]);
        this.hasMaterializedTranscript = true;
      } else {
        await this.appendMetadataEntry(entry);
      }
      this.currentSessionActiveLeaf = entry;
      this.parentCursorByScope.set(getTranscriptScopeKey(false), leafUuid);
    });
  }

  reAppendSessionMetadata(skipTitleRefresh = false): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(() =>
      this.reAppendSessionMetadataInternal(skipTitleRefresh),
    );
  }

  private async reAppendSessionMetadataInternal(
    skipTitleRefresh: boolean,
  ): Promise<void> {
    if (!this.hasMaterializedTranscript) {
      return;
    }

    const tail = await this.readFileTail();
    if (!tail) {
      return;
    }

    const tailLines = tail.split('\n');

    if (!skipTitleRefresh) {
      const titleLine = findLastLineWithPrefix(
        tailLines,
        '{"type":"custom-title"',
      );
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle');
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined;
        }
      }
    }

    const tagLine = findLastLineWithPrefix(tailLines, '{"type":"tag"');
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag');
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined;
      }
    }

    const workspaceDirectoriesLine = findLastLineWithPrefix(
      tailLines,
      '{"type":"workspace-directories"',
    );
    if (workspaceDirectoriesLine) {
      const tailDirectories = extractWorkspaceDirectories(
        workspaceDirectoriesLine,
      );
      if (tailDirectories) {
        this.currentWorkspaceDirectories = tailDirectories;
      }
    }

    await this.appendEntries(this.buildCachedMetadataEntries());
    this.metadataTailDirty = false;
  }

  private async insertMessageChain(
    messages: readonly Message[],
    isSidechain: boolean,
    agentId?: string,
    startingParentUuid?: string | null,
    immediate = false,
  ): Promise<string | null> {
    const projection = projectMessagesForTranscript(messages, {
      sessionId: this.sessionId,
      cwd: this.cwd,
      entrypoint: this.entrypoint,
      userType: this.userType,
      version: this.version,
      ...(this.gitBranch ? { gitBranch: this.gitBranch } : {}),
      isSidechain,
      ...(agentId ? { agentId } : {}),
      startingParentUuid,
    });
    const transcriptMessages = projection.messages;
    const lastChainUuid = projection.lastChainUuid;
    const latestCompactBoundaryUuid = projection.latestCompactBoundaryUuid;

    let materializedNow = false;
    let materializedBufferedEntries = 0;
    if (
      !this.hasMaterializedTranscript &&
      transcriptMessages.some(
        (message) => message.type === 'user' || message.type === 'assistant',
      )
    ) {
      materializedBufferedEntries = await this.materializeTranscript(immediate);
      materializedNow = true;
    }

    const latestPrompt = this.extractLatestPrompt(messages);
    if (latestPrompt && latestPrompt !== this.currentSessionLastPrompt) {
      this.currentSessionLastPrompt = latestPrompt;
    }

    const nextActiveLeaf: ActiveLeafEntry | undefined =
      !isSidechain && lastChainUuid !== null
        ? {
            type: 'active-leaf',
            sessionId: this.sessionId,
            leafUuid: lastChainUuid,
            explicit: false,
            ...(latestCompactBoundaryUuid
              ? { compactBoundaryUuid: latestCompactBoundaryUuid }
              : {}),
            timestamp: Date.now(),
          }
        : undefined;
    await this.writeOrBuffer(
      [...transcriptMessages, ...(nextActiveLeaf ? [nextActiveLeaf] : [])],
      immediate,
    );
    if (nextActiveLeaf) {
      this.currentSessionActiveLeaf = nextActiveLeaf;
    }
    if (materializedNow) {
      runLogger.log(
        'transcript.writer.materialized',
        `session=${this.sessionId}`,
        `entries=${transcriptMessages.length}`,
        `buffered_entries=${materializedBufferedEntries}`,
        `path=${this.filePath}`,
      );
      emitSessionPhaseFinished({
        sessionId: this.sessionId,
        phase: 'transcript.writer.materialized',
        success: true,
        data: {
          entries: transcriptMessages.length,
          buffered_entries: materializedBufferedEntries,
          path: this.filePath,
        },
      });
    }
    // Message + active-leaf append has committed. A later metadata-tail
    // failure must not make a retry append these same messages again.
    for (const message of messages) {
      this.messageSet.add(message.uuid);
    }
    if (lastChainUuid !== null) {
      this.parentCursorByScope.set(
        getTranscriptScopeKey(isSidechain, agentId),
        lastChainUuid,
      );
    }
    this.metadataTailDirty = true;
    if (shouldRefreshMetadataTailAfterInsert(messages)) {
      await this.appendCachedMetadataEntriesToTail();
    }

    return lastChainUuid;
  }

  private extractLatestPrompt(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const prompt = getRealUserPromptText(message);
      if (prompt) {
        return prompt;
      }
    }

    return null;
  }

  private async appendEntries(entries: readonly Entry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.channel.append(entries);
  }

  private async appendEntriesImmediately(
    entries: readonly Entry[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const append = this.channel.append(entries);
    // Observe both promises even when the channel barrier fails. Awaiting the
    // barrier first would skip the append rejection and leak it as an
    // unhandled promise during fail-stop persistence errors.
    await Promise.all([append, this.channel.barrier()]);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize writer operations while keeping the scheduling tail fulfilled.
    // The original operation promise still rejects its caller. AppendChannel
    // decides whether a persistence error is recoverable or fail-stop.
    const run = this.operationChain.then(() => operation());
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendMetadataEntry(
    entry:
      | LastPromptEntry
      | CustomTitleEntry
      | TagEntry
      | WorkspaceDirectoriesEntry
      | RuntimeConfigEntry
      | ActiveLeafEntry,
  ): Promise<void> {
    if (!this.hasMaterializedTranscript) {
      return;
    }

    await this.appendEntries([entry]);
  }

  private async appendNonCachedEntry(
    entry:
      | SummaryMessage
      | AiTitleEntry
      | FileHistorySnapshotEntry
      | ContentReplacementEntry
      | TokenStatsEntry,
  ): Promise<void> {
    await this.writeOrBuffer([entry]);
    this.metadataTailDirty = true;
  }

  /**
   * Write entries to disk if the transcript has been materialized,
   * otherwise buffer them for later flushing.
   */
  private async writeOrBuffer(
    entries: readonly Entry[],
    immediate = false,
  ): Promise<void> {
    if (this.hasMaterializedTranscript) {
      if (immediate) await this.appendEntriesImmediately(entries);
      else await this.appendEntries(entries);
    } else {
      this.pendingEntriesBeforeMaterialization.push(...entries);
    }
  }

  private buildCachedMetadataEntries(): Entry[] {
    const entries: Entry[] = [];

    if (this.currentSessionLastPrompt) {
      entries.push({
        type: 'last-prompt',
        sessionId: this.sessionId,
        lastPrompt: this.currentSessionLastPrompt,
      });
    }

    if (this.currentSessionTitle) {
      entries.push({
        type: 'custom-title',
        sessionId: this.sessionId,
        customTitle: this.currentSessionTitle,
      });
    }

    if (this.currentSessionAiTitle) {
      entries.push({
        type: 'ai-title',
        sessionId: this.sessionId,
        aiTitle: this.currentSessionAiTitle,
      });
    }

    if (this.currentSessionTag) {
      entries.push({
        type: 'tag',
        sessionId: this.sessionId,
        tag: this.currentSessionTag,
      });
    }

    if (this.currentWorkspaceDirectories) {
      entries.push({
        type: 'workspace-directories',
        sessionId: this.sessionId,
        directories: [...this.currentWorkspaceDirectories],
      });
    }

    if (this.currentRuntimeConfig) {
      entries.push(this.currentRuntimeConfig);
    }

    if (this.currentSessionActiveLeaf) {
      entries.push(this.currentSessionActiveLeaf);
    }

    return entries;
  }

  private async materializeTranscript(immediate = false): Promise<number> {
    if (this.hasMaterializedTranscript) {
      return 0;
    }

    const cachedMetadataEntries = this.buildCachedMetadataEntries();
    const entriesToFlush = [
      ...cachedMetadataEntries,
      ...this.pendingEntriesBeforeMaterialization,
    ];
    if (entriesToFlush.length > 0) {
      if (immediate) await this.appendEntriesImmediately(entriesToFlush);
      else await this.appendEntries(entriesToFlush);
    }
    this.hasMaterializedTranscript = true;
    this.pendingEntriesBeforeMaterialization = [];
    return entriesToFlush.length;
  }

  private async appendCachedMetadataEntriesToTail(): Promise<void> {
    if (!this.hasMaterializedTranscript || !this.metadataTailDirty) {
      return;
    }

    const entries = this.buildCachedMetadataEntries();
    if (entries.length === 0) {
      this.metadataTailDirty = false;
      return;
    }

    await this.appendEntriesImmediately(entries);
    this.metadataTailDirty = false;
  }

  private async readFileTail(bufferSize = 64 * 1024): Promise<string> {
    return (await this.channel.readTail(bufferSize)).toString('utf8');
  }

  private assertOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error(`SessionTranscriptWriter is ${this.lifecycle}`);
    }
  }
}

/**
 * Keeps only runtime messages that should be written to the transcript file.
 *
 * The transform step preserves a single call site for transcript-specific
 * normalization.
 */
export function cleanMessagesForLogging(
  messages: readonly Message[],
): Message[] {
  const filtered = messages.filter(isLoggableMessage);
  return transformMessagesForExternalTranscript(filtered, messages);
}

/**
 * Applies the transcript writer's canonical runtime-to-JSONL projection.
 *
 * Forking and persistence must share this transform so filtering, runtime-only
 * field removal and special parent relationships cannot drift apart.
 */
export function projectMessagesForTranscript(
  messages: readonly Message[],
  options: TranscriptMessageProjectionOptions,
): TranscriptMessageProjection {
  const cleaned = cleanMessagesForLogging(messages);
  let parentUuid = options.startingParentUuid ?? null;
  let lastChainUuid: string | null = null;
  let latestCompactBoundaryUuid: string | undefined;
  const transcriptMessages: TranscriptMessage[] = [];

  for (const message of cleaned) {
    let effectiveParentUuid = parentUuid;
    let logicalParentUuid: string | null | undefined;

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      logicalParentUuid = parentUuid;
      effectiveParentUuid = null;
      if (!message.compactMetadata?.preservedSegment) {
        latestCompactBoundaryUuid = message.uuid;
      }
    }

    if (message.type === 'user' && message.sourceToolAssistantUUID) {
      effectiveParentUuid = message.sourceToolAssistantUUID;
    }

    const transcriptMessage: TranscriptMessage = {
      ...stripRuntimeOnlyTranscriptFields(message),
      parentUuid: effectiveParentUuid,
      ...(logicalParentUuid !== undefined ? { logicalParentUuid } : {}),
      isSidechain: options.isSidechain ?? false,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      cwd: options.cwd,
      sessionId: options.sessionId,
      userType: options.userType ?? 'external',
      entrypoint: options.entrypoint,
      version: options.version ?? 'unknown',
      ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
      timestamp:
        options.preserveTimestamps && message.timestamp
          ? message.timestamp
          : new Date().toISOString(),
      ...(message.type === 'system' &&
      message.subtype === 'compact_boundary' &&
      !message.compactMetadata?.preservedSegment
        ? { requiresActiveLeafCommit: true }
        : {}),
    };

    transcriptMessages.push(boundCodeModeHistoryDetails(transcriptMessage));

    if (isChainParticipant(message)) {
      parentUuid = message.uuid;
      lastChainUuid = message.uuid;
    }
  }

  return {
    messages: transcriptMessages,
    lastChainUuid,
    ...(latestCompactBoundaryUuid ? { latestCompactBoundaryUuid } : {}),
  };
}

// Write-time policy for auxiliary child-tool details, not a read-time ceiling
// on existing transcripts. Keep this independent from resume admission.
const CODE_MODE_HISTORY_DETAIL_LIMITS = {
  maxLineBytes: 8 * 1024 ** 2,
  maxNestedItemsPerEntry: 50_000,
  maxDepth: 128,
};

/** Keep child tool details when the complete entry fits the detail policy. */
function boundCodeModeHistoryDetails(
  entry: TranscriptMessage,
): TranscriptMessage {
  if (entry.type !== 'user' || entry.toolUseResult == null) return entry;
  const grouped =
    Array.isArray(entry.message.content) &&
    entry.message.content.filter((block) => block.type === 'tool_result')
      .length > 1;
  const results = grouped ? entry.toolUseResult : [entry.toolUseResult];
  if (!Array.isArray(results)) return entry;
  const isCodeMode = (result: unknown): result is { calls: unknown[] } =>
    isRecord(result) &&
    result['type'] === CODE_MODE_RESULT_TYPE &&
    result['callsMode'] === 'delta' &&
    typeof result['rootToolUseId'] === 'string' &&
    Array.isArray(result['calls']);
  if (!results.some(isCodeMode)) return entry;
  const fits = (record: TranscriptMessage) =>
    Number.isFinite(
      countResumeEntryItems(record, CODE_MODE_HISTORY_DETAIL_LIMITS, {
        maxTextChars: CODE_MODE_HISTORY_DETAIL_LIMITS.maxLineBytes,
      }),
    ) &&
    Buffer.byteLength(JSON.stringify(record)) <=
      CODE_MODE_HISTORY_DETAIL_LIMITS.maxLineBytes;
  if (fits(entry)) return entry;

  const summarize = (keepOutcome: boolean): TranscriptMessage => {
    const summaries = results.map((result) => {
      if (!isCodeMode(result)) return result;
      const calls = result.calls.map((call) => {
        if (!isRecord(call) || !isRecord(call['hostResult'])) return call;
        const { hostResult, ...summary } = call;
        if (!keepOutcome) return summary;
        return {
          ...summary,
          hostResult: {
            content: 'Tool output omitted from history.',
            is_error: hostResult['is_error'],
          },
        };
      });
      return { ...result, calls };
    });
    return { ...entry, toolUseResult: grouped ? summaries : summaries[0] };
  };
  const compact = summarize(true);
  // Drop omission notices too if the parent result leaves room only for the call summaries.
  return fits(compact) ? compact : summarize(false);
}

export function isLoggableMessage(message: Message): boolean {
  if (
    message.type === 'system' &&
    TRANSIENT_TASK_SYSTEM_SUBTYPES.has(message.subtype)
  ) {
    return false;
  }

  switch (message.type) {
    case 'progress':
    case 'tool_use_summary':
    case 'tombstone':
      return false;
    case 'attachment':
      return !isEmptyHookSuccess(message);
    case 'system':
      return !isTaskLifecycleSubtype(message.subtype);
    default:
      return true;
  }
}

export function isChainParticipant(message: Message): boolean {
  switch (message.type) {
    case 'user':
    case 'assistant':
    case 'system':
      return true;
    case 'attachment':
      return !isEmptyHookSuccess(message);
    default:
      return false;
  }
}

function isEmptyHookSuccess(
  message: Extract<Message, { type: 'attachment' }>,
): boolean {
  const attachment = message.attachment;
  if (attachment.type !== 'hook_success') return false;
  const isBlank = (value: unknown) =>
    typeof value !== 'string' || value.trim() === '';
  return (
    !attachment['content'] &&
    isBlank(attachment['stdout']) &&
    isBlank(attachment['stderr'])
  );
}

function getTranscriptScopeKey(isSidechain: boolean, agentId?: string): string {
  return `${isSidechain ? 'sidechain' : 'main'}:${agentId ?? ''}`;
}

function isPendingAssistantFragment(message: Message): boolean {
  return (
    message.type === 'assistant' &&
    message.message.stop_reason == null &&
    message.isApiErrorMessage !== true
  );
}

function stripLeadingPendingFragments(
  messages: readonly Message[],
  pendingMessages: readonly Message[],
): Message[] {
  let cursor = 0;
  while (
    cursor < messages.length &&
    cursor < pendingMessages.length &&
    messages[cursor]?.uuid === pendingMessages[cursor]?.uuid
  ) {
    cursor++;
  }
  return messages.slice(cursor);
}

function extractTombstoneTargetUuid(message: Message): string | undefined {
  if (message.type !== 'tombstone') {
    return undefined;
  }

  const target = message.message;
  if (target && typeof target === 'object' && 'uuid' in target) {
    const uuid = target.uuid;
    return typeof uuid === 'string' ? uuid : undefined;
  }

  return undefined;
}

function stripRuntimeOnlyTranscriptFields(message: Message): Message {
  if (message.type === 'assistant') {
    const { requestId: _requestId, ...host } = message;
    const { usage, ...payload } = message.message;
    // 会话用量按原可见性规则落盘，模型完成载荷不承载计费字段。
    const exposeTokenCounts = message.modelSource === CUSTOM_PROVIDER_SOURCE;
    const persistUsage =
      exposeTokenCounts ||
      shouldExposeTokenUsage() ||
      hasCreditsMetadata(usage);
    return {
      ...host,
      message: {
        ...payload,
        ...(usage !== undefined && persistUsage
          ? { usage: cloneUsageForSdkOutput(usage, { exposeTokenCounts }) }
          : {}),
      },
    };
  }

  if (message.type === 'system') {
    if (message.usage) {
      const { total_tokens: _totalTokens, ...restUsage } = message.usage;
      return {
        ...message,
        usage: restUsage,
      } as Message;
    }
    return message;
  }

  return message;
}

interface CreditsUsageMetadata {
  billable?: boolean;
  credits?: number;
  original_credits?: number;
}

function hasCreditsMetadata(value: unknown): value is CreditsUsageMetadata {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const {
    billable,
    credits,
    original_credits: originalCredits,
  } = value as CreditsUsageMetadata;
  return (
    typeof billable === 'boolean' ||
    (typeof credits === 'number' && Number.isFinite(credits)) ||
    (typeof originalCredits === 'number' && Number.isFinite(originalCredits))
  );
}

function transformMessagesForExternalTranscript(
  messages: readonly Message[],
  _allMessages: readonly Message[],
): Message[] {
  return messages.map((message) => {
    const projected =
      message.type === 'user'
        ? projectUserToolResultsForExternalTranscript(message)
        : message;
    if (!projected.isVirtual) {
      return projected;
    }

    const { isVirtual: _omit, ...rest } = projected;
    return rest;
  });
}

function projectUserToolResultsForExternalTranscript(
  message: UserMessage,
): UserMessage {
  if (message.toolUseResult === undefined) return message;
  const content = message.message.content;
  if (!Array.isArray(content)) return message;

  const toolResultCount = content.filter(
    (block) => block.type === 'tool_result',
  ).length;
  if (toolResultCount === 0) return message;

  let changed = false;
  const projectedResults = Array.from(
    { length: toolResultCount },
    (_, index) => {
      const result = selectToolResultSideChannel(
        message.toolUseResult,
        index,
        toolResultCount,
      );
      const mcpMeta = selectMcpResultMeta(
        message.mcpMeta,
        index,
        toolResultCount,
      );
      const projected =
        mcpMeta === undefined
          ? projectFileToolResultForExternalUse(result)
          : result;
      changed ||= projected !== result;
      return projected;
    },
  );

  if (!changed) return message;
  return {
    ...message,
    toolUseResult:
      toolResultCount === 1 ? projectedResults[0] : projectedResults,
  };
}

function shouldRefreshMetadataTailAfterInsert(
  messages: readonly Message[],
): boolean {
  return messages.some(
    (message) =>
      message.type === 'assistant' &&
      !isPendingAssistantFragment(message) &&
      message.message.stop_reason !== 'tool_use',
  );
}

function findLastLineWithPrefix(
  lines: readonly string[],
  prefix: string,
): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line?.startsWith(prefix)) {
      return line;
    }
  }
  return undefined;
}

function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  let lastValue: string | undefined;

  for (const pattern of patterns) {
    let searchFrom = 0;
    while (true) {
      const index = text.indexOf(pattern, searchFrom);
      if (index < 0) {
        break;
      }

      const valueStart = index + pattern.length;
      let cursor = valueStart;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === '"') {
          const raw = text.slice(valueStart, cursor);
          lastValue = raw.includes('\\') ? JSON.parse(`"${raw}"`) : raw;
          break;
        }
        cursor++;
      }
      searchFrom = cursor + 1;
    }
  }

  return lastValue;
}

function extractWorkspaceDirectories(text: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    const directories =
      'directories' in parsed ? parsed.directories : undefined;
    if (!Array.isArray(directories)) {
      return undefined;
    }
    return directories.filter(
      (directory): directory is string => typeof directory === 'string',
    );
  } catch {
    return undefined;
  }
}
