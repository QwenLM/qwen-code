/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  automationGateCallId,
  createHostedAutomationGateRelease,
  createHostedAutomationGateRunner,
  HostedAutomationGateHeld,
} from './hosted-automation-gate.js';
import {
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE,
} from './hosted-workspace-profiles.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

const RUN_ID = 'arun_fixture';
const REVISION = 3;
const CALL_ID = automationGateCallId(RUN_ID, REVISION);
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

/** `drop` destroys the connection: the request arrived, its answer never does. */
type Answer = { code?: number; body: unknown } | 'drop';
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
    if (answer === 'drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.code ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture listener');
  const options = {
    broker: { baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' },
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    toolProfile: () => profile,
  };
  const run = createHostedAutomationGateRunner(options);
  const release = createHostedAutomationGateRelease(options);
  return {
    calls,
    probe: () =>
      run({
        automationRunId: RUN_ID,
        definitionRevision: REVISION,
        gate: GATE,
        signal: new AbortController().signal,
      }),
    release: () => release(RUN_ID, REVISION),
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
  const RELEASE = `/tool-sessions/${encodeURIComponent(RUNTIME_SESSION_ID)}:release`;

  it.each([
    ['released', { body: { ...identity, released: true } }],
    ['unknown to the Broker', rejection(404, 'runtime_session_not_found')],
  ] as const)(
    'reads the occurrence’s receipt back without acquiring, and releases the Session it may have inherited (%s)',
    async (_what, release) => {
      // The attempt that settled the probe may have failed to release, or
      // died first: the replay releases, and a Session already gone counts.
      const { calls, probe } = await rig((path) =>
        path === RELEASE
          ? release
          : { body: settled('{"kind":"quiet","durationMs":3}') },
      );
      await expect(probe()).resolves.toEqual({ kind: 'quiet', durationMs: 3 });
      expect(calls.map((call) => call.path)).toEqual([
        '/executions:prepare',
        RELEASE,
      ]);
    },
  );

  it('fails the fire instead of answering while the probe’s Session is unreleased', async () => {
    // Answering would let the scanner settle the occurrence with the Session
    // still a Workspace execution member; failing re-drives it.
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
          return { body: settled('{"kind":"quiet","durationMs":3}') };
        case RELEASE:
          return rejection(503, 'runtime_unavailable');
        default:
          throw new Error(`unexpected ${path}`);
      }
    });
    await expect(probe()).rejects.toThrow(
      /Runtime Session was not released.*runtime_unavailable/,
    );
    expect(calls.at(-1)?.path).toBe(RELEASE);
  });

  it('fails a replay whose inherited Session still cannot be released', async () => {
    const { probe } = await rig((path) =>
      path === RELEASE
        ? rejection(503, 'runtime_unavailable')
        : { body: settled('{"kind":"quiet","durationMs":3}') },
    );
    await expect(probe()).rejects.toThrow(/Runtime Session was not released/);
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

  it('fails the fire for a retry while the occurrence’s Session is held', async () => {
    // An attempt still running, or a lost acquisition still being admitted:
    // settling now could strand a late acquisition, and the Session is not
    // this attempt's to release.
    const { calls, probe } = await rig(() =>
      rejection(409, 'runtime_session_not_ready'),
    );
    await expect(probe()).rejects.toThrow(
      "the occurrence's Runtime Session is held by another attempt",
    );
    expect(calls.map((call) => call.path)).toEqual(['/executions:prepare']);
  });

  it.each([
    [
      'an execution still running',
      {
        body: {
          ...identity,
          executionCallId: 'gate-execution',
          status: { state: 'executing' },
        },
      },
    ],
    ['a Broker fault', rejection(503, 'runtime_store_unavailable')],
  ] as const)(
    'fails the fire for a retry, releasing nothing, on %s',
    async (_what, prepare) => {
      // The probe may still be running under another attempt's Session, or
      // a Session may still be held: a later attempt reads the settled
      // receipt and releases. "Could not start" would settle the occurrence
      // and strand the Session.
      const { calls, probe } = await rig(() => prepare);
      await expect(probe()).rejects.toThrow(
        "the occurrence's Runtime Session is held by another attempt",
      );
      expect(calls.map((call) => call.path)).toEqual(['/executions:prepare']);
    },
  );

  it.each([
    [
      'runtime_broker_execution_unknown',
      "the Runtime lost the occurrence's probe before it settled",
    ],
    [
      'runtime_idempotency_conflict',
      'this occurrence was already probed under another request',
    ],
  ])('answers unknown and releases the Session on %s', async (code, reason) => {
    const { calls, probe } = await rig((path) =>
      path === RELEASE
        ? { body: { ...identity, released: true } }
        : rejection(409, code),
    );
    await expect(probe()).resolves.toEqual({ kind: 'unknown', reason });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      RELEASE,
    ]);
  });

  it('derives a Session per definition revision of the occurrence', () => {
    // A revision that changed the gate probes under fresh identities, and
    // the attempt that finds its revision stale names the old Session.
    expect(CALL_ID).toBe(`${RUN_ID}:gate:${REVISION}`);
    expect(
      hostedRuntimeSessionId(automationGateCallId(RUN_ID, REVISION + 1)),
    ).not.toBe(RUNTIME_SESSION_ID);
  });

  it.each([
    [
      'an execution still running',
      {
        body: {
          ...identity,
          executionCallId: 'gate-execution',
          status: { state: 'executing' },
        },
      },
      'held',
    ],
    [
      'an execution the Runtime lost',
      rejection(409, 'runtime_broker_execution_unknown'),
      'unknown',
    ],
  ] as const)(
    'reads a reservation found only after acquiring like the first answer: %s',
    async (_what, second, expected) => {
      // A Broker that restarted knew no Session at the first ask; under the
      // acquired Session the key names an earlier attempt's execution. That
      // is not "could not start".
      let prepares = 0;
      const { calls, probe } = await rig((path) => {
        if (path === '/executions:prepare') {
          prepares++;
          return prepares === 1
            ? rejection(404, 'runtime_session_not_found')
            : second;
        }
        if (path === '/tool-sessions:acquire') return { body: acquired };
        if (path === RELEASE) return { body: { ...identity, released: true } };
        throw new Error(`unexpected ${path}`);
      });
      if (expected === 'held') {
        await expect(probe()).rejects.toBeInstanceOf(HostedAutomationGateHeld);
        expect(calls.map((call) => call.path)).toEqual([
          '/executions:prepare',
          '/tool-sessions:acquire',
          '/executions:prepare',
        ]);
      } else {
        await expect(probe()).resolves.toEqual({
          kind: 'unknown',
          reason: "the Runtime lost the occurrence's probe before it settled",
        });
        expect(calls.map((call) => call.path)).toEqual([
          '/executions:prepare',
          '/tool-sessions:acquire',
          '/executions:prepare',
          RELEASE,
        ]);
      }
    },
  );

  it.each([
    [
      'still executing: a later attempt reads the real receipt',
      {
        body: {
          ...identity,
          executionCallId: 'gate-execution',
          status: { state: 'executing' },
        },
      },
      'held',
    ],
    [
      'settled meanwhile: its receipt is the answer',
      {
        body: settled(
          '{"kind":"output","stdout":"new mail\\n","truncated":false,"durationMs":5}',
        ),
      },
      'output',
    ],
    [
      'still only prepared: the start never arrived',
      {
        body: {
          ...identity,
          executionCallId: 'gate-execution',
          status: { state: 'prepared' },
        },
      },
      'cancelled',
    ],
  ] as const)(
    'reads the reservation again when it loses sight of a started probe: %s',
    async (_what, now, expected) => {
      // A poll that fails once must not cost the occurrence a probe that is
      // running fine; only a reservation that never started is cancelled.
      let prepares = 0;
      const { calls, probe } = await rig((path) => {
        switch (path) {
          case '/executions:prepare':
            prepares++;
            return prepares === 1
              ? rejection(404, 'runtime_session_not_found')
              : prepares === 2
                ? {
                    body: {
                      ...identity,
                      executionCallId: 'gate-execution',
                      status: { state: 'prepared' },
                    },
                  }
                : now;
          case '/tool-sessions:acquire':
            return { body: acquired };
          case '/executions/gate-execution:start':
            return rejection(503, 'runtime_store_unavailable');
          case '/executions/gate-execution':
            return rejection(503, 'runtime_store_unavailable');
          case '/executions/gate-execution:cancel':
            // A prepared reservation settles at once as cancelled.
            return {
              body: {
                ...identity,
                executionCallId: 'gate-execution',
                status: {
                  state: 'settled',
                  result: { executionStatus: 'cancelled', responseParts: [] },
                },
              },
            };
          case RELEASE:
            return { body: { ...identity, released: true } };
          default:
            throw new Error(`unexpected ${path}`);
        }
      });
      const paths = () => calls.map((call) => call.path);
      if (expected === 'held') {
        await expect(probe()).rejects.toBeInstanceOf(HostedAutomationGateHeld);
        expect(paths()).not.toContain('/executions/gate-execution:cancel');
        expect(paths()).not.toContain(RELEASE);
        return;
      }
      if (expected === 'output') {
        await expect(probe()).resolves.toMatchObject({
          kind: 'output',
          stdout: 'new mail\n',
        });
        expect(paths()).not.toContain('/executions/gate-execution:cancel');
      } else {
        await expect(probe()).resolves.toMatchObject({
          kind: 'failed',
          detail: 'could not start: the Runtime never started the probe',
        });
        expect(paths()).toContain('/executions/gate-execution:cancel');
      }
      expect(paths().at(-1)).toBe(RELEASE);
    },
  );

  it.each([
    [
      'settled first: its receipt is the answer',
      {
        body: settled(
          '{"kind":"output","stdout":"late mail\\n","truncated":false,"durationMs":5}',
        ),
      },
      'output',
    ],
    [
      'still running: a later attempt reads how it ended',
      {
        body: {
          ...identity,
          executionCallId: 'gate-execution',
          status: { state: 'cancel_requested' },
        },
      },
      'held',
    ],
  ] as const)(
    'answers by what the cancel finds when a late start landed after all: %s',
    async (_what, cancelled, expected) => {
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
          case '/executions/gate-execution':
            return rejection(503, 'runtime_store_unavailable');
          case '/executions/gate-execution:cancel':
            return cancelled;
          case RELEASE:
            return { body: { ...identity, released: true } };
          default:
            throw new Error(`unexpected ${path}`);
        }
      });
      if (expected === 'held') {
        await expect(probe()).rejects.toBeInstanceOf(HostedAutomationGateHeld);
        expect(calls.map((call) => call.path)).not.toContain(RELEASE);
      } else {
        await expect(probe()).resolves.toMatchObject({
          kind: 'output',
          stdout: 'late mail\n',
        });
        expect(calls.at(-1)?.path).toBe(RELEASE);
      }
    },
  );

  it('leaves a Session a restarted Broker holds only on record to the Workspace cascade', async () => {
    // The replay never acquires; a Broker that restarted cannot prove the
    // release of a Session it does not hold in memory. Acquiring it to
    // release it could provision a Runtime: the answer goes out instead.
    const { calls, probe } = await rig((path) =>
      path === RELEASE
        ? rejection(503, 'runtime_reconciliation_required')
        : { body: settled('{"kind":"quiet","durationMs":3}') },
    );
    await expect(probe()).resolves.toEqual({ kind: 'quiet', durationMs: 3 });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      RELEASE,
    ]);
  });

  it.each([
    [
      'the Broker restarted and knows no live Session',
      'reread',
      rejection(404, 'runtime_session_not_found'),
    ],
    [
      "the cancel's answer is lost",
      'cancel',
      rejection(503, 'runtime_store_unavailable'),
    ],
  ] as const)(
    'retries rather than answers when it cannot tell how a started probe ended: %s',
    async (_what, where, failure) => {
      // An answer here could publish unknown or "never started" for a
      // probe whose receipt says output; a later attempt reads it.
      let prepares = 0;
      const { calls, probe } = await rig((path) => {
        switch (path) {
          case '/executions:prepare':
            prepares++;
            if (prepares === 1)
              return rejection(404, 'runtime_session_not_found');
            if (prepares === 3 && where === 'reread') return failure;
            return {
              body: {
                ...identity,
                executionCallId: 'gate-execution',
                status: { state: 'prepared' },
              },
            };
          case '/tool-sessions:acquire':
            return { body: acquired };
          case '/executions/gate-execution:start':
          case '/executions/gate-execution':
            return rejection(503, 'runtime_store_unavailable');
          case '/executions/gate-execution:cancel':
            return failure;
          default:
            throw new Error(`unexpected ${path}`);
        }
      });
      await expect(probe()).rejects.toBeInstanceOf(HostedAutomationGateHeld);
      expect(calls.map((call) => call.path)).not.toContain(RELEASE);
    },
  );

  it('answers failed for a Workspace that cannot admit the probe, with the reason', async () => {
    // Busy or unavailable may last (a maintenance hold, a missing cwd): a
    // visible failure per slot, not hours of retries the status never shows.
    const { calls, probe } = await rig((path) =>
      path === '/executions:prepare'
        ? rejection(404, 'runtime_session_not_found')
        : rejection(409, 'workspace_busy'),
    );
    await expect(probe()).resolves.toMatchObject({
      kind: 'failed',
      detail: expect.stringContaining('workspace_busy'),
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      '/tool-sessions:acquire',
    ]);
  });

  it('keeps retrying while a restarted Broker sorts out an acquisition it did not confirm', async () => {
    // The probe may have run before the restart; until the Broker can say,
    // "could not start" would publish a guess.
    const { probe } = await rig((path) => {
      if (path === '/executions:prepare')
        return rejection(404, 'runtime_session_not_found');
      if (path === '/tool-sessions:acquire')
        return rejection(503, 'runtime_reconcile_in_progress');
      return rejection(503, 'runtime_reconciliation_required');
    });
    await expect(probe()).rejects.toThrow(/was not released/);
  });

  it('never says a probe it started could not start, on a later attempt', async () => {
    // Attempt 1 starts the probe and loses it to a Broker restart; attempt
    // 2 cannot acquire the Session again. The probe may have run.
    let attempt = 1;
    let prepares = 0;
    const { probe } = await rig((path) => {
      switch (path) {
        case '/executions:prepare':
          prepares++;
          if (attempt === 1 && prepares === 2)
            return {
              body: {
                ...identity,
                executionCallId: 'gate-execution',
                status: { state: 'prepared' },
              },
            };
          return rejection(404, 'runtime_session_not_found');
        case '/tool-sessions:acquire':
          return attempt === 1
            ? { body: acquired }
            : rejection(409, 'runtime_session_conflict');
        default:
          return rejection(503, 'runtime_store_unavailable');
      }
    });
    await expect(probe()).rejects.toBeInstanceOf(HostedAutomationGateHeld);
    attempt = 2;
    await expect(probe()).resolves.toMatchObject({
      kind: 'unknown',
      reason: expect.stringContaining('an earlier attempt started the probe'),
    });
  });

  it.each([
    ['released', { body: { ...identity, released: true } }, true],
    [
      'unknown to the Broker',
      rejection(404, 'runtime_session_not_found'),
      true,
    ],
    ['busy', rejection(409, 'runtime_session_busy'), false],
  ] as const)(
    'releases the Session of a revision no fire probes again (%s)',
    async (_what, answer, ok) => {
      const { calls, release } = await rig((path) =>
        path === RELEASE ? answer : rejection(500, 'unexpected'),
      );
      if (ok) await expect(release()).resolves.toBeUndefined();
      else await expect(release()).rejects.toThrow(/was not released/);
      expect(calls.map((call) => call.path)).toEqual([RELEASE]);
    },
  );

  it('keeps a not-found release after a lost acquisition from settling the fire', async () => {
    // The Broker may still be admitting the acquisition whose answer was
    // lost: "not found" now proves nothing, so the fire is retried.
    const { calls, probe } = await rig((path) => {
      switch (path) {
        case '/executions:prepare':
          return rejection(404, 'runtime_session_not_found');
        case '/tool-sessions:acquire':
          return 'drop';
        default:
          return rejection(404, 'runtime_session_not_found');
      }
    });
    await expect(probe()).rejects.toThrow(/Runtime Session was not released/);
    expect(calls.at(-1)?.path).toBe(RELEASE);
  });

  it('releases a Session the Broker already holds even when its own acquire is refused', async () => {
    // A live reservation for the occurrence means the Session exists: a
    // late acquisition from a lost answer, say. A refused acquire must not
    // leave it behind.
    const { calls, probe } = await rig((path) => {
      switch (path) {
        case '/executions:prepare':
          return {
            body: {
              ...identity,
              executionCallId: 'gate-execution',
              status: { state: 'prepared' },
            },
          };
        case '/tool-sessions:acquire':
          return rejection(409, 'runtime_session_not_acquirable');
        case RELEASE:
          return { body: { ...identity, released: true } };
        default:
          throw new Error(`unexpected ${path}`);
      }
    });
    await expect(probe()).resolves.toMatchObject({ kind: 'failed' });
    expect(calls.map((call) => call.path)).toEqual([
      '/executions:prepare',
      '/tool-sessions:acquire',
      RELEASE,
    ]);
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

  it.each([
    ['its answer is lost', 'drop' as const],
    ['the Broker fails on it', rejection(503, 'runtime_unavailable')],
  ])(
    'releases before answering when an acquisition is unconfirmed: %s',
    async (_what, acquire) => {
      // The acquisition may have committed before the answer was lost: the
      // Session would stay a Workspace execution member with nobody left to
      // release it once the occurrence settles.
      const { calls, probe } = await rig((path) => {
        switch (path) {
          case '/executions:prepare':
            return rejection(404, 'runtime_session_not_found');
          case '/tool-sessions:acquire':
            return acquire;
          case RELEASE:
            return { body: { ...identity, released: true } };
          default:
            throw new Error(`unexpected ${path}`);
        }
      });
      await expect(probe()).resolves.toMatchObject({ kind: 'failed' });
      expect(calls.map((call) => call.path)).toEqual([
        '/executions:prepare',
        '/tool-sessions:acquire',
        RELEASE,
      ]);
    },
  );

  it('fails the fire when an unconfirmed acquisition cannot be released', async () => {
    const { probe } = await rig((path) => {
      switch (path) {
        case '/executions:prepare':
          return rejection(404, 'runtime_session_not_found');
        case '/tool-sessions:acquire':
          return 'drop';
        default:
          return rejection(503, 'runtime_unavailable');
      }
    });
    await expect(probe()).rejects.toThrow(/Runtime Session was not released/);
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
