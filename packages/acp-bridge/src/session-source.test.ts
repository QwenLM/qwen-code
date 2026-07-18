/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseSessionSource } from './session-source.js';

describe('parseSessionSource', () => {
  it('accepts an absent source or a valid source pair', () => {
    expect(parseSessionSource(undefined, undefined)).toEqual({});
    expect(parseSessionSource('scheduled_task', 'task-123')).toEqual({
      sourceType: 'scheduled_task',
      sourceId: 'task-123',
    });
  });

  it('requires sourceType when sourceId is provided', () => {
    expect(parseSessionSource(undefined, 'task-123')).toEqual({
      error: expect.stringContaining('sourceType'),
    });
  });

  it.each(['ScheduledTask', 'scheduled task', '', 'a'.repeat(65)])(
    'rejects invalid sourceType %j',
    (sourceType) => {
      expect(parseSessionSource(sourceType, undefined)).toEqual({
        error: expect.stringContaining('sourceType'),
      });
    },
  );

  it.each(['', 'bad\nvalue', 'a'.repeat(257)])(
    'rejects invalid sourceId %j',
    (sourceId) => {
      expect(parseSessionSource('scheduled_task', sourceId)).toEqual({
        error: expect.stringContaining('sourceId'),
      });
    },
  );
});
