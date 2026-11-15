/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_DINGTALK_PENDING_LIMIT,
  ManagedDingtalkStateStore,
  validManagedDingtalkState,
} from './managed-state.js';
import type { ManagedDingtalkState } from './managed-state.js';
import type { ManagedInboundEvent } from '@qwen-code/channel-base';

// #17173 R1-33: the state store had no dedicated suite. Pin the save/load
// round-trip, one rejection per validated field, ENOENT -> undefined and a
// corrupt/invalid file -> throw, so a loosened guard reds a case.

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-dingtalk-state-'));
  tempDirs.push(dir);
  return dir;
}
beforeEach(() => {
  vi.stubEnv('QWEN_HOME', tempHome());
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function inbound(eventId: string): ManagedInboundEvent {
  return {
    accountGeneration: 1,
    platformEventId: eventId,
    semanticRevision: 1,
    scope: { kind: 'chat_thread', senderId: null, chatId: 'c', threadId: 't' },
    senderId: 's',
    chatId: 'c',
    threadId: 't',
    subject: null,
    text: 'hello',
    attachments: [],
    replyContext: { sessionWebhook: 'https://example.invalid' },
  };
}

function baseState(): ManagedDingtalkState {
  return {
    version: 1,
    generation: 1,
    pending: [],
    outbound: [],
    recent: [],
    webhooks: {},
  };
}

function populatedState(): ManagedDingtalkState {
  return {
    version: 1,
    generation: 3,
    instanceRefusals: 2,
    pending: [{ eventId: 'e1', event: inbound('e1'), inputId: 'i1' }],
    outbound: [
      {
        deliveryId: 'd1',
        ordinal: 0,
        messageId: 'm1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: 'p1',
          acceptedAt: 1_700_000_000_000,
        },
      },
      { deliveryId: 'd2', ordinal: 1, messageId: 'm2' },
    ],
    recent: ['e0'],
    webhooks: { c: 'https://example.invalid/hook' },
  };
}

describe('validManagedDingtalkState', () => {
  it('accepts a minimal and a fully populated state', () => {
    expect(validManagedDingtalkState(baseState())).toBe(true);
    expect(validManagedDingtalkState(populatedState())).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validManagedDingtalkState(null)).toBe(false);
    expect(validManagedDingtalkState('state')).toBe(false);
  });

  it('rejects a bad version or generation', () => {
    expect(validManagedDingtalkState({ ...baseState(), version: 2 })).toBe(
      false,
    );
    expect(validManagedDingtalkState({ ...baseState(), generation: 0 })).toBe(
      false,
    );
    expect(validManagedDingtalkState({ ...baseState(), generation: 1.5 })).toBe(
      false,
    );
  });

  it('rejects a bad instanceRefusals but allows it absent', () => {
    expect(validManagedDingtalkState(baseState())).toBe(true);
    expect(
      validManagedDingtalkState({ ...baseState(), instanceRefusals: -1 }),
    ).toBe(false);
    expect(
      validManagedDingtalkState({ ...baseState(), instanceRefusals: 0.5 }),
    ).toBe(false);
  });

  it('rejects a pending entry with a bad eventId, event or inputId', () => {
    const withPending = (entry: unknown): ManagedDingtalkState => ({
      ...baseState(),
      pending: [entry as ManagedDingtalkState['pending'][number]],
    });
    expect(
      validManagedDingtalkState(
        withPending({ eventId: '', event: inbound('e1') }),
      ),
    ).toBe(false);
    // The persisted event must be the exact admitted event, keyed by id.
    expect(
      validManagedDingtalkState(
        withPending({ eventId: 'e1', event: inbound('other') }),
      ),
    ).toBe(false);
    expect(
      validManagedDingtalkState(
        withPending({ eventId: 'e1', event: inbound('e1'), inputId: 7 }),
      ),
    ).toBe(false);
    expect(validManagedDingtalkState(withPending(null))).toBe(false);
  });

  it('rejects pending beyond the admission limit', () => {
    const pending = Array.from(
      { length: MANAGED_DINGTALK_PENDING_LIMIT + 1 },
      (_, i) => ({ eventId: `e${i}`, event: inbound(`e${i}`) }),
    );
    expect(validManagedDingtalkState({ ...baseState(), pending })).toBe(false);
  });

  it('rejects an outbound entry with a bad deliveryId, ordinal, messageId or receipt', () => {
    const good = populatedState().outbound[1];
    const withOutbound = (entry: unknown): ManagedDingtalkState => ({
      ...baseState(),
      outbound: [entry as ManagedDingtalkState['outbound'][number]],
    });
    expect(
      validManagedDingtalkState(withOutbound({ ...good, deliveryId: '' })),
    ).toBe(false);
    expect(
      validManagedDingtalkState(withOutbound({ ...good, ordinal: -1 })),
    ).toBe(false);
    expect(
      validManagedDingtalkState(withOutbound({ ...good, messageId: '' })),
    ).toBe(false);
    expect(
      validManagedDingtalkState(
        withOutbound({ ...good, receipt: { outcome: 'accepted' } }),
      ),
    ).toBe(false);
  });

  it('rejects outbound beyond the shared ledger cap', () => {
    const outbound = Array.from({ length: 65 }, (_, i) => ({
      deliveryId: `d${i}`,
      ordinal: i,
      messageId: `m${i}`,
    }));
    expect(validManagedDingtalkState({ ...baseState(), outbound })).toBe(false);
  });

  it('rejects a bad recent window', () => {
    expect(validManagedDingtalkState({ ...baseState(), recent: [7] })).toBe(
      false,
    );
    expect(
      validManagedDingtalkState({
        ...baseState(),
        recent: Array.from({ length: 257 }, (_, i) => `e${i}`),
      }),
    ).toBe(false);
  });

  it('rejects a bad webhook map', () => {
    expect(
      validManagedDingtalkState({ ...baseState(), webhooks: { '': 'x' } }),
    ).toBe(false);
    expect(
      validManagedDingtalkState({ ...baseState(), webhooks: { c: '' } }),
    ).toBe(false);
    expect(
      validManagedDingtalkState({
        ...baseState(),
        webhooks: [] as unknown as Record<string, string>,
      }),
    ).toBe(false);
  });
});

describe('ManagedDingtalkStateStore', () => {
  function store(): ManagedDingtalkStateStore {
    return new ManagedDingtalkStateStore('robot', tempHome(), 'client-1');
  }

  it('round-trips a populated state through save and load', () => {
    const s = store();
    const state = populatedState();
    s.save(state);
    expect(s.load()).toEqual(state);
  });

  it('returns undefined when no state file exists (ENOENT)', () => {
    expect(store().load()).toBeUndefined();
  });

  it('throws on a corrupt (unparseable) file', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    writeFileSync(s.file, '{not json');
    expect(() => s.load()).toThrow(/unreadable or invalid/);
  });

  it('throws on a parseable but invalid state', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    writeFileSync(s.file, JSON.stringify({ ...baseState(), generation: 0 }));
    expect(() => s.load()).toThrow(/unreadable or invalid/);
  });
});
