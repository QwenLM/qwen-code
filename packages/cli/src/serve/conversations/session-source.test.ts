/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  classifyTopLevelConversationSource,
  isReservedLiveSessionSource,
  isReservedStandaloneSessionSource,
  readLoadableConversationSession,
  readLoadableLiveConversationMetadata,
  type ConversationSessionMetadataStore,
  type LiveSessionCreationMetadata,
} from './session-source.js';

const LIVE_ID = '550e8400-e29b-41d4-a716-446655440000';
const LIVE_CHILD_ID = '550e8400-e29b-41d4-a716-446655440001';
const LEGACY_ID = '550e8400-e29b-41d4-a716-446655440002';
const LEGACY_CHILD_ID = '550e8400-e29b-41d4-a716-446655440003';
const EXPLICIT_ID = '550e8400-e29b-41d4-a716-446655440004';
const EXPLICIT_CHILD_ID = '550e8400-e29b-41d4-a716-446655440005';
const DELETED_PARENT_ID = '550e8400-e29b-41d4-a716-446655440006';
const ORPHAN_ID = '550e8400-e29b-41d4-a716-446655440007';
const GRANDCHILD_ID = '550e8400-e29b-41d4-a716-446655440008';
const ATTRIBUTED_CHILD_ID = '550e8400-e29b-41d4-a716-446655440009';
const MALFORMED_LIVE_ID = '550e8400-e29b-41d4-a716-44665544000a';
const SELF_ID = '550e8400-e29b-41d4-a716-44665544000b';
const CYCLE_A_ID = '550e8400-e29b-41d4-a716-44665544000c';
const CYCLE_B_ID = '550e8400-e29b-41d4-a716-44665544000d';
const LEGACY_CHILD_OF_EXPLICIT_ID = '550e8400-e29b-41d4-a716-44665544000e';
const SELF_STANDALONE_ID = '550e8400-e29b-41d4-a716-44665544000f';
const MALFORMED_PARENT_STANDALONE_ID = '550e8400-e29b-41d4-a716-446655440010';

function createStore(
  records: ReadonlyMap<string, LiveSessionCreationMetadata>,
): ConversationSessionMetadataStore {
  return {
    async getSessionLocation(sessionId) {
      return records.has(sessionId) ? 'active' : undefined;
    },
    async readCreationMetadataIfReadable(sessionId) {
      return records.get(sessionId) ?? {};
    },
  };
}

describe('conversation session source classification', () => {
  const records = new Map<string, LiveSessionCreationMetadata>([
    [LIVE_ID, { sourceType: 'default', sourceId: 'realtime_voice:call-1' }],
    [LIVE_CHILD_ID, { parentSessionId: LIVE_ID }],
    [LEGACY_ID, { sourceType: 'default' }],
    [LEGACY_CHILD_ID, { parentSessionId: LEGACY_ID }],
    [EXPLICIT_ID, { sourceType: 'standalone' }],
    [
      EXPLICIT_CHILD_ID,
      { sourceType: 'standalone', parentSessionId: DELETED_PARENT_ID },
    ],
    [ORPHAN_ID, { parentSessionId: DELETED_PARENT_ID }],
    [GRANDCHILD_ID, { parentSessionId: LEGACY_CHILD_ID }],
    [
      ATTRIBUTED_CHILD_ID,
      {
        parentSessionId: LIVE_ID,
        sourceType: 'default',
        sourceId: 'realtime_voice:forged-worker',
      },
    ],
    [MALFORMED_LIVE_ID, { sourceType: 'default', sourceId: 'realtime_voice:' }],
    [SELF_ID, { parentSessionId: SELF_ID }],
    [CYCLE_A_ID, { parentSessionId: CYCLE_B_ID }],
    [CYCLE_B_ID, { parentSessionId: CYCLE_A_ID }],
    [LEGACY_CHILD_OF_EXPLICIT_ID, { parentSessionId: EXPLICIT_ID }],
    [
      SELF_STANDALONE_ID,
      { sourceType: 'standalone', parentSessionId: SELF_STANDALONE_ID },
    ],
    // Without the `!isValidSessionId` conjunct the explicit-standalone
    // shortcut below the parent guard would accept this record.
    [
      MALFORMED_PARENT_STANDALONE_ID,
      { sourceType: 'standalone', parentSessionId: 'not-a-session-id' },
    ],
  ]);
  const store = createStore(records);

  it('reserves Live and standalone source strings before full validation', () => {
    expect(
      isReservedLiveSessionSource({
        sourceType: 'default',
        sourceId: 'realtime_voice:',
      }),
    ).toBe(true);
    expect(
      isReservedStandaloneSessionSource({ sourceType: 'standalone' }),
    ).toBe(true);
  });

  it('classifies compatible top-level sources', () => {
    expect(
      classifyTopLevelConversationSource(records.get(LIVE_ID)!),
    ).toMatchObject({ kind: 'live', persistence: 'explicit' });
    expect(
      classifyTopLevelConversationSource(records.get(LEGACY_ID)!),
    ).toMatchObject({ kind: 'standalone', persistence: 'legacy' });
    expect(
      classifyTopLevelConversationSource(records.get(EXPLICIT_ID)!),
    ).toMatchObject({ kind: 'standalone', persistence: 'explicit' });
    expect(
      classifyTopLevelConversationSource({
        sourceType: 'standalone',
        sourceId: 'unexpected',
      }),
    ).toBeUndefined();
  });

  it.each([
    [LIVE_ID, 'live', 'explicit'],
    [LIVE_CHILD_ID, 'live', 'legacy'],
    [LEGACY_ID, 'standalone', 'legacy'],
    [LEGACY_CHILD_ID, 'standalone', 'legacy'],
    [EXPLICIT_ID, 'standalone', 'explicit'],
    [EXPLICIT_CHILD_ID, 'standalone', 'explicit'],
    [LEGACY_CHILD_OF_EXPLICIT_ID, 'standalone', 'legacy'],
  ] as const)(
    'classifies %s as %s %s',
    async (sessionId, kind, persistence) => {
      await expect(
        readLoadableConversationSession(sessionId, store),
      ).resolves.toMatchObject({ kind, persistence });
    },
  );

  it.each([
    ORPHAN_ID,
    GRANDCHILD_ID,
    ATTRIBUTED_CHILD_ID,
    MALFORMED_LIVE_ID,
    SELF_ID,
    SELF_STANDALONE_ID,
    MALFORMED_PARENT_STANDALONE_ID,
    CYCLE_A_ID,
  ])('rejects malformed or ambiguous lineage for %s', async (sessionId) => {
    await expect(
      readLoadableConversationSession(sessionId, store),
    ).resolves.toBeUndefined();
  });

  it('keeps the compatibility adapter limited to Live and legacy projectless sessions', async () => {
    await expect(
      readLoadableLiveConversationMetadata(LIVE_CHILD_ID, store),
    ).resolves.toEqual(records.get(LIVE_CHILD_ID));
    await expect(
      readLoadableLiveConversationMetadata(LEGACY_ID, store),
    ).resolves.toEqual(records.get(LEGACY_ID));
    await expect(
      readLoadableLiveConversationMetadata(LEGACY_CHILD_ID, store),
    ).resolves.toEqual(records.get(LEGACY_CHILD_ID));
    await expect(
      readLoadableLiveConversationMetadata(EXPLICIT_ID, store),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableLiveConversationMetadata(EXPLICIT_CHILD_ID, store),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableLiveConversationMetadata(LEGACY_CHILD_OF_EXPLICIT_ID, store),
    ).resolves.toBeUndefined();
  });

  it('rejects missing and conflicting transcripts without reading metadata', async () => {
    let reads = 0;
    const unavailableStore: ConversationSessionMetadataStore = {
      async getSessionLocation(sessionId) {
        return sessionId === LEGACY_ID ? 'conflict' : undefined;
      },
      async readCreationMetadataIfReadable() {
        reads++;
        return {};
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, unavailableStore),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableConversationSession(EXPLICIT_ID, unavailableStore),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('rejects a transcript that disappears while its metadata is read', async () => {
    let locationReads = 0;
    const disappearingStore: ConversationSessionMetadataStore = {
      async getSessionLocation() {
        locationReads++;
        return locationReads === 1 ? 'active' : undefined;
      },
      async readCreationMetadataIfReadable() {
        return {};
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, disappearingStore),
    ).resolves.toBeUndefined();
  });

  it('rejects a transcript whose creation metadata is unreadable', async () => {
    const states: Array<'active' | 'archived'> = [];
    const unreadableStore: ConversationSessionMetadataStore = {
      async getSessionLocation() {
        return 'active';
      },
      async readCreationMetadataIfReadable(_sessionId, state) {
        states.push(state);
        return undefined;
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, unreadableStore),
    ).resolves.toBeUndefined();
    await expect(
      readLoadableLiveConversationMetadata(LEGACY_ID, unreadableStore),
    ).resolves.toBeUndefined();
    expect(states).toEqual(['active', 'active']);
  });

  it('reads archived transcripts with the archived state', async () => {
    const states: Array<'active' | 'archived'> = [];
    const archivedStore: ConversationSessionMetadataStore = {
      async getSessionLocation(sessionId) {
        return records.has(sessionId) ? 'archived' : undefined;
      },
      async readCreationMetadataIfReadable(sessionId, state) {
        states.push(state);
        return records.get(sessionId);
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, archivedStore),
    ).resolves.toMatchObject({ kind: 'standalone', persistence: 'legacy' });
    expect(states).toEqual(['archived']);
  });
});
