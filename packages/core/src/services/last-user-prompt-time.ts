/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { ChatRecord } from './chatRecordingService.js';

const timestampSchema = z.string().datetime({ offset: true });

export function userPromptTimestamp(record: ChatRecord): string | undefined {
  if (
    record.type !== 'user' ||
    record.forkedFrom !== undefined ||
    record.agentId !== undefined ||
    record.isSidechain === true ||
    (record.provenance !== undefined && record.provenance !== 'real_user') ||
    (record.subtype !== undefined &&
      record.subtype !== 'mid_turn_user_message' &&
      record.subtype !== 'realtime_message' &&
      record.subtype !== 'agent_mention') ||
    !timestampSchema.safeParse(record.timestamp).success
  ) {
    return undefined;
  }
  const timestamp = Date.parse(record.timestamp);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}
