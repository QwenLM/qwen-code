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
  headers,
  hookPin,
  mcpApp,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  useToolApprovals,
  waitFor,
} from './hosted-harness-session-approvals.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { create as createTar } from 'tar';
import { compileManagedExtensionPackage } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { prepareManagedPackageImport } from '@qwen-code/qwen-code-core/extension/managed-package-import.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { reloadStableOwnerIds } from './hosted-harness-session.js';
import {
  type HostedHookSession,
  hostedConfigScopedOwnerId,
} from './hosted-hook-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST } from './managed-extension-profile.js';
import { ManagedExtensionRuntime } from './managed-extension-runtime.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedHookCatalog } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';

describe('Hosted Harness tool approvals', () => {
  useToolApprovals();

  it.each([
    ['candidates', 'skill_source_busy', 'hosted_skill_source_unavailable'],
    ['snapshot', 'source_changed', 'hosted_skill_source_unavailable'],
    [
      'archive',
      'skill_snapshot_unavailable',
      'hosted_skill_snapshot_unavailable',
    ],
  ])(
    'preserves Runtime Skill refusals on the %s route without replay',
    async (route, code, fallback) => {
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'skillControl');
      const warm = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'warm')
        .mockResolvedValue();
      const { server, authorize } = await mcpApp();
      const warmCalls = warm.mock.calls.length;
      const operationId = randomUUID();
      const send = () => {
        const base = `/session/${SESSION_ID}/extensions/skills`;
        const request =
          route === 'snapshot'
            ? supertest(server)
                .post(`${base}/snapshot`)
                .send({
                  operationId,
                  owner: { bindingId: 'binding', generation: '1' },
                  path: '.qwen/skills/check',
                  digest: 'a'.repeat(64),
                })
            : supertest(server).get(
                route === 'candidates'
                  ? `${base}/candidates`
                  : `${base}/archives/${randomUUID()}?operationId=${operationId}&bindingId=binding&generation=1&offset=0`,
              );
        return authorize(request);
      };
      control.mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(409, code),
      );
      expect((await send().expect(409)).body).toMatchObject({ code });
      expect(control).toHaveBeenCalledOnce();
      control.mockRejectedValueOnce(new Error('private transport detail'));
      expect((await send().expect(409)).body).toMatchObject({ code: fallback });
      expect(control).toHaveBeenCalledTimes(2);
      expect(warm).toHaveBeenCalledTimes(warmCalls);
      expect(state.model).not.toHaveBeenCalled();
      await authorize(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
    },
  );

  it('loads a pinned standalone Skill through the skill tool on the first Hosted turn', async () => {
    const archive = path.join(state.root, 'source.tar.gz');
    await writeFile(
      path.join(state.root, 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nFollow PINNED_REVIEW_INSTRUCTIONS.',
    );
    await createTar({ cwd: state.root, file: archive, gzip: true }, [
      'SKILL.md',
    ]);
    const target = { platform: 'linux', arch: 'any' } as const;
    const prepared = await prepareManagedPackageImport(
      archive,
      {
        sourceKind: 'skill',
        sourceDigest: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
        target,
        compilerVersion: 1,
      },
      { destination: path.join(state.root, 'compiled') },
    );
    const runtime = new ManagedExtensionRuntime({
      executionMode: 'developer-process-group',
      directory: path.join(state.root, 'runtime'),
      admitted: async (sessionId) => sessionId === SESSION_ID,
      idle: () => true,
      compile: async (root) =>
        (await compileManagedExtensionPackage(root, { target })).contributions,
      drain: async () => undefined,
      install: async () => undefined,
    });
    await runtime.cache.upload(
      prepared.packageDigest,
      createReadStream(prepared.archivePath),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionControl',
    ).mockImplementation(async (operation) => {
      switch (operation.kind) {
        case 'extension-status':
          return {
            ...(await runtime.operationStatus(
              SESSION_ID,
              operation.operationId,
            )),
          };
        case 'extension-prepare':
          return {
            ...(await runtime.prepare(
              SESSION_ID,
              operation.command,
              operation,
            )),
          };
        case 'extension-activate':
          return {
            ...(await runtime.activate(SESSION_ID, operation.operationId)),
          };
        default:
          throw new Error(`Unexpected extension operation: ${operation.kind}`);
      }
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        initialSelection: {
          operationId: randomUUID(),
          actorKey: 'a'.repeat(64),
          expectedRevision: 0,
          extensions: [
            {
              extensionId: 'sample',
              packageRevision: 1,
              packageDigest: prepared.packageDigest,
            },
          ],
        },
      })
      .expect(200);
    state.model.mockImplementationOnce(async ({ signal, toolTurn, skills }) => {
      expect(skills?.invocations('/review:review')).toEqual(['review:review']);
      expect(await toolTurn!.declarations(signal)).toContainEqual(
        expect.objectContaining({ name: 'skill' }),
      );
      const args = { skill: 'review:review' };
      const call = {
        name: 'skill',
        args,
        callId: 'call-review',
        prompt_id: PROMPT_ID,
        isClientInitiated: false,
      };
      const result = await toolTurn!.execute(
        [call],
        [{ functionCall: { name: call.name, id: call.callId, args } }],
        'test-model',
        signal,
      );
      expect(JSON.stringify(result)).toContain('PINNED_REVIEW_INSTRUCTIONS');
      return { text: 'Reviewed', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review these changes' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        promptId: PROMPT_ID,
        prompt,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      expect(state.model).toHaveBeenCalledOnce();
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(200);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'Reviewed',
    });
  });

  it('loads a mixed skills+hook package on the first Hosted turn and reports hooks degraded', async () => {
    const archive = path.join(state.root, 'mixed.tar.gz');
    await writeFile(
      path.join(state.root, 'qwen-extension.json'),
      JSON.stringify({ name: 'review', version: '1.0.0' }),
    );
    await mkdir(path.join(state.root, 'skills', 'review'), {
      recursive: true,
    });
    await writeFile(
      path.join(state.root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nFollow PINNED_REVIEW_INSTRUCTIONS.',
    );
    await mkdir(path.join(state.root, 'hooks'), { recursive: true });
    await writeFile(
      path.join(state.root, 'hooks', 'hooks.json'),
      JSON.stringify({
        PostToolUse: [{ hooks: [{ type: 'command', command: 'collect.sh' }] }],
      }),
    );
    await createTar({ cwd: state.root, file: archive, gzip: true }, [
      'qwen-extension.json',
      'skills',
      'hooks',
    ]);
    const target = { platform: 'linux', arch: 'any' } as const;
    const prepared = await prepareManagedPackageImport(
      archive,
      {
        sourceKind: 'extension',
        sourceDigest: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
        target,
        compilerVersion: 1,
      },
      { destination: path.join(state.root, 'compiled-mixed') },
    );
    const runtime = new ManagedExtensionRuntime({
      executionMode: 'developer-process-group',
      directory: path.join(state.root, 'runtime-mixed'),
      admitted: async (sessionId) => sessionId === SESSION_ID,
      idle: () => true,
      compile: async (root) =>
        (await compileManagedExtensionPackage(root, { target })).contributions,
      drain: async () => undefined,
      install: async () => undefined,
    });
    await runtime.cache.upload(
      prepared.packageDigest,
      createReadStream(prepared.archivePath),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    let degradedComponents: ReadonlyArray<'mcp' | 'hooks'> | undefined;
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionControl',
    ).mockImplementation(async (operation) => {
      switch (operation.kind) {
        case 'extension-status':
          return {
            ...(await runtime.operationStatus(
              SESSION_ID,
              operation.operationId,
            )),
          };
        case 'extension-prepare': {
          const result = await runtime.prepare(
            SESSION_ID,
            operation.command,
            operation,
          );
          degradedComponents = result.packages[0]?.degradedComponents;
          return { ...result };
        }
        case 'extension-activate':
          return {
            ...(await runtime.activate(SESSION_ID, operation.operationId)),
          };
        default:
          throw new Error(`Unexpected extension operation: ${operation.kind}`);
      }
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        initialSelection: {
          operationId: randomUUID(),
          actorKey: 'a'.repeat(64),
          expectedRevision: 0,
          extensions: [
            {
              extensionId: 'sample',
              packageRevision: 1,
              packageDigest: prepared.packageDigest,
            },
          ],
        },
      })
      .expect(200);
    expect(degradedComponents).toEqual(['hooks']);
    state.model.mockImplementationOnce(async ({ signal, toolTurn, skills }) => {
      expect(skills?.invocations('/review:review')).toEqual(['review:review']);
      const args = { skill: 'review:review' };
      const call = {
        name: 'skill',
        args,
        callId: 'call-review-mixed',
        prompt_id: PROMPT_ID,
        isClientInitiated: false,
      };
      const result = await toolTurn!.execute(
        [call],
        [{ functionCall: { name: call.name, id: call.callId, args } }],
        'test-model',
        signal,
      );
      expect(JSON.stringify(result)).toContain('PINNED_REVIEW_INSTRUCTIONS');
      return { text: 'Reviewed mixed', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review these changes' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        promptId: PROMPT_ID,
        prompt,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      expect(state.model).toHaveBeenCalledOnce();
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(200);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'Reviewed mixed',
    });
  });

  it('loads a failed initial extension selection for management while keeping the first Prompt blocked', async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    let failPrepare = true;
    const runtimeStates = new Map<string, string>();
    const control = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'extensionControl')
      .mockImplementation(async (operation) => {
        const common = {
          operationId: operation.operationId,
          executionMode: 'developer-process-group',
        };
        if (operation.kind === 'extension-prepare') {
          if (failPrepare) throw new Error('invalid initial package');
          runtimeStates.set(operation.operationId, 'prepared');
          return {
            ...common,
            state: 'prepared',
            expectedRevision: operation.expectedRevision,
            revision: operation.expectedRevision + 1,
            packages: operation.extensions.map((pin) => ({
              pin,
              assetRoot: `extension://${pin.extensionId}/`,
              contributions: {
                skills: [],
                commands: [],
                agents: [],
                context: [],
                mcpServers: {},
                hooks: {},
                settings: [],
              },
            })),
            mcpServers: [],
            hookCatalog: null,
          };
        }
        if (operation.kind === 'extension-activate')
          runtimeStates.set(operation.operationId, 'active');
        return {
          ...common,
          state: runtimeStates.get(operation.operationId),
          revision: 1,
        };
      });
    const initialSelection = {
      operationId: randomUUID(),
      actorKey: 'a'.repeat(64),
      expectedRevision: 0,
      extensions: [
        {
          extensionId: 'sample',
          packageRevision: 1,
          packageDigest: 'b'.repeat(64),
        },
      ],
    };
    const definition = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      agentDefinition: {
        agentId: `agent_${'c'.repeat(32)}`,
        revision: '1',
        digest: 'd'.repeat(64),
      },
      initialSelection,
    };
    const original = await app(true);
    await headers(supertest(original).post('/session'))
      .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
      .expect(503);
    await headers(supertest(original).post(`/session/${SESSION_ID}/load`))
      .send(definition)
      .expect(503);
    expect(control.mock.calls.map(([operation]) => operation.kind)).toEqual([
      'extension-status',
      'extension-status',
      'extension-prepare',
    ]);
    const replacement = await app(true);
    const attachment = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ ...definition, passiveManagedRuntimeRecovery: true })
      .expect(200);
    expect(control).toHaveBeenCalledTimes(3);
    expect(HostedWorkspaceBroker.prototype.warm).toHaveBeenCalledOnce();
    expect(state.model).not.toHaveBeenCalled();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', attachment.body.clientId);
    const prompt = [{ type: 'text', text: 'start after configuration' }];
    const promptBody = {
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    };
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
    )
      .send(promptBody)
      .expect(409);
    failPrepare = false;
    const repair = await authorize(
      supertest(replacement).post(
        `/session/${SESSION_ID}/extensions/management`,
      ),
    )
      .send({ ...initialSelection, operationId: randomUUID() })
      .expect(202);
    expect(repair.body).toMatchObject({
      revision: 1,
      operation: { state: 'active' },
    });
    const callsBeforeConflict = control.mock.calls.length;
    const rejected = await authorize(
      supertest(replacement).post(
        `/session/${SESSION_ID}/extensions/management`,
      ),
    )
      .send({ ...initialSelection, operationId: randomUUID() })
      .expect(409);
    expect(rejected.body).toMatchObject({
      error: 'extension_config_revision_conflict',
    });
    expect(control).toHaveBeenCalledTimes(callsBeforeConflict);
    state.model.mockResolvedValue({ text: 'ready', model: 'test-model' });
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
    )
      .send(promptBody)
      .expect(202);
    await waitFor(async () => {
      const status = await authorize(
        supertest(replacement).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    expect(state.model).toHaveBeenCalledOnce();
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('rebuilds the Hook session on the new owner when a revision bump keeps the catalog while the mount is held', async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    const catalog: ManagedHookCatalog = {
      ...hookPin,
      hooks: [
        {
          hookId: 'Notification',
          eventName: HookEventName.Notification,
          sequential: false,
          async: false,
          failClosed: true,
          onceKey: null,
          config: { type: 'command' },
        },
      ],
    };
    const hookOwners: string[] = [];
    // R14-1: track terminal releases as durable RELEASED tombstones. The
    // enable() owner swap closes the previous owner; a post-swap apply failure
    // leaves the durable active naming the previous revision, so a reload
    // recomputes that same id and must still re-acquire it.
    const releasedOwners = new Set<string>();
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        releasedOwners.add(this.runtimeSessionId);
      },
    );
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        if (releasedOwners.has(this.runtimeSessionId))
          throw new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          );
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async function (this: HostedWorkspaceBroker, operation) {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog,
          };
        if (operation.kind === 'hook-execute')
          hookOwners.push(this.runtimeSessionId);
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
    const runtimeStates = new Map<string, string>();
    let currentRevision = 0;
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionControl',
    ).mockImplementation(async (operation) => {
      const common = {
        operationId: operation.operationId,
        executionMode: 'developer-process-group',
      };
      if (operation.kind === 'extension-prepare') {
        runtimeStates.set(operation.operationId, 'prepared');
        currentRevision = operation.expectedRevision + 1;
        return {
          ...common,
          state: 'prepared',
          expectedRevision: operation.expectedRevision,
          revision: currentRevision,
          packages: operation.extensions.map((pin) => ({
            pin,
            assetRoot: `extension://${pin.extensionId}/`,
            contributions: {
              skills: [],
              commands: [],
              agents: [],
              context: [],
              mcpServers: {},
              hooks: {},
              settings: [],
            },
          })),
          mcpServers: [],
          hookCatalog: hookPin,
        };
      }
      if (operation.kind === 'extension-activate')
        runtimeStates.set(operation.operationId, 'active');
      return {
        ...common,
        state: runtimeStates.get(operation.operationId),
        revision: currentRevision,
      };
    });
    const selection = (expectedRevision: number) => ({
      operationId: randomUUID(),
      actorKey: 'a'.repeat(64),
      expectedRevision,
      extensions: [
        {
          extensionId: 'sample',
          packageRevision: 1,
          packageDigest: 'b'.repeat(64),
        },
      ],
    });
    const definition = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      agentDefinition: {
        agentId: `agent_${'c'.repeat(32)}`,
        revision: '1',
        digest: 'd'.repeat(64),
      },
      initialSelection: selection(0),
    };
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
      .expect(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    // The initial selection already booted the extension to revision 1 with
    // the Hook catalog bound. Fire a Hook so the session acquires and holds
    // its Workspace mount.
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    )
      .send({
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      })
      .expect(200);
    // A revision bump that keeps the Hook catalog pin must close and rebuild
    // the Hook session on the new owner — not park the apply at
    // recovery_required because the mount is held.
    const second = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/extensions/management`),
    )
      .send(selection(1))
      .expect(202);
    expect(second.body).toMatchObject({
      revision: 2,
      operation: { state: 'active' },
    });
    // Pin the rebuild itself, not just "not parked": fire a second Hook and
    // observe which owner its broker carries. A no-arg handover would keep the
    // old owner; closing without rebuilding would leave no usable Hook session.
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const ownerFor = (revision: number) =>
      `extensions-components-${createHash('sha256')
        .update(JSON.stringify([sessionKey, revision]))
        .digest('hex')}`;
    expect(hookOwners[0]).toBe(ownerFor(1));
    // R14-1: the swap handed the old owner's mount back non-terminally. Its id
    // must stay re-acquirable — a post-swap apply failure leaves the durable
    // active naming revision 1, and the reload recomputes exactly this id.
    expect(releasedOwners.has(ownerFor(1))).toBe(false);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    )
      .send({
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'after bump', notification_type: 'test' },
      })
      .expect(200);
    expect(hookOwners).toHaveLength(2);
    expect(hookOwners[1]).toBe(ownerFor(2));
    expect(hookOwners[1]).not.toBe(hookOwners[0]);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('keeps the deterministic Hook owner re-acquirable across a detach and same-revision reload (R13-1)', async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    // A Broker that refuses to re-acquire a terminally released owner, exactly
    // as acquireNewSession refuses any non-ACQUIRING row. The released set is
    // the durable RELEASED tombstone: it survives the reload.
    const releasedOwners = new Set<string>();
    const runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = runtime;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        if (releasedOwners.has(this.runtimeSessionId))
          throw new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          );
        this.runtime = runtime;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        releasedOwners.add(this.runtimeSessionId);
      },
    );
    // A mount handback frees the mount without tombstoning the owner.
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockResolvedValue();
    const catalog: ManagedHookCatalog = {
      ...hookPin,
      hooks: [
        {
          hookId: 'Notification',
          eventName: HookEventName.Notification,
          sequential: false,
          async: false,
          failClosed: true,
          onceKey: null,
          config: { type: 'command' },
        },
      ],
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog,
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
    const runtimeStates = new Map<string, string>();
    let currentRevision = 0;
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionControl',
    ).mockImplementation(async (operation) => {
      const common = {
        operationId: operation.operationId,
        executionMode: 'developer-process-group',
      };
      if (operation.kind === 'extension-prepare') {
        runtimeStates.set(operation.operationId, 'prepared');
        currentRevision = operation.expectedRevision + 1;
        return {
          ...common,
          state: 'prepared',
          expectedRevision: operation.expectedRevision,
          revision: currentRevision,
          packages: operation.extensions.map((pin) => ({
            pin,
            assetRoot: `extension://${pin.extensionId}/`,
            contributions: {
              skills: [],
              commands: [],
              agents: [],
              context: [],
              mcpServers: {},
              hooks: {},
              settings: [],
            },
          })),
          mcpServers: [],
          hookCatalog: hookPin,
        };
      }
      if (operation.kind === 'extension-activate')
        runtimeStates.set(operation.operationId, 'active');
      return {
        ...common,
        state: runtimeStates.get(operation.operationId),
        revision: currentRevision,
      };
    });
    const selection = (expectedRevision: number) => ({
      operationId: randomUUID(),
      actorKey: 'a'.repeat(64),
      expectedRevision,
      extensions: [
        {
          extensionId: 'sample',
          packageRevision: 1,
          packageDigest: 'b'.repeat(64),
        },
      ],
    });
    const definition = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      agentDefinition: {
        agentId: `agent_${'c'.repeat(32)}`,
        revision: '1',
        digest: 'd'.repeat(64),
      },
      initialSelection: selection(0),
    };
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const ownerFor = (revision: number) =>
      `extensions-components-${createHash('sha256')
        .update(JSON.stringify([sessionKey, revision]))
        .digest('hex')}`;
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
      .expect(200);
    const clientId = created.body.clientId as string;
    const fireHook = (message: string) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/hooks/operations`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          operationId: randomUUID(),
          event: 'Notification',
          input: { message, notification_type: 'test' },
        });
    // Fire a Hook so the deterministic owner acquires and holds the mount.
    await fireHook('ready').expect(200);
    expect(releasedOwners.has(ownerFor(1))).toBe(false);
    // Detach, then reload the SAME Session at the SAME configRevision in a
    // fresh harness process. The load recomputes the identical deterministic
    // owner id; a terminal release on detach would have tombstoned it and the
    // next Hook's acquire would be refused.
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    // The detach must not terminally release the deterministic owner: the next
    // load recomputes the identical id from (sessionKey, configRevision) and
    // must re-acquire it. A terminal release here persists a RELEASED tombstone
    // that acquireNewSession refuses, killing every Hook after the reload. The
    // acquire mock above refuses any re-acquire of a released id, so this is
    // exactly the condition that would wedge the reload.
    expect(releasedOwners.has(ownerFor(1))).toBe(false);
  });

  it.each([
    { arm: 'detach', terminal: false },
    { arm: 'delete', terminal: true },
    { arm: 'detach, row already released', terminal: false, releasedRow: true },
    { arm: 'delete, no hold row', terminal: true, noHoldRow: true },
  ])(
    'exempts a durable MCP owner with no live object on $arm',
    async ({ terminal, releasedRow = false, noHoldRow = false }) => {
      // R8-2: the mcp-<digest> family needs the same durable source the
      // config-scoped family got in R5-1. A plain Session builds neither live
      // object, so nothing here is nulled by the test; the restore seeds the
      // owner from the Broker's hold rows and the durable configuration row
      // is what must keep it exempt.
      const released: string[] = [];
      const runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          released.push(this.runtimeSessionId);
        },
      );
      const durableMcpOwner = `mcp-${'e'.repeat(64)}`;
      const definition = {
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        publicChildAgentsVersion: 1,
      };
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
        .expect(200);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'activeHoldRuntimeSessionIds',
      ).mockResolvedValue(noHoldRow ? [] : [durableMcpOwner]);
      const reloaded = await app(true);
      const loaded = await headers(
        supertest(reloaded).post(`/session/${SESSION_ID}/load`),
      ).send(definition);
      expect(loaded.status).toBe(200);
      const resident = (
        wakeDeps.last as {
          session: {
            hooks?: unknown;
            mcp?: unknown;
            heldRuntimeTurns: Set<string>;
            managed: {
              authority: {
                extensionRecordsInDomain: (
                  domain: string,
                ) => ReadonlyArray<{ record: unknown }>;
              };
            };
          };
        }
      ).session;
      expect(resident.hooks).toBeUndefined();
      expect(resident.mcp).toBeUndefined();
      expect(resident.heldRuntimeTurns.has(durableMcpOwner)).toBe(!noHoldRow);
      const authority = resident.managed.authority;
      const recordsInDomain =
        authority.extensionRecordsInDomain.bind(authority);
      // A non-released configuration row naming that owner — the same row the
      // MCP constructor picks its owner from on the next load. The real parser
      // validates it, so a wrong shape fails here rather than passing vacuously.
      const configurationRecord = {
        configurationId: '11111111-1111-4111-8111-111111111111',
        runtimeSessionId: durableMcpOwner,
        serverId: 'sample',
        serverRevision: 1,
        configRevision: 1,
        catalogRevision: null,
        connectionGeneration: null,
        catalogRef: null,
        releaseState: releasedRow ? 'released' : 'active',
        run: {
          state: releasedRow ? 'cancelled' : 'admitted',
          execution: releasedRow ? 'not_started_proven' : 'intent',
          effectId: '11111111-1111-4111-8111-111111111111',
          executionCallId: null,
          dispatchId: null,
          deliveryId: null,
          delivery: null,
          definition: {
            definitionId: 'sample',
            definitionRevision: 1,
            definitionDigest: 'b'.repeat(64),
          },
          reason: null,
          runtime: null,
        },
      };
      vi.spyOn(authority, 'extensionRecordsInDomain').mockImplementation(
        (domain: string) =>
          domain === 'mcp_configuration'
            ? [{ record: configurationRecord }]
            : recordsInDomain(domain),
      );
      released.length = 0;
      const settled = terminal
        ? await headers(
            supertest(reloaded).delete(`/session/${SESSION_ID}`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
        : await headers(
            supertest(reloaded).post(`/session/${SESSION_ID}/detach`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(settled.status).toBe(204);
      // A detach must leave a live owner re-acquirable; only a delete may
      // tombstone it. A row already RELEASED is one no successor recomputes,
      // so it is not exempt and the detach drains it like any other hold.
      // With no hold row the drain cannot reach it either, so a delete only
      // discharges it if the sweep enumerates the durable MCP family (R9-1).
      expect(released.includes(durableMcpOwner)).toBe(terminal || releasedRow);
    },
  );

  it.each([
    { arm: 'v2 delete', terminal: true, protocol: 2 },
    { arm: 'v2 close', terminal: false, protocol: 2 },
    { arm: 'legacy delete', terminal: true, protocol: 1 },
    { arm: 'legacy detach', terminal: false, protocol: 1 },
    {
      arm: 'legacy delete, Hooks retained',
      terminal: true,
      protocol: 1,
      retained: true,
    },
    {
      arm: 'legacy delete, orphan release refused',
      terminal: true,
      protocol: 1,
      refused: true,
    },
    {
      arm: 'legacy delete, Broker restarted',
      terminal: true,
      protocol: 1,
      reconciling: true,
    },
    {
      arm: 'v2 delete, Broker restarted',
      terminal: true,
      protocol: 2,
      reconciling: true,
    },
    {
      arm: 'legacy delete, broker delegated to MCP',
      terminal: true,
      protocol: 1,
      retained: true,
      delegated: true,
    },
    {
      arm: 'legacy delete, owner acquired but no Hook ran',
      terminal: true,
      protocol: 1,
      retained: true,
      noHookRun: true,
    },
  ])(
    'releases the orphaned config-scoped owners a hook-free apply left behind ($arm)',
    async ({
      terminal,
      protocol,
      retained = false,
      refused = false,
      reconciling = false,
      delegated = false,
      noHookRun = false,
    }) => {
      // Both v2 operations end the Session (main #16728/#16882).
      const endsSession = terminal || protocol === 2;
      // R7-1, driven end to end: no session field is assigned by this test.
      // Installing hooks, firing one, then applying a revision whose bundle
      // carries no Hook catalog is enough for the real drain to nil the Hook
      // session and the real enable to skip rebuilding it. The earlier-owner
      // sweep lives on that object, so a delete used to answer 204 having
      // released nothing while the durable chain still named the owner.
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'capabilityDigest',
        'get',
      ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
      const runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
      const acquired: string[] = [];
      const released: string[] = [];
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
          acquired.push(this.runtimeSessionId);
        },
      );
      let orphanId = '';
      let refuseOrphan = refused;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          // A restarted Broker answers this on every attempt — the state it
          // answers from never changes, so rethrowing wedges the delete.
          if (reconciling && this.runtimeSessionId === orphanId)
            throw new HostedWorkspaceBrokerRejection(
              503,
              'runtime_reconciliation_required',
            );
          if (refuseOrphan && this.runtimeSessionId === orphanId) {
            refuseOrphan = false;
            throw new HostedWorkspaceBrokerRejection(
              409,
              'runtime_session_held',
            );
          }
          released.push(this.runtimeSessionId);
        },
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'releaseMount',
      ).mockResolvedValue();
      const catalog: ManagedHookCatalog = {
        ...hookPin,
        hooks: [
          {
            hookId: 'Notification',
            eventName: HookEventName.Notification,
            sequential: false,
            async: false,
            failClosed: true,
            onceKey: null,
            config: { type: 'command' },
          },
        ],
      };
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'hookControl',
      ).mockImplementation(async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog,
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
      });
      const runtimeStates = new Map<string, string>();
      let currentRevision = 0;
      let hookFree = false;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'extensionControl',
      ).mockImplementation(async (operation) => {
        const common = {
          operationId: operation.operationId,
          executionMode: 'developer-process-group',
        };
        if (operation.kind === 'extension-prepare') {
          runtimeStates.set(operation.operationId, 'prepared');
          currentRevision = operation.expectedRevision + 1;
          return {
            ...common,
            state: 'prepared',
            expectedRevision: operation.expectedRevision,
            revision: currentRevision,
            packages: operation.extensions.map((pin) => ({
              pin,
              assetRoot: `extension://${pin.extensionId}/`,
              contributions: {
                skills: [],
                commands: [],
                agents: [],
                context: [],
                mcpServers: {},
                hooks: {},
                settings: [],
              },
            })),
            mcpServers: [],
            hookCatalog: hookFree ? null : hookPin,
          };
        }
        if (operation.kind === 'extension-activate')
          runtimeStates.set(operation.operationId, 'active');
        return {
          ...common,
          state: runtimeStates.get(operation.operationId),
          revision: currentRevision,
        };
      });
      const selection = (expectedRevision: number) => ({
        operationId: randomUUID(),
        actorKey: 'a'.repeat(64),
        expectedRevision,
        extensions: [
          {
            extensionId: 'sample',
            packageRevision: 1,
            packageDigest: 'b'.repeat(64),
          },
        ],
      });
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const ownerFor = (revision: number) =>
        hostedConfigScopedOwnerId(sessionKey, revision);
      orphanId = ownerFor(1);
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          publicChildAgentsVersion: 1,
          initialSelection: selection(0),
          sessionId: SESSION_ID,
          sessionScope: 'thread',
        })
        .expect(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', created.body.clientId);
      // R8-1: `configure()` acquires the owner before any Hook fires, so an
      // owner with no Hook run has no `hook_execution` record for
      // `releaseEarlierOwners` to enumerate.
      if (!noHookRun)
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        )
          .send({
            operationId: randomUUID(),
            event: 'Notification',
            input: { message: 'ready', notification_type: 'test' },
          })
          .expect(200);
      const residentOf = () =>
        (
          wakeDeps.last as {
            session: {
              hooks?: unknown;
              mcp?: unknown;
              extensions?: { configRevisions: readonly number[] };
              toolProfile?: string;
              shell?: {
                monitorLoops?: Map<
                  string,
                  {
                    prepareLifecycle: () => void;
                    stop: (settle?: string) => Promise<void>;
                  }
                >;
              };
            };
          }
        ).session;
      // Ownership control: the owner really was acquired under revision 1's
      // deterministic id, so the assertions below cannot pass vacuously.
      expect(acquired).toContain(ownerFor(1));
      expect(residentOf().hooks).toBeDefined();
      hookFree = !retained;
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/extensions/management`),
      )
        .send(selection(1))
        .expect(202);
      // The shape is produced by the apply itself, not by this test.
      expect(residentOf().hooks === undefined).toBe(!retained);
      expect(residentOf().mcp).toBeUndefined();
      expect(residentOf().extensions?.configRevisions).toEqual([1, 2]);
      if (delegated) {
        // R9-2: build MCP on the Hooks broker and delegate, exactly as the
        // apply path does. `ownsBroker` now gates BOTH Hooks sweeps off, so
        // only the orphan sweep can still reach revision 1's owner.
        const hooks = residentOf().hooks as HostedHookSession;
        residentOf().mcp = {
          broker: hooks.broker,
          recoveryBlocked: false,
          hasPendingOperations: () => false,
          close: async () => {},
          closeResources: async () => {},
          reconcileEffects: async () => {},
        };
        hooks.delegateBrokerToMcp();
        // The legacy close refuses an MCP-carrying Shell resident outright,
        // so this arm runs the profile the legacy close admits MCP on.
        residentOf().toolProfile = 'hosted-workspace-mcp/1';
      }
      const stop = vi.fn(async () => {});
      const loopHost = residentOf();
      loopHost.shell ??= {};
      loopHost.shell.monitorLoops = new Map([
        ['watch', { prepareLifecycle: () => {}, stop }],
      ]);
      released.length = 0;
      const settled =
        protocol === 2
          ? await authorize(
              supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
            ).send({
              protocolVersion: 2,
              phase: 'settle_resources',
              kind: terminal ? 'delete' : 'close',
              toolProfile: 'hosted-workspace-shell/1',
              sessionKey,
              authority: {
                operationId: `orphan-${protocol}-${terminal ? 'delete' : 'close'}`,
                claimGeneration: 1,
              },
            })
          : terminal
            ? await authorize(
                supertest(server).delete(`/session/${SESSION_ID}`),
              )
            : await authorize(
                supertest(server).post(`/session/${SESSION_ID}/detach`),
              );
      if (refused) {
        // A refusal parks the delete instead of deregistering a Session whose
        // owner still holds work: the same discipline the held-Runtime drain
        // above it follows. The retry, once the hold clears, discharges it.
        expect(settled.status).not.toBe(204);
        expect(released.includes(ownerFor(1))).toBe(false);
        const retry = await authorize(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(retry.status).toBe(204);
        expect(released.includes(ownerFor(1))).toBe(true);
        return;
      }
      // The 503 is absorbed exactly as both held-Runtime drains absorb it,
      // so the Session still retires instead of looping on an answer that
      // cannot change (R8-1).
      expect(settled.status).toBe(protocol === 2 ? 200 : 204);
      // Absorbing the 503 is only half the sibling discipline: the stop it
      // could not prove must settle runtime_lost, not stop_requested.
      if (endsSession && !refused)
        expect(stop).toHaveBeenCalledWith(
          reconciling ? 'runtime_lost' : 'stop_requested',
        );
      if (reconciling) return;
      // A delete discharges the owner nobody else can reach; a detach must
      // leave it re-acquirable, or the next load's acquire is refused (R13-1).
      // Exactly once: with a live Hooks session its own close already swept
      // the superseded owner, and sweeping again here would rethrow the hold
      // fence that close absorbs into a retry (N4).
      // A broker-owning Hooks session sweeps the earlier owner itself AND the
      // orphan sweep no longer short-circuits (R8-1), so that shape releases it
      // twice; the redundant call is absorbed. Every other shape has exactly
      // one releaser.
      expect(released.filter((id) => id === ownerFor(1))).toHaveLength(
        endsSession ? (retained && !delegated && !noHookRun ? 2 : 1) : 0,
      );
    },
  );

  it.each(
    [
      { arm: 'v2 close', terminal: false, protocol: 2 },
      { arm: 'v2 delete', terminal: true, protocol: 2 },
      { arm: 'legacy detach', terminal: false, protocol: 1 },
      { arm: 'legacy delete', terminal: true, protocol: 1 },
    ].flatMap((route) =>
      (
        [
          'held turn',
          'mcp',
          'lease',
          'ordinary lease',
          'durable only',
          'durable lease',
        ] as const
      ).map((carrier) => ({
        ...route,
        carrier,
        arm: `${route.arm}, owner carried by ${carrier}`,
      })),
    ),
  )(
    'stops only what it may stop with a restored config-scoped owner ($arm)',
    async ({ terminal, protocol, carrier }) => {
      // Under main's lifecycle model (#16728/#16882) BOTH v2 operations end
      // the Session, so a v2 close discharges the owner exactly like a delete.
      // Only the v1 detach is a non-terminal exit a reload can follow.
      const endsSession = terminal || protocol === 2;
      // R28-1 on a Session that really owns the id: the owner is derived from
      // (sessionKey, configRevision) by an active extension bundle, not typed
      // as a literal. Three ids ride the restore — the owner, an ordinary turn,
      // and a client-chosen id that merely shares the owner's prefix. Only the
      // first is exempt, and only on a non-terminal close (R1-2).
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'capabilityDigest',
        'get',
      ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
      const releasedOwners = new Set<string>();
      const runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          releasedOwners.add(this.runtimeSessionId);
        },
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'releaseMount',
      ).mockResolvedValue();
      const catalog: ManagedHookCatalog = {
        ...hookPin,
        hooks: [
          {
            hookId: 'Notification',
            eventName: HookEventName.Notification,
            sequential: false,
            async: false,
            failClosed: true,
            onceKey: null,
            config: { type: 'command' },
          },
        ],
      };
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'hookControl',
      ).mockImplementation(async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog,
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
      });
      const runtimeStates = new Map<string, string>();
      let currentRevision = 0;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'extensionControl',
      ).mockImplementation(async (operation) => {
        const common = {
          operationId: operation.operationId,
          executionMode: 'developer-process-group',
        };
        if (operation.kind === 'extension-prepare') {
          runtimeStates.set(operation.operationId, 'prepared');
          currentRevision = operation.expectedRevision + 1;
          return {
            ...common,
            state: 'prepared',
            expectedRevision: operation.expectedRevision,
            revision: currentRevision,
            packages: operation.extensions.map((pin) => ({
              pin,
              assetRoot: `extension://${pin.extensionId}/`,
              contributions: {
                skills: [],
                commands: [],
                agents: [],
                context: [],
                mcpServers: {},
                hooks: {},
                settings: [],
              },
            })),
            mcpServers: [],
            hookCatalog: hookPin,
          };
        }
        if (operation.kind === 'extension-activate')
          runtimeStates.set(operation.operationId, 'active');
        return {
          ...common,
          state: runtimeStates.get(operation.operationId),
          revision: currentRevision,
        };
      });
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const owner = hostedConfigScopedOwnerId(sessionKey, 1);
      const ordinary = 'turn-ordinary';
      // A channel inputId is only length-bounded, so a caller can choose this.
      // It is not an owner and its Runtime is still owed a drain.
      const lookalike = `extensions-components-${'f'.repeat(64)}`;
      expect(lookalike).not.toBe(owner);
      // A wake turn's mapped id: not reload-stable, and not in the hold rows,
      // so only the lease handback can release it.
      const ordinaryLease = `wake-${'d'.repeat(64)}`;
      const definition = {
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        publicChildAgentsVersion: 1,
        initialSelection: {
          operationId: randomUUID(),
          actorKey: 'a'.repeat(64),
          expectedRevision: 0,
          extensions: [
            {
              extensionId: 'sample',
              packageRevision: 1,
              packageDigest: 'b'.repeat(64),
            },
          ],
        },
      };
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
        .expect(200);
      const clientId = created.body.clientId as string;
      await headers(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          operationId: randomUUID(),
          event: 'Notification',
          input: { message: 'ready', notification_type: 'test' },
        })
        .expect(200);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      releasedOwners.clear();
      // The lease arms keep the owner out of the hold rows: there the only
      // thing that could release it is the lease handback (R3-1).
      const leaseCarried =
        carrier === 'lease' ||
        carrier === 'ordinary lease' ||
        carrier === 'durable lease';
      const activeHolds = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
        .mockResolvedValue(
          leaseCarried ? [ordinary, lookalike] : [owner, ordinary, lookalike],
        );
      // A bare load carries no lifecycle authority, so the restore runs and
      // seeds the hold rows; the same Session can then settle under either
      // protocol (R28-1).
      const reloaded = await app(true);
      const loaded = await headers(
        supertest(reloaded).post(`/session/${SESSION_ID}/load`),
      ).send(definition);
      expect(loaded.status).toBe(200);
      expect(activeHolds).toHaveBeenCalled();
      const resident = (
        wakeDeps.last as {
          session: {
            heldRuntimeTurns: Set<string>;
            extensions?: { configRevisions: readonly number[] };
            hooks?: HostedHookSession;
            mcp?: {
              broker: { runtimeSessionId: string };
              recoveryBlocked: boolean;
              hasPendingOperations: () => boolean;
              close: (options: { terminal: boolean }) => Promise<void>;
              closeResources: (options: { terminal: boolean }) => Promise<void>;
              reconcileEffects: () => Promise<void>;
            };
            runtimeLeaseHeld?: { promptId: string; runtimeSessionId: string };
            toolProfile?: string;
            shell?: {
              monitorLoops?: Map<
                string,
                {
                  prepareLifecycle: () => void;
                  stop: (settle?: string) => Promise<void>;
                }
              >;
            };
          };
        }
      ).session;
      // Ownership control: without a real owner the exemption has nothing to
      // match, and every assertion below would pass for the wrong reason.
      expect(resident.hooks?.broker.runtimeSessionId).toBe(owner);
      expect(resident.heldRuntimeTurns.has(owner)).toBe(!leaseCarried);
      if (carrier === 'mcp') {
        // Hooks no longer names the owner, so a drain reduced to
        // `reloadStableOwnerIds({ hooks })` loses the exemption here (R3-4).
        resident.hooks = undefined;
        resident.mcp = {
          broker: { runtimeSessionId: owner },
          recoveryBlocked: false,
          hasPendingOperations: () => false,
          close: async () => {},
          closeResources: async () => {},
          reconcileEffects: async () => {},
        };
        // The legacy close refuses an MCP-carrying Shell resident outright
        // (hosted_lifecycle_required), so the legacy arms run the shape whose
        // legacy close admits MCP. The v2 arms stay on the Shell profile,
        // the only one this contract admits to lifecycle v2.
        if (protocol !== 2) resident.toolProfile = 'hosted-workspace-mcp/1';
      } else if (carrier === 'lease') {
        // A recovery load adopts the unsettled Turn's Runtime under the
        // owner id; the close hands that lease back (R3-1).
        resident.runtimeLeaseHeld = {
          promptId: ordinary,
          runtimeSessionId: owner,
        };
      } else if (carrier === 'durable only' || carrier === 'durable lease') {
        // The blocked-resident shape R5-1 describes: the passive load set
        // `blocked` and built neither live object, yet the durable
        // config_install chain still names revision 1. Only that chain can
        // supply the exemption here.
        resident.hooks = undefined;
        resident.mcp = undefined;
        expect(resident.extensions?.configRevisions).toContain(1);
        if (carrier === 'durable lease') {
          // R6-1: the same object-less resident, with the owner arriving on
          // the recovery lease instead of the hold rows. The carriers above
          // are mutually exclusive, so none of them reached this combination
          // — and it is the one where the deferral's premise fails: there is
          // no `hooks.close` to be the owner's terminal releaser, so a delete
          // that also declines the handback releases it nowhere.
          resident.runtimeLeaseHeld = {
            promptId: ordinary,
            runtimeSessionId: owner,
          };
        }
      } else if (carrier === 'ordinary lease') {
        // The other direction of the same decision: a lease that is NOT a
        // reload-stable owner must still be handed back, or the Workspace
        // stays pinned. Without this arm "always defer" survives (M06).
        resident.runtimeLeaseHeld = {
          promptId: ordinary,
          runtimeSessionId: ordinaryLease,
        };
      }
      const stop = vi.fn(async () => {});
      resident.shell ??= {};
      resident.shell.monitorLoops = new Map([
        ['watch', { prepareLifecycle: () => {}, stop }],
      ]);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const response =
        protocol === 2
          ? await headers(
              supertest(reloaded).post(`/session/${SESSION_ID}/lifecycle`),
            )
              .set('X-Qwen-Client-Id', loaded.body.clientId as string)
              .send({
                protocolVersion: 2,
                phase: 'settle_resources',
                kind: terminal ? 'delete' : 'close',
                toolProfile: 'hosted-workspace-shell/1',
                sessionKey,
                authority: {
                  operationId: `settle-${protocol}-${terminal ? 'delete' : 'close'}`,
                  claimGeneration: 1,
                },
              })
          : terminal
            ? await headers(
                supertest(reloaded).delete(`/session/${SESSION_ID}`),
              ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
            : await headers(
                supertest(reloaded).post(`/session/${SESSION_ID}/detach`),
              ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(response.status).toBe(protocol === 2 ? 200 : 204);
      // The ordinary turn and the lookalike always drain: they prove the loop
      // ran, and the lookalike pins that the exemption is not the prefix.
      expect(releasedOwners.has(hostedRuntimeSessionId(ordinary))).toBe(true);
      expect(releasedOwners.has(lookalike)).toBe(true);
      expect(releasedOwners.has(owner)).toBe(endsSession);
      // Skipping is not discharging: the obligation stays owed. What finally
      // releases the owner is a terminal close on a successor resident after
      // a reload — this resident cannot offer one, because the v2 close pins
      // lifecycleKind and every later kind conflicts (R2-6/R3-5).
      expect(resident.heldRuntimeTurns.has(owner)).toBe(
        leaseCarried ? false : !endsSession,
      );
      if (carrier === 'ordinary lease') {
        // M06: the deferral must not swallow an ordinary recovered lease.
        expect(releasedOwners.has(ordinaryLease)).toBe(true);
        expect(resident.runtimeLeaseHeld).toBeUndefined();
      }
      // Both drains word their deferral identically, and only a carrier that
      // put the owner in the hold rows reaches one. Asserting both directions
      // pins the line the lease assertion below cannot see: a delete releases
      // the owner instead of announcing a park it never made (M12).
      expect(
        stderr.mock.calls.some(([line]) =>
          String(line).includes(
            `detach keeps reload-stable owner ${owner} running: release deferred`,
          ),
        ),
      ).toBe(protocol !== 2 && !terminal && !leaseCarried);
      if (carrier === 'lease' || carrier === 'durable lease') {
        // R4-1: the lease path names the id it left running, like the drains
        // — but only when it really left it running. A terminal route releases
        // the owner (through its own close when one exists, through this
        // handback when none does), so the owed line there would report a leak
        // that does not exist (R4-1 follow-up, R6-1).
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes(
              `keeps reload-stable owner ${owner} running: release deferred`,
            ),
          ),
        ).toBe(protocol !== 2 && !terminal);
      }
      // The settle argument is reached on every arm, so a wrong one fails
      // rather than passing silently. A skipped owner proved no stop (R1-1);
      // an ordinary lease that was really handed back did prove one, so that
      // carrier settles stop_requested even on a detach. The stderr spy is
      // restored by this describe's afterEach, which also runs on a throw.
      expect(stop).toHaveBeenCalledWith(
        endsSession || carrier === 'ordinary lease'
          ? 'stop_requested'
          : 'runtime_lost',
      );
    },
  );

  it.each([
    {
      shape: 'Hooks alone holding the config-scoped owner',
      shared: false,
      hooksId: `extensions-components-${'a'.repeat(64)}`,
      mcpId: undefined,
      exempt: true,
    },
    {
      shape: 'Hooks alone holding a per-load activation owner',
      shared: false,
      hooksId: 'hooks-activation-1',
      mcpId: undefined,
      exempt: false,
    },
    {
      shape: 'MCP alone holding a durable mcp-<digest> owner',
      shared: false,
      hooksId: undefined,
      mcpId: 'mcp-abc123',
      exempt: true,
    },
    {
      shape: 'MCP alone holding the config-scoped owner',
      shared: false,
      hooksId: undefined,
      mcpId: `extensions-components-${'b'.repeat(64)}`,
      exempt: true,
    },
    {
      shape: 'a broker shared with Hooks carrying a per-load activation owner',
      shared: true,
      hooksId: 'hooks-activation-1',
      mcpId: 'hooks-activation-1',
      exempt: false,
    },
    {
      shape: 'a broker shared with Hooks carrying the config-scoped owner',
      shared: true,
      hooksId: `extensions-components-${'c'.repeat(64)}`,
      mcpId: `extensions-components-${'c'.repeat(64)}`,
      exempt: true,
    },
    {
      shape: 'a broker shared with Hooks carrying a durable mcp-<digest> owner',
      shared: true,
      hooksId: 'mcp-def456',
      mcpId: 'mcp-def456',
      exempt: true,
    },
    {
      shape: 'MCP alone holding a per-load activation owner',
      shared: false,
      hooksId: undefined,
      mcpId: 'hooks-activation-1',
      exempt: false,
    },
    {
      // The blocked-resident shape: bootstrap never completed, so neither
      // live object exists, yet the durable chain still names the revision
      // whose owner the restore seeded (R5-1).
      shape: 'no live broker, but the durable chain names the owner',
      shared: false,
      hooksId: undefined,
      mcpId: undefined,
      durableIds: [`extensions-components-${'d'.repeat(64)}`],
      exempt: true,
    },
    {
      // The R1-2 constraint on the same arm: an empty durable chain must not
      // exempt a client-chosen id that merely shares the prefix.
      shape: 'no live broker and an empty durable chain',
      shared: false,
      hooksId: undefined,
      mcpId: undefined,
      durableIds: [],
      probeId: `extensions-components-${'f'.repeat(64)}`,
      exempt: false,
    },
  ])('exempts only reload-stable owners: $shape', (c) => {
    // The route fixtures cannot drive every owner shape — a Session carrying
    // MCP on a workspace profile must settle through v2 and does not release
    // its writer for a reload — so the decision itself is pinned here. The
    // shared-broker rows pin that sharing is irrelevant: the load hands MCP's
    // broker to Hooks, so deciding by object identity exempted the durable
    // id when MCP owned the broker and tombstoned the very same id when
    // Hooks merely shared it (R14-1/R2-5/R2-7).
    const hooksBroker = c.hooksId ? { runtimeSessionId: c.hooksId } : undefined;
    const mcpBroker = c.mcpId
      ? c.shared
        ? hooksBroker
        : { runtimeSessionId: c.mcpId }
      : undefined;
    const owners = reloadStableOwnerIds({
      hooks: hooksBroker ? { broker: hooksBroker } : undefined,
      mcp: mcpBroker ? { broker: mcpBroker } : undefined,
      configScopedOwnerIds: c.durableIds,
    });
    const id = c.probeId ?? c.mcpId ?? c.hooksId ?? c.durableIds?.[0];
    expect(owners.has(id!)).toBe(c.exempt);
    expect(owners.size).toBe(c.exempt ? 1 : 0);
  });

  it('refuses the tool_stage recovery domain when extensions are disabled', async () => {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journalStore = new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: state.root,
      sessionId: SESSION_ID,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
    });
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
      journalStore,
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile: 'hosted-workspace-shell/1',
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
    const inputRef = await resources.publish(
      'managed-extension-command-input',
      Buffer.from(JSON.stringify({ command: 'printf x', timeout: 120000 })),
    );
    const toolStageId = `command-step-${'a'.repeat(64)}`;
    await managed.authority.commitExtensionRecord(
      {
        operation: 'commandStep.stage',
        commandId: randomUUID(),
        sessionKey: key,
        contentDigest: 'f'.repeat(64),
      },
      {
        domain: 'tool_stage',
        record: {
          kind: 'tool_stage',
          toolStageId,
          stepIndex: 0,
          toolName: 'shell',
          expansionId: `expansion-${'b'.repeat(32)}`,
          inputRef,
          permissionRef: null,
          resultRef: null,
          run: {
            state: 'admitted',
            reason: null,
            definition: {
              definitionId: 'shell',
              definitionRevision: 1,
              definitionDigest: 'c'.repeat(64),
            },
            executionCallId: toolStageId,
            effectId: null,
            dispatchId: null,
            deliveryId: null,
            execution: 'intent',
            runtime: null,
            delivery: null,
          },
        },
      },
      { class: 'trusted_entry' },
    );
    await managed.close();

    // Without extensions the tool_stage domain is unsupported and the load
    // must refuse restore verification rather than silently admit it.
    const plain = await app(true);
    const refused = await headers(
      supertest(plain).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('restore_verification_failed');
    await new Promise<void>((resolve) => plain.close(() => resolve()));
  });
});
