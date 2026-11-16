/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_WECOM_PENDING_LIMIT,
  ManagedWecomStateStore,
  RECENT_LIMIT,
  validManagedWecomState,
} from './managed-state.js';
import type { ManagedWecomState } from './managed-state.js';
import {
  MANAGED_OUTBOUND_LIMIT,
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
  type ManagedInboundEvent,
} from '@qwen-code/channel-base';

// Mirror the DingTalk state suite: pin the save/load round-trip, one rejection
// per validated field, ENOENT -> undefined and a corrupt/invalid file ->
// throw, so a loosened guard reds a case. The WeCom state has no webhook map
// (a reply rides the live WebSocket keyed by chatid, no bearer capability).

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-wecom-state-'));
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
    scope: { kind: 'chat_thread', senderId: null, chatId: 'c', threadId: 'c' },
    senderId: 's',
    chatId: 'c',
    threadId: 'c',
    subject: null,
    text: 'hello',
    attachments: [],
    replyContext: { chatId: 'c', senderId: 's', botId: 'bot-1' },
  };
}

function baseState(): ManagedWecomState {
  return {
    version: 1,
    generation: 1,
    pending: [],
    outbound: [],
    recent: [],
  };
}

function populatedState(): ManagedWecomState {
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
  };
}

describe('validManagedWecomState', () => {
  it('accepts a minimal and a fully populated state', () => {
    expect(validManagedWecomState(baseState())).toBe(true);
    expect(validManagedWecomState(populatedState())).toBe(true);
  });

  // The adapter routinely writes ledgers at exactly these caps, so the
  // accepting side must be pinned too — flipping a `<=` to `<` would otherwise
  // leave the suite green while the adapter's own steady state fails to load.
  it('accepts each ledger at its exact cap (the adapter steady state)', () => {
    expect(
      validManagedWecomState({
        ...baseState(),
        outbound: Array.from({ length: MANAGED_OUTBOUND_LIMIT }, (_, i) => ({
          deliveryId: `d${i}`,
          ordinal: i,
          messageId: `m${i}`,
        })),
      }),
    ).toBe(true);
    expect(
      validManagedWecomState({
        ...baseState(),
        recent: Array.from({ length: RECENT_LIMIT }, (_, i) => `e${i}`),
      }),
    ).toBe(true);
    expect(
      validManagedWecomState({
        ...baseState(),
        pending: Array.from(
          { length: MANAGED_WECOM_PENDING_LIMIT },
          (_, i) => ({
            eventId: `e${i}`,
            event: inbound(`e${i}`),
          }),
        ),
      }),
    ).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validManagedWecomState(null)).toBe(false);
    expect(validManagedWecomState('state')).toBe(false);
  });

  it('rejects a bad version or generation', () => {
    expect(validManagedWecomState({ ...baseState(), version: 2 })).toBe(false);
    expect(validManagedWecomState({ ...baseState(), generation: 0 })).toBe(
      false,
    );
    expect(validManagedWecomState({ ...baseState(), generation: 1.5 })).toBe(
      false,
    );
  });

  it('rejects a bad instanceRefusals but allows it absent', () => {
    expect(validManagedWecomState(baseState())).toBe(true);
    expect(
      validManagedWecomState({ ...baseState(), instanceRefusals: -1 }),
    ).toBe(false);
    expect(
      validManagedWecomState({ ...baseState(), instanceRefusals: 0.5 }),
    ).toBe(false);
  });

  it('rejects a pending entry with a bad eventId, event or inputId', () => {
    const withPending = (entry: unknown): ManagedWecomState => ({
      ...baseState(),
      pending: [entry as ManagedWecomState['pending'][number]],
    });
    expect(
      validManagedWecomState(
        withPending({ eventId: '', event: inbound('e1') }),
      ),
    ).toBe(false);
    // The persisted event must be the exact admitted event, keyed by id.
    expect(
      validManagedWecomState(
        withPending({ eventId: 'e1', event: inbound('other') }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withPending({ eventId: 'e1', event: inbound('e1'), inputId: 7 }),
      ),
    ).toBe(false);
    expect(validManagedWecomState(withPending(null))).toBe(false);
    // held is persisted and re-read; a non-boolean must fail closed (the stall
    // re-arm reads truthiness, the lift/sort require === true).
    expect(
      validManagedWecomState(
        withPending({ eventId: 'e1', event: inbound('e1'), held: 'yes' }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withPending({ eventId: 'e1', event: inbound('e1'), held: 'false' }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withPending({ eventId: 'e1', event: inbound('e1'), held: true }),
      ),
    ).toBe(true);
    // The event body guards: a non-string text or a non-object event must not
    // load and re-drive verbatim into submitInbound.
    expect(
      validManagedWecomState(
        withPending({
          eventId: 'e1',
          event: { ...inbound('e1'), text: 42 },
        }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(withPending({ eventId: 'e1', event: 'e1' })),
    ).toBe(false);
  });

  it('rejects pending beyond the admission limit', () => {
    const pending = Array.from(
      { length: MANAGED_WECOM_PENDING_LIMIT + 1 },
      (_, i) => ({ eventId: `e${i}`, event: inbound(`e${i}`) }),
    );
    expect(validManagedWecomState({ ...baseState(), pending })).toBe(false);
  });

  it('rejects an outbound entry with a bad deliveryId, ordinal, messageId or receipt', () => {
    const good = populatedState().outbound[1];
    const withOutbound = (entry: unknown): ManagedWecomState => ({
      ...baseState(),
      outbound: [entry as ManagedWecomState['outbound'][number]],
    });
    expect(
      validManagedWecomState(withOutbound({ ...good, deliveryId: '' })),
    ).toBe(false);
    expect(validManagedWecomState(withOutbound({ ...good, ordinal: -1 }))).toBe(
      false,
    );
    expect(
      validManagedWecomState(withOutbound({ ...good, messageId: '' })),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withOutbound({ ...good, receipt: { outcome: 'accepted' } }),
      ),
    ).toBe(false);
  });

  it('rejects outbound beyond the shared ledger cap', () => {
    const outbound = Array.from(
      { length: MANAGED_OUTBOUND_LIMIT + 1 },
      (_, i) => ({
        deliveryId: `d${i}`,
        ordinal: i,
        messageId: `m${i}`,
      }),
    );
    expect(validManagedWecomState({ ...baseState(), outbound })).toBe(false);
  });

  it('rejects a bad recent window', () => {
    expect(validManagedWecomState({ ...baseState(), recent: [7] })).toBe(false);
    expect(
      validManagedWecomState({
        ...baseState(),
        recent: Array.from({ length: RECENT_LIMIT + 1 }, (_, i) => `e${i}`),
      }),
    ).toBe(false);
  });
});

describe('ManagedWecomStateStore', () => {
  function store(): ManagedWecomStateStore {
    return new ManagedWecomStateStore('bot', tempHome(), 'bot-1');
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

  it('keeps the state file 0600 inside a 0700 directory', () => {
    const s = store();
    s.save(populatedState());
    // Mask to the permission bits: the save path sets them explicitly,
    // independent of the process umask.
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(statSync(s.directory).mode & 0o777).toBe(0o700);
  });

  it('scopes the directory by name and bot id', () => {
    const cwd = tempHome();
    const a = new ManagedWecomStateStore('bot', cwd, 'bot-1');
    const b = new ManagedWecomStateStore('bot', cwd, 'bot-2');
    expect(a.directory).not.toBe(b.directory);
    expect(a.directory).toMatch(/wecom-[0-9a-f]{16}$/);
    // The name is part of the key: a renamed entry is a different directory.
    const renamed = new ManagedWecomStateStore('other', cwd, 'bot-1');
    expect(renamed.directory).not.toBe(a.directory);
  });

  it('keys the directory deterministically on the canonical workspace scope', () => {
    const cwd = tempHome();
    const a = new ManagedWecomStateStore('bot', cwd, 'bot-1');
    // Determinism: a fresh store with the same inputs must resolve the SAME
    // directory, or a restart silently loses every un-receipted claim.
    const again = new ManagedWecomStateStore('bot', cwd, 'bot-1');
    expect(again.directory).toBe(a.directory);
    // The workspace-scope term is load-bearing: two cwds must not collapse
    // onto one directory (which would re-drive A's claims into B).
    const otherCwd = tempHome();
    const elsewhere = new ManagedWecomStateStore('bot', otherCwd, 'bot-1');
    expect(elsewhere.directory).not.toBe(a.directory);
    // The full path prefix, not just the leaf regex.
    expect(a.directory).toBe(
      join(
        getGlobalQwenDir(),
        'channels',
        getWorkspaceScopeDirName(cwd),
        a.directory.split('/').pop()!,
      ),
    );
  });

  it('save is atomic: a write failure leaves the prior state loadable and no tmp', () => {
    const s = store();
    s.save(populatedState());
    const before = s.load();
    // Force a real write failure: remove the directory's write bit so the
    // temp-file open fails. An in-place write would instead truncate the
    // prior state; the atomic temp+rename must leave it intact.
    chmodSync(s.directory, 0o500);
    try {
      expect(() => s.save({ ...baseState(), generation: 9 })).toThrow(
        /could not be saved/,
      );
    } finally {
      chmodSync(s.directory, 0o700);
    }
    expect(s.load()).toEqual(before);
    expect(readdirSync(s.directory).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
  });
});
