/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import type { Policy } from './loader.js';
import { PolicyEnforcer } from './enforcer.js';
import { QuotaStore, MemoryQuotaWal, type QuotaLimit } from './quotas.js';

const NOW = 1_000_000;

function fakeAudit(): { entries: AuditEntry[]; recorder: AuditRecorder } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    recorder: { record: async (e: AuditEntry) => void entries.push(e) },
  };
}

/** A daemon whose vote returns `voteOk`; records each respondToSessionPermission. */
function fakeDaemon(voteOk: boolean): {
  daemon: DaemonClient;
  votes: Array<{ sessionId: string; requestId: string }>;
} {
  const votes: Array<{ sessionId: string; requestId: string }> = [];
  const daemon = {
    respondToSessionPermission: async (
      sessionId: string,
      requestId: string,
    ): Promise<boolean> => {
      votes.push({ sessionId, requestId });
      return voteOk;
    },
  } as unknown as DaemonClient;
  return { daemon, votes };
}

/**
 * REAL permission_request data (the daemon's ACP ToolCall verbatim): `{
 * toolCallId, title, kind, rawInput }`. The old synthetic `{ name, input }`
 * shape hid the extraction bug that Task 7 fixes — never reintroduce it here.
 */
function permEvent(
  kind: string,
  requestId = 'r1',
): { type: string; data: unknown } {
  return {
    type: 'permission_request',
    data: {
      requestId,
      toolCall: { toolCallId: 'tc1', title: 'humanized', kind, rawInput: {} },
      options: [
        { optionId: 'always', kind: 'allow_always', label: 'Always' },
        { optionId: 'ok', kind: 'allow_once', label: 'Once' },
      ],
    },
  };
}

const quotaRule = (count: number): Policy => ({
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'q',
      match: { tool: 'execute' },
      action: 'allow',
      maxPerWindow: { count, windowSec: 60 },
    },
  ],
});

async function storeFor(m: Record<string, QuotaLimit>): Promise<QuotaStore> {
  return QuotaStore.create(new MemoryQuotaWal(), (id) => m[id]);
}

describe('PolicyEnforcer + quota store (cycle 43 flip)', () => {
  it('consumes exactly once on a successful allow vote and audits quotaRemaining', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { entries, recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    const handled = await enf.handlePermission('s1', permEvent('execute'));
    expect(handled).toBe(true);
    expect(votes).toHaveLength(1);
    expect(store.remaining('q', NOW)).toBe(1); // consumed once
    const rec = entries.find((e) => e.action === 'policy_decision');
    expect(rec?.detail).toMatchObject({
      action: 'allow',
      ruleId: 'q',
      voted: true,
      quotaRemaining: 1,
    });
  });

  it('does NOT consume when the vote fails', async () => {
    const { daemon } = fakeDaemon(false); // vote returns false
    const { recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    const handled = await enf.handlePermission('s1', permEvent('execute'));
    expect(handled).toBe(false); // fell through to push
    expect(store.remaining('q', NOW)).toBe(2); // untouched
  });

  it('falls through (no auto-allow) once the quota is exhausted', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const store = await storeFor({ q: { count: 2, windowSec: 60 } });
    const enf = new PolicyEnforcer(
      daemon,
      quotaRule(2),
      recorder,
      store,
      () => NOW,
    );

    expect(await enf.handlePermission('s1', permEvent('execute', 'a'))).toBe(
      true,
    );
    expect(await enf.handlePermission('s1', permEvent('execute', 'b'))).toBe(
      true,
    );
    // 3rd within the window: exhausted → rule no-match → default prompt → no vote.
    expect(await enf.handlePermission('s1', permEvent('execute', 'c'))).toBe(
      false,
    );
    expect(votes).toHaveLength(2); // only the first two allowed
    expect(store.remaining('q', NOW)).toBe(0);
  });

  it('an allow via a NON-quota rule does not consume (no WAL churn)', async () => {
    const { daemon } = fakeDaemon(true);
    const { entries, recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, () => undefined); // nothing tracked
    const plain: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [{ id: 'plain', match: { tool: 'execute' }, action: 'allow' }],
    };
    const enf = new PolicyEnforcer(daemon, plain, recorder, store, () => NOW);

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(true);
    expect(await wal.load()).toEqual([]); // no consume persisted
    const rec = entries.find((e) => e.action === 'policy_decision');
    expect(rec?.detail).not.toHaveProperty('quotaRemaining');
  });

  it('a prompt decision never consumes', async () => {
    const { daemon } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const wal = new MemoryQuotaWal();
    const store = await QuotaStore.create(wal, (id) =>
      id === 'q' ? { count: 2, windowSec: 60 } : undefined,
    );
    const empty: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [],
    };
    const enf = new PolicyEnforcer(daemon, empty, recorder, store, () => NOW);

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(false);
    expect(await wal.load()).toEqual([]);
  });

  it('with NO store the maxPerWindow rule stays a prompt (backward compatible)', async () => {
    const { daemon, votes } = fakeDaemon(true);
    const { recorder } = fakeAudit();
    const enf = new PolicyEnforcer(daemon, quotaRule(2), recorder); // no store

    expect(await enf.handlePermission('s1', permEvent('execute'))).toBe(false);
    expect(votes).toHaveLength(0); // never auto-voted
  });
});
