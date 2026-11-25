/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session — the aggregate root.
 *
 * A Session is a PURE IN-MEMORY aggregate: every method below operates on the
 * in-memory projection only and performs no I/O. All disk persistence
 * (transcript appends, metadata entries, rewind active-leaf records, fork
 * transcripts) is orchestrated by {@link SessionManager}, which pairs each
 * memory mutation with the corresponding transcript write — e.g.
 * `manager.append(session, message)` is `session.addMessage(message)` plus
 * the transcript append.
 *
 * A session instance is distinguished along several data axes (all verified
 * against the current sources): identity (sessionId), remote mirror (remoteId),
 * origin (entrypoint/version/userType), location
 * (projectDir/sessionPath/cwd/gitBranch/worktree), time, catalog metadata,
 * and fork lineage. Daemon-managed lifecycle state (generation, launch
 * request, idle flags) is deliberately NOT part of the entity — it is host
 * state about a session, not of the session.
 *
 * Physical reality this model mirrors: there is no session registry. The
 * JSONL transcript file IS the authoritative store (file name = sessionId),
 * everything on this entity is derived from its entries, and all
 * modifications are appended entries — never in-place rewrites.
 */

import type { Message } from '../message/message.js';
import type { Turn } from '../turn/turn.js';

/** One persisted conversation, held as an in-memory projection. */
export interface Session {
  // ── Identity ──

  getSessionId(): string;
  /** Server-issued mirror key (`qs_`-prefixed); present only for remote-hosted sessions. */
  getRemoteId(): string | undefined;

  // ── Origin ──

  /** Where the session was started from. */
  getEntrypoint(): string | undefined;
  /** CLI/SDK version that wrote the session. */
  getVersion(): string | undefined;
  /** User type stamp, e.g. 'external' for interactive sessions. */
  getUserType(): string | undefined;

  // ── Location & project context ──

  /** Project directory owning the transcript bucket. */
  getProjectDir(): string;
  /** Absolute path of the transcript JSONL file. */
  getSessionPath(): string;
  /** Effective working directory (folds worktree state + relocation entries). */
  getCwd(): string;
  /** Most recently recorded git branch in the active chain. */
  getGitBranch(): string | undefined;
  /** Worktree binding; null means explicitly exited. */
  getWorktree(): string | null | undefined;
  /** Workspace directories authorized for the session. */
  getDirectories(): readonly string[] | undefined;
  /** Project directory that owns the transcript bucket (for writer rebinding). */
  getTranscriptProjectDir(): string | undefined;
  /** Absolute path of the transcript bucket (~/.qwen/projects/<sanitized>). */
  getTranscriptBucketDir(): string | undefined;
  /** Worktree path this session came from (cross-worktree sessions only). */
  getSourceWorktreePath(): string | undefined;
  /** Logical project path shown in session pickers, independent of storage. */
  getDisplayProjectPath(): string | undefined;

  // ── Time ──

  /** ISO timestamp of the session's first entry. */
  getStartedAt(): string;
  /** ISO timestamp of the session's last update. */
  getUpdatedAt(): string;

  // ── Catalog metadata ──
  getTag(): string | undefined;
  getSummary(): string | undefined;
  getLastPrompt(): string | undefined;
  getCustomTitle(): string | undefined;
  getAiTitle(): string | undefined;

  // ── Presentation & addressing ──

  /** 1-based position in the owning project's catalog; 0 when unranked. */
  getIndex(): number;
  setIndex(value: number): void;
  /** Whether this session is the caller's current session. */
  isCurrentSession(): boolean;
  /** One-line summary: `Session N: <first user message> (…)`; for logs/UI. */
  getDisplayInfo(): string;
  /** Human-readable title: custom > ai > last-prompt > summary > first user message. */
  getDisplayName(): string;
  /** Flattened searchable text of the whole conversation, when projected. */
  getFullContent(): string | undefined;
  /**
   * Searchable text excerpts projected when the catalog is built with
   * `includeFullContent`. These are display/Search-layer artifacts, not the
   * full runtime message chain.
   */
  getSearchableMessages(): readonly Message[];
  getSearchableContent(): string | undefined;

  // ── Content access ──

  /**
   * Returns the full projected message chain of the active transcript path.
   *
   * Elements are domain {@link Message} aggregates: structural facts plus
   * the underlying protocol payload (per message via `getPayload()`).
   * Callers that need the turn-grouped DAG view should iterate turns and
   * their messages instead.
   */
  getMessages(): readonly Message[];

  /** Returns all turns in this session, in chain order. */
  getTurns(): readonly Turn[];

  // ── Statistics ──

  getMessageCount(): number;
  getUserMessageCount(): number;
  /** Transcript file size in bytes. */
  getFileSize(): number | undefined;

  // ── Queries ──

  /** Whether this session contains any resumable messages. */
  hasResumableMessages(): boolean;

  /** Returns the first real user prompt, or a fallback display text. */
  getFirstUserMessage(): string;

  /** Counts user messages that are visible in default history. */
  countUserMessages(): number;

  /** Counts messages that are displayable in default history. */
  countDisplayMessages(): number;

  /** Returns the workspace directories resolved for this session. */
  getWorkspaceDirectories(): readonly string[];

  // ── In-memory state mutation ──
  // Memory-only; the paired transcript write lives on SessionManager.

  /**
   * Adds a message to the in-memory main chain. The caller is responsible
   * for building the {@link Message} (e.g. via `buildMessage`); duplicates by
   * uuid are ignored.
   */
  addMessage(message: Message): void;

  // Note: catalog metadata mutations (customTitle, aiTitle, lastPrompt, tag,
  // summary, workspaceDirectories, activeLeaf) are intentionally NOT exposed
  // as direct setters on the aggregate. They are written to the transcript
  // via SessionTranscriptWriter and projected back onto Session by the reader.
}
