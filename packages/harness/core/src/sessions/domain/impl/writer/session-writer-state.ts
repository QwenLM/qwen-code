/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionTranscriptWriterImpl } from './session-transcript-writer-impl.js';
import type { SessionWriterMetadataSnapshot } from './session-transcript-writer-impl.js';

export interface SessionWriterStateSnapshot
  extends SessionWriterMetadataSnapshot {
  readonly messageUuids: readonly string[];
  /** UUID of the final message in the transcript, if any. */
  readonly mainParentUuid?: string | null;
  /** Explicit active leaf cursor, when one was recorded in the transcript. */
  readonly activeLeafUuid?: string | null;
  /** True when the transcript file already existed on disk before the writer was acquired. */
  readonly fileExisted?: boolean;
}

export interface ManagedSessionWriterState {
  key: string;
  readonly writer: SessionTranscriptWriterImpl;
  filePath: string;
  retain(): boolean;
  release(): Promise<boolean>;
  forceClose(): Promise<void>;
}

/**
 * Reference-counted wrapper around one {@link SessionTranscriptWriterImpl}.
 *
 * Mirrors the legacy `SessionWriterState`: it tracks how many handles still
 * hold the writer, closes it when the count reaches zero, and guards against
 * double-close.
 */
export class SessionWriterState implements ManagedSessionWriterState {
  references = 0;
  lifecycle: 'open' | 'closing' | 'closed' = 'open';
  closePromise: Promise<void> | undefined;

  constructor(
    public key: string,
    public filePath: string,
    readonly writer: SessionTranscriptWriterImpl,
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
