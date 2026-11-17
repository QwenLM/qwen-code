/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_OUTBOUND_LIMIT } from '@qwen-code/channel-base';
import type { ManagedInboundEvent } from '@qwen-code/channel-base';
import {
  DISPATCHED_COMMENTS_LIMIT,
  MANAGED_GITHUB_PENDING_LIMIT,
  ManagedGithubStateStore,
  validManagedGithubState,
  type ManagedGithubState,
} from './managed-state.js';

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

  it('refuses to start over an unreadable or invalid state', () => {
    const store = new ManagedGithubStateStore(
      'gh-1',
      tempCwd(),
      'https://api.github.com',
    );
    store.save(freshState());
    writeFileSync(store.file, '{broken');
    expect(() => store.load()).toThrow(/unreadable or invalid/);
    writeFileSync(store.file, JSON.stringify({ version: 99 }));
    expect(() => store.load()).toThrow(/unreadable or invalid/);
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
});
