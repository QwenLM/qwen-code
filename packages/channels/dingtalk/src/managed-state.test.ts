/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_DINGTALK_PENDING_LIMIT,
  ManagedDingtalkStateStore,
  RECENT_LIMIT,
  WEBHOOK_LIMIT,
  validManagedDingtalkState,
} from './managed-state.js';
import type { ManagedDingtalkState } from './managed-state.js';
import {
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
  MANAGED_OUTBOUND_LIMIT,
  type ManagedInboundEvent,
} from '@qwen-code/channel-base';

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

  // R1-1: the adapter routinely writes ledgers at exactly these caps, so the
  // accepting side must be pinned too — flipping a `<=` to `<` would otherwise
  // leave the suite green while the adapter's own steady state fails to load.
  it('accepts each ledger at its exact cap (the adapter steady state)', () => {
    expect(
      validManagedDingtalkState({
        ...baseState(),
        outbound: Array.from({ length: MANAGED_OUTBOUND_LIMIT }, (_, i) => ({
          deliveryId: `d${i}`,
          ordinal: i,
          messageId: `m${i}`,
        })),
      }),
    ).toBe(true);
    expect(
      validManagedDingtalkState({
        ...baseState(),
        recent: Array.from({ length: RECENT_LIMIT }, (_, i) => `e${i}`),
      }),
    ).toBe(true);
    expect(
      validManagedDingtalkState({
        ...baseState(),
        webhooks: Object.fromEntries(
          Array.from({ length: WEBHOOK_LIMIT }, (_, i) => [
            `conv-${i}`,
            `https://example.invalid/hook-${i}`,
          ]),
        ),
      }),
    ).toBe(true);
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
    const outbound = Array.from(
      { length: MANAGED_OUTBOUND_LIMIT + 1 },
      (_, i) => ({
        deliveryId: `d${i}`,
        ordinal: i,
        messageId: `m${i}`,
      }),
    );
    expect(validManagedDingtalkState({ ...baseState(), outbound })).toBe(false);
  });

  it('rejects a bad recent window', () => {
    expect(validManagedDingtalkState({ ...baseState(), recent: [7] })).toBe(
      false,
    );
    expect(
      validManagedDingtalkState({
        ...baseState(),
        recent: Array.from({ length: RECENT_LIMIT + 1 }, (_, i) => `e${i}`),
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
    expect(
      validManagedDingtalkState({
        ...baseState(),
        webhooks: Object.fromEntries(
          Array.from({ length: WEBHOOK_LIMIT + 1 }, (_, i) => [
            `conv-${i}`,
            `https://example.invalid/hook-${i}`,
          ]),
        ),
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

  it('throws on a corrupt (unparseable) file, naming the file and keeping the cause', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    writeFileSync(s.file, '{not json');
    let caught: unknown;
    try {
      s.load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(s.file);
    expect((caught as Error).message).toMatch(/is not valid JSON/);
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('throws on a parseable but invalid state, naming the file', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    writeFileSync(s.file, JSON.stringify({ ...baseState(), generation: 0 }));
    let caught: unknown;
    try {
      s.load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(s.file);
    expect((caught as Error).message).toMatch(/is invalid/);
  });

  it('an I/O read failure is distinct from a corrupt state and keeps the cause', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    // A directory at the ledger path makes readFileSync fail with an I/O error
    // (EISDIR on POSIX), not a corrupt state; the diagnostic names the file and
    // keeps the cause so an unreadable ledger is distinguishable from an invalid
    // sibling under the same entry directory. The errno is platform-specific.
    mkdirSync(s.file);
    let caught: unknown;
    try {
      s.load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(s.file);
    expect((caught as Error).message).toMatch(/could not be read/);
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('reports a stranded legacy ledger on upgrade, without adopting it', () => {
    const s = store();
    mkdirSync(s.directory, { recursive: true });
    // Seed the pre-upgrade single ledger with one pending claim and one
    // outbound segment; the identity-keyed ledger does not exist yet.
    const legacy = {
      ...baseState(),
      pending: [{ eventId: 'dingtalk:m1', event: inbound('m1') }],
      outbound: [{ deliveryId: 'd-1', ordinal: 0, messageId: 'm-1' }],
    };
    writeFileSync(
      join(s.directory, 'managed-state.json'),
      JSON.stringify(legacy),
    );
    const stranded = s.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.path).toBe(join(s.directory, 'managed-state.json'));
    expect(stranded!.pending).toBe(1);
    expect(stranded!.outbound).toBe(1);
    // The legacy ledger is reported, not adopted: load() still returns undefined
    // (the identity-keyed file is absent), so no pending replays across identities.
    expect(s.load()).toBeUndefined();
    // Once the identity-keyed ledger exists, the legacy file is no longer reported.
    s.save(baseState());
    expect(s.strandedLegacyLedger()).toBeUndefined();
  });

  it('no stranded legacy ledger when none exists', () => {
    const s = store();
    expect(s.strandedLegacyLedger()).toBeUndefined();
  });

  it('keeps the state file 0600 inside a 0700 directory (R4)', () => {
    const s = store();
    s.save(populatedState());
    // The state carries live sessionWebhook bearer capabilities; the mode is
    // load-bearing, not cosmetic. Mask to the permission bits: the save path
    // sets them explicitly, independent of the process umask.
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(statSync(s.directory).mode & 0o777).toBe(0o700);
  });

  it('preserves the fs error on cause when the save fails (R1-3)', () => {
    const s = store();
    s.save(populatedState());
    // A read-only directory makes the temp-file open fail with EACCES; the
    // wrapper must carry it on cause so the adapter logs can distinguish
    // ENOSPC / EACCES / read-only mount.
    chmodSync(s.directory, 0o500);
    try {
      let thrown: unknown;
      try {
        s.save(populatedState());
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toMatch(/could not be saved/);
      expect((thrown as Error).cause).toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(s.directory, 0o700);
    }
  });

  it('keys the lock directory by name and clientId per workspace scope', () => {
    const cwd = tempHome();
    const a = new ManagedDingtalkStateStore('robot', cwd, 'client-1');
    // Determinism: a fresh store with the same inputs resolves the SAME
    // directory, or a restart silently loses every un-receipted claim.
    expect(
      new ManagedDingtalkStateStore('robot', cwd, 'client-1').directory,
    ).toBe(a.directory);
    // The name and clientId are part of the key: a renamed entry or a different
    // robot app is a different directory (and a different connection lock).
    expect(
      new ManagedDingtalkStateStore('other', cwd, 'client-1').directory,
    ).not.toBe(a.directory);
    expect(
      new ManagedDingtalkStateStore('robot', cwd, 'client-2').directory,
    ).not.toBe(a.directory);
    // The workspace-scope term is load-bearing: two cwds must not collapse onto
    // one directory.
    expect(
      new ManagedDingtalkStateStore('robot', tempHome(), 'client-1').directory,
    ).not.toBe(a.directory);
    expect(a.directory).toBe(
      join(
        getGlobalQwenDir(),
        'channels',
        getWorkspaceScopeDirName(cwd),
        basename(a.directory),
      ),
    );
  });

  it('keys the ledger file by registration identity beneath the shared entry directory', () => {
    const cwd = tempHome();
    const a = new ManagedDingtalkStateStore(
      'robot',
      cwd,
      'client-1',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    const b = new ManagedDingtalkStateStore(
      'robot',
      cwd,
      'client-1',
      'cp|tenant-b|chan-1|actor|ws|.',
    );
    // The connection lock stays per entry: both registrations share ONE
    // directory (so two instances of the robot app contend for one lock).
    expect(b.directory).toBe(a.directory);
    // The ledger is file-deep isolated: a different registration identity keys
    // a different file, so A's pending is never loaded under B.
    expect(b.file).not.toBe(a.file);
    expect(basename(a.file)).toMatch(/^managed-state-[0-9a-f]{16}\.json$/);
    // Determinism: the same identity resolves the same ledger file.
    expect(
      new ManagedDingtalkStateStore(
        'robot',
        cwd,
        'client-1',
        'cp|tenant-a|chan-1|actor|ws|.',
      ).file,
    ).toBe(a.file);
    // Each ownership field changes the ledger key.
    for (const identity of [
      'cp|tenant-a|chan-1|other-actor|ws|.',
      'cp|tenant-a|chan-1|actor|ws-2|.',
      'cp|tenant-a|chan-1|actor|ws|sub',
      'cp|tenant-a|chan-2|actor|ws|.',
      'other-cp|tenant-a|chan-1|actor|ws|.',
    ]) {
      expect(
        new ManagedDingtalkStateStore('robot', cwd, 'client-1', identity).file,
      ).not.toBe(a.file);
    }
  });
});
