/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { restoreAttachment } from './transcript-conversion.js';
import { normalizeAttachmentsForAPI } from './normalize.js';
import type { AttachmentMessage } from './types.js';

describe('retired transcript attachments', () => {
  it.each([
    'plan_mode_event',
    'output_token_usage',
    'deferred_tools_delta',
    'task_status',
    'diagnostics',
    'skill_discovery',
    'output_style',
    'budget_usd',
    'ultrathink_effort',
    'companion_intro',
    'async_hook_response',
    'teammate_shutdown_batch',
    'dynamic_skill',
    'command_permissions',
    'context_efficiency',
    'structured_output',
    'max_turns_reached',
    'bagel_console',
    'pen_mode_enter',
    'pen_mode_exit',
  ])('ignores historical %s payloads during restoration', (type) => {
    expect(restoreAttachment({ type })).toBeUndefined();
  });

  it('projects surviving context after a retired historical attachment', () => {
    const messages = [
      {
        type: 'attachment',
        uuid: 'old',
        timestamp: '2026-10-16T00:00:00.000Z',
        attachment: { type: 'output_style', style: 'retired style' },
      },
      {
        type: 'attachment',
        uuid: 'current',
        timestamp: '2026-10-16T00:00:01.000Z',
        attachment: { type: 'critical_system_reminder', content: 'continue' },
      },
    ] as unknown as AttachmentMessage[];

    expect(normalizeAttachmentsForAPI(messages)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\ncontinue\n</system-reminder>',
          },
        ],
      },
    ]);
  });

  it.each([
    { type: 'token_usage', used: 10, total: 100, remaining: 90 },
    { type: 'compaction_reminder' },
    {
      type: 'compact_file_reference',
      filename: '/large.txt',
      displayPath: 'large.txt',
    },
    { type: 'current_session_memory', snapshot: 'session summary' },
  ])('retains provider context for $type', (payload) => {
    const attachment = restoreAttachment(payload);
    expect(attachment?.type).toBe(payload.type);
    expect(attachment?.toUserMessages()).toHaveLength(1);
  });
});
