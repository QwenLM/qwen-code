/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvalidSessionTranscriptCursorError,
  InvalidSessionTranscriptTurnAnchorError,
  navigationKindForRecord,
  isReplayTurnStartType,
  SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES,
  SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptSnapshotUnavailableError,
  type SessionTranscriptCursorCodec,
  type SessionTranscriptReader,
  type SessionTranscriptRecordPage,
} from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import { summarizeReplay } from '@qwen-code/acp-bridge';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { replayTranscriptRecordPage } from '../acp-integration/session/history-replay-page.js';

export class SessionToolCallsLimitError extends Error {
  constructor(
    message = 'Turn tool calls exceed the maximum of 100 transcript pages',
  ) {
    super(message);
    this.name = 'SessionToolCallsLimitError';
  }
}

export class SessionToolCallsReplayError extends Error {
  constructor() {
    super('Turn tool-call replay is incomplete');
    this.name = 'SessionToolCallsReplayError';
  }
}

/** Read a frozen, complete turn; cursors and partial pages stay server-side. */
export async function readSessionToolCalls({
  sessionId,
  turnId,
  reader,
  codec,
  hasActivePrompt,
}: {
  sessionId: string;
  turnId: string;
  reader: Pick<SessionTranscriptReader, 'readPage' | 'readTurnIndexPage'>;
  codec: Pick<SessionTranscriptCursorCodec, 'encode'>;
  hasActivePrompt: () => boolean;
}): Promise<BridgeEvent[]> {
  const activeBeforeRead = hasActivePrompt();
  const { snapshot } = await reader.readTurnIndexPage(sessionId, { limit: 1 });
  const records: ChatRecord[] = [];
  const ownedRecordIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let retainedBytes = 2;
  const maxBytes = 2 * SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES;
  let selected = false;
  let selectionClosed = false;
  let complete = false;
  let nextPrompt = false;
  let lastPage: SessionTranscriptRecordPage | undefined;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await reader.readPage(sessionId, {
      ...(cursor ? { cursor } : { atRecordId: turnId, snapshot }),
      limit: 250,
      maxBytes: SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
    });
    lastPage = page;
    if (page.records.some((record) => record.sessionId !== sessionId)) {
      throw new SessionTranscriptSnapshotUnavailableError(sessionId);
    }
    if (!cursor && !page.records.some((record) => record.uuid === turnId)) {
      throw new InvalidSessionTranscriptTurnAnchorError();
    }
    for (const record of page.records) {
      if (record.uuid === turnId) selected = true;
      else if (selected) {
        if (
          record.subtype !== 'realtime_message' &&
          isReplayTurnStartType(record.type, record.subtype)
        ) {
          nextPrompt = true;
          break;
        }
        if (navigationKindForRecord(record) !== undefined)
          selectionClosed = true;
      }
      if (selected && !selectionClosed) ownedRecordIds.add(record.uuid);
      retainedBytes += Buffer.byteLength(JSON.stringify(record)) + 1;
      if (retainedBytes > maxBytes) {
        throw new SessionToolCallsLimitError(
          'Turn tool-call replay scan exceeds its byte budget, including records needed to pair late results',
        );
      }
      records.push(record);
    }
    if (nextPrompt || !page.hasMore) {
      complete = true;
      break;
    }
    if (!page.nextCursorState) {
      throw new InvalidSessionTranscriptCursorError(
        'Turn tool-call replay cursor did not advance',
      );
    }
    cursor = codec.encode(page.nextCursorState);
    if (cursors.has(cursor)) {
      throw new InvalidSessionTranscriptCursorError(
        'Turn tool-call replay cursor did not advance',
      );
    }
    cursors.add(cursor);
  }
  if (!complete || !lastPage) throw new SessionToolCallsLimitError();

  // Keep the safe prefix and late interleaved results in one replay machine so
  // ownership follows starts, while result pairing and duplicate IDs stay intact.
  const replay = await replayTranscriptRecordPage({
    sessionId,
    page: {
      ...lastPage,
      records,
      hasMore: false,
      nextCursorState: undefined,
      replay: undefined,
    },
    encodeCursor: (state) => codec.encode(state),
    finalizeDangling: nextPrompt || (!activeBeforeRead && !hasActivePrompt()),
  });
  if (replay.partial || replay.replayError) {
    throw new SessionToolCallsReplayError();
  }
  const summary = summarizeReplay(
    replay.updates.map((update) => ({
      v: 1 as const,
      type: 'session_update' as const,
      data: update,
    })),
  );
  const events: BridgeEvent[] = [];
  const ownedCallIds = new Set<string>();
  retainedBytes = 2;
  for (const event of summary) {
    const update = event.data as Record<string, unknown>;
    const meta = update['_meta'] as Record<string, unknown> | undefined;
    const timing = meta?.['timing'] as Record<string, unknown> | undefined;
    const transcript = meta?.['qwenTranscript'] as
      | { sourceRecordIds?: string[] }
      | undefined;
    const callId = update['toolCallId'];
    if (
      update['sessionUpdate'] === 'tool_call' &&
      typeof callId === 'string' &&
      transcript?.sourceRecordIds?.some((id) => ownedRecordIds.has(id))
    ) {
      ownedCallIds.add(callId);
    }
    const ownTool =
      (update['sessionUpdate'] === 'tool_call' ||
        update['sessionUpdate'] === 'tool_call_update') &&
      typeof callId === 'string' &&
      ownedCallIds.has(callId);
    const ownTiming =
      timing?.['kind'] === 'tool' &&
      typeof timing['callId'] === 'string' &&
      ownedCallIds.has(timing['callId']);
    const anchor =
      update['sessionUpdate'] === 'user_message_chunk' &&
      transcript?.sourceRecordIds?.includes(turnId);
    if (!ownTool && !ownTiming && !anchor) continue;
    const output = update['rawOutput'];
    // Successful agent content duplicates the nested result; failures carry
    // diagnostics that are not present in the structured summary.
    const projected =
      update['status'] === 'completed' &&
      typeof output === 'object' &&
      output !== null &&
      'type' in output &&
      output.type === 'task_execution'
        ? { ...event, data: { ...update, content: [] } }
        : event;
    retainedBytes += Buffer.byteLength(JSON.stringify(projected)) + 1;
    if (retainedBytes > maxBytes) {
      throw new SessionTranscriptPageTooLargeError(
        sessionId,
        retainedBytes,
        maxBytes,
      );
    }
    events.push(projected);
  }
  return events;
}
