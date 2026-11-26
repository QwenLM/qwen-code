/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error codes thrown by {@link SessionManager} operations.
 */
export type SessionErrorCode =
  | 'NO_SESSIONS_FOUND'
  | 'INVALID_SESSION_IDENTIFIER'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_SESSION_TITLE';

/**
 * Domain error for session-manager failures.
 *
 * Callers distinguish recoverable catalog/resume errors by `code` rather
 * than parsing the message string.
 */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }

  /**
   * Thrown by `loadLatest` when a project has no sessions and by
   * `loadByIndex`/`loadByIdOrIndex` when the resolved catalog is empty.
   */
  static noSessionsFound(): SessionError {
    return new SessionError(
      'NO_SESSIONS_FOUND',
      'No previous sessions found for this project.',
    );
  }

  /**
   * Thrown when a resume argument cannot be resolved to an existing session.
   */
  static invalidSessionIdentifier(
    identifier: string,
    searchDir?: string,
  ): SessionError {
    const dirInfo = searchDir ? ` in ${searchDir}` : '';
    return new SessionError(
      'INVALID_SESSION_IDENTIFIER',
      `Invalid session identifier "${identifier}".\n  Searched for sessions${dirInfo}.\n  Use --list-sessions to see available sessions, then use --continue to load the most recent conversation saved under the current project directory, or use --resume {number} / --resume {uuid} to load a specific conversation.`,
    );
  }

  /**
   * Thrown by `loadById` when the id is well-formed but no session exists,
   * or when the id is in the explicit exclusion list.
   */
  static sessionNotFound(
    identifier: string,
    searchDir?: string,
  ): SessionError {
    const dirInfo = searchDir ? ` in ${searchDir}` : '';
    return new SessionError(
      'SESSION_NOT_FOUND',
      `Session "${identifier}" not found${dirInfo}.`,
    );
  }

  /** Thrown when a session title is empty or exceeds the length limit. */
  static invalidSessionTitle(
    title: string,
    maxLength: number,
  ): SessionError {
    return new SessionError(
      'INVALID_SESSION_TITLE',
      `Session title must be a non-empty string at most ${maxLength} characters (got ${title.length}).`,
    );
  }
}
