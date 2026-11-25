/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionManager — the unified facade over one project's session bucket.
 *
 * Responsibilities:
 * - Read / construction surface: list, load*, create, loadByStamp, delete
 * - Day-to-day transcript appends and metadata writes are intentionally NOT
 *   exposed here; they belong to the {@link SessionTranscriptWriter} handle
 *   obtained for an open session. This keeps the manager focused on operations
 *   that need project-level context or coordination between memory and disk.
 *
 * {@link Session} objects remain pure in-memory aggregates — the manager never
 * caches them and every load returns a fresh instance.
 */

import type { Session } from '../session/session.js';
import type { SessionStamp } from '../stamp/session-stamp.js';
import type { SessionDeleteOptions } from './session-delete-options.js';
import type { SessionForkOptions } from './session-fork-options.js';
import type { SessionLoadOptions } from './session-load-options.js';
import type { SessionRenameOptions } from './session-rename-options.js';

/** Unified manager over one project's session bucket. */
export interface SessionManager {

  /**
   * Lists the project's session catalog, newest first. Metadata-derived by
   * default; see {@link SessionLoadOptions} for where-to-read, projection
   * depth, and presentation controls.
   */
  list(
    projectDir: string,
    options?: SessionLoadOptions,
  ): Promise<readonly Session[]>;

  /**
   * Lists sessions across all projects under the config root, sorted by
   * project directory ascending and then updatedAt descending.
   */
  listAll(options?: SessionLoadOptions): Promise<readonly Session[]>;

  /**
   * Loads the project's most recently updated session (the `--continue`
   * semantic). Throws {@link SessionError} 'NO_SESSIONS_FOUND' when the
   * project has no sessions.
   */
  loadLatest(
    projectDir: string,
    options?: SessionLoadOptions,
  ): Promise<Session>;

  /**
   * Loads one session by id. Returns `null` when the id is malformed or no
   * session exists for that id. Other I/O errors are thrown.
   */
  loadById(
    projectDir: string,
    sessionId: string,
    options?: SessionLoadOptions,
  ): Promise<Session | null>;

  /**
   * Loads a session by its 1-based position in the catalog (the
   * `--resume <number>` semantic). Throws {@link SessionError}
   * 'INVALID_SESSION_IDENTIFIER' when out of range.
   */
  loadByIndex(
    projectDir: string,
    index: number,
    options?: SessionLoadOptions,
  ): Promise<Session>;

  /**
   * Resolves a session from either an id or a 1-based catalog index. This is
   * the unified entry point for `--resume` arguments that accept both forms.
   * Non-numeric values are treated as ids; numeric values are treated as
   * indexes. Throws {@link SessionError} when the identifier cannot be
   * resolved.
   */
  loadByIdOrIndex(
    projectDir: string,
    idOrIndex: string,
    options?: SessionLoadOptions,
  ): Promise<Session>;

  /**
   * Creates a new session and returns its in-memory aggregate. The
   * transcript file is materialized on the first append, not by this call.
   *
   * When `stamp.sessionId` is omitted a new UUID is generated. All other
   * stamp fields are optional and receive sensible defaults.
   */
  create(stamp?: SessionStamp): Promise<Session>;

  /**
   * Resolves a Session from a {@link SessionStamp}.
   *
   * Resolution order:
   * 1. Load from disk if a transcript file exists for `stamp.sessionId`.
   * 2. Construct a new Session from the stamp data if no persisted session
   *    exists.
   */
  loadByStamp(stamp: SessionStamp): Promise<Session>;

  /**
   * Deletes the session's transcript file.
   *
   * Mirrors the legacy `TranscriptStore.deleteTranscript` /
   * `sessions.deleteSession`: only the transcript file is removed; auxiliary
   * session state, checkpoints, or artifacts are out of scope for this layer.
   * Callers that need to guard against deleting the active session should do
   * so at the UI / application layer.
   *
   * Returns `true` if the transcript file was removed, `false` if it did not
   * exist or the id is unsafe. I/O failures are thrown.
   */
  delete(
    projectDir: string,
    sessionId: string,
    options?: SessionDeleteOptions,
  ): Promise<boolean>;

  /**
   * Sets a custom title for the session by appending a `custom-title` entry
   * to its transcript. The session id (and therefore the transcript file name)
   * does not change; the title is a metadata layer used for display and search.
   *
   * Returns the updated {@link Session} reflecting the new title.
   * Throws {@link SessionError} 'SESSION_NOT_FOUND' when the session does not
   * exist, or 'INVALID_SESSION_TITLE' when the title is empty or too long.
   */
  rename(
    projectDir: string,
    sessionId: string,
    title: string,
    options?: SessionRenameOptions,
  ): Promise<Session>;

  /**
   * Resolves a lightweight metadata-only projection of one session.
   *
   * Mirrors the legacy `TranscriptSessionInfo` read path: the returned
   * {@link Session} carries catalog metadata and message counts, but its
   * message chain is not populated. Use {@link loadById} when the full
   * conversation is required.
   *
   * Throws {@link SessionError} 'SESSION_NOT_FOUND' when the session does not
   * exist.
   */
  info(
    projectDir: string,
    sessionId: string,
    options?: SessionLoadOptions,
  ): Promise<Session>;

  /**
   * Forks a source session into a new target session transcript.
   *
   * The target session id is taken from `options.targetSessionId` or generated
   * as a fresh UUID. It must differ from the source session id when provided.
   * By default the entire source chain is copied; pass `resumeSessionAt` to
   * truncate at a specific message UUID.
   *
   * Returns the newly created forked {@link Session}. Its
   * {@link Session.getForkedFrom} carries the fork provenance.
   * Throws {@link SessionError} when the source or target cannot be resolved,
   * or when the target session already exists.
   */
  fork(
    projectDir: string,
    sessionId: string,
    options?: SessionForkOptions,
  ): Promise<Session>;
}
