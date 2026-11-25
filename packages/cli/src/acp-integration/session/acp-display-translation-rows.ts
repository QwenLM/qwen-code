/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModRenderSite } from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { MOD_MAX_BYTES } from '@qwen-code/qwen-code-core/mods/types.js';
import type { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { MAX_SNAPSHOTS } from '@qwen-code/qwen-code-core/services/file-history-limits.js';
import { splitInsightSegments } from '@qwen-code/qwen-code-core/utils/insight-segments.js';
import type { ModRowAuthorization } from '../../services/mod-rows.js';

// Match the Web Shell's default live transcript window for non-recorded chats.
const liveRowLimit = 50_000;
const rowTextLimit = MOD_MAX_BYTES / 2;

function rowKey(component: ModRenderSite, text: string): string {
  return createHash('sha256')
    .update(component)
    .update(text, 'utf16le')
    .digest('hex');
}

function* displayedRows(
  component: ModRenderSite,
  text: string,
): Iterable<string> {
  yield component === 'Thinking' ? text.trimEnd() : text;
  if (component === 'AssistantMessage') {
    for (const segment of splitInsightSegments(text) ?? [])
      if (segment.kind === 'text') yield segment.text;
  }
}

/** Only session-owned output may be sent to the display translation model. */
export class AcpDisplayTranslationRows {
  private sessionId?: string;
  private recorder?: ChatRecordingService;
  private branch?: number;
  private generation = new AbortController();
  private pending?: {
    attempt: WeakRef<object>;
    component: ModRenderSite;
    text: string;
    oversized: boolean;
  };
  private sequence = 0;
  private readonly live = new Map<string, number>();
  private readonly rootToolIds = new Map<string, number>();
  private readonly checkpoints = new Map<string, number>();
  private persisted?: { cursor: string; rows: Promise<Set<string>> };

  constructor(private readonly config: Config) {}

  private currentRecorder(): ChatRecordingService | undefined {
    const sessionId = this.config.getSessionId();
    const recorder = this.config.getChatRecordingService();
    const branch = recorder?.getBranchGeneration();
    if (
      this.sessionId !== sessionId ||
      this.recorder !== recorder ||
      this.branch !== branch
    ) {
      this.sessionId = sessionId;
      this.recorder = recorder;
      this.branch = branch;
      this.sequence = 0;
      this.live.clear();
      this.rootToolIds.clear();
      this.checkpoints.clear();
      this.invalidateGeneration();
    }
    return recorder;
  }

  private invalidateGeneration(): void {
    const previous = this.generation;
    this.generation = new AbortController();
    this.pending = undefined;
    this.persisted = undefined;
    previous.abort();
  }

  recordLiveCheckpoint(promptId: string): void {
    this.currentRecorder();
    this.checkpoints.set(promptId, ++this.sequence);
    if (this.checkpoints.size > MAX_SNAPSHOTS)
      this.checkpoints.delete(this.checkpoints.keys().next().value!);
  }

  rewindLiveRows(promptId: string): void {
    this.currentRecorder();
    // Without a checkpoint there is no reliable retained prefix.
    const cutoff = this.checkpoints.get(promptId) ?? 0;
    for (const entries of [this.live, this.rootToolIds, this.checkpoints]) {
      for (const [key, position] of entries) {
        if (position >= cutoff) entries.delete(key);
      }
    }
    this.invalidateGeneration();
  }

  observe(text: string, component: ModRenderSite, attempt: object): void {
    this.currentRecorder();
    const pending = this.pending;
    if (pending?.attempt.deref() === attempt) {
      if (pending.component === component) {
        if (!pending.oversized) {
          const remaining = rowTextLimit - pending.text.length;
          pending.text += text.slice(0, remaining);
          pending.oversized = text.length > remaining;
        }
        return;
      }
      // The Web Shell closes the preceding row when a different kind starts.
      this.settleAttempt(attempt, true);
    }
    this.pending = {
      attempt: new WeakRef(attempt),
      component,
      text: text.slice(0, rowTextLimit),
      oversized: text.length > rowTextLimit,
    };
  }

  settleAttempt(attempt: object, completed: boolean): void {
    this.currentRecorder();
    const pending = this.pending;
    if (pending?.attempt.deref() !== attempt) return;
    this.pending = undefined;
    if (completed && !pending.oversized)
      this.rememberCompleted(pending.component, pending.text);
  }

  observeRootToolCall(toolCallId: string, preparing: boolean): void {
    this.currentRecorder();
    const id = createHash('sha256').update(toolCallId, 'utf16le').digest('hex');
    if (this.rootToolIds.has(id)) return;
    this.rootToolIds.set(id, ++this.sequence);
    if (this.rootToolIds.size > liveRowLimit)
      this.rootToolIds.delete(this.rootToolIds.keys().next().value!);
    if (!preparing) return;

    const attempt = this.pending?.attempt.deref();
    if (attempt) this.settleAttempt(attempt, true);
  }

  rememberCompleted(component: ModRenderSite, text: string): void {
    this.currentRecorder();
    if (!text.trim() || Buffer.byteLength(text) > rowTextLimit) return;
    for (const row of displayedRows(component, text)) {
      const key = rowKey(component, row);
      if (this.live.has(key)) continue;
      this.live.set(key, ++this.sequence);
      if (this.live.size > liveRowLimit)
        this.live.delete(this.live.keys().next().value!);
    }
  }

  private isPendingPrefix(component: ModRenderSite, text: string): boolean {
    if (this.pending?.component !== component) return false;
    for (const row of displayedRows(component, this.pending.text)) {
      if (row.startsWith(text)) return true;
    }
    return false;
  }

  /** The returned check pins permission to the transcript seen before dispatch. */
  async authorize(
    component: ModRenderSite,
    text: string,
  ): Promise<ModRowAuthorization | undefined> {
    if (!text.trim() || Buffer.byteLength(text) > rowTextLimit)
      return undefined;
    const recorder = this.currentRecorder();
    const generation = this.generation.signal;
    const stillCurrent = () => {
      this.currentRecorder();
      return !generation.aborted;
    };
    const signal = recorder?.getBranchAbortSignal() ?? generation;
    const liveAuthorization = { isCurrent: stillCurrent, signal };
    const key = rowKey(component, text);
    if (this.live.has(key)) return liveAuthorization;
    // MAX_TOKENS recovery can persist a prefix before its display row ends.
    const canReadPersisted = () =>
      stillCurrent() && !this.isPendingPrefix(component, text);
    if (!canReadPersisted()) return undefined;
    const cursor = recorder?.getTranscriptCursor().recordId;
    if (!recorder || !cursor) return undefined;

    const rows = await this.readPersisted(recorder, cursor);
    if (!stillCurrent()) return undefined;
    if (this.live.has(key)) return liveAuthorization;
    if (!canReadPersisted()) return undefined;
    const persistedAuthorization = { isCurrent: canReadPersisted, signal };
    if (rows?.has(key)) return persistedAuthorization;
    const nextCursor = recorder.getTranscriptCursor().recordId;
    if (!nextCursor || nextCursor === cursor) return undefined;

    // An assistant record may have committed while the first snapshot loaded.
    const latest = await this.readPersisted(recorder, nextCursor);
    if (!stillCurrent()) return undefined;
    if (this.live.has(key)) return liveAuthorization;
    return canReadPersisted() && latest?.has(key)
      ? persistedAuthorization
      : undefined;
  }

  private async readPersisted(
    recorder: ChatRecordingService,
    cursor: string,
  ): Promise<Set<string> | undefined> {
    if (this.persisted?.cursor !== cursor) {
      const rows = recorder
        .readActiveTranscriptChain()
        .then(async (records) => {
          const { projectChatRecordsToDaemonTranscript } = await import(
            '@qwen-code/sdk/daemon/transcript'
          );
          const modelRecordIds = new Set(
            records
              .filter(
                ({ type, subtype, provenance }) =>
                  type === 'assistant' &&
                  subtype === undefined &&
                  (provenance === undefined ||
                    provenance === 'assistant_output'),
              )
              .map(({ uuid }) => uuid),
          );
          const keys = new Set<string>();
          const { blocks } = projectChatRecordsToDaemonTranscript(records);
          for (const block of blocks) {
            if (
              (block.kind === 'assistant' || block.kind === 'thought') &&
              !block.parentToolCallId &&
              !block.agent &&
              block.sourceRecordIds?.length &&
              block.sourceRecordIds.every((id) => modelRecordIds.has(id))
            ) {
              const component =
                block.kind === 'thought' ? 'Thinking' : 'AssistantMessage';
              for (const text of displayedRows(component, block.text))
                keys.add(rowKey(component, text));
            }
          }
          return keys;
        });
      this.persisted = { cursor, rows };
    }

    const pending = this.persisted;
    try {
      return await pending.rows;
    } catch {
      if (this.persisted === pending) this.persisted = undefined;
      return undefined;
    }
  }
}
