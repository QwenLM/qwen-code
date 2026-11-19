/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  foldLiveEvent,
  snapshotCanonicalHistory,
  type LiveHistoryItem,
} from './live-session-model.js';
import { ToolCallStatus, type HistoryItem } from '../types.js';

describe('scheduler canonical tool group carrier', () => {
  it('replaces source on every sibling without deriving raw arguments from formatted cards', () => {
    let items: readonly LiveHistoryItem[] = [];
    for (const id of ['read', 'edit'])
      items = foldLiveEvent(items, {
        type: 'tool-start',
        id,
        tool: id,
        title: id,
      });
    const source: Extract<HistoryItem, { type: 'tool_group' }> = {
      id: -1,
      type: 'tool_group',
      batchId: 'batch-1',
      memoryReadCount: 1,
      tools: ['read', 'edit'].map((callId) => ({
        callId,
        name: callId,
        description: `actual ${callId}`,
        args: { file_path: '/owned/a', exact: { nested: ['before', 'after'] } },
        status: ToolCallStatus.Confirming,
        resultDisplay: {
          fileDiff: '-before\n+after',
          fileName: 'a',
          originalContent: 'before',
          newContent: 'after',
        },
        confirmationDetails: undefined,
        images: [{ mimeType: 'image/png', data: 'YQ==' }],
        omittedImageCount: 2,
      })),
    };
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: source,
      pending: true,
    });
    expect(items).toHaveLength(2);
    expect(
      items.every(
        (item) => item.canonicalHistoryItem === source && item.canonicalPending,
      ),
    ).toBe(true);
    expect(
      snapshotCanonicalHistory(items.filter((item) => !item.canonicalPending)),
    ).toEqual([]);
    const committed = {
      ...source,
      memoryWriteCount: 1,
      tools: source.tools.map((tool) => ({
        ...tool,
        status: ToolCallStatus.Success,
        detailedDisplay: 'full detail',
      })),
    };
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: committed,
      pending: false,
    });
    expect(
      items.every(
        (item) =>
          item.canonicalHistoryItem === committed &&
          item.canonicalPending === false,
      ),
    ).toBe(true);
    expect(snapshotCanonicalHistory(items)).toEqual([committed]);
    expect(snapshotCanonicalHistory(items)[0]).toBe(committed);
  });
  it('keeps both original scheduler groups when a provider reuses a callId in the next batch', () => {
    const source = (
      id: number,
      batchId: string,
      text: string,
    ): Extract<HistoryItem, { type: 'tool_group' }> => ({
      id,
      type: 'tool_group',
      batchId,
      tools: [
        {
          callId: 'same-wire-id',
          name: 'replace',
          description: text,
          args: {
            file_path: '/owned/a',
            old_string: text,
            new_string: `${text}-after`,
          },
          status: ToolCallStatus.Success,
          resultDisplay: text,
          confirmationDetails: undefined,
        },
      ],
    });
    const first = source(-10, 'batch-first', 'first');
    const second = source(-11, 'batch-second', 'second');
    let items: readonly LiveHistoryItem[] = [];
    items = foldLiveEvent(items, {
      type: 'tool-start',
      id: 'same-wire-id',
      tool: 'replace',
      title: 'first',
    });
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: first,
      pending: false,
    });
    items = foldLiveEvent(items, {
      type: 'tool-end',
      id: 'same-wire-id',
      success: true,
      summary: 'ok',
    });
    expect(snapshotCanonicalHistory(items)).toEqual([first]);
    items = foldLiveEvent(items, {
      type: 'tool-start',
      id: 'same-wire-id',
      tool: 'replace',
      title: 'second',
    });
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: second,
      pending: true,
    });
    expect(
      snapshotCanonicalHistory(items.filter((item) => !item.canonicalPending)),
    ).toEqual([first]);
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: second,
      pending: false,
    });
    items = foldLiveEvent(items, {
      type: 'tool-end',
      id: 'same-wire-id',
      success: true,
      summary: 'ok',
    });
    expect(snapshotCanonicalHistory(items)).toEqual([first, second]);
    expect(snapshotCanonicalHistory(items).map((item) => item.id)).toEqual([
      -10, -11,
    ]);
  });
});
