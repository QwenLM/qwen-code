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
  hookApp,
  hookPin,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
} from './hosted-hook-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedHookOperationView } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('runs and queries a Hook-only operation without opening a user turn', async () => {
    const { server, authorize, requests } = await hookApp();
    const operationId = randomUUID();
    const operation = {
      operationId,
      event: 'Notification',
      input: { message: 'ready', notification_type: 'test' },
    };
    const response = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send(operation);
    expect(response.status).toBe(200);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        ).send(operation)
      ).status,
    ).toBe(200);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const conflict = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({ ...operation, input: { ...operation.input, message: 'changed' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_hook_operation_conflict');
    expect(log).not.toHaveBeenCalled();
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
    const status = await authorize(
      supertest(server).get(
        `/session/${SESSION_ID}/hooks/operations/${operationId}`,
      ),
    );
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('settled');
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
  });

  it.each([
    ['a Hook operation', 200, 'hosted_hook_operation_active'],
    ['Session deletion', 204, 'hosted_session_closing'],
  ])('refuses a prompt while %s runs', async (trigger, settled, code) => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => (dispatched = resolve));
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute') {
        dispatched();
        await held;
      }
      return original(operation);
    });
    const running = (
      trigger === 'Session deletion'
        ? headers(supertest(server).delete(`/session/${SESSION_ID}`))
        : authorize(
            supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
          ).send({
            operationId: randomUUID(),
            event: 'Notification',
            input: { message: 'ready', notification_type: 'test' },
          })
    ).then(
      (response) => response,
      () => undefined,
    );
    await started;
    try {
      const refused = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe(code);
    } finally {
      finish();
      expect((await running)?.status).toBe(settled);
    }
  });

  it.each(['continue', 'cancel'])(
    'refuses Runtime-only %s for a Hook Session without changing its owner or records',
    async (operation) => {
      const { server, authorize, requests, release } = await hookApp();
      const before = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      const control = await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${operation}`,
        ),
      ).send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint',
        activationId: 'activation',
      });
      expect(control.status).toBe(409);
      expect(control.body.code).toBe('hosted_hook_recovery_required');
      expect(requests).toEqual([]);
      expect(release).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      const after = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(after.body.events).toEqual(before.body.events);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([1, 2])(
    'recovers Hook activation after %s failed installation(s) without accepting stranded prompts',
    async (failures) => {
      const { server, authorize } = await hookApp();
      const install = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'installActivation',
      );
      for (let index = 0; index < failures; index++)
        install.mockRejectedValueOnce(new Error('activation unavailable'));
      const operation = {
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(503);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      if (failures === 2) {
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: PROMPT_ID, payloadDigest })
          .expect(409);
        expect(state.model).not.toHaveBeenCalled();
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        )
          .send(operation)
          .expect(200);
      }
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledOnce();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.SessionStart,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      true,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.SessionStart,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      false,
      true,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.PreToolUse,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      true,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      true,
    ],
    [
      'unrecognized_runtime_error',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
  ] as const)(
    'settles only a cancelled pre-model Hook (%s, %s, reload=%s, modelStarted=%s)',
    async (code, event, reload, modelStarted) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      Object.assign(catalog, {
        hooks: [
          {
            ...catalog.hooks[0],
            eventName: event,
            onceKey: 'submit-once',
          },
        ],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute') {
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        return original.call(this, operation);
      });
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal, modelScope }) => {
          if (modelStarted) await modelScope!.beginMainAttempt('test-model');
          await hooks!.fire(
            event,
            event === HookEventName.SessionStart
              ? `session-start:${SESSION_ID}`
              : event === HookEventName.InstructionsLoaded
                ? `${promptId}:native:${'c'.repeat(64)}:0`
                : promptId!,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      if (reload)
        write.mockImplementation(function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/hooks/operations/${child.operationId}/cancel`,
        ),
      ).expect(reload ? 409 : 200);
      if (reload) {
        const blocked = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(blocked.body.recoveryBlocked).toBe(true);
        write.mockRestore();
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        ).expect(204);
        const replacement = await app(true);
        const loaded = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            ...definition,
            ...(event === HookEventName.UserPromptSubmit
              ? { driveRuntimeRecovery: true }
              : { passiveManagedRuntimeRecovery: true }),
          })
          .expect(200);
        expect(loaded.body.recoveryRequired).toBeUndefined();
        await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId)
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(202);
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(replacement).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        return;
      }
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      if (
        event === HookEventName.PreToolUse ||
        modelStarted ||
        code === 'unrecognized_runtime_error'
      ) {
        expect(status.body.recoveryBlocked).toBe(true);
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(409);
        return;
      }
      expect(status.body.recoveryBlocked).toBe(false);
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send(definition)
        .expect(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
    },
  );

  it.each([
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
      event: HookEventName.UserPromptSubmit,
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
      event: HookEventName.UserPromptSubmit,
    },
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
      event: HookEventName.InstructionsLoaded,
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
      event: HookEventName.InstructionsLoaded,
    },
  ] as const)(
    'settles a turn an evaluation fence parked once the Runtime republishes ($code, $event)',
    async ({ code, outcome, event }) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: event }],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      const republished = new Map<string, ManagedHookOperationView>();
      let fence = true;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute' && fence) {
          fence = false;
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        if (
          (operation.kind === 'hook-status' ||
            operation.kind === 'hook-cancel') &&
          republished.has(operation.targetOperationId)
        )
          return republished.get(operation.targetOperationId)!;
        return original.call(this, operation);
      });
      // The mock stands in for the whole turn body, so fire the Hook from
      // it the way runHostedHarnessTextTurn would. A republished
      // InstructionsLoaded receipt can never carry cancelRequested, so its
      // fence is admitted by its creation inside the parked turn instead.
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal }) => {
          await hooks!.fire(
            event,
            event === HookEventName.InstructionsLoaded
              ? `${promptId}:native:${'c'.repeat(64)}:0`
              : promptId!,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The fenced Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      // Once the evaluation definitively ends the Runtime republishes its
      // receipt, and the next prompt reconciles the fence, settles the parked
      // turn, and is admitted rather than refused for the Session's life.
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      republished.set(child.operationId, {
        operationId: child.operationId,
        state: 'settled',
        result: { success: false, outcome, duration: 0, notStarted: true },
      });
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
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
  );

  it.each([
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
    },
  ] as const)(
    'settles a pre-tool turn an evaluation fence parked once the Runtime republishes ($code)',
    async ({ code, outcome }) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: HookEventName.PreToolUse }],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      const republished = new Map<string, ManagedHookOperationView>();
      let fence = true;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute' && fence) {
          fence = false;
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        if (
          (operation.kind === 'hook-status' ||
            operation.kind === 'hook-cancel') &&
          republished.has(operation.targetOperationId)
        )
          return republished.get(operation.targetOperationId)!;
        return original.call(this, operation);
      });
      const call = {
        name: 'write_file',
        callId: 'call-0',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      // The assistant message commits before the PreToolUse Hook fences, so
      // the parked turn is the pre-tool arm's, never the pre-model one's.
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, modelScope }) => {
          const complete = await modelScope!.beginMainAttempt('test-model');
          await complete(true, []);
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
          throw new Error('The fenced Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'write notes' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      // Once the evaluation definitively ends the Runtime republishes its
      // receipt, and the next prompt reconciles the fence, settles the
      // parked turn, and is admitted rather than refused for the Session's
      // life — the pre-model arm's contract, applied to the pre-tool arm.
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      republished.set(child.operationId, {
        operationId: child.operationId,
        state: 'settled',
        result: { success: false, outcome, duration: 0, notStarted: true },
      });
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
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
  );

  it.each([
    'single',
    'batch',
    'result-write-failure',
    'result-ack-failure',
    'terminal-write-failure',
    'reload',
    'unknown',
    'unfinished-model',
    'wrong-prompt',
    'wrong-call',
    'large-batch',
    'large-batch-partial',
    'large-batch-reload',
    'large-batch-utf8',
  ])(
    'recovers only proven-unstarted cancelled PreToolUse (%s)',
    async (mode) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      const large = mode.startsWith('large-batch');
      if (large) {
        const actual = await vi.importActual<
          typeof import('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js')
        >(
          '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
        );
        const bounded = actual.createHttpManagedSessionStores({
          baseUrl: 'http://127.0.0.1:8080',
          writerId: BOOT_ID,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        }).resourceStore;
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(async function (
          this: LocalManagedSessionResourceStore,
          kind,
          bytes,
        ) {
          await bounded.publish(kind, bytes);
          return publish.call(this, kind, bytes);
        });
      }
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: HookEventName.PreToolUse }],
      });
      if (mode.startsWith('wrong-')) {
        const fire = HostedHookSession.prototype.fire;
        vi.spyOn(HostedHookSession.prototype, 'fire').mockImplementation(
          function (
            this: HostedHookSession,
            event,
            operationId,
            input,
            ...rest
          ) {
            return fire.call(
              this,
              event,
              operationId,
              {
                ...input,
                ...(event === HookEventName.PreToolUse
                  ? mode === 'wrong-prompt'
                    ? { prompt_id: randomUUID() }
                    : { tool_use_id: 'different-call' }
                  : {}),
              },
              ...rest,
            );
          },
        );
      }
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      control.mockImplementation(async (operation) => {
        if (operation.kind !== 'hook-execute') return original(operation);
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: {
            code:
              mode === 'unknown'
                ? 'unrecognized_runtime_error'
                : 'managed_hook_handler_unavailable',
          },
        };
      });
      const calls = Array.from(
        { length: large ? 650 : mode === 'single' ? 1 : 2 },
        (_, i) => ({
          name: large ? 'read_file' : 'write_file',
          callId: mode === 'large-batch-utf8' ? `调用-${i}` : `call-${i}`,
          args: large
            ? { file_path: 'x' }
            : { file_path: `notes-${i}.txt`, content: 'hello' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        }),
      );
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, modelScope }) => {
          const complete = await modelScope!.beginMainAttempt('test-model');
          if (mode !== 'unfinished-model') await complete(true, []);
          await toolTurn!.execute(
            calls,
            calls.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
      const prompt = [{ type: 'text', text: 'write notes' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      const reload = mode === 'reload' || mode === 'large-batch-reload';
      const fail =
        mode.includes('failure') || reload || mode === 'large-batch-partial';
      let resultWrites = 0;
      if (fail)
        write.mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (large && record.type === 'tool_result' && ++resultWrites === 2)
            throw new Error('second result write unavailable');
          if (record.type === 'tool_result' && mode.startsWith('result-')) {
            if (mode === 'result-ack-failure')
              await originalWrite.call(this, record);
            throw new Error('result write unavailable');
          }
          if (
            !large &&
            record.subtype === 'turn_result' &&
            !mode.startsWith('result-')
          )
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/hooks/operations/${child.operationId}/cancel`,
        ),
      ).expect(fail ? 409 : 200);
      if (
        fail ||
        mode === 'unknown' ||
        mode === 'unfinished-model' ||
        mode.startsWith('wrong-')
      ) {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(true);
        // The prompt gate re-arms while the Session stays blocked and
        // retries the settle the failed cancel dropped: where the refusal
        // writes already landed durably the retry completes the settlement
        // and admits the prompt, and where the write failure is permanent
        // it refuses again.
        const heals =
          mode === 'result-ack-failure' ||
          mode === 'large-batch-partial' ||
          mode === 'large-batch-reload';
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(heals ? 202 : 409);
        if (large || mode === 'result-ack-failure') {
          const partial = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          );
          const results: ChatRecord[] = partial.body.events.flatMap(
            (event: { data?: { record?: ChatRecord } }) =>
              event.data?.record?.type === 'tool_result'
                ? [event.data.record]
                : [],
          );
          // No call is refused twice: the retry answers only the calls the
          // dropped settle had not already covered durably.
          expect(results).toHaveLength(large ? 2 : 1);
          expect(results[0].message!.parts!.length).toBeGreaterThan(0);
          if (large)
            expect(results[0].message!.parts!.length).toBeLessThan(
              calls.length,
            );
          expect(
            results.flatMap((result) =>
              result.message!.parts!.map((part) => part.functionResponse?.id),
            ),
          ).toEqual(calls.map((call) => call.callId));
          expect(
            partial.body.events.filter(
              (event: { type: string; promptId?: string }) =>
                event.type === 'turn_complete' && event.promptId === PROMPT_ID,
            ),
          ).toHaveLength(1);
        }
        if (heals)
          // The admitted retry prompt runs its own turn; let it finish
          // before the admissions below race its active Turn.
          await vi.waitFor(
            async () => {
              const settled = await authorize(
                supertest(server).get(`/session/${SESSION_ID}/status`),
              );
              expect(settled.body.hasActivePrompt).toBe(false);
            },
            { timeout: settleTimeoutMs() },
          );
        if (!fail) return;
      }
      write.mockRestore();
      let owner = authorize;
      let recovered = server;
      if (reload) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        ).expect(204);
        recovered = await app(true);
        const loaded = await headers(
          supertest(recovered).post(`/session/${SESSION_ID}/load`),
        )
          .send(definition)
          .expect(200);
        expect(loaded.body.recoveryRequired).toBeUndefined();
        owner = (request) =>
          headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      } else {
        await Promise.all(
          [0, 1].map(() =>
            owner(
              supertest(recovered).get(
                `/session/${SESSION_ID}/hooks/operations/${child.operationId}`,
              ),
            ).expect(200),
          ),
        );
      }
      const status = await owner(
        supertest(recovered).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      const transcript = await owner(
        supertest(recovered).get(`/session/${SESSION_ID}/transcript`),
      );
      const records: ChatRecord[] = transcript.body.events.flatMap(
        (event: { data?: { record?: ChatRecord } }) =>
          event.data?.record ? [event.data.record] : [],
      );
      const responses = records.flatMap(
        (record) =>
          record.message?.parts?.flatMap((part) =>
            part.functionResponse ? [part.functionResponse] : [],
          ) ?? [],
      );
      if (large) {
        const results = records.filter(
          (record) => record.type === 'tool_result',
        );
        expect(results).toHaveLength(2);
        for (const record of results)
          expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
            64 * 1024,
          );
        const assistant = records.find(
          (record) => record.type === 'assistant',
        )!;
        expect(results[0].parentUuid).toBe(assistant.uuid);
        expect(results[1].parentUuid).toBe(results[0].uuid);
        expect(
          Buffer.byteLength(JSON.stringify(assistant)),
        ).toBeLessThanOrEqual(64 * 1024);
        expect(
          Buffer.byteLength(
            JSON.stringify({
              ...results[0],
              message: {
                role: 'user',
                parts: results.flatMap((record) => record.message!.parts!),
              },
            }),
          ),
        ).toBeGreaterThan(64 * 1024);
      }
      expect(responses).toEqual(
        calls.map((call) => ({
          id: call.callId,
          name: call.name,
          response: { error: expect.stringContaining('cancelled') },
        })),
      );
      expect(
        transcript.body.events.filter(
          (event: { type: string; promptId?: string }) =>
            event.type === 'turn_complete' && event.promptId === PROMPT_ID,
        ),
      ).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(
        requests.filter((entry) => entry.kind === 'hook-execute'),
      ).toHaveLength(1);
      await owner(supertest(recovered).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await owner(
            supertest(recovered).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      await owner(
        supertest(recovered).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([HookEventName.SessionStart, HookEventName.InstructionsLoaded])(
    'does not settle a later turn from a previously cancelled %s',
    async (event) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: event }],
      });
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      control.mockImplementation(async (operation) => {
        if (operation.kind !== 'hook-execute') return original(operation);
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_hook_handler_unavailable' },
        };
      });
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal }) => {
          await hooks!.fire(
            event,
            event === HookEventName.SessionStart
              ? `session-start:${SESSION_ID}`
              : `${promptId}:native:${'c'.repeat(64)}:0`,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const submit = (promptId: string) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId,
            payloadDigest,
          },
        );
      const expectBlocked = () =>
        vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: true,
            });
          },
          { timeout: settleTimeoutMs() },
        );
      await submit(PROMPT_ID).expect(202);
      await expectBlocked();
      const child = requests.find(
        (operation) => operation.kind === 'hook-execute',
      )!;
      const route = `/session/${SESSION_ID}/hooks/operations/${child.operationId}`;
      await authorize(supertest(server).post(`${route}/cancel`)).expect(200);

      state.model.mockRejectedValueOnce(new HostedHookRecoveryRequiredError());
      await submit(randomUUID()).expect(202);
      await expectBlocked();
      await authorize(supertest(server).get(route)).expect(200);
      await submit(randomUUID()).expect(409);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send(definition)
        .expect(200);
      expect(loaded.body.recoveryRequired).toBe(true);
      expect(
        requests.filter((operation) => operation.kind === 'hook-execute'),
      ).toHaveLength(1);
    },
  );

  it.each([
    undefined,
    'managed-hook-message-chunks',
    'managed-hook-message-part',
  ])(
    'restores the saved Hook pin and verifies its message closure (missing: %s)',
    async (missingKind) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], config: { type: 'function' } }],
      });
      for (let index = 0; index < 2; index++) {
        const prompt = [{ type: 'text', text: 'x'.repeat(40 * 1024) }];
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      }
      const operation = {
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(200);
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/registrations`),
      )
        .send({
          operationId: randomUUID(),
          expectedRevision: 1,
          catalog: { ...hookPin, catalogRevision: 2 },
        })
        .expect(200);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          hookCatalog: { ...hookPin, catalogRevision: 2 },
        })
        .expect(409);
      if (missingKind) {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const damaged = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            return ref.kind === missingKind
              ? Promise.reject(new Error('missing Hook snapshot resource'))
              : read.call(this, ref);
          });
        const refused = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(refused.body.reason).toBe('restore_verification_failed');
        damaged.mockRestore();
      }
      const reads = new Map<string, { kind: string; count: number }>();
      const read = LocalManagedSessionResourceStore.prototype.read;
      const counted = vi
        .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
        .mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          ref,
        ) {
          if (ref.kind.startsWith('managed-hook')) {
            const entry = reads.get(ref.resourceId);
            reads.set(ref.resourceId, {
              kind: ref.kind,
              count: (entry?.count ?? 0) + 1,
            });
          }
          return read.call(this, ref);
        });
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      counted.mockRestore();
      expect(loaded.status).toBe(200);
      // The load verified every Hook record, input, result and message part
      // once, however many revisions name it. A plan is read again to walk
      // its message snapshot.
      expect(reads.size).toBeGreaterThan(10);
      expect(
        [...reads.values()].filter(
          ({ kind, count }) => count !== (kind === 'managed-hook-plan' ? 2 : 1),
        ),
      ).toEqual([]);
      const restored = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      await restored(
        supertest(replacement).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(200);
      const current = await restored(
        supertest(replacement).get(`/session/${SESSION_ID}/hooks`),
      );
      expect(current.body.catalog.catalogRevision).toBe(2);
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      expect(state.model).toHaveBeenCalledTimes(2);
      await restored(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('finishes a stopped Hook turn after its final settlement write is lost', async () => {
    const { server, authorize, definition, catalog, requests } =
      await hookApp();
    Object.assign(catalog, {
      hooks: [
        {
          ...catalog.hooks[0],
          hookId: 'stop-after-tools',
          eventName: HookEventName.PostToolBatch,
        },
      ],
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const originalControl = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      const response = await originalControl(operation);
      return operation.kind === 'hook-execute'
        ? {
            ...response,
            result: {
              success: true,
              outcome: 'success' as const,
              duration: 0,
              output: { continue: false, stopReason: 'Stopped after tools.' },
            },
          }
        : response;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'original result' }],
      });
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failFinalSettlement = true;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.subtype === 'turn_result' && failFinalSettlement)
          throw new Error('lost final settlement');
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'stopped-call',
        args: { file_path: 'a' },
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
      expect(toolTurn!.hookStopReason).toBe('Stopped after tools.');
      return { text: toolTurn!.hookStopReason!, model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
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
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const checkpoint = saved.events.findLast(
      (event) => event.kind === 'checkpoint.committed',
    )!;
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const savedState = JSON.parse(
      (
        await resources.read(
          assertManagedSessionDurableRef(
            checkpoint.payload['stateRef'],
            'checkpoint',
          ),
        )
      ).toString(),
    );
    expect(savedState.continuation.phase).toBe('turn_settled');
    expect(savedState.tools.items).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    expect(saved.events.some((event) => event.kind === 'turn.settled')).toBe(
      false,
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
    failFinalSettlement = false;
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send(definition);
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).not.toBe(true);
    const restored = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    await vi.waitFor(
      async () => {
        const status = await restored(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await restored(
      supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_complete',
      ),
    ).toHaveLength(1);
    expect(state.model).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(
      requests.filter((operation) => operation.kind === 'hook-execute'),
    ).toHaveLength(1);
    await restored(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: randomUUID(), payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await restored(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await restored(
      supertest(replacement).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it.each([false, true])(
    'reports and clears the unknown Hook fence (reload: %s)',
    async (reload) => {
      const append = vi.spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      );
      const { server, authorize, requests, release, definition } =
        await hookApp();
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      let known = false;
      control.mockImplementation(async (operation) => {
        if (operation.kind === 'hook-catalog') return original(operation);
        requests.push(operation);
        const operationId =
          operation.kind === 'hook-status' || operation.kind === 'hook-cancel'
            ? operation.targetOperationId
            : operation.operationId;
        return known
          ? {
              operationId,
              state: 'settled',
              result: { success: true, outcome: 'success', duration: 0 },
            }
          : { operationId, state: 'outcome_unknown' };
      });
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const operationId = randomUUID();
      const send = (id: string) =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        ).send({
          operationId: id,
          event: 'Notification',
          input: { message: 'effect', notification_type: 'test' },
        });
      const unknown = await send(operationId);
      expect(unknown.status).toBe(503);
      expect(unknown.body.code).toBe('hosted_hook_operation_failed');
      expect((await send(randomUUID())).status).toBe(409);
      const replay = await send(operationId);
      expect(replay.status).toBe(503);
      expect(replay.body.code).toBe('hosted_hook_operation_failed');
      const blocked = `qwen serve: Hosted Hook operation ${operationId} is recovery blocked: Error: Hosted Hook requires reconciliation of its original execution.`;
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) => line.includes('Hosted Hook operation')),
      ).toEqual([blocked, blocked]);
      expect(
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body.recoveryBlocked,
      ).toBe(true);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(503);
      expect(release).not.toHaveBeenCalled();
      let current = server;
      let owner = authorize;
      if (reload) {
        await (
          append.mock.contexts[0] as LocalJsonlManagedSessionJournalHandle
        ).abort();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000);
        current = await app(true);
        const loaded = await headers(
          supertest(current).post(`/session/${SESSION_ID}/load`),
        )
          .send(definition)
          .expect(200);
        expect(loaded.body.recoveryRequired).toBe(true);
        owner = (request) =>
          headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      }
      expect(
        (await owner(supertest(current).get(`/session/${SESSION_ID}/status`)))
          .body.recoveryBlocked,
      ).toBe(true);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const submit = () =>
        owner(supertest(current).post(`/session/${SESSION_ID}/prompt`)).send({
          prompt,
          promptId: randomUUID(),
          payloadDigest,
        });
      await submit().expect(409);
      expect(state.model).not.toHaveBeenCalled();
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      known = true;
      await owner(
        supertest(current).get(
          `/session/${SESSION_ID}/hooks/operations/${operationId}`,
        ),
      ).expect(200);
      expect(
        (await owner(supertest(current).get(`/session/${SESSION_ID}/status`)))
          .body.recoveryBlocked,
      ).toBe(false);
      await submit().expect(202);
      await vi.waitFor(
        async () => {
          const status = await owner(
            supertest(current).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledOnce();
      await owner(
        supertest(current).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('logs the cause of a failed Hook operation before answering 503', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'installActivation',
    ).mockRejectedValueOnce(new Error('activation unavailable'));
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const operationId = randomUUID();
    const failed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId,
      event: 'Notification',
      input: { message: 'ready', notification_type: 'test' },
    });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('hosted_hook_operation_failed');
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Hook operation ${operationId} failed: Error: activation unavailable`,
    );
  });

  it('settles End and Delete before releasing the Hook Runtime', async () => {
    const { server, authorize, requests, release } = await hookApp();
    const order: string[] = [];
    const released: Array<[string, boolean]> = [];
    release.mockImplementation(async function (this: HostedWorkspaceBroker) {
      released.push([this.runtimeSessionId, Boolean(this.runtime)]);
      if (this.runtime) order.push('release');
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        order.push(operation.input.hook_event_name);
      return original(operation);
    });
    expect(
      (await authorize(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    expect(order).toEqual(['SessionEnd', 'SessionDelete', 'release']);
    // Both Hook operations replaced the load activation and restored it;
    // neither names an earlier owner, so only this load's Runtime is released.
    expect(released).toEqual([
      [expect.stringMatching(/^hooks-activation-/), true],
    ]);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input),
    ).toEqual([
      expect.objectContaining({
        hook_event_name: 'SessionEnd',
        reason: 'other',
      }),
      expect.objectContaining({
        hook_event_name: 'SessionDelete',
        deleted_session_id: SESSION_ID,
      }),
    ]);
  });

  it('logs a failed Session deletion and keeps the Session usable', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'installActivation',
    ).mockRejectedValueOnce(new Error('activation unavailable'));
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Session ${SESSION_ID} close failed: Error: activation unavailable`,
    );
    // The busy guards run before body validation, so an empty prompt shows
    // the deletion cleared its Hook flag.
    const prompt = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({});
    expect(prompt.status).toBe(400);
    expect(prompt.body.code).toBe('invalid_hosted_prompt');
    expect(
      (await authorize(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('deregisters the Session when the close sealed the writer but the release failed', async () => {
    // A plain Session (no hooks): the close reaches managed.close()
    // directly, so the boundary release fails inside it, after its finally
    // sealed the writer (review round 11, R11-3).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'releaseActivation',
    ).mockRejectedValue(new Error('resource store unavailable'));
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    // The sealed-but-rejected session is deregistered: a follow-up gets a
    // clean 404 instead of a stranded entry answering against a dead
    // journal. A retried DELETE does not re-run the release either.
    const followUp = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(followUp.status).toBe(404);
    expect(followUp.body.code).toBe('hosted_session_not_found');
  });

  it('keeps the Session when the close rejected before the writer seal landed', async () => {
    // A pre-seal seal() rejection leaves the writer open: the Session must
    // stay registered so a retry can reach it (review round 13, R13-1).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockRejectedValue(new Error('seal candidate already exists'));
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    // The pre-seal rejection keeps the Session: a follow-up DELETE reaches
    // the same entry and fails the same way instead of answering 404.
    const followUp = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(followUp.status).toBe(503);
    expect(followUp.body.code).toBe('managed_session_close_failed');
  });

  it('names a retained Hook hold when DELETE cannot release its owner', async () => {
    const { server, authorize, release } = await hookApp();
    release.mockImplementation(async () => {
      throw new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_owner_hold_pending',
      );
    });
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    // The generic close code would hide that the Session is still attached
    // because its Hook owner holds unfinished work.
    expect(failed.body.code).toBe('hosted_hook_recovery_required');
    const retry = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(retry.status).toBe(503);
    expect(retry.body.code).toBe('hosted_hook_recovery_required');
  });

  it('keeps the wake pump of a Session its refused DELETE kept alive', async () => {
    domainEnablement.monitorRun = true;
    const { server, authorize, release } = await hookApp(
      'hosted-workspace-shell/1',
    );
    const wakeClose = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'close');
    release.mockImplementation(async () => {
      throw new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_owner_hold_pending',
      );
    });
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('hosted_hook_recovery_required');
    // The Session stays attached and fully served — and its wake pump with
    // it: tearing the scheduler down before the Hook close was known
    // terminal would leave the kept Session never delivering a wake turn.
    expect(
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .status,
    ).toBe(200);
    expect(wakeClose).not.toHaveBeenCalled();
    release.mockResolvedValue();
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    expect(wakeClose).toHaveBeenCalledOnce();
  });

  it('bounds the prompt-gate reconcile so a stalled Runtime cannot hold the route', async () => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    expect(
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .body.recoveryBlocked,
    ).toBe(true);
    // The poll that never answers: only the route's own budget can end it.
    let statusSeen!: () => void;
    const firstStatus = new Promise<void>((resolve) => {
      statusSeen = resolve;
    });
    control.mockImplementation(async (operation) => {
      if (
        operation.kind === 'hook-status' ||
        operation.kind === 'hook-cancel'
      ) {
        statusSeen();
        return new Promise<ManagedHookOperationView>(() => {});
      }
      return original(operation);
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    // Only the reconcile budget's timer is faked — faking setImmediate too
    // would stall the request itself before the poll begins.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A supertest request fires on the first then: attach it now or the
      // poll below would wait on a request that was never sent.
      const posted = authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .send({
          prompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .then((response) => response);
      await firstStatus;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await posted;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('hosted_turn_recovery_required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the prompt-gate reconcile when the prompting client disconnects', async () => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    // The poll that never answers: only the client's own disconnect ends the
    // reconcile ahead of its budget here.
    let statusSeen!: () => void;
    const firstStatus = new Promise<void>((resolve) => {
      statusSeen = resolve;
    });
    control.mockImplementation(async (operation) => {
      if (
        operation.kind === 'hook-status' ||
        operation.kind === 'hook-cancel'
      ) {
        statusSeen();
        return new Promise<ManagedHookOperationView>(() => {});
      }
      return original(operation);
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const prompt = [{ type: 'text', text: 'hello' }];
    const posted = authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    // A supertest request fires on the first then: attach it before the
    // abort, or the poll below waits on a request that was never sent.
    const answered = posted.then(
      (response) => response,
      (cause: unknown) => cause,
    );
    await firstStatus;
    posted.abort();
    await answered;
    // The disconnect reaches the reconcile as its abort reason and is
    // logged, and the pass releases hooksBusy instead of holding every
    // other route at 409 for the rest of the budget.
    await vi.waitFor(
      () => {
        expect(stderr.mock.calls.flat().join('\n')).toContain(
          'The prompting client disconnected.',
        );
      },
      { timeout: settleTimeoutMs() },
    );
    control.mockImplementation(original);
    const deleted = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(deleted.body?.code).not.toBe('hosted_turn_active');
  });

  it('retries a settle the reconcile pass dropped once nothing is pending', async () => {
    const { server, authorize, catalog, requests } = await hookApp();
    Object.assign(catalog, {
      hooks: [
        { ...catalog.hooks[0], eventName: HookEventName.UserPromptSubmit },
      ],
    });
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
    const original = control.getMockImplementation()!;
    const republished = new Map<string, ManagedHookOperationView>();
    let fence = true;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'hook-execute' && fence) {
        fence = false;
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_hook_module_evaluation_abandoned' },
        };
      }
      if (
        (operation.kind === 'hook-status' ||
          operation.kind === 'hook-cancel') &&
        republished.has(operation.targetOperationId)
      )
        return republished.get(operation.targetOperationId)!;
      return original.call(this, operation);
    });
    state.model.mockImplementationOnce(async ({ hooks, promptId, signal }) => {
      await hooks!.fire(
        HookEventName.UserPromptSubmit,
        promptId!,
        { prompt_id: promptId },
        signal,
      );
      throw new Error('The fenced Hook must stop this turn.');
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      },
      { timeout: settleTimeoutMs() },
    );
    const child = requests.find((entry) => entry.kind === 'hook-execute')!;
    republished.set(child.operationId, {
      operationId: child.operationId,
      state: 'settled',
      result: {
        success: false,
        outcome: 'cancelled',
        duration: 0,
        notStarted: true,
      },
    });
    // The client disconnects the moment the poll's first record commit
    // lands: the reconcile drains the pending records, but the aborted
    // signal drops the settle at its first checkpoint, leaving the Session
    // blocked with nothing pending.
    let cut = false;
    let posted: supertest.Test | undefined;
    const commit = LocalManagedSessionAuthority.prototype.commitExtensionRecord;
    const commits = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'commitExtensionRecord')
      .mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        const receipt = await commit.apply(this, args);
        if (!cut && args[1].domain === 'hook_execution') {
          cut = true;
          posted?.abort();
        }
        return receipt;
      });
    try {
      posted = authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({ prompt, promptId: randomUUID(), payloadDigest });
      const answered = posted.then(
        (response) => response,
        (cause: unknown) => cause,
      );
      await answered;
      // Both the parked record and its marker must finish committing before
      // the next prompt, or the pending gate would re-arm on its own.
      await vi.waitFor(
        () => {
          expect(
            commits.mock.calls.filter(
              ([, request]) => request.domain === 'hook_execution',
            ),
          ).toHaveLength(2);
        },
        { timeout: settleTimeoutMs() },
      );
    } finally {
      commits.mockRestore();
    }
    const blocked = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(blocked.body.recoveryBlocked).toBe(true);
    // The gate re-arms on the still-blocked Session, retries the dropped
    // settle, and the prompt is admitted rather than refused for life.
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: randomUUID(), payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('answers an invalid prompt on a fenced Session without reconciling first', async () => {
    const { server, authorize, requests } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    const statusPolls = () =>
      requests.filter((request) => request.kind === 'hook-status').length;
    const before = statusPolls();
    const rejected = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({});
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('invalid_hosted_prompt');
    // A request the validation refuses never pays a Runtime poll or a
    // durable settle write.
    expect(statusPolls()).toBe(before);
    const transcript = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_complete',
      ),
    ).toHaveLength(0);
  });

  it('pins dynamic Hook revisions and rejects unscoped operations', async () => {
    const { server, authorize } = await hookApp();
    const operationId = randomUUID();
    const route = `/session/${SESSION_ID}/hooks/registrations`;
    const catalog = { ...hookPin, catalogRevision: 2 };
    expect(
      (
        await headers(supertest(server).post(route)).send({
          operationId,
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await authorize(supertest(server).post(route)).send({
          operationId,
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(200);
    const current = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/hooks`),
    );
    expect(current.body.catalog.catalogRevision).toBe(2);
    expect(JSON.stringify(current.body)).not.toContain('"config"');
    expect(
      (
        await authorize(supertest(server).post(route)).send({
          operationId: randomUUID(),
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(409);
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
  });
});
