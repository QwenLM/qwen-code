/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRecord, stripControlSequences } from './adaptor-utils.js';
import type { BackendEvent } from './types.js';

export function publicActivity(
  update: Record<string, unknown>,
  jobRef?: string,
): Extract<BackendEvent, { type: 'activity' }> | undefined {
  const kind = update['sessionUpdate'];
  let activity: 'message' | 'plan' | 'tool';
  let text = '';
  if (kind === 'agent_message_chunk') {
    const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
    if (
      meta?.['source'] === 'background_task_completed' ||
      meta?.['source'] === 'background_notification' ||
      meta?.['source'] === 'background_notification_turn_started'
    )
      return;
    const content = update['content'];
    if (!isRecord(content) || typeof content['text'] !== 'string') return;
    activity = 'message';
    text = content['text'];
  } else if (kind === 'plan') {
    if (!Array.isArray(update['entries'])) return;
    activity = 'plan';
    text = update['entries']
      .slice(0, 24)
      .flatMap((entry) => {
        if (!isRecord(entry) || typeof entry['content'] !== 'string') return [];
        const status = ['pending', 'in_progress', 'completed'].includes(
          String(entry['status']),
        )
          ? String(entry['status'])
          : 'pending';
        return [`[${status}] ${entry['content'].slice(0, 1024)}`];
      })
      .join('\n');
  } else if (kind === 'tool_call_update') {
    activity = 'tool';
    const parts: string[] = [];
    if (typeof update['title'] === 'string') parts.push(update['title']);
    if (
      ['pending', 'in_progress', 'completed', 'failed'].includes(
        String(update['status']),
      )
    )
      parts.push(`[${String(update['status'])}]`);
    if (Array.isArray(update['content'])) {
      for (const part of update['content'].slice(0, 24)) {
        if (!isRecord(part) || part['type'] !== 'content') continue;
        const content = part['content'];
        if (
          isRecord(content) &&
          content['type'] === 'text' &&
          typeof content['text'] === 'string'
        )
          parts.push(content['text']);
      }
    }
    text = parts.join('\n');
  } else return;
  text = stripControlSequences(text).slice(0, 8192);
  if (!text) return;
  return {
    type: 'activity',
    kind: activity,
    text,
    ...(jobRef ? { jobRef } : {}),
  };
}
