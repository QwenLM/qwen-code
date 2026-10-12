/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { ManagedOperationGrantGate } from '@qwen-code/qwen-code-core/managed-runtime/managed-operation-grant-gate.js';
import {
  parseMcpConfiguration,
  parseMcpOperation,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-record.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import {
  HostedMcpSession,
  HostedMcpRecoveryRequiredError,
  parseHostedMcpServers,
} from './hosted-mcp-session.js';
import { parseManagedRuntimeProviderRequest } from './managed-runtime-provider-protocol.js';

let root: string;
let session: ManagedSession;
let mcp: HostedMcpSession;
let requests: ManagedMcpControl[];
let replies: Map<string, ManagedMcpOperationView>;
let loseAck: boolean;
let unknown: boolean;
const pin = {
  serverId: 'demo',
  serverRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
const rawResponse = {
  contents: [
    {
      uri: 'memory://blob',
      mimeType: 'application/octet-stream',
      blob: 'AAH/',
    },
  ],
  _meta: { marker: 'complete' },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-hosted-mcp-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  requests = [];
  replies = new Map();
  loseAck = false;
  unknown = false;
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'control').mockImplementation(
    async (operation) => {
      requests.push(operation);
      if (operation.kind === 'mcp-status' || operation.kind === 'mcp-cancel') {
        if (operation.kind === 'mcp-cancel')
          expect(
            parseMcpOperation(
              session.authority.extensionRecord(
                'mcp_operation',
                operation.targetOperationId,
              )!.record,
            ).cancelRequested,
          ).toBe(true);
        return (
          replies.get(operation.targetOperationId) ?? {
            operationId: operation.targetOperationId,
            state: 'outcome_unknown',
          }
        );
      }
      if (!('grant' in operation)) throw new Error('Missing grant');
      const domain =
        operation.kind === 'mcp-invoke' ? 'mcp_operation' : 'mcp_configuration';
      const record = session.authority.extensionRecord(
        domain,
        operation.grant.operationId,
      );
      expect(record).toBeDefined();
      if (operation.kind === 'mcp-release')
        expect(parseMcpConfiguration(record!.record).releaseState).toBe(
          'releasing',
        );
      else if (operation.kind !== 'mcp-discover')
        expect(record!.run.execution).toBe('dispatch_started');
      let view: ManagedMcpOperationView;
      if (operation.kind === 'mcp-configure') {
        view = {
          operationId: operation.operationId,
          state: 'settled',
          catalog: {
            serverId: operation.serverId,
            serverRevision: operation.serverRevision,
            definitionDigest: operation.definitionDigest,
            configRevision: operation.configRevision,
            connectionGeneration: operation.configRevision,
            catalogRevision: operation.configRevision,
            tools: [
              {
                name: 'echo',
                description: 'Echo input',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
            resources: [{ name: 'blob', uri: 'memory://blob' }],
            prompts: [{ name: 'greet' }],
            discovery: {
              tools: 'complete',
              resources: 'complete',
              prompts: 'complete',
            },
          },
        };
      } else if (operation.kind === 'mcp-discover') {
        view = {
          operationId: operation.operationId,
          state: 'settled',
          catalog: replies.get(operation.grant.operationId)!.catalog,
        };
      } else if (operation.kind === 'mcp-invoke') {
        view = {
          operationId: operation.operationId,
          state: unknown ? 'outcome_unknown' : 'settled',
          ...(unknown ? {} : { response: rawResponse }),
        };
      } else
        view = {
          operationId: operation.operationId,
          state: 'settled',
          response: { released: true },
        };
      replies.set(operation.operationId, view);
      if (loseAck) {
        loseAck = false;
        throw new TypeError('lost reply');
      }
      return view;
    },
  );
  mcp = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await session?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it('pins discovery, commits raw resource results and replays without another effect', async () => {
  const operationId = randomUUID();
  const request = { kind: 'resource_read' as const, uri: 'memory://blob' };
  const response = await mcp.invoke(operationId, 'demo', request);
  expect(response.response).toEqual(rawResponse);
  expect(mcp.tools()).toHaveLength(1);
  expect(
    mcp.toolInput(mcp.tools()[0].name!, { text: 'hello' }, 'tool-1'),
  ).toMatchObject({
    toolName: 'managed_mcp_call',
    input: {
      serverId: 'demo',
      connectionGeneration: 1,
      request: {
        kind: 'tool_call',
        name: 'echo',
        arguments: { text: 'hello' },
      },
    },
  });
  expect(await mcp.invoke(operationId, 'demo', request)).toEqual(response);
  expect(
    requests.filter((request) => request.kind === 'mcp-invoke'),
  ).toHaveLength(1);
  expect(session.authority.taskViews()).toEqual([]);
  expect(
    (await session.sink.project()).some(
      (entry) => entry.type === 'tool_result',
    ),
  ).toBe(false);
  await expect(
    mcp.invoke(operationId, 'demo', { kind: 'resource_read', uri: 'other' }),
  ).rejects.toThrow('conflicts');
  await mcp.close();
  expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
});

it('queries a lost configure reply by its original identity instead of reconnecting', async () => {
  loseAck = true;
  await mcp.ensureReady();
  expect(requests.map((request) => request.kind)).toEqual([
    'mcp-configure',
    'mcp-status',
  ]);
  expect(requests[1]).toMatchObject({
    targetOperationId: requests[0].operationId,
  });
});

async function interruptBeforeDispatch(operationId: string) {
  await mcp.ensureReady();
  const original = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  const commit = vi.spyOn(session.authority, 'commitExtensionRecord');
  commit.mockImplementation(async (...args) => {
    if (
      args[1].domain === 'mcp_operation' &&
      parseMcpOperation(args[1].record).run.execution === 'dispatch_started'
    )
      throw new Error('dispatch commit failed');
    return original(...args);
  });
  await expect(
    mcp.invoke(operationId, 'demo', {
      kind: 'resource_read',
      uri: 'memory://blob',
    }),
  ).rejects.toThrow('dispatch commit failed');
  commit.mockRestore();
  expect(requests.filter((entry) => entry.kind === 'mcp-invoke')).toHaveLength(
    0,
  );
}

it('resumes an unsent operation after a failed dispatch commit and a status query', async () => {
  const operationId = randomUUID();
  await interruptBeforeDispatch(operationId);
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  expect(await reloaded.status(operationId)).toEqual({
    operationId,
    state: 'running',
  });
  expect(
    session.authority.extensionRecord('mcp_operation', operationId)!.run
      .execution,
  ).toBe('intent');
  const response = await reloaded.invoke(operationId, 'demo', {
    kind: 'resource_read',
    uri: 'memory://blob',
  });
  expect(response.response).toEqual(rawResponse);
  expect(
    requests
      .filter((entry) => entry.kind === 'mcp-invoke')
      .map((entry) => entry.operationId),
  ).toEqual([operationId]);
  expect(reloaded.hasPendingOperations()).toBe(false);
  await reloaded.close();
});

it('cancels an unsent operation durably without invoking it on a later retry', async () => {
  const operationId = randomUUID();
  await interruptBeforeDispatch(operationId);
  const cancelled = await mcp.cancel(operationId);
  expect(cancelled).toEqual({
    operationId,
    state: 'settled',
    error: { code: 'managed_mcp_cancelled' },
  });
  expect(
    session.authority.extensionRecord('mcp_operation', operationId)!.run,
  ).toMatchObject({
    state: 'cancelled',
    execution: 'not_started_proven',
  });
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  expect(
    await reloaded.invoke(operationId, 'demo', {
      kind: 'resource_read',
      uri: 'memory://blob',
    }),
  ).toEqual(cancelled);
  expect(await reloaded.cancel(operationId)).toEqual(cancelled);
  expect(
    requests.filter(
      (entry) => entry.kind === 'mcp-invoke' || entry.kind === 'mcp-cancel',
    ),
  ).toHaveLength(0);
  expect(reloaded.hasPendingOperations()).toBe(false);
  await reloaded.close();
});

it.each([false, true])(
  'replays a committed result without reconnecting after reload (released: %s)',
  async (released) => {
    const operationId = randomUUID();
    const request = { kind: 'resource_read' as const, uri: 'memory://blob' };
    const response = await mcp.invoke(operationId, 'demo', request);
    if (released) await mcp.close();
    const reloaded = new HostedMcpSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      [pin],
    );
    vi.mocked(HostedWorkspaceBroker.prototype.acquire)
      .mockClear()
      .mockRejectedValue(new Error('Runtime unavailable'));
    vi.mocked(HostedWorkspaceBroker.prototype.control)
      .mockClear()
      .mockRejectedValue(new Error('Runtime unavailable'));
    expect(await reloaded.invoke(operationId, 'demo', request)).toEqual(
      response,
    );
    expect(await reloaded.status(operationId)).toEqual(response);
    await expect(
      reloaded.invoke(operationId, 'demo', { ...request, uri: 'different' }),
    ).rejects.toThrow('conflicts');
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.control).not.toHaveBeenCalled();
  },
);

it('commits its owner identity before acquiring and resumes a never-dispatched intent', async () => {
  vi.spyOn(session.authority, 'commitExtensionRecord').mockRejectedValueOnce(
    new Error('store unavailable'),
  );
  await expect(mcp.ensureReady()).rejects.toThrow('store unavailable');
  await mcp.close();
  expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
  expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
  vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockRejectedValueOnce(
    new Error('lost acquire reply'),
  );
  await expect(mcp.ensureReady()).rejects.toThrow('lost acquire reply');
  const intent = parseMcpConfiguration(
    session.authority.extensionRecordsInDomain('mcp_configuration')[0].record,
  );
  expect(intent.run.execution).toBe('intent');
  expect(intent.run.runtime).toBeNull();
  expect(requests).toHaveLength(0);
  await mcp.ensureReady();
  expect(
    requests
      .filter((entry) => entry.kind === 'mcp-configure')
      .map((entry) => entry.operationId),
  ).toEqual([intent.configurationId]);
  await mcp.close();
});

it('reconciles a temporarily unknown configuration without repeating its effect', async () => {
  const control = HostedWorkspaceBroker.prototype.control;
  const physical = vi.mocked(control).getMockImplementation()!;
  vi.mocked(control).mockImplementationOnce(async (operation) => {
    await physical(operation);
    return { operationId: operation.operationId, state: 'outcome_unknown' };
  });
  await expect(mcp.ensureReady()).rejects.toThrow('reconciliation');
  const unknownRecord =
    session.authority.extensionRecordsInDomain('mcp_configuration')[0];
  vi.mocked(control).mockImplementationOnce(async (operation) => ({
    operationId: operation.operationId,
    state: 'running',
  }));
  await expect(mcp.ensureReady()).rejects.toThrow('reconciliation');
  expect(
    session.authority.extensionRecordsInDomain('mcp_configuration')[0],
  ).toEqual(unknownRecord);
  await mcp.ensureReady();
  expect(
    requests.filter((entry) => entry.kind === 'mcp-configure'),
  ).toHaveLength(1);
  expect(mcp.getCatalogs()).toHaveLength(1);
  await mcp.close();
});

it.each(['settled', 'failed'] as const)(
  'reconciles an unknown initial configuration during close after its original result is %s',
  async (outcome) => {
    const control = HostedWorkspaceBroker.prototype.control;
    const physical = vi.mocked(control).getMockImplementation()!;
    vi.mocked(control).mockImplementationOnce(async (operation) => {
      await physical(operation);
      if (outcome === 'failed')
        replies.set(operation.operationId, {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_connection_failed' },
        });
      return { operationId: operation.operationId, state: 'outcome_unknown' };
    });
    await expect(mcp.ensureReady()).rejects.toThrow('reconciliation');
    const initialId = requests[0].operationId;
    const original = replies.get(initialId)!;
    replies.set(initialId, { operationId: initialId, state: 'running' });
    await expect(mcp.close()).rejects.toThrow('reconciliation');
    expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
    replies.set(initialId, original);
    await mcp.close();
    expect(
      requests.filter((entry) => entry.kind === 'mcp-configure'),
    ).toHaveLength(1);
    expect(
      requests.filter((entry) => entry.kind === 'mcp-release'),
    ).toHaveLength(outcome === 'settled' ? 1 : 0);
    expect(
      parseMcpConfiguration(
        session.authority.extensionRecordsInDomain('mcp_configuration')[0]
          .record,
      ),
    ).toMatchObject({
      releaseState: 'released',
      run: { state: outcome, execution: 'settled' },
    });
  },
);

it('reconciles an older unknown configuration during close after a legacy writer installed a newer revision', async () => {
  const control = HostedWorkspaceBroker.prototype.control;
  const physical = vi.mocked(control).getMockImplementation()!;
  vi.mocked(control).mockImplementationOnce(async (operation) => {
    await physical(operation);
    return { operationId: operation.operationId, state: 'outcome_unknown' };
  });
  await expect(mcp.ensureReady()).rejects.toThrow('reconciliation');
  const initialId = requests[0].operationId;
  // Reproduce history accepted before the pending-configuration admission gate.
  await (
    mcp as unknown as {
      install: (
        server: typeof pin,
        previous: undefined,
        id: string,
        revision: number,
      ) => Promise<void>;
    }
  ).install(pin, undefined, randomUUID(), 2);
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  await reloaded.close();
  expect(
    requests.filter((entry) => entry.kind === 'mcp-configure'),
  ).toHaveLength(2);
  expect(
    requests.some(
      (entry) =>
        entry.kind === 'mcp-status' && entry.targetOperationId === initialId,
    ),
  ).toBe(true);
  expect(requests.filter((entry) => entry.kind === 'mcp-release')).toHaveLength(
    2,
  );
  expect(
    session.authority
      .extensionRecordsInDomain('mcp_configuration')
      .map((entry) => parseMcpConfiguration(entry.record).releaseState),
  ).toEqual(['released', 'released']);
});

it.each([false, true])(
  'closes a never-dispatched configuration after workspace admission is refused (interrupted drain commit: %s)',
  async (interrupted) => {
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockRejectedValue(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
    await expect(mcp.ensureReady()).rejects.toThrow('workspace_busy');
    if (interrupted) {
      const commit = session.authority.commitExtensionRecord.bind(
        session.authority,
      );
      const save = vi
        .spyOn(session.authority, 'commitExtensionRecord')
        .mockImplementation(async (...args) => {
          if (
            args[1].domain === 'mcp_configuration' &&
            parseMcpConfiguration(args[1].record).releaseState === 'drained'
          )
            throw new Error('drain commit interrupted');
          return commit(...args);
        });
      await expect(mcp.close()).rejects.toThrow('drain commit interrupted');
      save.mockRestore();
      mcp = new HostedMcpSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        [pin],
      );
    }
    await mcp.close();
    const configuration = parseMcpConfiguration(
      session.authority.extensionRecordsInDomain('mcp_configuration')[0].record,
    );
    expect(configuration).toMatchObject({
      releaseState: 'released',
      run: { state: 'cancelled', execution: 'not_started_proven' },
    });
    expect(requests).toEqual([]);
    expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledOnce();
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
  },
);

it('publishes a new immutable configuration after catalog invalidation, without replacing old pins', async () => {
  await mcp.ensureReady();
  const original = mcp.getCatalogs()[0];
  const name = mcp.tools()[0].name!;
  const physical = vi
    .mocked(HostedWorkspaceBroker.prototype.control)
    .getMockImplementation()!;
  let stale = true;
  vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
    async (operation) => {
      const response = await physical(operation);
      if (operation.kind === 'mcp-discover' && stale) {
        stale = false;
        return { ...response, catalog: { ...original, catalogRevision: 2 } };
      }
      return response;
    },
  );
  await mcp.refresh();
  expect(mcp.getCatalogs()[0].configRevision).toBe(2);
  expect(mcp.toolInput(name, {}, 'old-call')?.input.configRevision).toBe(1);
  await mcp.refresh();
  expect(mcp.getCatalogs()[0].configRevision).toBe(2);
  expect(
    requests.filter((entry) => entry.kind === 'mcp-configure'),
  ).toHaveLength(2);
});

it('can replace an initial definition that failed before any catalog was published', async () => {
  const physical = vi
    .mocked(HostedWorkspaceBroker.prototype.control)
    .getMockImplementation()!;
  vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
    async (operation) => {
      const response = await physical(operation);
      if (
        operation.kind === 'mcp-configure' &&
        operation.serverRevision === 1
      ) {
        const failed: ManagedMcpOperationView = {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_connection_failed' },
        };
        replies.set(operation.operationId, failed);
        return failed;
      }
      return response;
    },
  );
  await expect(mcp.ensureReady()).rejects.toThrow('configuration failed');
  await mcp.configure(randomUUID(), { ...pin, serverRevision: 2 }, 1);
  await mcp.ensureReady();
  expect(mcp.getCatalogs()[0].serverRevision).toBe(2);
  expect(
    requests
      .filter((entry) => entry.kind === 'mcp-configure')
      .map((entry) => entry.serverRevision),
  ).toEqual([1, 2]);
});

it.each(['refresh', 'close'] as const)(
  'renews committed grants before %s after an idle Harness restart',
  async (action) => {
    const gate = new ManagedOperationGrantGate();
    const physical = vi
      .mocked(HostedWorkspaceBroker.prototype.control)
      .getMockImplementation()!;
    vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
      async (operation) => {
        if ('grant' in operation) gate.install(operation.grant);
        return physical(operation);
      },
    );
    await mcp.refresh();
    const sessionKey = session.authority.sessionHeader.sessionKey;
    const configuration =
      session.authority.extensionRecordsInDomain('mcp_configuration')[0];
    await session.close();
    session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'session.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'test',
      workerId: 'replacement-worker',
      activationLeaseDurationMs: 60_000,
    });
    const restored = new HostedMcpSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      [pin],
    );
    await restored[action]();
    expect(
      session.authority.extensionRecordsInDomain('mcp_configuration')[0]
        .revision,
    ).toBeGreaterThan(configuration.revision);
    expect(
      requests.filter((entry) => entry.kind === 'mcp-configure'),
    ).toHaveLength(1);
  },
);

it('restores the original owner before close and uses fresh identities after confirmed release', async () => {
  await mcp.ensureReady();
  const original = mcp.broker.runtimeSessionId;
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  expect(reloaded.broker.runtimeSessionId).toBe(original);
  await reloaded.close();
  expect(requests.filter((entry) => entry.kind === 'mcp-release')).toHaveLength(
    1,
  );
  const identities = new Set([original]);
  for (let round = 0; round < 2; round++) {
    const next = new HostedMcpSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      [pin],
    );
    expect(identities.has(next.broker.runtimeSessionId)).toBe(false);
    identities.add(next.broker.runtimeSessionId);
    await next.ensureReady();
    await next.close();
  }
  for (const runtimeSessionId of identities) {
    expect(() =>
      parseManagedRuntimeProviderRequest({
        protocolVersion: 1,
        providerProtocol: 'managed-runtime-provider/1',
        session: {
          harnessSessionId:
            session.authority.sessionHeader.sessionKey.sessionId,
          runtimeSessionId,
          turnKind: 'bootstrap',
        },
        operation: { kind: 'release' },
      }),
    ).not.toThrow();
  }
});

it('does not bypass durable pending work when a newly loaded Session is closed', async () => {
  unknown = true;
  await mcp.invoke(randomUUID(), 'demo', {
    kind: 'resource_read',
    uri: 'memory://blob',
  });
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  await expect(reloaded.close()).rejects.toThrow('reconciliation');
  expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
});

it('confirms a lost Broker release acknowledgement before marking connections released', async () => {
  await mcp.ensureReady();
  vi.mocked(HostedWorkspaceBroker.prototype.release).mockRejectedValueOnce(
    new Error('lost ack'),
  );
  await expect(mcp.close()).rejects.toThrow('lost ack');
  expect(
    parseMcpConfiguration(
      session.authority.extensionRecordsInDomain('mcp_configuration')[0].record,
    ).releaseState,
  ).toBe('drained');
  const reloaded = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  expect(reloaded.broker.runtimeSessionId).toBe(mcp.broker.runtimeSessionId);
  expect(reloaded.recoveryBlocked).toBe(true);
  vi.mocked(HostedWorkspaceBroker.prototype.acquire)
    .mockClear()
    .mockRejectedValue(new Error('runtime_session_not_ready'));
  vi.mocked(HostedWorkspaceBroker.prototype.control)
    .mockClear()
    .mockRejectedValue(new Error('runtime_session_not_ready'));
  await reloaded.close();
  expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
  expect(HostedWorkspaceBroker.prototype.control).not.toHaveBeenCalled();
  expect(
    parseMcpConfiguration(
      session.authority.extensionRecordsInDomain('mcp_configuration')[0].record,
    ).releaseState,
  ).toBe('released');
  expect(requests.filter((entry) => entry.kind === 'mcp-release')).toHaveLength(
    1,
  );
});

it('does not release the owner until the physical drain receipt is durably committed', async () => {
  await mcp.ensureReady();
  const commit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  const save = vi
    .spyOn(session.authority, 'commitExtensionRecord')
    .mockImplementation(async (...args) => {
      if (
        args[1].domain === 'mcp_configuration' &&
        parseMcpConfiguration(args[1].record).releaseState === 'drained'
      )
        throw new Error('drain receipt commit failed');
      return commit(...args);
    });
  await expect(mcp.close()).rejects.toThrow('drain receipt commit failed');
  expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
  save.mockRestore();
  const owner = mcp.broker.runtimeSessionId;
  mcp = new HostedMcpSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    [pin],
  );
  await mcp.close();
  expect(mcp.broker.runtimeSessionId).toBe(owner);
  expect(requests.filter((entry) => entry.kind === 'mcp-release')).toHaveLength(
    1,
  );
  expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
});

it.each([
  { status: 409, code: 'runtime_session_not_ready', retry: true, held: false },
  {
    status: 409,
    code: 'runtime_session_not_acquirable',
    retry: true,
    held: false,
  },
  { status: 409, code: 'runtime_session_not_ready', retry: true, held: true },
  { status: 503, code: 'runtime_session_not_ready', retry: false, held: false },
  { status: 409, code: 'runtime_admission_closed', retry: false, held: false },
  { status: 409, code: 'runtime_session_conflict', retry: false, held: false },
  { status: 403, code: 'workspace_access_denied', retry: false, held: false },
  { status: 0, code: 'network failure', retry: false, held: false },
])(
  'recovers legacy releasing records only after a closed-owner rejection ($status $code, held: $held)',
  async ({ status, code, retry, held }) => {
    await mcp.ensureReady();
    const saved =
      session.authority.extensionRecordsInDomain('mcp_configuration')[0];
    const record = {
      ...parseMcpConfiguration(saved.record),
      releaseState: 'releasing',
    };
    await session.authority.commitExtensionRecord(
      {
        operation: 'legacy-release',
        commandId: randomUUID(),
        sessionKey: session.authority.sessionHeader.sessionKey,
        contentDigest: 'a'.repeat(64),
      },
      { domain: 'mcp_configuration', record },
      { class: 'trusted_entry' },
    );
    const owner = mcp.broker.runtimeSessionId;
    mcp = new HostedMcpSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      [pin],
    );
    const failure = status
      ? new HostedWorkspaceBrokerRejection(status, code)
      : new Error(code);
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockRejectedValue(
      failure,
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    if (held)
      release.mockRejectedValue(new Error('still owns unfinished work'));
    if (retry && !held) await mcp.close();
    else
      await expect(mcp.close()).rejects.toThrow(
        held ? 'still owns unfinished work' : failure.message,
      );
    expect(mcp.broker.runtimeSessionId).toBe(owner);
    expect(release).toHaveBeenCalledTimes(retry ? 1 : 0);
    expect(
      parseMcpConfiguration(
        session.authority.extensionRecordsInDomain('mcp_configuration')[0]
          .record,
      ).releaseState,
    ).toBe(retry && !held ? 'released' : 'releasing');
    expect(
      requests.filter((entry) => entry.kind === 'mcp-release'),
    ).toHaveLength(0);
  },
);

it('keeps advertised calls on their original catalog when a newer definition is installed', async () => {
  await mcp.ensureReady();
  const name = mcp.tools()[0].name!;
  const second = {
    ...pin,
    serverRevision: 2,
    definitionDigest: 'b'.repeat(64),
  };
  const operationId = randomUUID();
  await mcp.configure(operationId, second, 1);
  expect(mcp.tools()[0].name).not.toBe(name);
  expect(mcp.toolInput(name, { text: 'old' }, 'old-call')?.input).toMatchObject(
    { serverRevision: 1, connectionGeneration: 1 },
  );
  expect(
    mcp.toolInput(mcp.tools()[0].name!, { text: 'new' }, 'new-call')?.input,
  ).toMatchObject({ serverRevision: 2, connectionGeneration: 2 });
  await mcp.configure(operationId, second, 1);
  expect(
    requests.filter((request) => request.kind === 'mcp-configure'),
  ).toHaveLength(2);
  await expect(mcp.configure(randomUUID(), pin, 1)).rejects.toThrow(
    'revision conflicts',
  );
  await mcp.close();
  expect(
    requests.filter((request) => request.kind === 'mcp-release'),
  ).toHaveLength(2);
});

it('advances past a failed replacement revision while retaining the published catalog', async () => {
  await mcp.ensureReady();
  const control = HostedWorkspaceBroker.prototype.control;
  const physical = vi.mocked(control).getMockImplementation()!;
  const failedId = randomUUID();
  vi.mocked(control).mockImplementationOnce(async (operation) => {
    await physical(operation);
    const response = {
      operationId: operation.operationId,
      state: 'settled' as const,
      error: { code: 'managed_mcp_connection_failed' },
    };
    replies.set(operation.operationId, response);
    return response;
  });
  await expect(mcp.configure(failedId, pin, 1)).rejects.toThrow(
    'configuration failed',
  );
  const failedRecord = session.authority.extensionRecord(
    'mcp_configuration',
    failedId,
  )!;
  const failure = replies.get(failedId)!;
  replies.set(failedId, { operationId: failedId, state: 'outcome_unknown' });
  await expect(mcp.configure(failedId, pin, 1)).rejects.toBeInstanceOf(
    HostedMcpRecoveryRequiredError,
  );
  expect(
    session.authority.extensionRecord('mcp_configuration', failedId),
  ).toEqual(failedRecord);
  replies.set(failedId, failure);
  expect(mcp.getCatalogs()[0].configRevision).toBe(1);
  await expect(mcp.configure(randomUUID(), pin, 1)).rejects.toThrow(
    'revision conflicts',
  );
  await mcp.configure(randomUUID(), pin, 2);
  expect(mcp.getCatalogs()[0].configRevision).toBe(3);
  await mcp.close();
});

it('keeps unknown effects blocked, records cancellation, and accepts a known late result', async () => {
  const operationId = randomUUID();
  unknown = true;
  const response = await mcp.invoke(operationId, 'demo', {
    kind: 'prompt_get',
    name: 'greet',
    arguments: {},
  });
  expect(response.state).toBe('outcome_unknown');
  await expect(mcp.close()).rejects.toThrow('reconciliation');
  await mcp.cancel(operationId);
  const committed = parseMcpOperation(
    session.authority.extensionRecord('mcp_operation', operationId)!.record,
  );
  expect(committed.run.execution).toBe('outcome_unknown');
  expect(committed.cancelRequested).toBe(true);
  replies.set(operationId, {
    operationId,
    state: 'settled',
    response: {
      messages: [
        { role: 'user', content: { type: 'text', text: 'one' } },
        { role: 'assistant', content: { type: 'text', text: 'two' } },
      ],
    },
  });
  expect((await mcp.status(operationId)).response?.['messages']).toHaveLength(
    2,
  );
  expect(
    parseMcpOperation(
      session.authority.extensionRecord('mcp_operation', operationId)!.record,
    ).run.state,
  ).toBe('settled');
  expect(
    requests.filter((request) => request.kind === 'mcp-invoke'),
  ).toHaveLength(1);
  await mcp.close();
});

it('refuses duplicate servers, unpinned definitions and credentials in Hosted input', () => {
  expect(parseHostedMcpServers([pin])).toEqual([pin]);
  for (const input of [
    [],
    [pin, pin],
    [{ ...pin, definitionDigest: '' }],
    [{ ...pin, headers: { Authorization: 'secret' } }],
  ])
    expect(() => parseHostedMcpServers(input)).toThrow();
});

it('does not let a stale cancel intent claim not-started after invocation dispatch', async () => {
  await mcp.ensureReady();
  const operationId = randomUUID();
  const request = { kind: 'resource_read' as const, uri: 'memory://blob' };
  await interruptBeforeDispatch(operationId);
  let localReached!: () => void;
  let releaseLocal!: () => void;
  let nativeReached!: () => void;
  let releaseNative!: () => void;
  const readIntent = new Promise<void>((r) => (localReached = r));
  const resumeCancel = new Promise<void>((r) => (releaseLocal = r));
  const dispatched = new Promise<void>((r) => (nativeReached = r));
  const finishNative = new Promise<void>((r) => (releaseNative = r));
  const internal = mcp as unknown as {
    localOperationView: (
      record: ReturnType<typeof parseMcpOperation>,
    ) => Promise<ManagedMcpOperationView | undefined>;
  };
  const local = internal.localOperationView.bind(mcp);
  let pauseFirst = true;
  const barrier = vi
    .spyOn(internal, 'localOperationView')
    .mockImplementation(async (record) => {
      if (pauseFirst) {
        pauseFirst = false;
        localReached();
        await resumeCancel;
      }
      return local(record);
    });
  const physical = vi
    .mocked(HostedWorkspaceBroker.prototype.control)
    .getMockImplementation()!;
  vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
    async (operation) => {
      if (operation.kind === 'mcp-invoke') {
        requests.push(operation);
        nativeReached();
        await finishNative;
        const response = {
          operationId: operation.operationId,
          state: 'settled' as const,
          response: rawResponse,
        };
        replies.set(operation.operationId, response);
        return response;
      }
      if (operation.kind === 'mcp-cancel') {
        requests.push(operation);
        return { operationId: operation.targetOperationId, state: 'running' };
      }
      return physical(operation);
    },
  );
  const cancelling = mcp.cancel(operationId).then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  await readIntent;
  const invoking = mcp.invoke(operationId, 'demo', request).then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  await dispatched;
  const beforeCancel = parseMcpOperation(
    session.authority.extensionRecord('mcp_operation', operationId)!.record,
  );
  releaseLocal();
  expect(await cancelling).toHaveProperty('value.state', 'running');
  const duringNative = parseMcpOperation(
    session.authority.extensionRecord('mcp_operation', operationId)!.record,
  );
  const pendingWhileNative = mcp.hasPendingOperations();
  releaseNative();
  expect(await invoking).toHaveProperty('value.response', rawResponse);
  barrier.mockRestore();
  const final = parseMcpOperation(
    session.authority.extensionRecord('mcp_operation', operationId)!.record,
  );

  expect(beforeCancel.run.execution).toBe('dispatch_started');
  expect(duringNative.run.execution).not.toBe('not_started_proven');
  expect(pendingWhileNative).toBe(true);
  expect(final.run.state).toBe('settled');
  expect(final.resultRef).not.toBeNull();
  expect(requests.filter((entry) => entry.kind === 'mcp-invoke')).toHaveLength(
    1,
  );
  expect(requests.filter((entry) => entry.kind === 'mcp-cancel')).toHaveLength(
    1,
  );
  await mcp.close();
});

it('stops refresh after cancellation without configuring a changed catalog or polling again', async () => {
  await mcp.ensureReady();
  const original = mcp.getCatalogs()[0];
  const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
  const physical = control.getMockImplementation()!;
  let respond!: (view: ManagedMcpOperationView) => void;
  const response = new Promise<ManagedMcpOperationView>((resolve) => {
    respond = resolve;
  });
  let discoveryId: string | undefined;
  control.mockImplementation(async (operation) => {
    if (operation.kind === 'mcp-discover') {
      discoveryId = operation.operationId;
      return response;
    }
    return physical(operation);
  });
  const abort = new AbortController();
  const refresh = mcp.refresh(abort.signal).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(discoveryId).toBeDefined());
  const count = control.mock.calls.length;
  const reason = new Error('cancelled discovery');
  abort.abort(reason);
  respond({
    operationId: discoveryId!,
    state: 'settled',
    catalog: { ...original, catalogRevision: 2 },
  });
  expect(await refresh).toBe(reason);
  expect(control.mock.calls).toHaveLength(count);
  expect(mcp.getCatalogs()).toEqual([original]);
  await mcp.close();
});

it.each([
  { count: 1, reload: false },
  { count: 1, reload: true },
  { count: 2, reload: false },
  { count: 2, reload: true },
])(
  'retries an undelivered release before fencing the owner ($count servers, reload: $reload)',
  async ({ count, reload }) => {
    const pins = [pin, { ...pin, serverId: 'second' }].slice(0, count);
    mcp = new HostedMcpSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pins,
    );
    await mcp.ensureReady();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const physical = control.getMockImplementation()!;
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const acquired = acquire.getMockImplementation()!;
    const releases: ManagedMcpControl[] = [];
    const drained = new Set<string>();
    let ownerReleasing = false;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      if (ownerReleasing) throw new Error('runtime_session_not_ready');
      return acquired.call(this);
    });
    control.mockImplementation(async (operation) => {
      if (ownerReleasing) throw new Error('runtime_session_not_ready');
      if (operation.kind === 'mcp-release') {
        releases.push(operation);
        if (releases.length === 1) throw new Error('failed before delivery');
        drained.add(operation.serverId);
      }
      return physical(operation);
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockImplementation(async () => {
      ownerReleasing = true;
      if (drained.size !== count)
        throw new Error('connection still holds its owner');
    });
    await expect(mcp.close()).rejects.toBeInstanceOf(
      HostedMcpRecoveryRequiredError,
    );
    expect(release).not.toHaveBeenCalled();
    if (reload)
      mcp = new HostedMcpSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pins,
      );
    await mcp.close();
    expect(release).toHaveBeenCalledOnce();
    expect(releases).toHaveLength(count + 1);
    const identities = releases.map((operation) => {
      if (!('grant' in operation)) throw new Error('missing grant');
      const { grant: _grant, ...identity } = operation;
      return identity;
    });
    expect(identities[1]).toEqual(identities[0]);
    expect(
      session.authority
        .extensionRecordsInDomain('mcp_configuration')
        .every(
          (entry) =>
            parseMcpConfiguration(entry.record).releaseState === 'released',
        ),
    ).toBe(true);
  },
);

it('discards discovery from a configuration superseded while the request was pending', async () => {
  await mcp.ensureReady();
  const original = mcp.getCatalogs()[0];
  const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
  const physical = control.getMockImplementation()!;
  let reply!: (view: ManagedMcpOperationView) => void;
  const pending = new Promise<ManagedMcpOperationView>((resolve) => {
    reply = resolve;
  });
  let operationId: string | undefined;
  control.mockImplementation(async (operation) => {
    if (operation.kind === 'mcp-discover') {
      operationId = operation.operationId;
      return pending;
    }
    return physical(operation);
  });
  const refreshing = mcp.refresh();
  await vi.waitFor(() => expect(operationId).toBeDefined());
  try {
    await mcp.configure(randomUUID(), { ...pin, serverRevision: 2 }, 1);
    reply({
      operationId: operationId!,
      state: 'settled',
      catalog: { ...original, catalogRevision: 2 },
    });
    await refreshing;
    expect(mcp.getCatalogs()[0]).toMatchObject({
      serverRevision: 2,
      configRevision: 2,
    });
    expect(
      requests.filter((entry) => entry.kind === 'mcp-configure'),
    ).toHaveLength(2);
    await mcp.close();
  } finally {
    reply({ operationId: operationId!, state: 'outcome_unknown' });
    await refreshing;
  }
});

it.each(['intent', 'acquire', 'dispatch_started'] as const)(
  'stops a refresh replacement cancelled during %s and fences close until it drains',
  async (phase) => {
    await mcp.ensureReady();
    const catalog = mcp.getCatalogs()[0];
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const physical = control.getMockImplementation()!;
    control.mockImplementation(async (operation) =>
      operation.kind === 'mcp-discover'
        ? {
            operationId: operation.operationId,
            state: 'settled',
            catalog: { ...catalog, catalogRevision: 2 },
          }
        : physical(operation),
    );
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = false;
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const originalAcquire = acquire.getMockImplementation()!;
    let acquisitions = 0;
    if (phase === 'acquire') {
      acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
        if (++acquisitions === 2) {
          entered = true;
          await barrier;
        }
        await originalAcquire.call(this);
      });
    } else {
      const commit = session.authority.commitExtensionRecord.bind(
        session.authority,
      );
      vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
        async (...args) => {
          const result = await commit(...args);
          if (
            args[1].domain === 'mcp_configuration' &&
            parseMcpConfiguration(args[1].record).configRevision === 2 &&
            parseMcpConfiguration(args[1].record).run.execution === phase
          ) {
            entered = true;
            await barrier;
          }
          return result;
        },
      );
    }
    const abort = new AbortController();
    const reason = new Error('cancel replacement');
    const refreshing = mcp
      .refresh(abort.signal)
      .catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      abort.abort(reason);
      await expect(mcp.close()).rejects.toBeInstanceOf(
        HostedMcpRecoveryRequiredError,
      );
      expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
      resume();
      expect(await refreshing).toBe(reason);
      expect(
        requests.filter((entry) => entry.kind === 'mcp-configure'),
      ).toHaveLength(phase === 'dispatch_started' ? 2 : 1);
      await mcp.close();
      expect(
        requests.filter((entry) => entry.kind === 'mcp-configure'),
      ).toHaveLength(phase === 'dispatch_started' ? 2 : 1);
    } finally {
      resume();
      await refreshing;
    }
  },
);

it.each(['intent', 'acquire', 'dispatch_started'] as const)(
  'preserves the original configuration when initialization aborts during %s',
  async (phase) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = false;
    let resumed = false;
    const commit = session.authority.commitExtensionRecord.bind(
      session.authority,
    );
    const acquire = vi
      .mocked(HostedWorkspaceBroker.prototype.acquire)
      .getMockImplementation()!;
    if (phase === 'acquire') {
      vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          entered = true;
          await pending;
          await acquire.call(this);
          resumed = true;
        },
      );
    } else {
      vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
        async (...args) => {
          const result = await commit(...args);
          if (
            args[1].domain === 'mcp_configuration' &&
            parseMcpConfiguration(args[1].record).run.execution === phase
          ) {
            entered = true;
            await pending;
            resumed = true;
          }
          return result;
        },
      );
    }
    const abort = new AbortController();
    const reason = new Error('cancel initialization');
    const initializing = mcp
      .ensureReady(abort.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const before =
        session.authority.extensionRecordsInDomain('mcp_configuration')[0];
      abort.abort(reason);
      expect(await initializing).toBe(reason);
      await expect(mcp.close()).rejects.toBeInstanceOf(
        HostedMcpRecoveryRequiredError,
      );
      expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
      loseAck = phase === 'dispatch_started';
      finish();
      await vi.waitFor(() => expect(resumed).toBe(true));
      if (phase === 'dispatch_started') {
        await vi.waitFor(() =>
          expect(
            requests.filter((request) => request.kind === 'mcp-configure'),
          ).toHaveLength(1),
        );
        await mcp.ensureReady();
        expect(
          requests.filter((request) => request.kind === 'mcp-configure'),
        ).toHaveLength(1);
        expect(mcp.getCatalogs()).toHaveLength(1);
      } else {
        expect(requests).toHaveLength(0);
      }
      const after =
        session.authority.extensionRecordsInDomain('mcp_configuration')[0];
      expect(after.recordId).toBe(before.recordId);
      expect(parseMcpConfiguration(after.record).runtimeSessionId).toBe(
        parseMcpConfiguration(before.record).runtimeSessionId,
      );
      await mcp.close();
      if (phase !== 'dispatch_started') expect(requests).toHaveLength(0);
    } finally {
      finish();
      await initializing;
    }
  },
);
