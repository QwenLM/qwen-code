/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../message/message.js';

/**
 * A caller-owned lease over one session's transcript file.
 *
 * Implementations may buffer writes internally; callers should `flush()`
 * before relying on durability and `close()` when the session is finished.
 */
export interface SessionTranscriptWriter {
  /** The session id this writer is bound to. */
  readonly sessionId: string;
  /** Absolute path of the transcript JSONL file. */
  readonly filePath: string;

  /**
   * Appends one or more messages to the transcript main chain.
   * Implementations decide how messages are encoded into JSONL entries.
   */
  recordMessages(messages: readonly Message[]): Promise<void>;

  /** Records a user-set custom title in the transcript metadata. */
  recordCustomTitle(title: string): Promise<void>;

  /** Records an AI-generated title in the transcript metadata. */
  recordAiTitle(title: string): Promise<void>;

  /** Records the most recent meaningful user prompt in the transcript metadata. */
  recordLastPrompt(text: string): Promise<void>;

  /** Records a compact summary in the transcript metadata. */
  recordSummary(summary: string): Promise<void>;

  /** Records a user tag in the transcript metadata; null clears it. */
  recordTag(tag: string | null): Promise<void>;

  /** Records the workspace directories authorized for the session. */
  recordWorkspaceDirectories(directories: readonly string[]): Promise<void>;

  /** Records the active-leaf cursor for the main chain. */
  recordActiveLeaf(leafUuid: string | null): Promise<void>;

  /** Flushes any buffered entries to disk. */
  flush(): Promise<void>;

  /** Closes the writer and releases underlying file resources. */
  close(): Promise<void>;
}
