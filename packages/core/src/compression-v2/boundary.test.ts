/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Message, SystemMessage } from '../protocol/transcript/message.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import {
  createCompactBoundaryMessage,
  findCompressionBoundary,
} from './boundary.js';

function boundary(): SystemMessage {
  return createCompactBoundaryMessage({
    trigger: 'manual',
    preTokens: 1234,
  });
}

describe('findCompressionBoundary', () => {
  it('returns initial_history when no boundary marker is present', () => {
    const history: Message[] = [
      makeUser([{ type: 'text' as const, text: 'hello' }]),
      makeAssistant([{ type: 'text' as const, text: 'world' }]),
    ];

    expect(findCompressionBoundary(history)).toEqual({
      startIndex: 0,
      prefixContents: [],
      contents: history,
      source: 'initial_history',
    });
  });

  it('does not treat snapshot-tagged user text as a boundary on its own', () => {
    // Pre-refactor the pipeline anchored to the `<state_snapshot>` tag in a
    // user message; now only the `system/compact_boundary` marker counts.
    const history: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: '<state_snapshot>compressed</state_snapshot>',
        },
      ]),
      makeUser([{ type: 'text' as const, text: 'tail' }]),
    ];

    expect(findCompressionBoundary(history).source).toBe('initial_history');
  });

  it('anchors on the most recent system/compact_boundary marker', () => {
    const marker = boundary();
    const tailUser = makeUser([{ type: 'text' as const, text: 'tail' }]);
    const tailAssistant = makeAssistant([
      { type: 'text' as const, text: 'reply' },
    ]);
    const history: Message[] = [
      makeUser([{ type: 'text' as const, text: 'old turn' }]),
      makeAssistant([{ type: 'text' as const, text: 'old reply' }]),
      marker,
      tailUser,
      tailAssistant,
    ];

    const result = findCompressionBoundary(history);

    expect(result.source).toBe('compact_boundary');
    expect(result.startIndex).toBe(3);
    expect(result.prefixContents).toEqual(history.slice(0, 3));
    expect(result.contents).toEqual([tailUser, tailAssistant]);
  });

  it('uses only the latest boundary when several markers exist', () => {
    const oldMarker = boundary();
    const newMarker = boundary();
    const tailUser = makeUser([{ type: 'text' as const, text: 'after-new' }]);
    const history: Message[] = [
      oldMarker,
      makeUser([{ type: 'text' as const, text: 'between' }]),
      newMarker,
      tailUser,
    ];

    const result = findCompressionBoundary(history);

    expect(result.source).toBe('compact_boundary');
    expect(result.contents).toEqual([tailUser]);
  });

  it('keeps attachment messages in `contents` for cache-aligned compaction', () => {
    const marker = boundary();
    const tailUser = makeUser([{ type: 'text' as const, text: 'tail' }]);
    // Attachments expand into model-visible prompt blocks. Compact forks need
    // them so their request prefix matches the parent request cache prefix.
    const attachment: Message = {
      type: 'attachment',
      uuid: 'attach-1',
      timestamp: '2026-04-18T00:00:00Z',
      attachment: { type: 'relevant_memories' },
    };
    const history: Message[] = [marker, attachment, tailUser];

    const result = findCompressionBoundary(history);

    expect(result.contents).toEqual([attachment, tailUser]);
  });

  it('drops non-model-visible system messages from `contents`', () => {
    const marker = boundary();
    const tailUser = makeUser([{ type: 'text' as const, text: 'tail' }]);
    const straySystem: SystemMessage = {
      type: 'system',
      uuid: 'system-1',
      timestamp: '2026-04-18T00:00:00Z',
      subtype: 'informational',
      content: 'local-only status',
      level: 'info',
    };
    const history: Message[] = [marker, straySystem, tailUser];

    const result = findCompressionBoundary(history);

    expect(result.contents).toEqual([tailUser]);
  });
});

describe('createCompactBoundaryMessage', () => {
  it('produces a system/compact_boundary marker carrying compactMetadata', () => {
    const marker = createCompactBoundaryMessage({
      trigger: 'auto',
      preTokens: 87654,
      postTokens: 12345,
      messagesSummarized: 42,
    });

    expect(marker.type).toBe('system');
    expect(marker.subtype).toBe('compact_boundary');
    expect(marker.level).toBe('info');
    expect(marker.compactMetadata).toEqual({
      trigger: 'auto',
      preTokens: 87654,
      postTokens: 12345,
      messagesSummarized: 42,
    });
    expect(typeof marker.uuid).toBe('string');
    expect(marker.uuid.length).toBeGreaterThan(0);
    expect(typeof marker.timestamp).toBe('string');
  });
});
