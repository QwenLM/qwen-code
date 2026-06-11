/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import type { Policy } from './loader.js';
import { PolicyEnforcer } from './enforcer.js';

/** Fake audit recorder collecting entries; never throws. */
function fakeAudit(): { entries: AuditEntry[]; recorder: AuditRecorder } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    recorder: {
      record: async (entry: AuditEntry): Promise<void> => {
        entries.push(entry);
      },
    },
  };
}

/** A permission_request event with the daemon's nested toolCall/options shape. */
function permEvent(
  tool: string,
  opts: { requestId?: string; withOptions?: boolean; args?: unknown } = {},
): { type: string; data: unknown } {
  const { requestId = 'r1', withOptions = true, args } = opts;
  return {
    type: 'permission_request',
    data: {
      requestId,
      toolCall: { name: tool, input: args ?? {} },
      // allow_always at [0] (must NOT be chosen) + the allow_once we expect.
      options: withOptions
        ? [
            { optionId: 'always', kind: 'allow_always', label: 'Always allow' },
            { optionId: 'ok', kind: 'allow_once', label: 'Allow once' },
          ]
        : [],
    },
  };
}

const allowBash: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [{ id: 'allow-bash', match: { tool: 'bash' }, action: 'allow' }],
};

const denyBash: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [{ id: 'deny-bash', match: { tool: 'bash' }, action: 'deny' }],
};

const emptyPolicy: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [],
};

// An allow rule whose expiresAt is firmly in the past: the (real-clock)
// evaluator classifies it as a definitive no-match → falls through to default
// prompt, so the enforcer must NOT auto-vote. Clock-independent.
const expiredAllowBash: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'expired-allow',
      match: { tool: 'bash' },
      action: 'allow',
      expiresAt: '2000-01-01T00:00:00Z',
    },
  ],
};

let stub: StubDaemon | undefined;

afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('PolicyEnforcer', () => {
  it('allow + options + 200 → votes selected, returns true, audits voted:true', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(true);
    expect(audit.entries).toHaveLength(1);
    const e = audit.entries[0];
    expect(e.action).toBe('policy_decision');
    expect(e.detail).toMatchObject({
      requestId: 'r1',
      action: 'allow',
      ruleId: 'allow-bash',
      voted: true,
    });
  });

  it('deny → votes cancelled, returns true, audits voted:true', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, denyBash, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(true);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'deny',
      voted: true,
    });
  });

  it('prompt (empty policy) → returns false, no vote, audits voted:false', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, emptyPolicy, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'prompt',
      voted: false,
    });
  });

  it('allow + NO options → no vote, returns false, audits voted:false (fail-safe)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permEvent('bash', { withOptions: false }),
    );
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'allow',
      voted: false,
    });
  });

  it('SECURITY: allow but options have ONLY allow_always (no allow_once) → no vote (fail-safe)', async () => {
    // Auto-voting an allow_always option would persist a standing grant / flip
    // the session to auto-edit. With no allow_once available we must NOT vote.
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', {
      type: 'permission_request',
      data: {
        requestId: 'r1',
        toolCall: { name: 'bash', input: {} },
        options: [{ optionId: 'always', kind: 'allow_always' }],
      },
    });
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'allow',
      voted: false,
    });
  });

  it('allow but stub 404 → vote not accepted → returns false, voted:false', async () => {
    stub = await startStubDaemon({ permissionStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'allow',
      voted: false,
    });
  });

  it('allow but stub 500 → vote not accepted/throws → returns false, voted:false', async () => {
    stub = await startStubDaemon({ permissionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'allow',
      voted: false,
    });
  });

  it('an out-of-window / expired allow rule does NOT auto-vote (falls through to prompt)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, expiredAllowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', permEvent('bash'));
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'prompt',
      voted: false,
    });
  });

  it('non-permission_request event → returns false, no audit', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', {
      type: 'session_update',
      data: { text: 'hi' },
    });
    expect(handled).toBe(false);
    expect(audit.entries).toHaveLength(0);
  });

  it('audit detail never includes tool args (no path/command leakage)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    await enf.handlePermission(
      's1',
      permEvent('bash', { args: { command: 'rm -rf /secret/path' } }),
    );
    const blob = JSON.stringify(audit.entries);
    expect(blob).not.toContain('rm -rf');
    expect(blob).not.toContain('/secret/path');
  });

  it('allow but NO requestId → no vote, returns false, voted:false', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowBash, audit.recorder);

    const handled = await enf.handlePermission('s1', {
      type: 'permission_request',
      data: { toolCall: { name: 'bash' }, options: [{ optionId: 'ok' }] },
    });
    expect(handled).toBe(false);
    expect(audit.entries[0].detail).toMatchObject({
      action: 'allow',
      voted: false,
    });
  });

  it("stamps decisionSource:'policy' on a rule-decided allow/deny, 'default' on no-match (cycle 39)", async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });

    const a = fakeAudit();
    await new PolicyEnforcer(daemon, allowBash, a.recorder).handlePermission(
      's1',
      permEvent('bash'),
    );
    expect(a.entries[0].detail).toMatchObject({ decisionSource: 'policy' });

    const d = fakeAudit();
    await new PolicyEnforcer(daemon, denyBash, d.recorder).handlePermission(
      's1',
      permEvent('bash'),
    );
    expect(d.entries[0].detail).toMatchObject({ decisionSource: 'policy' });

    // No rule matches (empty policy) → default prompt → decisionSource 'default'.
    const p = fakeAudit();
    await new PolicyEnforcer(daemon, emptyPolicy, p.recorder).handlePermission(
      's1',
      permEvent('bash'),
    );
    expect(p.entries[0].detail).toMatchObject({
      action: 'prompt',
      decisionSource: 'default',
    });
  });
});
