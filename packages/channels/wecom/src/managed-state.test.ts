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
import { basename, join } from 'node:path';
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
      validManagedWecomState({ ...baseState(), instanceRefusals: 0 }),
    ).toBe(true);
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
    // Isolate the eventId length guard: a matching empty platformEventId means
    // only the non-empty eventId clause can reject this.
    expect(
      validManagedWecomState(withPending({ eventId: '', event: inbound('') })),
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

  it('rejects a pending event missing any field the re-drive reads', () => {
    // resubmitPending re-drives the persisted event verbatim; a partial state
    // that loads would drop the claim with a misleading line (allowlist) or
    // submit it without chat/scope (open). Each required field must fail closed.
    const withEvent = (event: unknown): ManagedWecomState => ({
      ...baseState(),
      pending: [{ eventId: 'e1', event: event as ManagedInboundEvent }],
    });
    const drop = (key: keyof ManagedInboundEvent) => {
      const event = { ...inbound('e1') } as Record<string, unknown>;
      delete event[key];
      return withEvent(event);
    };
    for (const key of [
      'senderId',
      'chatId',
      'threadId',
      'accountGeneration',
      'semanticRevision',
      'scope',
      'attachments',
      'replyContext',
    ] as const) {
      expect(validManagedWecomState(drop(key))).toBe(false);
    }
    // Empty-string ids and out-of-range generations must not load either.
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), senderId: '' })),
    ).toBe(false);
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), chatId: '' })),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), accountGeneration: 0 }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), semanticRevision: 2 }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), scope: { kind: 'other' } }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), attachments: 'none' }),
      ),
    ).toBe(false);
    // The nested carriers are load-bearing: a presence-only scope/replyContext
    // check would load a hand-repaired state whose claim is refused (scope) or
    // whose reply settles rejected with no chatId (replyContext).
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), scope: { kind: 'chat_thread' } }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          scope: {
            kind: 'chat_thread',
            senderId: null,
            chatId: '',
            threadId: 'c',
          },
        }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          scope: {
            kind: 'chat_thread',
            senderId: null,
            chatId: 'c',
            threadId: '',
          },
        }),
      ),
    ).toBe(false);
    // The base contract fixes scope.senderId to literally null.
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          scope: {
            kind: 'chat_thread',
            senderId: 's',
            chatId: 'c',
            threadId: 'c',
          },
        }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), replyContext: {} })),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), replyContext: null }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), replyContext: { chatId: '' } }),
      ),
    ).toBe(false);
    // send() gates the whole delivery on replyContext.senderId (senderAllowed);
    // a context missing it would load and settle the reply rejected silently.
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          replyContext: { chatId: 'c', botId: 'bot-1' },
        }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          replyContext: { chatId: 'c', senderId: '' },
        }),
      ),
    ).toBe(false);
    // Isolate the chatId guard with a valid senderId so the senderId clause
    // cannot mask it: missing chatId and empty chatId must each reject on the
    // chatId clause alone (otherwise deleting that clause stays green).
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          replyContext: { senderId: 's', botId: 'bot-1' },
        }),
      ),
    ).toBe(false);
    expect(
      validManagedWecomState(
        withEvent({
          ...inbound('e1'),
          replyContext: { chatId: '', senderId: 's', botId: 'bot-1' },
        }),
      ),
    ).toBe(false);
    // subject is submitted on re-drive; a non-string/non-null must fail closed.
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), subject: 42 })),
    ).toBe(false);
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), subject: 'x' })),
    ).toBe(true);
    // threadId empty string must reject on its own length guard.
    expect(
      validManagedWecomState(withEvent({ ...inbound('e1'), threadId: '' })),
    ).toBe(false);
    // accountGeneration non-integer must reject on the isSafeInteger half.
    expect(
      validManagedWecomState(
        withEvent({ ...inbound('e1'), accountGeneration: 1.5 }),
      ),
    ).toBe(false);
    // No over-rejection: the intact carriers the adapter actually writes load.
    expect(validManagedWecomState(withEvent(inbound('e1')))).toBe(true);
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
      validManagedWecomState(withOutbound({ ...good, ordinal: 1.5 })),
    ).toBe(false);
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
    // A directory sitting at the ledger path makes readFileSync fail with an
    // I/O error (EISDIR on POSIX), not a corrupt state. The diagnostic must name
    // the file and keep the cause so the operator can tell an unreadable ledger
    // from an invalid sibling under the same entry directory. The errno itself
    // is platform-specific, so only the cause's presence is pinned here.
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
    // The full path prefix, not just the leaf regex. basename (not split('/'))
    // so the leaf derivation is correct on the Windows lane too.
    expect(a.directory).toBe(
      join(
        getGlobalQwenDir(),
        'channels',
        getWorkspaceScopeDirName(cwd),
        basename(a.directory),
      ),
    );
  });

  it('an early open failure leaves the prior state loadable', () => {
    const s = store();
    s.save(populatedState());
    const before = s.load();
    // Remove the directory's write bit so the temp-file open fails before any
    // write. An in-place write would instead truncate the prior state; the
    // atomic temp+rename must leave it intact.
    chmodSync(s.directory, 0o500);
    try {
      let caught: unknown;
      try {
        s.save({ ...baseState(), generation: 9 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/could not be saved/);
      // The underlying fs error survives as the cause (sibling-store parity),
      // so the adapter's loss diagnostic can name the real fault, not only the
      // fixed sentence.
      expect((caught as Error).cause).toBeInstanceOf(Error);
    } finally {
      chmodSync(s.directory, 0o700);
    }
    expect(s.load()).toEqual(before);
  });

  it('save cleans up the temp file when the rename fails after the write', () => {
    const s = store();
    s.save(populatedState());
    // Replace the state file with a directory: the temp open/write/fsync all
    // succeed, then renameSync(temp, file) fails EISDIR — a failure AFTER the
    // temp file exists. This is the case the cleanup is named for: without the
    // finally rmSync, each attempt leaks one <uuid>.tmp with nothing to sweep it.
    rmSync(s.file);
    mkdirSync(s.file);
    expect(() => s.save({ ...baseState(), generation: 9 })).toThrow(
      /could not be saved/,
    );
    expect(readdirSync(s.directory).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
  });
});
