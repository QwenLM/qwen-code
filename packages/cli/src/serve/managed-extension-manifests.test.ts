/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import type { OperationGrant } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { ManagedMcpRuntime } from './managed-mcp-runtime.js';
import { ManagedHookRuntime } from './managed-hook-runtime.js';
import { stageManagedExtensionManifests } from './managed-extension-manifests.js';
import { ManagedExtensionProcessOwners } from './managed-extension-process.js';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';

it('keeps private settings out of public MCP and Hook digest inputs', () => {
  const workspace = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    workspaceGeneration: '1',
  };
  const contributions = {
    skills: [],
    commands: [],
    agents: [],
    context: [],
    settings: [{ name: 'Token', envVar: 'TOKEN', sensitive: true }],
    mcpServers: {
      fixture: { command: process.execPath },
    },
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'printf "%s" "$TOKEN"' }] },
      ],
    },
  };
  const pin = {
    extensionId: 'one',
    packageRevision: 1,
    packageDigest: 'a'.repeat(64),
    settingsRevision: 1,
  };
  const build = (secret: string, settingsRevision = 1) =>
    stageManagedExtensionManifests({
      ...workspace,
      runtimeSessionId: 'root',
      command: {
        operationId: randomUUID(),
        actorKey: 'a'.repeat(64),
        expectedRevision: 0,
        extensions: [],
      },
      packages: [
        {
          pin: { ...pin, settingsRevision },
          assetRoot: '/private/package',
          contributions,
        },
      ],
      baseMcpServers: [],
      baseHookCatalog: null,
      mcp: new ManagedMcpRuntime(workspace, async () => undefined, {
        version: 1,
        servers: [],
      }),
      hooks: new ManagedHookRuntime(workspace, async () => undefined, {
        version: 1,
        catalogs: [],
      }),
      hydrated: () => ({
        environment: { TOKEN: secret, UNDECLARED: 'must-not-leak' },
        contributions,
      }),
    });
  const first = build('fixture-secret-a');
  const changedPrivateInput = build('fixture-secret-b');
  expect(first.mcpServers).toEqual(changedPrivateInput.mcpServers);
  expect(first.hookCatalog).toEqual(changedPrivateInput.hookCatalog);
  expect(first.mcpManifest.servers[0]?.env).toEqual({
    TOKEN: 'fixture-secret-a',
  });
  expect(first.hookManifest.catalogs[0]?.hooks[0]?.config).toMatchObject({
    env: { TOKEN: 'fixture-secret-a' },
  });
  expect(JSON.stringify(contributions)).not.toContain('fixture-secret');
  expect(JSON.stringify(first)).not.toContain('must-not-leak');
  const newRevision = build('fixture-secret-b', 2);
  expect(newRevision.mcpServers[0]?.definitionDigest).not.toEqual(
    first.mcpServers[0]?.definitionDigest,
  );
  expect(newRevision.hookCatalog?.definitionDigest).not.toEqual(
    first.hookCatalog?.definitionDigest,
  );
});

it('keeps unchanged package MCP revisions and restores their exact pins after worker reconstruction', () => {
  const workspace = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    workspaceGeneration: '1',
  };
  const mcp = new ManagedMcpRuntime(workspace, async () => undefined, {
    version: 1,
    servers: [],
  });
  const hooks = new ManagedHookRuntime(workspace, async () => undefined, {
    version: 1,
    catalogs: [],
  });
  const contributions = {
    skills: [],
    commands: [],
    agents: [],
    context: [],
    settings: [],
    hooks: {},
    mcpServers: { fixture: { command: process.execPath } },
  };
  const input = {
    ...workspace,
    runtimeSessionId: 'root',
    command: {
      operationId: randomUUID(),
      actorKey: 'a'.repeat(64),
      expectedRevision: 6,
      extensions: [],
    },
    packages: [
      {
        pin: {
          extensionId: 'one',
          packageRevision: 1,
          packageDigest: 'b'.repeat(64),
        },
        assetRoot: '/private/package',
        contributions,
      },
    ],
    baseMcpServers: [],
    baseHookCatalog: null,
    mcp,
    hooks,
    hydrated: () => ({ contributions, environment: {} }),
  };
  const initial = stageManagedExtensionManifests(input);
  mcp.installSessionDefinitions('root', initial.mcpManifest);
  const updated = stageManagedExtensionManifests({
    ...input,
    command: { ...input.command, expectedRevision: 7 },
  });
  expect(updated.mcpServers).toEqual(initial.mcpServers);
  const unrelated = stageManagedExtensionManifests({
    ...input,
    runtimeSessionId: 'other-root',
    command: { ...input.command, expectedRevision: 7 },
  });
  expect(unrelated.mcpServers[0]?.serverRevision).toBe(8);
  const reconstructed = new ManagedMcpRuntime(
    workspace,
    async () => undefined,
    { version: 1, servers: [] },
  );
  const restored = stageManagedExtensionManifests({
    ...input,
    command: { ...input.command, expectedRevision: 7 },
    mcp: reconstructed,
    preparedMcpServers: updated.mcpServers,
  });
  expect(restored.mcpServers).toEqual(initial.mcpServers);
  const conflicting = {
    ...initial.mcpManifest.servers[0]!,
    serverRevision: 1,
    definitionDigest: 'c'.repeat(64),
  };
  const conflictingRuntime = new ManagedMcpRuntime(
    workspace,
    async () => undefined,
    { version: 1, servers: [conflicting] },
  );
  expect(() =>
    stageManagedExtensionManifests({
      ...input,
      mcp: conflictingRuntime,
      baseMcpServers: [
        {
          serverId: conflicting.serverId,
          serverRevision: 1,
          definitionDigest: conflicting.definitionDigest,
        },
      ],
    }),
  ).toThrow('duplicate');
});

it.skipIf(process.platform !== 'darwin')(
  'delivers only each package declared settings to real MCP and Hook subprocesses without recipe env mappings',
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-env-'),
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'root',
    };
    const workspace = { ...key, workspaceGeneration: '1' };
    const ledger = ManagedRuntimeLedger.create({
      workFile: path.join(directory, 'ledger.json'),
      worker: {
        pid: process.pid,
        pgid: process.pid,
        incarnation: 'settings-test',
        startedAt: Date.now(),
        groupOwned: false,
      },
    });
    const owners = new ManagedExtensionProcessOwners(
      'developer-process-group',
      {
        ledger,
        directory: path.join(directory, 'owners'),
      },
    );
    const mcp = new ManagedMcpRuntime(
      workspace,
      async () => directory,
      {
        version: 1,
        servers: [],
      },
      owners,
    );
    const hooks = new ManagedHookRuntime(
      workspace,
      async () => directory,
      {
        version: 1,
        catalogs: [],
      },
      owners,
    );
    const probe =
      '{TOKEN:process.env.TOKEN,ONLY_ONE:process.env.ONLY_ONE??null,ONLY_TWO:process.env.ONLY_TWO??null,UNDECLARED:process.env.UNDECLARED??null}';
    const server = `
const {createInterface}=require("node:readline");
createInterface({input:process.stdin}).on("line",line=>{
 const req=JSON.parse(line);
 if(req.id===undefined)return;
 const result=req.method==="initialize"
 ?{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"settings",version:"1"}}
 :{tools:[{name:"probe",description:JSON.stringify(${probe}),inputSchema:{type:"object"}}]};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result})+"\\n");
});`;
    const packages = ['one', 'two'].map((name, index) => {
      const contributions: ManagedPackageContributions = {
        skills: [],
        commands: [],
        agents: [],
        context: [],
        settings: [
          { name: 'Token', envVar: 'TOKEN', sensitive: true },
          { name: 'Own value', envVar: `ONLY_${name.toUpperCase()}` },
        ],
        mcpServers: {
          probe: { command: process.execPath, args: ['-e', server] },
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({systemMessage:JSON.stringify(${probe})}))'`,
                },
              ],
            },
          ],
        },
      };
      return {
        pin: {
          extensionId: name,
          packageRevision: 1,
          packageDigest: String(index + 1).repeat(64),
          settingsRevision: 1,
        },
        assetRoot: path.join(directory, name),
        contributions,
      };
    });
    const staged = stageManagedExtensionManifests({
      ...workspace,
      runtimeSessionId: key.sessionId,
      command: {
        operationId: randomUUID(),
        actorKey: 'a'.repeat(64),
        expectedRevision: 0,
        extensions: packages.map((entry) => entry.pin),
      },
      packages,
      baseMcpServers: [],
      baseHookCatalog: null,
      mcp,
      hooks,
      hydrated: (root) => ({
        contributions: packages.find((entry) => entry.assetRoot === root)!
          .contributions,
        environment: {
          TOKEN: `${path.basename(root)}-secret`,
          ONLY_ONE: 'one-only',
          ONLY_TWO: 'two-only',
          UNDECLARED: 'must-not-leak',
        },
      }),
    });
    const grant = (
      operationId: string,
      domain: OperationGrant['domain'],
      phases: string[],
    ): OperationGrant => ({
      sessionKey: key,
      operationId,
      domain,
      operationRevision: 1,
      ownerId: 'owner',
      workspaceGeneration: '1',
      resourceScope: {
        recordRef: {
          resourceId: `record:${operationId}`,
          kind: `managed-${domain}`,
          schemaVersion: 1,
          byteLength: 1,
          digest: 'b'.repeat(64),
        },
        phases,
      },
      leaseDurationMs: 60_000,
      expiresAt: Date.now() + 60_000,
    });
    try {
      expect(
        JSON.stringify({
          packages,
          mcpServers: staged.mcpServers,
          hookCatalog: staged.hookCatalog,
        }),
      ).not.toContain('-secret');
      mcp.installSessionDefinitions(key.sessionId, staged.mcpManifest);
      hooks.installSessionManifest(key.sessionId, staged.hookManifest);
      for (const [index, pkg] of packages.entries()) {
        const expected = {
          TOKEN: `${pkg.pin.extensionId}-secret`,
          ONLY_ONE: index === 0 ? 'one-only' : null,
          ONLY_TWO: index === 1 ? 'two-only' : null,
          UNDECLARED: null,
        };
        const serverPin = staged.mcpServers[index]!;
        const configureId = `configure-${index}`;
        await mcp.control('owner', {
          kind: 'mcp-configure',
          sessionKey: key,
          operationId: configureId,
          ...serverPin,
          configRevision: 1,
          grant: grant(configureId, 'mcp_configuration', [
            'configure',
            'discover',
            'release',
          ]),
        });
        await vi.waitFor(
          async () => {
            const result = await mcp.control('owner', {
              kind: 'mcp-status',
              sessionKey: key,
              operationId: `query-${index}`,
              targetOperationId: configureId,
            });
            expect(result.state).toBe('settled');
            expect(result.error).toBeUndefined();
            expect(JSON.parse(result.catalog!.tools[0]!.description!)).toEqual(
              expected,
            );
          },
          { timeout: 10_000 },
        );
        const executeId = `hook-${index}`;
        await hooks.control('owner', {
          kind: 'hook-execute',
          sessionKey: key,
          operationId: executeId,
          pin: staged.hookCatalog!,
          hookId: staged.hookManifest.catalogs[0]!.hooks[index]!.hookId,
          input: {
            session_id: key.sessionId,
            cwd: directory,
            transcript_path: '',
            hook_event_name: HookEventName.PreToolUse,
            timestamp: new Date().toISOString(),
          },
          grant: grant(executeId, 'hook_execution', ['execute']),
        });
        await vi.waitFor(
          async () => {
            const result = await hooks.control('owner', {
              kind: 'hook-status',
              sessionKey: key,
              operationId: `hook-query-${index}`,
              targetOperationId: executeId,
            });
            expect(result.state).toBe('settled');
            expect(result.error).toBeUndefined();
            expect(result.result?.success).toBe(true);
            expect(JSON.parse(result.result!.output!.systemMessage!)).toEqual(
              expected,
            );
          },
          { timeout: 10_000 },
        );
      }
    } finally {
      await Promise.all([mcp.close(), hooks.close()]);
      await owners.stopAll();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
