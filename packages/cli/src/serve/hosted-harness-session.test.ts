/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import type { HostedFileHistoryState } from './hosted-file-history-protocol.js';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
} from './hosted-hook-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';
import {
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_APPROVAL_TIMEOUT_MS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';

const state = vi.hoisted(() => ({
  root: '',
  assertWritable: vi.fn(async () => undefined),
  toolResults: null as DurableToolResultResourceStore | null,
  publicationRequest: vi.fn(),
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
      hooks?: import('./hosted-hook-session.js').HostedHookSession;
      promptId?: string;
      modelScope?: import('@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js').ManagedHookModelScope;
      resumeFromToolResults?: readonly unknown[];
    }) => ({
      text: 'hello back',
      model: 'test-model',
    }),
  ),
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  () => ({
    HTTP_MANAGED_SESSION_STORE_CONTRACT: { maxInlineResourceBytes: 64 * 1024 },
    createHttpManagedSessionStores: (options: {
      sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
    }) => {
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      });
      return {
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: options.sessionKey.sessionId,
          transcriptPath: path.join(
            state.root,
            `${options.sessionKey.sessionId}.jsonl`,
          ),
        }),
        resourceStore,
        toolResultResources: state.toolResults ?? resourceStore,
        assertWritable: state.assertWritable,
        publication: {
          owner: async () => ({ writerId: BOOT_ID, writerGeneration: 1 }),
          request: (route: string, body: unknown, token?: string) =>
            state.publicationRequest(resourceStore, route, body, token),
          rememberAdmission: () => undefined,
        },
        close: async () => undefined,
      };
    },
  }),
);
vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: state.model,
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';

const listeners = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...listeners].map(
      (listener) =>
        new Promise<void>((resolve) => {
          listener.close(() => resolve());
          listener.closeAllConnections();
        }),
    ),
  );
  listeners.clear();
});

async function app(withBroker = false) {
  const result = express();
  result.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
  );
  installHostedHarnessContractMiddleware(result, contract);
  registerHostedHarnessSessionRoutes(
    result,
    contract,
    state.root,
    withBroker ? { baseUrl: 'http://127.0.0.1:1', token: 'test' } : undefined,
  );
  const listener = createServer(result);
  listeners.add(listener);
  // Match supertest's IPv4 URL; wildcard IPv6 can share an unrelated IPv4 port.
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  return listener;
}

function headers<T extends supertest.Test>(request: T): T {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID);
}

function store() {
  return {
    baseUrl: 'http://store.test',
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: BOOT_ID,
    leaseDurationMs: 60_000,
  };
}

async function mcpApp(unknownConfigure = false, serverIds = ['demo']) {
  const requests: ManagedMcpControl[] = [];
  const replies = new Map<string, ManagedMcpOperationView>();
  const brokerOwners = new Set<string>();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      brokerOwners.add(this.runtimeSessionId);
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'control').mockImplementation(
    async function (this: HostedWorkspaceBroker, operation) {
      if (!brokerOwners.has(this.runtimeSessionId))
        throw new Error('Runtime Session is not active in this Broker process');
      requests.push(operation);
      if (operation.kind === 'mcp-status' || operation.kind === 'mcp-cancel')
        return (
          replies.get(operation.targetOperationId) ?? {
            operationId: operation.targetOperationId,
            state: 'outcome_unknown',
          }
        );
      if (operation.kind === 'mcp-configure') {
        const settled: ManagedMcpOperationView = {
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
            resources: [{ name: 'note', uri: 'memory://note' }],
            prompts: [{ name: 'greet' }],
            discovery: {
              tools: 'complete',
              resources: 'complete',
              prompts: 'complete',
            },
          },
        };
        replies.set(operation.operationId, settled);
        return unknownConfigure
          ? { operationId: operation.operationId, state: 'outcome_unknown' }
          : settled;
      }
      if (operation.kind === 'mcp-discover')
        return {
          ...replies.get(operation.grant.operationId)!,
          operationId: operation.operationId,
        };
      return (
        replies.get(operation.operationId) ?? {
          operationId: operation.operationId,
          state: 'settled',
          response: { contents: [] },
        }
      );
    },
  );
  const server = await app(true);
  const created = await headers(supertest(server).post('/session')).send({
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    toolProfile: 'hosted-workspace-mcp/1',
    mcpServers: serverIds.map((serverId) => ({
      serverId,
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    })),
  });
  expect(created.status).toBe(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
  return { server, authorize, requests, replies, brokerOwners };
}

const hookPin = {
  catalogId: 'test',
  catalogRevision: 1,
  definitionDigest: 'b'.repeat(64),
};
async function hookApp() {
  const requests: ManagedHookControl[] = [];
  const catalog: ManagedHookCatalog = {
    ...hookPin,
    hooks: [
      HookEventName.Notification,
      HookEventName.SessionEnd,
      HookEventName.SessionDelete,
    ].map((eventName) => ({
      hookId: eventName,
      eventName,
      sequential: false,
      async: false,
      failClosed: true,
      onceKey: null,
      config: { type: 'command' as const },
    })),
  };
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
  const release = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'release')
    .mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
    async (operation) => {
      requests.push(operation);
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...catalog, ...operation.pin },
        };
      return {
        operationId: operation.operationId,
        state: 'settled',
        result: {
          success: true,
          outcome: 'success',
          duration: 0,
          output: { hookSpecificOutput: { additionalContext: 'checked' } },
        },
      };
    },
  );
  const server = await app(true);
  const definition = {
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    toolProfile: 'hosted-workspace-files/1',
    approvalMode: 'yolo',
    hookCatalog: hookPin,
  };
  const created = await headers(supertest(server).post('/session')).send(
    definition,
  );
  expect(created.status).toBe(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId);
  return { server, authorize, definition, catalog, requests, release };
}

describe('Hosted Harness no-tool session', () => {
  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.toolResults = null;
    state.assertWritable.mockReset();
    state.assertWritable.mockResolvedValue(undefined);
    state.model.mockReset();
    state.publicationRequest.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  it('refuses a new prompt while the journal close is still sealing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalJsonlManagedSessionJournalHandle.prototype.seal;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockImplementation(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      commit,
    ) {
      entered();
      await gate;
      await original.call(this, commit);
    });
    const closing = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    await started;
    try {
      const prompt = [{ type: 'text', text: 'late input' }];
      const rejected = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('hosted_session_closing');
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await closing).status).toBe(204);
  });

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
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
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
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      });
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
        await vi.waitFor(async () => {
          const status = await headers(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        });
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
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
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
          baseUrl: 'http://store.test',
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
        { timeout: 10_000 },
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
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(409);
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
          expect(results).toHaveLength(1);
          expect(results[0].message!.parts!.length).toBeGreaterThan(0);
          if (large)
            expect(results[0].message!.parts!.length).toBeLessThan(
              calls.length,
            );
          else
            expect(
              results[0].message!.parts!.map(
                (part) => part.functionResponse?.id,
              ),
            ).toEqual(calls.map((call) => call.callId));
          expect(
            partial.body.events.filter(
              (event: { type: string }) => event.type === 'turn_complete',
            ),
          ).toHaveLength(0);
        }
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
          (event: { type: string }) => event.type === 'turn_complete',
        ),
      ).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(
        requests.filter((entry) => entry.kind === 'hook-execute'),
      ).toHaveLength(1);
      await owner(supertest(recovered).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(async () => {
        const status = await owner(
          supertest(recovered).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
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
          { timeout: 10_000 },
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
        await vi.waitFor(async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        });
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
      { timeout: 10_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
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
      { timeout: 10_000 },
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
      { timeout: 10_000 },
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
        { timeout: 10_000 },
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

  it('refuses file history APIs on the MCP profile without blocking its session', async () => {
    const { server, authorize } = await mcpApp();
    const history = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    );
    expect(history.status).toBe(409);
    expect(history.body.code).toBe('hosted_file_history_unavailable');
    const undo = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('hosted_file_history_unavailable');
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it.each([false, true])(
    'unblocks MCP resource requests after the original unknown operation settles (Broker restarted: %s)',
    async (restartBroker) => {
      const { server, authorize, requests, replies, brokerOwners } =
        await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const send = (id: string) =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: id,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await send(operationId)).body.state).toBe('outcome_unknown');
      const status = () =>
        authorize(supertest(server).get(`/session/${SESSION_ID}/status`));
      expect((await status()).body.recoveryBlocked).toBe(true);
      expect((await send(randomUUID())).status).toBe(409);
      const prompt = [{ type: 'text', text: 'blocked by raw operation' }];
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/prompt`),
          ).send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
        ).status,
      ).toBe(409);
      expect(state.model).not.toHaveBeenCalled();

      const settled: ManagedMcpOperationView = {
        operationId,
        state: 'settled',
        response: { contents: [{ uri: 'memory://note', text: 'late result' }] },
      };
      replies.set(operationId, settled);
      const originalOwner = [...brokerOwners][0];
      if (restartBroker) brokerOwners.clear();
      const recovered = await authorize(
        supertest(server).get(
          `/session/${SESSION_ID}/mcp/operations/${operationId}`,
        ),
      );
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(settled);
      expect([...brokerOwners]).toEqual([originalOwner]);
      expect((await status()).body.recoveryBlocked).toBe(false);
      const next = await send(randomUUID());
      expect(next.status).toBe(202);
      expect(next.body.state).toBe('settled');
      expect(
        requests.filter((request) => request.kind === 'mcp-invoke'),
      ).toHaveLength(2);
      expect(
        requests.filter((request) => request.kind === 'mcp-configure'),
      ).toHaveLength(1);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['cancel', 'deadline'] as const)(
    'stops first-prompt MCP initialization after %s without admitting input or configuring another server',
    async (ending) => {
      const { server, authorize, requests, replies } = await mcpApp(false, [
        'demo',
        'second',
      ]);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let configurationId: string | undefined;
      let returned = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        const response = await original.call(this, operation);
        if (
          operation.kind === 'mcp-configure' &&
          operation.serverId === 'demo'
        ) {
          configurationId = operation.operationId;
          replies.set(configurationId, {
            operationId: configurationId,
            state: 'outcome_unknown',
          });
          await pending;
          replies.set(configurationId, response);
          returned = true;
        }
        return response;
      });
      const prompt = [{ type: 'text', text: 'cancel initial discovery' }];
      const send = (id: string, deadlineMs?: number) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: id,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
          },
        );
      let response: supertest.Response | undefined;
      const submitted = send(
        PROMPT_ID,
        ending === 'deadline' ? 1000 : undefined,
      ).then((value) => {
        response = value;
      });
      try {
        await vi.waitFor(() => expect(configurationId).toBeDefined());
        if (ending === 'cancel')
          expect(
            (
              await authorize(
                supertest(server).post(`/session/${SESSION_ID}/cancel`),
              )
            ).status,
          ).toBe(204);
        await vi.waitFor(() => expect(response).toBeDefined(), {
          timeout: 3000,
        });
        expect(response!.status).toBe(503);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(admit).not.toHaveBeenCalled();
        expect(state.model).not.toHaveBeenCalled();
        expect((await send(randomUUID())).body.error).toBe(
          'hosted_mcp_recovery_required',
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(503);
        finish();
        await vi.waitFor(() => expect(returned).toBe(true));
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo']);
        expect(admit).not.toHaveBeenCalled();
        expect((await send(randomUUID())).status).toBe(202);
        await vi.waitFor(async () =>
          expect(
            (
              await authorize(
                supertest(server).get(`/session/${SESSION_ID}/status`),
              )
            ).body.hasActivePrompt,
          ).toBe(false),
        );
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo', 'second']);
        expect(state.model).toHaveBeenCalledOnce();
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finish();
        await submitted;
        await vi.waitFor(async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.status === 404 || !status.body.hasActivePrompt).toBe(
            true,
          );
        });
        await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('does not admit input when cancellation arrives during publication after MCP initialization', async () => {
    const { server, authorize } = await mcpApp();
    const original = LocalManagedSessionResourceStore.prototype.publish;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let publishing = false;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      ...args
    ) {
      const result = await original.apply(this, args);
      if (args[0] === 'managed-input') {
        publishing = true;
        await pending;
      }
      return result;
    });
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'cancel before input admission' }];
    const submitted = authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(publishing).toBe(true));
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/cancel`),
          )
        ).status,
      ).toBe(204);
      finish();
      expect((await submitted).status).toBe(503);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      finish();
      await submitted;
    }
  });

  it.each(['status', 'cancel'] as const)(
    'serves MCP %s during dispatch and keeps admissions fenced until both finish',
    async (kind) => {
      const { server, authorize, requests, replies } = await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let finishInvoke!: () => void;
      let finishRecovery!: () => void;
      const invoking = new Promise<void>((resolve) => {
        finishInvoke = resolve;
      });
      const recovering = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      let invokeStarted = false;
      let recoveryStarted = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'mcp-invoke') {
          invokeStarted = true;
          await invoking;
        }
        if (
          operation.kind === (kind === 'status' ? 'mcp-status' : 'mcp-cancel')
        ) {
          recoveryStarted = true;
          await recovering;
        }
        return original.call(this, operation);
      });
      const invoke = authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .then((response) => response);
      let recovery: Promise<supertest.Response> | undefined;
      try {
        await vi.waitFor(() => expect(invokeStarted).toBe(true));
        const url = `/session/${SESSION_ID}/mcp/operations/${operationId}`;
        recovery = authorize(
          kind === 'status'
            ? supertest(server).get(url)
            : supertest(server).post(`${url}/cancel`),
        ).then((response) => response);
        await vi.waitFor(() => expect(recoveryStarted).toBe(true));
        finishInvoke();
        expect((await invoke).status).toBe(202);
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(409);
        const prompt = [{ type: 'text', text: 'still recovering' }];
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/prompt`),
            ).send({
              prompt,
              promptId: PROMPT_ID,
              payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            })
          ).status,
        ).toBe(409);
        finishRecovery();
        expect((await recovery).status).toBe(kind === 'status' ? 200 : 202);
        expect(
          requests.filter((request) => request.kind === 'mcp-invoke'),
        ).toHaveLength(1);
        const settled: ManagedMcpOperationView = {
          operationId,
          state: 'settled',
          response: { contents: [] },
        };
        replies.set(operationId, settled);
        expect((await authorize(supertest(server).get(url))).body).toEqual(
          settled,
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finishInvoke();
        finishRecovery();
        await invoke;
        await recovery;
      }
    },
  );

  it('refuses every MCP operation and prompt admission while close is pending', async () => {
    const { server, authorize } = await mcpApp();
    const resource = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      });
    const operationId = (await resource()).body.operationId as string;
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const original = control.getMockImplementation()!;
    let released: () => void = () => undefined;
    const releasePending = new Promise<void>((resolve) => {
      released = resolve;
    });
    let releasing = false;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'mcp-release') {
        releasing = true;
        await releasePending;
      }
      return original.call(this, operation);
    });
    const closed = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    try {
      await vi.waitFor(() => expect(releasing).toBe(true));
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const sendPrompt = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
      expect(sendPrompt.status).toBe(409);
      const configure = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
      ).send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 2,
          definitionDigest: 'b'.repeat(64),
        },
      });
      expect(configure.status).toBe(409);
      expect((await resource()).status).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).get(
              `/session/${SESSION_ID}/mcp/operations/${operationId}`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).post(
              `/session/${SESSION_ID}/mcp/operations/${operationId}/cancel`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      released();
    }
    expect((await closed).status).toBe(204);
  });

  it.each([
    [
      'an MCP configuration',
      'mcp-configure',
      202,
      'hosted_mcp_operation_active',
    ],
    ['Session deletion', 'mcp-release', 204, 'hosted_session_closing'],
  ] as const)(
    'refuses a prompt while %s runs',
    async (trigger, parked, settled, code) => {
      const { server, authorize } = await mcpApp();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .expect(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let dispatched!: () => void;
      const started = new Promise<void>((resolve) => (dispatched = resolve));
      let finish!: () => void;
      const held = new Promise<void>((resolve) => (finish = resolve));
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === parked) {
          dispatched();
          await held;
        }
        return original.call(this, operation);
      });
      const running = (
        trigger === 'Session deletion'
          ? headers(supertest(server).delete(`/session/${SESSION_ID}`))
          : authorize(
              supertest(server).post(
                `/session/${SESSION_ID}/mcp/configurations`,
              ),
            ).send({
              operationId: randomUUID(),
              expectedRevision: 1,
              server: {
                serverId: 'demo',
                serverRevision: 1,
                definitionDigest: 'a'.repeat(64),
              },
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
    },
  );

  it.each(['invoke', 'close'])(
    'restores the owner before %s after an idle Broker restart',
    async (next) => {
      const { server, authorize, brokerOwners } = await mcpApp();
      const invoke = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await invoke()).body.state).toBe('settled');
      brokerOwners.clear();
      if (next === 'invoke')
        expect((await invoke()).body.state).toBe('settled');
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    },
  );

  it.each([
    { kind: 'resource_read', uri: '' },
    { kind: 'resource_read', uri: '   ' },
    { kind: 'prompt_get', name: '', arguments: {} },
    { kind: 'prompt_get', name: '   ', arguments: {} },
    { kind: 'resource_read', uri: 'memory://\ud800' },
    { kind: 'prompt_get', name: 'greet\udfff', arguments: {} },
    { kind: 'prompt_get', name: 'greet', arguments: { value: '\ud800' } },
    { kind: 'prompt_get', name: 'greet', arguments: { ['\udfff']: 'value' } },
  ])(
    'rejects invalid MCP strings before committing or dispatching: %j',
    async (request) => {
      const { server, authorize, requests } = await mcpApp();
      const commit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitExtensionRecord',
      );
      const rejected = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({ operationId: randomUUID(), serverId: 'demo', request });
      expect(rejected.status).toBe(400);
      expect(commit).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['unknown', 'failed'] as const)(
    'settles a turn after %s discovery and can retry and reload',
    async (failure) => {
      const { server, authorize } = await mcpApp();
      const physical = vi
        .mocked(HostedWorkspaceBroker.prototype.control)
        .getMockImplementation()!;
      let fail = true;
      vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
        async function (this: HostedWorkspaceBroker, operation) {
          if (operation.kind === 'mcp-discover' && fail) {
            fail = false;
            if (failure === 'unknown') throw new Error('Broker 503');
            return {
              operationId: operation.operationId,
              state: 'settled',
              error: { code: 'managed_mcp_connection_failed' },
            };
          }
          return physical.call(this, operation);
        },
      );
      let modelRequests = 0;
      state.model.mockImplementation(async ({ toolTurn }) => {
        await toolTurn!.declarations(new AbortController().signal);
        modelRequests++;
        return { text: 'done', model: 'test-model' };
      });
      const send = (promptId: string) => {
        const prompt = [{ type: 'text', text: 'hello' }];
        return authorize(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        ).send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      };
      expect((await send(PROMPT_ID)).status).toBe(202);
      await vi.waitFor(async () => {
        const transcript = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        );
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      });
      expect(modelRequests).toBe(0);
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      });
      expect(modelRequests).toBe(1);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('keeps MCP load explicit and outside Workspace-only cold validation', async () => {
    const { server, authorize } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
    state.assertWritable.mockRejectedValue(
      new Error('Workspace-only validation must not run'),
    );
    const load = (body: Record<string, unknown>) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        ...body,
      });
    expect((await load({})).body.code).toBe('hosted_tool_profile_conflict');
    expect(
      (await load({ toolProfile: 'hosted-workspace-mcp/1' })).body.code,
    ).toBe('invalid_hosted_mcp_servers');
    const mcpServers = [
      { serverId: 'demo', serverRevision: 1, definitionDigest: 'a'.repeat(64) },
    ];
    expect(
      (
        await load({
          toolProfile: 'hosted-workspace-mcp/1',
          mcpServers: [{ ...mcpServers[0], serverRevision: 2 }],
        })
      ).body.code,
    ).toBe('hosted_tool_profile_conflict');
    const loaded = await load({
      toolProfile: 'hosted-workspace-mcp/1',
      mcpServers,
    });
    expect(loaded.status).toBe(200);
    expect(state.assertWritable).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
  });

  it('keeps valid Unicode arguments intact through raw MCP admission', async () => {
    const { server, authorize, requests } = await mcpApp();
    const request = {
      kind: 'prompt_get',
      name: 'greet',
      arguments: { ['名字😀']: '你好😀' },
    };
    const response = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({ operationId: randomUUID(), serverId: 'demo', request });
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('settled');
    expect(requests.find((entry) => entry.kind === 'mcp-invoke')).toMatchObject(
      { request },
    );
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
  });

  it('settles a turn overlapping explicit configuration without latching recovery', async () => {
    const { server, authorize, requests } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    let resumeModel!: () => void;
    let resumeConfigure!: () => void;
    const modelBarrier = new Promise<void>((resolve) => {
      resumeModel = resolve;
    });
    const configurationBarrier = new Promise<void>((resolve) => {
      resumeConfigure = resolve;
    });
    let modelEntered = false;
    let configurationEntered = false;
    state.model.mockImplementation(async ({ signal, toolTurn }) => {
      modelEntered = true;
      await modelBarrier;
      await toolTurn!.declarations(signal);
      return { text: 'done', model: 'test-model' };
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const physical = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (
        operation.kind === 'mcp-configure' &&
        operation.configRevision === 2
      ) {
        configurationEntered = true;
        await configurationBarrier;
      }
      if (operation.kind === 'mcp-discover' && configurationEntered)
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_binding_conflict' },
        };
      return physical.call(this, operation);
    });
    const send = (promptId: string) => {
      const prompt = [{ type: 'text', text: 'hello' }];
      return authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    };
    expect((await send(PROMPT_ID)).status).toBe(202);
    await vi.waitFor(() => expect(modelEntered).toBe(true));
    const configuring = authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    )
      .send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(configurationEntered).toBe(true));
      resumeModel();
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      resumeConfigure();
      expect((await configuring).status).toBe(202);
      configurationEntered = false;
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(
        requests.filter((entry) => entry.kind === 'mcp-configure'),
      ).toHaveLength(2);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      resumeModel();
      resumeConfigure();
      await configuring;
    }
  });

  it.each([
    [16, 200],
    [17, 400],
    [32, 400],
  ])(
    'checks the MCP pin limit at creation (%i pins)',
    async (count, status) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: Array.from({ length: count }, (_, index) => ({
          serverId: `server-${index}`,
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        })),
      });
      if (created.status === 200)
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      expect(created.status).toBe(status);
      if (status === 400)
        expect(created.body.code).toBe('invalid_hosted_mcp_servers');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([17, 32])(
    'loads and detaches an existing %i-pin MCP Session',
    async (count) => {
      const mcpServers = Array.from({ length: count }, (_, index) => ({
        serverId: `server-${index}`,
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      }));
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const previous = await openManagedSession({
        runtimeBaseDir: state.root,
        cwd: state.root,
        transcriptPath,
        sessionId: SESSION_ID,
        sessionKey,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath,
        }),
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: 'hosted-workspace-mcp/1',
                mcpServers,
              }),
            ),
          ),
          rootSnapshotRef: await resources.publish(
            'managed-root',
            Buffer.from('{}'),
          ),
          createdBy: 'hosted-harness',
        },
      });
      await previous.close();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers,
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
        ).status,
      ).toBe(204);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each(['prompt', 'configuration', 'resource'])(
    'reports exhausted Runtime capacity from the MCP %s entry point',
    async (entryPoint) => {
      const { server, authorize } = await mcpApp();
      const resource = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      if (entryPoint === 'configuration')
        expect((await resource()).status).toBe(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const physical = control.getMockImplementation()!;
      control.mockImplementationOnce(async (operation) => {
        expect(operation.kind).toBe('mcp-configure');
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_connection_quota' },
        };
      });
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const sendPrompt = () =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          },
        );
      const rejected =
        entryPoint === 'prompt'
          ? await sendPrompt()
          : entryPoint === 'resource'
            ? await resource()
            : await authorize(
                supertest(server).post(
                  `/session/${SESSION_ID}/mcp/configurations`,
                ),
              ).send({
                operationId: randomUUID(),
                expectedRevision: 1,
                server: {
                  serverId: 'demo',
                  serverRevision: 2,
                  definitionDigest: 'a'.repeat(64),
                },
              });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('managed_mcp_connection_quota');
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      control.mockImplementation(physical);
      if (entryPoint === 'prompt') {
        expect((await sendPrompt()).status).toBe(202);
        await vi.waitFor(async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        });
        expect(state.model).toHaveBeenCalledOnce();
      }
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it('reconciles an unknown initial MCP configuration before admitting a retried prompt', async () => {
    const { server, authorize, requests } = await mcpApp(true);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
    const rejected = await send();
    expect(rejected.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const replacement = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    ).send({
      operationId: randomUUID(),
      expectedRevision: 1,
      server: {
        serverId: 'demo',
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      },
    });
    expect(replacement.status).toBe(503);
    expect(replacement.body.error).toBe('hosted_mcp_recovery_required');
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const admitted = await send();
    expect(admitted.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(state.model).toHaveBeenCalledOnce();
    expect(requests.map((request) => request.kind)).toEqual([
      'mcp-configure',
      'mcp-status',
    ]);
    expect(requests[1]).toMatchObject({
      targetOperationId: requests[0].operationId,
    });
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('requires the saved explicit Shell profile and advertises it only with a Broker', async () => {
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    };
    expect(
      (await headers(supertest(await app()).post('/session')).send(body))
        .status,
    ).toBe(400);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    expect(created.status).toBe(200);
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      expect(
        (await toolTurn!.declarations(new AbortController().signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual(['read_file', 'write_file', 'edit', 'run_shell_command']);
      return { text: 'text without side effects', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    const clientId = created.body.clientId as string;
    expect(
      (
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(acquire).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    expect(
      (
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        })
      ).status,
    ).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    let resumedDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      resumedDeclarations = (await toolTurn!.declarations(signal)).map(
        (tool) => tool.name!,
      );
      return { text: 'resumed', model: 'test-model' };
    });
    const nextPrompt = [{ type: 'text', text: 'again' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(resumedDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'run_shell_command',
    ]);
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each(['completed', 'model-error', 'execution-error'])(
    'closes the Shell publisher after a %s turn',
    async (ending) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        randomUUID(),
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'not_started',
          responseParts: [],
          capture: null,
          error: { message: 'command validation failed' },
        });
      if (ending === 'execution-error')
        execute.mockRejectedValue(new Error('lost execution reply'));
      let descriptor: ShellPublisherDescriptor | undefined;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockImplementation(async (value) => {
        descriptor = value;
        return '1';
      });
      const close = vi.spyOn(HostedShellPublisher.prototype, 'close');
      const start = vi.spyOn(HostedShellPublisher.prototype, 'start');
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
        if (ending === 'model-error') throw new Error('model failed');
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
          expect(status.body.recoveryBlocked).toBe(
            ending === 'execution-error',
          );
        },
        { timeout: 10_000 },
      );
      try {
        expect(descriptor).toBeDefined();
        expect(execute).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        await expect(
          fetch(descriptor!.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${descriptor!.token}` },
          }),
        ).rejects.toThrow();
      } finally {
        // Also release the real listener if the lifecycle regression fails.
        for (const publisher of start.mock.contexts)
          await (publisher as HostedShellPublisher).close();
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        );
      }
    },
  );

  it('clears the active prompt and the session when Shell publisher cleanup never settles', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'command validation failed' },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    const realClose = HostedShellPublisher.prototype.close;
    const close = vi
      .spyOn(HostedShellPublisher.prototype, 'close')
      .mockReturnValue(new Promise(() => {}));
    const start = vi.spyOn(HostedShellPublisher.prototype, 'start');
    const server = await app(true);
    let clientId = '';
    try {
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
        })
        .expect(200);
      clientId = created.body.clientId as string;
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
        },
        { timeout: 10_000 },
      );
      // The drain is still parked: availability and deletion came first.
      expect(close).toHaveBeenCalledOnce();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    } finally {
      close.mockRestore();
      for (const publisher of start.mock.contexts)
        await realClose.call(publisher);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('distinguishes strict create and load outcomes', async () => {
    const server = await app();
    const missing = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(missing.status).toBe(404);

    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const exists = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(exists.status).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses a workspace cold load before another input when a committed resource is missing', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const submitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(submitted.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const original = LocalManagedSessionResourceStore.prototype.read;
    const damaged = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    );
    damaged.mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      ref,
    ) {
      return ref.kind === 'managed-input'
        ? Promise.reject(new Error('missing committed input'))
        : original.call(this, ref);
    });
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(state.model).toHaveBeenCalledTimes(1);
    damaged.mockRestore();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('refuses a cold load when a settled file tool outcome is missing from its checkpoint', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'file contents' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'call',
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
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const original = LocalManagedSessionResourceStore.prototype.read;
    const damaged = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    );
    damaged.mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      ref,
    ) {
      return ref.kind === 'managed-tool-outcome'
        ? Promise.reject(new Error('missing settled tool outcome'))
        : original.call(this, ref);
    });
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(
      damaged.mock.calls.some(([ref]) => ref.kind === 'managed-tool-outcome'),
    ).toBe(true);
    expect(state.model).toHaveBeenCalledTimes(1);
    damaged.mockRestore();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('refuses a cold load when a complete empty Shell stream loses its seal', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const sealedResources = new Map<string, Buffer>();
    state.toolResults = {
      async publish(kind, bytes, resourceId = randomUUID()) {
        const key = `${kind}/${resourceId}`;
        const previous = sealedResources.get(key);
        if (previous && !previous.equals(bytes))
          throw new Error('Resource conflict');
        sealedResources.set(key, Buffer.from(bytes));
        return {
          resourceId,
          kind,
          schemaVersion: 1,
          byteLength: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      async read(ref) {
        const bytes = sealedResources.get(`${ref.kind}/${ref.resourceId}`);
        return bytes ? Buffer.from(bytes) : resources.read(ref);
      },
    };
    const segments = new ResourceToolResultSegmentStore(state.toolResults);
    const captureId = randomUUID();
    const capture = new LocalShellResultCapture(segments, resources, {
      tenantId: 'tenant',
      sessionId: SESSION_ID,
      turnId: PROMPT_ID,
      executionCallId: randomUUID(),
      callId: 'call',
      invocationDigest: 'digest',
      bindingGeneration: '1',
      captureId,
      revision: 1,
    });
    capture.setStarted(1);
    capture.setProcessResult({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 1,
      executionMethod: 'child_process',
    });
    await Promise.all([
      capture.finish('stdout', true),
      capture.finish('stderr', true),
    ]);
    const envelope = await capture.finalize('success', []);
    expect(envelope.capture?.captureStatus).toBe('complete');
    const manifest = envelope.capture!.manifest!;
    await segments.close();
    const manifestBody = parseToolResultManifestBytes(
      await resources.read(manifest),
    );
    const reader = new ResourceToolResultSegmentStore(state.toolResults);
    expect(
      await reader.readRange({
        manifestRef: manifest,
        expectedIdentity: manifestBody,
        streamId: 'stdout',
        offset: 0,
        length: 0,
      }),
    ).toEqual({ status: 'ok', result: Buffer.alloc(0) });
    await reader.close();
    const events = LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'eventsInSequenceRange',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      start,
      end,
    ) {
      return [
        ...events.call(this, start, end),
        {
          kind: 'tool.receipt',
          payload: { resultRef: manifest },
        } as unknown as ManagedSessionEvent,
      ];
    });
    const sealId = createHash('sha256')
      .update(JSON.stringify([captureId, 'stderr', 'seal']))
      .digest('hex');
    const sealKey = `managed-tool-result-content/${sealId}`;
    const seal = sealedResources.get(sealKey)!;
    expect(seal).toBeDefined();
    sealedResources.delete(sealKey);
    const read = vi.spyOn(state.toolResults, 'read');
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(
      read.mock.calls.map(([ref]) => [ref.kind, ref.resourceId]),
    ).toContainEqual(['managed-tool-result-content', sealId]);
    read.mockRestore();
    sealedResources.set(sealKey, seal);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('keeps one restore cut while activation renewal advances the log', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    let renew: (() => Promise<unknown>) | undefined;
    let cut = 0;
    const restore = LocalManagedSessionAuthority.prototype.restoreBundle;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'restoreBundle',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const bundle = await restore.call(this);
      renew = () => this.renewActivation({ leaseDurationMs: 60_000 });
      cut = bundle.throughSequence;
      return bundle;
    });
    const read = LocalManagedSessionResourceStore.prototype.read;
    let renewed = false;
    const reads = new Map<string, number>();
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      if (renew)
        reads.set(
          reference.resourceId,
          (reads.get(reference.resourceId) ?? 0) + 1,
        );
      if (renew && reference.kind === 'managed-root' && !renewed) {
        renewed = true;
        await renew();
      }
      return read.call(this, reference);
    });
    const projection = vi.spyOn(ManagedSessionRecordSink.prototype, 'project');
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(renewed).toBe(true);
    expect(reads.size).toBeGreaterThan(0);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(loaded.body.lastEventId).toBeGreaterThan(cut);
    expect(projection).toHaveBeenCalledWith(cut);
    expect(state.assertWritable).toHaveBeenCalledTimes(2);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each(['conflicting-ref', 'extension-domain'])(
    'refuses a cold load with %s in retained history',
    async (fault) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      });
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        created.body.clientId as string,
      );
      const events =
        LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
      const damaged = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'eventsInSequenceRange')
        .mockImplementation(function (
          this: LocalManagedSessionAuthority,
          start,
          end,
        ) {
          return [
            ...events.call(this, start, end),
            {
              kind:
                fault === 'extension-domain'
                  ? 'domain.committed'
                  : 'tool.receipt',
              payload:
                fault === 'extension-domain'
                  ? { domain: 'unsupported' }
                  : {
                      resultRef: {
                        ...this.sessionHeader.rootSnapshotRef,
                        schemaVersion: 2,
                      },
                    },
            } as unknown as ManagedSessionEvent,
          ];
        });
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(state.model).not.toHaveBeenCalled();
      damaged.mockRestore();
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
    'loads a renamed %s Session and verifies its retained title resources',
    async (toolProfile) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      });
      expect(created.status).toBe(200);
      for (const title of ['First title', 'Second title']) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .send({ title })
          .expect(200);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        created.body.clientId as string,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
      const read = LocalManagedSessionResourceStore.prototype.read;
      const damaged = vi
        .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
        .mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          reference,
        ) {
          return reference.kind === 'managed-session_metadata'
            ? Promise.reject(new Error('title resource missing'))
            : read.call(this, reference);
        });
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(state.model).not.toHaveBeenCalled();
      damaged.mockRestore();
      const retry = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(retry.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        retry.body.clientId as string,
      );
    },
  );

  it('refuses attachment if writer ownership is lost during restore validation', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    state.assertWritable.mockRejectedValueOnce(new Error('writer lost'));
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(state.model).not.toHaveBeenCalled();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('allows only one concurrent attachment for a session ID', async () => {
    const server = await app();
    const create = () =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the caller session ID, commits a text turn, and refuses duplicate inference', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toBe(SESSION_ID);
    expect(created.body.lastEventId).toBeGreaterThan(0);

    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    const admitted = await send();
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toBe(PROMPT_ID);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(state.model).toHaveBeenCalledTimes(1);

    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(transcript.status).toBe(200);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session_update',
          promptId: PROMPT_ID,
        }),
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    expect(
      (transcript.body.events as Array<{ id: number }>).map(
        (event) => event.id,
      ),
    ).toEqual(
      (transcript.body.events as Array<{ id: number }>).map(
        (_, index) => index + 1,
      ),
    );
    const listener = server;
    const address = listener.address();
    expect(address && typeof address !== 'string').toBe(true);
    const controller = new AbortController();
    try {
      const stream = await fetch(
        `http://127.0.0.1:${(address as { port: number }).port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
            'X-Qwen-Event-Epoch': admitted.body.eventEpoch as string,
            'Last-Event-ID': String(admitted.body.lastEventId),
          },
          signal: controller.signal,
        },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('x-qwen-event-epoch')).toBe(
        admitted.body.eventEpoch,
      );
      const reader = stream.body!.getReader();
      let frames = '';
      while (!frames.includes('event: turn_complete')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += new TextDecoder().decode(chunk.value);
      }
      const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(
        ids.map((_, index) => Number(admitted.body.lastEventId) + index + 1),
      );
      expect(frames).toContain('event: session_update');
      expect(frames).toContain(`"promptId":"${PROMPT_ID}"`);
    } finally {
      controller.abort();
      listener.closeAllConnections();
    }
    const repeated = await send();
    expect(repeated.status).toBe(202);
    expect(repeated.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);

    const title = await headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ title: 'Hosted test' });
    expect(title.status).toBe(200);
    expect(title.body.persisted).toBe(true);

    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const gone = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(gone.status).toBe(404);
  });

  it('rejects unsupported prompt content before model or tool execution', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'image', data: 'forbidden' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(400);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('rejects prompts whose durable user record would exceed the store limit', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const prompt = [{ type: 'text', text: 'x'.repeat(65_300) }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(413);
    expect(state.model).not.toHaveBeenCalled();
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it.each(['assistant', 'cancellation'] as const)(
    'rejects an oversized complete %s record before acquisition and permits retry and reload',
    async (mode) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
      const server = await app(true);
      const toolProfile = 'hosted-workspace-files/1';
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      });
      expect(created.status).toBe(200);
      const writes = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: 'call',
          args: { file_path: 'a' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        if (mode === 'cancellation') {
          const user = writes.mock.calls.find(
            ([record]) => record.type === 'user',
          )![0];
          const assistant = {
            ...user,
            uuid: randomUUID(),
            parentUuid: user.uuid,
            type: 'assistant',
            model: 'test-model',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: call.callId,
                    name: call.name,
                    args: call.args,
                  },
                },
              ],
            },
          };
          call.callId = 'c'.repeat(
            65_535 -
              Buffer.byteLength(JSON.stringify(assistant)) +
              call.callId.length,
          );
        }
        await toolTurn!.execute(
          [call],
          [
            ...(mode === 'assistant' ? [{ text: 'x'.repeat(65_100) }] : []),
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
        throw new Error('oversized record was accepted');
      });
      const prompt = [{ type: 'text', text: 'read a' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const clientId = created.body.clientId as string;
      const send = async (promptId: string) => {
        const response = await headers(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ prompt, promptId, payloadDigest });
        expect(response.status).toBe(202);
        await vi.waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        });
      };
      await send(PROMPT_ID);
      expect(acquire).not.toHaveBeenCalled();
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      await send('44444444-4444-4444-8444-444444444444');
      expect(state.model).toHaveBeenCalledTimes(2);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it('omits settled output when only the complete tool result record exceeds the limit', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'x'.repeat(65_200) }],
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const publish = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let response: Record<string, unknown> | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'call',
        args: { file_path: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      const parts = await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      response = parts[0].functionResponse?.response;
      await toolTurn!.consumeResults();
      return { text: 'request a smaller range', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    // The default 1s waitFor timeout races this turn's durable writes on
    // contended CI runners; the assertions are unchanged.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(response?.['outputOmitted']).toBe(true);
    expect(response?.['executionStatus']).toBe('success');
    expect(release).toHaveBeenCalledOnce();
    for (const [, bytes] of publish.mock.calls)
      expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  });

  it.each([
    ['workspace_busy', false],
    ['workspace_unavailable', false],
    ['partial', false],
    ['managed_runtime_provider_operation_failed', false],
    ['runtime_control_operation_invalid', false],
    ['workspace_busy', true],
  ] as const)(
    'preserves the original Shell receipt and continuation across %s recovery (Hooks: %s)',
    async (refusalCode, hooks) => {
      const partial = refusalCode === 'partial';
      const captureStatus = partial
        ? ('partial' as const)
        : ('complete' as const);
      const captureReason = partial ? ('storage_failed' as const) : null;
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const manifest = await resources.publish(
        'managed-tool-result-manifest',
        Buffer.from(
          JSON.stringify({
            toolResult: 'managed-tool-result/1',
            type: 'manifest',
            tenantId: key.tenantId,
            sessionId: SESSION_ID,
            turnId: PROMPT_ID,
            executionCallId: 'shell-execution',
            callId: 'model-shell-call',
            invocationDigest: 'digest',
            bindingGeneration: '1',
            captureId: randomUUID(),
            revision: 1,
            executionStatus: 'success',
            exitCode: 0,
            signal: null,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            captureStatus,
            captureReason,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: partial && streamId === 'stderr' ? 'incomplete' : 'sealed',
              byteLength: 0,
              digest: createHash('sha256').update('').digest('hex'),
              missingRanges: [],
              body: { pages: [] },
            })),
          }),
        ),
      );
      const envelope = {
        executionStatus: 'success' as const,
        responseParts: [{ text: 'hi' }],
        capture: {
          manifest,
          captureStatus,
          captureReason,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      if (hooks)
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'hookControl',
        ).mockImplementation(async (operation) => ({
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...hookPin, hooks: [] },
        }));
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding-1',
            generation: '1',
            workspaceGeneration: '1',
          };
        });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
        executionCallId: 'shell-execution',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      const acknowledge = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acknowledgeV3')
        .mockRejectedValueOnce(
          new HostedWorkspaceBrokerRejection(409, 'runtime_execution_conflict'),
        )
        .mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      state.publicationRequest.mockImplementation(
        async (
          resourceStore: LocalManagedSessionResourceStore,
          route: string,
          body: unknown,
        ) => {
          if (route === '/grants') return { state: 'OPEN' };
          if (route === '/receipts/verify') return body;
          if (route.endsWith('/finished')) return { result: envelope };
          if (route.endsWith('/admissions/prepare'))
            return resourceStore.publish(
              'managed-tool-outcome',
              Buffer.from(JSON.stringify(body)),
            );
          throw new Error('Unexpected publication route ' + route);
        },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let failed = false;
      let failFinalSettlement = true;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, record) {
          if (!failed && record.type === 'tool_result') {
            failed = true;
            throw new Error('lost history write');
          }
          if (record.subtype === 'turn_result' && failFinalSettlement)
            throw new Error('lost final settlement');
          return originalWrite.call(this, record);
        },
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
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
        throw new Error('Expected a lost history write');
      });
      state.model.mockImplementationOnce(
        async ({ toolTurn, resumeFromToolResults }) => {
          expect(resumeFromToolResults).toHaveLength(1);
          await toolTurn!.consumeResults();
          return { text: 'resumed after Shell', model: 'test-model' };
        },
      );
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
        ...(hooks ? { hookCatalog: hookPin } : {}),
      });
      expect(created.status).toBe(200);
      const close = (target: Server, clientId: string) =>
        hooks
          ? headers(
              supertest(target).post(`/session/${SESSION_ID}/detach`),
            ).set('X-Qwen-Client-Id', clientId)
          : headers(supertest(target).delete(`/session/${SESSION_ID}`));
      const prompt = [{ type: 'text', text: 'run Shell' }];
      const payloadDigest =
        'sha256:' +
        createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
      await headers(supertest(first).post('/session/' + SESSION_ID + '/prompt'))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(first).get('/session/' + SESSION_ID + '/status'),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      });
      expect(failed).toBe(true);
      expect(acknowledge).not.toHaveBeenCalled();
      await close(first, created.body.clientId).expect(204);
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const releasedBefore = releases.mock.calls.length;
      const second = await app(true);
      const checkpointBefore = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      const prepare = vi.mocked(HostedWorkspaceBroker.prototype.prepareV3);
      const execute = vi.mocked(HostedWorkspaceBroker.prototype.executeV3);
      const acquireCount = acquire.mock.calls.length;
      for (const failure of [
        'missing page',
        'corrupt page',
        'missing segment',
        'corrupt segment',
        'missing empty seal',
      ]) {
        state.publicationRequest.mockRejectedValueOnce(new Error(failure));
        const refused = await headers(
          supertest(second).post('/session/' + SESSION_ID + '/load'),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(state.model).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        expect(acquire).toHaveBeenCalledTimes(acquireCount);
        expect(acknowledge).not.toHaveBeenCalled();
        const unchanged = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        );
        const recoverable = (events: ManagedSessionEvent[]) =>
          events.filter((event) =>
            [
              'message.committed',
              'checkpoint.committed',
              'tool.receipt',
            ].includes(event.kind),
          );
        expect(recoverable(unchanged.events)).toEqual(
          recoverable(checkpointBefore.events),
        );
      }
      const conflict = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({ managedSessionStore: store(), captureBytes: 512 });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('hosted_tool_profile_conflict');
      if (partial) {
        acknowledge.mockReset();
        acknowledge.mockResolvedValue();
        for (let attempt = 0; attempt < 2; attempt++) {
          const loaded = await headers(
            supertest(second).post('/session/' + SESSION_ID + '/load'),
          ).send({ managedSessionStore: store() });
          expect(loaded.status).toBe(409);
          expect(loaded.body.code).toBe('hosted_turn_recovery_required');
          expect(acknowledge).toHaveBeenLastCalledWith('shell-execution', {
            executionCallId: 'shell-execution',
            manifest,
            deliveryStatus: 'blocked',
            historyRevision: null,
          });
          expect(state.model).toHaveBeenCalledOnce();
          expect(prepare).toHaveBeenCalledOnce();
          expect(execute).toHaveBeenCalledOnce();
          expect(acquire).toHaveBeenCalledTimes(acquireCount);
        }
        const repaired = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        );
        expect(
          repaired.events.filter((event) => event.kind === 'tool.receipt'),
        ).toHaveLength(1);
        expect(
          repaired.events.filter(
            (event) =>
              event.kind === 'message.committed' &&
              event.payload['role'] === 'tool_result',
          ),
        ).toHaveLength(1);
        return;
      }
      const bindRefused = !refusalCode.startsWith('workspace_');
      const refusal = new HostedWorkspaceBrokerRejection(
        refusalCode === 'runtime_control_operation_invalid' ? 400 : 409,
        refusalCode,
      );
      if (bindRefused)
        vi.mocked(
          HostedWorkspaceBroker.prototype.fileHistory,
        ).mockRejectedValueOnce(refusal);
      else acquire.mockRejectedValueOnce(refusal);
      const refused = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(refused.status).toBe(bindRefused ? 503 : 409);
      expect(refused.body.code).toBe(
        bindRefused ? 'managed_session_open_failed' : refusalCode,
      );
      if (!hooks) expect(releases).toHaveBeenCalledTimes(releasedBefore);
      expect(state.model).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
      const originalOwner = (execute.mock.contexts[0] as HostedWorkspaceBroker)
        .runtimeSessionId;
      expect(
        (acknowledge.mock.contexts[0] as HostedWorkspaceBroker)
          .runtimeSessionId,
      ).toBe(originalOwner);
      if (hooks) expect(originalOwner).not.toBe(PROMPT_ID);
      const checkpointAfter = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      expect(
        checkpointAfter.events.filter((event) => event.kind === 'tool.receipt'),
      ).toEqual(
        checkpointBefore.events.filter(
          (event) => event.kind === 'tool.receipt',
        ),
      );
      const savedCheckpoint = checkpointAfter.events.findLast(
        (event) => event.kind === 'checkpoint.committed',
      );
      expect(savedCheckpoint).toBeDefined();
      const stateRef = assertManagedSessionDurableRef(
        savedCheckpoint!.payload['stateRef'],
        'savedCheckpoint.stateRef',
      );
      const savedState = JSON.parse(
        (await resources.read(stateRef)).toString('utf8'),
      );
      expect(savedState.continuation.phase).toBe('results_ready');
      expect(savedState.tools.items[0]).toMatchObject({
        executionCallId: 'shell-execution',
        state: 'settled',
        consumed: false,
      });
      state.assertWritable
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('writer lost after recovery'));
      const ownerLost = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({ managedSessionStore: store() });
      expect(ownerLost.status).toBe(409);
      expect(ownerLost.body.code).toBe('hosted_turn_recovery_required');
      expect(state.model).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      acknowledge.mockClear();
      acknowledge.mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(409, 'runtime_execution_conflict'),
      );
      const loaded = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(second).get('/session/' + SESSION_ID + '/status'),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      });
      expect(state.model).toHaveBeenCalledTimes(2);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(
        (acknowledge.mock.contexts[0] as HostedWorkspaceBroker)
          .runtimeSessionId,
      ).toBe(originalOwner);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('runtime_execution_conflict'),
      );
      await close(second, loaded.body.clientId).expect(204);
      failFinalSettlement = false;
      const third = await app(true);
      const reopened = await headers(
        supertest(third).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(reopened.status).toBe(200);
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(third).get('/session/' + SESSION_ID + '/status'),
        ).set('X-Qwen-Client-Id', reopened.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      });
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(state.model).toHaveBeenCalledTimes(2);
      const transcript = await headers(
        supertest(third).get('/session/' + SESSION_ID + '/transcript'),
      ).set('X-Qwen-Client-Id', reopened.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      await headers(supertest(third).delete('/session/' + SESSION_ID)).expect(
        204,
      );
      const project = vi.spyOn(ManagedSessionRecordSink.prototype, 'project');
      const fourth = await app(true);
      const settled = await headers(
        supertest(fourth).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(settled.status).toBe(200);
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledWith(expect.any(Number));
      await headers(supertest(fourth).delete('/session/' + SESSION_ID)).expect(
        204,
      );
    },
  );

  it('recovers a proven unstarted Shell after its history reply is lost', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'shell-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
    });
    const acknowledge = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resourceStore, route: string, body: { operation: string }) => {
        if (route !== '/grants')
          throw new Error('Unexpected publication route');
        return {
          state:
            body.operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
        };
      },
    );
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failed = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record) {
        if (!failed && record.type === 'tool_result') {
          failed = true;
          await originalWrite.call(this, record);
          throw new Error('lost history reply');
        }
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'model-shell-call',
        args: { command: 'printf hi' },
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
      throw new Error('Expected a lost history reply');
    });
    state.model.mockImplementationOnce(
      async ({ toolTurn, resumeFromToolResults }) => {
        expect(resumeFromToolResults).toHaveLength(1);
        await toolTurn!.consumeResults();
        return { text: 'resumed after unstarted Shell', model: 'test-model' };
      },
    );
    const first = await app(true);
    const created = await headers(supertest(first).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'run Shell' }];
    await headers(supertest(first).post('/session/' + SESSION_ID + '/prompt'))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(first).get('/session/' + SESSION_ID + '/status'),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    expect(failed).toBe(true);
    await headers(supertest(first).delete('/session/' + SESSION_ID)).expect(
      204,
    );
    const second = await app(true);
    const loaded = await headers(
      supertest(second).post('/session/' + SESSION_ID + '/load'),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(second).get('/session/' + SESSION_ID + '/status'),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
    });
    expect(state.model).toHaveBeenCalledTimes(2);
    expect(acknowledge).not.toHaveBeenCalled();
    await headers(supertest(second).delete('/session/' + SESSION_ID)).expect(
      204,
    );
  });

  it('ends an event stream when its attachment closes', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const listener = server;
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
          },
          signal: AbortSignal.timeout(3_000),
        },
      );
      expect(stream.status).toBe(200);
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(closed.status).toBe(204);
      const reader = stream.body!.getReader();
      let done = false;
      while (!done) ({ done } = await reader.read());
      expect(done).toBe(true);
    } finally {
      listener.closeAllConnections();
    }
  });

  it('stops writing an event stream after backpressure ends it', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events.length).toBeGreaterThan(2);
    });

    const originalWrite = ServerResponse.prototype.write;
    let frames = 0;
    let ends = 0;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          frames++;
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
        ends++;
        return this;
      });
    const listener = server;
    const abort = new AbortController();
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: abort.signal,
        },
      );
      expect(stream.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(frames).toBe(1);
      expect(ends).toBe(1);
    } finally {
      write.mockRestore();
      end.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('logs the failure cause while keeping the public turn error generic', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockRejectedValueOnce(new Error('model initialization failed'));
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_error',
            promptId: PROMPT_ID,
            data: {
              sessionId: SESSION_ID,
              promptId: PROMPT_ID,
              code: 'hosted_turn_failed',
              message: 'Hosted Harness turn failed.',
            },
          }),
        ]),
      );
    });
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Harness turn ${PROMPT_ID} failed: Error: model initialization failed`,
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it.each([
    ['managed-message', 'turn_error', 0],
    ['managed-turn-result', 'turn_complete', 1],
    ['runnable-check', 'turn_error', 0],
  ])(
    'settles a turn after one %s failure',
    async (failedKind, terminalType, modelCalls) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(created.status).toBe(200);
      let failed = false;
      if (failedKind === 'runnable-check') {
        const restore = LocalManagedSessionAuthority.prototype.restoreBundle;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'restoreBundle',
        ).mockImplementation(function (this: LocalManagedSessionAuthority) {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('transient restore failure'));
          }
          return restore.call(this);
        });
      } else {
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          kind,
          bytes,
        ) {
          if (kind === failedKind && !failed) {
            failed = true;
            return Promise.reject(new Error('transient store failure'));
          }
          return publish.call(this, kind, bytes);
        });
      }
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'hello' }];
      const send = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          });
      const admitted = await send();
      expect(admitted.status).toBe(202);
      // The default 1s waitFor timeout races the settlement retry's durable
      // writes on contended CI runners; the assertions are unchanged.
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: terminalType,
                promptId: PROMPT_ID,
              }),
            ]),
          );
        },
        { timeout: 10_000 },
      );
      expect(failed).toBe(true);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
      const retried = await send();
      expect(retried.status).toBe(202);
      expect(retried.body).toEqual(admitted.body);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const nextPrompt = [{ type: 'text', text: 'next' }];
      const nextPromptId = '44444444-4444-4444-8444-444444444444';
      const next = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: nextPrompt,
          promptId: nextPromptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        });
      expect(next.status).toBe(202);
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'turn_complete',
                promptId: nextPromptId,
              }),
            ]),
          );
        },
        { timeout: 10_000 },
      );
      expect(state.model).toHaveBeenCalledTimes(modelCalls + 1);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('preserves a recovery failure when Shell cleanup also fails', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceToolTurn.prototype, 'close').mockRejectedValue(
      new Error('cleanup failed'),
    );
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('original result unknown')),
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run Shell' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_error',
      ),
    ).toEqual([]);
  });

  it('blocks new prompts when terminal settlement keeps failing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-turn-result') {
        return Promise.reject(new Error('store down'));
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) =>
          event.type === 'turn_complete' || event.type === 'turn_error',
      ),
    ).toEqual([]);
    const nextPrompt = [{ type: 'text', text: 'next' }];
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '44444444-4444-4444-8444-444444444444',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses a bare load of a recovery-blocked Turn after detach', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockRejectedValue(
      new Error('broker gone'),
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'call-1',
        args: { file_path: 'a', content: 'x' },
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
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles a cancelled turn when writing its user record fails once', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message') {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(204);
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(async () => {
      const transcript = await headers(
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
    });
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports an aborted turn as cancelled to the Java event projector', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          );
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(cancelled.status).toBe(204);
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
            data: expect.objectContaining({ stopReason: 'cancelled' }),
          }),
        ]),
      );
    });
    expect(log).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports a deadline-exceeded turn as a classified failure, not a cancellation', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest, deadlineMs: 2000 });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
        expect(
          (transcript.body.events as Array<{ type: string }>).some(
            (event) => event.type === 'turn_complete',
          ),
        ).toBe(false);
      },
      { timeout: 10_000 },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    );
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    // The settled Turn frees the Session for the next prompt.
    const followUp = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: randomUUID(), payloadDigest });
    expect(followUp.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('classifies a deadline expiry on the retried settlement path', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message' && !rejectWrite) {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        deadlineMs: 2000,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    // Let the deadline fire while the user-record write is still hung, so
    // the turn fails before the model ran and the settlement retry path
    // (not the runner's own catch) classifies the abort.
    await new Promise((resolve) => setTimeout(resolve, 2250));
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    );
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});

describe('Hosted Harness tool approvals', () => {
  // Turns commit and sync several records, which can take over a second
  // on a busy host.
  const waitFor = <T>(check: () => T | Promise<T>) =>
    vi.waitFor(check, { timeout: 10_000 });

  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async () => randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  const files = 'hosted-workspace-files/1';

  async function definitions(): Promise<unknown[]> {
    const paths = (await readdir(state.root, { recursive: true })).filter(
      (entry) =>
        entry.includes(`managed-definition${path.sep}`) &&
        !path.basename(entry).startsWith('.'),
    );
    return Promise.all(
      paths.map(async (entry) =>
        JSON.parse(await readFile(path.join(state.root, entry), 'utf8')),
      ),
    );
  }

  it('pins a mode that can ask at creation and refuses other modes', async () => {
    const server = await app(true);
    const create = (extra: Record<string, unknown>) =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...extra,
      });
    for (const extra of [
      { approvalMode: 'plan' },
      { approvalMode: 'auto' },
      { approvalMode: null },
      { approvalMode: 'default', approvalTimeoutMs: 999 },
    ]) {
      const refused = await create({ toolProfile: files, ...extra });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_hosted_approval');
    }
    expect(await definitions()).toEqual([]);

    const noTools = await create({ approvalMode: 'plan' });
    expect(noTools.status).toBe(200);
    expect(noTools.body).not.toHaveProperty('approvalMode');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      noTools.body.clientId as string,
    );
    expect(await definitions()).toEqual([
      { engine: 'managed', sessionId: SESSION_ID },
    ]);
  });

  it.each([
    { approvalMode: 'plan', approvalTimeoutMs: 60_000 },
    { approvalMode: 'default' },
    { approvalTimeoutMs: 60_000 },
  ])(
    'refuses to load a tool Session whose saved approval is %o',
    async (saved) => {
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const managed = await openManagedSession({
        runtimeBaseDir: state.root,
        transcriptPath: '',
        sessionId: SESSION_ID,
        sessionKey,
        cwd: state.root,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
        resourceStore,
        create: {
          definitionRef: await resourceStore.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: files,
                ...saved,
              }),
            ),
          ),
          rootSnapshotRef: await resourceStore.publish(
            'managed-root',
            Buffer.from(JSON.stringify({ cwd: state.root })),
          ),
          createdBy: 'hosted-harness',
        },
        requireNew: true,
      });
      await managed.close();
      const loaded = await headers(
        supertest(await app(true)).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_tool_profile_conflict');
    },
  );

  it('keeps a yolo tool Session definition unchanged', async () => {
    const created = await headers(
      supertest(await app(true)).post('/session'),
    ).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
      approvalTimeoutMs: 5,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('yolo');
    expect(await definitions()).toEqual([
      { engine: 'managed', sessionId: SESSION_ID, toolProfile: files },
    ]);
  });

  it('answers approvals through the resolve route across turns and a reload', async () => {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: randomUUID(),
        args: { file_path: 'notes.txt', content: 'hello' },
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
      toolProfile: files,
      approvalMode: 'default',
      approvalTimeoutMs: 60_000,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('default');
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
      },
    ]);
    const answer = (clientId: string, requestId: string, optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const runTurn = async (clientId: string, promptId: string) => {
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
      return requestIds.at(-1)!;
    };
    const finished = async (clientId: string) =>
      waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });

    let clientId = created.body.clientId as string;
    const first = await runTurn(clientId, PROMPT_ID);
    const missing = await answer('other-client', first, 'allow');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('hosted_session_not_found');
    const unknown = await answer(
      clientId,
      `tool_approval_${'0'.repeat(32)}`,
      'allow',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('action_not_found');
    const invalid = await answer(clientId, first, 'later');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_action_response');
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    // Reading the options fails before anything is written.
    const failure = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(new Error('store down'));
    const failed = await answer(clientId, first, 'allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('store down'));
    failure.mockRestore();
    log.mockRestore();
    const allowed = await answer(clientId, first, 'allow');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      requestId: first,
      state: 'decided',
      optionId: 'allow',
    });
    await finished(clientId);
    expect((await answer(clientId, first, 'allow')).status).toBe(200);
    const changed = await answer(clientId, first, 'deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');

    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.approvalMode).toBe('default');
    clientId = loaded.body.clientId as string;
    const secondPrompt = randomUUID();
    const second = await runTurn(clientId, secondPrompt);
    expect(second).not.toBe(first);
    expect((await answer(clientId, second, 'allow')).status).toBe(200);
    await finished(clientId);

    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(2);
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, secondPrompt]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  async function waitingSession() {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'edit',
        callId: 'call-1',
        args: { file_path: 'a.txt', old_string: 'a', new_string: 'b' },
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
      toolProfile: files,
      approvalMode: 'default',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'edit a' }];
    const submit = async (promptId: string) => {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
    };
    await submit(PROMPT_ID);
    const answer = (optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestIds.at(-1)}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const status = async () =>
      (
        await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId)
      ).body;
    return { server, clientId, answer, status, submit };
  }

  it('streams a message_retracted envelope when a restarted attempt retracts its prefix', async () => {
    state.model.mockImplementationOnce(async (input) => {
      const deltas = (
        input as {
          textDeltas?: {
            delta(text: string): Promise<void>;
            retract(): Promise<void>;
          };
        }
      ).textDeltas;
      await deltas!.delta('orphaned prefix');
      await deltas!.retract();
      await deltas!.delta('recovered');
      return { text: 'recovered', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'retry' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const events = transcript.body.events as Array<{
      id: number;
      type: string;
      promptId?: string;
      data?: {
        turnId?: string;
        messageId?: string;
        fromSequence?: number;
        update?: { sessionUpdate?: string; content?: { text?: string } };
      };
    }>;
    const chunks = events.filter((event) => event.type === 'session_update');
    const retractions = events.filter(
      (event) => event.type === 'message_retracted',
    );
    expect(retractions).toHaveLength(1);
    expect(retractions[0]!.promptId).toBe(PROMPT_ID);
    expect(retractions[0]!.data?.turnId).toBe(PROMPT_ID);
    // The retraction names the orphaned prefix's first delta and lands
    // between the orphaned chunks and the replay's.
    expect(retractions[0]!.data?.fromSequence).toBe(chunks[0]!.id);
    expect(retractions[0]!.id).toBeGreaterThan(chunks[0]!.id);
    const replayed = chunks.filter((chunk) => chunk.id > retractions[0]!.id);
    expect(
      replayed.map((chunk) => chunk.data?.update?.content?.text).join(''),
    ).toBe('recovered');
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('blocks the Session at once when recording an answer stops its writes', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { answer, status } = await waitingSession();
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const failed = await answer('allow');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('hosted_turn_recovery_required');
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect((await answer('allow')).body.code).toBe(
      'hosted_turn_recovery_required',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('journal down'));
  });

  it('retains the turn recovery error on cold load of a pending file edit', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockRejectedValueOnce(
      new Error('lost execution reply'),
    );
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const history = await headers(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .send({})
      .expect(204);
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockClear();
    state.model.mockClear();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: files });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each(['pending-snapshot', 'history-settled'])(
    'reloads settled file results after %s without redispatch',
    async (phase) => {
      vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
      const { server, clientId, answer, status } = await waitingSession();
      const fileState = {
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      };
      if (phase === 'pending-snapshot') {
        vi.mocked(
          HostedWorkspaceBroker.prototype.fileHistory,
        ).mockImplementation(async (operation) => {
          if (operation.action === 'snapshot')
            throw new Error('snapshot reply lost');
          return fileState;
        });
      } else {
        vi.spyOn(
          HostedWorkspaceToolTurn.prototype,
          'consumeResults',
        ).mockRejectedValueOnce(
          new HostedToolRecoveryRequiredError(
            new Error('interrupted before model continuation'),
          ),
        );
      }
      expect((await answer('allow')).status).toBe(200);
      await waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        }),
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      vi.mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockResolvedValue(fileState)
        .mockClear();
      state.model.mockImplementationOnce(
        async ({ toolTurn, resumeFromToolResults }) => {
          expect(resumeFromToolResults).toHaveLength(1);
          await toolTurn!.consumeResults();
          return {
            text: 'resumed from saved file result',
            model: 'test-model',
          };
        },
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      const recoveredId = loaded.body.clientId as string;
      await waitFor(async () => {
        const response = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', recoveredId);
        expect(response.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.fileHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: phase === 'pending-snapshot' ? 'snapshot' : 'bind',
        }),
      );
      const history = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', recoveredId);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', recoveredId)
        .send({})
        .expect(204);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          ).send({ managedSessionStore: store(), toolProfile: files })
        ).status,
      ).toBe(200);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    },
  );

  it('cancels a waiting approval through the cancel route and releases the Workspace', async () => {
    const { server, clientId, answer, status } = await waitingSession();
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    const transcript = await headers(
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
    const late = await answer('allow');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_cancelled');
  });

  it('refuses answers once the Session is recovery-blocked', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'resolveAction',
    ).mockRejectedValueOnce(new Error('fenced'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const refused = await answer('allow');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fenced'));
  });

  it('asks again in the Turn after one whose calls were all refused', async () => {
    const { server, clientId, answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      },
    ]);
    expect((await answer('deny')).status).toBe(200);
    await finished();
    const second = randomUUID();
    await submit(second);
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, second]);
  });

  it('keeps a replay retryable when it fails before writing on a stopped Session', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({ hasActivePrompt: false }),
    );
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed' })
      .expect(503);
    // Only a Session whose writes stopped refuses the next write as well.
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed again' })
      .expect(503);
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockRejectedValueOnce(new Error('store unavailable'));
    const failed = await answer('allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect((await answer('allow')).status).toBe(200);
    const changed = await answer('deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('store unavailable'),
    );
  });

  it('asks again in the next Turn after an approval expired unanswered', async () => {
    const { answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    // An answer after the expiry time expires the Action at once.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + HOSTED_APPROVAL_TIMEOUT_MS);
    const late = await answer('allow');
    now.mockRestore();
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_expired');
    await finished();
    await submit(randomUUID());
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
  });
  it.each([
    'success',
    'conflict',
    'closing',
    'old-history-unavailable',
    'corrupt-receipt',
    'release',
    'busy',
    'warm',
    'bind',
    'unsupported',
    'unknown-acquire',
    'unknown-released',
    'unknown-bind',
    'refusal-release',
    'capacity',
    'partial',
  ])(
    'settles undo or preserves its recovery boundary (%s)',
    async (scenario) => {
      const releaseFails = scenario === 'release';
      let writePromptId = PROMPT_ID;
      const historyState: HostedFileHistoryState = {
        ownerSessionId: SESSION_ID,
        snapshots: [
          {
            promptId: PROMPT_ID,
            timestamp: '2026-09-30T00:00:00.000Z',
            trackedFileBackups: {
              'notes.txt': {
                backupFileName: null,
                version: 1,
                backupTime: '2026-09-30T00:00:00.000Z',
              },
            },
          },
        ],
        files: {
          'notes.txt': { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 },
        },
      };
      if (scenario === 'partial') {
        historyState.snapshots[0].trackedFileBackups['other.txt'] = {
          ...historyState.snapshots[0].trackedFileBackups['notes.txt'],
        };
        historyState.files['other.txt'] = historyState.files['notes.txt'];
      }
      const conflict = scenario === 'conflict';
      const control = vi
        .mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockImplementation(async (operation) =>
          operation.action === 'rewind'
            ? {
                state: conflict
                  ? historyState
                  : { ...historyState, files: { 'notes.txt': null } },
                filesChanged: conflict ? [] : ['notes.txt'],
                filesFailed: [],
                conflict,
              }
            : historyState,
        );
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: 'write',
          args: { file_path: 'notes.txt', content: 'hello' },
          isClientInitiated: false,
          prompt_id: writePromptId,
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
          'model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
      });
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          prompt,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      if (scenario === 'old-history-unavailable') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (
              ref.kind === 'managed-file_history' &&
              JSON.parse(bytes.toString('utf8')).pendingTurn
            )
              throw new Error('old history resource unavailable');
            return bytes;
          });
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        fault.mockRestore();
      }
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      const before = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(before.body.history.state).toEqual(historyState);
      if (scenario === 'corrupt-receipt') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (ref.kind !== 'managed-file_history') return bytes;
            const record = JSON.parse(bytes.toString('utf8'));
            record.undoReceipts = [
              {
                requestId: randomUUID(),
                promptId: PROMPT_ID,
                filesChanged: ['missing.txt'],
                conflict: false,
              },
            ];
            return Buffer.from(JSON.stringify(record));
          });
        const log = vi
          .spyOn(stdio, 'writeStderrLineSafe')
          .mockImplementation(() => {});
        const detail =
          'Invalid Hosted file history undo receipt 0: filesChanged must contain only tracked paths.';
        const failed = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(failed.status).toBe(503);
        expect(failed.body).toEqual({
          error: 'hosted_file_history_failed',
          code: 'hosted_file_history_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted file history read failed: Error: ${detail}`,
        );
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', clientId)
          .send({})
          .expect(204);
        log.mockClear();
        const failedLoad = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store(), toolProfile: files });
        expect(failedLoad.status).toBe(503);
        expect(failedLoad.body).toEqual({
          error: 'managed_session_open_failed',
          code: 'managed_session_open_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted Session open failed: Error: ${detail}`,
        );
        fault.mockRestore();
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({ managedSessionStore: store(), toolProfile: files })
          .expect(200);
        await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).expect(204);
        return;
      }
      if (releaseFails)
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockRejectedValueOnce(new Error('release response lost'));
      const request = { promptId: PROMPT_ID, requestId: randomUUID() };
      const undo = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/files/rewind`))
          .set('X-Qwen-Client-Id', clientId)
          .send(request);
      const physicalUndo = control.getMockImplementation()!;
      let rewinds = 0;
      control.mockImplementation(async (operation) => {
        if (operation.action === 'rewind') {
          const pending = await headers(
            supertest(server).get(`/session/${SESSION_ID}/files/history`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(pending.body.history.pendingUndo).toEqual({
            requestId: expect.any(String),
            promptId: operation.promptId,
          });
          if (rewinds++ === 0) {
            expect(pending.body.history.pendingUndo).toEqual(request);
            expect(pending.body.history.state).toEqual(historyState);
          }
        }
        return physicalUndo(operation);
      });
      if (scenario === 'closing') {
        const releaseActivation =
          LocalManagedSessionAuthority.prototype.releaseActivation;
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let closing = false;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'releaseActivation',
        ).mockImplementation(async function (
          this: LocalManagedSessionAuthority,
          ...args
        ) {
          closing = true;
          await pending;
          return releaseActivation.apply(this, args);
        });
        const closed = headers(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .then((response) => response);
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const controls = control.mock.calls.length;
        try {
          await waitFor(() => expect(closing).toBe(true));
          const refused = await undo();
          expect(refused.status).toBe(409);
          expect(refused.body.code).toBe('hosted_mcp_operation_active');
          expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
            acquisitions,
          );
          expect(control).toHaveBeenCalledTimes(controls);
        } finally {
          finish();
          expect((await closed).status).toBe(204);
        }
        return;
      }
      if (
        scenario !== 'success' &&
        scenario !== 'conflict' &&
        scenario !== 'release' &&
        scenario !== 'old-history-unavailable'
      ) {
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
        const acquiredBefore = acquire.mock.calls.length;
        const releasedBefore = release.mock.calls.length;
        const retryable = ['busy', 'bind', 'unsupported', 'capacity'].includes(
          scenario,
        );
        if (scenario === 'warm')
          vi.mocked(HostedWorkspaceBroker.prototype.warm).mockRejectedValueOnce(
            new Error('warm response lost'),
          );
        if (['busy', 'unknown-acquire', 'unknown-released'].includes(scenario))
          acquire.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'busy' ? 409 : 503,
              scenario === 'unknown-released'
                ? 'runtime_session_not_acquirable'
                : 'workspace_busy',
            ),
          );
        if (
          ['bind', 'unsupported', 'unknown-bind', 'refusal-release'].includes(
            scenario,
          )
        )
          control.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'unsupported'
                ? 400
                : scenario === 'unknown-bind'
                  ? 503
                  : 409,
              scenario === 'unsupported'
                ? 'runtime_control_operation_invalid'
                : 'managed_runtime_provider_operation_failed',
            ),
          );
        if (scenario === 'refusal-release')
          release.mockRejectedValueOnce(new Error('release response lost'));
        if (scenario === 'capacity')
          vi.spyOn(
            hostedHistory,
            'assertHostedFileHistoryCapacity',
          ).mockRejectedValueOnce(
            new hostedHistory.HostedFileHistoryRefusedError(
              'capacity exhausted',
            ),
          );
        if (scenario === 'partial') {
          const physical = control.getMockImplementation()!;
          control.mockImplementation(async (operation) => {
            const result = await physical(operation);
            return operation.action === 'rewind'
              ? {
                  state: {
                    ...historyState,
                    files: { ...historyState.files, 'notes.txt': null },
                  },
                  filesChanged: ['notes.txt'],
                  filesFailed: ['other.txt'],
                  conflict: false,
                }
              : result;
          });
        }
        const response = await undo();
        expect(response.status).toBe(retryable ? 409 : 503);
        if (!retryable)
          expect(response.body.code).toBe(
            'hosted_file_history_recovery_required',
          );
        if (scenario === 'capacity')
          expect(response.body.code).toBe(
            'hosted_file_history_capacity_exceeded',
          );
        if (scenario === 'busy')
          expect(response.body.code).toBe('workspace_busy');
        if (scenario === 'bind' || scenario === 'unsupported')
          expect(response.body.code).toBe('hosted_file_history_refused');
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: !retryable,
        });
        const after = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(after.body.history.pendingUndo).toEqual(
          scenario === 'partial' ? request : null,
        );
        expect(after.body.history.state).toEqual(historyState);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(scenario === 'partial' ? 1 : 0);
        expect(acquire).toHaveBeenCalledTimes(
          acquiredBefore + (['capacity', 'warm'].includes(scenario) ? 0 : 1),
        );
        expect(release).toHaveBeenCalledTimes(
          releasedBefore +
            (['bind', 'unsupported', 'refusal-release'].includes(scenario)
              ? 1
              : 0),
        );
        if (retryable) {
          if (scenario === 'bind' || scenario === 'unsupported') {
            acquire.mockRejectedValueOnce(
              new HostedWorkspaceBrokerRejection(
                409,
                'runtime_session_not_acquirable',
              ),
            );
            const reused = await undo();
            expect(reused.status).toBe(409);
            expect(reused.body.code).toBe('runtime_session_not_acquirable');
            const stillUsable = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(stillUsable.body.recoveryBlocked).toBe(false);
            request.requestId = randomUUID();
          }
          expect((await undo()).status).toBe(200);
          expect((await undo()).status).toBe(200);
          expect(
            control.mock.calls.filter(([op]) => op.action === 'rewind'),
          ).toHaveLength(1);
        }
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
        return;
      }
      const response = await undo();
      expect(response.status).toBe(releaseFails ? 503 : conflict ? 409 : 200);
      if (releaseFails)
        expect(response.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      const after = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(after.body.history.pendingUndo).toEqual(
        releaseFails ? request : null,
      );
      expect(after.body.history.state.files).toEqual(
        conflict ? historyState.files : { 'notes.txt': null },
      );
      expect(after.body.history.undoReceipts).toEqual([
        {
          ...request,
          filesChanged: conflict ? [] : ['notes.txt'],
          conflict,
        },
      ]);
      if (!releaseFails) {
        const replay = await undo();
        expect(replay.status).toBe(conflict ? 409 : 200);
        expect(replay.body).toEqual(response.body);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(1);
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, requestId: randomUUID() })
          .expect(conflict ? 409 : 200);
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const acquisitions = acquire.mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(acquire).toHaveBeenCalledTimes(acquisitions);

        const anotherPrompt = randomUUID();
        historyState.snapshots.push({
          ...historyState.snapshots[0],
          promptId: anotherPrompt,
        });

        writePromptId = randomUUID();
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: writePromptId,
            prompt,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        });
        expect((await undo()).body).toEqual(response.body);
        const controls = control.mock.calls.length;
        const acquired = acquire.mock.calls.length;
        const mismatched = await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ ...request, promptId: anotherPrompt });
        expect(mismatched.status).toBe(409);
        expect(mismatched.body.code).toBe('hosted_file_rewind_conflict');
        expect(control).toHaveBeenCalledTimes(controls);
        expect(acquire).toHaveBeenCalledTimes(acquired);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(2);
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      const reopened = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(reopened.status).toBe(releaseFails ? 409 : 200);
      if (releaseFails)
        expect(reopened.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      else {
        clientId = reopened.body.clientId as string;
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );
});

describe('Hosted Harness Runtime turn takeover', () => {
  const BOOT_ID_2 = '77777777-7777-4777-8777-777777777777';

  /** Captured per parked turn so tests can assert which loads acquire the
   * Runtime lease: a cold load never does, a passive takeover adopts it. */
  let acquireSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  function replacementApp() {
    const result = express();
    result.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID_2,
    );
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    return result;
  }

  function replacementHeaders<T extends supertest.Test>(request: T): T {
    return request
      .set('X-Qwen-Harness-Protocol-Version', '1')
      .set('X-Qwen-Harness-Boot-Id', BOOT_ID_2);
  }

  function storeFor(writerId: string) {
    return { ...store(), writerId };
  }

  const FILE_PROFILE = 'hosted-workspace-files/1';
  const CALL = {
    name: 'write_file',
    callId: 'call-1',
    args: { file_path: 'a.txt', content: 'x' },
    isClientInitiated: false,
    prompt_id: PROMPT_ID,
  };

  /**
   * Drives a Workspace turn to its parked await_runtime checkpoint: the Broker
   * execute hangs until the owner is "crashed" via cancel, leaving the turn
   * unsettled in the journal.
   */
  async function parkToolTurn() {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
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
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled(), {
      timeout: 10_000,
    });
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
      { timeout: 10_000 },
    );
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    // Only the parked owner's own acquires are behind us; a takeover's
    // acquire must be visible to the asserting test.
    acquireSpy.mockClear();
  }

  async function loadReplacement(passive = false) {
    const server = replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      // Only the coordinator's takeover may drive or report a parked Turn.
      [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
        true,
    });
    return { server, loaded };
  }

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
    const server = replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(execute).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('settles the parked execution on load and continues the turn', async () => {
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
    const clientId = loaded.body.clientId as string;
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
    expect(continued.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
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
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
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
      { timeout: 10_000 },
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

  it('reports a parked execution passively and cancels the turn', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    // The cancellation path adopts the Runtime Session; it still dispatches nothing.
    expect(acquireSpy).toHaveBeenCalled();
    // The adoption is held for the cancel route: loading never releases it.
    expect(release).not.toHaveBeenCalled();
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_runtime');
    expect(recovery.executions).toEqual([
      expect.objectContaining({
        outcome: 'known',
        status: { state: 'prepared' },
      }),
    ]);
    expect(status).toHaveBeenCalled();
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
    expect(cancelled.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The cancelled round's assistant functionCall must meet a journaled
    // tool_result, or the next turn's history is malformed for providers.
    const toolResults = (
      transcript.body.events as Array<{
        type: string;
        data?: {
          record?: {
            type?: string;
            message?: { parts?: Array<{ functionResponse?: { id?: string } }> };
          };
        };
      }>
    ).filter(
      (event) =>
        event.type === 'managed_journal_event' &&
        event.data?.record?.type === 'tool_result',
    );
    expect(
      toolResults.flatMap(
        (event) =>
          event.data?.record?.message?.parts?.map(
            (part) => part.functionResponse?.id,
          ) ?? [],
      ),
    ).toEqual([CALL.callId]);
    // A cancelled recovery must not wedge the session: the next turn runs.
    const nextPromptId = '44444444-4444-4444-8444-444444444444';
    const nextPrompt = [{ type: 'text', text: 'after cancel' }];
    const next = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(next.status).toBe(202);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(later.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
              data: expect.objectContaining({ stopReason: 'end_turn' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // Exactly once, across the whole lifecycle: the cancel route's own
    // release discharges the owed lease with its identity, so the teardown
    // skips what is now a redundant handback.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease owed when the cancel route fails transiently and settles on retry', async () => {
    await parkToolTurn();
    let released = false;
    let stopConfirmed = false;
    let failNextStatus = false;
    // Model the real Broker: once released, the same identity can never be
    // re-acquired and its reads refuse — a stray release must not stay green.
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => {
        if (released)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        if (failNextStatus) {
          failNextStatus = false;
          throw new Error('broker transport blip');
        }
        return { state: stopConfirmed ? 'settled' : 'prepared' };
      },
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // One transient transport failure on the cancel route's first read.
    failNextStatus = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    // The coordinator retries a failed cancel: the adopted lease must stay
    // owed, or the retried takeover can never be driven again.
    expect(release).not.toHaveBeenCalled();
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    // The only handback is the successful retry's own.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the adoption owed through a failed terminal write and settles on the redriven cancel', async () => {
    await parkToolTurn();
    // The parked execution already settled before the owner died: the
    // cancel only has to confirm it, settle the Turn, and release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failTerminalWrite = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (failTerminalWrite && record.subtype === 'turn_result') {
          failTerminalWrite = false;
          throw new Error('store hiccup');
        }
        return originalWrite.call(this, record);
      },
    );
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // A store hiccup on the terminal turn_result write only. Releasing the
    // adopted session before that write would leave the Turn unsettled with
    // its identity RELEASED — no retry could ever re-acquire it.
    failTerminalWrite = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    expect(release).not.toHaveBeenCalled();
    // The first attempt advanced the checkpoint before the write failed, so
    // the redriven cancel still carries the load-time snapshot. The daemon
    // never re-loads an attached Session, so the route re-admits it against
    // the current checkpoint — the owed, still-READY lease stays acquirable
    // for exactly this retry.
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    // The retry released once, after the terminal record landed.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A replayed cancel replays at the admission watermark it was admitted
    // under, same as before.
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(retried.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the lease owed when the takeover load cannot verify workspace writes', async () => {
    await parkToolTurn();
    let released = false;
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    // The restore-stage write probe passes, so the passive takeover adopts
    // first; the post-recovery probe then rejects once.
    state.assertWritable
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('writer lost'));
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(acquireSpy).toHaveBeenCalled();
    // The refusal invited a retried takeover load: the adopted lease must
    // stay owed — but never silently, since a Session closed before
    // registration leaves no route to hand it back.
    expect(release).not.toHaveBeenCalled();
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    expect(owedLines()).toHaveLength(1);
    // The retried takeover on the same daemon re-acquires the READY
    // identity idempotently and reports.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeDefined();
    expect(owedLines()).toHaveLength(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('records the owed adoption when every takeover load refuses the workspace writes', async () => {
    await parkToolTurn();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    // The probe rejects after every adoption, on every attempt: the refusal
    // is persistent, so the same daemon keeps refusing.
    let probeCalls = 0;
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    const second = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(second.status).toBe(409);
    // Every refused attempt re-adopts the same READY identity — never
    // releasing it, or the wedge this PR removes would reopen — while the
    // stranded adoption is reported exactly once per identity, by name.
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(owedLines()).toHaveLength(1);
    // The next successful load drains the record, so a later refusal must
    // report again rather than stay silent on a stale one.
    state.assertWritable.mockImplementation(async () => undefined);
    probeCalls = 0;
    const third = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(third.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    probeCalls = 0;
    const fourth = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(fourth.status).toBe(409);
    expect(owedLines()).toHaveLength(2);
    // Only the successful Session's own teardown released anything.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease owed when the cancel meets a blocked session', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(new Error('handback refused'))
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    // Drive the recovered turn, then flip the session blocked with an
    // unrecoverable write — same mechanism the continuation fixture uses.
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
      { timeout: 10_000 },
    );
    // The continuation's teardown handback refused, so the recovered lease
    // is still owed when the blocked refusal runs.
    expect(release).toHaveBeenCalledTimes(1);
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
    // The blocked refusal must not hand back an owed lease: the workspace
    // outlives this refusal, and a RELEASED identity can never be
    // re-acquired by the retirement-time retry.
    expect(release).toHaveBeenCalledTimes(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('answers a settled cancellation even when the final handback fails', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(new Error('broker unreachable'))
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The terminal record is durable before the handback runs, so a release
    // failure must not refuse an already-settled cancellation.
    const cancelled = await cancelTurn();
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The admission survives the failed handback: a replay still replays at
    // its watermark, and the replay discharges the owed lease — the failed
    // handback (call 1) plus the replay's own (call 2).
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(cancelled.body.lastEventId);
    expect(release).toHaveBeenCalledTimes(2);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // The teardown must not re-release an already-discharged lease.
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('refuses to settle a cancellation the Broker never confirmed', async () => {
    await parkToolTurn();
    // The cancel is accepted but the stop can never be observed: the
    // execution state becomes unreadable right after it.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValueOnce({ state: 'prepared' })
      .mockResolvedValueOnce({ state: 'executing' })
      .mockRejectedValue(new Error('broker gone'));
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
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
    expect(cancelled.status).toBe(503);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // No terminal record may land while the stop is unconfirmed.
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses cancel with a mismatched recovery identity', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'ckpt-from-another-epoch',
        activationId: 'activation-from-another-epoch',
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(cancel).not.toHaveBeenCalled();
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (transcript.body.events as Array<{ type: string }>).filter(
        (event) => event.type === 'turn_complete',
      ),
    ).toHaveLength(0);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost cancel admission at its watermark while it runs', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    // Hold the cancel's confirmation open so the replay meets it in flight.
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      () => cancelGate,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const first = send();
    first.then((r) =>
      console.error(
        'PROBE first cancel status',
        r.status,
        JSON.stringify(r.body),
      ),
    );
    // The first cancel is admitted and its broker confirmation is still open.
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(true);
      },
      { timeout: 10_000 },
    );
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    stopConfirmed = true;
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(answered.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('continues a turn parked in a second tool round without corrupting history', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
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
      { timeout: 10_000 },
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
      { timeout: 10_000 },
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
      { timeout: 10_000 },
    );
    const continuedCall = state.model.mock.calls.find(
      (call) =>
        (call[0] as { resumeFromToolResults?: unknown })
          .resumeFromToolResults !== undefined,
    );
    expect(continuedCall).toBeDefined();
    const input = continuedCall![0] as unknown as {
      history: Array<{ type: string }>;
      resumeFromToolResults: unknown[];
    };
    // Round one's tool result stays in history; only the parked round's
    // result becomes the resume request. Assert on the tool_result records —
    // the assistant record carries call-a's functionCall either way.
    const historyResults = input.history.filter(
      (entry) => entry.type === 'tool_result',
    );
    expect(JSON.stringify(historyResults)).toContain('call-a');
    expect(JSON.stringify(historyResults)).not.toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).not.toContain('call-a');
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

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
      { timeout: 10_000 },
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

  it('clears the pending file history when a recovered Write continuation answers with text', async () => {
    await parkToolTurn();
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
      },
      { timeout: 10_000 },
    );
    const historyAfter = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(historyAfter.body.history.pendingTurn).toBeNull();
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
  });

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
      { timeout: 10_000 },
    );
    // "accepted" is the only signal the coordinator ever got, but the Turn
    // will never settle — the replay must surface the refusal instead.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
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
      timeout: 10_000,
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
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });
});
