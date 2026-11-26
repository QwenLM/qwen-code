/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  domainEnablement,
  enforceInlineResourceLimit,
  expectFullStreamedAnswer,
  headers,
  runnerApiHistory,
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
  writeCancelledGroupWithLegacySnapshot,
  writeSettledToolHistory,
} from './hosted-harness-session.test-helper.js';
import {
  BOOT_ID_2,
  CALL,
  FILE_PROFILE,
  acquireSpy,
  loadReplacement,
  parkToolTurn,
  replacementApp,
  replacementHeaders,
  spyOnAcquire,
  storeFor,
  useRuntimeTakeover,
} from './hosted-harness-session-takeover.test-helper.js';
import { createHash } from 'node:crypto';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
} from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  it('continues the resident prompt after recovering the original Broker result', async () => {
    const { server, clientId } = await parkToolTurn(
      true,
      FILE_PROFILE,
      true,
      new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body.clientId).toBe(clientId);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { phase: string; checkpointId: string; activationId: string };
    expect(recovery.phase).toBe('results_ready');
    const continued = await headers(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('keeps the adopted lease when a continue meets the recovery-blocked Session', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    // Drive the recovered turn into a recovery-blocked exit: the parked Turn
    // still owns the adopted lease.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The blocked refusal keeps the lease too: the Turn is still parked, and
    // a release would persist RELEASED, wedging the next takeover's
    // same-identity re-acquire on runtime_session_not_acquirable.
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(release).not.toHaveBeenCalled();
    // The close owns the adopted lease's single handback.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the owed lease when a fresh prompt exits recovery-blocked', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(
          503,
          'runtime_reconciliation_required',
        ),
      )
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    // The cancelled Turn settled, but the handback was refused: the lease
    // is owed to the next terminal route.
    expect(release).toHaveBeenCalledTimes(1);
    // The fresh prompt's Turn exits recovery-blocked: the parked Turn owns
    // the owed lease now, so the settle-tail retry must NOT fire — a
    // release would persist RELEASED and wedge the later takeover's
    // same-identity re-acquire on runtime_session_not_acquirable.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const nextPrompt = [{ type: 'text', text: 'blocked exit' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '55555555-5555-4555-8555-555555555555',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(release).toHaveBeenCalledTimes(1);
    // The owed lease survives to close(), whose handback is the
    // discharger of last resort — proof the blocked exit never fired it.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('continues a turn parked in a second tool round without corrupting history', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const EXEC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const EXEC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare')
      .mockResolvedValueOnce(EXEC_A)
      .mockResolvedValue(EXEC_B);
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((id, _payload, signal) => {
        if (id === EXEC_A) {
          return Promise.resolve({
            executionStatus: 'success',
            responseParts: [{ text: 'a written' }],
          }) as never;
        }
        return signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            );
      });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    for (const [id, outcome, reason] of [
      ['prior-crash', 'cancelled', 'harness_interruption'],
      ['prior-cancel', 'cancelled', 'cancelled'],
      ['prior-complete', 'completed', 'end_turn'],
    ] as const)
      await writeSettledToolHistory(managed, id, outcome, reason);
    const CALL_A = {
      name: 'write_file',
      callId: 'call-a',
      args: { file_path: 'a.txt', content: 'a' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    const CALL_B = {
      ...CALL_A,
      callId: 'call-b',
      args: { file_path: 'b.txt', content: 'b' },
    };
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      await toolTurn!.execute(
        [CALL_A],
        [
          {
            functionCall: {
              id: CALL_A.callId,
              name: CALL_A.name,
              args: CALL_A.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.execute(
        [CALL_B],
        [
          {
            functionCall: {
              id: CALL_B.callId,
              name: CALL_B.name,
              args: CALL_B.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'unreached', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'write two files' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      () =>
        expect(execute.mock.calls.some((call) => call[0] === EXEC_B)).toBe(
          true,
        ),
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'b written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
      executions: Array<{ executionCallId: string; outcome: string }>;
    };
    expect(recovery.executions).toHaveLength(2);
    expect(
      recovery.executions.every((execution) => execution.outcome === 'known'),
    ).toBe(true);
    const clientId = loaded.body.clientId as string;
    const continued = await replacementHeaders(
      supertest(replacement).post(
        `/session/${SESSION_ID}/managed-runtime/continue`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const continuedCall = state.model.mock.calls.find(
      (call) =>
        (call[0] as { resumeFromToolResults?: unknown })
          .resumeFromToolResults !== undefined,
    );
    expect(continuedCall).toBeDefined();
    const input = continuedCall![0] as unknown as {
      history: ChatRecord[];
      resumeFromToolResults: unknown[];
    };
    // Round one's tool result stays in history; only the parked round's
    // result becomes the resume request. Assert on the tool_result records —
    // the assistant record carries call-a's functionCall either way.
    const historyResults = input.history.filter(
      (entry) => entry.type === 'tool_result',
    );
    for (const id of ['prior-crash', 'prior-complete'])
      expect(
        input.history
          .filter((entry) => entry.daemonPromptId === id && entry.message)
          .map((entry) => entry.type),
      ).toEqual(['user', 'assistant', 'tool_result']);
    expect(
      input.history.some((entry) => entry.daemonPromptId === 'prior-cancel'),
    ).toBe(false);
    expect(JSON.stringify(historyResults)).toContain('call-a');
    expect(JSON.stringify(historyResults)).not.toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).not.toContain('call-a');
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

  it('excludes a cancelled group from a legacy snapshot on the continue route (PR #15959 R3-3)', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const EXEC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const EXEC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare')
      .mockResolvedValueOnce(EXEC_A)
      .mockResolvedValue(EXEC_B);
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((id, _payload, signal) => {
        if (id === EXEC_A) {
          return Promise.resolve({
            executionStatus: 'success',
            responseParts: [{ text: 'a written' }],
          }) as never;
        }
        return signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            );
      });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    await writeCancelledGroupWithLegacySnapshot(managed);
    const CALL_A = {
      name: 'write_file',
      callId: 'call-a',
      args: { file_path: 'a.txt', content: 'a' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    const CALL_B = {
      ...CALL_A,
      callId: 'call-b',
      args: { file_path: 'b.txt', content: 'b' },
    };
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      await toolTurn!.execute(
        [CALL_A],
        [
          {
            functionCall: {
              id: CALL_A.callId,
              name: CALL_A.name,
              args: CALL_A.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.execute(
        [CALL_B],
        [
          {
            functionCall: {
              id: CALL_B.callId,
              name: CALL_B.name,
              args: CALL_B.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'unreached', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'write two files' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      () =>
        expect(execute.mock.calls.some((call) => call[0] === EXEC_B)).toBe(
          true,
        ),
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'b written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const clientId = loaded.body.clientId as string;
    const continued = await replacementHeaders(
      supertest(replacement).post(
        `/session/${SESSION_ID}/managed-runtime/continue`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const continuedCall = state.model.mock.calls.find(
      (call) =>
        (call[0] as { resumeFromToolResults?: unknown })
          .resumeFromToolResults !== undefined,
    );
    expect(continuedCall).toBeDefined();
    const input = continuedCall![0] as unknown as {
      history: ChatRecord[];
      excludedPromptIds?: ReadonlySet<string>;
    };
    // Inspect the api history the runner would actually send: the cancelled
    // group's compressed copy must be absent while the completed group survives.
    // Skipping the continue route's normalization leaves the snapshot's legacy
    // marks unbridged, so the cancelled copy leaks into the request.
    const api = JSON.stringify(runnerApiHistory(input));
    expect(api).not.toContain('prior-cancel:background-agent');
    expect(api).toContain('prior-complete:background-agent');
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

  it('bridges a legacy snapshot when the continue route answers a team sibling (PR #15959 R3-3)', async () => {
    domainEnablement.childRun = true;
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      spyOnAcquire().mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '66666666-6666-4666-8666-666666666666',
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      const managed = (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed;
      await writeCancelledGroupWithLegacySnapshot(managed);
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const later = {
        name: 'task_create',
        callId: 'call-2',
        args: { subject: 'Audit', description: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      const team = {
        name: 'team_create',
        callId: 'call-0',
        args: { team_name: 'review' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal }) =>
          toolTurn!.execute(
            [team, CALL, later],
            [team, CALL, later].map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          ) as never,
      );
      const prompt = [{ type: 'text', text: 'team and a file' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'workspaceContext',
      ).mockResolvedValue([]);
      const { server: replacement, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      let resumedInput:
        | { history?: ChatRecord[]; excludedPromptIds?: ReadonlySet<string> }
        | undefined;
      state.model.mockImplementationOnce(async (input) => {
        resumedInput = input as {
          history?: ChatRecord[];
          excludedPromptIds?: ReadonlySet<string>;
        };
        return { text: 'continued', model: 'test-model' };
      });
      const continued = await replacementHeaders(
        supertest(replacement).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(() => expect(resumedInput).toBeDefined(), {
        timeout: settleTimeoutMs(),
      });
      // Answering the team sibling re-derives the history; that refresh must
      // bridge the snapshot's legacy marks so the cancelled group's compressed
      // copy stays out of the api history the runner would send.
      const api = JSON.stringify(runnerApiHistory(resumedInput!));
      expect(api).not.toContain('prior-cancel:background-agent');
      expect(api).toContain('prior-complete:background-agent');
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      await replacementHeaders(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.childRun = true;
    }
  }, 30_000);

  it('refuses the load with a retryable refusal when the takeover drive fails', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockRejectedValue(
      new Error('broker unreachable'),
    );
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('takeover_failed');
    // The takeover acquired the Runtime Session before the drive failed; the
    // refusal must hand the lease back or the Workspace stays pinned.
    expect(release).toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses continue with a mismatched recovery identity', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const send = (body: Record<string, unknown>) =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send(body);
    expect((await send({ promptId: PROMPT_ID })).status).toBe(400);
    expect(
      (
        await send({
          promptId: PROMPT_ID,
          checkpointId: 'ckpt-other',
          activationId: 'activation-other',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await replacementHeaders(
          supertest(server).post(
            `/session/44444444-4444-4444-8444-444444444444/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: 'ckpt',
            activationId: 'activation',
          })
      ).status,
    ).toBe(404);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost continue admission at its original watermark', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The turn settled by now; the coordinator's replay must still answer
    // with the admission watermark, not the current sequence.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('releases the recovered Runtime lease when the Session detaches', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(release).not.toHaveBeenCalled();
    const clientId = loaded.body.clientId as string;
    const detached = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(detached.status).toBe(204);
    expect(release).toHaveBeenCalled();
  });

  it.each(['inline', 'chunked'])(
    'completes an answer (%s) and clears file history after a recovered Write continuation',
    async (storage) => {
      await parkToolTurn();
      const text =
        storage === 'chunked' ? '续接😀'.repeat(31_000) : 'hello back';
      if (storage === 'chunked') {
        await enforceInlineResourceLimit();
        state.model.mockImplementationOnce(async ({ textDeltas }) => {
          expect(textDeltas).toBeDefined();
          await textDeltas!.delta(text);
          return { text, model: 'test-model' };
        });
      }

      // The parked Write left its file-history obligation durable.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const historyBefore = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(historyBefore.body.history.pendingTurn).toBe(PROMPT_ID);
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const historyAfter = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(historyAfter.body.history.pendingTurn).toBeNull();
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
      ).set('X-Qwen-Client-Id', clientId);
      if (storage === 'chunked')
        expectFullStreamedAnswer(transcript.body, text);
      // The obligation is gone: a cold load and a file tool run normally.
      await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      const reloaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
      });
      expect(reloaded.status).toBe(200);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );

  it('refuses the replay of a continuation that became recovery blocked', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation hits an unrecoverable write: the Session latches
    // blocked without a terminal record.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // "accepted" is the only signal the coordinator ever got, but the Turn
    // will never settle — the replay must surface the refusal instead.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    expect(replayed.body.reason).toBe('turn_blocked');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('leaves the continuation re-drivable when the resume meets a retryable acquisition refusal', async () => {
    // A parked read-only turn carries no file-history pendingTurn marker,
    // so the continuation's resumeCommittedResults() reaches its
    // fall-through re-acquire — the only path on which a retryable Broker
    // refusal escapes raw.
    await parkToolTurn([
      {
        name: 'read_file',
        callId: 'call-1',
        args: { file_path: 'a.txt' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      },
    ] as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'contents' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation's re-acquire meets a retryable busy refusal: the
    // checkpoint's Runtime receipts are still unconsumed, so the Turn must
    // stay re-drivable (recovery-blocked) rather than settle terminally.
    acquireSpy.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const continued = await send();
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // No terminal record landed: the Turn is still there to drive.
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          (event.type === 'turn_complete' || event.type === 'turn_error') &&
          event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // A replay meets the refusal rather than re-answering a certified
    // admission that will never settle.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    // Neither the recovery-blocked drive nor the replay's refusal hands the
    // adopted lease back: a release persists RELEASED, and the same-identity
    // re-acquire the takeover below depends on would conflict with
    // runtime_session_not_acquirable forever.
    expect(release).not.toHaveBeenCalled();
    // …and a fresh incarnation can take the same Turn over: the recovery
    // report is still offered, so the drive can be retried there.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    const { server: restarted, loaded: reloaded } = await loadReplacement();
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeDefined();
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker when the compensating settle runs after a drive failure', async () => {
    // The parked write_file Turn carries a durable file-history marker; the
    // continuation never reaches its resume, so the compensating settle
    // owns the retirement.
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The drive's first projection read fails before any resume runs, so
    // the marker is still pending when the compensating settle lands.
    vi.spyOn(
      ManagedSessionRecordSink.prototype,
      'project',
    ).mockRejectedValueOnce(new Error('projection lost'));
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The durable record, not a spy: the marker the parked Turn left is
    // retired before the Session goes quiet.
    const history = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(history.body.history.pendingTurn).toBeNull();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('owes the compensating retirement when its write fails, and a settled prompt retires it', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(
      ManagedSessionRecordSink.prototype,
      'project',
    ).mockRejectedValueOnce(new Error('projection lost'));
    // The compensating settle's retirement write fails once: the marker
    // stays durable-owed rather than silently dropped.
    let failHistoryCommit = true;
    const originalCommit =
      LocalManagedSessionAuthority.prototype.commitDomainRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockImplementation(async function (
      this: LocalManagedSessionAuthority,
      record,
      ...rest
    ) {
      if (failHistoryCommit && record.operation === 'commitFileHistory') {
        failHistoryCommit = false;
        throw new Error('history write rejected');
      }
      return originalCommit.call(this, record, ...rest);
    });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The failed drop left the settled Turn's marker pending…
    const owed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(owed.body.history.pendingTurn).toBe(PROMPT_ID);
    // …and the next settled prompt's admission drive retires it.
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const retired = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(retired.body.history.pendingTurn).toBeNull();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost continue admission while the turn still runs', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // Hold the continued Turn open so the replay meets a running one — the
    // ordinary case, since a continuation drives the model for minutes.
    let releaseModel!: () => void;
    const modelGate = new Promise<{ text: string; model: string }>(
      (resolve) => {
        releaseModel = () => resolve({ text: 'done', model: 'test-model' });
      },
    );
    state.model.mockImplementationOnce(() => modelGate);
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
      timeout: settleTimeoutMs(),
    });
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);
    // Let the held-open continuation finish before teardown removes its root.
    releaseModel();
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('settles a raw reconciliation failure as a terminal error and keeps the Session usable', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation's reconciliation escapes resumeCommittedResults()
    // raw. The 200 is already sent and no blocked-on-recovery re-drive
    // exists on this route, so the failure must settle the Turn terminally
    // instead of blocking it forever: only an already-wrapped recovery
    // error still lands in the recovery-blocked handler.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // …and the durable pending-Turn obligation retired with it: a cold load
    // after detach is admitted instead of refused forever, or one warm-up
    // failure would brick the Session's file history.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker after the compensating terminal write too', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The first terminal turn_result write fails once, so the marker
    // retirement must ride the outer catch's compensating path — or the
    // direct-settle retirement never runs and the cold load is refused.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failedOnce = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (!failedOnce && recordToWrite.subtype === 'turn_result') {
          failedOnce = true;
          throw new Error('settle-store hiccup');
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker through close when the retirement write fails once', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    // The retirement failed at the settle point: it stays owed instead of
    // dragging the settled Turn down with it — and nothing blocks.
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    const settledStatus = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settledStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    // …and close retires it, so the cold load is still admitted.
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalledTimes(2), {
      timeout: settleTimeoutMs(),
    });
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    const reloadedStatus = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(reloadedStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it.each([
    { exit: 'DELETE', drain: true },
    // The control plane closes a bound Session through the lifecycle: its
    // effects phase retries the owed cleanup before the detach.
    { exit: 'lifecycle', drain: false },
  ])(
    'retires the owed marker before $exit hands back a cleanup-owed recovered lease',
    async ({ exit, drain }) => {
      const cleanupStates: unknown[] = [];
      const appendEvent =
        LocalManagedSessionAuthority.prototype.appendExecutionEvent;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'appendExecutionEvent',
      ).mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        const appended = await Reflect.apply(appendEvent, this, args);
        if (args[0].operation === 'hostedCleanup')
          cleanupStates.push(
            (
              args[1] as (sequence: number) => {
                payload: Record<string, unknown>;
              }
            )(0).payload['state'],
          );
        return appended;
      });
      await parkToolTurn(false, FILE_PROFILE, true);
      // The parked owner's Runtime binding committed a real cleanup
      // obligation: its release waits on the Turn's file-history marker.
      expect(cleanupStates).toEqual(['owed']);
      let stopConfirmed = false;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
        async () => {
          stopConfirmed = true;
        },
      );
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // Only the cancellation's first retirement write fails: the
      // compensating path lands turn.settled and owes the marker.
      let failHistoryCommit = true;
      const originalCommit =
        LocalManagedSessionAuthority.prototype.commitDomainRecord;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitDomainRecord',
      ).mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        record,
        ...rest
      ) {
        if (failHistoryCommit && record.operation === 'commitFileHistory') {
          failHistoryCommit = false;
          throw new Error('history write rejected');
        }
        return originalCommit.call(this, record, ...rest);
      });
      const send = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      expect((await send()).status).toBe(503);
      expect((await send()).status).toBe(200);
      // The replay's handback is refused while the marker still names the
      // Turn, so the lease stays owed into the close.
      await vi.waitFor(
        () =>
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining(
              'Original file history marker is still owed',
            ),
          ),
        { timeout: settleTimeoutMs() },
      );
      expect(release).not.toHaveBeenCalled();
      if (exit === 'DELETE') {
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).expect(204);
      } else {
        const authority = { operationId: 'close-op', claimGeneration: 1 };
        await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            kind: 'close',
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
            authority,
          })
          .expect(200);
        await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ authority })
          .expect(204);
      }
      // The marker is retired first, so the obligation releases the original
      // Runtime and is confirmed: no 204 with the lease never handed back,
      // and no lifecycle refused on every retry.
      expect(release).toHaveBeenCalledOnce();
      expect(release.mock.contexts[0]).toMatchObject({
        runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
      });
      expect(release.mock.calls[0][0]).toEqual({
        bindingId: 'binding',
        generation: '1',
        ...(drain ? { drain: true } : {}),
      });
      expect(cleanupStates).toEqual(['owed', 'confirmed']);
    },
  );

  it("retires a settled Turn's pending marker on a fresh-incarnation load", async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The marker retirement's durable write stays refused through the
    // cancel *and* the close, so the Session's in-memory owed flag dies
    // with it while the durable marker survives into the next incarnation.
    const commitSpy = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'commitDomainRecord')
      .mockRejectedValue(new Error('history write rejected'));
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    // The retirement failure after the settle answers a retry-inviting 503,
    // but the compensating path still lands the terminal record.
    expect(cancelled.status).toBe(503);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    // The marker is still durable before the close…
    const before = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(before.body.history.pendingTurn).toBe(PROMPT_ID);
    // …and close()'s owed retirement fails against the same refused write,
    // so the marker strands across the incarnation boundary.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    await vi.waitFor(
      () => expect(dropSpy.mock.calls.length).toBeGreaterThan(1),
      {
        timeout: settleTimeoutMs(),
      },
    );
    commitSpy.mockRestore();
    // A fresh incarnation's load retires the settled Turn's marker instead
    // of refusing on it forever.
    const restarted = await replacementApp();
    const reloadedFresh = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloadedFresh.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloadedFresh.body.clientId as string);
    expect(history.body.history.pendingTurn).toBeNull();
    const freshStatus = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', reloadedFresh.body.clientId as string);
    expect(freshStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires an owed file-history marker at admission, before the next write', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    // The continuation settled as an error and owes the pending marker's
    // retirement (its retirement write was refused above).
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    // The drop was invoked, but the drive's busy flag clears only in its
    // finally — wait for that too, or the next /prompt can meet a 409.
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The new Turn's write needs an execution identity of its own — the
    // parked Turn's prepare mock still answers its own id.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '99999999-9999-4999-8999-999999999999',
    );
    // A fresh prompt whose model writes a file: the owed marker must retire
    // at admission — inside the busy flag — or this Turn's first write meets
    // the durable pending marker and blocks with no terminal record.
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
    const nextCall = {
      name: 'write_file',
      callId: 'call-next',
      args: { file_path: 'next.txt', content: 'y' },
      isClientInitiated: false,
      prompt_id: nextPromptId,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [nextCall],
          [
            {
              functionCall: {
                id: nextCall.callId,
                name: nextCall.name,
                args: nextCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const nextPrompt = [{ type: 'text', text: 'write next.txt' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const after = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(after.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('skips the file-history retirement read on a completed continuation', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    // A completed continuation already reconciled inside resumeCommittedResults:
    // the settle tail must not pay another fallible durable round trip that
    // could turn a completed answer into an error.
    expect(dropSpy).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('logs the root cause when the recovered continuation fails pre-wrapped', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The reconcile sees a file-history snapshot that drifted from the
    // durable one, so resumeCommittedResults throws an already-wrapped
    // recovery error; the route must rethrow it as-is, or the blocked log
    // line names the wrapper instead of the cause an operator needs.
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'fileHistory',
    ).mockResolvedValueOnce({
      ownerSessionId: SESSION_ID,
      snapshots: [{ filePath: 'drifted' } as never],
      files: {},
    });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Original file history snapshots changed.'),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  async function loadParkedRecovery() {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    return { server, clientId: loaded.body.clientId as string, recovery };
  }

  it('refuses continue on a profile-less Session', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ promptId: PROMPT_ID, checkpointId: 'x', activationId: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('recovery_unsupported');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('names a lost authorization read on continue and hands the lease back', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockRejectedValue(
      new Error(
        `journal gone\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
      ),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('authorization_unreadable');
    // Strong oracle: the exact expected full line — the newline and the
    // escape sequence are removed outright, the unsafe-class member became
    // a space, and the detail is capped at 4096 before it is interpolated;
    // the filler rides up to that cap.
    const expectedDetailPrefix = 'Error: journal gone qwen serve: forged';
    const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} continue: run authorization could not be read: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
    expect(log.mock.calls.map(([emitted]) => emitted)).toContain(expectedLine);
    const line = log.mock.calls
      .map(([emitted]) => emitted)
      .find((emitted) => emitted.includes('could not be read'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(4400);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a lost authorization read on cancel and keeps the lease owed', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockRejectedValue(
      new Error(
        `journal gone\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
      ),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('authorization_unreadable');
    // Strong oracle: same exact-line pin as the continue sibling — the
    // newline and the escape sequence are removed outright, the
    // unsafe-class member became a space, and the detail is capped at 4096
    // before it is interpolated.
    const expectedDetailPrefix = 'Error: journal gone qwen serve: forged';
    const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} cancel: run authorization could not be read: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
    expect(log.mock.calls.map(([emitted]) => emitted)).toContain(expectedLine);
    const line = log.mock.calls
      .map(([emitted]) => emitted)
      .find((emitted) => emitted.includes('could not be read'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(4400);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(release.mock.calls.length).toBe(releasesBefore);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a not-runnable authorization on continue and hands the lease back', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'checkpoint record ckpt-1 is not valid JSON.',
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'continue: run authorization not runnable: invalid_state: checkpoint record ckpt-1 is not valid JSON.',
      ),
    );
    // The retry-inviting refusal on the resume path returns the adopted
    // lease now, like the authorization-unreadable twin; a retry cannot
    // otherwise re-acquire it.
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a not-runnable authorization on cancel and keeps the lease owed', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'checkpoint record ckpt-1 is not valid JSON.',
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'cancel: run authorization not runnable: invalid_state: checkpoint record ckpt-1 is not valid JSON.',
      ),
    );
    // The cancellation path keeps the adopted lease owed: nothing here is
    // terminal, and a release would persist RELEASED — the retry could
    // never re-acquire that identity.
    expect(release.mock.calls.length).toBe(releasesBefore);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('omits the absent authorization message on a not-runnable refusal', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'missing_checkpoint',
    } as never);
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('not runnable: missing_checkpoint'),
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a runnable but unready continuation on continue', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'runnable',
      checkpoint: { continuation: { phase: 'await_runtime' } },
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('continuation_not_ready');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('continuation not ready: phase=await_runtime'),
    );
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('strips control characters from the blocked authorization message', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    // The message is Store-influenced free text: the single-line tag must
    // strip newlines and control sequences rather than replay them.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: `invalid_state\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
    } as never);
    for (const route of ['continue', 'cancel'] as const) {
      log.mockClear();
      const refused = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${route}`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ promptId: PROMPT_ID, ...recovery });
      expect(refused.status).toBe(409);
      expect(refused.body.reason).toBe('not_runnable');
      // Strong oracle: the exact expected full line — the newline and the
      // escape sequence are removed outright, the unsafe-class member
      // became a space, the detail is capped at 4096 before it is
      // interpolated, and the filler rides up to that cap.
      const expectedDetailPrefix = 'invalid_state qwen serve: forged';
      const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} ${route}: run authorization not runnable: invalid_state: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
      expect(log.mock.calls.map(([emitted]) => emitted)).toContain(
        expectedLine,
      );
      const line = log.mock.calls
        .map(([emitted]) => emitted)
        .find((emitted) => emitted.includes('not runnable'));
      expect(line).toBeDefined();
      // The message is capped at 4096 characters before it is interpolated.
      expect(line?.length).toBeLessThan(4400);
      // Oracles independent of the implementation: no C0/C1 control and no
      // code point of the log-line-unsafe class may survive into the line.
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(line).not.toMatch(
        /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
      );
    }
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });
});
