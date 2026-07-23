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

/**
 * REAL permission_request data: the daemon emits the ACP ToolCall verbatim as
 * `{ toolCallId, title, kind, rawInput }`. The old synthetic `{ name, input }`
 * shape is what hid the extraction bug for nine policy cycles — never
 * reintroduce it. Every permission event in this file is built through this
 * one helper.
 *
 * `opts.requestId: null` omits `requestId` entirely (vs. the default `'q1'`),
 * for the fail-safe "no requestId" case. `opts.options` overrides the default
 * two-option (`allow_always` + `allow_once`) list for the fail-safe
 * "no options" / "only allow_always" cases.
 */
function permissionEvent(
  kind: string,
  rawInput: Record<string, unknown> = {},
  opts: {
    requestId?: string | null;
    options?: unknown[];
  } = {},
): { type: string; data: unknown } {
  const requestId = 'requestId' in opts ? opts.requestId : 'q1';
  return {
    type: 'permission_request',
    data: {
      ...(requestId ? { requestId } : {}),
      sessionId: 's1',
      toolCall: { toolCallId: 'tc1', title: 'humanized', kind, rawInput },
      options: opts.options ?? [
        { optionId: 'always', kind: 'allow_always', label: 'Always allow' },
        { optionId: 'ok', kind: 'allow_once', label: 'Allow once' },
      ],
    },
  };
}

const allowExecute: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [{ id: 'allow-bash', match: { tool: 'execute' }, action: 'allow' }],
};

const denyExecute: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [{ id: 'deny-bash', match: { tool: 'execute' }, action: 'deny' }],
};

const emptyPolicy: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [],
};

// An allow rule whose expiresAt is firmly in the past: the (real-clock)
// evaluator classifies it as a definitive no-match → falls through to default
// prompt, so the enforcer must NOT auto-vote. Clock-independent.
const expiredAllowExecute: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'expired-allow',
      match: { tool: 'execute' },
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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
    const enf = new PolicyEnforcer(daemon, denyExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1', options: [] }),
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent(
        'execute',
        {},
        {
          requestId: 'r1',
          options: [{ optionId: 'always', kind: 'allow_always' }],
        },
      ),
    );
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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
    const enf = new PolicyEnforcer(daemon, expiredAllowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

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
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    await enf.handlePermission(
      's1',
      permissionEvent(
        'execute',
        { command: 'rm -rf /secret/path' },
        { requestId: 'r1' },
      ),
    );
    const blob = JSON.stringify(audit.entries);
    expect(blob).not.toContain('rm -rf');
    expect(blob).not.toContain('/secret/path');
  });

  it('allow but NO requestId → no vote, returns false, voted:false', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const enf = new PolicyEnforcer(daemon, allowExecute, audit.recorder);

    const handled = await enf.handlePermission(
      's1',
      permissionEvent(
        'execute',
        {},
        { requestId: null, options: [{ optionId: 'ok' }] },
      ),
    );
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
    await new PolicyEnforcer(daemon, allowExecute, a.recorder).handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
    expect(a.entries[0].detail).toMatchObject({ decisionSource: 'policy' });

    const d = fakeAudit();
    await new PolicyEnforcer(daemon, denyExecute, d.recorder).handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
    expect(d.entries[0].detail).toMatchObject({ decisionSource: 'policy' });

    // No rule matches (empty policy) → default prompt → decisionSource 'default'.
    const p = fakeAudit();
    await new PolicyEnforcer(daemon, emptyPolicy, p.recorder).handlePermission(
      's1',
      permissionEvent('execute', {}, { requestId: 'r1' }),
    );
    expect(p.entries[0].detail).toMatchObject({
      action: 'prompt',
      decisionSource: 'default',
    });
  });

  it('matches a rule against a REAL frame (kind + rawInput)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const policy: Policy = {
      defaults: { action: 'prompt' },
      rules: [{ id: 'deny-shell', match: { tool: 'execute' }, action: 'deny' }],
    };
    const enf = new PolicyEnforcer(
      daemon,
      policy,
      audit.recorder,
      undefined,
      () => 0,
      () => '/proj',
    );
    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', { command: 'rm -rf /' }),
    );
    expect(handled).toBe(true);
    expect(
      (stub.lastRespondedPermission?.response as { outcome?: unknown })
        ?.outcome,
    ).toEqual({ outcome: 'cancelled' });
  });

  it('matches a pathGlob rule via rawInput.file_path', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const policy: Policy = {
      defaults: { action: 'prompt' },
      rules: [
        {
          id: 'deny-env',
          match: { pathGlob: ['**/.env*'] },
          action: 'deny',
        },
      ],
    };
    const enf = new PolicyEnforcer(
      daemon,
      policy,
      audit.recorder,
      undefined,
      () => 0,
      () => '/proj',
    );
    const handled = await enf.handlePermission(
      's1',
      permissionEvent('edit', { file_path: '/proj/.env' }),
    );
    expect(handled).toBe(true);
  });

  it('leaves originScope/sessionTag unpopulated (documented limitation)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const policy: Policy = {
      defaults: { action: 'prompt' },
      rules: [
        {
          id: 'scoped',
          match: { originScope: 'write' },
          action: 'deny',
        },
      ],
    };
    const enf = new PolicyEnforcer(
      daemon,
      policy,
      audit.recorder,
      undefined,
      () => 0,
      () => '/proj',
    );
    const handled = await enf.handlePermission(
      's1',
      permissionEvent('execute', { command: 'ls' }),
    );
    expect(handled).toBe(false); // no match → falls through to a human
  });
});
