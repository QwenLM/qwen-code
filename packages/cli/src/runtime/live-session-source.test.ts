/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyTopLevelConversationSource,
  isReservedLiveSessionSource,
  isReservedStandaloneSessionSource,
  readLoadableConversationSession,
  readLoadableLiveConversationMetadata,
  type ConversationSessionMetadataStore,
  type LiveSessionCreationMetadata,
} from './live-session-source.js';

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
const ATTRIBUTED_STANDALONE_CHILD_ID = '550e8400-e29b-41d4-a716-446655440011';
const STANDALONE_CHILD_OF_LIVE_ID = '550e8400-e29b-41d4-a716-446655440012';
const STANDALONE_CYCLE_A_ID = '550e8400-e29b-41d4-a716-446655440013';
const STANDALONE_CYCLE_B_ID = '550e8400-e29b-41d4-a716-446655440014';
const STANDALONE_CHILD_OF_LEGACY_ID = '550e8400-e29b-41d4-a716-446655440015';
const NIL_PARENT_STANDALONE_ID = '550e8400-e29b-41d4-a716-446655440016';
const V7_PARENT_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const V7_CHILD_ID = '550e8400-e29b-41d4-a716-446655440017';
const AGENT_PARENT_ID = `${LIVE_ID}-agent-worker`;
const AGENT_CHILD_ID = '550e8400-e29b-41d4-a716-446655440018';

function createStore(
  records: ReadonlyMap<string, LiveSessionCreationMetadata>,
): ConversationSessionMetadataStore {
  return {
    async readCreationMetadataIfReadable(sessionId, state) {
      return state === 'active' ? records.get(sessionId) : undefined;
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
    // A parent spelling the store cannot resolve leaves an explicit
    // standalone child self-describing, like a deleted parent would.
    [
      MALFORMED_PARENT_STANDALONE_ID,
      { sourceType: 'standalone', parentSessionId: 'not-a-session-id' },
    ],
    // A forged `sourceId` must not ride the explicit-standalone child
    // shortcut, which is reached before the legacy source-pairing guard.
    [
      ATTRIBUTED_STANDALONE_CHILD_ID,
      {
        sourceType: 'standalone',
        sourceId: 'realtime_voice:forged-worker',
        parentSessionId: EXPLICIT_ID,
      },
    ],
    // An explicit standalone child is self-describing, but a parent that is
    // still readable and contradicts depth-1 standalone lineage disqualifies it.
    [
      STANDALONE_CHILD_OF_LIVE_ID,
      { sourceType: 'standalone', parentSessionId: LIVE_ID },
    ],
    [
      STANDALONE_CYCLE_A_ID,
      { sourceType: 'standalone', parentSessionId: STANDALONE_CYCLE_B_ID },
    ],
    [
      STANDALONE_CYCLE_B_ID,
      { sourceType: 'standalone', parentSessionId: STANDALONE_CYCLE_A_ID },
    ],
    [
      STANDALONE_CHILD_OF_LEGACY_ID,
      { sourceType: 'standalone', parentSessionId: LEGACY_ID },
    ],
    // Parents older builds could persist: nil, v7, and agent-suffixed ids are
    // not RFC-4122 v1-v5, but the store resolves them, so lineage must too.
    [
      NIL_PARENT_STANDALONE_ID,
      {
        sourceType: 'standalone',
        parentSessionId: '00000000-0000-0000-0000-000000000000',
      },
    ],
    [V7_PARENT_ID, { sourceType: 'default' }],
    [V7_CHILD_ID, { parentSessionId: V7_PARENT_ID }],
    [
      AGENT_PARENT_ID,
      { sourceType: 'default', sourceId: 'realtime_voice:call-agent' },
    ],
    [AGENT_CHILD_ID, { parentSessionId: AGENT_PARENT_ID }],
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
    [STANDALONE_CHILD_OF_LEGACY_ID, 'standalone', 'explicit'],
    [MALFORMED_PARENT_STANDALONE_ID, 'standalone', 'explicit'],
    [NIL_PARENT_STANDALONE_ID, 'standalone', 'explicit'],
    [V7_CHILD_ID, 'standalone', 'legacy'],
    [AGENT_CHILD_ID, 'live', 'legacy'],
  ] as const)(
    'classifies %s as %s %s',
    async (sessionId, kind, persistence) => {
      await expect(
        readLoadableConversationSession(sessionId, store),
      ).resolves.toMatchObject({ kind, persistence });
    },
  );

  it.each([
    // Parent readable and classified: lineage is proven.
    [LEGACY_CHILD_ID, { kind: 'standalone', persistence: 'legacy' }],
    [
      LEGACY_CHILD_OF_EXPLICIT_ID,
      { kind: 'standalone', persistence: 'explicit' },
    ],
    [LIVE_CHILD_ID, { kind: 'live', persistence: 'explicit' }],
    [
      STANDALONE_CHILD_OF_LEGACY_ID,
      { kind: 'standalone', persistence: 'legacy' },
    ],
    [V7_CHILD_ID, { kind: 'standalone', persistence: 'legacy' }],
    [AGENT_CHILD_ID, { kind: 'live', persistence: 'explicit' }],
  ] as const)(
    'reports the proven parent lineage for %s',
    async (sessionId, lineage) => {
      await expect(
        readLoadableConversationSession(sessionId, store),
      ).resolves.toMatchObject({ parentSource: lineage });
    },
  );

  it.each([
    EXPLICIT_ID,
    LEGACY_ID,
    LIVE_ID,
    EXPLICIT_CHILD_ID,
    MALFORMED_PARENT_STANDALONE_ID,
    NIL_PARENT_STANDALONE_ID,
  ])('leaves the parent lineage unproven for %s', async (sessionId) => {
    // Top-level sessions have no parent, and an explicit standalone child
    // whose parent was archived away or deleted cannot produce one. Callers
    // that need proven lineage must reject on this rather than on `kind`.
    const result = await readLoadableConversationSession(sessionId, store);
    expect(result).toBeDefined();
    expect(result?.parentSource).toBeUndefined();
  });

  it.each([
    ORPHAN_ID,
    GRANDCHILD_ID,
    ATTRIBUTED_CHILD_ID,
    MALFORMED_LIVE_ID,
    SELF_ID,
    SELF_STANDALONE_ID,
    ATTRIBUTED_STANDALONE_CHILD_ID,
    CYCLE_A_ID,
    // Readable parent contradicting depth-1 standalone lineage.
    STANDALONE_CHILD_OF_LIVE_ID,
    STANDALONE_CYCLE_A_ID,
    STANDALONE_CYCLE_B_ID,
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

  it('resolves a conflicted transcript from its active copy', async () => {
    // Both state copies exist (a crash inside archiveSessions leaves that
    // behind): reads use the active copy, matching the CLI resume path.
    const conflictedStore: ConversationSessionMetadataStore = {
      async readCreationMetadataIfReadable(_sessionId, state) {
        return state === 'active' ? { sourceType: 'default' } : {};
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, conflictedStore),
    ).resolves.toMatchObject({ kind: 'standalone', persistence: 'legacy' });
  });

  it('refuses path-unsafe ids without touching the store', async () => {
    let reads = 0;
    const store: ConversationSessionMetadataStore = {
      async readCreationMetadataIfReadable() {
        reads++;
        return {};
      },
    };

    await expect(
      readLoadableConversationSession('../escape', store),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each(['CON', 'nul', 'AUX.txt', 'PRN.', 'COM1', 'lpt9.jsonl'])(
    'refuses Windows device transcript name %s without touching the store',
    async (sessionId) => {
      let reads = 0;
      const deviceStore: ConversationSessionMetadataStore = {
        async readCreationMetadataIfReadable() {
          reads++;
          return {};
        },
      };

      await expect(
        readLoadableConversationSession(sessionId, deviceStore),
      ).resolves.toBeUndefined();
      expect(reads).toBe(0);
    },
  );

  it('resolves a transcript that a concurrent archive moves mid-read', async () => {
    const movingStore: ConversationSessionMetadataStore = {
      async readCreationMetadataIfReadable(_sessionId, state) {
        // The active copy vanished before the read; the archived copy has it.
        return state === 'archived' ? { sourceType: 'default' } : undefined;
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, movingStore),
    ).resolves.toMatchObject({ kind: 'standalone', persistence: 'legacy' });
  });

  it('rejects a transcript whose creation metadata is unreadable', async () => {
    const states: Array<'active' | 'archived'> = [];
    const unreadableStore: ConversationSessionMetadataStore = {
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
    expect(states).toEqual(['active', 'archived', 'active', 'archived']);
  });

  it('reads archived transcripts with the archived state', async () => {
    const states: Array<'active' | 'archived'> = [];
    const archivedStore: ConversationSessionMetadataStore = {
      async readCreationMetadataIfReadable(sessionId, state) {
        states.push(state);
        return state === 'archived' ? records.get(sessionId) : undefined;
      },
    };

    await expect(
      readLoadableConversationSession(LEGACY_ID, archivedStore),
    ).resolves.toMatchObject({ kind: 'standalone', persistence: 'legacy' });
    expect(states).toEqual(['active', 'archived']);
  });
});
