/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
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
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
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

const state = vi.hoisted(() => ({
  root: '',
  assertWritable: vi.fn(async () => undefined),
  toolResults: null as DurableToolResultResourceStore | null,
  publicationRequest: vi.fn(),
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
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

function app(withBroker = false) {
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
  return result;
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
  const server = app(true);
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
    const server = app();
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
      const server = app(true);
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
      const server = app(true);
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
      (await headers(supertest(app()).post('/session')).send(body)).status,
    ).toBe(400);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const server = app(true);
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
      const server = app(true);
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

  it('distinguishes strict create and load outcomes', async () => {
    const server = app();
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
    const server = app(true);
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
    const server = app(true);
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
    const server = app(true);
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
    const server = app(true);
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
      const server = app(true);
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
      const server = app(true);
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
    const server = app(true);
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
    const server = app();
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
    const server = app();
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
    const listener = server.listen(0);
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
      listener.close();
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
    const server = app();
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
    const server = app();
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

  it('rejects an oversized complete assistant record before acquisition and permits retry and reload', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const server = app(true);
    const toolProfile = 'hosted-workspace-files/1';
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile,
    });
    expect(created.status).toBe(200);
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
          { text: 'x'.repeat(65_100) },
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
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
  });

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
    const server = app(true);
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
    'workspace_busy',
    'workspace_unavailable',
    'partial',
    'managed_runtime_provider_operation_failed',
    'runtime_control_operation_invalid',
  ])(
    'preserves the original Shell receipt and continuation across %s recovery',
    async (refusalCode) => {
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
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
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
      const first = app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      });
      expect(created.status).toBe(200);
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
        expect(status.body.recoveryBlocked).toBe(true);
      });
      expect(failed).toBe(true);
      expect(acknowledge).not.toHaveBeenCalled();
      await headers(supertest(first).delete('/session/' + SESSION_ID)).expect(
        204,
      );
      const second = app(true);
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
      expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
      expect(state.model).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
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
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('runtime_execution_conflict'),
      );
      await headers(supertest(second).delete('/session/' + SESSION_ID)).expect(
        204,
      );
      failFinalSettlement = false;
      const third = app(true);
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
      const fourth = app(true);
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
    const first = app(true);
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
    const second = app(true);
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
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const listener = server.listen(0);
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
      listener.close();
    }
  });

  it('stops writing an event stream after backpressure ends it', async () => {
    const server = app();
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
    const listener = server.listen(0);
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
      listener.close();
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
    const server = app();
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
      const server = app();
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
    const server = app(true);
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
    const server = app();
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

  it('settles a cancelled turn when writing its user record fails once', async () => {
    const server = app();
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
    const server = app();
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
    const server = app(true);
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
        supertest(app(true)).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_tool_profile_conflict');
    },
  );

  it('keeps a yolo tool Session definition unchanged', async () => {
    const created = await headers(supertest(app(true)).post('/session')).send({
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
    const server = app(true);
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
    const server = app(true);
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
    'closing',
    'old-history-unavailable',
    'release',
    'busy',
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
      const historyState = {
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
      const control = vi
        .mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockImplementation(async (operation) =>
          operation.action === 'rewind'
            ? {
                state: { ...historyState, files: { 'notes.txt': null } },
                filesChanged: ['notes.txt'],
                filesFailed: [],
                conflict: false,
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
      const server = app(true);
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
      if (releaseFails)
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockRejectedValueOnce(new Error('release response lost'));
      const request = { promptId: PROMPT_ID, requestId: randomUUID() };
      const undo = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/files/rewind`))
          .set('X-Qwen-Client-Id', clientId)
          .send(request);
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
          control.mockImplementation(async (operation) =>
            operation.action === 'rewind'
              ? {
                  state: historyState,
                  filesChanged: [],
                  filesFailed: ['notes.txt'],
                  conflict: false,
                }
              : physical(operation),
          );
        }
        const response = await undo();
        expect(response.status).toBe(retryable ? 409 : 503);
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
          acquiredBefore + (scenario === 'capacity' ? 0 : 1),
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
      expect(response.status).toBe(releaseFails ? 503 : 200);
      const after = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(after.body.history.pendingUndo).toEqual(
        releaseFails ? request : null,
      );
      if (!releaseFails) {
        expect((await undo()).body).toEqual(response.body);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(1);
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, requestId: randomUUID() })
          .expect(200);
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const acquisitions = acquire.mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(acquire).toHaveBeenCalledTimes(acquisitions);

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
