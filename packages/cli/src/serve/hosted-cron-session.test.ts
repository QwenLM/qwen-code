/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HostedCronError,
  HostedCronSession,
  type HostedCronStore,
} from './hosted-cron-session.js';
import type {
  ManagedAutomationDefinitionInput,
  ManagedAutomationPage,
  ManagedAutomationResult,
  ManagedPublicAutomation,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { HostedLoopSession } from './hosted-loop-session.js';

const automation: ManagedPublicAutomation = {
  id: 'asch_abc',
  sessionId: 'session-a',
  cron: '*/5 * * * *',
  timezone: 'UTC',
  goal: 'check the build',
  state: 'active',
  enabled: true,
};

function fakeStore(overrides: Partial<HostedCronStore> = {}): {
  store: HostedCronStore;
  created: Array<{
    definition: ManagedAutomationDefinitionInput;
    key: string;
  }>;
  retired: Array<{ id: string; key: string }>;
  listCalls: Array<{ cursor?: string; limit?: number }>;
} {
  const created: Array<{
    definition: ManagedAutomationDefinitionInput;
    key: string;
  }> = [];
  const retired: Array<{ id: string; key: string }> = [];
  const listCalls: Array<{ cursor?: string; limit?: number }> = [];
  const result: ManagedAutomationResult = { automation, replayed: false };
  const store: HostedCronStore = {
    automationsCreate: async (definition, key) => {
      created.push({ definition, key });
      return result;
    },
    automationsList: async (cursor, limit) => {
      listCalls.push({ cursor, limit });
      return { data: [automation], hasMore: false, nextCursor: null };
    },
    automationsRetire: async (id, key) => {
      retired.push({ id, key });
      return {
        automation: { ...automation, state: 'retired' },
        replayed: false,
      };
    },
    ...overrides,
  };
  return { store, created, retired, listCalls };
}

function fakeLoops(
  wakeups: Array<{ id: string; fireAt: number | null; prompt: string }> = [],
): HostedLoopSession {
  return {
    list: async () => wakeups,
    cancel: async (id: string) => wakeups.some((w) => w.id === id),
  } as unknown as HostedLoopSession;
}

const allow = async () => ({ allowed: true, reason: null });
const session = (
  store: HostedCronStore,
  loops?: HostedLoopSession,
  classify = allow,
) => new HostedCronSession(store, loops, { classify });

const validParams = {
  cron: '*/5 * * * *',
  prompt: 'check the build',
  recurring: true,
};

describe('HostedCronSession', () => {
  it('creates a durable persistent definition with the derived create key', async () => {
    const { store, created } = fakeStore();
    const result = await session(store).create(validParams, 'call-1');
    expect(result).toEqual({ automation, replayed: false });
    expect(created).toHaveLength(1);
    expect(created[0]!.key).toBe('loop:call-1:create');
    expect(created[0]!.definition).toMatchObject({
      cron: '*/5 * * * *',
      prompt: 'check the build',
      timezone: 'UTC',
      session_mode: 'persistent',
    });
  });

  it('refuses a one-shot schedule', async () => {
    const { store, created } = fakeStore();
    await expect(
      session(store).create({ ...validParams, recurring: false }, 'call-1'),
    ).rejects.toBeInstanceOf(HostedCronError);
    expect(created).toHaveLength(0);
  });

  it('refuses durable:false', async () => {
    const { store, created } = fakeStore();
    await expect(
      session(store).create({ ...validParams, durable: false }, 'call-1'),
    ).rejects.toBeInstanceOf(HostedCronError);
    expect(created).toHaveLength(0);
  });

  it('refuses an invalid cron with a typed error before any store call', async () => {
    const { store, created } = fakeStore();
    await expect(
      session(store).create({ ...validParams, cron: 'not a cron' }, 'call-1'),
    ).rejects.toBeInstanceOf(HostedCronError);
    expect(created).toHaveLength(0);
  });

  it('refuses when the arm-time classifier denies the continuation', async () => {
    const { store, created } = fakeStore();
    const deny = async () => ({ allowed: false, reason: 'unsafe' });
    await expect(
      session(store, undefined, deny).create(validParams, 'call-1'),
    ).rejects.toThrow(/admission denied/u);
    expect(created).toHaveLength(0);
  });

  it('reviews the gate command alongside the prompt at arm time', async () => {
    const { store } = fakeStore();
    const classify = vi.fn(allow);
    await session(store, undefined, classify).create(
      { ...validParams, gate: 'test -f /tmp/ready' },
      'call-1',
    );
    expect(classify).toHaveBeenCalledTimes(1);
    const input = classify.mock.calls[0]![0];
    expect(input.prompt).toContain('check the build');
    expect(input.prompt).toContain('test -f /tmp/ready');
  });

  it('lists every ledger page and unions the pending wakeup', async () => {
    const page2: ManagedAutomationPage = {
      data: [{ ...automation, id: 'asch_def' }],
      hasMore: false,
      nextCursor: null,
    };
    const { store, listCalls } = fakeStore({
      automationsList: async (cursor) => {
        listCalls.push({ cursor });
        return cursor === undefined
          ? { data: [automation], hasMore: true, nextCursor: 'cursor-2' }
          : page2;
      },
    });
    const wakeup = { id: 'loop:w1', fireAt: 123, prompt: 'continue' };
    const answer = await session(store, fakeLoops([wakeup])).list();
    expect(answer.definitions.map((d) => d.id)).toEqual([
      'asch_abc',
      'asch_def',
    ]);
    expect(answer.wakeups).toEqual([wakeup]);
    expect(listCalls.map((c) => c.cursor)).toEqual([undefined, 'cursor-2']);
  });

  it('lists definitions without a wakeup funnel when none is bound', async () => {
    const { store } = fakeStore();
    const answer = await session(store).list();
    expect(answer.definitions).toHaveLength(1);
    expect(answer.wakeups).toEqual([]);
  });

  it('routes a loop: id to the wakeup cancel, not the ledger', async () => {
    const { store, retired } = fakeStore();
    const loops = fakeLoops([{ id: 'loop:w1', fireAt: null, prompt: 'x' }]);
    const answer = await session(store, loops).delete('loop:w1', 'call-2');
    expect(answer).toEqual({ kind: 'wakeup', cancelled: true });
    expect(retired).toHaveLength(0);
  });

  it('routes a definition id to retire with the derived retire key', async () => {
    const { store, retired } = fakeStore();
    const answer = await session(store).delete('asch_abc', 'call-2');
    expect(answer.kind).toBe('definition');
    expect(retired).toEqual([{ id: 'asch_abc', key: 'loop:call-2:retire' }]);
  });
});
