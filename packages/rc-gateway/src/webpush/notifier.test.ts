/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { TokenStore } from '../tokenStore.js';
import { PushStore } from '../pushStore.js';
import { VapidStore } from './vapid.js';
import { PushSender, type PushTransport } from './sender.js';
import { PushNotifier } from './notifier.js';
import type { PushPayload } from './payload.js';
import { SESSION_READ, APPROVE } from '../scopes.js';
import { SnoozeStore } from '../routing/snooze.js';

let tokens: TokenStore;
let store: PushStore;
let vapid: VapidStore;
let audit: AuditRecorder & { calls: AuditEntry[] };
let sent: Array<{ endpoint: string; payload: PushPayload }>;
let sender: PushSender;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

const FAST = { backoffMs: [0, 0, 0, 0, 0], sleep: async () => {} };

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-notifier-'));
  tokens = await TokenStore.open(join(dir, 'tokens.json'));
  store = await PushStore.open(join(dir, 'push.json'));
  vapid = await VapidStore.open(join(dir, 'vapid.json'));
  audit = fakeAudit();
  sent = [];
  const transport: PushTransport = async (sub, payloadJson) => {
    sent.push({
      endpoint: sub.endpoint,
      payload: JSON.parse(payloadJson) as PushPayload,
    });
    return { statusCode: 201 };
  };
  sender = new PushSender(vapid, store, audit, { transport, ...FAST });
});

describe('PushNotifier', () => {
  it('fans a permission.required only to subs whose token has the approve scope', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const reader = await tokens.issue([SESSION_READ], 'reader');
    const approverSub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.add(reader.id, {
      endpoint: 'https://push.example.com/reader',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('https://push.example.com/approver');
    expect(sent[0].payload.kind).toBe('permission.required');
    // The skipped (reader) sub produces NO audit noise.
    expect(audit.calls.length).toBe(1);
    expect(audit.calls[0].action).toBe('push_sent');
    expect(audit.calls[0].detail).toMatchObject({
      subscriptionId: approverSub.id,
    });
  });

  it('honors per-subscription prefs in the fan-out (absent=all, list=filter, []=none)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    // A: no prefs → receives all kinds.
    const subA = await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    // B: prefs limited to task.completed → does NOT receive permission.required.
    const subB = await store.add(approver.id, {
      endpoint: 'https://push.example.com/b',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setPrefs(subB.id, ['task.completed']);
    // C: empty prefs → receives nothing.
    const subC = await store.add(approver.id, {
      endpoint: 'https://push.example.com/c',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setPrefs(subC.id, []);

    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    // Only A (no prefs) receives the permission.required event.
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example.com/a']);
    // The per-sub skip is silent: only A's push_sent appears (no skip audit).
    expect(audit.calls.map((c) => c.action)).toEqual(['push_sent']);
    expect(audit.calls[0].detail).toMatchObject({ subscriptionId: subA.id });
  });

  it('does nothing for a non-notifiable event (buildPayload null)', async () => {
    const t = await tokens.issue([SESSION_READ, APPROVE], 'x');
    await store.add(t.id, {
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      { type: 'unknown_event', data: {} },
      { sessionId: 's1' },
    );
    expect(sent).toHaveLength(0);
  });

  it('notifyToken sends a payload only to that tokens own subs (scope-gated)', async () => {
    const owner = await tokens.issue([SESSION_READ], 'owner');
    const other = await tokens.issue([SESSION_READ], 'other');
    await store.add(owner.id, {
      endpoint: 'https://push.example.com/owner',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.add(other.id, {
      endpoint: 'https://push.example.com/other',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId: 'test',
      summary: 'Task finished',
      url: '/ui/?session=test',
    };
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notifyToken(owner.id, payload);

    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('https://push.example.com/owner');
    expect(sent[0].payload.kind).toBe('task.completed');
  });

  it('suppresses the whole fan-out once when snoozed for all, auditing push_suppressed', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const snoozeDir = mkdtempSync(join(tmpdir(), 'rc-notifier-snooze-'));
    const snooze = await SnoozeStore.open(join(snoozeDir, 'snooze.state'));
    await snooze.snooze(60, 'all');
    // A SEPARATE notifier-owned audit sink (the sender has its own `audit`).
    const notifierAudit = fakeAudit();

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      snooze,
      notifierAudit,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    // Suppressed before any send.
    expect(sent).toHaveLength(0);
    expect(notifierAudit.calls).toHaveLength(1);
    expect(notifierAudit.calls[0].action).toBe('push_suppressed');
    expect(notifierAudit.calls[0].target).toBe('s1');
    expect(notifierAudit.calls[0].detail).toMatchObject({
      kind: 'permission.required',
      reason: 'snoozed',
    });
  });

  it('still sends when the snooze is scoped to a different kind', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const snoozeDir = mkdtempSync(join(tmpdir(), 'rc-notifier-snooze-'));
    const snooze = await SnoozeStore.open(join(snoozeDir, 'snooze.state'));
    await snooze.snooze(60, 'task.completed'); // not permission.required
    const notifierAudit = fakeAudit();

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      snooze,
      notifierAudit,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.kind).toBe('permission.required');
    expect(
      notifierAudit.calls.some((c) => c.action === 'push_suppressed'),
    ).toBe(false);
  });

  it('notifyToken skips a token lacking the required scope (no audit noise)', async () => {
    const t = await tokens.issue([APPROVE], 'no-session-read');
    await store.add(t.id, {
      endpoint: 'https://push.example.com/t',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId: 'test',
      summary: 'Task finished',
      url: '/ui/?session=test',
    };
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notifyToken(t.id, payload);
    expect(sent).toHaveLength(0);
    expect(audit.calls.length).toBe(0);
  });
});
