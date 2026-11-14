/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../types.js';
import { ToolCallStatus } from '../types.js';
import {
  buildVirtualItems,
  VP_BANNER_ITEM,
  type VpItem,
} from './virtual-items.js';

const user = (id: number, text: string): HistoryItem => ({
  id,
  type: 'user',
  text,
});

const toolGroup = (id: number, batchId?: string): HistoryItem => ({
  id,
  type: 'tool_group',
  ...(batchId === undefined ? {} : { batchId }),
  tools: [
    {
      callId: `call-${id}`,
      name: 'run_shell_command',
      description: 'ls',
      resultDisplay: 'ok',
      status: ToolCallStatus.Success,
      confirmationDetails: undefined,
    },
  ],
});

const pendingToolGroup = (batchId: string) => ({
  type: 'tool_group' as const,
  batchId,
  tools: [
    {
      callId: 'live-call',
      name: 'run_shell_command',
      description: 'ls',
      resultDisplay: 'streaming',
      status: ToolCallStatus.Executing,
      confirmationDetails: undefined,
    },
  ],
});

describe('buildVirtualItems', () => {
  it('puts the banner sentinel at index 0, then history, then pending items', () => {
    const items = buildVirtualItems(
      [user(1, 'a'), user(2, 'b')],
      [{ type: 'gemini', text: 'live' }],
    );
    expect(items[0]).toBe(VP_BANNER_ITEM);
    expect(items[1]).toMatchObject({ id: 1, type: 'user' });
    expect(items[2]).toMatchObject({ id: 2, type: 'user' });
    // Pending items get negative IDs so renderers can tell them apart.
    expect(items[3]).toMatchObject({ id: -1, type: 'gemini', text: 'live' });
  });

  it('returns just the banner for an empty session', () => {
    expect(buildVirtualItems([], [])).toEqual([VP_BANNER_ITEM]);
  });

  it('drops the committed copy of a batch that is still live in pending', () => {
    const items = buildVirtualItems(
      [user(1, 'a'), toolGroup(2, 'batch-1')],
      [pendingToolGroup('batch-1')],
    );
    const types = items.map((item: VpItem) => item.type);
    expect(types).toEqual(['vp-banner', 'user', 'tool_group']);
    // The surviving copy is the live (negative-id) one.
    expect(items[2].id).toBe(-1);
  });

  it('keeps unrelated batches even when their callIds collide', () => {
    const items = buildVirtualItems([toolGroup(1), toolGroup(2)], []);
    expect(items).toHaveLength(3);
    expect(items[1].id).toBe(1);
    expect(items[2].id).toBe(2);
  });
});
