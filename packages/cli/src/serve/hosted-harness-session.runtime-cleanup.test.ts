/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  domainEnablement,
  headers,
  hookPin,
  neverStartedReconcile,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  capturedWakeSession,
  recoveryFileSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as modelRecovery from './hosted-model-recovery.js';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { commitHostedFileHistory } from './hosted-file-history.js';
import { hasHostedCleanupDebt } from './hosted-turn-cleanup.js';
import {
  LlmRequestPreparationError,
  type LlmPreparedRequest,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
  hostedConfigScopedOwnerId,
} from './hosted-hook-session.js';
import { HostedMcpRecoveryRequiredError } from './hosted-mcp-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import { HostedMonitorLoop } from './hosted-monitor-loop.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('settles a running Monitor watch as stop_requested when the Session closes', async () => {
    domainEnablement.monitorRun = true;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'monitor-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [
        {
          text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
        },
      ],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resources, route, _body) => {
        if (route === '/grants') return { state: 'OPEN' };
        throw new Error('Unexpected publication route ' + route);
      },
    );
    const stop = vi.spyOn(HostedMonitorLoop.prototype, 'stop');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const readMonitorRun = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const commits = journal.events.filter(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'monitor_run',
      );
      expect(commits.length).toBeGreaterThan(0);
      const ref = assertManagedSessionDurableRef(
        commits.at(-1)!.payload['recordRef'],
        'monitor_run record',
      );
      return parseMonitorRun(
        JSON.parse(
          (
            await LocalManagedSessionResourceStore.create({
              runtimeBaseDir: state.root,
              sessionKey: key,
            }).read(ref)
          ).toString('utf8'),
        ),
      );
    };
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
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'monitor',
        callId: 'monitor-call',
        args: { command: 'tail -f build.log' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'monitor started', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'watch the build' }];
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
      },
      { timeout: settleTimeoutMs() },
    );
    // Admission attached the record but nothing settled it: a live
    // observation loop is the only owner of its terminal write.
    expect((await readMonitorRun()).stopReason).toBeNull();
    expect((await readMonitorRun()).run.state).toBe('running');
    expect((await readMonitorRun()).run.execution).toBe('running_attached');
    expect(stop).not.toHaveBeenCalled();
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    expect(stop).toHaveBeenCalledTimes(1);
    const settled = await readMonitorRun();
    expect(settled.stopReason).toBe('stop_requested');
    expect(settled.run.state).toBe('cancelled');
    expect(settled.run.execution).toBe('settled');
  });

  it('parks a Monitor on runtime_lost when the Session closes over a refused release', async () => {
    domainEnablement.monitorRun = true;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    // The turn's terminal settlement rides this release; a busy refusal
    // leaves the Runtime's sweep unproven: the Session is still here, so
    // is every task it hosted, stopped or not — nobody may say which.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'monitor-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [
        {
          text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
        },
      ],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resources, route, _body) => {
        if (route === '/grants') return { state: 'OPEN' };
        throw new Error('Unexpected publication route ' + route);
      },
    );
    const stop = vi.spyOn(HostedMonitorLoop.prototype, 'stop');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const readMonitorRun = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const commits = journal.events.filter(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'monitor_run',
      );
      expect(commits.length).toBeGreaterThan(0);
      const ref = assertManagedSessionDurableRef(
        commits.at(-1)!.payload['recordRef'],
        'monitor_run record',
      );
      return parseMonitorRun(
        JSON.parse(
          (
            await LocalManagedSessionResourceStore.create({
              runtimeBaseDir: state.root,
              sessionKey: key,
            }).read(ref)
          ).toString('utf8'),
        ),
      );
    };
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
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'monitor',
        callId: 'monitor-call',
        args: { command: 'tail -f build.log' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'monitor started', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'watch the build' }];
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
    expect((await readMonitorRun()).stopReason).toBeNull();
    expect((await readMonitorRun()).run.execution).toBe('running_attached');
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    // The loop still ends locally — only the record claim changes: the
    // Runtime was never told anything stopped, so the run must keep an
    // unproven end with its rebuild path, never mint stop_requested.
    expect(stop).toHaveBeenCalledTimes(1);
    const parked = await readMonitorRun();
    expect(parked.stopReason).toBeNull();
    expect(parked.run.state).toBe('recovery_blocked');
    expect(parked.run.reason).toBe('runtime_lost');
    expect(parked.run.execution).toBe('outcome_unknown');
  });

  it.each([
    ['Tool', () => new HostedToolRecoveryRequiredError(new Error('x'))],
    ['MCP', () => new HostedMcpRecoveryRequiredError()],
    ['Hook', () => new HostedHookRecoveryRequiredError()],
    ['LLM preparation', () => new LlmRequestPreparationError(new Error('x'))],
  ] as const)(
    'returns the Workspace mount when a tool turn goes recovery blocked through a %s error',
    async (_label, blockError) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '55555555-5555-4555-8555-555555555555',
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'original result' }],
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockResolvedValue({
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'workspaceContext',
      ).mockResolvedValue([]);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const releaseMount = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
        .mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
        'route-claim',
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: 'blocked-tool',
          args: { file_path: 'gone.txt' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        throw blockError();
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'read gone' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
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
      // #13800: the blocked turn's mount lease must go back — a leaked
      // lease wedged every later tool turn on the same storage — while the
      // Runtime Session stays READY for the recovery fleet: exactly one
      // handback under this turn's claim (another test's owed chain may
      // still reach the prototype under its own), the RELEASED-forever
      // full release never.
      expect(
        releaseMount.mock.calls.filter(([claim]) => claim === 'route-claim'),
      ).toHaveLength(1);
      expect(release).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    },
  );

  it('returns the Workspace mount when a settled turn parks with its cleanup still owed (#13800)', async () => {
    // The warm answer names the Runtime, so the turn owes its release to
    // the cleanup debt rather than to finish().
    const named = async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(named);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      named,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    // The turn settles, but its owed full release cannot land.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable'),
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'cleanup-claim',
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'read',
        args: { file_path: 'a.txt' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'read a' }];
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
    // The cleanup keeps owing its full release; the mount is not held
    // hostage to it.
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'cleanup-claim'),
    ).toHaveLength(1);
  });

  it('returns the Workspace mount when a turn owing its cleanup cannot write its terminal record (#13800)', async () => {
    // The warm answer names the Runtime, so the turn owes its release to
    // the cleanup debt; a terminal write that never lands skips that
    // cleanup and parks the Session blocked.
    const named = async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(named);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      named,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'terminal-claim',
    );
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result')
          return Promise.reject(new Error('terminal write lost'));
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'read',
        args: { file_path: 'a.txt' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'read a' }];
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
    // The full release stays owed behind the durable terminal; only the
    // mount goes back.
    expect(release).not.toHaveBeenCalled();
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'terminal-claim'),
    ).toHaveLength(1);
  });

  it('drains a turn-held Runtime at close through the drain arm (#13856)', async () => {
    // The designed hold: the turn's routine release is refused
    // `runtime_session_held`, the turn settles clean (no recovery park),
    // and the Session's close owes the Runtime's drain release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'not run' },
    });
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
    );
    release.mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'shell',
        args: { command: 'printf hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'run command' }];
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
        // The designed hold is not a wedge: the Session stays healthy.
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    // The close handed the held Runtime back through the drain arm.
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1]).toEqual([{ drain: true }]);
  });

  it('closes a Session whose held Runtime is already gone (#13856 R1-1)', async () => {
    // The held turn's Runtime is already gone by the close: the drain's 404
    // names nothing left to stop, so the close tolerates it and answers 204
    // rather than wedging on a 503 over a Session that can never close.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'not run' },
    });
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
    );
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'shell',
        args: { command: 'printf hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'run command' }];
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
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1]).toEqual([{ drain: true }]);
  });

  it('restores the held-Runtime drain obligation on a replacement load (#13930 R1-2)', async () => {
    // A restart empties the in-memory held set; the close's drain
    // obligation survives only when the load restores it from the Broker's
    // durable hold rows. The prewritten Session below belongs to a process
    // that died before any close could drain; the Broker still lists the
    // held Runtime Session, so the load must restore the obligation and
    // this process's close must hand the Runtime back through the drain
    // arm. Without the load-time restore the final assertions are red:
    // the fresh process's set is empty and its close drains nothing. The
    // second id is digest-shaped: alongside the cardinality pin (every
    // restored entry drains, not just the first) it carries the close's
    // hostedRuntimeSessionId mapping end-to-end — an already path-safe
    // answer must come back verbatim (#13986 R1-1).
    await prewriteShellProfileSession();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockResolvedValue();
    const restored = [PROMPT_ID, `wake-${'a'.repeat(64)}`];
    const activeHolds = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
      .mockResolvedValue(restored);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    expect(activeHolds).toHaveBeenCalledTimes(1);
    // The load is additive: it restores the obligation and never discharges
    // it — only the close drains (#13986 R1-2).
    expect(release).not.toHaveBeenCalled();
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        )
      ).status,
    ).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls).toEqual([[{ drain: true }], [{ drain: true }]]);
    expect(
      (release.mock.contexts as HostedWorkspaceBroker[])
        .map((broker) => broker.runtimeSessionId)
        .sort(),
    ).toEqual([...restored].sort());
  });

  it('drains a prefix-shaped turn id when the Session owns no config-scoped owner (R1-2)', async () => {
    // A channel inputId is client-chosen and only length-bounded, so a turn
    // can carry the owner prefix without being an owner. This Session has no
    // extension bundle and therefore no config-scoped owner at all: both
    // restored ids are ordinary obligations and both must drain. Exempting by
    // id shape would strand the first one for the rest of its life. The
    // ownership-positive case lives beside the R13-1 fixture, where an active
    // bundle really constructs the id.
    await prewriteShellProfileSession();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockResolvedValue();
    const prefixShaped = `extensions-components-${'e'.repeat(64)}`;
    const activeHolds = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
      .mockResolvedValue([prefixShaped, PROMPT_ID]);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    expect(activeHolds).toHaveBeenCalledTimes(1);
    const resident = capturedWakeSession();
    // The premise, asserted: no bundle, so nothing here is an owner.
    expect(resident.hooks).toBeUndefined();
    expect(resident.heldRuntimeTurns.has(prefixShaped)).toBe(true);
    await headers(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile: 'hosted-workspace-shell/1',
        sessionKey: resident.managed.authority.sessionHeader.sessionKey,
        authority: {
          operationId: 'close-prefix-shaped-turn',
          claimGeneration: 1,
        },
      })
      .expect(200);
    const releasedIds = (release.mock.contexts as HostedWorkspaceBroker[]).map(
      (broker) => broker.runtimeSessionId,
    );
    expect(releasedIds).toContain(PROMPT_ID);
    expect(releasedIds).toContain(prefixShaped);
  });

  it('closes a Session whose restored hold the restarted Broker cannot drain (#13986 R2-1)', async () => {
    // A worker restart takes the Harness and the Broker down together. The
    // replacement Broker no longer holds the Runtime Session in memory and
    // cannot prove its release, so the drain of a restored hold answers the
    // declared-retryable 503 runtime_reconciliation_required — the
    // Workspace-level cascade owns the Runtime from there. The close must
    // tolerate that answer and retire the Session: before the tolerance the
    // same DELETE rethrew ahead of sessions.delete, answered 503 on every
    // retry, and the reload re-seeded the id — the Session could never
    // leave the registry. The unproven drain still parks the monitor-loop
    // settle on runtime_lost rather than stop_requested.
    await prewriteShellProfileSession();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValue(
      new HostedWorkspaceBrokerRejection(
        503,
        'runtime_reconciliation_required',
      ),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([PROMPT_ID]);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
    // The Session left the registry: a second close finds nothing to close.
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(404);
  });

  it('loads without the drain obligation when the restore query fails (#13930 R1-2)', async () => {
    // The declared degrade: a failed active-holds query logs and loads
    // without the obligation — never a failed load in the restart window
    // this slice serves. The close then drains nothing.
    await prewriteShellProfileSession();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockResolvedValue();
    const activeHolds = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
      .mockRejectedValue(new Error('broker unreachable'));
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    expect(activeHolds).toHaveBeenCalledTimes(1);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        )
      ).status,
    ).toBe(204);
    // No obligation was restored, so the close drains nothing.
    expect(release).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory on a fresh create (#13930 R1-2)', async () => {
    // A created Session has no hold rows: the restore read is load-only.
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory on a lifecycle-v2 load (#13986 R1-3)', async () => {
    // The set's only reader is the close's drain loop, which sits in the
    // v1-only close block: a v2 Session would restore an obligation its
    // close never drains — a dead Broker round trip on every load plus
    // in-memory state that reads as an armed drain and is not.
    await prewriteShellProfileSession();
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        lifecycleProtocolVersion: 2,
        lifecycleAuthority: { operationId: 'v2-load', claimGeneration: 1 },
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory for an MCP-profile load (#13986 R3-1)', async () => {
    // The 409 gate admits hosted-workspace-mcp/1 beside the workspace
    // profiles whenever brokerOptions is present, but an MCP-profile
    // Session has no tool turn and can never hold a background Runtime:
    // the restore read would be a dead Broker round trip on every load,
    // and a misleading could-not-restore line whenever the Broker is down.
    await prewriteShellProfileSession('hosted-workspace-mcp/1');
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  /** A Session whose process died before any close could drain: the
   * durable definition exists and the writer is free again. */
  async function prewriteShellProfileSession(
    toolProfile = 'hosted-workspace-shell/1',
  ): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile,
              ...(toolProfile === 'hosted-workspace-mcp/1'
                ? {
                    mcpServers: [
                      {
                        serverId: 'demo',
                        serverRevision: 1,
                        definitionDigest: 'a'.repeat(64),
                      },
                    ],
                  }
                : {}),
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from(JSON.stringify({ cwd: state.root })),
        ),
        createdBy: 'hosted-harness',
      },
    });
    // The open above only mints the durable definition; closing here frees
    // the writer so the replacement process may open the Session — the
    // death itself is that no close ever drained.
    await managed.close();
  }

  it.each(['DELETE', 'lifecycle'] as const)(
    'keeps terminal cleanup owed until %s drain really releases its owner',
    async (exit) => {
      const toolProfile =
        exit === 'lifecycle'
          ? 'hosted-workspace-shell/1'
          : 'hosted-workspace-files/1';
      const f = await recoveryFileSession(toolProfile);
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      await f.owe();
      const cleanupStates = () =>
        f.resident.managed.authority
          .eventsInSequenceRange(
            1,
            f.resident.managed.authority.committedSequence,
          )
          .filter((event) => event.kind === 'hosted.cleanup')
          .map((event) => event.payload['state']);
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      release.mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
      );
      const authority = { operationId: 'close-drain', claimGeneration: 1 };
      const close = () =>
        exit === 'DELETE'
          ? f.authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          : f
              .authorize(
                supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`),
              )
              .send({
                protocolVersion: 2,
                phase: 'settle_resources',
                kind: 'close',
                toolProfile,
                sessionKey:
                  f.resident.managed.authority.sessionHeader.sessionKey,
                authority,
              });
      await close().expect(503);
      expect(release).toHaveBeenCalledExactlyOnceWith({
        bindingId: 'binding',
        generation: '1',
        drain: true,
      });
      expect(cleanupStates()).toEqual(['owed']);
      expect(f.resident.managed.authority.writerSealed).toBe(false);

      await close().expect(exit === 'DELETE' ? 204 : 200);
      expect(release).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenLastCalledWith({
        bindingId: 'binding',
        generation: '1',
        drain: true,
      });
      expect(cleanupStates()).toEqual(['owed', 'confirmed']);
      if (exit === 'lifecycle')
        await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/detach`))
          .send({ authority })
          .expect(204);
    },
  );

  it('drains a held Runtime before terminal Hook owner release on a v2 close', async () => {
    const toolProfile = 'hosted-workspace-shell/1';
    const f = await recoveryFileSession(toolProfile);
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    await f.owe();
    // A Hook-configured turn leaves a background Shell on its shared owner.
    // Cleanup debt must drain before the public lifecycle releases that owner.
    let backgroundLive = true;
    const order: string[] = [];
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async (opts) => {
        order.push('drain');
        // Only the cleanup-debt drain names the owed turn's Runtime and so
        // proves its background Shell stopped; the lease drain carries no
        // descriptor and stops nothing this guard waits on.
        if (opts?.drain && 'bindingId' in opts) backgroundLive = false;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'det-claim',
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockImplementation(async () => {
      order.push('handback');
      if (backgroundLive)
        throw new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy');
    });
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      f.resident.managed,
      hookPin,
      undefined,
      () => false,
      `extensions-components-${'e'.repeat(64)}`,
    );
    vi.spyOn(hooks, 'mountHeld', 'get').mockReturnValue(true);
    const originalClose = hooks.close.bind(hooks);
    const closeHook = vi
      .spyOn(hooks, 'close')
      .mockImplementation(async (opts) => {
        expect(backgroundLive).toBe(false);
        order.push('owner-close');
        await originalClose(opts);
      });
    f.resident.hooks = hooks;
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile,
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-drain-order', claimGeneration: 1 },
      })
      .expect(200);
    expect(closeHook).toHaveBeenCalledExactlyOnceWith({ terminal: true });
    expect(order.indexOf('drain')).toBeLessThan(order.indexOf('owner-close'));
    expect(order).not.toContain('handback');
  });

  it('drains a registered held Runtime with no cleanup debt on a v2 close (R24-1)', async () => {
    const toolProfile = 'hosted-workspace-shell/1';
    const f = await recoveryFileSession(toolProfile);
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    // The obligation is seeded, not produced by a turn: the producers that
    // register one without a cleanup descriptor are a wake turn's held
    // aftermath and a cleanup hold. A Hook-configured turn registers nothing
    // (pinned by 'never registers a held Runtime for a Hook-configured turn'),
    // so this case deliberately does NOT claim to cover the Hook shape — it
    // pins the drain for the shapes that do reach it.
    expect(hasHostedCleanupDebt(f.resident.managed)).toBe(false);
    f.resident.heldRuntimeTurns.add(PROMPT_ID);
    let backgroundLive = true;
    const drained: string[] = [];
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async function (this: HostedWorkspaceBroker, opts) {
        // Key the guard to the held turn's own Runtime: the lease drain also
        // carries {drain:true} with no descriptor, so an opts-only check would
        // let that unrelated call clear the flag and pass a broken build.
        if (opts?.drain) {
          drained.push(this.runtimeSessionId);
          if (this.runtimeSessionId === hostedRuntimeSessionId(PROMPT_ID))
            backgroundLive = false;
        }
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'det-claim',
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockImplementation(async () => {
      if (backgroundLive)
        throw new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy');
    });
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      f.resident.managed,
      hookPin,
      undefined,
      () => false,
      `extensions-components-${'e'.repeat(64)}`,
    );
    vi.spyOn(hooks, 'mountHeld', 'get').mockReturnValue(true);
    f.resident.hooks = hooks;
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile,
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-held-drain', claimGeneration: 1 },
      })
      .expect(200);
    expect(drained).toContain(hostedRuntimeSessionId(PROMPT_ID));
  });

  it('closes a v2 Session whose held Runtime the restarted Broker cannot prove (R25-1)', async () => {
    const toolProfile = 'hosted-workspace-shell/1';
    const f = await recoveryFileSession(toolProfile);
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    expect(hasHostedCleanupDebt(f.resident.managed)).toBe(false);
    f.resident.heldRuntimeTurns.add(PROMPT_ID);
    // A Broker that restarted beside the Harness holds no resident Session and
    // cannot prove the release. Throwing here would skip hooks.close, the lease
    // release, both loop stops and both publisher closes on every retry, and
    // the reloaded id is re-seeded each time — the Session could never close.
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async function (this: HostedWorkspaceBroker, opts) {
        if (
          opts?.drain &&
          this.runtimeSessionId === hostedRuntimeSessionId(PROMPT_ID)
        )
          throw new HostedWorkspaceBrokerRejection(
            503,
            'runtime_reconciliation_required',
          );
      },
    );
    // The drain proved nothing, so the loop must not settle as a confirmed
    // stop. Inject a loop and assert it actually ran, so a failed injection
    // fails the test instead of passing vacuously.
    const stop = vi.fn(
      async (_settle?: 'stop_requested' | 'runtime_lost') => {},
    );
    const shell = (f.resident.shell ??= {});
    shell.monitorLoops = new Map([
      ['m1', { prepareLifecycle: () => {}, stop }],
    ]);
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile,
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-unproven-drain', claimGeneration: 1 },
      })
      .expect(200);
    // Tolerated, not re-seeded: a retry must not attempt the same stop again.
    expect(f.resident.heldRuntimeTurns.has(PROMPT_ID)).toBe(false);
    expect(stop).toHaveBeenCalledWith('runtime_lost');
  });

  it('settles a blocked v2 Session on the runtime_lost line when the drain proved nothing owed (R26-1)', async () => {
    const toolProfile = 'hosted-workspace-shell/1';
    const f = await recoveryFileSession(toolProfile);
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    // No held Runtime, so the drain is trivially proven and heldDrainUnproven
    // stays false. The Session's own settlement already failed, which is the
    // other reason v1 refuses to certify a stop: nothing proved to the Runtime
    // that the writer stopped, and only the runtime_lost line keeps
    // rebuildFromRuntimeLost able to recover the record.
    expect(f.resident.heldRuntimeTurns.size).toBe(0);
    f.resident.blocked = true;
    const stop = vi.fn(
      async (_settle?: 'stop_requested' | 'runtime_lost') => {},
    );
    const shell = (f.resident.shell ??= {});
    shell.monitorLoops = new Map([
      ['m1', { prepareLifecycle: () => {}, stop }],
    ]);
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile,
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-blocked-settle', claimGeneration: 1 },
      })
      .expect(200);
    expect(stop).toHaveBeenCalledWith('runtime_lost');
  });

  it.each(['settled prompt', 'recovery recheck'] as const)(
    'leaves a reload-stable owner owed on the %s handback (R4-2)',
    async (driver) => {
      const f = await recoveryFileSession();
      const owner = hostedConfigScopedOwnerId(
        f.resident.managed.authority.sessionHeader.sessionKey,
        1,
      );
      // These two routes reach releaseHeldRuntime without passing either
      // drain, so the close arms cannot pin them. Neither refuses a
      // Hook-configured Session; the managed-runtime replay routes do
      // (hosted_hook_recovery_required), which is why this arm drives these.
      f.resident.hooks = {
        broker: { runtimeSessionId: owner },
        hasPendingOperations: false,
        ensureReady: async () => {},
      } as unknown as HostedHookSession;
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const adopt = () => {
        f.resident.runtimeLeaseHeld = {
          promptId: PROMPT_ID,
          runtimeSessionId: owner,
        };
        f.resident.runtimeLeaseOwedByTerminalRoute = true;
        release.mockClear();
      };
      if (driver === 'settled prompt') {
        adopt();
        await f.submit();
        await f.idle();
      } else {
        await f.submit();
        await f.idle();
        f.resident.blocked = true;
        f.resident.cleanupBlocked = true;
        adopt();
        await f
          .authorize(
            supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
          )
          .send({ promptId: PROMPT_ID })
          .expect(202);
      }
      // The lease is a Turn obligation and is discharged; the owner it names
      // is not, and only its own close may release it terminally.
      await vi.waitFor(
        () => expect(f.resident.runtimeLeaseHeld).toBeUndefined(),
        { timeout: settleTimeoutMs() },
      );
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(false);
      expect(
        release.mock.contexts.map(
          (broker) => (broker as HostedWorkspaceBroker).runtimeSessionId,
        ),
      ).not.toContain(owner);
    },
  );

  it('rechecks an admitted prompt before running queued cleanup', async () => {
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => undefined,
    );
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    let finishRelease!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    releases.mockImplementationOnce(async () => {
      await releaseBarrier;
      throw new Error('release unavailable');
    });
    const load = () =>
      headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
    const first = load();
    let second: ReturnType<typeof load> | undefined;
    let finishPrompt: (() => void) | undefined;
    try {
      await vi.waitFor(() => expect(releases).toHaveBeenCalledOnce(), {
        timeout: settleTimeoutMs(),
      });
      const firstRetry = f.resident.cleanupRetry;
      expect(firstRetry).toBeDefined();
      second = load();
      await vi.waitFor(
        () => {
          expect(f.resident.cleanupRetry).toBeDefined();
          expect(f.resident.cleanupRetry).not.toBe(firstRetry);
        },
        { timeout: settleTimeoutMs() },
      );
      state.model.mockImplementationOnce(
        ({ signal }) =>
          new Promise((resolve) => {
            finishPrompt = () =>
              resolve({ text: 'later', model: 'test-model' });
            signal.addEventListener('abort', finishPrompt, { once: true });
          }),
      );
      const prompt = [{ type: 'text', text: 'later active turn' }];
      await f
        .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
        .send({
          prompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2), {
        timeout: settleTimeoutMs(),
      });
      finishRelease();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(releases).toHaveBeenCalledOnce();
      expect((await f.status()).body.hasActivePrompt).toBe(true);
      expect(f.resident.cleanupBlocked).toBe(true);
      expect(f.resident.cleanupRetry).toBeUndefined();
    } finally {
      finishRelease();
      finishPrompt?.();
      await Promise.all([first, second]);
      await f.idle();
      await f
        .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
        .expect(204);
    }
  });

  it('keeps a queued cleanup retry owned until the last caller settles', async () => {
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => undefined,
    );
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    releases.mockImplementationOnce(async () => {
      await firstBarrier;
      throw new Error('release unavailable');
    });
    releases.mockImplementationOnce(async () => {
      await secondBarrier;
    });
    const load = () =>
      headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
    const first = load();
    let second: ReturnType<typeof load> | undefined;
    let third: ReturnType<typeof load> | undefined;
    try {
      await vi.waitFor(() => expect(releases).toHaveBeenCalledOnce(), {
        timeout: settleTimeoutMs(),
      });
      const firstRetry = f.resident.cleanupRetry;
      expect(firstRetry).toBeDefined();
      second = load();
      await vi.waitFor(
        () => {
          expect(f.resident.cleanupRetry).toBeDefined();
          expect(f.resident.cleanupRetry).not.toBe(firstRetry);
        },
        { timeout: settleTimeoutMs() },
      );
      const secondRetry = f.resident.cleanupRetry;
      finishFirst();
      await vi.waitFor(() => expect(releases).toHaveBeenCalledTimes(2), {
        timeout: settleTimeoutMs(),
      });
      expect(f.resident.cleanupRetry).toBe(secondRetry);
      third = load();
      await vi.waitFor(
        () => {
          expect(f.resident.cleanupRetry).toBeDefined();
          expect(f.resident.cleanupRetry).not.toBe(secondRetry);
        },
        { timeout: settleTimeoutMs() },
      );
      finishSecond();
      for (const response of await Promise.all([first, second, third])) {
        expect(response.status).toBe(200);
      }
      expect(releases).toHaveBeenCalledTimes(2);
      expect(f.resident.cleanupRetry).toBeUndefined();
      expect((await f.status()).body.recoveryBlocked).toBe(false);
    } finally {
      finishFirst();
      finishSecond();
      await Promise.all([first, second, third]);
      await f
        .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
        .expect(204);
    }
  });

  it('inspects original recovery evidence and rechecks only terminal cleanup', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    const read = () =>
      f
        .authorize(
          supertest(f.server).get(
            `/session/${SESSION_ID}/status?promptId=${PROMPT_ID}`,
          ),
        )
        .expect(200);
    expect((await read()).body.recovery).toMatchObject({
      state: 'cleanup_pending',
      promptId: PROMPT_ID,
      inputSettled: true,
      continuationReady: true,
      nextTurnAllowed: false,
    });
    expect(releases).not.toHaveBeenCalled();
    const recheck = () =>
      f
        .authorize(
          supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
        )
        .send({ promptId: PROMPT_ID })
        .expect(202);
    await Promise.all([recheck(), recheck()]);
    expect((await read()).body.recovery).toMatchObject({
      state: 'ready',
      nextTurnAllowed: true,
    });
    await recheck();
    expect(releases).toHaveBeenCalledOnce();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    expect((await read()).body.recovery.state).toBe('cleanup_pending');
    await recheck();
    expect((await read()).body.recovery.nextTurnAllowed).toBe(true);
    expect(releases).toHaveBeenCalledOnce();
    expect(releases).toHaveBeenCalledWith({
      bindingId: 'binding',
      generation: '1',
    });
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('refuses recovery cleanup for a different original input', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    const other = randomUUID();
    const status = await f
      .authorize(
        supertest(f.server).get(
          `/session/${SESSION_ID}/status?promptId=${other}`,
        ),
      )
      .expect(200);
    expect(status.body.recovery).toMatchObject({
      state: 'operator_required',
      inputSettled: false,
      nextTurnAllowed: false,
    });
    await f
      .authorize(
        supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
      )
      .send({ promptId: other })
      .expect(409);
    expect(releases).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('keeps a later terminal cleanup latch when rechecking an older input', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    const prompt = [{ type: 'text', text: 'later' }];
    const later = randomUUID();
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: later,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await f.idle();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    const recheck = (promptId: string) =>
      f
        .authorize(
          supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
        )
        .send({ promptId })
        .expect(202);
    await recheck(PROMPT_ID);
    expect(f.resident.cleanupBlocked).toBe(true);
    expect(f.resident.blocked).toBe(true);
    await recheck(later);
    expect(f.resident.cleanupBlocked).toBe(false);
    expect(f.resident.blocked).toBe(false);
    expect(state.model).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'reopens only original terminal cleanup across restart (release already observed: %s)',
    async (releasedBeforeRestart) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      await commitHostedFileHistory(f.resident.managed, {
        schemaVersion: 1,
        state: { ownerSessionId: SESSION_ID, snapshots: [], files: {} },
        pendingTurn: PROMPT_ID,
        pendingUndo: null,
      });
      await f.owe();
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      if (releasedBeforeRestart)
        await new HostedWorkspaceBroker(
          { baseUrl: 'http://127.0.0.1:1', token: 'test' },
          f.resident.managed.authority.sessionHeader.sessionKey,
          hostedRuntimeSessionId(PROMPT_ID),
        ).release({ bindingId: 'binding', generation: '1' });
      f.resident.monitorWake?.close();
      await f.resident.managed.close();
      releases.mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
      neverStartedReconcile.fn.mockClear();
      const previousWake = wakeDeps.last;
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      kick.mockClear();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          recoveryCleanupPromptId: PROMPT_ID,
        })
        .expect(200);
      expect(loaded.body.recoveryCleanupOnly).toBe(true);
      const authorize = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      const status = await authorize(
        supertest(replacement).get(
          `/session/${SESSION_ID}/status?promptId=${PROMPT_ID}`,
        ),
      ).expect(200);
      expect(status.body.recovery).toMatchObject({
        state: 'ready',
        promptId: PROMPT_ID,
        inputSettled: true,
        continuationReady: true,
        nextTurnAllowed: true,
      });
      const history = await authorize(
        supertest(replacement).get(`/session/${SESSION_ID}/files/history`),
      ).expect(200);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(releases).toHaveBeenCalledExactlyOnceWith({
        bindingId: 'binding',
        generation: '1',
      });
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
      expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
      expect(wakeDeps.last).toBe(previousWake);
      expect(state.model).toHaveBeenCalledOnce();
      await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          toolProfile: 'hosted-workspace-files/2',
        })
        .expect(409);
      const passive = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          toolProfile: 'hosted-workspace-files/1',
        })
        .expect(200);
      expect(passive.body.recoveryCleanupOnly).toBe(true);
      expect(passive.body.clientId).toBe(loaded.body.clientId);
      expect(kick).not.toHaveBeenCalled();
      expect(wakeDeps.last).toBe(previousWake);
      expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(releases).toHaveBeenCalledOnce();
      expect(state.model).toHaveBeenCalledOnce();
      const prompt = [{ type: 'text', text: 'next turn' }];
      const next = {
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      };
      await authorize(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .send(next)
        .expect(409);
      expect(state.model).toHaveBeenCalledOnce();
      const upgraded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      expect(upgraded.body.recoveryCleanupOnly).not.toBe(true);
      expect(upgraded.body.clientId).not.toBe(loaded.body.clientId);
      const ordinary = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', upgraded.body.clientId);
      await ordinary(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .send(next)
        .expect(202);
      await vi.waitFor(
        async () => {
          const current = await ordinary(
            supertest(replacement).get(
              `/session/${SESSION_ID}/status?promptId=${next.promptId}`,
            ),
          ).expect(200);
          expect(current.body.recovery.nextTurnAllowed).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(2);
      await ordinary(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('requires an ordinary load before managing MCP on a cleanup-only Session', async () => {
    const f = await recoveryFileSession('hosted-workspace-shell/1');
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        recoveryCleanupPromptId: PROMPT_ID,
      })
      .expect(200);
    expect(loaded.body.recoveryCleanupOnly).toBe(true);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    const journal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
    const before = await journal();
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    acquire.mockClear();
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'control');
    const definitions = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'mcpDefinitions')
      .mockResolvedValue([]);
    const route = `/session/${SESSION_ID}/mcp/management`;
    for (const request of [
      authorize(supertest(replacement).get(route)),
      authorize(
        supertest(replacement).get(`${route}/operations/${randomUUID()}`),
      ),
      authorize(supertest(replacement).post(route)).send({
        operationId: randomUUID(),
        actorKey: 'c'.repeat(64),
        action: 'add',
        serverId: 'demo',
        expectedRevision: 0,
        server: {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      }),
      headers(supertest(replacement).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        mcpManagementOnly: true,
      }),
    ]) {
      const refused = await request.expect(409);
      expect(refused.body.code).toBe('hosted_mcp_session_load_required');
    }
    expect(await journal()).toEqual(before);
    expect(acquire).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(definitions).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
    const upgraded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
      .expect(200);
    expect(upgraded.body.recoveryCleanupOnly).not.toBe(true);
    await headers(supertest(replacement).get(route))
      .set('X-Qwen-Client-Id', upgraded.body.clientId)
      .expect(200);
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', upgraded.body.clientId)
      .expect(204);
  });

  it('refuses cold cleanup before the original input is durably settled', async () => {
    const f = await recoveryFileSession();
    state.model.mockRejectedValueOnce(new LlmRequestPreparationError('parked'));
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    neverStartedReconcile.fn.mockClear();
    const previousWake = wakeDeps.last;
    const replacement = await app(true);
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        recoveryCleanupPromptId: PROMPT_ID,
      })
      .expect(409);
    expect(releases).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
    expect(wakeDeps.last).toBe(previousWake);
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('clears a cleanup-only block when continue confirms the original owner (R3-14)', async () => {
    const f = await recoveryFileSession();
    f.resident.runtimeLeaseHeld = {
      promptId: PROMPT_ID,
      runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
    };
    state.model.mockImplementationOnce(async () => {
      await f.owe();
      return { text: 'completed', model: 'test-model' };
    });
    vi.spyOn(
      HostedWorkspaceToolTurn.prototype,
      'cleanup',
    ).mockRejectedValueOnce(new Error('release unavailable'));
    await f.submit();
    await f.idle();
    expect(f.resident.cleanupBlocked).toBe(true);
    const authorization =
      await f.resident.managed.authority.harnessRunAuthorization();
    if (authorization.status !== 'runnable')
      throw new Error('fixture checkpoint is not runnable');
    await f
      .authorize(
        supertest(f.server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
      .send({
        promptId: PROMPT_ID,
        checkpointId: authorization.checkpoint.identity.checkpointId,
        activationId: f.resident.managed.activation.activationId,
      })
      .expect(409);
    await vi.waitFor(() => {
      expect(f.resident.runtimeLeaseHeld).toBeUndefined();
      expect(
        f.resident.managed.authority
          .eventsInSequenceRange(
            1,
            f.resident.managed.authority.committedSequence,
          )
          .some(
            (event) =>
              event.kind === 'hosted.cleanup' &&
              event.payload['state'] === 'confirmed',
          ),
      ).toBe(true);
    });
    const loaded = await headers(
      supertest(f.server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
      })
      .expect(200);
    expect(loaded.body.recoveryRequired).not.toBe(true);
    expect((await f.status()).body.recoveryBlocked).toBe(false);
    expect(f.resident.cleanupBlocked).toBe(false);
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('leaves a parked owner operable after lifecycle close requires recovery (R3-5)', async () => {
    const f = await recoveryFileSession();
    state.model.mockImplementationOnce(async () => {
      await f.owe();
      throw new LlmRequestPreparationError('parked request');
    });
    await f.submit();
    await f.idle();
    state.setLifecycleAuthority.mockClear();
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        kind: 'close',
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-parked', claimGeneration: 1 },
      })
      .expect(503);
    expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
    const cancel = await f
      .authorize(
        supertest(f.server).post(
          `/session/${SESSION_ID}/managed-runtime/cancel`,
        ),
      )
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint',
        activationId: f.resident.managed.activation.activationId,
      });
    expect(cancel.body.code).not.toBe('hosted_session_closing');
    expect(cancel.body.code).not.toBe('hosted_lifecycle_operation_active');
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('keeps a journaled cancellation after the recovered request deadline passes (R3-2)', async () => {
    const f = await recoveryFileSession();
    let modelWaiting = false;
    state.model.mockImplementationOnce(async ({ modelScope, signal }) => {
      const prepared: LlmPreparedRequest = {
        request: {
          model: 'fixture',
          contents: [{ role: 'user', parts: [{ text: 'original' }] }],
          config: { temperature: 0.3 },
        },
        history: [{ role: 'user', parts: [{ text: 'original' }] }],
        completedToolCallIds: [],
        routeSelector: 'openai:fixture',
        providerPin: 'a'.repeat(64),
        promptTokensForClamp: 12,
      };
      const request = modelRecovery.createHostedModelRequest(
        f.resident.managed,
        PROMPT_ID,
        prepared,
        0,
        false,
        undefined,
        { bootId: BOOT_ID, eventEpoch: 'source-epoch' },
      );
      await modelScope!.beginMainAttempt(
        'fixture',
        await modelRecovery.publishHostedModelRequest(
          f.resident.managed,
          request,
        ),
      );
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(
            new LlmRequestPreparationError('park cancellation before terminal'),
          ),
        );
        modelWaiting = true;
      });
    });
    await f.submit(10_000);
    // Bounded by the submitted deadline: a later model entry would put /cancel
    // past the deadline the ordering assertion below pins.
    await vi.waitFor(() => expect(modelWaiting).toBe(true), {
      timeout: 10_000,
    });
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/cancel`))
      .expect(204);
    await f.idle();
    const events = () =>
      f.resident.managed.authority.eventsInSequenceRange(
        1,
        f.resident.managed.authority.committedSequence,
      );
    const deadline = events().find((event) => event.kind === 'input.accepted')!
      .payload['deadline'] as number;
    const cancellation = events().find(
      (event) => event.kind === 'cancel.requested',
    )!;
    expect(cancellation.occurredAt).toBeLessThan(deadline);
    const now = Date.now.bind(Date);
    const elapsedStart = now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => deadline + 1 + now() - elapsedStart);
    try {
      state.model.mockImplementationOnce(async ({ signal }) => {
        signal.throwIfAborted();
        return { text: 'unexpected', model: 'fixture' };
      });
      await headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          driveRuntimeRecovery: true,
        })
        .expect(200);
      await vi.waitFor(
        () =>
          expect(
            events().filter((event) => event.kind === 'turn.settled'),
          ).toHaveLength(1),
        { timeout: settleTimeoutMs() },
      );
      expect(
        events().find((event) => event.kind === 'turn.settled')!.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    } finally {
      clock.mockRestore();
    }
    await f.idle();
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('keeps resident recovery and concurrent close consistent (R3-8)', async () => {
    const f = await recoveryFileSession();
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    const refuse = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'publish')
      .mockImplementation(function (
        this: LocalManagedSessionResourceStore,
        kind,
        bytes,
      ) {
        return kind === 'managed-turn-result'
          ? Promise.reject(new Error('terminal unavailable'))
          : publish.call(this, kind, bytes);
      });
    state.model.mockImplementationOnce(async ({ modelScope }) => {
      const finish = await modelScope!.beginMainAttempt('fixture');
      await finish(true, {});
      return { text: 'committed answer', model: 'fixture' };
    });
    await f.submit();
    await f.idle();
    refuse.mockRestore();
    const find = modelRecovery.findHostedCommittedModelOutput;
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(
      modelRecovery,
      'findHostedCommittedModelOutput',
    ).mockImplementationOnce(async (...args) => {
      const committed = await find(...args);
      expect(committed).toBeDefined();
      reading = true;
      await gate;
      return committed;
    });
    const loading = headers(
      supertest(f.server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        driveRuntimeRecovery: true,
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(reading).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      f.resident.mcpClosing = true;
      const closingRefusal = await headers(
        supertest(f.server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        driveRuntimeRecovery: true,
      });
      expect(closingRefusal.status).toBe(409);
      expect(closingRefusal.body.code).toBe('hosted_session_closing');
      f.resident.mcpClosing = false;
      await headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          driveRuntimeRecovery: true,
        })
        .expect(409);
      const closed = await f.authorize(
        supertest(f.server).delete(`/session/${SESSION_ID}`),
      );
      release();
      const loaded = await loading;
      if (closed.status === 204) {
        expect([404, 409]).toContain(loaded.status);
        await f
          .authorize(supertest(f.server).get(`/session/${SESSION_ID}/status`))
          .expect(404);
      } else {
        expect(closed.status).toBe(409);
        expect(closed.body.code).toBe('hosted_turn_active');
        expect(loaded.status).toBe(200);
        await f.status();
        await f.idle();
        await f
          .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          .expect(204);
      }
    } finally {
      f.resident.mcpClosing = false;
      release();
      await loading;
    }
  });

  it.each(['ordinary', 'wake'])(
    'retries completed native-file cleanup on the real scheduler cadence (%s)',
    async (source) => {
      const f = await recoveryFileSession();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockImplementation(async () => randomUUID());
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'written' }],
        });
      let unavailable = true;
      const releases: Array<{
        owner: string;
        options: unknown;
        failed: boolean;
        at: number;
      }> = [];
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
        async function (this: HostedWorkspaceBroker, options) {
          releases.push({
            owner: this.runtimeSessionId,
            options,
            failed: unavailable,
            at: Date.now(),
          });
          if (unavailable)
            throw new HostedWorkspaceBrokerRejection(
              503,
              'runtime_unavailable',
            );
        },
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: 'call-1',
          args: { file_path: 'a.txt', content: 'x' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        return { text: 'done', model: 'test-model' };
      });
      try {
        if (source === 'ordinary') await f.submit();
        else {
          const managed = f.resident.managed;
          const content = Buffer.from(JSON.stringify({ text: 'write a.txt' }));
          await managed.authority.submitInput(
            {
              operation: 'submitInput',
              commandId: PROMPT_ID,
              sessionKey: managed.authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256').update(content).digest('hex'),
            },
            {
              inputId: PROMPT_ID,
              turnId: PROMPT_ID,
              source: 'monitor',
              contentRef: await managed.resources.publish(
                'managed-input',
                content,
              ),
              admissionRef: await managed.resources.publish(
                'managed-admission',
                Buffer.from('{}'),
              ),
              deadline: null,
              wakeReason: 'input',
            },
          );
          (
            f.resident as unknown as { monitorWake: HostedMonitorWakeScheduler }
          ).monitorWake.kick();
        }
        await vi.waitFor(
          () => {
            expect(f.resident.cleanupBlocked).toBe(true);
            expect(releases.length).toBeGreaterThan(0);
          },
          { timeout: settleTimeoutMs() },
        );
        await vi.waitFor(
          () => expect(releases.filter((item) => item.failed)).toHaveLength(4),
          { timeout: settleTimeoutMs() },
        );
        expect(releases[3].at - releases[2].at).toBeGreaterThanOrEqual(400);
        expect(releases).toHaveLength(4);
        expect(f.resident.blocked).toBe(true);
        unavailable = false;
        await vi.waitFor(
          () => {
            expect(f.resident.blocked).toBe(false);
            expect(f.resident.cleanupBlocked).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(releases.filter((item) => !item.failed)).toHaveLength(1);
        expect(
          releases.every(
            (item) => item.owner === hostedRuntimeSessionId(PROMPT_ID),
          ),
        ).toBe(true);
        expect(releases.at(-1)!.options).toEqual({
          bindingId: 'binding',
          generation: '1',
        });
        expect(state.model).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        const events = f.resident.managed.authority.eventsInSequenceRange(
          1,
          f.resident.managed.authority.committedSequence,
        );
        expect(
          events.filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          ),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!
            .payload['state'],
        ).toBe('confirmed');
      } finally {
        unavailable = false;
        await f
          .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          .expect(204);
      }
    },
  );
});
