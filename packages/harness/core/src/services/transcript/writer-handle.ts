/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentReplacementEntry,
  FileHistorySnapshotEntry,
  RuntimeConfigEntry,
  TranscriptWorktreeSession,
} from '../../protocol/transcript/entry.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { ManagedSessionWriterState, TranscriptStore } from './store.js';
import type {
  RecordActiveLeafOptions,
  RelocateSessionTranscriptOptions,
  SessionWriterForkSnapshot,
} from './session-writer.js';

/**
 * Minimal sidechain surface consumed by subagent and fork runs.
 *
 * Declared as a projection of {@link TranscriptWriterHandle} so the two cannot
 * drift, and so wrappers that degrade persistence can stand in for a handle.
 */
export type SidechainTranscriptRecorder = Pick<
  TranscriptWriterHandle,
  'recordSidechainMessages' | 'close'
>;

/** A caller-owned lease over one shared session writer state. */
export class TranscriptWriterHandle {
  private active = true;

  constructor(
    private readonly store: TranscriptStore,
    private readonly state: ManagedSessionWriterState,
  ) {}

  get sessionId(): string {
    return this.state.writer.getSessionId();
  }

  get filePath(): string {
    return this.state.writer.getSessionFilePath();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFilePath(): string {
    return this.filePath;
  }

  hasMessageUuid(messageUuid: string): boolean {
    this.assertActive();
    return this.state.writer.hasMessageUuid(messageUuid);
  }

  adoptMainParentUuid(parentUuid: string | null): void {
    this.assertActive();
    this.state.writer.adoptMainParentUuid(parentUuid);
  }

  recordMessages(
    messages: readonly Message[],
    startingParentUuidHint?: string | null,
    options: { immediate?: boolean } = {},
  ): Promise<string | null> {
    this.assertActive();
    return this.state.writer.recordMessages(
      messages,
      startingParentUuidHint,
      options,
    );
  }

  recordSidechainMessages(
    messages: readonly Message[],
    agentId?: string,
    startingParentUuidHint?: string | null,
  ): Promise<string | null> {
    this.assertActive();
    return this.state.writer.recordSidechainMessages(
      messages,
      agentId,
      startingParentUuidHint,
    );
  }

  recordCustomTitle(customTitle: string): Promise<void> {
    this.assertActive();
    return this.state.writer.recordCustomTitle(customTitle);
  }

  recordLastPrompt(lastPrompt: string): Promise<void> {
    this.assertActive();
    return this.state.writer.recordLastPrompt(lastPrompt);
  }

  recordAiTitle(aiTitle: string): Promise<void> {
    this.assertActive();
    return this.state.writer.recordAiTitle(aiTitle);
  }

  recordSummary(leafUuid: string, summary: string): Promise<void> {
    this.assertActive();
    return this.state.writer.recordSummary(leafUuid, summary);
  }

  recordTag(tag: string | null): Promise<void> {
    this.assertActive();
    return this.state.writer.recordTag(tag);
  }

  recordWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    this.assertActive();
    return this.state.writer.recordWorkspaceDirectories(directories);
  }

  recordRuntimeConfig(
    config: Omit<RuntimeConfigEntry, 'type' | 'sessionId' | 'timestamp'>,
  ): Promise<void> {
    this.assertActive();
    return this.state.writer.recordRuntimeConfig(config);
  }

  recordTokenStats(promptTokenCount: number): Promise<void> {
    this.assertActive();
    return this.state.writer.recordTokenStats(promptTokenCount);
  }

  recordFileHistorySnapshot(
    entry: Omit<FileHistorySnapshotEntry, 'type'>,
  ): Promise<void> {
    this.assertActive();
    return this.state.writer.recordFileHistorySnapshot(entry);
  }

  recordContentReplacement(
    replacements: ContentReplacementEntry['replacements'],
    agentId?: string,
  ): Promise<void> {
    this.assertActive();
    return this.state.writer.recordContentReplacement(replacements, agentId);
  }

  createForkSnapshot(
    messages: readonly Message[],
  ): Promise<SessionWriterForkSnapshot> {
    this.assertActive();
    return this.state.writer.createForkSnapshot(messages);
  }

  withTranscriptRead<T>(read: (filePath: string) => Promise<T>): Promise<T> {
    this.assertActive();
    return this.state.writer.withTranscriptRead(read);
  }

  readTranscriptSnapshot(): Promise<Buffer> {
    this.assertActive();
    return this.state.writer.readTranscriptSnapshot();
  }

  recordActiveLeaf(
    leafUuid: string | null,
    options: RecordActiveLeafOptions,
  ): Promise<void> {
    this.assertActive();
    return this.state.writer.recordActiveLeaf(leafUuid, options);
  }

  relocate(options: RelocateSessionTranscriptOptions): Promise<void> {
    this.assertActive();
    return this.store.relocateWriter(this.state, options);
  }

  recordWorktreeState(
    worktreeSession: TranscriptWorktreeSession | null,
    discardLegacyFileHistorySnapshots?: boolean,
  ): Promise<void> {
    this.assertActive();
    return this.state.writer.recordWorktreeState(
      worktreeSession,
      discardLegacyFileHistorySnapshots,
    );
  }

  synchronizeWorktreeRuntimeState(
    state: TranscriptWorktreeSession | null,
  ): void {
    this.assertActive();
    this.state.writer.synchronizeWorktreeRuntimeState(state);
  }

  reAppendSessionMetadata(skipTitleRefresh = false): Promise<void> {
    this.assertActive();
    return this.state.writer.reAppendSessionMetadata(skipTitleRefresh);
  }

  flush(): Promise<void> {
    this.assertActive();
    return this.state.writer.flush();
  }

  async close(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.active = false;
    await this.store.releaseWriter(this.state);
  }

  invalidate(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('TranscriptWriterHandle is closed');
    }
  }
}
