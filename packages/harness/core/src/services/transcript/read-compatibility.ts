/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import { ResumeReadError } from './resume-read-budget.js';
import { runLogger } from '../../utils/runLogger.js';

/** Structural scans must not reject optional metadata before selecting a chain. */
export function hasReplacementTarget(
  value: unknown,
): value is { messageUuid: string } {
  return isRecord(value) && isString(value['messageUuid']);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only runtime projection consumes content. Keep raw entries/graph links intact. */
export function normalizeSelectedMessage(
  entry: TranscriptMessage,
): TranscriptMessage {
  if (entry.type === 'system') {
    if (typeof entry.content !== 'string')
      failSelectedMessage(entry, 'content');
    return entry;
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') return entry;
  const content: unknown = entry.message.content;
  if (typeof content === 'string') {
    // Plain text has the same meaning in historical user and assistant records.
    if (entry.type === 'user') return entry;
    return {
      ...entry,
      message: {
        ...entry.message,
        content: [{ type: 'text', text: content, citations: null }],
      },
    };
  }
  if (!Array.isArray(content)) failSelectedMessage(entry, 'message.content');
  for (let index = 0; index < content.length; index++) {
    const block: unknown = content[index];
    // Do not silently discard unrecognizable content or tool call/result pairs.
    if (!isRecord(block) || !isString(block['type'])) {
      failSelectedMessage(entry, `message.content[${index}].type`);
    }
  }
  return entry;
}

function failSelectedMessage(entry: TranscriptMessage, field: string): never {
  const error = new ResumeReadError('unsafe');
  // Keep the stable error code while making the offending entry actionable.
  error.message = `Transcript resume failed: unsafe (${entry.type} ${entry.uuid}, ${field}).`;
  runLogger.warn('transcript.resume.invalid_selected_message', {
    uuid: entry.uuid,
    type: entry.type,
    field,
  });
  throw error;
}
