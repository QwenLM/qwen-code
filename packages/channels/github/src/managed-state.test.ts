/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_OUTBOUND_LIMIT } from '@qwen-code/channel-base';
import type { ManagedInboundEvent } from '@qwen-code/channel-base';
import {
  DISPATCHED_COMMENTS_LIMIT,
  MANAGED_GITHUB_PENDING_LIMIT,
  MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT,
  MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT,
  MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT,
  ManagedGithubStateStore,
  validManagedGithubState,
  type ManagedGithubPrWatchPending,
  type ManagedGithubState,
} from './managed-state.js';

// Let one test force a real write failure inside store.save (after the temp
// file is opened) so the save-failure catch/finally actually executes; every
// other call passes through to the real fs.
const fsControl = vi.hoisted(() => ({ failWrite: false, failRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failWrite) {
        throw Object.assign(
          new Error('ENOSPC: no space left on device, write'),
          { code: 'ENOSPC' },
        );
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (fsControl.failRename) {
        throw Object.assign(new Error('EACCES: permission denied, rename'), {
          code: 'EACCES',
        });
      }
      return actual.renameSync(...args);
    }) as typeof actual.renameSync,
  };
});

function event(eventId: string): ManagedInboundEvent {
  return {
    accountGeneration: 1,
    platformEventId: eventId,
    semanticRevision: 1,
    scope: {
      kind: 'chat_thread',
      senderId: null,
      chatId: 'owner/repo',
      threadId: 'issue:7',
    },
    senderId: 'alice',
    chatId: 'owner/repo',
    threadId: 'issue:7',
    subject: 'Issue title',
    text: '@bot-user help',
    attachments: [],
    replyContext: { owner: 'Owner', repo: 'Repo', issueNumber: 7 },
  };
}

function freshState(): ManagedGithubState {
  return {
    version: 1,
    generation: 1,
    cursor: { lastProcessedAt: null, dispatchedComments: [] },
    pending: [],
    outbound: [],
  };
}

describe('validManagedGithubState', () => {
  it('accepts a fresh state and a populated one', () => {
    expect(validManagedGithubState(freshState())).toBe(true);
    const state = freshState();
    state.cursor.lastProcessedAt = '2026-11-16T10:00:00Z';
    state.cursor.dispatchedComments = ['IC_1'];
    state.pending = [
      {
        eventId: 'github:IC_1',
        event: event('github:IC_1'),
        notificationThreadId: 'n-1',
      },
    ];
    state.outbound = [
      {
        deliveryId: 'd-1',
        ordinal: 0,
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: '9001',
          acceptedAt: 1,
        },
      },
    ];
    expect(validManagedGithubState(state)).toBe(true);
  });

  it('rejects a malformed cursor', () => {
    expect(
      validManagedGithubState({
        ...freshState(),
        cursor: { lastProcessedAt: 42, dispatchedComments: [] },
      }),
    ).toBe(false);
    // A non-date watermark would pass load() and then throw RangeError on
    // every tick's since computation, stalling inbound and outbound while
    // connect reports running. The Legacy cursor validator parses the date.
    expect(
      validManagedGithubState({
        ...freshState(),
        cursor: { lastProcessedAt: 'not-a-date', dispatchedComments: [] },
      }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        cursor: { lastProcessedAt: null, dispatchedComments: [7] },
      }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        cursor: {
          lastProcessedAt: null,
          dispatchedComments: Array.from(
            { length: DISPATCHED_COMMENTS_LIMIT + 1 },
            (_, index) => `IC_${index}`,
          ),
        },
      }),
    ).toBe(false);
  });

  it('rejects pending entries without the full event or thread id', () => {
    expect(
      validManagedGithubState({
        ...freshState(),
        pending: [{ eventId: 'github:IC_1', event: event('github:IC_1') }],
      }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        pending: [
          {
            eventId: 'github:IC_other',
            event: event('github:IC_1'),
            notificationThreadId: 'n-1',
          },
        ],
      }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        pending: Array.from(
          { length: MANAGED_GITHUB_PENDING_LIMIT + 1 },
          () => ({
            eventId: 'github:IC_1',
            event: event('github:IC_1'),
            notificationThreadId: 'n-1',
          }),
        ),
      }),
    ).toBe(false);
  });

  it('rejects a malformed outbound ledger', () => {
    expect(
      validManagedGithubState({
        ...freshState(),
        outbound: [
          { deliveryId: 'd-1', ordinal: 0, receipt: { outcome: 'delivered' } },
        ],
      }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        outbound: Array.from(
          { length: MANAGED_OUTBOUND_LIMIT + 1 },
          (_, ordinal) => ({
            deliveryId: 'd-1',
            ordinal,
          }),
        ),
      }),
    ).toBe(false);
  });

  it('accepts each ledger at its exact cap (the adapter steady state)', () => {
    // The adapter trims each ledger to exactly its cap before persisting;
    // tightening any validator bound from <= to < would make load() reject
    // the adapter's own steady-state file and refuse to start.
    const state = freshState();
    state.cursor.dispatchedComments = Array.from(
      { length: DISPATCHED_COMMENTS_LIMIT },
      (_, i) => `IC_${i}`,
    );
    state.pending = Array.from(
      { length: MANAGED_GITHUB_PENDING_LIMIT },
      (_, i) => ({
        eventId: `github:IC_${i}`,
        event: event(`github:IC_${i}`),
        notificationThreadId: 'n-1',
      }),
    );
    state.outbound = Array.from({ length: MANAGED_OUTBOUND_LIMIT }, (_, i) => ({
      deliveryId: `d-${i}`,
      ordinal: i,
    }));
    expect(validManagedGithubState(state)).toBe(true);
  });

  it('rejects a bad version or generation', () => {
    expect(validManagedGithubState({ ...freshState(), version: 2 })).toBe(
      false,
    );
    expect(validManagedGithubState({ ...freshState(), generation: 0 })).toBe(
      false,
    );
    expect(validManagedGithubState(null)).toBe(false);
  });
});

describe('validManagedGithubState watch segment', () => {
  function watchPending(
    overrides: Partial<ManagedGithubPrWatchPending> = {},
  ): ManagedGithubPrWatchPending {
    return {
      key: 'prw:ci_failure:Owner/Repo#9:sha-a:1',
      episode: 1,
      owner: 'Owner',
      repo: 'Repo',
      prNumber: 9,
      transition: 'ci_failure',
      headSha: 'sha-a',
      evidence: 'CI failed on head sha-a.',
      detectedAt: '2026-11-17T10:00:00Z',
      ...overrides,
    };
  }

  function watchState(): ManagedGithubState {
    return {
      ...freshState(),
      watch: {
        prs: {
          'owner/repo#9': {
            headSha: 'sha-a',
            mergeableState: 'clean',
            ci: 'passing',
            ciFiredSha: 'sha-a',
            seq: 2,
            fired: ['prw:ci_failure:Owner/Repo#9:sha-a:1'],
            pending: [watchPending()],
          },
        },
      },
    };
  }

  it('accepts an absent watch (existing state) and a populated one', () => {
    expect(validManagedGithubState(freshState())).toBe(true);
    expect(validManagedGithubState(watchState())).toBe(true);
    expect(
      validManagedGithubState({ ...freshState(), watch: { prs: {} } }),
    ).toBe(true);
    // A baseline-only entry (first observation) is legal.
    expect(
      validManagedGithubState({
        ...freshState(),
        watch: { prs: { 'owner/repo#9': { headSha: 'sha-a' } } },
      }),
    ).toBe(true);
  });

  it('accepts a durable sweep offset and episode watermark, rejects malformed ones', () => {
    const base = watchState();
    const withWatch = (extra: Record<string, unknown>) => ({
      ...freshState(),
      watch: { ...base.watch!, ...extra },
    });
    // A restart must accept the persisted rotation offset and watermark.
    expect(
      validManagedGithubState(
        withWatch({ sweepStart: 0, episodes: { 'owner/repo#9': 3 } }),
      ),
    ).toBe(true);
    expect(validManagedGithubState(withWatch({ sweepStart: 30 }))).toBe(true);
    expect(validManagedGithubState(withWatch({ sweepStart: -1 }))).toBe(false);
    expect(validManagedGithubState(withWatch({ sweepStart: 1.5 }))).toBe(false);
    expect(validManagedGithubState(withWatch({ sweepStart: '0' }))).toBe(false);
    expect(
      validManagedGithubState(withWatch({ episodes: { 'owner/repo#9': 0 } })),
    ).toBe(false);
    expect(
      validManagedGithubState(withWatch({ episodes: { 'owner/repo#9': 1.5 } })),
    ).toBe(false);
    expect(validManagedGithubState(withWatch({ episodes: [] }))).toBe(false);
    expect(validManagedGithubState(withWatch({ episodes: null }))).toBe(false);
    const overCap: Record<string, number> = {};
    for (let i = 0; i <= MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT; i++) {
      overCap[`owner/repo#${i}`] = 1;
    }
    expect(validManagedGithubState(withWatch({ episodes: overCap }))).toBe(
      false,
    );
  });

  it('accepts the fired ring and pending queue at their exact caps', () => {
    const state = watchState();
    const entry = state.watch!.prs['owner/repo#9']!;
    entry.fired = Array.from(
      { length: MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT },
      (_, i) => `prw:head_change:Owner/Repo#9:${i}:1`,
    );
    entry.pending = Array.from(
      { length: MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT },
      (_, i) => watchPending({ key: `prw:head_change:Owner/Repo#9:${i}:1` }),
    );
    expect(validManagedGithubState(state)).toBe(true);
  });

  it('rejects a malformed watch container', () => {
    expect(validManagedGithubState({ ...freshState(), watch: null })).toBe(
      false,
    );
    expect(validManagedGithubState({ ...freshState(), watch: [] })).toBe(false);
    expect(
      validManagedGithubState({ ...freshState(), watch: { prs: [] } }),
    ).toBe(false);
    expect(
      validManagedGithubState({ ...freshState(), watch: { prs: null } }),
    ).toBe(false);
    expect(
      validManagedGithubState({
        ...freshState(),
        watch: { prs: { 'owner/repo#9': null } },
      }),
    ).toBe(false);
  });

  it('rejects a malformed baseline', () => {
    const withEntry = (entry: unknown) => ({
      ...freshState(),
      watch: { prs: { 'owner/repo#9': entry } },
    });
    expect(validManagedGithubState(withEntry({ headSha: '' }))).toBe(false);
    expect(validManagedGithubState(withEntry({ headSha: 42 }))).toBe(false);
    expect(validManagedGithubState(withEntry({ ci: 'failure' }))).toBe(false);
    expect(validManagedGithubState(withEntry({ ci: 'red' }))).toBe(false);
    expect(validManagedGithubState(withEntry({ seq: -1 }))).toBe(false);
    expect(validManagedGithubState(withEntry({ seq: 1.5 }))).toBe(false);
    expect(validManagedGithubState(withEntry({ ciFiredSha: '' }))).toBe(false);
  });

  it('rejects a malformed fired ring', () => {
    const withEntry = (entry: unknown) => ({
      ...freshState(),
      watch: { prs: { 'owner/repo#9': entry } },
    });
    expect(validManagedGithubState(withEntry({ fired: 'key' }))).toBe(false);
    expect(validManagedGithubState(withEntry({ fired: [''] }))).toBe(false);
    expect(validManagedGithubState(withEntry({ fired: [7] }))).toBe(false);
    expect(
      validManagedGithubState(
        withEntry({
          fired: Array.from(
            { length: MANAGED_GITHUB_PR_WATCH_FIRED_LIMIT + 1 },
            (_, i) => `key-${i}`,
          ),
        }),
      ),
    ).toBe(false);
  });

  it('rejects a malformed pending entry', () => {
    const withPending = (pending: unknown) => ({
      ...freshState(),
      watch: { prs: { 'owner/repo#9': { pending } } },
    });
    expect(validManagedGithubState(withPending('nope'))).toBe(false);
    expect(validManagedGithubState(withPending([null]))).toBe(false);
    expect(
      validManagedGithubState(withPending([watchPending({ key: '' })])),
    ).toBe(false);
    expect(
      validManagedGithubState(withPending([watchPending({ episode: 0 })])),
    ).toBe(false);
    expect(
      validManagedGithubState(
        withPending([watchPending({ episode: undefined as never })]),
      ),
    ).toBe(false);
    expect(
      validManagedGithubState(withPending([watchPending({ prNumber: 0 })])),
    ).toBe(false);
    expect(
      validManagedGithubState(
        withPending([watchPending({ transition: 'state_change' as never })]),
      ),
    ).toBe(false);
    expect(
      validManagedGithubState(withPending([watchPending({ headSha: '' })])),
    ).toBe(false);
    expect(
      validManagedGithubState(
        withPending([watchPending({ detectedAt: 'not-a-date' })]),
      ),
    ).toBe(false);
    expect(
      validManagedGithubState(withPending([watchPending({ owner: '' })])),
    ).toBe(false);
    expect(
      validManagedGithubState(
        withPending(
          Array.from(
            { length: MANAGED_GITHUB_PR_WATCH_PENDING_LIMIT + 1 },
            (_, i) => watchPending({ key: `key-${i}` }),
          ),
        ),
      ),
    ).toBe(false);
  });

  it('round-trips the watch segment through the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-github-watch-'));
    vi.stubEnv('QWEN_HOME', dir);
    try {
      const store = new ManagedGithubStateStore(
        'gh-1',
        dir,
        'https://api.github.com',
      );
      const state = watchState();
      store.save(state);
      expect(store.load()).toEqual(state);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ManagedGithubStateStore', () => {
  const tempDirs: string[] = [];
  function tempCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'managed-github-state-'));
    tempDirs.push(dir);
    return dir;
  }
  beforeEach(() => {
    vi.stubEnv('QWEN_HOME', tempCwd());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a state and returns undefined before the first save', () => {
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    expect(store.load()).toBeUndefined();
    const state = freshState();
    state.cursor.dispatchedComments = ['IC_1'];
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it('refuses to start over a corrupt or invalid state, naming the file', () => {
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    store.save(freshState());
    writeFileSync(store.file, '{broken');
    let err: Error | undefined;
    try {
      store.load();
    } catch (error) {
      err = error as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/is not valid JSON/);
    expect(err!.message).toContain(store.file);
    expect(err!.cause).toBeDefined();
    writeFileSync(store.file, JSON.stringify({ version: 99 }));
    expect(() => store.load()).toThrow(/is invalid/);
    expect(() => store.load()).toThrow(store.file);
  });

  it('an I/O read failure is distinct from corrupt JSON and keeps the cause', () => {
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    // A directory at the ledger path makes the read fail (EISDIR), which must
    // be distinguishable from a merely corrupt file.
    mkdirSync(store.file, { recursive: true });
    let err: Error | undefined;
    try {
      store.load();
    } catch (error) {
      err = error as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/could not be read/);
    expect(err!.message).toContain(store.file);
    expect((err!.cause as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('writes the directory 0700 and the file 0600', () => {
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    store.save(freshState());
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('preserves the fs error on cause and removes the half-written temp file', () => {
    // Force the write to fail AFTER the temp file is opened, so the real
    // save-failure catch ({ cause }) and finally (temp cleanup) both execute.
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    fsControl.failWrite = true;
    let err: Error | undefined;
    try {
      store.save(freshState());
    } catch (error) {
      err = error as Error;
    } finally {
      fsControl.failWrite = false;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/could not be saved/);
    // The cause is the raw fs error, not a stringified message, so the
    // adapter's persistErrorText can name the errno.
    expect((err!.cause as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(
      readdirSync(store.directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('keys the directory by name and endpoint, never by credential', () => {
    const cwd = tempCwd();
    const a = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://api.github.com',
    );
    const b = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://ghe.example.com',
    );
    const c = new ManagedGithubStateStore(
      'gh-2',
      cwd,
      'https://api.github.com',
    );
    expect(a.directory).not.toBe(b.directory);
    expect(a.directory).not.toBe(c.directory);
    expect(a.directory).toMatch(/github-[0-9a-f]{16}$/);
  });

  it('keys the ledger file by registration identity beneath the shared entry directory', () => {
    const cwd = tempCwd();
    const a = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    const b = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://api.github.com',
      'cp|tenant-b|chan-1|actor|ws|.',
    );
    // The connection lock stays per entry: both registrations share ONE
    // directory, but the ledger file beneath it is identity-keyed.
    expect(a.directory).toBe(b.directory);
    expect(a.file).not.toBe(b.file);
    expect(basename(a.file)).toMatch(/^managed-state-[0-9a-f]{16}\.json$/);
    expect(dirname(a.file)).toBe(a.directory);
    // A pending claim staged under A is never loaded under B.
    const state = freshState();
    state.pending = [
      {
        eventId: 'github:IC_1',
        event: event('github:IC_1'),
        notificationThreadId: 'n-1',
      },
    ];
    a.save(state);
    expect(a.load()?.pending?.[0]?.eventId).toBe('github:IC_1');
    expect(b.load()).toBeUndefined();
  });

  it('a workspace change within one tenant isolates the ledger', () => {
    // One shared cwd so the workspace-scope parent is identical: the file
    // difference must come from the identity key alone, not from separate
    // tempCwd() parents (R2-4). A constant ledger name must red this.
    const cwd = tempCwd();
    const a = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    const b = new ManagedGithubStateStore(
      'gh-1',
      cwd,
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws-2|.',
    );
    expect(a.directory).toBe(b.directory);
    expect(a.file).not.toBe(b.file);
  });

  it('reports a stranded legacy ledger on upgrade, without adopting it', () => {
    const store = new ManagedGithubStateStore(
      'gh-legacy',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    // Asymmetric counts (2 pending, 3 outbound) so swapping the two count
    // assignments or the two interpolations in the adapter notice reds this.
    const legacy = {
      ...freshState(),
      pending: [
        {
          eventId: 'github:IC_1',
          event: event('github:IC_1'),
          notificationThreadId: 'n-1',
        },
        {
          eventId: 'github:IC_2',
          event: event('github:IC_2'),
          notificationThreadId: 'n-2',
        },
      ],
      outbound: [
        { deliveryId: 'd-1', ordinal: 0 },
        { deliveryId: 'd-2', ordinal: 1 },
        { deliveryId: 'd-3', ordinal: 2 },
      ],
    };
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify(legacy),
    );
    const stranded = store.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.path).toBe(join(store.directory, 'managed-state.json'));
    expect(stranded!.pending).toBe(2);
    expect(stranded!.outbound).toBe(3);
    expect(stranded!.readable).toBe(true);
    // Reported, not adopted: load() still returns undefined (no keyed ledger).
    expect(store.load()).toBeUndefined();
    // Once archived, the legacy is no longer detected.
    const archived = store.archiveStrandedLegacy();
    expect(archived).toBeDefined();
    expect(store.strandedLegacyLedger()).toBeUndefined();
  });

  it('still reports a legacy ledger staged after a rollback (keyed ledger exists)', () => {
    const store = new ManagedGithubStateStore(
      'gh-rollback',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    store.save(freshState());
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify({
        ...freshState(),
        pending: [
          {
            eventId: 'github:IC_rb',
            event: event('github:IC_rb'),
            notificationThreadId: 'n-rb',
          },
        ],
      }),
    );
    const stranded = store.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.pending).toBe(1);
    expect(stranded!.outbound).toBe(0);
    expect(store.load()).toEqual(freshState());
  });

  it.each([
    ['{not json', false],
    ['null', true],
    ['[]', true],
  ])(
    'a corrupt legacy ledger (%s) reports zero counts instead of throwing',
    (raw, readable) => {
      const store = new ManagedGithubStateStore(
        'gh-corrupt',
        tempCwd(),
        'https://api.github.com',
        'cp|tenant-a|chan-1|actor|ws|.',
      );
      mkdirSync(store.directory, { recursive: true });
      writeFileSync(join(store.directory, 'managed-state.json'), raw);
      const stranded = store.strandedLegacyLedger();
      expect(stranded).toBeDefined();
      expect(stranded!.pending).toBe(0);
      expect(stranded!.outbound).toBe(0);
      expect(stranded!.readable).toBe(readable);
    },
  );

  it('an unreadable legacy ledger (directory at the path) is flagged, not empty', () => {
    const store = new ManagedGithubStateStore(
      'gh-eisdir',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    mkdirSync(join(store.directory, 'managed-state.json'));
    const stranded = store.strandedLegacyLedger();
    expect(stranded).toBeDefined();
    expect(stranded!.readable).toBe(false);
  });

  it('no stranded legacy ledger when none exists', () => {
    const store = new ManagedGithubStateStore(
      'gh-none',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    expect(store.strandedLegacyLedger()).toBeUndefined();
    expect(store.archiveStrandedLegacy()).toBeUndefined();
    expect(existsSync(join(store.directory, 'managed-state.json'))).toBe(false);
  });

  it('surfaces the legacy notification watermark, null when unreadable or cursor-less', () => {
    const store = new ManagedGithubStateStore(
      'gh-watermark',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const legacyPath = join(store.directory, 'managed-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        ...freshState(),
        cursor: {
          lastProcessedAt: '2026-11-19T09:00:00Z',
          dispatchedComments: [],
        },
      }),
    );
    expect(store.strandedLegacyLedger()!.watermark).toBe(
      '2026-11-19T09:00:00Z',
    );
    // A cursor-less legacy has no watermark to name.
    writeFileSync(legacyPath, JSON.stringify(freshState()));
    expect(store.strandedLegacyLedger()!.watermark).toBeNull();
    // An unreadable legacy cannot surface a watermark.
    writeFileSync(legacyPath, '{not json');
    expect(store.strandedLegacyLedger()!.watermark).toBeNull();
  });

  it('merges entry-scoped watch.episodes, sanitized to the validator bound', () => {
    const store = new ManagedGithubStateStore(
      'gh-episodes',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const legacyPath = join(store.directory, 'managed-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        ...freshState(),
        watch: {
          prs: {},
          episodes: { 'owner/repo#7': 5, 'owner/repo#8': 0, bad: 'x' },
        },
      }),
    );
    // Only safe integers >= 1 are carried; the rest re-baseline (R2-2).
    expect(store.entryWatchEpisodes()).toEqual({ 'owner/repo#7': 5 });
    // A legacy without watch carries no episodes.
    writeFileSync(legacyPath, JSON.stringify(freshState()));
    expect(store.entryWatchEpisodes()).toBeUndefined();
    // An unreadable legacy carries no episodes.
    writeFileSync(legacyPath, '{not json');
    expect(store.entryWatchEpisodes()).toBeUndefined();
    // No directory at all is best-effort undefined, never a throw.
    const absent = new ManagedGithubStateStore(
      'gh-episodes-absent',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    expect(absent.entryWatchEpisodes()).toBeUndefined();
  });

  it('resumes the episode counters from the archive after the legacy is renamed away (R3-1)', () => {
    const store = new ManagedGithubStateStore(
      'gh-episodes-archive',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify({
        ...freshState(),
        watch: { prs: {}, episodes: { 'owner/repo#7': 5 } },
      }),
    );
    expect(store.entryWatchEpisodes()).toEqual({ 'owner/repo#7': 5 });
    // Registration A archives the legacy; a later registration B must still
    // resume the counters from the .stranded-* archive, not restart at 0.
    const archived = store.archiveStrandedLegacy();
    expect(archived).toBeDefined();
    expect(existsSync(join(store.directory, 'managed-state.json'))).toBe(false);
    expect(store.entryWatchEpisodes()).toEqual({ 'owner/repo#7': 5 });
  });

  it('merges episode counters Math.max across sibling registrations of one entry (R3-1)', () => {
    const cwd = tempCwd();
    const a = new ManagedGithubStateStore(
      'gh-merge',
      cwd,
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    const b = new ManagedGithubStateStore(
      'gh-merge',
      cwd,
      'https://api.github.com',
      'cp|tenant-b|chan-1|actor|ws|.',
    );
    expect(a.directory).toBe(b.directory);
    expect(a.file).not.toBe(b.file);
    a.save({
      ...freshState(),
      watch: { prs: {}, episodes: { 'owner/repo#7': 5, 'owner/repo#8': 2 } },
    });
    b.save({
      ...freshState(),
      watch: { prs: {}, episodes: { 'owner/repo#7': 3, 'owner/repo#9': 9 } },
    });
    // The entry-scoped merge takes the max per key across both ledgers, so
    // neither registration re-derives an already-admitted input id.
    const expected = {
      'owner/repo#7': 5,
      'owner/repo#8': 2,
      'owner/repo#9': 9,
    };
    expect(a.entryWatchEpisodes()).toEqual(expected);
    expect(b.entryWatchEpisodes()).toEqual(expected);
  });

  it('re-caps the merged episode counters so the state stays loadable (R3-1)', () => {
    const store = new ManagedGithubStateStore(
      'gh-episodes-cap',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const episodes: Record<string, number> = {};
    for (let i = 0; i <= MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT; i++) {
      episodes[`owner/repo#${i}`] = 1;
    }
    writeFileSync(
      join(store.directory, 'managed-state.json'),
      JSON.stringify({ ...freshState(), watch: { prs: {}, episodes } }),
    );
    const merged = store.entryWatchEpisodes()!;
    expect(Object.keys(merged).length).toBeLessThanOrEqual(
      MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT,
    );
    expect(
      validManagedGithubState({
        ...freshState(),
        watch: { prs: {}, episodes: merged },
      }),
    ).toBe(true);
    // The eviction direction is the contract (R4-2): overflow drops the OLDEST
    // (head of insertion order), keeping the tail — the same direction as the
    // live watermark eviction. Keeping the head instead would drop the most
    // recently merged counter first, losing a carried counter at the bound.
    expect(merged[`owner/repo#${MANAGED_GITHUB_PR_WATCH_EPISODE_LIMIT}`]).toBe(
      1,
    );
    expect(merged['owner/repo#0']).toBeUndefined();
  });

  it('counts the legacy watch.prs queues so a queued transition is not a quiescent 0 pending (R3-1)', () => {
    const store = new ManagedGithubStateStore(
      'gh-watch-pending',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const legacyPath = join(store.directory, 'managed-state.json');
    const queued = {
      key: 'prw:ci_failure:owner/repo#9:sha-h:1',
      episode: 1,
      owner: 'owner',
      repo: 'repo',
      prNumber: 9,
      transition: 'ci_failure',
      headSha: 'sha-h',
      evidence: 'CI failing',
      detectedAt: '2026-11-19T09:00:00Z',
    };
    writeFileSync(
      legacyPath,
      JSON.stringify({
        ...freshState(),
        watch: {
          prs: {
            'owner/repo#9': { headSha: 'sha-h', pending: [queued] },
            'owner/repo#8': { headSha: 'sha-x' },
          },
        },
      }),
    );
    const stranded = store.strandedLegacyLedger()!;
    expect(stranded.pending).toBe(0);
    // One PR entry holds a non-empty queue; the baseline-only entry does not.
    expect(stranded.watchPending).toBe(1);
    // The keys let the caller check the loaded baselines for the stranded PRs.
    expect(stranded.watchPendingKeys).toEqual(['owner/repo#9']);
    // An empty queue counts no watch pending.
    writeFileSync(
      legacyPath,
      JSON.stringify({
        ...freshState(),
        watch: { prs: { 'owner/repo#9': { headSha: 'sha-h', pending: [] } } },
      }),
    );
    expect(store.strandedLegacyLedger()!.watchPending).toBe(0);
    expect(store.strandedLegacyLedger()!.watchPendingKeys).toEqual([]);
    // No watch at all counts none.
    writeFileSync(legacyPath, JSON.stringify(freshState()));
    expect(store.strandedLegacyLedger()!.watchPending).toBe(0);
    expect(store.strandedLegacyLedger()!.watchPendingKeys).toEqual([]);
  });

  it('a failed archive rename leaves the legacy reported, never throws', () => {
    const store = new ManagedGithubStateStore(
      'gh-archive-fail',
      tempCwd(),
      'https://api.github.com',
      'cp|tenant-a|chan-1|actor|ws|.',
    );
    mkdirSync(store.directory, { recursive: true });
    const legacyPath = join(store.directory, 'managed-state.json');
    writeFileSync(legacyPath, JSON.stringify(freshState()));
    fsControl.failRename = true;
    try {
      // The documented rename-failure arm returns undefined and keeps the file
      // so the next start reports it again (R2-6); it must not throw.
      expect(store.archiveStrandedLegacy()).toBeUndefined();
    } finally {
      fsControl.failRename = false;
    }
    expect(existsSync(legacyPath)).toBe(true);
    expect(store.strandedLegacyLedger()).toBeDefined();
  });
});
