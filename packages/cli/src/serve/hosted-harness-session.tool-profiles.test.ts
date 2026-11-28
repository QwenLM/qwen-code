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
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it.each(['hosted-workspace-files/1', 'hosted-workspace-files/2'])(
    'pins %s through create and load and advertises glob',
    async (toolProfile) => {
      const body = {
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send(
        body,
      );
      expect(created.status).toBe(200);
      let createDeclarations: string[] | undefined;
      state.model.mockImplementationOnce(async ({ toolTurn }) => {
        // Capture, don't assert: an AssertionError inside this callback is
        // swallowed by executeHostedTurn's catch, so only an assertion after
        // the turn settles can fail the test.
        createDeclarations = (
          await toolTurn!.declarations(new AbortController().signal)
        ).map((tool) => tool.name!);
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
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(createDeclarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
      ]);
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
            toolProfile:
              toolProfile === 'hosted-workspace-files/1'
                ? 'hosted-workspace-files/2'
                : 'hosted-workspace-files/1',
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
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(resumedDeclarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
      ]);
      expect(state.model).toHaveBeenCalledTimes(2);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it('rejects the removed Shell profile on creation and load', async () => {
    const server = await app(true);
    for (const route of ['/session', `/session/${SESSION_ID}/load`]) {
      const response = await headers(supertest(server).post(route)).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/2',
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('hosted_tool_profile_unavailable');
    }
    expect(state.model).not.toHaveBeenCalled();
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
    // Captured here and asserted after the Turn: an assertion inside the
    // model mock fails only the Turn, which the test would not see.
    let firstDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      firstDeclarations = (
        await toolTurn!.declarations(new AbortController().signal)
      ).map((tool) => tool.name!);
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(firstDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'web_fetch',
      'run_shell_command',
      'glob',
      'todo_write',
      // H4b: a Shell-laned root Session advertises its Agent tool,
      // and (H4d-b) messages the child tasks it launched.
      'agent',
      // H4e-b1: with the team domains enabled, so are its team tools.
      'team_create',
      'team_delete',
      // H4e-b3a: the lead stops a member itself.
      'request_shutdown',
      'task_create',
      'task_update',
      'task_list',
      'send_message',
      // #13803: and, behind its own kind gate, its Workflow tool.
      'workflow',
      'ask_user_question',
    ]);
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(resumedDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'web_fetch',
      'run_shell_command',
      'glob',
      'todo_write',
      // H4b: a Shell-laned root Session advertises its Agent tool,
      // and (H4d-b) messages the child tasks it launched.
      'agent',
      // H4e-b1: with the team domains enabled, so are its team tools.
      'team_create',
      'team_delete',
      // H4e-b3a: the lead stops a member itself.
      'request_shutdown',
      'task_create',
      'task_update',
      'task_list',
      'send_message',
      // #13803: and, behind its own kind gate, its Workflow tool.
      'workflow',
      'ask_user_question',
    ]);
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each(['Hook pin', 'extension config_install'])(
    'refuses an external files saved session with %s on cold load',
    async (configuration) => {
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
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
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: 'hosted-workspace-external-files/1',
                approvalMode: 'yolo',
                approvalTimeoutMs: 60_000,
                ...(configuration === 'Hook pin'
                  ? { hookCatalog: hookPin }
                  : {}),
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
      if (configuration === 'extension config_install') {
        const operationId = randomUUID();
        await managed.authority.commitDomainRecord(
          {
            operation: 'extensionConfig.apply.preparing',
            commandId: operationId,
            sessionKey: key,
            contentDigest: 'c'.repeat(64),
          },
          {
            domain: 'config_install',
            content: {
              kind: 'hosted-extension-config',
              formatVersion: 1,
              command: {
                operationId,
                actorKey: 'b'.repeat(64),
                expectedRevision: 0,
                extensions: [],
              },
              mode: 'apply',
              phaseOperationId: operationId,
              configRevision: 1,
              previousConfigRevision: 0,
              phase: 'preparing',
              previousBundleRef: null,
              restoresBundleRef: null,
              bundleRef: null,
              rootSnapshotRef: await resources.publish(
                'managed-root',
                Buffer.from(JSON.stringify({ cwd: state.root })),
              ),
              stageAckRefs: [],
              enableAckRefs: [],
              error: null,
            },
          },
          { class: 'trusted_entry' },
        );
      }
      await managed.close();
      const broker = vi.spyOn(HostedWorkspaceBroker.prototype, 'control');
      const response = await headers(
        supertest(await app(true)).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('hosted_tool_profile_conflict');
      expect(broker).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('requires the exact consumer token for external files create and lifecycle load', async () => {
    const descriptorCount = state.storeOptions.length;
    const result = express();
    result.use(express.json());
    const advertised = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID,
    );
    const contract = {
      ...advertised,
      features: advertised.features?.filter(
        (feature) => feature !== 'hosted-workspace-external-files/1',
      ),
    };
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    for (const route of ['/session', `/session/${SESSION_ID}/load`]) {
      const response = await headers(supertest(result).post(route)).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-external-files/1',
        ...(route.endsWith('/load')
          ? { lifecycleAuthority: { operationId: 'close', claimGeneration: 1 } }
          : {}),
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('hosted_tool_profile_unavailable');
    }
    expect(state.storeOptions).toHaveLength(descriptorCount);
  });

  it('preserves external files on cold load without hidden lanes and closes with lifecycle v1', async () => {
    const profile = 'hosted-workspace-external-files/1';
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: profile,
      })
      .expect(200);
    const assertNoLanes = async (clientId: string) => {
      for (const [route, code] of [
        ['automations/operations', 'hosted_automations_unavailable'],
        ['channels/operations', 'hosted_channels_unavailable'],
        ['files/rewind', 'hosted_file_history_unavailable'],
      ]) {
        const response = await headers(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({});
        expect(response.status).toBe(409);
        expect(response.body.code).toBe(code);
      }
      const prompt = [{ type: 'text', text: 'enter plan mode' }];
      const refusedPlan = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          approvalSelection: { mode: 'yolo', revision: 1, planMode: true },
        });
      expect(refusedPlan.status).toBe(400);
      expect(refusedPlan.body.code).toBe('invalid_hosted_approval_selection');
    };
    await assertNoLanes(created.body.clientId as string);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    await assertNoLanes(loaded.body.clientId as string);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
    const authority = { operationId: 'external-close', claimGeneration: 1 };
    const lifecycleLoad = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: profile,
        lifecycleProtocolVersion: 1,
        lifecycleAuthority: authority,
      })
      .expect(200);
    const closed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    )
      .set('X-Qwen-Client-Id', lifecycleLoad.body.clientId as string)
      .send({
        protocolVersion: 1,
        kind: 'close',
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority,
      })
      .expect(200);
    expect(closed.body.effects).toEqual([]);
    expect(state.authorizeLifecycle).toHaveBeenCalledWith('close');
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', lifecycleLoad.body.clientId as string)
      .send({ authority })
      .expect(204);
  });

  it.each([
    { agentDefinition: {} },
    { sessionSkillsRef: {} },
    { mcpServers: [] },
    { hookCatalog: {} },
    { initialSelection: {} },
    { lineage: {} },
    { childWorkspaces: true },
    { childSnapshots: true },
    { publicChildAgentsVersion: 1 },
    { captureBytes: 1024 },
    { planMode: true },
  ])(
    'refuses external files optional lanes on create and load: %j',
    async (extra) => {
      const server = await app(true);
      const definition = {
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-external-files/1',
      };
      await headers(supertest(server).post('/session'))
        .send({ ...definition, ...extra })
        .expect(400);
      const created = await headers(supertest(server).post('/session'))
        .send(definition)
        .expect(200);
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({ managedSessionStore: store(), ...extra })
        .expect(400);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), ...extra });
      expect([400, 409]).toContain(refused.status);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('admits external Shell create only with its capture reservation', async () => {
    const server = await app(true);
    const definition = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-external-shell/1',
    };
    // The external drain proves the captured bytes arrived, so the placement
    // refuses admission without a reserved capture budget.
    const missing = await headers(supertest(server).post('/session')).send(
      definition,
    );
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('hosted_tool_profile_conflict');
    // The refused create already wrote the Session header, so the admitted
    // retry uses a fresh Session id rather than loading the refused one.
    const admittedId = randomUUID();
    const created = await headers(supertest(server).post('/session'))
      .send({ ...definition, sessionId: admittedId, captureBytes: 4096 })
      .expect(200);
    await headers(supertest(server).post(`/session/${admittedId}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    // A cold load offering a different reservation conflicts with the saved
    // definition rather than silently re-reserving the capture.
    const conflict = await headers(
      supertest(server).post(`/session/${admittedId}/load`),
    ).send({ managedSessionStore: store(), captureBytes: 8192 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_tool_profile_conflict');
    const loaded = await headers(
      supertest(server).post(`/session/${admittedId}/load`),
    )
      .send({ managedSessionStore: store(), captureBytes: 4096 })
      .expect(200);
    // The excluded management lanes stay closed on the Shell placement.
    for (const [route, code] of [
      ['automations/operations', 'hosted_automations_unavailable'],
      ['channels/operations', 'hosted_channels_unavailable'],
    ]) {
      const response = await headers(
        supertest(server).post(`/session/${admittedId}/${route}`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({});
      expect(response.status).toBe(409);
      expect(response.body.code).toBe(code);
    }
    await headers(supertest(server).post(`/session/${admittedId}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
  });

  it.each([
    'hosted-workspace-files/1',
    'hosted-workspace-shell/1',
    'hosted-workspace-external-files/1',
  ])(
    'persists the foreground-only surface through resident and cold loads of %s',
    async (profile) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(true);
      const surface = async (clientId: string) => {
        let names: Array<string | undefined> = [];
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          const declarations = await toolTurn!.declarations(signal);
          names = declarations.map((tool) => tool.name);
          for (const tool of declarations) {
            if (tool.name === 'run_shell_command') {
              expect(tool.parametersJsonSchema).not.toHaveProperty(
                'properties.is_background',
              );
            }
          }
          return { text: 'ok', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: randomUUID() }];
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: randomUUID(),
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
          { timeout: settleTimeoutMs() },
        );
        expect(names).toEqual(
          profile === 'hosted-workspace-external-files/1'
            ? ['read_file', 'write_file', 'edit', 'glob']
            : [
                'read_file',
                'write_file',
                'edit',
                'web_fetch',
                ...(profile.includes('shell') ? ['run_shell_command'] : []),
                'glob',
                ...(profile.includes('shell') ? ['todo_write'] : []),
              ],
        );
      };
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: profile,
          foregroundOnly: true,
          ...(profile.includes('shell') ? { captureBytes: 1024 * 1024 } : {}),
        })
        .expect(200);
      let clientId = created.body.clientId as string;
      await surface(clientId);
      for (const foregroundOnly of [undefined, true]) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            passiveManagedRuntimeRecovery: true,
            ...(foregroundOnly === undefined ? {} : { foregroundOnly }),
          })
          .expect(200);
        await surface(clientId);
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          foregroundOnly: false,
        })
        .expect(409);
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          childWorkspaces: true,
        })
        .expect(profile === 'hosted-workspace-external-files/1' ? 400 : 409);
      await surface(clientId);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      for (const incompatible of [
        { foregroundOnly: false },
        { childWorkspaces: true },
      ]) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            ...incompatible,
          })
          .expect(409);
      }
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
        })
        .expect(200);
      clientId = loaded.body.clientId as string;
      await surface(clientId);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    },
  );

  it.each([
    { foregroundOnly: 'true' },
    { childWorkspaces: true },
    { mcpServers: [] },
    { hookCatalog: {} },
    { lineage: {} },
    { toolProfile: 'hosted-workspace-mcp/1' },
  ])('refuses incompatible SSH foreground-only creation: %j', async (extra) => {
    const server = await app(true);
    await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        foregroundOnly: true,
        ...extra,
      })
      .expect(400);
    expect(state.model).not.toHaveBeenCalled();
  });

  // #13753 I2: `childWorkspaces` describes the host, not the Session: the
  // create that carries it advertises isolation, and a later load answers
  // whatever that load restates, since nothing persists it.
  it('advertises worktree isolation only while the create or load restates the host capability', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const isolationOf = async (clientId: string): Promise<boolean> => {
      let declared: boolean | undefined;
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const agent = (await toolTurn!.declarations(signal)).find(
          (tool) => tool.name === 'agent',
        );
        declared =
          'isolation' in
          ((agent?.parametersJsonSchema as { properties?: object })
            ?.properties ?? {});
        return { text: 'ok', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: randomUUID() }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: randomUUID(),
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
        { timeout: settleTimeoutMs() },
      );
      expect(declared).toBeDefined();
      return declared!;
    };
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      childWorkspaces: true,
    });
    expect(created.status).toBe(200);
    expect(await isolationOf(created.body.clientId as string)).toBe(true);
    // A load re-answered from the resident Session restates it too.
    for (const childWorkspaces of [false, true]) {
      const resident = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        ...(childWorkspaces ? { childWorkspaces } : {}),
      });
      expect(resident.status).toBe(200);
      expect(resident.body.clientId).toBe(created.body.clientId);
      expect(await isolationOf(resident.body.clientId as string)).toBe(
        childWorkspaces,
      );
    }
    let clientId = created.body.clientId as string;
    for (const childWorkspaces of [undefined, 'true', true]) {
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        ...(childWorkspaces === undefined ? {} : { childWorkspaces }),
      });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      expect(await isolationOf(clientId)).toBe(childWorkspaces === true);
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  // #13753 I3: what a prompt's tool turn declares, read from inside it.
  async function declaredDuring(
    server: Parameters<typeof supertest>[0],
    clientId: string,
  ): Promise<{ tools: string[]; isolation?: unknown }> {
    let declared: { tools: string[]; isolation?: unknown } | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const tools = await toolTurn!.declarations(signal);
      const agent = tools.find((tool) => tool.name === 'agent');
      declared = {
        tools: tools.map((tool) => tool.name!),
        isolation: ((
          agent?.parametersJsonSchema as {
            properties?: Record<string, { enum?: unknown }>;
          }
        )?.properties ?? {})['isolation']?.enum,
      };
      return { text: 'ok', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: randomUUID() }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: randomUUID(),
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
      { timeout: settleTimeoutMs() },
    );
    expect(declared).toBeDefined();
    return declared!;
  }

  // #13753 I3: `childSnapshots` describes the host like `childWorkspaces`,
  // and counts only beside it.
  it('advertises snapshot isolation only while a create or load restates it beside child Workspaces', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      childWorkspaces: true,
      childSnapshots: true,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    expect((await declaredDuring(server, clientId)).isolation).toEqual([
      'worktree',
      'snapshot',
    ]);
    for (const [flags, isolation] of [
      [{ childWorkspaces: true }, ['worktree']],
      [{ childSnapshots: true }, undefined],
      [{ childWorkspaces: true, childSnapshots: 'true' }, ['worktree']],
      [
        { childWorkspaces: true, childSnapshots: true },
        ['worktree', 'snapshot'],
      ],
    ] as const) {
      const resident = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        ...flags,
      });
      expect(resident.status).toBe(200);
      expect((await declaredDuring(server, clientId)).isolation).toEqual(
        isolation,
      );
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  // The read profile is a saved profile: it is created, and its turns
  // declare the two read tools and no Agent tool, whatever the host serves.
  it('serves the read profile with its two read tools', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-read/1',
      approvalMode: 'default',
      childWorkspaces: true,
      childSnapshots: true,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    expect(await declaredDuring(server, clientId)).toEqual({
      tools: ['read_file', 'glob'],
      isolation: undefined,
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });
});
