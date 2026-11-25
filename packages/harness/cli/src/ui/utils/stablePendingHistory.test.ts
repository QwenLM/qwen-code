/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreToolCallStatus } from '@qwen-code/core';
import { describe, expect, it } from 'vitest';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import {
  createStablePendingHistoryState,
  reconcileStablePendingHistory,
} from './stablePendingHistory.js';

const toolGroup = (
  callId: string,
  description = 'running',
): HistoryItemWithoutId => ({
  type: 'tool_group',
  tools: [
    {
      callId,
      name: 'Read',
      description,
      status: CoreToolCallStatus.Executing,
      resultDisplay: undefined,
      confirmationDetails: undefined,
    } as IndividualToolCallDisplay,
  ],
});

describe('reconcileStablePendingHistory', () => {
  it('retains identities when a new item is inserted before the live tail', () => {
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(3),
      [{ type: 'gemini', text: 'hel' }, toolGroup('call-1')],
      3,
    );

    const next = reconcileStablePendingHistory(
      initial,
      [
        { type: 'info', text: 'new' },
        { type: 'gemini', text: 'hello' },
        toolGroup('call-1', 'still running'),
      ],
      3,
    );

    expect(next.items[1]?.key).toBe(initial.items[0]?.key);
    expect(next.items[1]?.id).toBe(initial.items[0]?.id);
    expect(next.items[2]?.key).toBe(initial.items[1]?.key);
    expect(next.items[2]?.id).toBe(initial.items[1]?.id);
    expect(next.items[0]?.key).not.toBe(initial.items[0]?.key);
  });

  it('keeps surviving siblings stable when another pending item commits', () => {
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(0),
      [{ type: 'gemini', text: 'complete response' }, toolGroup('call-1')],
      0,
    );

    const afterCommit = reconcileStablePendingHistory(
      initial,
      [toolGroup('call-1', 'updated')],
      0,
    );

    expect(afterCommit.items[0]?.key).toBe(initial.items[1]?.key);
    expect(afterCommit.items[0]?.id).toBe(initial.items[1]?.id);
  });

  it('allocates a new identity after an item disappears', () => {
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(0),
      [{ type: 'gemini', text: 'first' }],
      0,
    );
    const empty = reconcileStablePendingHistory(initial, [], 0);
    const next = reconcileStablePendingHistory(
      empty,
      [{ type: 'gemini', text: 'second' }],
      0,
    );

    expect(next.items[0]?.key).not.toBe(initial.items[0]?.key);
    expect(next.items[0]?.id).not.toBe(initial.items[0]?.id);
  });

  it('resets identities when the conversation scope changes', () => {
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(1),
      [{ type: 'gemini', text: 'stream' }],
      1,
    );
    const next = reconcileStablePendingHistory(
      initial,
      [{ type: 'gemini', text: 'streaming' }],
      2,
    );

    expect(next.items[0]?.key).toBe('pending:2:1');
    expect(next.items[0]?.key).not.toBe(initial.items[0]?.key);
  });

  it('keeps an empty tool rail stable without relying on its array index', () => {
    const rail: HistoryItemWithoutId = {
      type: 'tool_group',
      tools: [],
      borderTop: false,
      borderBottom: true,
    };
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(0),
      [rail],
      0,
    );
    const next = reconcileStablePendingHistory(
      initial,
      [{ type: 'info', text: 'inserted' }, { ...rail }],
      0,
    );

    expect(next.items[1]?.key).toBe(initial.items[0]?.key);
  });

  it('keeps a thinking identity when parsing moves text into the subject', () => {
    const initial = reconcileStablePendingHistory(
      createStablePendingHistoryState(0),
      [
        {
          type: 'thinking',
          thought: { subject: '', description: '**Inspect' },
        },
      ],
      0,
    );
    const next = reconcileStablePendingHistory(
      initial,
      [
        {
          type: 'thinking',
          thought: { subject: 'Inspect', description: 'the renderer' },
        },
      ],
      0,
    );

    expect(next.items[0]?.key).toBe(initial.items[0]?.key);
    expect(next.items[0]?.id).toBe(initial.items[0]?.id);
  });
});
