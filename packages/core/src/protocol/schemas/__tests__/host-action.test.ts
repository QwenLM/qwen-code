/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { HOST_ACTIONS, HostActionEventSchema } from '../sdk-message.js';

describe('HostActionEventSchema', () => {
  const base = {
    type: 'feedback',
    subtype: 'action',
    uuid: '22222222-2222-4222-8222-222222222222',
    session_id: 'session-1',
    parent_result_uuid: '11111111-1111-4111-8111-111111111111',
  } as const;

  it('accepts every supported Host operation', () => {
    expect(HOST_ACTIONS).toEqual([
      'copy_text',
      'helpful',
      'not_helpful',
      'create_branch_task',
      'copy_markdown',
      'add_reply_to_task',
    ]);
    for (const action of HOST_ACTIONS) {
      expect(HostActionEventSchema().parse({ ...base, action })).toMatchObject({
        type: 'feedback',
        subtype: 'action',
        action,
      });
    }
  });

  it('rejects unknown operations and additional fields', () => {
    expect(() =>
      HostActionEventSchema().parse({ ...base, action: 'unknown_action' }),
    ).toThrow();
    expect(() =>
      HostActionEventSchema().parse({
        ...base,
        action: 'copy_text',
        arbitrary: 'not accepted',
      }),
    ).toThrow();
  });
});
