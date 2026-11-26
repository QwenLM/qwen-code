/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../../interface/message/message.js';
import type { AppendChannelLease } from '../../../infra/writer/append-channel-lease.js';
import type { TranscriptEntry } from '../../../infra/entry/transcript-entry.js';
import type { TranscriptMessageEntry } from '../../../infra/entry/transcript-message-entry.js';
import type {
  ActiveLeafEntry,
  AiTitleEntry,
  CustomTitleEntry,
  LastPromptEntry,
  SummaryEntry,
  TagEntry,
  WorkspaceDirectoriesEntry,
} from '../../../infra/entry/transcript-metadata-entries.js';

export interface SessionTranscriptWriterOptions {
  channel: AppendChannelLease;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  userType?: string;
  version?: string;
  gitBranch?: string;
}

export interface SessionWriterMetadataSnapshot {
  readonly customTitle?: string;
  readonly aiTitle?: string;
  readonly lastPrompt?: string;
  readonly tag?: string;
  readonly workspaceDirectories?: readonly string[];
}

export interface RecordActiveLeafOptions {
  explicit: boolean;
  rewound?: boolean;
  durable?: boolean;
}

/**
 * Domain implementation of {@link SessionTranscriptWriter}.
 *
 * This is a faithful port of the legacy `SessionTranscriptWriter` adapted to
 * the sessions package's `Message` domain interface. It keeps the same serialization
 * queue, materialization buffer, metadata tail cache, and lifecycle behaviour.
 */
export class SessionTranscriptWriterImpl {
  private filePath: string;
  private channel: AppendChannelLease;
  private readonly sessionId: string;
  private cwd: string;
  private readonly entrypoint: string;
  private readonly userType: string;
  private readonly version: string;
  private gitBranch?: string;
  private currentSessionLastPrompt?: string;
  private currentSessionTitle?: string;
  private currentSessionTag?: string;
  private currentWorkspaceDirectories?: string[];
  private currentSessionActiveLeaf?: ActiveLeafEntry;

  private readonly messageSet = new Set<string>();
  private pendingEntriesBeforeMaterialization: TranscriptEntry[] = [];
  private operationChain: Promise<void> = Promise.resolve();
  private hasMaterializedTranscript = false;
  private metadataTailDirty = false;
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | undefined;
  private mainParentCursor: string | null = null;

  constructor(options: SessionTranscriptWriterOptions) {
    this.channel = options.channel;
    this.filePath = options.channel.filePath;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.entrypoint = options.entrypoint;
    this.userType = options.userType ?? 'external';
    this.version = options.version ?? 'unknown';
    this.gitBranch = options.gitBranch;
  }

  getSessionFilePath(): string {
    return this.filePath;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  hasMessageUuid(messageUuid: string): boolean {
    this.assertOpen();
    return this.messageSet.has(messageUuid);
  }

  initializeExistingTranscript(
    messageUuids: Iterable<string> = [],
    mainParentUuid?: string | null,
    activeLeafUuid?: string | null,
  ): void {
    this.assertOpen();
    for (const messageUuid of messageUuids) {
      this.messageSet.add(messageUuid);
    }
    const effectiveParentUuid = activeLeafUuid ?? mainParentUuid;
    if (effectiveParentUuid !== undefined) {
      this.mainParentCursor = effectiveParentUuid;
    }
    this.hasMaterializedTranscript = true;
  }

  primeWorkspaceDirectories(directories: readonly string[]): void {
    this.assertOpen();
    this.currentWorkspaceDirectories = [...directories];
  }

  hydrateSessionMetadata(snapshot: SessionWriterMetadataSnapshot): void {
    this.assertOpen();
    this.currentSessionTitle = snapshot.customTitle || undefined;
    this.currentSessionLastPrompt = snapshot.lastPrompt || undefined;
    this.currentSessionTag = snapshot.tag || undefined;
    this.currentWorkspaceDirectories = snapshot.workspaceDirectories
      ? [...snapshot.workspaceDirectories]
      : undefined;
  }

  async recordMessages(messages: readonly Message[]): Promise<string | null> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      let startingParentUuid = this.mainParentCursor ?? null;
      let seenNewMessage = false;
      const newMessages: Message[] = [];

      // Skip any leading prefix that has already been written to the transcript
      // so that re-recordings of the same chain are idempotent.
      for (const message of messages) {
        if (
          !seenNewMessage &&
          this.messageSet.has(message.getUuid()) &&
          isChainParticipant(message)
        ) {
          startingParentUuid = message.getUuid();
        } else {
          seenNewMessage = true;
          newMessages.push(message);
        }
      }

      if (newMessages.length === 0) {
        this.mainParentCursor = startingParentUuid;
        return startingParentUuid;
      }

      const parentUuid = await this.insertMessageChain(
        newMessages,
        startingParentUuid,
      );
      if (parentUuid !== null) {
        this.mainParentCursor = parentUuid;
      }
      return parentUuid;
    });
  }

  flush(): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
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
      let failure: unknown;
      try {
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
      await this.appendNonCachedEntry({
        type: 'ai-title',
        sessionId: this.sessionId,
        aiTitle,
      });
    });
  }

  recordSummary(summary: string): Promise<void> {
    this.assertOpen();
    return this.enqueueOperation(async () => {
      await this.appendNonCachedEntry({
        type: 'summary',
        leafUuid: this.mainParentCursor ?? '',
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
      this.mainParentCursor = leafUuid;
    });
  }

  private async insertMessageChain(
    messages: readonly Message[],
    startingParentUuid?: string | null,
  ): Promise<string | null> {
    const projection = projectMessagesForTranscript(messages, {
      sessionId: this.sessionId,
      cwd: this.cwd,
      entrypoint: this.entrypoint,
      userType: this.userType,
      version: this.version,
      gitBranch: this.gitBranch,
      startingParentUuid,
    });
    const transcriptMessages = projection.messages;
    const lastChainUuid = projection.lastChainUuid;

    let materializedNow = false;
    if (
      !this.hasMaterializedTranscript &&
      transcriptMessages.some(
        (message) => message.type === 'user' || message.type === 'assistant',
      )
    ) {
      await this.materializeTranscript();
      materializedNow = true;
    }

    const latestPrompt = this.extractLatestPrompt(messages);
    if (latestPrompt && latestPrompt !== this.currentSessionLastPrompt) {
      this.currentSessionLastPrompt = latestPrompt;
    }

    const nextActiveLeaf: ActiveLeafEntry | undefined =
      lastChainUuid !== null
        ? {
            type: 'active-leaf',
            sessionId: this.sessionId,
            leafUuid: lastChainUuid,
            explicit: false,
            timestamp: Date.now(),
          }
        : undefined;
    await this.writeOrBuffer([
      ...transcriptMessages,
      ...(nextActiveLeaf ? [nextActiveLeaf] : []),
    ]);
    if (nextActiveLeaf) {
      this.currentSessionActiveLeaf = nextActiveLeaf;
    }
    if (materializedNow) {
      // Intentionally left as a no-op log hook so legacy-writer parity is visible.
    }
    this.metadataTailDirty = true;
    if (shouldRefreshMetadataTailAfterInsert(messages)) {
      await this.appendCachedMetadataEntriesToTail();
    }

    for (const message of messages) {
      this.messageSet.add(message.getUuid());
    }

    return lastChainUuid;
  }

  private extractLatestPrompt(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const prompt = message.getRealUserPromptText();
      if (prompt) {
        return prompt;
      }
    }
    return null;
  }

  private async appendEntries(entries: readonly TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.channel.append(entries);
  }

  private async appendEntriesImmediately(
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const append = this.channel.append(entries);
    await Promise.all([append, this.channel.barrier()]);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
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
      | ActiveLeafEntry,
  ): Promise<void> {
    if (!this.hasMaterializedTranscript) {
      return;
    }
    await this.appendEntries([entry]);
  }

  private async appendNonCachedEntry(
    entry: SummaryEntry | AiTitleEntry,
  ): Promise<void> {
    await this.writeOrBuffer([entry]);
    this.metadataTailDirty = true;
  }

  private async writeOrBuffer(
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    if (this.hasMaterializedTranscript) {
      await this.appendEntries(entries);
    } else {
      this.pendingEntriesBeforeMaterialization.push(...entries);
    }
  }

  private buildCachedMetadataEntries(): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];

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

    if (this.currentSessionActiveLeaf) {
      entries.push(this.currentSessionActiveLeaf);
    }

    return entries;
  }

  private async materializeTranscript(): Promise<number> {
    if (this.hasMaterializedTranscript) {
      return 0;
    }

    this.hasMaterializedTranscript = true;

    const cachedMetadataEntries = this.buildCachedMetadataEntries();
    const entriesToFlush = [
      ...cachedMetadataEntries,
      ...this.pendingEntriesBeforeMaterialization,
    ];
    this.pendingEntriesBeforeMaterialization = [];

    if (entriesToFlush.length > 0) {
      await this.appendEntries(entriesToFlush);
    }
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

  private assertOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error(`SessionTranscriptWriter is ${this.lifecycle}`);
    }
  }
}

interface TranscriptMessageProjectionOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly entrypoint: string;
  readonly userType?: string;
  readonly version?: string;
  readonly gitBranch?: string;
  readonly startingParentUuid?: string | null;
}

interface TranscriptMessageProjection {
  readonly messages: TranscriptMessageEntry[];
  readonly lastChainUuid: string | null;
}

function projectMessagesForTranscript(
  messages: readonly Message[],
  options: TranscriptMessageProjectionOptions,
): TranscriptMessageProjection {
  const cleaned = cleanMessagesForLogging(messages);
  let parentUuid = options.startingParentUuid ?? null;
  let lastChainUuid: string | null = null;
  const transcriptMessages: TranscriptMessageEntry[] = [];

  for (const message of cleaned) {
    const transcriptMessage: TranscriptMessageEntry = {
      ...(message.getPayload() ?? {}),
      type: message.getRole(),
      uuid: message.getUuid(),
      timestamp: message.getTimestamp(),
      parentUuid,
      ...(message.getLogicalParent() !== undefined
        ? { logicalParentUuid: message.getLogicalParent() }
        : {}),
      isSidechain: false,
      cwd: options.cwd,
      sessionId: options.sessionId,
      userType: options.userType ?? 'external',
      entrypoint: options.entrypoint,
      version: options.version ?? 'unknown',
      ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
      ...(message.getPromptId() ? { promptId: message.getPromptId() } : {}),
      ...(message.getRequestSetId()
        ? { requestSetId: message.getRequestSetId() }
        : {}),
      ...(message.getAgentId() ? { agentId: message.getAgentId() } : {}),
      message: message.getPayload() ?? {},
    } as TranscriptMessageEntry;

    transcriptMessages.push(transcriptMessage);

    if (isChainParticipant(message)) {
      parentUuid = message.getUuid();
      lastChainUuid = message.getUuid();
    }
  }

  return {
    messages: transcriptMessages,
    lastChainUuid,
  };
}

function cleanMessagesForLogging(
  messages: readonly Message[],
): readonly Message[] {
  // The sessions domain's Message type does not currently carry transient progress
  // or tool-summary types, so the only filtering needed is identity.
  return messages;
}

function isChainParticipant(_message: Message): boolean {
  // All sessions-domain message roles (user/assistant/system) participate in
  // the persisted chain. Attachments and progress types do not exist here yet.
  return true;
}

function shouldRefreshMetadataTailAfterInsert(messages: readonly Message[]): boolean {
  return messages.some((message) => message.getRole() === 'assistant');
}
