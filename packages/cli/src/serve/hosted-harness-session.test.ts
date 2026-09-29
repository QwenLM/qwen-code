/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';
import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import * as stdio from '../utils/stdioHelpers.js';

const state = vi.hoisted(() => ({
  root: '',
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
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
    }) => ({
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: options.sessionKey.sessionId,
        transcriptPath: path.join(
          state.root,
          `${options.sessionKey.sessionId}.jsonl`,
        ),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      }),
      close: async () => undefined,
    }),
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

async function mcpApp(unknownConfigure = false) {
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
    mcpServers: [
      {
        serverId: 'demo',
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      },
    ],
  });
  expect(created.status).toBe(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
  return { server, authorize, requests, replies, brokerOwners };
}

describe('Hosted Harness no-tool session', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
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

  it('refuses prompt, configuration and resource admission while MCP close is pending', async () => {
    const { server, authorize } = await mcpApp();
    const resource = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      });
    expect((await resource()).status).toBe(202);
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
  ])(
    'rejects an empty MCP name or URI before committing or dispatching: %j',
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
      expect((await toolTurn!.declarations()).map((tool) => tool.name)).toEqual(
        ['read_file', 'write_file', 'edit', 'run_shell_command'],
      );
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
      await vi.waitFor(async () => {
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
      });
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
      await vi.waitFor(async () => {
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
      });
      expect(state.model).toHaveBeenCalledTimes(modelCalls + 1);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

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
