/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { ManagedHistoryQuery } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-history.js';

export function hostedSessionRecords(
  session: {
    readonly authority: { readonly committedSequence: number };
    readonly sink: {
      iterateRecords(throughSequence?: number): AsyncIterable<ChatRecord>;
    };
  },
  throughSequence = session.authority.committedSequence,
) {
  return new ManagedHistoryQuery(() =>
    session.sink.iterateRecords(throughSequence),
  );
}

export function hostedMessageRecords(
  session: {
    readonly authority: { readonly committedSequence: number };
    readonly sink: {
      iterateMessageRecords(
        throughSequence?: number,
      ): AsyncIterable<ChatRecord>;
    };
  },
  throughSequence = session.authority.committedSequence,
) {
  return new ManagedHistoryQuery(() =>
    session.sink.iterateMessageRecords(throughSequence),
  );
}

export function hostedRecordsAfter(
  records: ManagedHistoryQuery<ChatRecord>,
  recordId: string,
): ManagedHistoryQuery<ChatRecord> {
  return new ManagedHistoryQuery(async function* () {
    let after = false;
    for await (const record of records) {
      if (after) yield record;
      else if (record.uuid === recordId) after = true;
    }
  });
}
