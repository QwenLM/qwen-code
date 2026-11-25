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
  parkBlockedTextTurn,
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
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
import { createHash, randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import * as modelRecovery from './hosted-model-recovery.js';
import * as approvalContinuation from './hosted-approval-continuation.js';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionStoreTransportError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { ManagedMcpOperationView } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { recoverHostedRuntimeTurn } from './hosted-runtime-recovery.js';
import type { createMonitorWakeRunTurn } from './hosted-monitor-wake-turn.js';
import { HostedPublicChildRecoveryProfileChanged } from './hosted-approval-continuation.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  it.each([false, true])(
    'keeps a quiescing recovery load in the pool-wait lane (resident: %s)',
    async (resident) => {
      await parkToolTurn();
      const server = await replacementApp('recovery-pod');
      const descriptor = {
        managedSessionStore: {
          ...storeFor(BOOT_ID_2),
          writerToken: 'a'.repeat(32),
        },
        harnessPlacement: {
          instanceId: 'recovery-pod',
          bootId: BOOT_ID_2,
          placementEpoch: 1,
        },
        toolProfile: FILE_PROFILE,
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      if (resident) {
        const attached = await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ ...descriptor, passiveManagedRuntimeRecovery: true });
        expect(attached.status).toBe(200);
      }
      try {
        acquireSpy.mockClear();
        const execute = vi.mocked(HostedWorkspaceBroker.prototype.execute);
        execute.mockClear();
        const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
        release.mockClear();
        acquireSpy.mockImplementationOnce(async () => {
          const draining = await replacementHeaders(
            supertest(server).post(
              '/internal/hosted-harness/v1/instance:drain',
            ),
          ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID_2 });
          expect(draining.status).toBe(202);
          expect(draining.body.state).toBe('QUIESCING');
          expect(draining.body.counters.inFlightMutations).toBeGreaterThan(0);
        });
        const loaded = await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ ...descriptor, driveRuntimeRecovery: true });
        expect(loaded.status).toBe(409);
        expect(loaded.body.code).toBe('hosted_harness_quiescing');
        expect(acquireSpy).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(resident ? 0 : 1);
      } finally {
        if (resident)
          await replacementHeaders(
            supertest(server).delete(`/session/${SESSION_ID}`),
          ).expect(204);
      }
    },
  );

  it.each(['cancel', 'close', 'continue-refusal'])(
    'preserves the actual passive MCP owner through %s',
    async (path) => {
      const mcpServers = [
        {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      ];
      vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
        () => {},
      );
      const replies = new Map<string, ManagedMcpOperationView>();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'control').mockImplementation(
        async (operation) => {
          if (operation.kind === 'mcp-configure') {
            const result: ManagedMcpOperationView = {
              operationId: operation.operationId,
              state: 'settled',
              catalog: {
                serverId: operation.serverId,
                serverRevision: operation.serverRevision,
                definitionDigest: operation.definitionDigest,
                configRevision: operation.configRevision,
                connectionGeneration: operation.configRevision,
                catalogRevision: operation.configRevision,
                tools: [],
                resources: [],
                prompts: [],
                discovery: {
                  tools: 'complete',
                  resources: 'complete',
                  prompts: 'complete',
                },
              },
            };
            replies.set(operation.operationId, result);
            return result;
          }
          if (operation.kind === 'mcp-discover')
            return {
              ...replies.get(operation.grant.operationId)!,
              operationId: operation.operationId,
            };
          if (
            operation.kind === 'mcp-status' ||
            operation.kind === 'mcp-cancel'
          )
            return (
              replies.get(operation.targetOperationId) ?? {
                operationId: operation.targetOperationId,
                state: 'outcome_unknown',
              }
            );
          return { operationId: operation.operationId, state: 'settled' };
        },
      );
      await parkToolTurn(true, 'hosted-workspace-mcp/1');
      const originalResident = (
        wakeDeps.last as Parameters<typeof createMonitorWakeRunTurn>[0]
      ).session;
      await (
        originalResident.managed as Awaited<
          ReturnType<typeof openManagedSession>
        >
      ).close();
      let stopped = false;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => ({ state: stopped ? 'settled' : 'prepared' }),
      );
      vi.mocked(HostedWorkspaceBroker.prototype.cancel).mockImplementation(
        async () => {
          stopped = true;
        },
      );
      const releases: string[] = [];
      const releaseArgs: Array<{ owner: string; options: unknown }> = [];
      const acquisitions: string[] = [];
      const retired = new Set<string>();
      acquireSpy.mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        if (retired.has(this.runtimeSessionId))
          throw new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          );
        acquisitions.push(this.runtimeSessionId);
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      });
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
        async function (this: HostedWorkspaceBroker, options) {
          releases.push(this.runtimeSessionId);
          retired.add(this.runtimeSessionId);
          releaseArgs.push({
            owner: this.runtimeSessionId,
            options: options ?? null,
          });
          if (this.runtimeSessionId === PROMPT_ID)
            throw new HostedWorkspaceBrokerRejection(
              404,
              'runtime_session_not_found',
            );
        },
      );
      const server = await replacementApp();
      const loaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers,
        passiveManagedRuntimeRecovery: true,
      });
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
      expect(recovery.phase).toBe('await_runtime');
      const owner = recovery.executions[0].runtimeSessionId;
      expect(owner.startsWith('mcp-')).toBe(true);
      if (path === 'close') {
        const closed = await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(closed.status).toBe(204);
        expect(releases).toContain(owner);
        expect(releases).not.toContain(PROMPT_ID);
        expect(releaseArgs[0].options).toBeNull();
        return;
      }
      if (path === 'continue-refusal') {
        const refused = await replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(refused.body.reason).toBe('continuation_not_ready');
        expect(releases).toEqual([]);
      }
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      await vi.waitFor(async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      });
      const terminalReleases = [...releases];
      const terminalArgs = [...releaseArgs];
      const closed = await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(cancelled.status).toBe(200);
      expect(closed.status).toBe(204);
      expect(terminalReleases).toEqual([]);
      expect(releases).toContain(owner);
      expect(terminalReleases).not.toContain(PROMPT_ID);
      expect(
        terminalArgs.every(
          (entry) =>
            entry.options === null ||
            !(entry.options as { drain?: boolean }).drain,
        ),
      ).toBe(true);
      expect(releaseArgs.at(-1)?.options).toBeNull();
    },
  );

  it('closes an adopted Session after a transient handback transport fault (R2-1)', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releaseActivation = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'releaseActivation',
    );
    release.mockRejectedValueOnce(
      new TypeError('Broker handback transport fault'),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledOnce();
    expect(releaseActivation).toHaveBeenCalledOnce();
    await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(404);
  });

  it.each(
    (['continue', 'cancel'] as const).flatMap((route) =>
      (['closing', 'authorizing', 'detached'] as const).map((phase) => ({
        route,
        phase,
      })),
    ),
  )(
    'fences recovery $route admission when $phase',
    async ({ route, phase }) => {
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
      const clientId = loaded.body.clientId as string;
      state.model.mockClear();
      const cancel = vi.mocked(HostedWorkspaceBroker.prototype.cancel);
      cancel.mockClear();
      let finishRelease!: () => void;
      let finishAuthorization!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      const authorizationGate = new Promise<void>((resolve) => {
        finishAuthorization = resolve;
      });
      let releasing = false;
      let authorizing = false;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'release',
      ).mockImplementationOnce(async () => {
        releasing = true;
        await releaseGate;
      });
      if (phase !== 'closing') {
        const original =
          LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'harnessRunAuthorization',
        ).mockImplementation(async function (
          this: LocalManagedSessionAuthority,
        ) {
          const authorization = await original.call(this);
          authorizing = true;
          await authorizationGate;
          return authorization;
        });
      }
      const admit = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/${route}`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, ...recovery })
          .then((response) => response);
      let request: Promise<supertest.Response> | undefined;
      let closing: Promise<supertest.Response> | undefined;
      try {
        if (phase !== 'closing') {
          request = admit();
          await vi.waitFor(() => expect(authorizing).toBe(true));
        }
        closing = replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).then((response) => response);
        await vi.waitFor(() => expect(releasing).toBe(true));
        if (phase === 'detached') {
          finishRelease();
          expect((await closing).status).toBe(204);
        }
        if (phase === 'closing') request = admit();
        finishAuthorization();
        const refused = await request!;
        expect(refused.status).toBe(phase === 'detached' ? 404 : 409);
        expect(refused.body.code).toBe(
          phase === 'detached'
            ? 'hosted_session_not_found'
            : 'hosted_session_closing',
        );
        expect(state.model).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        finishRelease();
        expect((await closing).status).toBe(204);
      } finally {
        finishAuthorization();
        finishRelease();
        await request;
        await closing;
      }
    },
  );

  it('keeps a bare cold load of a parked Turn inert', async () => {
    await parkToolTurn();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('carries a blocked authorization message beside the cold-load ground', async () => {
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'core detail',
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The ground names the category; the detail core recorded rides beside
    // it — this Session is closed unregistered, so no other route can ever
    // report the message.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        '"ground":"authorization_blocked_invalid_state","groundDetail":"core detail"',
      ),
    );
  });

  it('names a stranger pending record pending_turn_mismatch on takeover load', async () => {
    await parkToolTurn();
    const read = hostedHistory.readHostedFileHistory;
    vi.spyOn(hostedHistory, 'readHostedFileHistory').mockImplementation(
      async (managed) => {
        const record = await read(managed);
        return record?.pendingTurn
          ? { ...record, pendingTurn: 'stranger-turn' }
          : record;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The takeover recovers exactly its own parked Turn; a record naming any
    // other turn is named outright, not by whichever probe conjunct trips.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"ground":"pending_turn_mismatch"'),
    );
  });

  it('bounds a forged line separator in the blocked authorization detail on the gate tag', async () => {
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      // U+2028 survives a plain ANSI strip and JSON.stringify emits it
      // raw: the detail must reach the single-line tag already bounded.
      message:
        'x\u2028qwen serve: Hosted Session 22222222-2222-4222-8222-222222222222 turn settled',
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      '"groundDetail":"x qwen serve: Hosted Session 22222222-2222-4222-8222-222222222222 turn settled"',
    );
  });

  it('bounds a forged line separator in a Store-read pendingTurn on the gate tag', async () => {
    await parkToolTurn();
    const read = hostedHistory.readHostedFileHistory;
    vi.spyOn(hostedHistory, 'readHostedFileHistory').mockImplementation(
      async (managed) => {
        const record = await read(managed);
        return record?.pendingTurn
          ? {
              ...record,
              // The record parser checks typeof only, and JSON.stringify
              // emits U+2028 raw: the tag must bound the field itself.
              pendingTurn: `x\u2028qwen serve: Hosted Session ${SESSION_ID} turn settled`,
            }
          : record;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      `"pendingTurn":"x qwen serve: Hosted Session ${SESSION_ID} turn settled"`,
    );
  });

  it('bounds a forged line separator in a journal-read unsettled turnId on the gate tag', async () => {
    await parkToolTurn();
    const events = LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'eventsInSequenceRange',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      start,
      end,
    ) {
      return events.call(this, start, end).map((event) =>
        event.kind === 'input.accepted'
          ? {
              ...event,
              payload: {
                ...event.payload,
                // assertManagedSessionStableId admits U+2028 (it is not a
                // control character) and JSON.stringify emits it raw: the
                // tag must bound the journal-read id itself.
                turnId: `x\u2028qwen serve: Hosted Session ${SESSION_ID} turn settled`,
              },
            }
          : event,
      );
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      `"unsettled":"x qwen serve: Hosted Session ${SESSION_ID} turn settled"`,
    );
  });

  it('replays a takeover load idempotently until its continue is admitted', async () => {
    await parkToolTurn();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('results_ready');

    // The original reply was presumably lost: the coordinator repeats the
    // takeover load against the same process and must get the same snapshot
    // instead of a bare already-attached refusal — without driving again.
    const repeated = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body._meta?.['qwen.daemon.managedRuntimeRecovery']).toEqual(
      recovery,
    );
    expect(execute).toHaveBeenCalledOnce();

    // A plain re-load still refuses while the recovery is pending.
    const bare = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(bare.status).toBe(409);
    expect(bare.body.code).toBe('hosted_session_already_attached');

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
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );

    // After the continue settles, nothing is owed: a redrive answers the
    // plain attach (no recovery to recompute), not a refusal and not the
    // old snapshot — the re-answer mechanism needs no consumption rule.
    const afterContinue = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(afterContinue.status).toBe(200);
    expect(
      afterContinue.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeUndefined();
    expect(afterContinue.body.clientId).toBe(loaded.body.clientId);
    expect(afterContinue.body.recoveryRequired).not.toBe(true);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps a turn that ended unanswered out of the resume request history too', async () => {
    // The continue builder must exclude an errored-turn prompt exactly
    // like the execute builder: a parked user Turn resumed through the
    // takeover must not replay the errored turn's naked user record.
    const ERRORED = 'eeeeeeee-1111-4222-8333-eeeeeeeeeeee';
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    spyOnAcquire().mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((_id, _payload, signal) =>
        signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            ),
      );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    // Phase 0: a turn that ends unanswered — the model explodes and the
    // naked user record would be a live second-execution hazard.
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    const doomedPrompt = [{ type: 'text', text: 'doomed' }];
    const doomedDigest = `sha256:${createHash('sha256').update(JSON.stringify(doomedPrompt)).digest('hex')}`;
    const admitted = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt: doomedPrompt,
      promptId: ERRORED,
      payloadDigest: doomedDigest,
    });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // Phase 1: the parked user Turn (parkToolTurn's shape, inline).
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL],
          [
            {
              functionCall: {
                id: CALL.callId,
                name: CALL.name,
                args: CALL.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'write a.txt' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admittedPark = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admittedPark.status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    await authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`));
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    // Takeover + continue: the resume request is the second builder.
    execute.mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    state.model.mockClear();
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
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      promptId?: string;
      history?: Array<{ type?: string; daemonPromptId?: string }>;
    };
    expect(modelInput.promptId).toBe(PROMPT_ID);
    const history = modelInput.history ?? [];
    // The errored turn's naked user record is out; the parked turn's own
    // records stay in.
    expect(history.some((entry) => entry.daemonPromptId === ERRORED)).toBe(
      false,
    );
    expect(history.some((entry) => entry.daemonPromptId === PROMPT_ID)).toBe(
      true,
    );
    // The teardown deletes nothing the resumed Turn still writes: it
    // settles before the Session goes.
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
  }, 30_000);

  it.each([FILE_PROFILE, 'hosted-workspace-files/2'])(
    'settles the parked execution on load and continues the turn (%s)',
    async (toolProfile) => {
      await parkToolTurn([CALL], toolProfile);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      // Non-empty so "fetched" is distinguishable from "never fetched": an
      // empty read assembles to '', which the slot already looks like.
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'workspaceContext',
      ).mockResolvedValue([{ name: 'AGENTS.md', text: 'never touch prod' }]);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const { server, loaded } = await loadReplacement(false, toolProfile);
      expect(loaded.status).toBe(200);
      // The takeover holds the lease until the continued Turn settles.
      expect(release).not.toHaveBeenCalled();
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as {
        phase: string;
        checkpointId: string;
        activationId: string;
        executions: Array<Record<string, unknown>>;
      };
      expect(recovery.phase).toBe('results_ready');
      expect(recovery.executions).toEqual([
        expect.objectContaining({
          executionCallId: '66666666-6666-4666-8666-666666666666',
          outcome: 'known',
          status: { state: 'settled' },
        }),
      ]);
      let declarations: string[] | undefined;
      let recoveredContext: string | undefined;
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, workspaceContext }) => {
          // The takeover-built attachment must have read the Workspace
          // instructions before this recovered turn drives the model.
          recoveredContext = workspaceContext?.read();
          declarations = (await toolTurn!.declarations(signal)).map(
            (tool) => tool.name!,
          );
          return { text: 'continued', model: 'test-model' };
        },
      );
      const clientId = loaded.body.clientId as string;
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
      expect(continued.body.accepted).toBe(true);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(declarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
      ]);
      // The takeover-built attachment starts with an undefined slot: the
      // recovered turn must have populated it before driving the model, or
      // the user-visible answer is synthesized with no project instructions.
      expect(recoveredContext).toContain('--- Context from: AGENTS.md ---');
      expect(recoveredContext).toContain('never touch prod');
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
      expect(
        state.model.mock.calls.some(
          (call) =>
            (call[0] as { resumeFromToolResults?: unknown[] })
              .resumeFromToolResults?.length === 1,
        ),
      ).toBe(true);
      // The recovered turn's Runtime Session is released once it settles — one
      // release for the tool turn's own reconciliation acquire, one for the
      // recovered lease.
      expect(release).toHaveBeenCalledTimes(2);
      // A replayed continuation for the settled Turn replays the receipt
      // without driving the model again.
      const modelCallsBeforeReplay = state.model.mock.calls.length;
      const replayed = await replacementHeaders(
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
      expect(replayed.status).toBe(200);
      expect(replayed.body.accepted).toBe(true);
      expect(state.model.mock.calls.length).toBe(modelCallsBeforeReplay);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );

  function failFinalAuthorization(failure: 'blocked' | 'exception') {
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    const acquisitionsBefore = acquireSpy.mock.calls.length;
    let failed = false;
    return vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'harnessRunAuthorization')
      .mockImplementation(async function (this: LocalManagedSessionAuthority) {
        if (acquireSpy.mock.calls.length > acquisitionsBefore && !failed) {
          failed = true;
          if (failure === 'exception') throw new Error('store hiccup');
          return { status: 'blocked', reason: 'missing_state' } as never;
        }
        return original.call(this);
      });
  }

  it.each(
    (['blocked', 'exception'] as const).flatMap((failure) =>
      [false, true].map((retry) => ({ failure, retry })),
    ),
  )(
    'releases a resident passive adoption after $failure, retry=$retry',
    async ({ failure, retry }) => {
      const { server, clientId } = await parkToolTurn(true);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => undefined);
      const owedLines = () =>
        stderr.mock.calls.filter(
          ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
        );
      const passiveLoad = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        });
      const authorization = failFinalAuthorization(failure);
      const refused = await passiveLoad();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(authorization).toHaveBeenCalledTimes(
        failure === 'blocked' ? 4 : 2,
      );
      if (failure === 'blocked')
        expect(await authorization.mock.results[1].value).toMatchObject({
          status: 'blocked',
          reason: 'missing_state',
        });
      expect(release).not.toHaveBeenCalled();
      const firstRefusalDiagnostics = owedLines().length;
      let repeatedRefusalDiagnostics: number | undefined;
      authorization.mockRestore();
      if (retry) {
        const loaded = await passiveLoad();
        expect(loaded.status).toBe(200);
        expect(loaded.body.clientId).toBe(clientId);
        expect(acquireSpy).toHaveBeenCalledTimes(2);
        expect(release).not.toHaveBeenCalled();
        // Successful attachment drains the refusal's diagnostic record.
        const failedAgain = failFinalAuthorization(failure);
        expect((await passiveLoad()).status).toBe(409);
        repeatedRefusalDiagnostics = owedLines().length;
        failedAgain.mockRestore();
      }
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(204);
      expect(release).toHaveBeenCalledOnce();
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
      expect(firstRefusalDiagnostics).toBe(1);
      if (retry) expect(repeatedRefusalDiagnostics).toBe(2);
    },
  );

  it('refuses a teardown that lands while a resident passive load is adopting', async () => {
    const { server } = await parkToolTurn(true);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    acquireSpy.mockImplementationOnce(() => acquireGate as never);
    let loading: Promise<supertest.Response> | undefined;
    try {
      loading = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledOnce(), {
        timeout: settleTimeoutMs(),
      });
      // The parked recovery holds close()'s fence for its whole await, so a
      // DELETE without a client id is refused instead of racing the adoption:
      // releasing mid-adoption persists the record RELEASED and every later
      // acquire of that identity answers 409 runtime_session_not_acquirable.
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('hosted_turn_active');
      finishAcquire();
      const loaded = await loading;
      expect(loaded.status).toBe(200);
      expect(release).not.toHaveBeenCalled();
      expect(owedLines()).toHaveLength(0);
    } finally {
      finishAcquire();
      await loading;
    }
  }, 30_000);

  it.each(['resolved', 'rejected'])(
    'keeps teardown fenced until overlapping passive loads finish (%s)',
    async (secondOutcome) => {
      const { server, clientId } = await parkToolTurn(true);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      let rejectSecond!: (cause: Error) => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve, reject) => {
        finishSecond = resolve;
        rejectSecond = reject;
      });
      acquireSpy
        .mockImplementationOnce(() => firstGate as never)
        .mockImplementationOnce(() => secondGate as never);
      const passiveLoad = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            toolProfile: FILE_PROFILE,
            passiveManagedRuntimeRecovery: true,
          })
          .then((response) => response);
      let firstLoad: Promise<supertest.Response> | undefined;
      let secondLoad: Promise<supertest.Response> | undefined;
      try {
        firstLoad = passiveLoad();
        await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledOnce(), {
          timeout: settleTimeoutMs(),
        });
        secondLoad = passiveLoad();
        await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(2), {
          timeout: settleTimeoutMs(),
        });
        const bothInFlight = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(bothInFlight.status).toBe(409);
        expect(bothInFlight.body.code).toBe('hosted_turn_active');
        expect(release).not.toHaveBeenCalled();
        finishFirst();
        const first = await firstLoad;
        expect(first.status).toBe(200);
        expect(first.body.clientId).toBe(clientId);
        const prematureClose = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(prematureClose.status).toBe(409);
        expect(prematureClose.body.code).toBe('hosted_turn_active');
        expect(release).not.toHaveBeenCalled();
        if (secondOutcome === 'rejected') {
          rejectSecond(new Error('store hiccup'));
        } else {
          finishSecond();
        }
        const second = await secondLoad;
        expect(second.status).toBe(secondOutcome === 'resolved' ? 200 : 409);
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
        expect(release).toHaveBeenCalledOnce();
        expect(
          (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
        ).toBe(PROMPT_ID);
        const repeatedClose = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(repeatedClose.status).toBe(404);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        finishFirst();
        finishSecond();
        await Promise.all([firstLoad, secondLoad]);
      }
    },
    30_000,
  );

  it('refuses a teardown that lands after a resident passive load published its adoption', async () => {
    const { server } = await parkToolTurn(true);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    // onPassiveRuntimeAcquired publishes the adopted lease as soon as acquire
    // resolves, and the recovery reads execution states after that: gating the
    // read holds the teardown in the published-but-unfinished window.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValue({ state: 'prepared' });
    let finishStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      finishStatus = resolve;
    });
    status.mockImplementationOnce(async () => {
      await statusGate;
      return { state: 'prepared' };
    });
    let loading: Promise<supertest.Response> | undefined;
    try {
      loading = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce(), {
        timeout: settleTimeoutMs(),
      });
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('hosted_turn_active');
      finishStatus();
      const loaded = await loading;
      expect(loaded.status).toBe(200);
      // The adopted lease stays on the live Session: releasing it here would
      // answer 409 runtime_session_not_acquirable to every later acquire of
      // the same identity.
      expect(release).not.toHaveBeenCalled();
      expect(owedLines()).toHaveLength(0);
    } finally {
      finishStatus();
      await loading;
    }
  }, 30_000);

  it('records the owed adoption when a teardown strands a drive redrive', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    release.mockClear();
    acquireSpy.mockClear();
    let acquireEntered = false;
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    acquireSpy.mockImplementationOnce(() => {
      acquireEntered = true;
      return acquireGate as never;
    });
    let redriving: Promise<supertest.Response> | undefined;
    try {
      redriving = replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: storeFor(BOOT_ID_2),
          toolProfile: FILE_PROFILE,
          driveRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(acquireEntered).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(
        (acquireSpy.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
      // This fixture has no G3 request/approval snapshot and reaches the G1 acquire window.
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
      finishAcquire();
      const redriven = await redriving;
      expect(redriven.status).toBe(404);
      expect(redriven.body.code).toBe('hosted_session_not_found');
      // The teardown handed the lease it could see; the redrive's own
      // adoption is named instead of released, because a release would
      // persist RELEASED and wedge every retried acquire of the identity.
      expect(release).toHaveBeenCalledOnce();
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
      expect(owedLines()).toHaveLength(1);
    } finally {
      finishAcquire();
      await redriving;
    }
  }, 30_000);

  it.each(['blocked', 'exception'] as const)(
    'records a cold passive adoption after final authorization is %s',
    async (failure) => {
      await parkToolTurn();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => undefined);
      const authorization = failFinalAuthorization(failure);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_turn_recovery_required');
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(
        stderr.mock.calls.some(
          ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
        ),
      ).toBe(true);
      authorization.mockRestore();
      const reloaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
      });
      expect(reloaded.status).toBe(200);
      expect(release).not.toHaveBeenCalled();
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
      expect(release).toHaveBeenCalledOnce();
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
    },
  );

  it('reports the undriven recovered Turn as in flight until a terminal route drives it', async () => {
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
    const getStatus = () =>
      replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
    // The takeover answered with recovery, but the recovered Turn is still
    // owned by the client: /status must not read the Session as idle, or the
    // SDK's settlement check learns the Turn is terminal while it is not.
    const afterLoad = await getStatus();
    expect(afterLoad.body.hasActivePrompt).toBe(true);
    expect(afterLoad.body.recoveryBlocked).toBe(false);
    // A user cancel cannot stop an undriven recovered Turn — only the
    // coordinator's managed-runtime/cancel settles its parked executions —
    // so the route refuses instead of confirming a cancellation that never
    // happened. A fresh Turn must not start over the checkpoint the takeover
    // just advertised either.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'a second turn' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    // The refusal is the only oncall-visible evidence of a recovered Turn
    // that nobody drives — it must be logged, not just answered.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('refused a fresh prompt while recovered Turn'),
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
        expect((await getStatus()).body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The recovered Turn settled: the Session admits fresh Turns again.
    const nextPrompt = [{ type: 'text', text: 'after the takeover' }];
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
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
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(later.body.events).toEqual(
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
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven takeover load whose reply was lost', async () => {
    await parkToolTurn();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('results_ready');
    expect(execute).toHaveBeenCalledTimes(1);
    // The load reply is lost: the coordinator redrives the identical load
    // against the already-attached Session, which must re-answer the
    // recovery snapshot instead of wedging the Turn on a 409 loop.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body.lastEventId).toBe(loaded.body.lastEventId);
    const redrivenRecovery = redriven.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as Record<string, unknown>;
    expect(redrivenRecovery).toEqual(recovery);
    // The redrive dispatches nothing: the parked execution stays settled
    // exactly once.
    expect(execute).toHaveBeenCalledTimes(1);
    // The redriven snapshot admits the continuation.
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', redriven.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: redrivenRecovery['checkpointId'],
        activationId: redrivenRecovery['activationId'],
      });
    expect(continued.status).toBe(200);
    expect(continued.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', redriven.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', redriven.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven passive takeover load whose reply was lost', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_runtime');
    // The passive load reply is lost; the redrive re-reads the Broker state
    // and re-answers the snapshot rather than refusing with a 409.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    const redrivenRecovery = redriven.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as Record<string, unknown>;
    expect(redrivenRecovery).toEqual(recovery);
    // The redriven snapshot admits the cancellation.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', redriven.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: redrivenRecovery['checkpointId'],
        activationId: redrivenRecovery['activationId'],
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('a failed lease release keeps the suspension gate closed', async () => {
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
    // The handback the cancellation owes cannot land, so the settled Turn
    // leaves the lease owed. The idle teardown must not certify that
    // release: it retries to the cap and escalates instead of sealing.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable'),
    );
    const server = await replacementApp(undefined, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 5,
      suspendRetryCap: 2,
    });
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    // The gate survives the resident: a cold open meets the non-transient
    // refusal, never a silent seal that would report the Session ready
    // while its Runtime owner is still running.
    await vi.waitFor(
      async () => {
        const load = await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: storeFor(BOOT_ID_2),
          toolProfile: FILE_PROFILE,
        });
        expect(load.status).toBe(409);
        expect(load.body.code).toBe('hosted_session_teardown_blocked');
      },
      { timeout: 5000 },
    );
    const stats = (
      server as Server & {
        harnessRegistration: ReturnType<
          typeof registerHostedHarnessSessionRoutes
        >;
      }
    ).harnessRegistration.suspensionStats();
    expect(stats.blockedTeardowns).toBe(1);
    expect(stats.cleanSuspensions).toBe(0);
  });

  it('keeps a transiently blocked restore on the retriable refusal', async () => {
    // A missing_state WITH the authority's store-error message is an erased
    // store call, not a durable verdict: the route must answer the retriable
    // 409, never the typed terminal decline, even though a bare
    // missing_state (no message) and missing_checkpoint both go terminal.
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'missing_state',
      message: 'the HTTP Managed Session writer is not active.',
    } as never);
    const close = vi.spyOn(LocalManagedSessionAuthority.prototype, 'close');
    const { loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('restore_blocked');
    expect(close).toHaveBeenCalled();
  });

  it('keeps a durably blocked cancel-arm restore on the retriable refusal', async () => {
    // The restore guard runs before the takeover branch: a durable verdict
    // on a cancellation-only load answers the baseline retriable refusal —
    // an attach from a blocked restore is unsafe for ANY shape, and the
    // kernel's inapplicable still wants no terminal write from this code.
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'opaque_state',
    } as never);
    const { loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('restore_blocked');
  });

  it('refuses a cancellation takeover of a parked no-tool Turn retriably', async () => {
    // Where the kernel cannot even be called, nothing may answer "nothing
    // is owed": a minted plain attach would stand a Session whose parked
    // Turn no route resolves, and the loose latch would then admit input
    // the authority can never settle (R5-2'). The cancellation arm gets
    // the baseline retriable refusal instead; drive keeps its typed
    // model_start decline. Surface the connector's workspace==null shape:
    // a definition lacking any toolProfile, so the load stays tool-free.
    await parkToolTurn();
    const read = LocalManagedSessionResourceStore.prototype.read;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      const bytes = await read.call(this, reference);
      if (reference.kind !== 'managed-definition') return bytes;
      const definition = JSON.parse(bytes.toString('utf8')) as Record<
        string,
        unknown
      >;
      delete definition['toolProfile'];
      return Buffer.from(JSON.stringify(definition));
    });
    const drive = await replacementHeaders(
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      driveRuntimeRecovery: true,
    });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('model_start');

    // The decline closed its authority, releasing the writer latch for
    // the cancellation arm's load.
    const passive = await replacementHeaders(
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
    expect(passive.body.reason).toBe('takeover_unsupported');
  });

  it('replays the snapshot only to a request re-proving its store identity', async () => {
    // The replay hands over the attached session's client id, so a caller
    // with the harness token and a matching takeover shape must also
    // re-prove tenant/workspace/store — otherwise it drives a session whose
    // journal identity it never proved.
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: { ...storeFor(BOOT_ID_2), tenantId: 'other-tenant' },
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_session_already_attached');
    // The workspace half of the identity check guards the same handover:
    // a matching tenant under the wrong workspace is still a caller that
    // never proved this Session's journal identity.
    const wrongWorkspace = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: {
        ...storeFor(BOOT_ID_2),
        workspaceId: 'other-workspace',
      },
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(wrongWorkspace.status).toBe(409);
    expect(wrongWorkspace.body.code).toBe('hosted_session_already_attached');
    const matching = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(matching.status).toBe(200);
  });

  function mockAuthorizationWithPhase(phase: string, approval: unknown) {
    // Pass the REAL authorization through with only the wait shape
    // changed: a wholesale replacement breaks the integrity checks the
    // route performs between open, restore and takeover.
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const authorization = await original.call(this);
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase,
          },
          ...(approval === undefined ? {} : { approval }),
        },
      } as never;
    });
  }

  it('carries a takeover decline reason onto the wire', async () => {
    // The seven-reason taxonomy was witnessed only at the restore guard:
    // this pins a recoverHostedRuntimeTurn decline reaching the route's
    // own emitter with its typed reason intact.
    await parkToolTurn();
    mockAuthorizationWithPhase('before_model', undefined);
    const { loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_declined');
    expect(loaded.body.reason).toBe('model_start');
  });

  it('carries a resident kernel decline reason onto the wire', async () => {
    const { server } = await parkToolTurn(true);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({ status: 'blocked', reason: 'identity_mismatch' });
    const declined = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('checkpoint_blocked');
  });

  // #17260: the reason literal is the cross-language contract with
  // HarnessCoordinator's REASON_PUBLIC_CHILD_UNSUPPORTED. Deleting the
  // branch drops the cause into the retriable refusal — the once-a-minute
  // loop — and renaming the literal silently stops matching, both with a
  // green suite unless these route answers are pinned.
  it('declines a resident redrive whose saved public-child profile changed', async () => {
    const { server } = await parkToolTurn(true);
    vi.spyOn(
      approvalContinuation,
      'findHostedApprovalContinuation',
    ).mockRejectedValue(new HostedPublicChildRecoveryProfileChanged());
    const declined = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('public_child_recovery_unsupported');
  });

  it('declines a cold takeover load whose saved public-child profile changed', async () => {
    await parkToolTurn();
    // The saved continuation is only read at a continuation phase; the
    // parked tool wait itself sits at await_runtime.
    mockAuthorizationWithPhase('await_action', { state: 'requested' });
    vi.spyOn(
      approvalContinuation,
      'findHostedApprovalContinuation',
      // The park that produced the continuation ran on the healthy
      // topology; only the load's own read meets the stale profile.
    ).mockRejectedValue(new HostedPublicChildRecoveryProfileChanged());
    const server = await replacementApp();
    const declined = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('public_child_recovery_unsupported');
  });

  it.each([false, true])(
    'reattaches a resident requested approval (passive=%s)',
    async (passive) => {
      const { server, clientId } = await parkToolTurn(true);
      mockAuthorizationWithPhase('await_approval', { state: 'requested' });
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(loaded.status).toBe(200);
      expect(loaded.body.clientId).toBe(clientId);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      expect(acquireSpy).not.toHaveBeenCalled();
    },
  );

  /**
   * Takes a parked Workspace turn over and continues it with every
   * turn_result write rejected by `failure`: the resident ends
   * recovery-blocked with its terminal record still owed, payable by a
   * later redrive's final-settlement projection.
   */
  async function blockOnLostTerminalWrite(failure: Error) {
    await parkToolTurn();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(function (this: ManagedSessionRecordSink, item) {
        if (item.subtype === 'turn_result') return Promise.reject(failure);
        return originalWrite.call(this, item);
      });
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      })
      .expect(200);
    const status = () =>
      replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
    await vi.waitFor(async () => {
      const blocked = await status();
      expect(blocked.body.hasActivePrompt).toBe(false);
      expect(blocked.body.recoveryBlocked).toBe(true);
    });
    write.mockRestore();
    return { server, loaded, status };
  }

  it('clears a stale store reason when resident recovery preparation fails', async () => {
    const { server, status } = await blockOnLostTerminalWrite(
      new ManagedSessionStoreTransportError('terminal write unavailable'),
    );
    expect((await status()).body.recoveryReason).toBe(
      'managed_session_store_unavailable',
    );

    const preparation = vi
      .spyOn(modelRecovery, 'findHostedCommittedModelOutput')
      .mockRejectedValueOnce(new Error('recovery preparation unavailable'));
    try {
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(409);
      expect(redriven.body.code).toBe('hosted_turn_recovery_required');
      expect(preparation).toHaveBeenCalledOnce();
    } finally {
      preparation.mockRestore();
    }

    const blocked = await status();
    expect(blocked.body.recoveryBlocked).toBe(true);
    expect(blocked.body.recoveryReason).toBeUndefined();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it.each([false, true])(
    'settles a payable resident projection after a lost terminal write (passive=%s)',
    async (passive) => {
      // The lost write met the store, so the block it leaves is named —
      // and the lift the projection brings must take the name with it
      // (#13800 R2-5).
      const { server, loaded, status } = await blockOnLostTerminalWrite(
        new ManagedSessionStoreTransportError('terminal write unavailable'),
      );
      expect((await status()).body.recoveryReason).toBe(
        'managed_session_store_unavailable',
      );
      const history = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(history.body.history.pendingUndo).toBeNull();
      mockAuthorizationWithPhase('turn_settled', null);
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(redriven.status).toBe(200);
      expect(redriven.body.clientId).toBe(loaded.body.clientId);
      await vi.waitFor(async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      });
      // A lifted block keeps no reason: a stale store name would point a
      // client's retry and an operator's alert at a store that has
      // recovered.
      await vi.waitFor(async () => {
        const lifted = await status();
        expect(lifted.body.recoveryBlocked).toBe(false);
        expect(lifted.body.recoveryReason).toBeUndefined();
      });
    },
  );

  it('names the store on the block a resident projection leaves when its commit cannot land', async () => {
    // The final-settlement projection settles outside every turn route: a
    // redrive that finds the park payable lifts the block and writes the
    // terminal record itself. When that commit dies against the store,
    // the block it leaves is named like the turn routes' blocks. The
    // continue route's block before it was unnamed, so the name can only
    // come from the projection (#13800 R2-14).
    const { server, status } = await blockOnLostTerminalWrite(
      new Error('terminal write unavailable'),
    );
    expect((await status()).body.recoveryReason).toBeUndefined();
    mockAuthorizationWithPhase('turn_settled', null);
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    let settlementAttempts = 0;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        // The projection's terminal commit is the only batch carrying a
        // turn.settled event.
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        settlementAttempts += 1;
        throw new ManagedSessionStoreTransportError('store flap');
      });
    try {
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(200);
      await vi.waitFor(
        async () => {
          const reblocked = await status();
          expect(reblocked.body.hasActivePrompt).toBe(false);
          expect(reblocked.body.recoveryBlocked).toBe(true);
          expect(reblocked.body.recoveryReason).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: settleTimeoutMs() },
      );
    } finally {
      failing.mockRestore();
    }
    // The projection's one commit met the store; nothing retried it past
    // the stopped writer.
    expect(settlementAttempts).toBe(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses a resident inapplicable redrive while a rewind owns the prompt slot', async () => {
    const realAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    await parkToolTurn();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(function (this: ManagedSessionRecordSink, item) {
        if (item.subtype === 'turn_result')
          return Promise.reject(new Error('terminal write unavailable'));
        return originalWrite.call(this, item);
      });
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      })
      .expect(200);
    await vi.waitFor(async () => {
      const status = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    write.mockRestore();
    // An approval-pending redrive answers the inapplicable resident without
    // a projection, clearing the resident latch.
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const armed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(armed.status).toBe(200);
    // The next redrive turns payable: hold it inside
    // settleProjectablePromptId, admit a rewind inside the window, and
    // only then release the held read.
    let resumeSettle!: () => void;
    const settleHeld = new Promise<void>((resolve) => {
      resumeSettle = resolve;
    });
    let settleParked = false;
    let helperAnswered = false;
    vi.mocked(
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization,
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      if (helperAnswered && !settleParked) {
        settleParked = true;
        await settleHeld;
      }
      const authorization = await realAuthorization.call(this);
      helperAnswered = true;
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase: 'turn_settled',
          },
          approval: null,
        },
      } as never;
    });
    const redriven = replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(settleParked).toBe(true);
    });
    // The rewind's own history read is the only resource read in flight
    // now, so gating it parks the rewind after it took the prompt slot.
    let resumeRewindRead!: () => void;
    const rewindReadHeld = new Promise<void>((resolve) => {
      resumeRewindRead = resolve;
    });
    let rewindParked = false;
    const realRead = LocalManagedSessionResourceStore.prototype.read;
    const readSpy = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockImplementation(async function (
        this: LocalManagedSessionResourceStore,
        ...args: Parameters<LocalManagedSessionResourceStore['read']>
      ) {
        if (!rewindParked) {
          rewindParked = true;
          await rewindReadHeld;
        }
        return realRead.apply(this, args);
      } as never);
    const rewind = replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', armed.body.clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(rewindParked).toBe(true);
    });
    resumeSettle();
    const refused = await redriven;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    // The rewind must keep its prompt slot: /status may never report the
    // Session idle while a workspace mutation is in flight.
    const during = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', armed.body.clientId);
    expect(during.body.hasActivePrompt).toBe(true);
    resumeRewindRead();
    readSpy.mockRestore();
    await rewind;
    await vi.waitFor(async () => {
      const status = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', armed.body.clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
  });

  it.each(['removed', 'closing'] as const)(
    'refuses a resident inapplicable redrive when its attachment is %s',
    async (attachmentState) => {
      await parkToolTurn();
      vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const originalAuthorization =
        LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
      let resumeAuthorization!: () => void;
      const authorizationGate = new Promise<void>((resolve) => {
        resumeAuthorization = resolve;
      });
      let authorizationCalls = 0;
      let authorizationHeld = false;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        const authorization = await originalAuthorization.call(this);
        if (authorization.status !== 'runnable') return authorization;
        if (++authorizationCalls === 2) {
          authorizationHeld = true;
          await authorizationGate;
        }
        return {
          ...authorization,
          checkpoint: {
            ...authorization.checkpoint,
            continuation: {
              ...authorization.checkpoint.continuation,
              phase: 'await_approval',
            },
            approval: { state: 'requested' },
          },
        } as never;
      });
      let resumeClose!: () => void;
      const closeGate = new Promise<void>((resolve) => {
        resumeClose = resolve;
      });
      let closeHeld = false;
      if (attachmentState === 'closing') {
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockImplementationOnce(async () => {
          closeHeld = true;
          await closeGate;
        });
      }
      const load = replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: storeFor(BOOT_ID_2),
          toolProfile: FILE_PROFILE,
          driveRuntimeRecovery: true,
        })
        .then((response) => response);
      let close: Promise<supertest.Response> | undefined;
      try {
        await vi.waitFor(() => expect(authorizationHeld).toBe(true));
        close = replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).then((response) => response);
        if (attachmentState === 'closing') {
          await vi.waitFor(() => expect(closeHeld).toBe(true));
        } else {
          expect((await close).status).toBe(204);
        }
        resumeAuthorization();
        const refused = await load;
        expect(refused.status).toBe(attachmentState === 'removed' ? 404 : 409);
        expect(refused.body.code).toBe(
          attachmentState === 'removed'
            ? 'hosted_session_not_found'
            : 'hosted_session_closing',
        );
      } finally {
        resumeAuthorization();
        resumeClose();
        await Promise.allSettled(close ? [load, close] : [load]);
      }
      expect((await close!).status).toBe(204);
    },
  );

  it('refuses a cancellation takeover attachment deleted during settlement', async () => {
    const { server } = await parkToolTurn(true);
    const authorize =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const result = await authorize.call(this);
      if (result.status !== 'runnable') return result;
      return {
        ...result,
        checkpoint: {
          ...result.checkpoint,
          approval: null,
          tools: {
            ...result.checkpoint.tools,
            items: result.checkpoint.tools!.items.map((item) => ({
              ...item,
              state: 'settled',
              consumed: true,
            })),
          },
        },
      } as never;
    });
    let started!: () => void;
    const settling = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, item) {
        await originalWrite.call(this, item);
        if (item.subtype === 'turn_result') {
          started();
          await held;
        }
      },
    );
    const load = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      })
      .then((response) => response);
    await settling;
    try {
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
        204,
      );
    } finally {
      resume();
    }
    const refused = await load;
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('hosted_session_not_found');
  });

  it('re-answers the unchanged recovery after a lost cancellation report', async () => {
    // Nothing consumed means nothing to unwedge: a failed cancel cannot
    // break the re-answer — the redrive recomputes from the attached state
    // and admits the still-pending cancellation (R5-8's gap, closed by
    // construction in D6's recompute mode).
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'unknown',
    });
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const replayed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(replayed.status).toBe(200);
    // The recompute proves the same parked Turn under the live state —
    // the failed cancel's unknown read surfaces honestly in the report.
    const replayRecovery = replayed.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
      executions: Array<{ outcome: string }>;
    };
    expect(replayRecovery.checkpointId).toBe(recovery.checkpointId);
    expect(replayRecovery.activationId).toBe(recovery.activationId);
    expect(replayRecovery.executions[0]?.outcome).toBe('unknown');
  });

  it('refuses a fresh prompt stacked on a Session attached with a parked Turn', async () => {
    // An approval-parked takeover answers inapplicable: the Session
    // attaches plain, with every latch skipped and no recoveryRequired
    // advertised (R5-2). The prompt route must still guard the journal
    // itself (R10-2): a different promptId admitted on top would run from
    // the parked Turn's mid-flight checkpoint, overwrite it on commit, and
    // leave two unsettled inputs that fail every later takeover closed.
    await parkToolTurn();
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const prompt = [{ type: 'text', text: 'stack on the parked Turn' }];
    const stacked = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(stacked.status).toBe(409);
    // The session-level wedge code, deliberately NOT the prompt-scoped
    // one: `hosted_prompt_recovery_required` names the REQUESTED prompt's
    // own unsettled duplicate, and the coordinator proves a lost-reply
    // adoption from it (R11-1); a refusal about someone else's parked
    // work must never mint that proof.
    expect(stacked.body.code).toBe('hosted_turn_recovery_required');
    // Re-posting the PARKED promptId itself is not a replay either: the
    // journal holds it accepted AND unsettled, where only a takeover may
    // settle — answering the replay's 202 would certify an admission the
    // Session cannot drive.
    const parkedPrompt = [{ type: 'text', text: 'write a.txt' }];
    const reposted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: parkedPrompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(parkedPrompt)).digest('hex')}`,
      });
    expect(reposted.status).toBe(409);
    expect(reposted.body.code).toBe('hosted_prompt_recovery_required');
  });

  it('refuses an inapplicable takeover whose projection cannot settle the park', async () => {
    // The checkpoint claims turn_settled while the journal never landed
    // the record: the bare branch's settle conditions do not hold (the
    // executions are still unsettled, the assistant tail carries a
    // functionCall), so no route pays — the load keeps the retriable
    // refusal instead of minting a healthy-looking plain attach (R11-2).
    await parkToolTurn();
    mockAuthorizationWithPhase('turn_settled', undefined);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    for (const passive of [false, true]) {
      const refused = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('takeover_unrecovered');
    }
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
  });

  it('refuses an inapplicable takeover whose file history cannot settle past the projection', async () => {
    // The parked Turn's tool work settled and was consumed and its last
    // assistant message is text-only with an empty tail, so every
    // settleProjectablePromptId guard passes except the file-history
    // probe — which can never pay here (the checkpoint names turn_settled
    // and the text tail carries no tool calls). The record's clearing
    // commit is held back below, so it still names the parked Turn: the
    // load must keep the retriable refusal instead of projecting a
    // turn_result over a history record nothing clears.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      await toolTurn!.execute(
        [CALL],
        [
          {
            functionCall: {
              id: CALL.callId,
              name: CALL.name,
              args: CALL.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    // The terminal record never lands: the Turn parks with its tool work
    // settled and consumed and a text-only assistant at the tail.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (record.subtype === 'turn_result')
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    // Hold back the record's clearing commit: it still names the parked
    // Turn when the projection would run — the shape the probe refuses.
    const commitHistory = hostedHistory.commitHostedFileHistory;
    vi.spyOn(hostedHistory, 'commitHostedFileHistory').mockImplementation(
      async (managed, historyRecord) =>
        historyRecord.pendingTurn === null
          ? undefined
          : commitHistory(managed, historyRecord),
    );
    const prompt = [{ type: 'text', text: 'write a.txt' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
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
    // The park is durable; the probe window below watches for the
    // projection's would-be terminal record.
    write.mockImplementation(async function (
      this: ManagedSessionRecordSink,
      record,
    ) {
      return originalWrite.call(this, record);
    });
    write.mockClear();
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    mockAuthorizationWithPhase('turn_settled', undefined);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await replacementHeaders(
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('takeover_unrecovered');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
    // A wrongly-started projection writes asynchronously: give it its
    // would-be window, then prove no terminal record landed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      write.mock.calls.filter(([record]) => record.subtype === 'turn_result'),
    ).toHaveLength(0);
  });

  it('refuses the attached redrive of an inapplicable takeover it cannot settle', async () => {
    // Stage 1: the requested approval answers inapplicable and the Session
    // attaches (the resolve route can pay that wait). Stage 2: the parked
    // state has since become turn_settled-with-missing-record whose
    // projection cannot pay — the redrive must refuse retriably rather
    // than restate a 200 over a Turn nothing terminalizes (R11-2).
    await parkToolTurn();
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    mockAuthorizationWithPhase('turn_settled', null);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(409);
    expect(redriven.body.code).toBe('hosted_turn_recovery_required');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
  });

  it('arms the undriven marker when a redriven load re-answers a newly drivable recovery', async () => {
    await parkToolTurn();
    // The first passive load meets an execution the Broker cannot account
    // for: the report is undrivable, so the marker stays unarmed.
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockResolvedValue(undefined);
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    // The reply was lost; by the redrive the Broker can account for the
    // execution, so the re-answer advertises a drivable recovery — and must
    // arm the same marker the first load would have, or a fresh prompt is
    // admitted over the parked execution the report describes.
    status.mockResolvedValue({ state: 'executing' });
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const freshPrompt = [{ type: 'text', text: 'racing prompt' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the undriven marker when a redriven load re-answers undrivable', async () => {
    await parkToolTurn();
    // The first passive load meets a live execution: the report is
    // drivable, so the marker arms — then its 200 reply is lost.
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockResolvedValue({ state: 'executing' });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    // By the redrive the Broker has forgotten the execution: the recomputed
    // report is undrivable, and the coordinator fails the Turn without ever
    // calling continue/cancel — so the marker the first load armed must
    // discharge here, or no route ever clears it.
    status.mockResolvedValue(undefined);
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    // The refusal code discriminates the disarm: an armed marker answers
    // hosted_turn_active, while the journal-level guard (R10-2) answers
    // hosted_turn_recovery_required for the still-unsettled parked input.
    const freshPrompt = [{ type: 'text', text: 'after the disarm' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  /** Commits a pending Monitor notification into the parked Session's
   * journal: the wake pump owes it a Turn the moment the Session idles. */
  async function commitMonitorNotification(turnId: string): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
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
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const monitors = new HostedMonitorSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  it('parks the Monitor wake pump while a recovered Turn is undriven', async () => {
    domainEnablement.monitorRun = true;
    try {
      await parkToolTurn([CALL], 'hosted-workspace-shell/1');
      const notificationTurnId = 'monitor-1:notify:1';
      await commitMonitorNotification(notificationTurnId);
      // A drivable passive takeover arms the undriven marker; the load
      // registration also kicks the wake pump that owns the notification.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'executing',
      });
      wakeDeps.last = undefined;
      state.model.mockClear();
      // Count the pump's kicks so a retry refused while the marker is armed
      // is witnessed, not assumed from a hardcoded sleep.
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      const { server, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const kicksAtLoad = kick.mock.calls.length;
      const armed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(armed.body.hasActivePrompt).toBe(true);
      // The wake scheduler came up with the takeover load; the armed marker
      // must read busy to it, or the pump would start the monitor Turn over
      // the parked checkpoint the recovery report just advertised.
      const deps = wakeDeps.last as { busy?: () => boolean } | undefined;
      expect(deps?.busy?.()).toBe(true);
      // The park has something to park: the notification's input is
      // journaled where the pump reads it.
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(true);
      // At least one pump retry fires and is refused while the marker is
      // armed: no model Turn ran and the notification stays unsettled.
      await vi.waitFor(
        () => expect(kick.mock.calls.length).toBeGreaterThan(kicksAtLoad),
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).not.toHaveBeenCalled();
      const parkedJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        parkedJournal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(false);
      // Driving the recovered Turn to its terminal record discharges the
      // marker — the pump's busy claim releases with it. The stop step's
      // poll needs a terminal fence: report the execution settled now.
      const statusSpy = vi.mocked(HostedWorkspaceBroker.prototype.status);
      statusSpy.mockResolvedValue({ state: 'settled' });
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
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The discharged marker must let the pump deliver the parked
      // notification: its model turn runs and its input settles.
      await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
        timeout: settleTimeoutMs(),
      });
      await vi.waitFor(
        async () => {
          const delivered = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          expect(
            delivered.events.some(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === notificationTurnId,
            ),
          ).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.monitorRun = false;
    }
  });

  it('keeps the Monitor wake pump parked after an undrivable redrive disarms the marker', async () => {
    domainEnablement.monitorRun = true;
    try {
      await parkToolTurn([CALL], 'hosted-workspace-shell/1');
      const notificationTurnId = 'monitor-1:notify:1';
      await commitMonitorNotification(notificationTurnId);
      // A drivable passive takeover arms the undriven marker; the load
      // registration also kicks the wake pump that owns the notification.
      const status = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'status')
        .mockResolvedValue({ state: 'executing' });
      wakeDeps.last = undefined;
      state.model.mockClear();
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      const { server, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const armed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(armed.body.hasActivePrompt).toBe(true);
      // The lost reply is redriven once the Broker can no longer account
      // for the execution: the undrivable re-answer disarms the marker,
      // but the parked input is still unsettled in the journal, so the
      // pump must stay parked exactly like /prompt keeps refusing.
      status.mockResolvedValue({ state: 'unknown' });
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(200);
      const disarmed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(disarmed.body.hasActivePrompt).toBe(false);
      // A negative assertion can only wait on the clock: past two 500 ms
      // retry intervals the pump must still not have run the notification
      // Turn — no model call, and no turn.settled for a notification no
      // model ever saw. (A fired pump wedges the Session blocked, which
      // stops the kicks, so a kick-count gate would read the buggy arm as
      // a pass.)
      expect(kick.mock.calls.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(state.model).not.toHaveBeenCalled();
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(false);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.monitorRun = false;
    }
  });

  it('keeps the held Runtime lease when a redriven load fails transiently', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    release.mockClear();
    // A transient Broker failure inside the re-answer must refuse with the
    // retry-inviting code — and must NOT release the lease the attached
    // Session already holds: a release persists RELEASED and every later
    // redrive would wedge on runtime_session_not_acquirable.
    acquireSpy.mockRejectedValueOnce(new Error('broker hiccup'));
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('takeover_failed');
    expect(release).not.toHaveBeenCalled();
    // The next redrive recovers: same attachment, same recovery snapshot.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body._meta?.['qwen.daemon.managedRuntimeRecovery']).toEqual(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  /** Drives the parked Turn into the consume/settle crash window: the
   * committed results are consumed into the continuation (checkpoint
   * results_ready, every runtime item settled and consumed) while the
   * journal never lands the terminal record — the state a drive load's
   * lost reply leaves behind. */
  async function consumeParkedToolResults(): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
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
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: managed,
        sessionId: SESSION_ID,
        cwd: state.root,
        promptId: PROMPT_ID,
        brokerOptions: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        passive: false,
      });
      if (outcome.kind !== 'recovered')
        throw new Error(`expected a recovery, got ${outcome.kind}`);
      await createManagedHarnessHandle(managed).consumeRuntimeResults();
    } finally {
      await managed.close();
    }
  }

  it('disarms the undriven marker when a redriven load settles the cancelled park', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    // The owner dies between consumeRuntimeResults() and
    // settleConsumedRuntimeContinuation(): results_ready with every runtime
    // item settled and consumed, the journal input still unsettled.
    await consumeParkedToolResults();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    // The lost-reply redrive carrying the coordinator's cancellation
    // settles the park without the kernel — and must discharge the marker
    // with it, or /prompt refuses this Session for the rest of the
    // incarnation.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
      cancellationTakeover: true,
    });
    expect(redriven.status).toBe(200);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.hasActivePrompt).toBe(false);
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
    // A user cancel over the settled Turn keeps the plain 204: the
    // client's cancel flow hard-requires it before streaming the terminal
    // record, and a definitive refusal would be retried forever.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(204);
    // The Session is usable again: a fresh prompt is admitted and settles.
    const nextPrompt = [{ type: 'text', text: 'after the redriven settle' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '99999999-9999-4999-8999-999999999999',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const idle = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(idle.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a stopped writer when a redriven recovery cannot journal the settle', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    // A passive takeover attaches without driving the parked execution, so
    // the report stays at await_runtime and the lease it acquired on the
    // dead-owner identity stays recorded on the resident Session.
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    expect(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery']?.['phase'],
    ).toBe('await_runtime');
    release.mockClear();
    // The drive redrive must journal the execution's settle: publish the
    // outcome, write the tool_result record, and resolve the await_runtime
    // batch. A failed append latches writesStopped in the authority, so the
    // refusal names the terminal writer state rather than the takeover
    // shape (R1-3), while the lease already held is not handed back.
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValue(new Error('journal down'));
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('writes_stopped');
    expect(release).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven takeover load of a Session without a parked Turn', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(loaded.body._meta).toBeUndefined();
    // Same lost-reply redrive, but the Session has no parked Turn: the
    // attachment is re-stated as-is.
    const redriven = await replacementHeaders(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body._meta).toBeUndefined();
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

  it('logs the reconciliation root cause of a refused load-resume', async () => {
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
    // The drive consumed the parked results, so the checkpoint now reads
    // results_ready with the file-history marker still pending: detach, and
    // the next bare load computes a resume whose reconciliation reads the
    // drifted snapshot.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'fileHistory',
    ).mockResolvedValueOnce({
      ownerSessionId: SESSION_ID,
      snapshots: [{ filePath: 'drifted' } as never],
      files: {},
    });
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('managed_session_open_failed');
    // The 503 carries no detail: the root cause an operator needs must be in
    // the daemon log, not swallowed by the final else arm.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Original file history snapshots changed.'),
    );
  });

  it('reports an undrivable recovery passively without arming the Session', async () => {
    await parkToolTurn();
    // Only a still-reconcilable unknown reports as failing to account for
    // the execution: the coordinator cannot drive it either, so arming the
    // marker here would refuse every later route forever.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'unknown',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.executions).toEqual([
      expect.objectContaining({ outcome: 'unknown' }),
    ]);
    const clientId = loaded.body.clientId as string;
    // The coordinator cannot drive a recovery whose executions are unknown —
    // it fails the Turn without ever calling continue/cancel — so arming
    // the undriven marker here would pile `hosted_turn_active` onto the
    // journal-state refusals G3 already answers for the parked input: the
    // Session must stay unarmed instead.
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(status.body.recoveryBlocked).toBe(false);
    // G3's journal-state guards own the refusal while the parked input
    // stays unsettled: the user cancel meets R10-3's honest 409, and a
    // fresh prompt meets R10-2's session-level 409 — `hosted_turn_active`
    // here would mean the marker armed, which is exactly what this test
    // forbids for an undrivable report.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'after a lost runtime' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(409);
    expect(admitted.body.code).toBe('hosted_turn_recovery_required');
    // The settling prompt must not release the lease this load adopted: a
    // release persists RELEASED and wedges the still-parked Turn's next
    // takeover on runtime_session_not_acquirable — the adoption is owed to
    // the terminal recovery route or close() alone.
    expect(release).not.toHaveBeenCalled();
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
  });

  it('refuses a file rewind while a recovered Turn is undriven', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const historySpy = vi.spyOn(hostedHistory, 'readHostedFileHistory');
    // A route that borrows `active` as its busy flag must not be admitted
    // over the undriven Turn either — it would confuse the user cancel with
    // an abort the rewind body never consults, and its own failure would
    // wedge the recovery it races.
    const rewound = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        requestId: '99999999-9999-4999-8999-999999999999',
        promptId: PROMPT_ID,
      });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_active');
    expect(historySpy).not.toHaveBeenCalled();
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses a takeover on a Session without any tool profile', async () => {
    await parkBlockedTextTurn(false);
    const server = await replacementApp();
    // The drive shape is G3's typed terminal decline; the retriable refusal
    // with its ground survives on the cancellation-only shape.
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('takeover_unsupported');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('settles a takeover whose parked turn holds nothing unanswerable (#13847)', async () => {
    await parkBlockedTextTurn(true);
    const server = await replacementApp();
    const loadBody = {
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    };
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(loadBody);
    // G3 declined this park terminally and bricked the Session. #13847
    // settles it instead: the interrupted Turn owes no Runtime work and
    // nothing the takeover cannot answer, so it is cancelled durably and
    // this drive keeps only the plain retriable refusal…
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('takeover_unrecovered');
    // …and the next drive attaches, because the Turn's settle landed the
    // input: the Session is never bricked.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(loadBody);
    expect(reloaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});
