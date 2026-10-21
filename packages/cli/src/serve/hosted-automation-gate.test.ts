/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  automationGateCallId,
  createHostedAutomationGateRunner,
} from './hosted-automation-gate.js';
import {
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE,
} from './hosted-workspace-profiles.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

const RUN_ID = 'arun_fixture';
const CALL_ID = automationGateCallId(RUN_ID);
const RUNTIME_SESSION_ID = hostedRuntimeSessionId(CALL_ID);
const GATE = 'sh ./probe.sh';
const PREFIX = '/internal/runtime-broker/v1';
const identity = {
  protocolVersion: 1,
  harnessSessionId: 'session',
  runtimeSessionId: RUNTIME_SESSION_ID,
};
const settled = (text: string) => ({
  ...identity,
  executionCallId: 'gate-execution',
  status: {
    state: 'settled',
    result: { executionStatus: 'success', responseParts: [{ text }] },
  },
});
const rejection = (code: number, reason: string) => ({
  code,
  body: { code: reason, message: reason },
});

type Answer = { code?: number; body: unknown };
type Script = (path: string, body: Record<string, unknown>) => Answer;

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** A scripted Broker and the runner bound to it; `calls` lists what the runner sent. */
async function rig(
  script: Script,
  profile: unknown = HOSTED_WORKSPACE_SHELL_PROFILE,
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://fixture');
    const body = raw
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(url.searchParams);
    const path = url.pathname.slice(PREFIX.length);
    calls.push({ path, body });
    const answer = script(path, body);
    res.writeHead(answer.code ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture listener');
  const run = createHostedAutomationGateRunner({
    broker: { baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' },
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    toolProfile: () => profile,
  });
  return {
    calls,
    probe: () =>
      run({
        automationRunId: RUN_ID,
        gate: GATE,
        signal: new AbortController().signal,
      }),
  };
}

const acquired = {
  ...identity,
  acquired: true,
  scope: {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
  },
};

describe('createHostedAutomationGateRunner', () => {
  it('reads the occurrence’s receipt back without acquiring a Runtime Session', async () => {
    const { calls, probe } = await rig((path) => {
      expect(path).toBe('/executions:prepare');
      return { body: settled('{"kind":"quiet","durationMs":3}') };
    });
    await expect(probe()).resolves.toEqual({ kind: 'quiet', durationMs: 3 });
    expect(calls.map((call) => call.path)).toEqual(['/executions:prepare']);
  });

  it('acquires, reserves, starts and releases only when the Broker knows no Session for the occurrence', async () => {
    let prepares = 0;
    const { calls, probe } = await rig((path) => {
      switch (path) {
        case '/executions:prepare':
          prepares++;
          return prepares === 1
            ? rejection(404, 'runtime_session_not_found')
            : {
                body: {
                  ...identity,
                  executionCallId: 'gate-execution',
                  status: { state: 'prepared' },
                },
              };
        case '/tool-sessions:acquire':
          return { body: acquired };
        case '/executions/gate-execution:start':
          return {
            body: settled(
              '{"kind":"output","stdout":"event: comment\\n","truncated":false,"durationMs":9}',
            ),
          };
        case `/tool-sessions/${encodeURIComponent(RUNTIME_SESSION_ID)}:release`:
          return { body: { ...identity, released: true } };
        default:
          throw new Error(`unexpected ${path}`);
      }
    });
    await expect(probe()).resolves.toEqual({
      kind: 'output',
      stdout: 'event: comment\n',
      truncated: false,
      durationMs: 9,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      '/tool-sessions:acquire',
      '/executions:prepare',
      '/executions/gate-execution:start',
      `/tool-sessions/${encodeURIComponent(RUNTIME_SESSION_ID)}:release`,
    ]);
    // Every part of the reservation and the payload derives from the
    // occurrence, so a re-drive meets the same key and reference.
    const reservation = calls[2].body;
    expect(reservation).toMatchObject({
      runtimeSessionId: RUNTIME_SESSION_ID,
      idempotencyKey: `${RUNTIME_SESSION_ID}:${CALL_ID}`,
      toolCallId: CALL_ID,
      reference: {
        sessionId: RUNTIME_SESSION_ID,
        promptId: RUNTIME_SESSION_ID,
        callId: CALL_ID,
      },
    });
    expect(calls[0].body).toMatchObject({
      idempotencyKey: reservation['idempotencyKey'],
      requestDigest: reservation['requestDigest'],
    });
    expect(JSON.parse(calls[3].body['payloadJson'] as string)).toEqual({
      toolName: 'managed_automation_gate',
      input: { gate: GATE },
    });
  });

  it('answers unknown while another attempt holds the occurrence’s Session', async () => {
    const { calls, probe } = await rig(() =>
      rejection(409, 'runtime_session_not_ready'),
    );
    await expect(probe()).resolves.toEqual({
      kind: 'unknown',
      reason: "the occurrence's Runtime Session is held by another attempt",
    });
    expect(calls.map((call) => call.path)).toEqual(['/executions:prepare']);
  });

  it('answers failed, not unknown, when the derived Session cannot be acquired', async () => {
    const { calls, probe } = await rig((path) =>
      path === '/executions:prepare'
        ? rejection(404, 'runtime_session_not_found')
        : rejection(409, 'runtime_session_not_acquirable'),
    );
    await expect(probe()).resolves.toEqual({
      kind: 'failed',
      detail:
        'could not start: Runtime Broker returned HTTP 409 (runtime_session_not_acquirable).',
      stderr: '',
      durationMs: 0,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      '/tool-sessions:acquire',
    ]);
  });

  it('blocks a Session whose tool profile declares no Shell before asking the Broker', async () => {
    const { calls, probe } = await rig(() => {
      throw new Error('the Broker must not be asked');
    }, HOSTED_WORKSPACE_FILE_PROFILE);
    await expect(probe()).resolves.toEqual({
      kind: 'blocked',
      reason: "the Session's tool profile declares no Shell",
    });
    expect(calls).toEqual([]);
  });
});
