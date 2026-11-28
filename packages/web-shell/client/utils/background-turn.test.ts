/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseDaemonBackgroundTurn,
  type DaemonBackgroundTurn,
} from '@qwen-code/sdk/daemon';
import { parseBackgroundTurn } from './background-turn';

const validTurn: DaemonBackgroundTurn = {
  turnId: 'turn-1',
  taskId: 'task-1',
  kind: 'agent',
  startedAt: 0,
  toolUseId: 'tool-1',
  sourceTurnId: 'source-1',
  label: 'Explore',
};

describe('parseBackgroundTurn', () => {
  it.each([
    { label: 'valid agent turn with optional fields', value: validTurn },
    {
      label: 'valid monitor turn without optional fields',
      value: {
        turnId: 't2',
        taskId: 'k2',
        kind: 'monitor',
        startedAt: 1234,
      },
    },
    {
      label: 'valid shell turn',
      value: { turnId: 't3', taskId: 'k3', kind: 'shell', startedAt: 1 },
    },
    {
      label: 'valid workflow turn',
      value: { turnId: 't4', taskId: 'k4', kind: 'workflow', startedAt: 1 },
    },
    {
      label: 'valid peer turn',
      value: { turnId: 't5', taskId: 'k5', kind: 'peer', startedAt: 1 },
    },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'primitive', value: 'turn-1' },
    { label: 'array', value: [] },
    { label: 'empty turnId', value: { ...validTurn, turnId: '' } },
    { label: 'non-string turnId', value: { ...validTurn, turnId: 42 } },
    { label: 'empty taskId', value: { ...validTurn, taskId: '' } },
    { label: 'non-string taskId', value: { ...validTurn, taskId: null } },
    { label: 'unknown kind', value: { ...validTurn, kind: 'cron' } },
    { label: 'negative startedAt', value: { ...validTurn, startedAt: -1 } },
    { label: 'NaN startedAt', value: { ...validTurn, startedAt: Number.NaN } },
    {
      label: 'Infinity startedAt',
      value: { ...validTurn, startedAt: Number.POSITIVE_INFINITY },
    },
    {
      label: 'non-number startedAt',
      value: { ...validTurn, startedAt: '100' },
    },
    {
      label: 'non-string toolUseId',
      value: { ...validTurn, toolUseId: 123 },
    },
    {
      label: 'non-string sourceTurnId',
      value: { ...validTurn, sourceTurnId: false },
    },
    {
      label: 'non-string label',
      value: { ...validTurn, label: ['Explore'] },
    },
  ])('matches SDK parser on $label', ({ value }) => {
    expect(parseBackgroundTurn(value)).toEqual(
      parseDaemonBackgroundTurn(value),
    );
  });
});
