/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionTranscriptWriter } from '../../interface/writer/session-transcript-writer.js';
import type { SessionTranscriptWriterImpl } from './session-transcript-writer-impl.js';

/**
 * A caller-owned lease over one shared session writer.
 *
 * Closing the lease releases the store's reference count; when the count
 * reaches zero the underlying writer is flushed and closed.
 */
export class LeasedSessionTranscriptWriter implements SessionTranscriptWriter {
  readonly sessionId: string;
  readonly filePath: string;
  private active = true;

  constructor(
    private readonly writer: SessionTranscriptWriterImpl,
    private readonly release: () => Promise<void>,
  ) {
    this.sessionId = writer.getSessionId();
    this.filePath = writer.getSessionFilePath();
  }

  async recordMessages(
    messages: ReadonlyArray<import('../../interface/message/message.js').Message>,
  ): Promise<void> {
    this.assertActive();
    await this.writer.recordMessages(messages);
  }

  recordCustomTitle(title: string): Promise<void> {
    this.assertActive();
    return this.writer.recordCustomTitle(title);
  }

  recordAiTitle(title: string): Promise<void> {
    this.assertActive();
    return this.writer.recordAiTitle(title);
  }

  recordLastPrompt(text: string): Promise<void> {
    this.assertActive();
    return this.writer.recordLastPrompt(text);
  }

  recordSummary(summary: string): Promise<void> {
    this.assertActive();
    return this.writer.recordSummary(summary);
  }

  recordTag(tag: string | null): Promise<void> {
    this.assertActive();
    return this.writer.recordTag(tag);
  }

  recordWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    this.assertActive();
    return this.writer.recordWorkspaceDirectories(directories);
  }

  recordActiveLeaf(leafUuid: string | null): Promise<void> {
    this.assertActive();
    return this.writer.recordActiveLeaf(leafUuid, { explicit: true });
  }

  flush(): Promise<void> {
    this.assertActive();
    return this.writer.flush();
  }

  async close(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.active = false;
    await this.release();
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('SessionTranscriptWriter is closed');
    }
  }
}
