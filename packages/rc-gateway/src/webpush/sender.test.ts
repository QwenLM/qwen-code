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
import { VapidStore } from './vapid.js';
import { PushStore, type PushSubscriptionRecord } from '../pushStore.js';
import { WebPushError } from 'web-push';
import { PushSender, type PushTransport } from './sender.js';
import type { PushPayload } from './payload.js';

let vapid: VapidStore;
let store: PushStore;
let audit: AuditRecorder & { calls: AuditEntry[] };
let record: PushSubscriptionRecord;

const PAYLOAD: PushPayload = {
  v: 1,
  kind: 'permission.required',
  sessionId: 's1',
  summary: 'Permission needed: run_shell_command',
  url: '/ui/?session=s1',
};

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

const FAST = { backoffMs: [0, 0, 0, 0, 0], sleep: async () => {} };

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-sender-'));
  vapid = await VapidStore.open(join(dir, 'vapid.json'));
  store = await PushStore.open(join(dir, 'push.json'));
  audit = fakeAudit();
  record = await store.add('tokA', {
    endpoint: 'https://push.example.com/secret-1',
    keys: { p256dh: 'p', auth: 'a' },
  });
});

describe('PushSender', () => {
  it('2xx → push_sent, no removal, single transport call', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      return { statusCode: 201 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(1);
    const sent = audit.calls.filter((c) => c.action === 'push_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].detail).toMatchObject({
      subscriptionId: record.id,
      kind: 'permission.required',
    });
    expect(store.get(record.id)).toBeDefined();
  });

  it('410 → remove + push_subscription_expired, no retry', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      return { statusCode: 410 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(1);
    expect(store.get(record.id)).toBeUndefined();
    const exp = audit.calls.filter(
      (c) => c.action === 'push_subscription_expired',
    );
    expect(exp).toHaveLength(1);
    expect(exp[0].detail).toMatchObject({
      subscriptionId: record.id,
      statusCode: 410,
    });
    expect(audit.calls.some((c) => c.action === 'push_sent')).toBe(false);
  });

  it('403 → keep subscription + push_send_failed{reason:auth_error}, no retry', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      return { statusCode: 403 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    // Auth/config error (e.g. VAPID misconfig) must NOT wipe the sub and must
    // NOT retry — a single misconfig would otherwise clear the whole store.
    expect(calls).toBe(1);
    expect(store.get(record.id)).toBeDefined();
    const failed = audit.calls.filter((c) => c.action === 'push_send_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toMatchObject({
      subscriptionId: record.id,
      statusCode: 403,
      reason: 'auth_error',
    });
    expect(
      audit.calls.some((c) => c.action === 'push_subscription_expired'),
    ).toBe(false);
  });

  it('401 → same as 403 (auth error: keep + fail fast)', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      return { statusCode: 401 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(1);
    expect(store.get(record.id)).toBeDefined();
    const failed = audit.calls.filter((c) => c.action === 'push_send_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toMatchObject({
      statusCode: 401,
      reason: 'auth_error',
    });
    expect(
      audit.calls.some((c) => c.action === 'push_subscription_expired'),
    ).toBe(false);
  });

  it('thrown WebPushError(403) → mapped to auth error (keep + fail fast)', async () => {
    // The production path: web-push.sendNotification THROWS a WebPushError on a
    // non-2xx status rather than returning a code. This exercises the catch →
    // err.statusCode extraction that makes the real 403 fix work.
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      throw new WebPushError('Forbidden', 403, {}, '', '');
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(1);
    expect(store.get(record.id)).toBeDefined();
    const failed = audit.calls.filter((c) => c.action === 'push_send_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toMatchObject({
      statusCode: 403,
      reason: 'auth_error',
    });
  });

  it('503 then 201 → retried then push_sent', async () => {
    const codes = [503, 201];
    let i = 0;
    const transport: PushTransport = async () => ({ statusCode: codes[i++] });
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(i).toBe(2);
    expect(audit.calls.filter((c) => c.action === 'push_sent')).toHaveLength(1);
    expect(store.get(record.id)).toBeDefined();
  });

  it('persistent 503 → 5 attempts then push_send_failed, subscription kept', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      return { statusCode: 503 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(5);
    const failed = audit.calls.filter((c) => c.action === 'push_send_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toMatchObject({
      subscriptionId: record.id,
      statusCode: 503,
      reason: 'transient_exhausted',
    });
    expect(store.get(record.id)).toBeDefined();
  });

  it('network throw then 201 → retried then push_sent', async () => {
    let calls = 0;
    const transport: PushTransport = async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return { statusCode: 201 };
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await sender.send(record, PAYLOAD);
    expect(calls).toBe(2);
    expect(audit.calls.filter((c) => c.action === 'push_sent')).toHaveLength(1);
  });

  it('never throws even when the audit recorder throws', async () => {
    const throwingAudit: AuditRecorder = {
      record: async () => {
        throw new Error('audit boom');
      },
    };
    const transport: PushTransport = async () => ({ statusCode: 201 });
    const sender = new PushSender(vapid, store, throwingAudit, {
      transport,
      ...FAST,
    });
    await expect(sender.send(record, PAYLOAD)).resolves.toBeUndefined();
  });

  it('never throws even when the transport throws on every attempt', async () => {
    const transport: PushTransport = async () => {
      throw new Error('always down');
    };
    const sender = new PushSender(vapid, store, audit, { transport, ...FAST });
    await expect(sender.send(record, PAYLOAD)).resolves.toBeUndefined();
    expect(audit.calls.some((c) => c.action === 'push_send_failed')).toBe(true);
    expect(store.get(record.id)).toBeDefined();
  });
});
