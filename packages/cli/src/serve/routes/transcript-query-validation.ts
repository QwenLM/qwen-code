/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared query/body validation and response serialization for the
// workspace-qualified (`session.ts`) and standalone (`standalone-sessions.ts`)
// transcript routes; both route families import from this single module so
// the two cannot drift.

import {
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES,
  SessionTranscriptPageTooLargeError,
} from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import type { Response } from 'express';

// Chosen cap for one serialized transcript response, kept proportional to
// the core expanded-page ceiling so the two cannot drift arbitrarily. This
// is not a derived guarantee: a single aggregated record can exceed any
// page budget (the reader always takes at least one record so pagination
// cannot dead-end), and replayed SessionUpdate objects are not a fixed
// multiple of their source records. A page a route cannot serialize
// returns transcript_page_too_large for that anchor.
export const WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES =
  2 * SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES;
export const WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES = 64 * 1024;
export const TRANSCRIPT_CURSOR_TOO_LARGE_REPLAY_ERROR =
  'Transcript pagination state exceeds the safe limit';

export function parseTranscriptLimitQuery(
  rawLimit: unknown,
  res: Response,
): number | undefined | null {
  if (rawLimit === undefined) return undefined;
  if (typeof rawLimit !== 'string' || rawLimit.trim() === '') {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  if (!/^\d+$/.test(rawLimit)) {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    res.status(400).json({
      error: `\`limit\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      code: 'invalid_transcript_limit',
      maxLimit: SESSION_TRANSCRIPT_MAX_LIMIT,
    });
    return null;
  }
  return limit;
}

export function parseTranscriptCursorQuery(
  rawCursor: unknown,
  res: Response,
): string | undefined | null {
  if (rawCursor === undefined) return undefined;
  if (typeof rawCursor !== 'string' || rawCursor.trim() === '') {
    res.status(400).json({
      error: '`cursor` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawCursor;
}

export function parseTranscriptDirectionQuery(
  rawDirection: unknown,
  res: Response,
): 'backward' | undefined | null {
  if (rawDirection === undefined) return undefined;
  if (rawDirection !== 'backward') {
    res.status(400).json({
      error: '`direction` must be `backward`',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawDirection;
}

export function parseTranscriptSnapshotQuery(
  rawSnapshot: unknown,
  res: Response,
): string | undefined | null {
  if (rawSnapshot === undefined) return undefined;
  if (typeof rawSnapshot !== 'string' || rawSnapshot.trim() === '') {
    res.status(400).json({
      error: '`snapshot` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawSnapshot;
}

export function parseTranscriptStartQuery(
  rawStart: unknown,
  res: Response,
): number | undefined | null {
  if (rawStart === undefined) return undefined;
  if (typeof rawStart !== 'string' || !/^\d+$/.test(rawStart)) {
    res.status(400).json({
      error: '`start` must be a non-negative integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) {
    res.status(400).json({
      error: '`start` must be a non-negative safe integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return start;
}

export function parseTranscriptRecordBoundaryQuery(
  rawBoundary: unknown,
  res: Response,
): string | undefined | null {
  if (rawBoundary === undefined) return undefined;
  if (
    typeof rawBoundary !== 'string' ||
    rawBoundary.trim() === '' ||
    rawBoundary.length > 200
  ) {
    res.status(400).json({
      error: '`beforeRecordId` must be a non-empty record id',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawBoundary;
}

export function parseTranscriptTurnAnchorQuery(
  rawAnchor: unknown,
  res: Response,
): string | undefined | null {
  if (rawAnchor === undefined) return undefined;
  if (
    typeof rawAnchor !== 'string' ||
    rawAnchor.trim() === '' ||
    rawAnchor.length > 200
  ) {
    res.status(400).json({
      error: '`atRecordId` must be a non-empty record id',
      code: 'invalid_turn_anchor',
    });
    return null;
  }
  return rawAnchor;
}

export function parseReplayMode(
  body: Record<string, unknown>,
  res: Response,
  key: 'liveReplayMode' | 'compactedReplayMode' | 'eventDetailMode',
): 'full' | 'summary' | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'summary') {
    res.status(400).json({
      error: `\`${key}\` must be \`full\` or \`summary\``,
      code:
        key === 'liveReplayMode'
          ? 'invalid_live_replay_mode'
          : key === 'compactedReplayMode'
            ? 'invalid_compacted_replay_mode'
            : 'invalid_event_detail_mode',
    });
    return null;
  }
  return value;
}

export function workspaceTranscriptCursorExceedsLimit(
  cursor: string,
  maxBytes = WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES,
): boolean {
  return Buffer.byteLength(cursor) > maxBytes;
}

export function isConflictingTranscriptAnchorCombination(query: {
  direction: 'backward' | undefined;
  cursor: string | undefined;
  beforeRecordId: string | undefined;
  atRecordId: string | undefined;
  snapshot: string | undefined;
}): boolean {
  const { direction, cursor, beforeRecordId, atRecordId, snapshot } = query;
  return (
    (direction !== undefined &&
      (cursor !== undefined ||
        beforeRecordId !== undefined ||
        atRecordId !== undefined ||
        snapshot !== undefined)) ||
    (cursor !== undefined &&
      (beforeRecordId !== undefined ||
        atRecordId !== undefined ||
        snapshot !== undefined)) ||
    (atRecordId !== undefined &&
      (beforeRecordId !== undefined || snapshot === undefined)) ||
    (snapshot !== undefined &&
      atRecordId === undefined &&
      beforeRecordId === undefined)
  );
}

export const workspaceTranscriptCursorExceedsLimitForTesting =
  workspaceTranscriptCursorExceedsLimit;

export function serializeWorkspaceTranscriptResponse(
  result: unknown,
  sessionId: string,
  maxBytes = WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES,
): string {
  const serialized = JSON.stringify(result);
  const responseBytes = Buffer.byteLength(serialized);
  if (responseBytes > maxBytes) {
    throw new SessionTranscriptPageTooLargeError(
      sessionId,
      responseBytes,
      maxBytes,
    );
  }
  return serialized;
}

export const serializeWorkspaceTranscriptResponseForTesting =
  serializeWorkspaceTranscriptResponse;
