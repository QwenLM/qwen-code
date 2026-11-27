/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageForkInfo } from './message-fork-info.js';

/**
 * Message — the DAG node, keyed by {@link MessageUuid}.
 *
 * A message carries structural facts (where it sits in the session graph)
 * plus the underlying protocol payload. Together with the active-leaf cursor
 * it forms the conversation DAG.
 *
 * Graph-level structures such as {@link MessageNode}, {@link MessageDag} and
 * {@link ActiveLeaf} live in {@link message-graph.js} so that this file stays
 * focused on the domain message interface alone.
 */

/**
 * One persisted message in a session's DAG, keyed by {@link MessageUuid}.
 *
 * This is the sessions domain view of a message: structural facts
 * (where the node sits in the graph) plus the underlying protocol payload.
 * Callers consume it through {@link index.ts} without needing to know about
 * the protocol-level message union.
 */
export interface Message {
  /** Node key. */
  getUuid(): string;
  /** Owning session (persisted on every entry). */
  getSessionId(): string;
  /** Owning turn; persisted on user entries of the turn. */
  getTurnId(): string | undefined;
  /** Chain edge: the predecessor this message was appended after. */
  getParent(): string | null;
  /** Optional semantic edge (post-compaction head → summarized tail). */
  getLogicalParent(): string | null | undefined;
  /** Subagent owner when this message belongs to a sidechain. */
  getSidechainOf(): string | undefined;
  /** ISO timestamp; orders siblings within the file. */
  getTimestamp(): string;

  // ── Turn context ──
  /** Identifier shared by all messages created for the same user turn. */
  getPromptId(): string | undefined;
  /** Request-set grouping key started by this human message, when applicable. */
  getRequestSetId(): string | undefined;
  /** Owning subagent, when this message belongs to a sidechain. */
  getAgentId(): string | undefined;

  // ── Role / classification ──
  /** Discriminant of the underlying protocol message. */
  getRole(): 'user' | 'assistant' | 'system' | 'attachment';
  /** Hidden from default history (synthetic/tool-result user messages). */
  isHiddenUserMessage(): boolean;
  /** Whether this is a tool-result user message. */
  isToolResult(): boolean;
  /** Whether this message is a compact summary. */
  isCompactSummary(): boolean;
  /**
   * Whether this is a synthetic/meta message not from a real user/assistant
   * interaction. Maps to the legacy `MessageBase.isMeta`.
   */
  isMeta(): boolean;
  /**
   * Whether this message belongs to a sidechain (subagent conversation).
   * Maps to the legacy `TranscriptMessage.isSidechain`.
   */
  isSidechain(): boolean;
  /**
   * Whether this user message was locally sourced (human or auto-continuation).
   * Returns `true` for non-user messages, since `origin` only applies to user
   * entries. Maps to the legacy `isLocallySourcedUserEntry`.
   */
  isLocallySourced(): boolean;

  // ── Text extraction ──
  /** Searchable text: assistant text blocks, or the user's displayable text. */
  getSearchText(): string;
  /** User text as shown in history; undefined for non-displayable messages. */
  getDisplayableUserText(): string | undefined;
  /** The real human prompt, when this message carries one; null otherwise. */
  getRealUserPromptText(): string | null;
  /** Fallback display text (command/slash wrappers) for user messages. */
  getPromptFallbackText(): string | undefined;

  /**
   * Whether this message is resumable context for a continued conversation.
   *
   * User messages that are hidden from default history or synthetic local
   * actions are not resumable; compact summaries and real human prompts are.
   */
  isResumable(): boolean;

  /** Fork provenance, present only for messages copied by a fork. */
  getForkedFrom(): MessageForkInfo | undefined;

  /**
   * Returns the opaque protocol payload carried by this message. The writer
   * serializes this record into the JSONL transcript entry; callers that need
   * full round-tripping should supply a JSON-serializable payload at
   * construction time.
   */
  getPayload(): Record<string, unknown> | undefined;
}
