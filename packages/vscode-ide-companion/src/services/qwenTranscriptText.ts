/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { projectUserTranscriptForDisplay } from '@qwen-code/qwen-code-core';

type QwenTextRecord = {
  type?: unknown;
  message?: unknown;
  systemPayload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageParts(message: unknown): readonly unknown[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) return [];
  return message.parts;
}

function partsToText(parts: readonly unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') {
      texts.push(part.text);
    } else if (typeof part.data === 'string') {
      texts.push(part.data);
    }
  }
  return texts.join('\n');
}

export function qwenContentToText(message: unknown): string {
  return partsToText(messageParts(message));
}

export function qwenRecordToText(record: QwenTextRecord): string {
  if (record.type !== 'user') return qwenContentToText(record.message);

  const projection = projectUserTranscriptForDisplay({
    message: { parts: messageParts(record.message) },
    systemPayload: record.systemPayload,
  });
  return projection.displayText ?? partsToText(projection.parts);
}
