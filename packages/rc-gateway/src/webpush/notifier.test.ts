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
import { PushNotifier, type ApnsNotifier } from './notifier.js';
import { PushRateLimiter } from './rateLimiter.js';
import { PushCoalescer } from './coalescer.js';
import { PushDigest } from './digest.js';
import type { PushPayload } from './payload.js';
import { ApnsStore } from '../nativePush/apnsStore.js';
import { SESSION_READ, APPROVE, SHARE } from '../scopes.js';
import { SnoozeStore } from '../routing/snooze.js';
import { WorkingDeviceTracker } from '../routing/workingDevice.js';
import { compileRouting, loadRoutingConfig } from '../routing/rules.js';

let dir: string;
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

/** A fake APNs sender that records what it was asked to deliver. */
function fakeApns(): ApnsNotifier & {
  sends: Array<{ tokenId: string; deviceToken: string; payload: PushPayload }>;
} {
  const sends: Array<{
    tokenId: string;
    deviceToken: string;
    payload: PushPayload;
  }> = [];
  return {
    sends,
    send: async (sub, payload) => {
      sends.push({
        tokenId: sub.tokenId,
        deviceToken: sub.deviceToken,
        payload,
      });
      return { ok: true };
    },
  };
}

const FAST = { backoffMs: [0, 0, 0, 0, 0], sleep: async () => {} };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-notifier-'));
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

  it('SECURITY: does NOT deliver another session’s push to a session-locked share token', async () => {
    const share = await tokens.issueShare({
      scopes: [SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    await store.add(share.id, {
      endpoint: 'https://push.example.com/guest',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifier = new PushNotifier(tokens, store, sender);
    // Event for a DIFFERENT session s2 — the s1-locked guest must not receive it.
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's2' },
    );
    expect(sent).toHaveLength(0);
  });

  it('delivers the locked session’s OWN push to a share token', async () => {
    const share = await tokens.issueShare({
      scopes: [SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    await store.add(share.id, {
      endpoint: 'https://push.example.com/guest',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('https://push.example.com/guest');
  });

  it('SECURITY: does NOT deliver to an EXPIRED share token, even for its own session', async () => {
    // ttlSec negative → expiresAt in the past → scopesFor drops it (no push).
    const share = await tokens.issueShare({
      scopes: [SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: -10,
      parentId: 'owner',
    });
    await store.add(share.id, {
      endpoint: 'https://push.example.com/guest',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );
    expect(sent).toHaveLength(0);
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

    const notifierAudit = fakeAudit();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      notifierAudit,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    // Only A (no prefs) receives the permission.required event.
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example.com/a']);
    // B and C are suppressed by their prefs filter, each AUDITED (cycle 53): a
    // prefs mute is a suppression DECISION ("why no push"), not a silent
    // boundary — in fan-out order (A sent, then B, then C suppressed).
    const prefsSkips = notifierAudit.calls.filter(
      (c) => c.action === 'push_suppressed',
    );
    expect(prefsSkips.map((c) => c.detail)).toEqual([
      { kind: 'permission.required', reason: 'prefs', subscriptionId: subB.id },
      { kind: 'permission.required', reason: 'prefs', subscriptionId: subC.id },
    ]);
    // A (allowed) produced no prefs suppression.
    expect(
      prefsSkips.some(
        (c) =>
          (c.detail as { subscriptionId?: string }).subscriptionId === subA.id,
      ),
    ).toBe(false);
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

  it('suppresses a permission.required push to a working subscription, auditing push_suppressed', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const workingDevice = new WorkingDeviceTracker();
    workingDevice.touch(approver.id); // this token is actively working
    const notifierAudit = fakeAudit();

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      notifierAudit,
      workingDevice,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1' },
    );

    expect(sent).toHaveLength(0);
    const suppressed = notifierAudit.calls.filter(
      (c) => c.action === 'push_suppressed',
    );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].target).toBe('s1');
    expect(suppressed[0].detail).toMatchObject({
      kind: 'permission.required',
      reason: 'working_device',
      subscriptionId: sub.id,
    });
  });

  it('still sends a permission.required push to a non-working subscription', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const workingDevice = new WorkingDeviceTracker();
    // Not touched → this token is NOT working.
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      workingDevice,
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
  });

  it('still sends a task.completed push to a working subscription (suppression is permission.required-only)', async () => {
    const reader = await tokens.issue([SESSION_READ], 'reader');
    await store.add(reader.id, {
      endpoint: 'https://push.example.com/reader',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const workingDevice = new WorkingDeviceTracker();
    workingDevice.touch(reader.id); // token is working
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId: 's1',
      summary: 'Task finished',
      url: '/ui/?session=s1',
    };
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      workingDevice,
    );
    // task.completed only flows via the (ungated) notifyToken path; the
    // permission.required-only suppression must NOT touch it.
    await notifier.notifyToken(reader.id, payload);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.kind).toBe('task.completed');
  });

  it('a routing drop rule suppresses the whole fan-out, auditing routing_rule', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifierAudit = fakeAudit();
    const routing = { firstDrop: () => 'silence-prompts' };

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      notifierAudit,
      undefined,
      routing,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );

    expect(sent).toHaveLength(0);
    expect(notifierAudit.calls).toHaveLength(1);
    expect(notifierAudit.calls[0].action).toBe('push_suppressed');
    expect(notifierAudit.calls[0].target).toBe('s1');
    expect(notifierAudit.calls[0].detail).toMatchObject({
      kind: 'permission.required',
      reason: 'routing_rule',
      ruleId: 'silence-prompts',
    });
  });

  it('a routing matcher returning null leaves delivery unchanged', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const routing = { firstDrop: () => null };
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      routing,
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
  });

  it('setRouting hot-swaps the matcher (hot-reload): a later notify drops under the new rules', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    // Start with NO routing → the first notify delivers.
    const notifier = new PushNotifier(tokens, store, sender);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );
    expect(sent).toHaveLength(1);

    // Hot-swap in a drop-everything matcher → the next notify is suppressed.
    notifier.setRouting({ firstDrop: () => 'silence-prompts' });
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r2' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );
    expect(sent).toHaveLength(1); // unchanged — the 2nd was dropped

    // Swap back to undefined → delivery resumes.
    notifier.setRouting(undefined);
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r3' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );
    expect(sent).toHaveLength(2);
  });

  it('snooze takes precedence over a routing drop rule (gate order)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const snoozeDir = mkdtempSync(join(tmpdir(), 'rc-notifier-snooze-'));
    const snooze = await SnoozeStore.open(join(snoozeDir, 'snooze.state'));
    await snooze.snooze(60, 'all');
    const notifierAudit = fakeAudit();
    // A matcher that WOULD drop — but snooze fires first, so the recorded
    // reason must be 'snoozed', proving the routing gate sits after snooze.
    const routing = { firstDrop: () => 'would-drop' };

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      snooze,
      notifierAudit,
      undefined,
      routing,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'r1' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );

    expect(sent).toHaveLength(0);
    expect(notifierAudit.calls).toHaveLength(1);
    expect(notifierAudit.calls[0].detail).toMatchObject({ reason: 'snoozed' });
  });

  it('a per-subscription routing drop suppresses only the matched sub, auditing subscriptionId', async () => {
    // share = guest sub (drop target); approver = normal sub (delivered).
    const share = await tokens.issueShare({
      scopes: [SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const guestSub = await store.add(share.id, {
      endpoint: 'https://push.example.com/guest',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifierAudit = fakeAudit();
    // Drop only the guest token's subscription.
    const routing = {
      firstDrop: () => null,
      firstDropForSubscription: (
        _ev: { kind: string },
        sub: { tokenId: string },
      ) => (sub.tokenId === share.id ? 'mute-guests' : null),
    };

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      notifierAudit,
      undefined,
      routing,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );

    // Only the approver sub is delivered; the guest sub is suppressed.
    expect(sent.map((s) => s.endpoint)).toEqual([
      'https://push.example.com/approver',
    ]);
    const supp = notifierAudit.calls.filter(
      (c) => c.action === 'push_suppressed',
    );
    expect(supp).toHaveLength(1);
    expect(supp[0].target).toBe('s1');
    expect(supp[0].detail).toMatchObject({
      kind: 'permission.required',
      reason: 'routing_rule',
      ruleId: 'mute-guests',
      subscriptionId: guestSub.id,
    });
  });

  it('scopeIn:[share] drops a real share token via a compiled matcher (end-to-end)', async () => {
    // A share issued the way routes/share.ts mints them — carrying SHARE — so
    // scopesFor surfaces 'share' to the matcher's scopeIn check. Proves the
    // headline "mute guest shares" path through the REAL compiled matcher.
    const share = await tokens.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const guestSub = await store.add(share.id, {
      endpoint: 'https://push.example.com/guest',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const notifierAudit = fakeAudit();
    const routing = compileRouting(
      loadRoutingConfig(`
rules:
  - id: mute-guests
    match: { scopeIn: [share] }
    route: { drop: true }
`),
    );

    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      notifierAudit,
      undefined,
      routing,
    );
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'bash' }, requestId: 'r1' },
      },
      { sessionId: 's1', sessionName: 'demo' },
    );

    expect(sent.map((s) => s.endpoint)).toEqual([
      'https://push.example.com/approver',
    ]);
    const supp = notifierAudit.calls.filter(
      (c) => c.action === 'push_suppressed',
    );
    expect(supp).toHaveLength(1);
    expect(supp[0].detail).toMatchObject({
      reason: 'routing_rule',
      ruleId: 'mute-guests',
      subscriptionId: guestSub.id,
    });
  });

  it('a routing matcher WITHOUT firstDropForSubscription leaves per-sub delivery unchanged', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
    // Old-style stub: only firstDrop, no per-sub method (proves the ?. guard).
    const routing = { firstDrop: () => null };
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      routing,
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
  });

  it('notifyToken (/test) is NOT gated by a per-subscription routing drop rule', async () => {
    const owner = await tokens.issue([SESSION_READ], 'owner');
    await store.add(owner.id, {
      endpoint: 'https://push.example.com/owner',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId: 'test',
      summary: 'Task finished',
      url: '/ui/?session=test',
    };
    const routing = {
      firstDrop: () => null,
      firstDropForSubscription: () => 'drop-everything',
    };
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      routing,
    );
    await notifier.notifyToken(owner.id, payload);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.kind).toBe('task.completed');
  });

  it('notifyToken (/test) is NOT gated by a routing drop rule', async () => {
    const owner = await tokens.issue([SESSION_READ], 'owner');
    await store.add(owner.id, {
      endpoint: 'https://push.example.com/owner',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId: 'test',
      summary: 'Task finished',
      url: '/ui/?session=test',
    };
    const routing = { firstDrop: () => 'drop-everything' };
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      routing,
    );
    await notifier.notifyToken(owner.id, payload);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.kind).toBe('task.completed');
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

  // --- Quiet hours (cycle 29) ---------------------------------------------

  async function approverWithSub(): Promise<string> {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/q',
      keys: { p256dh: 'p', auth: 'a' },
    });
    return sub.id;
  }

  const PERM_EVENT = {
    type: 'permission_request',
    data: { toolCall: { name: 'bash' }, requestId: 'r1' },
  };

  it('suppresses a subscription whose quiet window covers now (+ audits reason)', async () => {
    const subId = await approverWithSub();
    await store.setQuietHours(subId, {
      from: '09:00',
      to: '17:00',
      timezone: 'UTC',
    });
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(
      PERM_EVENT,
      { sessionId: 's1' },
      new Date('2026-06-10T12:00:00Z'),
    );
    expect(sent).toHaveLength(0);
    const supp = audit.calls.find((c) => c.action === 'push_suppressed');
    expect(supp?.detail).toMatchObject({
      kind: 'permission.required',
      reason: 'quiet_hours',
      subscriptionId: subId,
    });
  });

  it('sends when now is OUTSIDE the quiet window', async () => {
    const subId = await approverWithSub();
    await store.setQuietHours(subId, {
      from: '09:00',
      to: '17:00',
      timezone: 'UTC',
    });
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(
      PERM_EVENT,
      { sessionId: 's1' },
      new Date('2026-06-10T20:00:00Z'),
    );
    expect(sent).toHaveLength(1);
    expect(audit.calls.some((c) => c.action === 'push_suppressed')).toBe(false);
  });

  it('handles a midnight-wrapping quiet window (23:00–07:00) at 02:00', async () => {
    const subId = await approverWithSub();
    await store.setQuietHours(subId, {
      from: '23:00',
      to: '07:00',
      timezone: 'UTC',
    });
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(
      PERM_EVENT,
      { sessionId: 's1' },
      new Date('2026-06-10T02:00:00Z'),
    );
    expect(sent).toHaveLength(0);
    expect(
      audit.calls.find((c) => c.action === 'push_suppressed')?.detail,
    ).toMatchObject({ reason: 'quiet_hours' });
  });

  it('FAIL-OPEN: an unparseable stored quiet window sends (no suppression)', async () => {
    const subId = await approverWithSub();
    // Bypasses PATCH validation by writing directly through the store.
    await store.setQuietHours(subId, {
      from: '99:99',
      to: '07:00',
      timezone: 'UTC',
    });
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(
      PERM_EVENT,
      { sessionId: 's1' },
      new Date('2026-06-10T02:00:00Z'),
    );
    expect(sent).toHaveLength(1);
    expect(audit.calls.some((c) => c.action === 'push_suppressed')).toBe(false);
  });

  it('a subscription with no quiet window is unaffected (back-compat)', async () => {
    await approverWithSub();
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(
      PERM_EVENT,
      { sessionId: 's1' },
      new Date('2026-06-10T12:00:00Z'),
    );
    expect(sent).toHaveLength(1);
  });
});

describe('PushNotifier rate limit (cycle 46)', () => {
  const PERM = {
    type: 'permission_request',
    data: { toolCall: { name: 'bash' }, requestId: 'r' },
  };
  const NOW = new Date(1_000_000);

  it('drops sends past maxPerHour and audits push_rate_limited ONCE (firstDrop)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setMaxPerHour(sub.id, 1);
    const rl = new PushRateLimiter();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      rl,
    );

    await notifier.notify(PERM, { sessionId: 's1' }, NOW); // sent
    await notifier.notify(PERM, { sessionId: 's1' }, NOW); // dropped (transition)
    await notifier.notify(PERM, { sessionId: 's1' }, NOW); // dropped (no re-audit)

    expect(sent).toHaveLength(1);
    const limited = audit.calls.filter((c) => c.action === 'push_rate_limited');
    expect(limited).toHaveLength(1); // only the transition audits
    expect(limited[0].detail).toMatchObject({
      subscriptionId: sub.id,
      kind: 'permission.required',
    });
  });

  it('with NO limiter wired there is no cap (back-compat)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setMaxPerHour(sub.id, 1);
    const notifier = new PushNotifier(tokens, store, sender); // no limiter

    await notifier.notify(PERM, { sessionId: 's1' });
    await notifier.notify(PERM, { sessionId: 's1' });
    expect(sent).toHaveLength(2); // maxPerHour ignored without a limiter
  });

  it('FAIL-OPEN: a corrupt stored maxPerHour:0 falls back to the default (not a 0-cap lockout)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    // Only reachable via a hand-edited store (the route forbids 0); must NOT
    // silently drop every push.
    await store.setMaxPerHour(sub.id, 0);
    const rl = new PushRateLimiter();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      rl,
    );
    await notifier.notify(PERM, { sessionId: 's1' }, NOW);
    expect(sent).toHaveLength(1); // sent, not locked out
  });

  it('applies the default cap (30) when the subscription sets none', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const rl = new PushRateLimiter();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      rl,
    );
    for (let i = 0; i < 31; i++) {
      await notifier.notify(PERM, { sessionId: 's1' }, NOW);
    }
    expect(sent).toHaveLength(30); // the default cap
  });
});

describe('PushNotifier.forgetRateLimit', () => {
  it('delegates to the limiter so a forgotten sub starts a fresh window', () => {
    const limiter = new PushRateLimiter();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      limiter,
    );
    // maxPerHour=1: first send allowed, second dropped (window at cap).
    expect(limiter.tryConsume('sub1', 1, 1000).allowed).toBe(true);
    expect(limiter.tryConsume('sub1', 1, 1000).allowed).toBe(false);
    // Forgetting the sub via the notifier clears the window -> allowed again.
    notifier.forgetRateLimit('sub1');
    expect(limiter.tryConsume('sub1', 1, 1000).allowed).toBe(true);
  });

  it('is a safe no-op when no limiter is configured', () => {
    const notifier = new PushNotifier(tokens, store, sender);
    expect(() => notifier.forgetRateLimit('sub1')).not.toThrow();
  });
});

describe('PushNotifier same-kind coalescing (cycle 63)', () => {
  async function approverSub() {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/approver',
      keys: { p256dh: 'p', auth: 'a' },
    });
  }
  const permEvent = {
    type: 'permission_request',
    data: { toolCall: { name: 'bash' }, requestId: 'r' },
  };

  it('suppresses a same-kind same-session repeat within the window and audits reason:coalesced', async () => {
    await approverSub();
    const coalescer = new PushCoalescer(5000);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      coalescer,
    );
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1000));
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(4000));
    expect(sent).toHaveLength(1); // the 2nd (3s later) was coalesced
    const coalesced = audit.calls.find(
      (c) =>
        c.action === 'push_suppressed' &&
        (c.detail as Record<string, unknown>)?.reason === 'coalesced',
    );
    expect(coalesced).toBeDefined();
  });

  it('does NOT coalesce across different sessions', async () => {
    await approverSub();
    const coalescer = new PushCoalescer(5000);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      coalescer,
    );
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1000));
    await notifier.notify(permEvent, { sessionId: 's2' }, new Date(1100));
    expect(sent).toHaveLength(2);
  });

  it('without a coalescer (default), both same-session pushes are delivered', async () => {
    await approverSub();
    const notifier = new PushNotifier(tokens, store, sender, undefined, audit);
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1000));
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1100));
    expect(sent).toHaveLength(2);
  });

  it('a disabled (window 0) coalescer never suppresses', async () => {
    await approverSub();
    const coalescer = new PushCoalescer(0);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      coalescer,
    );
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1000));
    await notifier.notify(permEvent, { sessionId: 's1' }, new Date(1100));
    expect(sent).toHaveLength(2);
  });
});

describe('PushNotifier quiet-hours digest tracking (cycle 71)', () => {
  it('records a quiet-hours suppression in the digest and exposes it via digestSummary', async () => {
    const { PushDigest } = await import('./digest.js');
    // APPROVE so permission.required passes the scope gate and reaches the
    // quiet-hours gate (where it is suppressed + recorded).
    const reader = await tokens.issue([SESSION_READ, APPROVE], 'reader');
    const sub = await store.add(reader.id, {
      endpoint: 'https://push.example.com/r',
      keys: { p256dh: 'p', auth: 'a' },
    });
    // A quiet window covering all day in UTC so `now` is always inside it.
    await store.setQuietHours(sub.id, {
      from: '00:00',
      to: '23:59',
      timezone: 'UTC',
    });
    const digest = new PushDigest();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      digest,
    );
    await notifier.notify(
      { type: 'permission_request', data: { requestId: 'r1' } },
      { sessionId: 's1' },
      new Date('2026-06-12T12:00:00Z'),
    );
    expect(sent).toHaveLength(0); // suppressed by quiet hours
    expect(notifier.digestSummary()).toEqual([
      {
        subscriptionId: sub.id,
        total: 1,
        byKind: { 'permission.required': 1 },
      },
    ]);
  });

  it('digestSummary is empty when no digest is wired', async () => {
    const notifier = new PushNotifier(tokens, store, sender);
    expect(notifier.digestSummary()).toEqual([]);
  });

  it('does NOT record a delivered (non-quiet) push in the digest', async () => {
    const { PushDigest } = await import('./digest.js');
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    // No quiet hours set -> the push is delivered, not suppressed.
    await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const digest = new PushDigest();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      digest,
    );
    await notifier.notify(
      { type: 'permission_request', data: { requestId: 'r1' } },
      { sessionId: 's1' },
      new Date('2026-06-12T12:00:00Z'),
    );
    expect(sent).toHaveLength(1); // delivered
    expect(notifier.digestSummary()).toEqual([]); // nothing recorded
  });
});

describe('PushNotifier.flushQuietDigests (D4 end-of-quiet digest)', () => {
  const QUIET = { from: '22:00', to: '07:00', timezone: 'UTC' };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  async function quietSub(): Promise<{
    notifier: PushNotifier;
    endpoint: string;
  }> {
    const digest = new PushDigest();
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'a');
    const endpoint = 'https://push.example.com/a';
    const sub = await store.add(approver.id, {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setQuietHours(sub.id, QUIET);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      digest,
    );
    return { notifier, endpoint };
  }

  it('sends one digest when the window ends, then resets the counts', async () => {
    const { notifier, endpoint } = await quietSub();
    // While quiet (02:00) the push is suppressed and recorded into the digest.
    await notifier.notify(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'x' }, requestId: 'r' },
      },
      { sessionId: 's1' },
      new Date('2026-06-09T02:00:00Z'),
    );
    expect(sent).toHaveLength(0);
    expect(notifier.digestSummary()).toHaveLength(1);

    notifier.flushQuietDigests(new Date('2026-06-09T02:30:00Z')); // seed quiet
    await settle();
    expect(sent).toHaveLength(0);

    notifier.flushQuietDigests(new Date('2026-06-09T08:00:00Z')); // window ended
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe(endpoint);
    expect(sent[0].payload.kind).toBe('digest');
    expect(sent[0].payload.summary).toContain('while you were away');
    // Counts reset so the next window-end does not re-digest.
    expect(notifier.digestSummary()).toEqual([]);

    notifier.flushQuietDigests(new Date('2026-06-09T08:30:00Z'));
    await settle();
    expect(sent).toHaveLength(1); // no double-fire
  });

  it('does not send a digest when nothing was suppressed while quiet', async () => {
    const { notifier } = await quietSub();
    notifier.flushQuietDigests(new Date('2026-06-09T02:30:00Z')); // seed quiet, no counts
    notifier.flushQuietDigests(new Date('2026-06-09T08:00:00Z')); // exit, empty digest
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('is a no-op (never throws) when no digest is configured', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'a');
    const sub = await store.add(approver.id, {
      endpoint: 'https://push.example.com/a',
      keys: { p256dh: 'p', auth: 'a' },
    });
    await store.setQuietHours(sub.id, QUIET);
    const notifier = new PushNotifier(tokens, store, sender); // no digest
    notifier.flushQuietDigests(new Date('2026-06-09T02:30:00Z'));
    notifier.flushQuietDigests(new Date('2026-06-09T08:00:00Z'));
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe('PushNotifier — APNs fan-out', () => {
  const PERM = {
    type: 'permission_request',
    data: { toolCall: { name: 'bash' }, requestId: 'r1' },
  };

  it('SECURITY: does NOT deliver another session’s push to a session-locked share token’s APNs device', async () => {
    const share = await tokens.issueShare({
      scopes: [SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const apnsStore = await ApnsStore.open(join(dir, 'apns.json'));
    await apnsStore.register({
      tokenId: share.id,
      deviceToken: 'devhex',
      bundleId: 'com.example.app',
      shellVersion: '1',
    });
    const apns = fakeApns();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { store: apnsStore, sender: apns },
    );
    // Event for a DIFFERENT session — the s1-locked guest's device must not get it.
    await notifier.notify(PERM, { sessionId: 's2' });
    expect(apns.sends).toHaveLength(0);
    // Its OWN session's event IS delivered.
    await notifier.notify(PERM, { sessionId: 's1' });
    expect(apns.sends).toHaveLength(1);
    expect(apns.sends[0]).toMatchObject({
      tokenId: share.id,
      deviceToken: 'devhex',
    });
    expect(apns.sends[0].payload.kind).toBe('permission.required');
  });

  it('only delivers a kind to APNs devices whose token holds the mapped scope', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const reader = await tokens.issue([SESSION_READ], 'reader');
    const apnsStore = await ApnsStore.open(join(dir, 'apns.json'));
    await apnsStore.register({
      tokenId: approver.id,
      deviceToken: 'app-dev',
      bundleId: 'b',
      shellVersion: '1',
    });
    await apnsStore.register({
      tokenId: reader.id,
      deviceToken: 'read-dev',
      bundleId: 'b',
      shellVersion: '1',
    });
    const apns = fakeApns();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { store: apnsStore, sender: apns },
    );
    await notifier.notify(PERM, { sessionId: 's1' });
    expect(apns.sends.map((s) => s.deviceToken)).toEqual(['app-dev']);
  });

  it('a global snooze suppresses the APNs fan-out too (no send)', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const apnsStore = await ApnsStore.open(join(dir, 'apns.json'));
    await apnsStore.register({
      tokenId: approver.id,
      deviceToken: 'app-dev',
      bundleId: 'b',
      shellVersion: '1',
    });
    const snooze = await SnoozeStore.open(join(dir, 'snooze.state'));
    await snooze.snooze(3600, 'all');
    const apns = fakeApns();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      snooze,
      audit,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { store: apnsStore, sender: apns },
    );
    await notifier.notify(PERM, { sessionId: 's1' });
    expect(apns.sends).toHaveLength(0);
  });

  it('coalesces a same-(kind,session) burst to the APNs device within the window', async () => {
    const approver = await tokens.issue([SESSION_READ, APPROVE], 'approver');
    const apnsStore = await ApnsStore.open(join(dir, 'apns.json'));
    await apnsStore.register({
      tokenId: approver.id,
      deviceToken: 'app-dev',
      bundleId: 'b',
      shellVersion: '1',
    });
    const coalescer = new PushCoalescer(5000);
    const apns = fakeApns();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      undefined,
      undefined,
      coalescer,
      undefined,
      { store: apnsStore, sender: apns },
    );
    const t0 = new Date('2026-06-09T00:00:00Z');
    const t1 = new Date('2026-06-09T00:00:03Z'); // +3s, within 5s window
    await notifier.notify(PERM, { sessionId: 's1' }, t0);
    await notifier.notify(PERM, { sessionId: 's1' }, t1);
    expect(apns.sends).toHaveLength(1); // second collapsed
    expect(
      audit.calls.some(
        (c) =>
          c.action === 'push_suppressed' && c.detail?.reason === 'coalesced',
      ),
    ).toBe(true);
  });
});
