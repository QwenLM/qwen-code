/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { projectEvents } from './hosted-sse-observer.js';

describe.each([
  {
    surface: 'public',
    expected: {
      schema_version: 1,
      projection_version: 1,
      sequence: 7,
      event_id: 'event',
      session_id: 'session',
      turn_id: 'turn',
      type: 'turn.completed',
      created_at: 1_700_000_000,
      data: { status: 'completed' },
    },
  },
  {
    surface: 'web',
    expected: {
      schemaVersion: 1,
      projectionVersion: 1,
      sequence: 7,
      eventId: 'event',
      sessionId: 'session',
      turnId: 'turn',
      type: 'turn.completed',
      createdAt: 1_700_000_000_123,
      data: { status: 'completed' },
    },
  },
])('projectEvents ($surface)', ({ surface, expected }) => {
  it.each([
    [false, false],
    [0, false],
    [true, true],
    [1, true],
  ])('projects the canonical SQL terminal flag %s', (flag, terminal) => {
    const rows = [
      {
        schema_version: 1,
        projection_version: 1,
        sequence_id: 7,
        event_id: 'event',
        session_id: 'session',
        turn_id: 'turn',
        item_id: null,
        content_part_id: null,
        event_type: 'turn.completed',
        gmt_create: 1_700_000_000_123,
        data_json: '{"status":"completed"}',
        is_terminal: flag,
      },
    ];

    expect(projectEvents(rows, surface)).toEqual([{ ...expected, terminal }]);
  });
});
