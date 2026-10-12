/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OperationGrant } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { MANAGED_MCP_TOOL } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import type {
  ManagedMcpCatalog,
  ManagedMcpConfigure,
  ManagedMcpControl,
  ManagedMcpInvoke,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  ManagedMcpRuntime,
  type ManagedMcpDefinition,
  type ManagedMcpManifest,
} from './managed-mcp-runtime.js';
import {
  ManagedToolExecutor,
  type ManagedToolSet,
} from './managed-runtime-tool-executor.js';

const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};
const runtimeSessionId = 'mcp:session-a';
const definitionDigest = 'a'.repeat(64);
const serverCode = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
let pages = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if (request.method==='notifications/cancelled') appendFileSync(process.env.COUNTER, 'cancel:'+request.params.requestId+'\n');
 if (request.id === undefined) return;
 appendFileSync(process.env.COUNTER, request.method+'\n');
 if (request.method==='initialize') send(request.id,{protocolVersion:'2024-11-05',capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'fixture',version:'1'}});
 else if (process.env.UNSUPPORTED_LISTS && ['resources/list','prompts/list'].includes(request.method)) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Not supported'}})+'\n');
 else if (request.method==='tools/list') {
   if (process.env.EMPTY_PAGES) {send(request.id,{tools:[],nextCursor:String(++pages)});return;}
   send(request.id,{tools:[...['echo','delayed','drop'].map(name=>({name,inputSchema:{type:'object'}})), ...(process.env.LARGE_CATALOG?[{name:'too-large',description:'x'.repeat(20*1024),inputSchema:{type:'object'}}]:[])]});
   if (process.env.INVALIDATE_DISCOVERY) process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');
 }
 else if (request.method==='resources/list') send(request.id,{resources:[{uri:'data://binary',name:'binary'}]});
 else if (request.method==='prompts/list') send(request.id,{prompts:[{name:'two-messages'}]});
 else if (request.method==='resources/read') send(request.id,{contents:[{uri:'data://binary',mimeType:'application/octet-stream',blob:'AQID'}]});
 else if (request.method==='prompts/get') send(request.id,{messages:[{role:'user',content:{type:'text',text:'first'}},{role:'assistant',content:{type:'text',text:'second'}}]});
 else if (request.method==='tools/call') {
   if(request.params.name==='drop') process.exit(0);
   if(request.params.arguments.invalid) {send(request.id,{content:'invalid'});return;}
   if(request.params.arguments.stray) send(999999,{});
   if(request.params.arguments.strayAfter) setTimeout(()=>send(999999,{}),100);
   if(request.params.arguments.duplicateId) send(request.params.arguments.duplicateId,{content:[{type:'text',text:'duplicate'}]});
   if(request.params.arguments.notify) process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');
   if(request.params.arguments.notifyMethod) process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:request.params.arguments.notifyMethod})+'\n');
   const respond=()=>send(request.id,{content:[{type:'text',text:request.params.arguments.large?'x'.repeat(61*1024):JSON.stringify({args:request.params.arguments,hasScopedSecret:process.env.MCP_SECRET==='runtime-only-secret',ambient:process.env.MCP_AMBIENT_SECRET??null,logname:process.env.LOGNAME??null,cwd:process.cwd(),systemRoot:process.env.SYSTEMROOT??null})}]});
   if (request.params.arguments.releaseFile) {
     const timer=setInterval(()=>{if(existsSync(request.params.arguments.releaseFile)){clearInterval(timer);respond();}},10);
   } else request.params.name==='delayed'?setTimeout(respond,1000):respond();
 }
});
`;

let directory: string;
let runtimes: ManagedMcpRuntime[];
let servers: Server[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-mcp-'));
  runtimes = [];
  servers = [];
});

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function grant(
  operationId: string,
  domain: OperationGrant['domain'] = 'mcp_configuration',
): OperationGrant {
  return {
    sessionKey,
    operationId,
    domain,
    operationRevision: 1,
    ownerId: 'harness-a',
    workspaceGeneration: '1',
    resourceScope: {
      recordRef: {
        resourceId: `record:${operationId}`,
        kind: `managed-${domain}`,
        schemaVersion: 1,
        byteLength: 1,
        digest: 'b'.repeat(64),
      },
      phases: ['configure', 'discover', 'invoke', 'release'],
    },
    leaseDurationMs: 300_000,
    expiresAt: Date.now() + 300_000,
  };
}

function stdioDefinition(serverRevision = 1): ManagedMcpDefinition {
  return {
    tenantId: sessionKey.tenantId,
    workspaceId: sessionKey.workspaceId,
    serverId: 'fixture',
    serverRevision,
    definitionDigest,
    transport: 'stdio',
    command: process.execPath,
    args: ['--input-type=module', '-e', serverCode],
    env: {
      COUNTER: path.join(directory, `calls-${serverRevision}`),
      MCP_SECRET: 'runtime-only-secret',
    },
  };
}

function runtime(
  definitions: readonly ManagedMcpDefinition[] = [stdioDefinition()],
): ManagedMcpRuntime {
  const instance = new ManagedMcpRuntime(
    { ...sessionKey, workspaceGeneration: '1' },
    async (id) => (id === runtimeSessionId ? directory : undefined),
    { version: 1, servers: definitions } satisfies ManagedMcpManifest,
  );
  runtimes.push(instance);
  return instance;
}

function configure(serverRevision = 1): ManagedMcpConfigure {
  return {
    kind: 'mcp-configure',
    operationId: `configuration-${serverRevision}`,
    sessionKey,
    serverId: 'fixture',
    serverRevision,
    configRevision: serverRevision,
    definitionDigest,
    grant: grant(`configuration-${serverRevision}`),
  };
}

async function settled(
  instance: ManagedMcpRuntime,
  control: ManagedMcpControl,
): Promise<ManagedMcpOperationView> {
  let view = await instance.control(runtimeSessionId, control);
  await vi.waitFor(
    async () => {
      view = await instance.control(runtimeSessionId, {
        kind: 'mcp-status',
        sessionKey,
        operationId: 'lookup',
        targetOperationId: control.operationId,
      });
      expect(view.state).not.toBe('running');
    },
    { timeout: 15_000 },
  );
  return view;
}

function invoke(
  catalog: ManagedMcpCatalog,
  operationId: string,
  request: ManagedMcpInvoke['request'],
): ManagedMcpInvoke {
  return {
    kind: 'mcp-invoke',
    sessionKey,
    operationId,
    serverId: catalog.serverId,
    serverRevision: catalog.serverRevision,
    configRevision: catalog.configRevision,
    connectionGeneration: catalog.connectionGeneration,
    catalogRevision: catalog.catalogRevision,
    grant: grant(
      request.kind === 'tool_call'
        ? `configuration-${catalog.configRevision}`
        : operationId,
      request.kind === 'tool_call' ? 'mcp_configuration' : 'mcp_operation',
    ),
    request,
  };
}

describe('Managed MCP Runtime', () => {
  it('refuses a parked configuration after sealing before any connection starts', async () => {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const instance = new ManagedMcpRuntime(
      { ...sessionKey, workspaceGeneration: '1' },
      async () => {
        enter();
        await gate;
        return directory;
      },
      { version: 1, servers: [stdioDefinition()] },
    );
    runtimes.push(instance);
    const executor = new ManagedToolExecutor(
      async () => undefined,
      undefined,
      instance,
    );
    const connect = vi.spyOn(Client.prototype, 'connect');
    const request = instance.control(runtimeSessionId, configure());
    const refusal = request.catch((error: unknown) => error);
    await entered;
    const retirementId = '550e8400-e29b-41d4-a716-446655440000';
    executor.sealAdmission(retirementId);
    expect(instance.getDrainInspection()).toEqual({
      pendingStarts: 1,
      pendingInvocations: 0,
      hasActivity: true,
    });
    resume();
    expect(await refusal).toMatchObject({ code: 'managed_mcp_closed' });
    expect(connect).not.toHaveBeenCalled();
    expect(instance.getDrainInspection()).toEqual({
      pendingStarts: 0,
      pendingInvocations: 0,
      hasActivity: true,
    });
    expect(executor.getDrainObservation(retirementId).workState).toBe(
      'BLOCKED',
    );
    expect(executor.getDrainObservation(retirementId).blockers).toContain(
      'mcp_lifecycle_unqualified',
    );
    connect.mockRestore();
  });

  it('preserves original MCP observation and release while refusing new work', async () => {
    const instance = runtime();
    const executor = new ManagedToolExecutor(
      async () => undefined,
      undefined,
      instance,
    );
    const original = await settled(instance, configure());
    const catalog = original.catalog!;
    const request = invoke(catalog, 'original-invoke', {
      kind: 'tool_call',
      name: 'echo',
      arguments: {},
    });
    const result = await instance.invokeTool(runtimeSessionId, request);
    const retirementId = '550e8400-e29b-41d4-a716-446655440000';
    executor.sealAdmission(retirementId);
    expect(await instance.control(runtimeSessionId, configure())).toEqual(
      original,
    );
    expect(await instance.invokeTool(runtimeSessionId, request)).toEqual(
      result,
    );
    expect(
      await instance.control(runtimeSessionId, {
        kind: 'mcp-cancel',
        sessionKey,
        operationId: 'cancel',
        targetOperationId: request.operationId,
      }),
    ).toEqual(result);
    await expect(
      instance.control(runtimeSessionId, {
        ...configure(),
        operationId: 'fresh-configure',
        grant: grant('fresh-configure'),
      }),
    ).rejects.toMatchObject({ code: 'managed_mcp_closed' });
    await expect(
      instance.control(runtimeSessionId, {
        kind: 'mcp-discover',
        sessionKey,
        operationId: 'fresh-discover',
        serverId: catalog.serverId,
        serverRevision: catalog.serverRevision,
        connectionGeneration: catalog.connectionGeneration,
        grant: grant('configuration-1'),
      }),
    ).rejects.toMatchObject({ code: 'managed_mcp_closed' });
    await expect(
      instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, 'fresh-invoke', {
          kind: 'tool_call',
          name: 'echo',
          arguments: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'managed_mcp_closed' });
    expect(
      (
        await settled(instance, {
          kind: 'mcp-release',
          sessionKey,
          operationId: 'original-release',
          serverId: catalog.serverId,
          serverRevision: catalog.serverRevision,
          connectionGeneration: catalog.connectionGeneration,
          grant: grant('configuration-1'),
        })
      ).response,
    ).toEqual({ released: true });
    expect(instance.hasHolds(runtimeSessionId)).toBe(false);
    expect(executor.getDrainObservation(retirementId).blockers).toContain(
      'mcp_lifecycle_unqualified',
    );
    await instance.close();
    expect(executor.getDrainObservation(retirementId).workState).toBe(
      'BLOCKED',
    );
    const calls = await readFile(path.join(directory, 'calls-1'), 'utf8');
    expect(
      calls.split('\n').filter((method) => method === 'tools/call'),
    ).toHaveLength(1);
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'ignores inherited notification names without changing the catalog: %s',
    async (method) => {
      const instance = runtime();
      const catalog = (await settled(instance, configure())).catalog!;
      const result = await instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, 'notify', {
          kind: 'tool_call',
          name: 'echo',
          arguments: { notifyMethod: method },
        }),
      );
      expect(result.error).toBeUndefined();
      const discovery = await settled(instance, {
        kind: 'mcp-discover',
        sessionKey,
        operationId: 'discover',
        serverId: catalog.serverId,
        serverRevision: catalog.serverRevision,
        connectionGeneration: catalog.connectionGeneration,
        grant: grant('configuration-1'),
      });
      expect(discovery.catalog).toEqual(catalog);
    },
  );

  it('keeps a healthy replacement while retaining the undrained predecessor hold', async () => {
    const instance = runtime([stdioDefinition(), stdioDefinition(2)]);
    const original = (await settled(instance, configure())).catalog!;
    const close = vi
      .spyOn(Client.prototype, 'close')
      .mockRejectedValueOnce(new Error('drain unconfirmed'));
    try {
      const replacement = await settled(instance, configure(2));
      expect(replacement.error).toBeUndefined();
      expect(replacement.catalog?.serverRevision).toBe(2);
      const result = await instance.invokeTool(
        runtimeSessionId,
        invoke(replacement.catalog!, 'echo-new', {
          kind: 'tool_call',
          name: 'echo',
          arguments: {},
        }),
      );
      expect(result.error).toBeUndefined();
      await settled(instance, {
        kind: 'mcp-release',
        sessionKey,
        operationId: 'release-new',
        serverId: 'fixture',
        serverRevision: 2,
        connectionGeneration: replacement.catalog!.connectionGeneration,
        grant: grant('configuration-2'),
      });
      expect(instance.hasHolds(runtimeSessionId)).toBe(true);
      const retired = await settled(instance, {
        kind: 'mcp-discover',
        sessionKey,
        operationId: 'discover-old',
        serverId: 'fixture',
        serverRevision: 1,
        connectionGeneration: original.connectionGeneration,
        grant: grant('configuration-1'),
      });
      expect(retired.error?.code).toBe('managed_mcp_retiring');
      await settled(instance, {
        kind: 'mcp-release',
        sessionKey,
        operationId: 'release-old',
        serverId: 'fixture',
        serverRevision: 1,
        connectionGeneration: original.connectionGeneration,
        grant: grant('configuration-1'),
      });
      expect(instance.hasHolds(runtimeSessionId)).toBe(false);
    } finally {
      close.mockRestore();
    }
  });

  it('settles a timed-out release only after physical close, retaining another connection', async () => {
    const instance = runtime([
      stdioDefinition(),
      { ...stdioDefinition(), serverId: 'second' },
    ]);
    const first = (await settled(instance, configure())).catalog!;
    const otherConfig = {
      ...configure(),
      operationId: 'other-configuration',
      serverId: 'second',
      grant: grant('other-configuration'),
    };
    const other = (await settled(instance, otherConfig)).catalog!;
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const physicalClose = Client.prototype.close;
    const close = vi
      .spyOn(Client.prototype, 'close')
      .mockImplementationOnce(async function (this: Client) {
        await closing;
        await physicalClose.call(this);
      });
    const release: ManagedMcpControl = {
      kind: 'mcp-release',
      sessionKey,
      operationId: 'slow-release',
      serverId: first.serverId,
      serverRevision: first.serverRevision,
      connectionGeneration: first.connectionGeneration,
      grant: grant('configuration-1'),
    };
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      expect((await instance.control(runtimeSessionId, release)).state).toBe(
        'running',
      );
      await vi.advanceTimersByTimeAsync(5_001);
      const status: ManagedMcpControl = {
        kind: 'mcp-status',
        sessionKey,
        operationId: 'status',
        targetOperationId: release.operationId,
      };
      expect(await instance.control(runtimeSessionId, status)).toMatchObject({
        state: 'outcome_unknown',
        error: { code: 'managed_mcp_drain_unknown' },
      });
      expect((await instance.control(runtimeSessionId, release)).state).toBe(
        'outcome_unknown',
      );
      expect(instance.hasHolds(runtimeSessionId)).toBe(true);
      vi.useRealTimers();
      finishClose();
      await vi.waitFor(async () => {
        expect(await instance.control(runtimeSessionId, status)).toEqual({
          operationId: release.operationId,
          state: 'settled',
          response: { released: true },
        });
      });
      expect(await instance.control(runtimeSessionId, release)).toMatchObject({
        state: 'settled',
        response: { released: true },
      });
      expect(instance.hasHolds(runtimeSessionId)).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      expect(
        (
          await settled(instance, {
            ...release,
            operationId: 'release-other',
            serverId: 'second',
            connectionGeneration: other.connectionGeneration,
            grant: grant('other-configuration'),
          })
        ).response,
      ).toEqual({ released: true });
      expect(instance.hasHolds(runtimeSessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
      finishClose();
      close.mockRestore();
    }
  });

  it('refuses an MCP tool when a provider claims its Session during context lookup', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    let admit!: (tools: ManagedToolSet) => void;
    const tools = new Promise<ManagedToolSet>((resolve) => (admit = resolve));
    const resolveTools = vi.fn(() => tools);
    const executor = new ManagedToolExecutor(resolveTools, undefined, instance);
    const input = invoke(catalog, 'tool-race', {
      kind: 'tool_call',
      name: 'echo',
      arguments: {},
    });
    const reference = {
      sessionId: runtimeSessionId,
      promptId: 'prompt',
      callId: input.operationId,
      argsDigest: 'digest',
    };
    const invoked = vi.spyOn(instance, 'invokeTool');
    const pending = executor.execute(reference, MANAGED_MCP_TOOL, { ...input });
    await vi.waitFor(() => expect(resolveTools).toHaveBeenCalledOnce());
    executor.claimProviderSession(runtimeSessionId);
    admit({
      sessionId: runtimeSessionId,
      tools: new Map(),
      admitsDirectory: () => true,
    });
    await expect(pending).rejects.toThrow(
      'Managed Runtime protocol conflicts.',
    );
    expect(invoked).not.toHaveBeenCalled();
    expect(executor.status(reference)).toBeNull();
  });

  it('bounds catalog pagination even when every page is empty with a fresh cursor', async () => {
    const definition = stdioDefinition();
    const instance = runtime([
      { ...definition, env: { ...definition.env, EMPTY_PAGES: '1' } },
    ]);
    const result = await settled(instance, configure());
    expect(result.catalog?.discovery.tools).toBe('failed');
    const requests = (
      await readFile(path.join(directory, 'calls-1'), 'utf8')
    ).split('\n');
    expect(requests.filter((method) => method === 'tools/list')).toHaveLength(
      64,
    );
  });

  it('keeps dead-transport evidence without charging it to live request capacity', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    const pending = Array.from({ length: 31 }, (_, i) =>
      instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, `pending-${i}`, {
          kind: 'tool_call',
          name: 'delayed',
          arguments: { releaseFile: path.join(directory, 'never-released') },
        }),
      ),
    );
    await vi.waitFor(async () => {
      const methods = (
        await readFile(path.join(directory, 'calls-1'), 'utf8')
      ).split('\n');
      expect(methods.filter((method) => method === 'tools/call')).toHaveLength(
        31,
      );
    });
    pending.push(
      instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, 'drop-all', {
          kind: 'tool_call',
          name: 'drop',
          arguments: {},
        }),
      ),
    );
    expect(
      (await Promise.all(pending)).every(
        (view) => view.state === 'outcome_unknown',
      ),
    ).toBe(true);
    expect(instance.hasHolds(runtimeSessionId)).toBe(true);
    const next = (
      await settled(instance, {
        ...configure(),
        operationId: 'configuration-2',
        configRevision: 2,
        grant: grant('configuration-2'),
      })
    ).catalog!;
    const result = await instance.invokeTool(
      runtimeSessionId,
      invoke(next, 'healthy', {
        kind: 'tool_call',
        name: 'echo',
        arguments: {},
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.response).toBeDefined();
    expect(instance.hasHolds(runtimeSessionId)).toBe(true);
  });

  it('lets pending calls settle after an SDK protocol error and then closes the retired transport', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    const call = invoke(catalog, 'stray-frame', {
      kind: 'tool_call',
      name: 'delayed',
      arguments: { stray: true },
    });
    const result = await instance.invokeTool(runtimeSessionId, call);
    expect(result.state).toBe('settled');
    expect(result.error).toBeUndefined();
    expect(result.response).toBeDefined();
    await vi.waitFor(() =>
      expect(instance.hasHolds(runtimeSessionId)).toBe(false),
    );
  });

  it('closes an idle connection retired by an SDK protocol error', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    const result = await instance.invokeTool(
      runtimeSessionId,
      invoke(catalog, 'idle-stray', {
        kind: 'tool_call',
        name: 'echo',
        arguments: { strayAfter: true },
      }),
    );
    expect(result.state).toBe('settled');
    await vi.waitFor(() =>
      expect(instance.hasHolds(runtimeSessionId)).toBe(false),
    );
  });

  it.each<Partial<ManagedMcpDefinition>>([
    { command: 'node\0' },
    { args: ['\0'] },
    { env: { KEY: '\0' } },
    { env: { ['KEY\0']: 'value' } },
  ])('rejects stdio NUL inputs before allocating a connection: %j', (input) => {
    expect(() => runtime([{ ...stdioDefinition(), ...input }])).toThrow(
      'managed_mcp_manifest_invalid',
    );
  });

  it('treats method-not-found catalogs as authoritative empty lists', async () => {
    const definition = stdioDefinition();
    const instance = runtime([
      { ...definition, env: { ...definition.env, UNSUPPORTED_LISTS: '1' } },
    ]);
    const catalog = (await settled(instance, configure())).catalog!;
    expect(catalog.resources).toEqual([]);
    expect(catalog.prompts).toEqual([]);
    expect(catalog.discovery).toEqual({
      tools: 'complete',
      resources: 'complete',
      prompts: 'complete',
    });
    const discovery = await settled(instance, {
      kind: 'mcp-discover',
      sessionKey,
      operationId: 'fresh',
      serverId: 'fixture',
      serverRevision: 1,
      connectionGeneration: catalog.connectionGeneration,
      grant: grant('configuration-1'),
    });
    expect(discovery.catalog).toEqual(catalog);
  });
  it('runs a real stdio server, preserves resource/prompt unions and never inherits ambient secrets', async () => {
    vi.stubEnv('MCP_AMBIENT_SECRET', 'must-not-reach-child');
    vi.stubEnv('LOGNAME', 'private-runtime-user');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const instance = runtime();
    const configured = await settled(instance, configure());
    expect(configured.error).toBeUndefined();
    const catalog = configured.catalog!;
    expect(catalog.discovery).toEqual({
      tools: 'complete',
      resources: 'complete',
      prompts: 'complete',
    });
    expect(JSON.stringify(catalog)).not.toContain('runtime-only-secret');
    expect(JSON.stringify(catalog)).not.toContain(process.execPath);
    const tool = invoke(catalog, 'tool-1', {
      kind: 'tool_call',
      name: 'echo',
      arguments: { message: 'hello' },
    });
    await expect(instance.control(runtimeSessionId, tool)).rejects.toThrow(
      'managed_mcp_tool_requires_execution',
    );
    const result = await instance.invokeTool(runtimeSessionId, tool);
    expect(result.state).toBe('settled');
    expect(result.response).toMatchObject({
      content: [
        { type: 'text', text: expect.stringContaining('"ambient":null') },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('runtime-only-secret');
    expect(JSON.stringify(result)).not.toContain('private-runtime-user');
    expect(result.response).toMatchObject({
      content: [{ text: expect.stringContaining('"hasScopedSecret":true') }],
    });
    expect(result.response).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            JSON.stringify({ systemRoot: 'C:\\Windows' }).slice(1, -1),
          ),
        },
      ],
    });
    const resource = await settled(
      instance,
      invoke(catalog, 'resource-1', {
        kind: 'resource_read',
        uri: 'data://binary',
      }),
    );
    expect(resource.response).toEqual({
      contents: [
        {
          uri: 'data://binary',
          mimeType: 'application/octet-stream',
          blob: 'AQID',
        },
      ],
    });
    const prompt = await settled(
      instance,
      invoke(catalog, 'prompt-1', {
        kind: 'prompt_get',
        name: 'two-messages',
        arguments: {},
      }),
    );
    expect(prompt.response?.['messages']).toHaveLength(2);
    expect(prompt.response).not.toHaveProperty('functionResponse');
  });

  it('joins original calls after lost replies and rejects conflicting IDs and Session isolation', async () => {
    const instance = runtime();
    const configured = await settled(instance, configure());
    const tool = invoke(configured.catalog!, 'same-call', {
      kind: 'tool_call',
      name: 'echo',
      arguments: {},
    });
    const first = await instance.invokeTool(runtimeSessionId, tool);
    expect(await instance.invokeTool(runtimeSessionId, tool)).toEqual(first);
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8'))
        .split('\n')
        .filter((line) => line === 'tools/call'),
    ).toHaveLength(1);
    await expect(
      instance.invokeTool(runtimeSessionId, {
        ...tool,
        request: { ...tool.request, arguments: { different: true } },
      }),
    ).rejects.toThrow('managed_mcp_operation_conflict');
    await expect(
      instance.control(runtimeSessionId, {
        ...configure(),
        sessionKey: { ...sessionKey, workspaceId: 'elsewhere' },
      }),
    ).rejects.toThrow('managed_mcp_scope_conflict');
    expect(
      await instance.control('other-runtime-session', {
        kind: 'mcp-status',
        sessionKey,
        operationId: 'lookup',
        targetOperationId: 'same-call',
      }),
    ).toEqual({ operationId: 'same-call', state: 'outcome_unknown' });
  });

  it('rejects configuration and raw effects that borrow another operation grant', async () => {
    const instance = runtime();
    await expect(
      instance.control(runtimeSessionId, {
        ...configure(),
        operationId: 'uncommitted-configuration',
      }),
    ).rejects.toThrow('managed_mcp_grant_invalid');
    expect(instance.hasHolds(runtimeSessionId)).toBe(false);
    const catalog = (await settled(instance, configure())).catalog!;
    for (const request of [
      { kind: 'resource_read' as const, uri: 'data://binary' },
      { kind: 'prompt_get' as const, name: 'two-messages', arguments: {} },
    ]) {
      const allowed = invoke(catalog, request.kind, request);
      expect((await settled(instance, allowed)).state).toBe('settled');
      await expect(
        instance.control(runtimeSessionId, {
          ...allowed,
          operationId: `uncommitted-${request.kind}`,
        }),
      ).rejects.toThrow('managed_mcp_grant_invalid');
    }
    const methods = (
      await readFile(path.join(directory, 'calls-1'), 'utf8')
    ).split('\n');
    expect(
      methods.filter((method) => method === 'resources/read'),
    ).toHaveLength(1);
    expect(methods.filter((method) => method === 'prompts/get')).toHaveLength(
      1,
    );
  });

  it.each([1, 2])(
    'pins in-flight work during replacement by server revision %i and accepts late success after cancel',
    async (serverRevision) => {
      const instance = runtime([stdioDefinition(1), stdioDefinition(2)]);
      const catalog = (await settled(instance, configure())).catalog!;
      const releaseFile = path.join(directory, 'release-delayed');
      const old = invoke(catalog, 'delayed', {
        kind: 'tool_call',
        name: 'delayed',
        arguments: { releaseFile },
      });
      const pending = instance.invokeTool(runtimeSessionId, old);
      await vi.waitFor(() =>
        expect(instance.toolStatus(runtimeSessionId, old).state).toBe(
          'running',
        ),
      );
      const replacement = await settled(instance, {
        ...configure(2),
        serverRevision,
      });
      expect(replacement.catalog!.connectionGeneration).not.toBe(
        catalog.connectionGeneration,
      );
      const release: ManagedMcpControl = {
        kind: 'mcp-release',
        sessionKey,
        operationId: 'release-old',
        serverId: catalog.serverId,
        serverRevision: catalog.serverRevision,
        connectionGeneration: catalog.connectionGeneration,
        grant: grant('configuration-1'),
      };
      expect((await instance.control(runtimeSessionId, release)).state).toBe(
        'running',
      );
      instance.cancelTool(runtimeSessionId, old);
      expect(instance.toolStatus(runtimeSessionId, old).state).toBe('running');
      await writeFile(releaseFile, 'release');
      expect((await pending).state).toBe('settled');
      await vi.waitFor(() =>
        expect(instance.toolStatus(runtimeSessionId, old).state).toBe(
          'settled',
        ),
      );
      expect((await settled(instance, release)).response).toEqual({
        released: true,
      });
      const rejected = await instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, 'old-new-call', {
          kind: 'tool_call',
          name: 'echo',
          arguments: {},
        }),
      );
      expect(rejected.error?.code).toBe('managed_mcp_binding_conflict');
    },
  );

  it('refreshes a stale catalog through a new configuration of the same definition', async () => {
    const instance = runtime();
    const first = (await settled(instance, configure())).catalog!;
    await instance.invokeTool(
      runtimeSessionId,
      invoke(first, 'invalidate', {
        kind: 'tool_call',
        name: 'echo',
        arguments: { notify: true },
      }),
    );
    expect(
      (
        await instance.invokeTool(
          runtimeSessionId,
          invoke(first, 'stale', {
            kind: 'tool_call',
            name: 'echo',
            arguments: {},
          }),
        )
      ).error?.code,
    ).toBe('managed_mcp_catalog_conflict');
    const second = (
      await settled(instance, {
        ...configure(),
        configRevision: 2,
        operationId: 'configuration-2',
        grant: grant('configuration-2'),
      })
    ).catalog!;
    expect(second.connectionGeneration).toBeGreaterThan(
      first.connectionGeneration,
    );
    expect(second.discovery.tools).toBe('complete');
    expect(
      (
        await instance.invokeTool(
          runtimeSessionId,
          invoke(second, 'fresh', {
            kind: 'tool_call',
            name: 'echo',
            arguments: {},
          }),
        )
      ).error,
    ).toBeUndefined();
  });

  it('keeps notifications received during initial discovery and rediscovery stale', async () => {
    const definition = stdioDefinition();
    const instance = runtime([
      { ...definition, env: { ...definition.env, INVALIDATE_DISCOVERY: '1' } },
    ]);
    const initial = (await settled(instance, configure())).catalog!;
    const refreshed = (
      await settled(instance, {
        kind: 'mcp-discover',
        sessionKey,
        operationId: 'rediscover',
        serverId: 'fixture',
        serverRevision: 1,
        connectionGeneration: initial.connectionGeneration,
        grant: grant('configuration-1'),
      })
    ).catalog!;
    for (const catalog of [initial, refreshed]) {
      expect(catalog.discovery.tools).toBe('stale');
      expect(catalog.discovery.resources).toBe('complete');
    }
    const response = await instance.invokeTool(
      runtimeSessionId,
      invoke(refreshed, 'stale-discovery-call', {
        kind: 'tool_call',
        name: 'echo',
        arguments: {},
      }),
    );
    expect(response.error?.code).toBe('managed_mcp_capability_unavailable');
    expect(
      await readFile(path.join(directory, 'calls-1'), 'utf8'),
    ).not.toContain('tools/call');
  });

  it('does not charge retained unknown replies against healthy invocation capacity', async () => {
    const instance = runtime([
      stdioDefinition(),
      { ...stdioDefinition(2), serverId: 'healthy' },
    ]);
    const invalid = (await settled(instance, configure())).catalog!;
    const healthy = (
      await settled(instance, { ...configure(2), serverId: 'healthy' })
    ).catalog!;
    for (let index = 0; index < 32; index++) {
      const response = await instance.invokeTool(
        runtimeSessionId,
        invoke(invalid, `invalid-${index}`, {
          kind: 'tool_call',
          name: 'echo',
          arguments: { invalid: true },
        }),
      );
      expect(response).toMatchObject({
        state: 'outcome_unknown',
        error: { code: 'managed_mcp_response_invalid' },
      });
    }
    for (const catalog of [healthy, invalid]) {
      const response = await instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, `healthy-${catalog.serverId}`, {
          kind: 'tool_call',
          name: 'echo',
          arguments: { duplicateId: 'invalid-0' },
        }),
      );
      expect(response.state).toBe('settled');
      expect(response.error).toBeUndefined();
      expect(response.response).toHaveProperty('content');
    }
    expect(
      await instance.control(runtimeSessionId, {
        kind: 'mcp-status',
        sessionKey,
        operationId: 'late-status',
        targetOperationId: 'invalid-0',
      }),
    ).toMatchObject({
      state: 'settled',
      response: { content: [{ text: 'duplicate' }] },
    });
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8')).match(
        /tools\/call/g,
      ),
    ).toHaveLength(33);
    expect(
      (await readFile(path.join(directory, 'calls-2'), 'utf8')).match(
        /tools\/call/g,
      ),
    ).toHaveLength(1);
    expect(instance.hasHolds(runtimeSessionId)).toBe(true);
  });

  it('keeps unanswered timed-out calls in the quota until their late replies arrive', async () => {
    const instance = runtime([{ ...stdioDefinition(), timeoutMs: 20 }]);
    const catalog = (await settled(instance, configure())).catalog!;
    const releaseFile = path.join(directory, 'release-quota');
    const inputs = Array.from({ length: 32 }, (_, index) =>
      invoke(catalog, `timeout-${index}`, {
        kind: 'tool_call',
        name: 'echo',
        arguments: { releaseFile },
      }),
    );
    for (const input of inputs) {
      expect(await instance.invokeTool(runtimeSessionId, input)).toMatchObject({
        state: 'outcome_unknown',
        error: { code: 'managed_mcp_timeout' },
      });
    }
    const next = (id: string) =>
      instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, id, {
          kind: 'tool_call',
          name: 'echo',
          arguments: {},
        }),
      );
    expect((await next('over-quota')).error?.code).toBe(
      'managed_mcp_inflight_quota',
    );
    await writeFile(releaseFile, 'release');
    await vi.waitFor(() => {
      for (const input of inputs)
        expect(instance.toolStatus(runtimeSessionId, input).state).toBe(
          'settled',
        );
    });
    await next('after-replies');
    await vi.waitFor(async () => {
      const response = await instance.control(runtimeSessionId, {
        kind: 'mcp-status',
        sessionKey,
        operationId: 'quota-status',
        targetOperationId: 'after-replies',
      });
      expect(response.response).toHaveProperty('content');
    });
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8')).match(
        /tools\/call/g,
      ),
    ).toHaveLength(33);
  });

  it('preserves settlement evidence after cancellation and a configured timeout', async () => {
    const instance = runtime([{ ...stdioDefinition(), timeoutMs: 50 }]);
    const catalog = (await settled(instance, configure())).catalog!;
    const releaseFile = path.join(directory, 'release-timeout');
    const input = invoke(catalog, 'timed-out', {
      kind: 'tool_call',
      name: 'delayed',
      arguments: { releaseFile },
    });
    const response = await instance.invokeTool(runtimeSessionId, input);
    expect(response.state).toBe('outcome_unknown');
    instance.cancelTool(runtimeSessionId, input);
    expect(
      await readFile(path.join(directory, 'calls-1'), 'utf8'),
    ).not.toContain('cancel:timed-out');
    expect(instance.hasHolds(runtimeSessionId)).toBe(true);
    await writeFile(releaseFile, 'release');
    await vi.waitFor(() =>
      expect(instance.toolStatus(runtimeSessionId, input).state).toBe(
        'settled',
      ),
    );
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8'))
        .split('\n')
        .filter((line) => line === 'tools/call'),
    ).toHaveLength(1);
  });

  it('caps catalog entries and settles oversized completed output without retaining an unknown hold', async () => {
    const definition = stdioDefinition();
    const instance = runtime([
      { ...definition, env: { ...definition.env, LARGE_CATALOG: '1' } },
    ]);
    const catalog = (await settled(instance, configure())).catalog!;
    expect(catalog.discovery.tools).toBe('partial');
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'echo',
      'delayed',
      'drop',
    ]);
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(16 * 1024);
    const request = invoke(catalog, 'oversized', {
      kind: 'tool_call',
      name: 'echo',
      arguments: { large: true },
    });
    const result = await instance.invokeTool(runtimeSessionId, request);
    expect(result).toEqual({
      operationId: 'oversized',
      state: 'settled',
      error: { code: 'managed_mcp_output_limit' },
    });
    expect(await instance.invokeTool(runtimeSessionId, request)).toEqual(
      result,
    );
    expect(
      (
        await settled(instance, {
          kind: 'mcp-release',
          sessionKey,
          operationId: 'release',
          serverId: 'fixture',
          serverRevision: 1,
          connectionGeneration: catalog.connectionGeneration,
          grant: grant('configuration-1'),
        })
      ).response,
    ).toEqual({ released: true });
    expect(instance.hasHolds(runtimeSessionId)).toBe(false);
  });

  it('rechecks grant expiry after resolving the active Session directory', async () => {
    let resolve: (directory: string) => void = () => undefined;
    const activeDirectory = new Promise<string>((complete) => {
      resolve = complete;
    });
    const instance = new ManagedMcpRuntime(
      { ...sessionKey, workspaceGeneration: '1' },
      async () => activeDirectory,
      { version: 1, servers: [stdioDefinition()] },
    );
    runtimes.push(instance);
    const now = Date.now();
    const request = {
      ...configure(),
      grant: { ...grant('configuration-1'), expiresAt: now + 1000 },
    };
    const pending = instance.control(runtimeSessionId, request);
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    resolve(directory);
    await expect(pending).rejects.toThrow('managed_mcp_grant_invalid');
    time.mockRestore();
    expect(instance.hasHolds(runtimeSessionId)).toBe(false);
  });

  it('bounds concurrent calls before dispatch and rejects expired or wrong-generation grants', async () => {
    const instance = runtime();
    const expired = configure();
    await expect(
      instance.control(runtimeSessionId, {
        ...expired,
        grant: { ...expired.grant, expiresAt: 1 },
      }),
    ).rejects.toThrow('managed_mcp_grant_invalid');
    await expect(
      instance.control(runtimeSessionId, {
        ...expired,
        grant: { ...expired.grant, workspaceGeneration: '2' },
      }),
    ).rejects.toThrow('managed_mcp_grant_invalid');
    const catalog = (await settled(instance, configure())).catalog!;
    const calls = Array.from({ length: 33 }, (_, index) =>
      instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, `quota-${index}`, {
          kind: 'tool_call',
          name: 'delayed',
          arguments: {},
        }),
      ),
    );
    const results = await Promise.all(calls);
    expect(
      results.filter(
        (result) => result.error?.code === 'managed_mcp_inflight_quota',
      ),
    ).toHaveLength(1);
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8'))
        .split('\n')
        .filter((line) => line === 'tools/call'),
    ).toHaveLength(32);
  });

  it('ignores duplicate settled responses without disrupting other requests', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    const original = invoke(catalog, 'completed-call', {
      kind: 'tool_call',
      name: 'echo',
      arguments: {},
    });
    const receipt = await instance.invokeTool(runtimeSessionId, original);
    expect(receipt.state).toBe('settled');
    const releaseFile = path.join(directory, 'release');
    const waiting = invoke(catalog, 'waiting-call', {
      kind: 'tool_call',
      name: 'echo',
      arguments: { releaseFile },
    });
    const pending = instance.invokeTool(runtimeSessionId, waiting);
    try {
      await vi.waitFor(async () => {
        const calls = await readFile(path.join(directory, 'calls-1'), 'utf8');
        expect(calls.split('tools/call')).toHaveLength(3);
      });
      const duplicate = await instance.invokeTool(
        runtimeSessionId,
        invoke(catalog, 'duplicate-trigger', {
          kind: 'tool_call',
          name: 'echo',
          arguments: { duplicateId: original.operationId },
        }),
      );
      expect(duplicate.state).toBe('settled');
      expect(instance.toolStatus(runtimeSessionId, waiting).state).toBe(
        'running',
      );
      expect(instance.toolStatus(runtimeSessionId, original)).toEqual(receipt);
      expect(
        (
          await instance.invokeTool(
            runtimeSessionId,
            invoke(catalog, 'still-usable', {
              kind: 'tool_call',
              name: 'echo',
              arguments: {},
            }),
          )
        ).error,
      ).toBeUndefined();
    } finally {
      await writeFile(releaseFile, 'done');
    }
    expect((await pending).state).toBe('settled');
  });

  it('counts replacement and retiring connections against the connection quota', async () => {
    const definitions = Array.from({ length: 17 }, (_, index) => ({
      ...stdioDefinition(),
      serverId: `fixture-${index}`,
    }));
    const instance = runtime(definitions);
    const views = await Promise.all(
      definitions.map((definition, index) =>
        settled(instance, {
          ...configure(),
          serverId: definition.serverId,
          operationId: `configuration:${index}`,
          grant: grant(`configuration:${index}`),
        }),
      ),
    );
    expect(
      views.filter(
        (view) => view.error?.code === 'managed_mcp_connection_quota',
      ),
    ).toHaveLength(1);
    expect(views.filter((view) => view.catalog)).toHaveLength(16);
  }, 30_000);

  it('preserves unknown and holds the Session when a server exits after dispatch', async () => {
    const instance = runtime();
    const catalog = (await settled(instance, configure())).catalog!;
    const call = invoke(catalog, 'dropped', {
      kind: 'tool_call',
      name: 'drop',
      arguments: {},
    });
    expect((await instance.invokeTool(runtimeSessionId, call)).state).toBe(
      'outcome_unknown',
    );
    expect((await instance.invokeTool(runtimeSessionId, call)).state).toBe(
      'outcome_unknown',
    );
    expect(instance.hasHolds(runtimeSessionId)).toBe(true);
    expect(
      (await readFile(path.join(directory, 'calls-1'), 'utf8'))
        .split('\n')
        .filter((line) => line === 'tools/call'),
    ).toHaveLength(1);
  });

  it('reclaims idle replaced connections without losing their receipts', async () => {
    const instance = runtime();
    const first = await settled(instance, configure());
    for (let revision = 2; revision <= 18; revision++) {
      const replacement = await settled(instance, {
        ...configure(),
        configRevision: revision,
        operationId: `configuration-${revision}`,
        grant: grant(`configuration-${revision}`),
      });
      expect(replacement.error).toBeUndefined();
      expect(replacement.catalog?.configRevision).toBe(revision);
    }
    expect(await instance.control(runtimeSessionId, configure())).toEqual(
      first,
    );
    expect(
      (
        await settled(instance, {
          kind: 'mcp-release',
          sessionKey,
          operationId: 'release-retired',
          serverId: 'fixture',
          serverRevision: 1,
          connectionGeneration: first.catalog!.connectionGeneration,
          grant: grant('configuration-1'),
        })
      ).response,
    ).toEqual({ released: true });
  }, 30_000);

  it('rebinds a drained definition with a new generation and keeps the old receipt', async () => {
    const resolveDirectory = vi.fn(async () => directory);
    const instance = new ManagedMcpRuntime(
      { ...sessionKey, workspaceGeneration: '1' },
      resolveDirectory,
      { version: 1, servers: [stdioDefinition()] },
    );
    runtimes.push(instance);
    const first = await settled(instance, configure());
    resolveDirectory.mockRejectedValue(new Error('directory revoked'));
    const release: ManagedMcpControl = {
      kind: 'mcp-release',
      sessionKey,
      operationId: 'release-first',
      serverId: 'fixture',
      serverRevision: 1,
      connectionGeneration: first.catalog!.connectionGeneration,
      grant: grant('configuration-1'),
    };
    expect((await settled(instance, release)).response).toEqual({
      released: true,
    });
    expect(resolveDirectory).toHaveBeenCalledTimes(1);
    resolveDirectory.mockResolvedValue(directory);
    const second = await settled(instance, {
      ...configure(),
      configRevision: 2,
      operationId: 'configuration-2',
      grant: grant('configuration-2'),
    });
    expect(second.catalog!.connectionGeneration).toBeGreaterThan(
      first.catalog!.connectionGeneration,
    );
    expect(second.catalog!.serverRevision).toBe(1);
    expect(await instance.control(runtimeSessionId, configure())).toEqual(
      first,
    );
    const stale = await instance.invokeTool(
      runtimeSessionId,
      invoke(first.catalog!, 'stale-call', {
        kind: 'tool_call',
        name: 'echo',
        arguments: {},
      }),
    );
    expect(stale.error?.code).toBe('managed_mcp_binding_conflict');
    const valid = await instance.invokeTool(
      runtimeSessionId,
      invoke(second.catalog!, 'new-call', {
        kind: 'tool_call',
        name: 'echo',
        arguments: {},
      }),
    );
    expect(valid.state).toBe('settled');
    expect(valid.error).toBeUndefined();
    const foreignGrant = invoke(second.catalog!, 'foreign-grant', {
      kind: 'tool_call',
      name: 'echo',
      arguments: {},
    });
    expect(
      (
        await instance.invokeTool(runtimeSessionId, {
          ...foreignGrant,
          grant: grant('another-configuration'),
        })
      ).error?.code,
    ).toBe('managed_mcp_grant_invalid');
  });

  it.each(['streamable-http', 'sse'] as const)(
    'runs real %s discovery and raw resource requests',
    async (transport) => {
      let events: ServerResponse | undefined;
      let failPrompts = true;
      const methods: string[] = [];
      const accepts: string[] = [];
      const server = createServer(async (request, response) => {
        expect(request.headers['authorization']).toBe(
          'Bearer scoped-test-secret',
        );
        if (request.method === 'DELETE') {
          response.writeHead(503).end();
          return;
        }
        if (request.method === 'GET' && transport === 'sse') {
          accepts.push(request.headers.accept ?? '');
          if (!request.headers.accept?.includes('text/event-stream')) {
            response.writeHead(406).end();
            return;
          }
          events = response;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('event: endpoint\ndata: /messages\n\n');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: string | number;
          method: string;
        };
        methods.push(body.method);
        const result =
          body.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { resources: {} },
                serverInfo: { name: 'http-fixture', version: '1' },
              }
            : body.method === 'tools/list'
              ? { tools: [] }
              : body.method === 'resources/list'
                ? { resources: [{ uri: 'data://binary', name: 'binary' }] }
                : body.method === 'prompts/list'
                  ? failPrompts
                    ? undefined
                    : { prompts: [{ name: 'recovered' }] }
                  : body.method === 'resources/read'
                    ? { contents: [{ uri: 'data://binary', blob: 'AQID' }] }
                    : {};
        const answer = {
          jsonrpc: '2.0',
          id: body.id,
          ...(result
            ? { result }
            : {
                error: {
                  code: -32000,
                  message: 'synthetic failure scoped-test-secret',
                },
              }),
        };
        if (transport === 'sse') {
          response.writeHead(202).end();
          if (body.id !== undefined)
            events!.write(
              `event: message\ndata: ${JSON.stringify(answer)}\n\n`,
            );
        } else if (body.id === undefined) response.writeHead(202).end();
        else
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'mcp-session-id': 'test-session',
            })
            .end(JSON.stringify(answer));
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address() as { port: number };
      const instance = runtime([
        {
          tenantId: sessionKey.tenantId,
          workspaceId: sessionKey.workspaceId,
          serverId: 'fixture',
          serverRevision: 1,
          definitionDigest,
          transport,
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: 'Bearer scoped-test-secret' },
        },
      ]);
      const configured = await settled(instance, configure());
      if (transport === 'sse') expect(accepts).toEqual(['text/event-stream']);
      expect(configured.error).toBeUndefined();
      expect(configured.catalog!.discovery).toEqual({
        tools: 'complete',
        resources: 'complete',
        prompts: 'failed',
      });
      expect(configured.catalog!.tools).toEqual([]);
      expect(JSON.stringify(configured)).not.toContain('scoped-test-secret');
      const discover = (operationId: string) =>
        settled(instance, {
          kind: 'mcp-discover',
          sessionKey,
          operationId,
          serverId: 'fixture',
          serverRevision: 1,
          connectionGeneration: configured.catalog!.connectionGeneration,
          grant: grant('configuration-1'),
        });
      for (const operationId of ['refresh-first', 'refresh-second']) {
        expect((await discover(operationId)).catalog).toEqual(
          configured.catalog,
        );
      }
      failPrompts = false;
      const recovered = await discover('refresh-recovered');
      expect(recovered.catalog).toMatchObject({
        connectionGeneration: configured.catalog!.connectionGeneration,
        catalogRevision: configured.catalog!.catalogRevision + 1,
        prompts: [{ name: 'recovered' }],
        discovery: { prompts: 'complete' },
      });
      expect((await discover('refresh-unchanged')).catalog).toEqual(
        recovered.catalog,
      );
      expect(methods.filter((method) => method === 'initialize')).toHaveLength(
        1,
      );
      const result = await settled(
        instance,
        invoke(recovered.catalog!, 'read-http', {
          kind: 'resource_read',
          uri: 'data://binary',
        }),
      );
      expect(result.response?.['contents']).toEqual([
        { uri: 'data://binary', blob: 'AQID' },
      ]);
      expect(
        methods.filter((method) => method === 'resources/read'),
      ).toHaveLength(1);
      expect(
        (
          await settled(instance, {
            kind: 'mcp-release',
            sessionKey,
            operationId: 'release-http',
            serverId: 'fixture',
            serverRevision: 1,
            connectionGeneration: configured.catalog!.connectionGeneration,
            grant: grant('configuration-1'),
          })
        ).response,
      ).toEqual({ released: true });
      expect(instance.hasHolds(runtimeSessionId)).toBe(false);
      events?.end();
    },
  );
});
