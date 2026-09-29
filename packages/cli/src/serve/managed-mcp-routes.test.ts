/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationGrant } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  MANAGED_MCP_ROUTE,
  MANAGED_MCP_TOOL,
  type ManagedMcpCatalog,
  type ManagedMcpControl,
  type ManagedMcpResponse,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
} from './managed-runtime-attestation-worker.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import {
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';
import { MANAGED_RUNTIME_PROVIDER_ROUTE } from './managed-runtime-provider-protocol.js';

let worker: ManagedRuntimeAttestationWorkerHandle | undefined;
let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  await worker?.close();
  if (server)
    await new Promise<void>((resolve) => {
      server!.closeAllConnections();
      server!.close(() => resolve());
    });
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('authenticates MCP controls, executes tools through the ordinary ledger and holds release until connections drain', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'qwen-mcp-worker-'));
  let effects = 0;
  server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const request = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: string | number;
      method: string;
    };
    if (request.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : request.method === 'tools/list'
          ? { tools: [{ name: 'count', inputSchema: { type: 'object' } }] }
          : request.method === 'resources/list'
            ? { resources: [] }
            : request.method === 'prompts/list'
              ? { prompts: [] }
              : { content: [{ type: 'text', text: String(++effects) }] };
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const key = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
  };
  const runtimeSessionId = 'mcp-session-a';
  const manifest = path.join(directory, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      servers: [
        {
          tenantId: key.tenantId,
          workspaceId: key.workspaceId,
          serverId: 'fixture',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
          transport: 'streamable-http',
          url: `http://127.0.0.1:${port}/mcp`,
        },
      ],
    }),
  );
  vi.stubEnv('QWEN_MANAGED_MCP_CONFIG', manifest);
  const boot: ManagedContextBoot = {
    type: 'boot',
    version: 2,
    managedContext: 'managed-context/1',
    runtimeInstanceId: 'runtime-a',
    runtimeIncarnation: 'boot-a',
    leaseId: 'lease-a',
    provisionRequestId: 'provision-a',
    token: 'test-token',
    epoch: 1,
    capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    isolationClass: 'session',
    tenantId: key.tenantId,
    workspaceId: key.workspaceId,
    workspaceGeneration: '1',
    storageId: 'storage://pvc/workspace-a',
    mountRoot: directory,
  };
  worker = await startManagedRuntimeAttestationWorker(boot);
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-qwen-managed-lease-id': 'lease-a',
    'x-qwen-managed-lease-epoch': '1',
  };
  const post = (route: string, body: unknown, auth = headers) =>
    fetch(`${worker!.ready.url}${route}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
  const binding: ManagedContextBinding = {
    tenantId: key.tenantId,
    workspaceId: key.workspaceId,
    workspaceGeneration: '1',
    storageId: boot.storageId,
    cwdRelative: '.',
    contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
    contextRevision: '1',
  };
  const contextDigest = computeManagedContextDigest(binding);
  const context = await post('/internal/managed-runtime/v3/context', {
    protocolVersion: 3,
    managedContext: 'managed-context/1',
    operationId: 'context-a',
    sessionId: runtimeSessionId,
    binding,
    contextDigest,
  });
  expect(context.status).toBe(200);
  const activation = {
    protocolVersion: 1,
    profile: WORKSPACE_EXECUTION_PROFILE,
    sessionId: runtimeSessionId,
    contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
    contextDigest,
    operation: 'activate',
  };
  expect(
    (await post('/internal/managed-runtime/v3/activation', activation)).status,
  ).toBe(200);
  const grant: OperationGrant = {
    sessionKey: key,
    operationId: 'config-a',
    domain: 'mcp_configuration',
    operationRevision: 1,
    ownerId: 'harness-a',
    workspaceGeneration: '1',
    leaseDurationMs: 300_000,
    expiresAt: Date.now() + 300_000,
    resourceScope: {
      recordRef: {
        resourceId: 'record-a',
        kind: 'managed-mcp_configuration',
        schemaVersion: 1,
        byteLength: 1,
        digest: 'b'.repeat(64),
      },
      phases: ['configure', 'invoke', 'release'],
    },
  };
  const configure: ManagedMcpControl = {
    kind: 'mcp-configure',
    sessionKey: key,
    operationId: 'config-a',
    serverId: 'fixture',
    serverRevision: 1,
    configRevision: 1,
    definitionDigest: 'a'.repeat(64),
    grant,
  };
  const request = (operation: ManagedMcpControl) => ({
    protocolVersion: 1,
    runtimeSessionId,
    operation,
  });
  const provider = (kind: 'acquire' | 'release') =>
    post(MANAGED_RUNTIME_PROVIDER_ROUTE.path, {
      protocolVersion: 1,
      providerProtocol: 'managed-runtime-provider/1',
      session: {
        harnessSessionId: key.sessionId,
        runtimeSessionId,
        turnKind: 'bootstrap',
      },
      operation: { kind },
    });
  expect(
    (
      await post(MANAGED_MCP_ROUTE, request(configure), {
        ...headers,
        authorization: 'Bearer wrong',
      })
    ).status,
  ).toBe(401);
  const response = await post(MANAGED_MCP_ROUTE, request(configure));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  let catalog: ManagedMcpCatalog | undefined;
  await vi.waitFor(async () => {
    const status = await post(
      MANAGED_MCP_ROUTE,
      request({
        kind: 'mcp-status',
        sessionKey: key,
        operationId: 'lookup-a',
        targetOperationId: 'config-a',
      }),
    );
    catalog = ((await status.json()) as ManagedMcpResponse).operation.catalog;
    expect(catalog).toBeDefined();
  });
  expect(
    (
      await post('/internal/managed-runtime/v3/activation', {
        ...activation,
        operation: 'release',
      })
    ).status,
  ).toBe(409);
  const invoke: ManagedMcpControl = {
    kind: 'mcp-invoke',
    sessionKey: key,
    operationId: 'tool-a',
    serverId: 'fixture',
    serverRevision: 1,
    configRevision: 1,
    connectionGeneration: catalog!.connectionGeneration,
    catalogRevision: catalog!.catalogRevision,
    grant,
    request: { kind: 'tool_call', name: 'count', arguments: {} },
  };
  expect((await post(MANAGED_MCP_ROUTE, request(invoke))).status).toBe(409);
  const reference = {
    sessionId: runtimeSessionId,
    promptId: 'prompt-a',
    callId: 'tool-a',
    argsDigest: `sha256:${'c'.repeat(64)}`,
  };
  const execution = {
    protocolVersion: 2,
    reference,
    toolName: MANAGED_MCP_TOOL,
    input: invoke,
  };
  const result = await post('/internal/managed-runtime/v2/execute', execution);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    state: 'settled',
    result: { executionStatus: 'success' },
  });
  expect(
    (await post('/internal/managed-runtime/v2/execute', execution)).status,
  ).toBe(200);
  expect(effects).toBe(1);
  expect((await provider('acquire')).status).toBe(409);
  expect((await provider('release')).status).toBe(409);
  const status = await post('/internal/managed-runtime/v2/status', {
    protocolVersion: 2,
    reference,
  });
  expect(await status.json()).toMatchObject({
    state: 'settled',
    result: { executionStatus: 'success' },
  });
  await post(
    MANAGED_MCP_ROUTE,
    request({
      kind: 'mcp-release',
      sessionKey: key,
      operationId: 'release-a',
      serverId: 'fixture',
      serverRevision: 1,
      connectionGeneration: catalog!.connectionGeneration,
      grant,
    }),
  );
  await vi.waitFor(async () => {
    const status = await post(
      MANAGED_MCP_ROUTE,
      request({
        kind: 'mcp-status',
        sessionKey: key,
        operationId: 'lookup-release',
        targetOperationId: 'release-a',
      }),
    );
    expect((await status.json()) as ManagedMcpResponse).toMatchObject({
      operation: { state: 'settled', response: { released: true } },
    });
  });
  expect((await provider('release')).status).toBe(200);
  expect(
    (await post('/internal/managed-runtime/v2/execute', execution)).status,
  ).toBe(409);
  expect(
    (
      await post('/internal/managed-runtime/v3/activation', {
        ...activation,
        operation: 'release',
      })
    ).status,
  ).toBe(200);
});
