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
  setupHostedTextSession,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  mockApprovalTurn,
  sleep,
  statsOf,
  statusOf,
} from './hosted-harness-session-suspension.test-helper.js';
import type { Part } from '@google/genai';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { create as createTar } from 'tar';
import { compileManagedExtensionPackage } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { prepareManagedPackageImport } from '@qwen-code/qwen-code-core/extension/managed-package-import.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type Server } from 'node:http';
import path from 'node:path';
import supertest from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import * as approvalContinuation from './hosted-approval-continuation.js';
import { isHostedDurableMcpOwner } from './hosted-mcp-session.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST } from './managed-extension-profile.js';
import { ManagedExtensionRuntime } from './managed-extension-runtime.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
} from './hosted-tool-approval.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { isHostedConfigScopedOwner } from './hosted-hook-session.js';

describe('idle suspension', () => {
  beforeEach(setupHostedTextSession);

  async function promptApproval(
    server: Server,
    prompt: unknown[] = [{ type: 'text', text: 'write notes' }],
    deadlineMs?: number,
    toolProfile = 'hosted-workspace-files/1',
    definition: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        ...(toolProfile === 'hosted-workspace-confined-shell/1'
          ? { foregroundOnly: true }
          : {}),
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
        ...definition,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      })
      .expect(202);
    return clientId;
  }

  // Idles several periods inside the approval wait, so a park that must not
  // happen has had every chance to.
  async function promptAndIdleInApproval(
    server: Server,
    prompt?: unknown[],
    toolProfile?: string,
  ): Promise<string> {
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    waiting.mockClear();
    try {
      const clientId = await promptApproval(
        server,
        prompt,
        undefined,
        toolProfile,
      );
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return clientId;
    } finally {
      waiting.mockRestore();
    }
  }

  // A resident wait must not outlive its test: its live poll and its later
  // suspension would read and stamp the next test's shared state.
  async function endResidentApproval(server: Server, clientId: string) {
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  }

  // An extension command whose one step runs a Shell command, which asks in
  // the default approval mode. Returns the Broker's command executions, the
  // Hook catalog reads, and the initial extension selection that installs the
  // command. With `hooks`, the extension brings a Hook catalog, as production
  // staging derives one from a package's hooks.
  async function mockCommandStepTurn(hooks = false): Promise<{
    commands: unknown[];
    catalogReads: unknown[];
    selection: Record<string, unknown>;
  }> {
    const source = path.join(state.root, 'command-extension');
    await mkdir(path.join(source, 'commands'), { recursive: true });
    await writeFile(
      path.join(source, 'qwen-extension.json'),
      JSON.stringify({ name: 'sample', version: '1.0.0' }),
    );
    await writeFile(
      path.join(source, 'commands', 'run.md'),
      '---\ndescription: Run one step\n---\n!{printf parked}',
    );
    const archive = path.join(state.root, 'command-extension.tar.gz');
    await createTar({ cwd: source, file: archive, gzip: true }, [
      'qwen-extension.json',
      'commands',
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
      { destination: path.join(state.root, 'command-compiled') },
    );
    const runtime = new ManagedExtensionRuntime({
      executionMode: 'developer-process-group',
      directory: path.join(state.root, 'command-runtime'),
      admitted: async (sessionId) => sessionId === SESSION_ID,
      idle: () => true,
      compile: async (root) =>
        (await compileManagedExtensionPackage(root, { target })).contributions,
      drain: async () => undefined,
      install: async () => undefined,
      ...(hooks
        ? { stage: async () => ({ mcpServers: [], hookCatalog: hookPin }) }
        : {}),
    });
    const catalogReads: unknown[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async (operation) => {
        if (operation.kind !== 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            result: { success: true, outcome: 'success', duration: 0 },
          };
        catalogReads.push(operation.pin);
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: {
            ...operation.pin,
            hooks: [
              {
                hookId: HookEventName.Notification,
                eventName: HookEventName.Notification,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command' as const },
              },
            ],
          },
        };
      },
    );
    await runtime.cache.upload(
      prepared.packageDigest,
      createReadStream(prepared.archivePath),
    );
    mockApprovalTurn();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
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
    const commands: unknown[] = [];
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionCommand',
    ).mockImplementation(async (operation) => {
      commands.push((operation.input as Record<string, unknown>)['command']);
      return {
        state: 'settled',
        result: {
          executionStatus: 'success',
          responseParts: [{ text: 'parked' }],
        },
      };
    });
    state.model.mockImplementation(
      async ({ toolTurn, resumeFromToolResults, signal }) => {
        if (resumeFromToolResults)
          return { text: 'resumed', model: 'test-model' };
        const call = {
          name: 'skill',
          callId: 'command-step-call',
          args: { skill: 'sample:run' },
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
        throw new Error('The waiting command step unexpectedly continued.');
      },
    );
    return {
      commands,
      catalogReads,
      selection: {
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
    };
  }

  // A bare load must never answer the parked command step: answering writes
  // the plan's own skill call a result and destroys the continuation (R9-1).
  // Nor may it attach a Hooks Session, which no later load could then resume.
  // The extension configuration the plan pins cannot change meanwhile either.
  it.each([false, true])(
    'parks a command-step approval that a bare load leaves unanswered and the decision-delivery load resumes (hooks=%s)',
    async (hooks) => {
      state.wakeDispatch = true;
      state.actionParking = true;
      state.wakeStamps.length = 0;
      state.approvalSelections.set(SESSION_ID, {
        mode: 'default',
        revision: 0,
      });
      const fixture = await mockCommandStepTurn(hooks);
      const definition = {
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        initialSelection: fixture.selection,
      };
      try {
        const server = await app(true, undefined, true, { idleSuspendMs: 150 });
        const created = await headers(supertest(server).post('/session'))
          .send({
            ...definition,
            sessionId: SESSION_ID,
            sessionScope: 'thread',
            approvalMode: 'default',
            approvalTimeoutMs: 60_000,
          })
          .expect(200);
        const clientId = created.body.clientId as string;
        const prompt = [{ type: 'text', text: 'run the step' }];
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
          timeout: 5000,
        });
        expect(statsOf(server).parkRefusals).toEqual({});
        expect(fixture.catalogReads.length > 0).toBe(hooks);
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, clientId)).status).toBe(404);
          },
          { timeout: 5000 },
        );
        const read = () =>
          LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
        const parked = await read();
        const bare = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send(definition)
          .expect(409);
        expect(bare.body).toMatchObject({
          code: 'hosted_turn_recovery_required',
          reason: 'turn_unsettled',
        });
        const afterBare = await read();
        expect(
          afterBare.events
            .slice(parked.events.length)
            .filter((event) =>
              ['message.committed', 'action.changed', 'turn.settled'].includes(
                event.kind,
              ),
            ),
        ).toEqual([]);
        const requestId = afterBare.events.findLast(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'requested',
        )!.payload['requestId'] as string;
        expect(requestId).toMatch(/^command_approval_/);
        expect(fixture.commands).toEqual([]);
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send({ ...definition, passiveManagedRuntimeRecovery: true })
          .expect(200);
        const resumedClient = loaded.body.clientId as string;
        const apply = await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/extensions/management`,
          ),
        )
          .set('X-Qwen-Client-Id', resumedClient)
          .send({
            command: {
              ...fixture.selection,
              operationId: randomUUID(),
              expectedRevision: 1,
              extensions: [],
            },
          })
          .expect(409);
        expect(apply.body.code).toBe('hosted_turn_active');
        await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/actions/${requestId}/resolve`,
          ),
        )
          .set('X-Qwen-Client-Id', resumedClient)
          .send({
            optionId: 'allow',
            inputRevision: 1,
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
          })
          .expect(200);
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, resumedClient)).body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: false,
            });
          },
          { timeout: 5000 },
        );
        expect(fixture.commands).toEqual(['printf parked']);
        expect(state.model).toHaveBeenLastCalledWith(
          expect.objectContaining({ resumeFromToolResults: expect.any(Array) }),
        );
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, resumedClient)).status).toBe(404);
          },
          { timeout: 5000 },
        );
      } finally {
        state.wakeDispatch = false;
        state.actionParking = false;
        state.approvalSelections.clear();
      }
    },
  );

  // Stage 4 S5 pre-check (#18149): a native Hooks batch runs on the Hook
  // owner, so S5 depends on what the park's owner close leaves behind. A
  // command-step park on an extensions Session is the Hooks park that exists
  // before S5, and it rides the same config-scoped owner.
  it('hands back a config-scoped Hook owner mount at park and resumes its Hooks on the same owner', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const fixture = await mockCommandStepTurn(true);
    const executions: Array<{ event: unknown; tool: unknown; owner: string }> =
      [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async function (this: HostedWorkspaceBroker, operation) {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...operation.pin,
              hooks: [HookEventName.PreToolUse, HookEventName.PostToolUse].map(
                (eventName) => ({
                  hookId: eventName,
                  eventName,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                }),
              ),
            },
          };
        if (operation.kind === 'hook-execute')
          executions.push({
            event: operation.input['hook_event_name'],
            tool: Reflect.get(operation.input, 'tool_name'),
            owner: this.runtimeSessionId,
          });
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'hook-owner-claim',
    );
    const handbacks: string[] = [];
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockImplementation(async function (this: HostedWorkspaceBroker) {
      handbacks.push(this.runtimeSessionId);
    });
    const live = state.model.getMockImplementation()!;
    const resumedHistories: Array<readonly ChatRecord[]> = [];
    state.model.mockImplementation(async (input) => {
      if (input.resumeFromToolResults)
        resumedHistories.push(
          (input as { history?: readonly ChatRecord[] }).history ?? [],
        );
      return live(input);
    });
    const ownerOf = (contexts: unknown[]) =>
      contexts.map(
        (context) => (context as HostedWorkspaceBroker).runtimeSessionId,
      );
    const definition = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      initialSelection: fixture.selection,
    };
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const created = await headers(supertest(server).post('/session'))
        .send({
          ...definition,
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'run the step' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      const owner = executions[0]?.owner;
      expect(executions).toEqual([
        { event: HookEventName.PreToolUse, tool: 'skill', owner },
        { event: HookEventName.PreToolUse, tool: 'run_shell_command', owner },
      ]);
      expect(isHostedConfigScopedOwner(owner)).toBe(true);
      expect(handbacks).toEqual([owner]);
      expect(
        ownerOf(
          vi.mocked(HostedWorkspaceBroker.prototype.release).mock.contexts,
        ),
      ).not.toContain(owner);

      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
      acquire.mockClear();
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ ...definition, passiveManagedRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 5000 },
      );
      expect(fixture.commands).toEqual(['printf parked']);
      // The resumed batch reacquires the plan's Runtime on the same owner. The
      // completed PreToolUse occurrences are read back, not rerun, and the
      // approved step's PostToolUse runs once on that owner.
      expect(
        acquire.mock.calls.filter(
          (_, index) => ownerOf([acquire.mock.contexts[index]])[0] === owner,
        ),
      ).toContainEqual([{ runtimeBindingId: 'binding', generation: '1' }]);
      expect(executions).toEqual([
        { event: HookEventName.PreToolUse, tool: 'skill', owner },
        { event: HookEventName.PreToolUse, tool: 'run_shell_command', owner },
        { event: HookEventName.PostToolUse, tool: 'run_shell_command', owner },
      ]);
      expect(resumedHistories).toHaveLength(1);
      expect(
        resumedHistories[0].find(
          (record) =>
            record.type === 'user' && record.daemonPromptId === PROMPT_ID,
        )?.message?.parts,
      ).toEqual([{ text: 'run the step' }]);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // S5 (#18149 Stage 4): a two-call native batch on an extension's
  // config-scoped Hook owner. PreToolUse rewrites the first call's input, and
  // PermissionRequest allows the second with a rewrite of its own, so only the
  // first asks. Returns each Hook execution and the Session definition.
  async function mockHooksNativeTurn(): Promise<{
    executions: Array<{ event: unknown; input: unknown; owner: string }>;
    handbacks: string[];
    definition: Record<string, unknown>;
  }> {
    const fixture = await mockCommandStepTurn(true);
    const executions: Array<{ event: unknown; input: unknown; owner: string }> =
      [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async function (this: HostedWorkspaceBroker, operation) {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...operation.pin,
              hooks: [
                HookEventName.PreToolUse,
                HookEventName.PermissionRequest,
                HookEventName.PostToolUse,
              ].map((eventName) => ({
                hookId: eventName,
                eventName,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command' as const },
              })),
            },
          };
        const settled = {
          operationId: operation.operationId,
          state: 'settled' as const,
          result: { success: true, outcome: 'success' as const, duration: 0 },
        };
        if (operation.kind !== 'hook-execute') return settled;
        const event = operation.input['hook_event_name'];
        const input = Reflect.get(operation.input, 'tool_input') as
          | Record<string, unknown>
          | undefined;
        executions.push({ event, input, owner: this.runtimeSessionId });
        const output =
          event === HookEventName.PreToolUse &&
          input?.['file_path'] === 'notes.txt'
            ? {
                hookSpecificOutput: {
                  hookEventName: HookEventName.PreToolUse,
                  updatedInput: { file_path: 'notes.txt', content: 'hooked' },
                },
              }
            : event === HookEventName.PermissionRequest &&
                input?.['file_path'] === 'other.txt'
              ? {
                  hookSpecificOutput: {
                    hookEventName: HookEventName.PermissionRequest,
                    decision: {
                      behavior: 'allow',
                      updatedInput: {
                        file_path: 'other.txt',
                        content: 'permitted',
                      },
                    },
                  },
                }
              : undefined;
        if (!output) return settled;
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { ...settled.result, output },
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'hook-owner-claim',
    );
    const handbacks: string[] = [];
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockImplementation(async function (this: HostedWorkspaceBroker) {
      handbacks.push(this.runtimeSessionId);
    });
    // As the model driver does, a resumed round first completes the batch's
    // tool Hooks.
    state.model.mockImplementation(
      async ({ toolTurn, resumeFromToolResults, signal }) => {
        if (resumeFromToolResults) {
          await toolTurn!.resumeHookResults(
            resumeFromToolResults as Part[],
            'test-model',
            signal,
          );
          return { text: 'resumed', model: 'test-model' };
        }
        const calls = ['notes.txt', 'other.txt'].map((file) => ({
          name: 'write_file',
          callId: `call-${file}`,
          args: { file_path: file, content: 'hello' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        }));
        await toolTurn!.execute(
          calls,
          calls.map((call) => ({
            functionCall: { id: call.callId, name: call.name, args: call.args },
          })),
          'test-model',
          signal,
        );
        throw new Error('The waiting Turn unexpectedly continued.');
      },
    );
    return {
      executions,
      handbacks,
      definition: {
        managedSessionStore: store(),
        // Extensions run only on the Shell and MCP profiles, and a Shell
        // profile's native batch never captures (S8a).
        toolProfile: 'hosted-workspace-mcp/1',
        // The active extension set replaces these with its own, none here.
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        initialSelection: fixture.selection,
      },
    };
  }

  async function createHooksNativeSession(
    server: Server,
    definition: Record<string, unknown>,
  ): Promise<string> {
    const created = await headers(supertest(server).post('/session'))
      .send({
        ...definition,
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'write both' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    return clientId;
  }

  const readJournal = () =>
    LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });

  async function allowHooksNativeWait(
    server: Server,
    clientId: string,
  ): Promise<void> {
    const requestId = (await readJournal()).events.findLast(
      (event) =>
        event.kind === 'action.changed' &&
        event.payload['state'] === 'requested',
    )!.payload['requestId'] as string;
    await headers(
      supertest(server).post(
        `/session/${SESSION_ID}/actions/${requestId}/resolve`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        optionId: 'allow',
        inputRevision: 1,
        policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      })
      .expect(200);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      },
      { timeout: 5000 },
    );
  }

  // The resumed batch reads every PreToolUse and PermissionRequest decision
  // back, runs each call once with the input its Hooks left, and fires each
  // call's PostToolUse once on the same owner.
  function expectHooksNativeResumed(
    executions: Array<{ event: unknown; input: unknown; owner: string }>,
  ): void {
    const owner = executions[0]?.owner;
    expect(isHostedConfigScopedOwner(owner)).toBe(true);
    const notes = { file_path: 'notes.txt', content: 'hello' };
    const hooked = { file_path: 'notes.txt', content: 'hooked' };
    const other = { file_path: 'other.txt', content: 'hello' };
    const permitted = { file_path: 'other.txt', content: 'permitted' };
    expect(executions).toEqual([
      { event: HookEventName.PreToolUse, input: notes, owner },
      { event: HookEventName.PreToolUse, input: other, owner },
      { event: HookEventName.PermissionRequest, input: hooked, owner },
      { event: HookEventName.PermissionRequest, input: other, owner },
      { event: HookEventName.PostToolUse, input: hooked, owner },
      { event: HookEventName.PostToolUse, input: permitted, owner },
    ]);
    expect(
      vi
        .mocked(HostedWorkspaceBroker.prototype.execute)
        .mock.calls.map(
          ([, payloadJson]) =>
            (JSON.parse(payloadJson) as { input: unknown }).input,
        ),
    ).toEqual([hooked, permitted]);
  }

  it('parks a Hooks native approval on a config-scoped owner and resumes it without rerunning its Hooks', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const fixture = await mockHooksNativeTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await createHooksNativeSession(
        server,
        fixture.definition,
      );
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      expect(statsOf(server).parkRefusals).toEqual({});
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      const owner = fixture.executions[0]?.owner;
      expect(fixture.executions).toHaveLength(4);
      expect(fixture.handbacks).toEqual([owner]);
      expect(
        vi
          .mocked(HostedWorkspaceBroker.prototype.release)
          .mock.contexts.map(
            (context) => (context as HostedWorkspaceBroker).runtimeSessionId,
          ),
      ).not.toContain(owner);
      // A bare load must not answer the parked batch, which would destroy its
      // continuation (R9-1).
      const parked = await readJournal();
      const bare = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send(fixture.definition)
        .expect(409);
      expect(bare.body).toMatchObject({
        code: 'hosted_turn_recovery_required',
        reason: 'turn_unsettled',
      });
      expect(
        (await readJournal()).events
          .slice(parked.events.length)
          .filter((event) =>
            ['message.committed', 'action.changed', 'turn.settled'].includes(
              event.kind,
            ),
          ),
      ).toEqual([]);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ ...fixture.definition, passiveManagedRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      await allowHooksNativeWait(server, resumedClient);
      expectHooksNativeResumed(fixture.executions);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // A park is a crash at the wait point to the journal, so the same wait must
  // also survive its Harness dying in it.
  it('takes a Hooks native approval over after its Harness dies in the wait', async () => {
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const fixture = await mockHooksNativeTurn();
    const wait = vi
      .spyOn(HostedApprovalWaiters.prototype, 'wait')
      .mockRejectedValueOnce(
        new HostedToolRecoveryRequiredError('approval writer interrupted'),
      );
    try {
      const original = await app(true);
      const clientId = await createHooksNativeSession(
        original,
        fixture.definition,
      );
      await vi.waitFor(
        async () => {
          expect((await statusOf(original, clientId)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 5000 },
      );
      await (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed.close();
      wait.mockRestore();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ ...fixture.definition, driveRuntimeRecovery: true })
        .expect(200);
      await allowHooksNativeWait(replacement, loaded.body.clientId as string);
      expectHooksNativeResumed(fixture.executions);
    } finally {
      wait.mockRestore();
      state.approvalSelections.clear();
    }
  });

  // Park teardown releases a Session-definition catalog's activation-scoped
  // owner, so its wait stays resident and is counted.
  it('counts a Session-definition Hook catalog as hooks_activation_owner and keeps the wait resident', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const fixture = await mockHooksNativeTurn();
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await createHooksNativeSession(server, {
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        hookCatalog: hookPin,
      });
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fixture.executions[0]?.owner).toMatch(/^hooks-activation-/);
      expect(state.wakeStamps).not.toContainEqual(
        expect.objectContaining({ parkedTurn: expect.anything() }),
      );
      expect(statsOf(server).parkRefusals).toEqual({
        hooks_activation_owner: 1,
      });
      await endResidentApproval(server, clientId);
    } finally {
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  const exerciseColdApprovalRecovery = async (confined: boolean) => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, {
      mode: 'default',
      revision: 0,
    });
    const park = vi.spyOn(HostedApprovalWaiters.prototype, 'park');
    mockApprovalTurn(PROMPT_ID, confined);
    try {
      const lifecycle = [
        'hosted-workspace-shell/1',
        'hosted-workspace-confined-shell/1',
      ];
      const createHarness = () =>
        app(
          true,
          undefined,
          true,
          { idleSuspendMs: 150 },
          undefined,
          lifecycle,
        );
      const server = await createHarness();
      // The Turn deadline lands before the 60s approval expiry.
      const clientId = await promptApproval(
        server,
        undefined,
        30_000,
        confined ? 'hosted-workspace-confined-shell/1' : undefined,
      );
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      expect(state.model).toHaveBeenCalled();
      expect(park).toHaveBeenCalledOnce();
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );

      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const deadline = journal.events.find(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['turnId'] === PROMPT_ID,
      )!.payload['deadline'];
      expect(deadline).toEqual(expect.any(Number));
      expect(state.wakeStamps[0]).toEqual({
        pending: false,
        dueAt: 0,
        parkedTurn: {
          promptId: PROMPT_ID,
          wakeAt: deadline,
          ...(confined ? {} : { approvalRevision: 0 }),
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const recovered = confined ? await createHarness() : server;
      const loaded = await headers(
        supertest(recovered).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await headers(
        supertest(recovered).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(recovered, loaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      const after = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requested = after.events.filter(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].payload['requestId']).toBe(requestId);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      // The reloaded resident suspends on its own; let it go before the next
      // test reads the shared wake stamps.
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(recovered, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  };

  it.each([false, true])(
    'parks a recoverable approval and resumes it through cold recovery (confined: %s)',
    exerciseColdApprovalRecovery,
  );

  async function allowParkedApproval(
    server: Server,
    clientId: string,
    loadFlags: Record<string, unknown>,
  ): Promise<void> {
    await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
      timeout: 5000,
    });
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const requestId = journal.events.findLast(
      (event) =>
        event.kind === 'action.changed' &&
        event.payload['state'] === 'requested',
    )!.payload['requestId'] as string;
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), ...loadFlags })
      .expect(200);
    const resumedClient = loaded.body.clientId as string;
    await headers(
      supertest(server).post(
        `/session/${SESSION_ID}/actions/${requestId}/resolve`,
      ),
    )
      .set('X-Qwen-Client-Id', resumedClient)
      .send({
        optionId: 'allow',
        inputRevision: 1,
        policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      })
      .expect(200);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, resumedClient)).body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      },
      { timeout: 5000 },
    );
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, resumedClient)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  }

  // Stage 1 pre-check (#18149): image-only Prompts may park only if a
  // cold-recovered Turn still hands the model its original image.
  it('resumes a parked approval with the original image still in its history', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    const live = state.model.getMockImplementation()!;
    const resumedHistories: Array<readonly ChatRecord[]> = [];
    state.model.mockImplementation(async (input) => {
      if (input.resumeFromToolResults)
        resumedHistories.push(
          (input as { history?: readonly ChatRecord[] }).history ?? [],
        );
      return live(input);
    });
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
      'base64',
    );
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, [
        { type: 'text', text: 'write notes' },
        { type: 'image', mimeType: 'image/png', data: image },
      ]);
      await allowParkedApproval(server, clientId, {
        driveRuntimeRecovery: true,
      });
      expect(resumedHistories).toHaveLength(1);
      const user = resumedHistories[0].find(
        (record) =>
          record.type === 'user' && record.daemonPromptId === PROMPT_ID,
      );
      expect(user?.message?.parts).toEqual([
        { text: 'write notes' },
        { inlineData: { data: image, mimeType: 'image/png' } },
      ]);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // Stage 1 pre-check (#18149): decision delivery cold-loads a Workspace
  // Session with only the passive recovery flag, and that load must take the
  // parked Turn over.
  it('resumes a parked approval through the passive load decision delivery sends', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server);
      await allowParkedApproval(server, clientId, {
        passiveManagedRuntimeRecovery: true,
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      expect(state.model).toHaveBeenLastCalledWith(
        expect.objectContaining({ resumeFromToolResults: expect.any(Array) }),
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('denies a parked approval after cold recovery without executing the sealed call', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, undefined, 30_000);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          optionId: 'deny',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      // Deny executes the sealed call zero times.
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      const after = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requested = after.events.filter(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].payload['requestId']).toBe(requestId);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
      // No later stamp carries a parkedTurn for the denied prompt.
      expect(
        state.wakeStamps.filter(
          (stamp) =>
            (stamp as { parkedTurn?: { promptId: string } }).parkedTurn
              ?.promptId === PROMPT_ID,
        ),
      ).toHaveLength(1);
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('resumes a parked approval through a mode change that allows on behalf', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, undefined, 30_000);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      // The mode change unparks at the control plane; the recovered driver
      // must re-read the new selection and allow on the user's behalf.
      state.approvalSelections.set(SESSION_ID, {
        mode: 'auto-edit',
        revision: 1,
      });
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      // No manual resolve: the live poll allowed on behalf under the new mode.
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('ends a parked approval expired once the wake time passes', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const prompt = [{ type: 'text', text: 'write notes' }];
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          approvalMode: 'default',
          approvalTimeoutMs: 1_500,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          deadlineMs: 30_000,
        })
        .expect(202);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      // Outlive the approval expiry: the sweep dispatches as usual once
      // retry_after passes, and the resumed driver ends the Action expired.
      await sleep(2_000);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'expired',
        ),
      ).toBe(true);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('parks a cold-recovered approval wait again on the next idle', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const park = vi.spyOn(HostedApprovalWaiters.prototype, 'park');
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, undefined, 30_000);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      expect(park).toHaveBeenCalledOnce();
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );

      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;

      // Cold-load without resolving: the rebuilt wait keeps the original
      // registration, so the next idle parks it a second time.
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(2), {
        timeout: 5000,
      });
      expect(park).toHaveBeenCalledTimes(2);
      expect(state.wakeStamps[1]).toEqual(state.wakeStamps[0]);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
      expect(statsOf(server).cleanSuspensions).toBe(2);

      // One Allow after the second park still executes the tool exactly once.
      const reloaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', reloaded.body.clientId as string)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, reloaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      const after = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requested = after.events.filter(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].payload['requestId']).toBe(requestId);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, reloaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      park.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('parks with the approval expiry when it precedes the Turn deadline', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      // The deadline lies past the 60s approval expiry: the clamp must wake
      // at the expiry, not at the deadline.
      const clientId = await promptApproval(server, undefined, 120_000);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      const wakeAt = (state.wakeStamps[0] as { parkedTurn: { wakeAt: number } })
        .parkedTurn.wakeAt;
      expect(wakeAt).toBeGreaterThan(Date.now() + 55_000);
      expect(wakeAt).toBeLessThanOrEqual(Date.now() + 60_000);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('parks an approval while an event stream reader is attached', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    const server = await app(true, undefined, true, { idleSuspendMs: 500 });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const stream = new AbortController();
    try {
      const clientId = await promptApproval(server, undefined, 30_000);
      const opened = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: stream.signal,
        },
      );
      expect(opened.status).toBe(200);
      let ended = false;
      void (async () => {
        const reader = opened.body!.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
        }
      })();
      // The park exemption ends the attached stream in teardown instead of
      // refusing the park across every idle period.
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 5000 });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      expect(statsOf(server).cleanSuspensions).toBe(1);
    } finally {
      stream.abort();
      server.closeAllConnections();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('clears the Turn deadline timer at the park so no late abort settles the sealed Turn', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, undefined, 1_500);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      // Outlive the original deadline: the cleared timer must not fire a
      // terminal settlement from the dropped resident.
      await sleep(2_000);
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.filter((event) => event.kind === 'turn.settled'),
      ).toHaveLength(0);
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('parks while retaining the runtime lease the resumed Turn executes against', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, undefined, 30_000);
      // The lease shape a workspace-profile park holds in production.
      (
        wakeDeps.last as {
          session: {
            runtimeLeaseHeld?: { promptId: string; runtimeSessionId: string };
          };
        }
      ).session.runtimeLeaseHeld = {
        promptId: PROMPT_ID,
        runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
      };
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      // The retain clause skips the handback for the parked prompt.
      expect(release).not.toHaveBeenCalled();

      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      const after = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requested = after.events.filter(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].payload['requestId']).toBe(requestId);
      // The resumed Turn still executes against the retained runtime.
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(server, loaded.body.clientId as string)).status,
          ).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      release.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('keeps an approval resident when Action parking is not advertised', async () => {
    // Wake dispatch stays on so only the Action parking grant gates the park.
    state.wakeDispatch = true;
    state.actionParking = false;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 1 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptAndIdleInApproval(server);
      expect(state.wakeStamps).toEqual([]);
      expect(statsOf(server).cleanSuspensions).toBe(0);
      expect(
        statsOf(server).parkRefusals.capability_not_advertised,
      ).toBeGreaterThan(0);
      await endResidentApproval(server, clientId);
    } finally {
      state.wakeDispatch = false;
      state.approvalSelections.clear();
    }
  });

  // S2 (#18149): a certified background hold seals beside the park
  // certificate only when the control plane advertises the pair.
  it.each([true, false])(
    'parks an approval beside a certified background hold only when the pair is advertised (%s)',
    async (advertised) => {
      state.wakeDispatch = true;
      state.actionParking = true;
      state.runtimeObservation = true;
      state.backgroundActionParking = advertised;
      state.wakeStamps.length = 0;
      state.approvalSelections.set(SESSION_ID, {
        mode: 'default',
        revision: 0,
      });
      const cleanup = await import('./hosted-turn-cleanup.js');
      const certificate = vi
        .spyOn(cleanup, 'backgroundSuspensionCertificate')
        .mockResolvedValue(true);
      mockApprovalTurn();
      try {
        const server = await app(true, undefined, true, {
          idleSuspendMs: 150,
        });
        if (!advertised) {
          const clientId = await promptAndIdleInApproval(server);
          expect(certificate).toHaveBeenCalled();
          expect(state.wakeStamps).toEqual([]);
          expect(statsOf(server).cleanSuspensions).toBe(0);
          expect(statsOf(server).eligibilityFailures).toBeGreaterThan(0);
          await endResidentApproval(server, clientId);
          return;
        }
        const clientId = await promptApproval(server);
        await allowParkedApproval(server, clientId, {
          driveRuntimeRecovery: true,
        });
        expect(state.wakeStamps[0]).toEqual({
          pending: false,
          dueAt: 0,
          backgroundHeld: true,
          parkedTurn: expect.objectContaining({ promptId: PROMPT_ID }),
        });
        expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(
          1,
        );
      } finally {
        certificate.mockRestore();
        state.wakeDispatch = false;
        state.actionParking = false;
        state.runtimeObservation = false;
        state.backgroundActionParking = false;
        state.approvalSelections.clear();
      }
    },
  );

  // P0 (#18149): decision delivery sends a Session with no Workspace a plain
  // load, which refuses an unsettled Turn. Such a Session never parks because
  // it has no approval policy: its tool calls never ask, so no Action waits.
  it('opens no Action on a Session with no Workspace, even for a memory write', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    state.memory.mockImplementation(async (query: { operation: string }) =>
      query.operation === 'binding'
        ? { enabled: true, memoryStoreId: 'memstore_personal' }
        : { status: 'stored', memoryId: 'entry' },
    );
    state.model.mockImplementation(async (input) => {
      await input.toolTurn!.declarations(input.signal);
      const call = {
        name: 'context_remember',
        callId: 'call-remember',
        args: { content: 'remember this' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        input.signal,
      );
      return { text: 'remembered', model: 'test-model' };
    });
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          memoryStoreId: 'memstore_personal',
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const prompt = [{ type: 'text', text: 'remember my preference' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(1), {
        timeout: 5000,
      });
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.find((event) => event.kind === 'turn.settled')?.payload[
          'outcome'
        ],
      ).toBe('completed');
      expect(
        journal.events.filter((event) => event.kind === 'action.changed'),
      ).toEqual([]);
      expect(waiting).not.toHaveBeenCalled();
      expect(state.wakeStamps).not.toContainEqual(
        expect.objectContaining({ parkedTurn: expect.anything() }),
      );
    } finally {
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  it('counts why a Shell-profile approval cannot park', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptAndIdleInApproval(
        server,
        undefined,
        'hosted-workspace-shell/1',
      );
      expect(state.wakeStamps).toEqual([]);
      const stats = statsOf(server);
      expect(stats.cleanSuspensions).toBe(0);
      // The wait idled through several suspension attempts but counts once.
      expect(stats.parkRefusals).toEqual({ shell_profile: 1 });
      await endResidentApproval(server, clientId);
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // Decision 8 (#18149): public-children Shell waits already park, so their
  // continuation is pinned for every outcome, both after a park and after the
  // Harness dies in the wait.
  const publicShellSession = {
    toolProfile: 'hosted-workspace-shell/1',
    captureBytes: 1024 * 1024,
    publicChildAgentsVersion: 1,
  };
  // Without tool publication the definition pins no captureBytes, so the
  // Session runs the older Shell lane: a deferred prepare, and output admitted
  // through the Session's own publisher.
  const publicShellLaneSession = {
    toolProfile: 'hosted-workspace-shell/1',
    publicChildAgentsVersion: 1,
  };

  async function mockPublicShellApproval(
    background = false,
    shellLane = false,
  ) {
    mockApprovalTurn();
    const prepareV3 = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'prepareV3')
      .mockResolvedValue({
        executionCallId: 'shell-execution',
        runtimeBindingId: 'binding',
        bindingGeneration: '1',
      });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const manifest = await resources.publish(
      'managed-tool-result-manifest',
      Buffer.from(
        JSON.stringify({
          toolResult: 'managed-tool-result/1',
          type: 'manifest',
          tenantId: 'tenant',
          sessionId: SESSION_ID,
          turnId: PROMPT_ID,
          executionCallId: 'shell-execution',
          callId: 'park-shell-call',
          invocationDigest: 'digest',
          bindingGeneration: '1',
          captureId: randomUUID(),
          revision: 1,
          executionStatus: 'success',
          exitCode: 0,
          signal: null,
          captureScope: 'process_pipes',
          capturePolicy: 'complete_required',
          captureStatus: 'complete',
          captureReason: null,
          upstreamTruncated: false,
          contents: ['stdout', 'stderr'].map((streamId) => ({
            streamId,
            role: streamId,
            mimeType: 'application/octet-stream',
            state: 'sealed',
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
      responseParts: [{ text: 'touched' }],
      capture: background
        ? {
            manifest: null,
            captureStatus: 'detached' as const,
            captureReason: null,
            previewTruncated: false,
            deliveryStatus: 'pending' as const,
          }
        : {
            manifest,
            captureStatus: 'complete' as const,
            captureReason: null,
            previewTruncated: false,
            deliveryStatus: 'pending' as const,
          },
    };
    const executeV3 = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'executeV3')
      .mockResolvedValue(envelope);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    const prepare = vi.mocked(HostedWorkspaceBroker.prototype.prepare);
    const execute = vi.mocked(HostedWorkspaceBroker.prototype.execute);
    if (shellLane) {
      prepare.mockResolvedValue('shell-execution');
      execute.mockResolvedValue(envelope as never);
      const outcomeRef = await resources.publish(
        'managed-tool-outcome',
        Buffer.from('{}'),
      );
      vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue({
        executionCallId: 'shell-execution',
        manifest,
        deliveryStatus: 'committed',
        historyRevision: 1,
        outcomeRef,
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledge',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
    }
    state.publicationRequest.mockImplementation(
      async (
        resourceStore: LocalManagedSessionResourceStore,
        route: string,
        body: unknown,
      ) => {
        if (route === '/grants') return { state: 'OPEN' };
        if (route.endsWith('/finished')) return { result: envelope };
        if (route.endsWith('/admissions/prepare'))
          return resourceStore.publish(
            'managed-tool-outcome',
            Buffer.from(JSON.stringify(body)),
          );
        throw new Error('Unexpected publication route ' + route);
      },
    );
    state.model.mockImplementation(
      async ({ toolTurn, resumeFromToolResults, signal }) => {
        if (resumeFromToolResults)
          return { text: 'resumed', model: 'test-model' };
        const call = {
          name: 'run_shell_command',
          callId: 'park-shell-call',
          args: background
            ? { command: 'npm run dev', is_background: true }
            : { command: 'touch notes.txt' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        // The production model pins this route before every public-children
        // request; the saved plan is readable as public Shell only with it.
        toolTurn!.setChildModelRoute!('test-model', {
          authType: 'openai',
          endpointDigest: 'a'.repeat(64),
          providerPin: 'b'.repeat(64),
        });
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
        throw new Error('The waiting Turn unexpectedly continued.');
      },
    );
    // A background Shell registers its output publisher before it asks.
    if (background)
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
    const saved = vi.spyOn(
      approvalContinuation,
      'findHostedApprovalContinuation',
    );
    return { prepareV3, executeV3, prepare, execute, saved };
  }

  async function promptPublicShellApproval(
    server: Server,
    approvalTimeoutMs = 60_000,
    definition: Record<string, unknown> = {},
    session: Record<string, unknown> = publicShellSession,
  ): Promise<string> {
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...session,
        ...definition,
        approvalMode: 'default',
        approvalTimeoutMs,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run the Shell' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    return clientId;
  }

  async function savedShellCall(
    saved: Awaited<ReturnType<typeof mockPublicShellApproval>>['saved'],
    shellLane = false,
  ) {
    const continuation = (await saved.mock.results[0]!.value) as Awaited<
      ReturnType<typeof approvalContinuation.findHostedApprovalContinuation>
    >;
    const call = continuation!.plan.calls[0]!;
    expect(call.call.name).toBe('run_shell_command');
    // The Shell lane has no publication, and its plan says so explicitly.
    expect(call.publicationId).toEqual(shellLane ? null : expect.any(String));
    return { call, input: continuation!.inputs[0]!.input };
  }

  const readSessionJournal = () =>
    LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });

  it.each(
    (['publication', 'Shell'] as const).flatMap((lane) =>
      (['park', 'Harness death'] as const).flatMap((interruption) =>
        (['allow', 'deny', 'expiry', 'mode change'] as const).map(
          (outcome) => [outcome, interruption, lane] as const,
        ),
      ),
    ),
  )(
    'settles a public-children Shell approval through %s after a %s on the %s lane',
    async (outcome, interruption, lane) => {
      const parks = interruption === 'park';
      const shellLane = lane === 'Shell';
      const session = shellLane ? publicShellLaneSession : publicShellSession;
      state.wakeDispatch = parks;
      state.actionParking = parks;
      state.wakeStamps.length = 0;
      state.approvalSelections.set(SESSION_ID, {
        mode: 'default',
        revision: 0,
      });
      const { prepareV3, executeV3, prepare, execute, saved } =
        await mockPublicShellApproval(false, shellLane);
      const wait = parks
        ? undefined
        : vi
            .spyOn(HostedApprovalWaiters.prototype, 'wait')
            .mockRejectedValueOnce(
              new HostedToolRecoveryRequiredError(
                'approval writer interrupted',
              ),
            );
      try {
        const original = await app(
          true,
          undefined,
          true,
          parks ? { idleSuspendMs: 150 } : undefined,
        );
        const clientId = await promptPublicShellApproval(
          original,
          outcome === 'expiry' ? 1_500 : 60_000,
          {},
          session,
        );
        let server = original;
        if (parks) {
          await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
            timeout: 5000,
          });
          await vi.waitFor(
            async () => {
              expect((await statusOf(original, clientId)).status).toBe(404);
            },
            { timeout: 5000 },
          );
          expect(state.wakeStamps[0]).toMatchObject({
            parkedTurn: { promptId: PROMPT_ID },
          });
          expect(statsOf(original).parkRefusals).toEqual({});
        } else {
          await vi.waitFor(
            async () => {
              expect((await statusOf(original, clientId)).body).toMatchObject({
                hasActivePrompt: false,
                recoveryBlocked: true,
              });
            },
            { timeout: 5000 },
          );
          await (
            wakeDeps.last as { session: { managed: ManagedSession } }
          ).session.managed.close();
          wait!.mockRestore();
          server = await app(true);
        }
        if (outcome === 'expiry') await sleep(2_000);
        if (outcome === 'mode change')
          state.approvalSelections.set(SESSION_ID, {
            mode: 'yolo',
            revision: 1,
          });
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            managedSessionStore: store(),
            ...session,
            driveRuntimeRecovery: true,
          })
          .expect(200);
        const resumedClient = loaded.body.clientId as string;
        const requestId = (await readSessionJournal()).events.findLast(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'requested',
        )!.payload['requestId'] as string;
        if (outcome === 'allow' || outcome === 'deny')
          await headers(
            supertest(server).post(
              `/session/${SESSION_ID}/actions/${requestId}/resolve`,
            ),
          )
            .set('X-Qwen-Client-Id', resumedClient)
            .send({
              optionId: outcome,
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            })
            .expect(200);
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, resumedClient)).body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: false,
            });
          },
          { timeout: 5000 },
        );

        if (!parks) expect(state.wakeStamps).toEqual([]);
        const executes = outcome === 'allow' || outcome === 'mode change';
        if (executes && shellLane) {
          const { call, input } = await savedShellCall(saved, true);
          expect(prepareV3).not.toHaveBeenCalled();
          expect(prepare).toHaveBeenCalledOnce();
          expect(prepare).toHaveBeenCalledWith(
            call.runtimeCallId,
            call.requestDigest,
            managedToolDigest(input),
            PROMPT_ID,
          );
          expect(execute).toHaveBeenCalledOnce();
        } else if (executes) {
          const { call } = await savedShellCall(saved);
          expect(prepareV3).toHaveBeenCalledOnce();
          expect(prepareV3).toHaveBeenCalledWith(
            call.runtimeCallId,
            call.argsDigest,
            call.requestDigest,
            call.publicationId,
            PROMPT_ID,
          );
          expect(executeV3).toHaveBeenCalledOnce();
        } else {
          expect(prepareV3).not.toHaveBeenCalled();
          expect(executeV3).not.toHaveBeenCalled();
          expect(prepare).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        }
        const journal = await readSessionJournal();
        const requested = journal.events.filter(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'requested',
        );
        expect(requested).toHaveLength(1);
        expect(requested[0].payload['requestId']).toBe(requestId);
        if (outcome === 'expiry')
          expect(
            journal.events.some(
              (event) =>
                event.kind === 'action.changed' &&
                event.payload['requestId'] === requestId &&
                event.payload['state'] === 'expired',
            ),
          ).toBe(true);
        // G3 §4.2: a decision continues the saved batch; expiry ends the
        // Turn cancelled without another model request.
        const settled = journal.events.filter(
          (event) => event.kind === 'turn.settled',
        );
        expect(settled).toHaveLength(1);
        expect(settled[0].payload['outcome']).toBe(
          outcome === 'expiry' ? 'cancelled' : 'completed',
        );
        // The reloaded resident suspends on its own; let it go before the
        // next test reads the shared wake stamps.
        if (parks)
          await vi.waitFor(
            async () => {
              expect((await statusOf(server, resumedClient)).status).toBe(404);
            },
            { timeout: 5000 },
          );
      } finally {
        wait?.mockRestore();
        saved.mockRestore();
        state.wakeDispatch = false;
        state.actionParking = false;
        state.approvalSelections.clear();
      }
    },
  );

  it('parks a public-children background Shell approval and starts its one process after the Allow', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const { prepareV3, executeV3, saved } = await mockPublicShellApproval(true);
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptPublicShellApproval(server);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      expect(state.wakeStamps[0]).toMatchObject({
        parkedTurn: { promptId: PROMPT_ID },
      });
      expect(statsOf(server).parkRefusals).toEqual({});
      const { call, input } = await savedShellCall(saved);
      expect(input['is_background']).toBe(true);
      expect(prepareV3).not.toHaveBeenCalled();

      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          ...publicShellSession,
          driveRuntimeRecovery: true,
        })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      const requestId = (await readSessionJournal()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 5000 },
      );
      expect(prepareV3).toHaveBeenCalledOnce();
      expect(prepareV3).toHaveBeenCalledWith(
        call.runtimeCallId,
        call.argsDigest,
        call.requestDigest,
        call.publicationId,
        PROMPT_ID,
      );
      expect(executeV3).toHaveBeenCalledOnce();
      const journal = await readSessionJournal();
      // Every child_run record belongs to the one reserved execution: the
      // resume admitted no second process.
      const childRunOperations = journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'child_run',
        )
        .map((event) => event.payload['operationId'] as string);
      expect(childRunOperations).toContain('shell-execution');
      expect(new Set(childRunOperations.map((id) => id.split(':')[0]))).toEqual(
        new Set(['shell-execution']),
      );
      const settled = journal.events.filter(
        (event) => event.kind === 'turn.settled',
      );
      expect(settled).toHaveLength(1);
      expect(settled[0].payload['outcome']).toBe('completed');
      // The started background Shell keeps the Session resident, so close it
      // before the next test reads the shared wake stamps.
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    } finally {
      saved.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // S5 widens decision 8: a public-children Shell Session whose extensions
  // bring Hooks parks its Shell approval on the config-scoped Hook owner.
  it.each(['park', 'Harness death'] as const)(
    'resumes a public-children Shell approval with extension Hooks after a %s',
    async (interruption) => {
      const parks = interruption === 'park';
      state.wakeDispatch = parks;
      state.actionParking = parks;
      state.wakeStamps.length = 0;
      state.approvalSelections.set(SESSION_ID, {
        mode: 'default',
        revision: 0,
      });
      const extensions = await mockCommandStepTurn(true);
      const { prepareV3, executeV3, saved } = await mockPublicShellApproval();
      const executions: Array<{
        event: unknown;
        command: unknown;
        owner: string;
      }> = [];
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'hookControl',
      ).mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...operation.pin,
              hooks: [
                HookEventName.PreToolUse,
                HookEventName.PermissionRequest,
                HookEventName.PostToolUse,
              ].map((eventName) => ({
                hookId: eventName,
                eventName,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command' as const },
              })),
            },
          };
        const settled = {
          operationId: operation.operationId,
          state: 'settled' as const,
          result: { success: true, outcome: 'success' as const, duration: 0 },
        };
        if (operation.kind !== 'hook-execute') return settled;
        const event = operation.input['hook_event_name'];
        const input = Reflect.get(operation.input, 'tool_input') as
          | Record<string, unknown>
          | undefined;
        executions.push({
          event,
          command: input?.['command'],
          owner: this.runtimeSessionId,
        });
        // PreToolUse rewrites the command, so the resume must run the saved
        // effective input rather than decide the Hooks again.
        if (event !== HookEventName.PreToolUse) return settled;
        return {
          ...settled,
          result: {
            ...settled.result,
            output: {
              hookSpecificOutput: {
                hookEventName: HookEventName.PreToolUse,
                updatedInput: { command: 'touch hooked.txt' },
              },
            },
          },
        };
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
        'hook-owner-claim',
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'releaseMount',
      ).mockResolvedValue();
      state.model.mockImplementation(
        async ({ toolTurn, resumeFromToolResults, signal }) => {
          // As the model driver does, a resumed round first completes the
          // batch's tool Hooks.
          if (resumeFromToolResults) {
            await toolTurn!.resumeHookResults(
              resumeFromToolResults as Part[],
              'test-model',
              signal,
            );
            return { text: 'resumed', model: 'test-model' };
          }
          const call = {
            name: 'run_shell_command',
            callId: 'park-shell-call',
            args: { command: 'touch notes.txt' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          };
          toolTurn!.setChildModelRoute!('test-model', {
            authType: 'openai',
            endpointDigest: 'a'.repeat(64),
            providerPin: 'b'.repeat(64),
          });
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
          throw new Error('The waiting Turn unexpectedly continued.');
        },
      );
      const definition = { initialSelection: extensions.selection };
      const wait = parks
        ? undefined
        : vi
            .spyOn(HostedApprovalWaiters.prototype, 'wait')
            .mockRejectedValueOnce(
              new HostedToolRecoveryRequiredError(
                'approval writer interrupted',
              ),
            );
      try {
        const original = await app(
          true,
          undefined,
          true,
          parks ? { idleSuspendMs: 150 } : undefined,
        );
        const clientId = await promptPublicShellApproval(
          original,
          60_000,
          definition,
        );
        let server = original;
        if (parks) {
          await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
            timeout: 5000,
          });
          await vi.waitFor(
            async () => {
              expect((await statusOf(original, clientId)).status).toBe(404);
            },
            { timeout: 5000 },
          );
          expect(state.wakeStamps[0]).toMatchObject({
            parkedTurn: { promptId: PROMPT_ID },
          });
          expect(statsOf(original).parkRefusals).toEqual({});
        } else {
          await vi.waitFor(
            async () => {
              expect((await statusOf(original, clientId)).body).toMatchObject({
                hasActivePrompt: false,
                recoveryBlocked: true,
              });
            },
            { timeout: 5000 },
          );
          await (
            wakeDeps.last as { session: { managed: ManagedSession } }
          ).session.managed.close();
          wait!.mockRestore();
          server = await app(true);
        }
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            managedSessionStore: store(),
            ...publicShellSession,
            ...definition,
            ...(parks
              ? { passiveManagedRuntimeRecovery: true }
              : { driveRuntimeRecovery: true }),
          })
          .expect(200);
        const resumedClient = loaded.body.clientId as string;
        const requestId = (await readSessionJournal()).events.findLast(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'requested',
        )!.payload['requestId'] as string;
        await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/actions/${requestId}/resolve`,
          ),
        )
          .set('X-Qwen-Client-Id', resumedClient)
          .send({
            optionId: 'allow',
            inputRevision: 1,
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
          })
          .expect(200);
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, resumedClient)).body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: false,
            });
          },
          { timeout: 5000 },
        );

        if (!parks) expect(state.wakeStamps).toEqual([]);
        // The Hooks that ran before the wait are read back, never rerun, and
        // the Allow fires one PostToolUse, all on the config-scoped owner.
        const owner = executions[0]?.owner;
        expect(isHostedConfigScopedOwner(owner)).toBe(true);
        expect(executions).toEqual([
          {
            event: HookEventName.PreToolUse,
            command: 'touch notes.txt',
            owner,
          },
          {
            event: HookEventName.PermissionRequest,
            command: 'touch hooked.txt',
            owner,
          },
          {
            event: HookEventName.PostToolUse,
            command: 'touch hooked.txt',
            owner,
          },
        ]);
        const { call, input } = await savedShellCall(saved);
        expect(input['command']).toBe('touch hooked.txt');
        expect(prepareV3).toHaveBeenCalledOnce();
        expect(prepareV3).toHaveBeenCalledWith(
          call.runtimeCallId,
          call.argsDigest,
          call.requestDigest,
          call.publicationId,
          PROMPT_ID,
        );
        expect(executeV3).toHaveBeenCalledOnce();
        expect(
          (
            JSON.parse(executeV3.mock.calls[0]![1]) as {
              input: Record<string, unknown>;
            }
          ).input['command'],
        ).toBe('touch hooked.txt');
        const journal = await readSessionJournal();
        expect(
          journal.events.filter(
            (event) =>
              event.kind === 'action.changed' &&
              event.payload['state'] === 'requested',
          ),
        ).toHaveLength(1);
        const settled = journal.events.filter(
          (event) => event.kind === 'turn.settled',
        );
        expect(settled).toHaveLength(1);
        expect(settled[0].payload['outcome']).toBe('completed');
        if (parks)
          await vi.waitFor(
            async () => {
              expect((await statusOf(server, resumedClient)).status).toBe(404);
            },
            { timeout: 5000 },
          );
      } finally {
        wait?.mockRestore();
        saved.mockRestore();
        state.wakeDispatch = false;
        state.actionParking = false;
        state.approvalSelections.clear();
      }
    },
  );

  // S6b pre-start check (#18149 Stage 4): a parked Turn's MCP tool
  // definitions must deep-equal the ones it saw before the park. An MCP
  // tool's model name digests its connection generation, so this holds only
  // if a cold load after a parked suspension keeps the same durable owner and
  // connection instead of configuring a new one.
  it('keeps the MCP owner and tool declarations across a parked suspension', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const { server, authorize, requests } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-mcp/1',
      {},
      { idleSuspendMs: 500 },
    );
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const acquired = acquire.getMockImplementation()!;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      await acquired.call(this);
      this.mcpParkable = true;
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const controlled = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      const reply = await controlled.call(this, operation);
      // The reply map keeps this object, so later discovers see the tool too.
      if (operation.kind === 'mcp-configure' && reply.catalog)
        Object.assign(reply.catalog, {
          tools: [
            {
              name: 'echo',
              description: 'Echo a message',
              inputSchema: { type: 'object' },
            },
          ],
        });
      return reply;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'idle-claim',
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockResolvedValue();
    const seen: Array<{ owner: string; tools: unknown[] }> = [];
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const tools = (await toolTurn!.declarations(signal)).filter((tool) =>
        tool.name?.startsWith('mcp_'),
      );
      const configure = control.mock.calls.findLastIndex(
        ([operation]) =>
          operation.kind === 'mcp-configure' ||
          operation.kind === 'mcp-discover',
      );
      seen.push({
        owner: (control.mock.contexts[configure] as HostedWorkspaceBroker)
          .runtimeSessionId,
        tools,
      });
      return { text: 'listed', model: 'test-model' };
    });
    const prompt = (request: supertest.Test, promptId: string) => {
      const parts = [{ type: 'text', text: 'list the tools' }];
      return request
        .send({
          prompt: parts,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`,
        })
        .expect(202);
    };
    await prompt(
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)),
      PROMPT_ID,
    );
    await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(1), {
      timeout: 10_000,
    });
    expect(requests.filter((r) => r.kind === 'mcp-release')).toEqual([]);

    requests.length = 0;
    const load = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
      })
      .expect(200);
    await prompt(
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`)).set(
        'X-Qwen-Client-Id',
        load.body.clientId as string,
      ),
      randomUUID(),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 10_000 });

    expect(seen[0]!.tools).toHaveLength(1);
    expect(isHostedDurableMcpOwner(seen[0]!.owner)).toBe(true);
    expect(seen[1]).toEqual(seen[0]);
    // The reload reused the parked connection: it revalidated discovery and
    // configured nothing new.
    expect(requests.some((r) => r.kind === 'mcp-configure')).toBe(false);
    expect(requests.find((r) => r.kind === 'mcp-discover')).toMatchObject({
      revalidate: true,
    });
    // Do not leak this second idle teardown into the next test's mock scope.
    await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(2), {
      timeout: 10_000,
    });
  });

  // S6b (#18149 Stage 4): an approval wait on an MCP Session parks when the
  // Broker parks MCP owners, and resumes on the same durable owner.
  async function mockMcpApprovalTurn(
    tool: 'write_file' | 'mcp',
    parkable = true,
    suspensionOptions: Parameters<typeof app>[3] = { idleSuspendMs: 150 },
    hooks = false,
  ) {
    mockApprovalTurn();
    // A Session-definition Hook catalog beside an MCP server borrows the MCP
    // broker, so its Hooks run on the durable MCP owner.
    const executions: Array<{ event: unknown; owner: string }> = [];
    if (hooks) {
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'authorizeLifecycle',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'hookControl',
      ).mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...operation.pin,
              hooks: [
                HookEventName.PreToolUse,
                HookEventName.PermissionRequest,
                HookEventName.PostToolUse,
              ].map((eventName) => ({
                hookId: eventName,
                eventName,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command' as const },
              })),
            },
          };
        if (operation.kind === 'hook-execute')
          executions.push({
            event: operation.input['hook_event_name'],
            owner: this.runtimeSessionId,
          });
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      });
    }
    const fixture = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-mcp/1',
      {
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
        ...(hooks ? { hookCatalog: hookPin } : {}),
      },
      suspensionOptions,
    );
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const acquired = acquire.getMockImplementation()!;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      await acquired.call(this);
      this.mcpParkable = parkable;
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const controlled = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      const reply = await controlled.call(this, operation);
      // The reply map keeps this object, so later discovers see the tool too.
      if (operation.kind === 'mcp-configure' && reply.catalog)
        Object.assign(reply.catalog, {
          tools: [
            {
              name: 'echo',
              description: 'Echo a message',
              inputSchema: { type: 'object' },
            },
          ],
        });
      return reply;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'mcp-claim',
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockResolvedValue();
    state.model.mockImplementation(
      async ({ toolTurn, resumeFromToolResults, signal }) => {
        // As the model driver does, a resumed round first completes the
        // batch's tool Hooks.
        if (resumeFromToolResults) {
          if (hooks)
            await toolTurn!.resumeHookResults(
              resumeFromToolResults as Part[],
              'test-model',
              signal,
            );
          return { text: 'resumed', model: 'test-model' };
        }
        const declarations = await toolTurn!.declarations(signal);
        const call =
          tool === 'mcp'
            ? {
                name: declarations.find((item) =>
                  item.name?.startsWith('mcp_'),
                )!.name!,
                callId: 'park-mcp-call',
                args: { message: 'hello' },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              }
            : {
                name: 'write_file',
                callId: 'park-mcp-call',
                args: { file_path: 'notes.txt', content: 'hello' },
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
        throw new Error('The waiting Turn unexpectedly continued.');
      },
    );
    return { ...fixture, executions };
  }

  const mcpDefinition = {
    managedSessionStore: store(),
    toolProfile: 'hosted-workspace-mcp/1',
    mcpServers: [
      { serverId: 'demo', serverRevision: 1, definitionDigest: 'a'.repeat(64) },
    ],
  };

  async function promptMcpApproval(
    authorize: (request: supertest.Test) => supertest.Test,
    server: Server,
  ): Promise<void> {
    const prompt = [{ type: 'text', text: 'use the tool' }];
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
  }

  it.each(
    (['write_file', 'mcp', 'mcp with Hooks'] as const).flatMap((tool) =>
      (['park', 'Harness death'] as const).map(
        (interruption) => [tool, interruption] as const,
      ),
    ),
  )(
    'resumes a %s approval on an MCP Session after a %s',
    async (variant, interruption) => {
      const hooks = variant === 'mcp with Hooks';
      const tool = hooks ? 'mcp' : variant;
      const parks = interruption === 'park';
      state.wakeDispatch = parks;
      state.actionParking = parks;
      state.wakeStamps.length = 0;
      state.approvalSelections.set(SESSION_ID, {
        mode: 'default',
        revision: 0,
      });
      const wait = parks
        ? undefined
        : vi
            .spyOn(HostedApprovalWaiters.prototype, 'wait')
            .mockRejectedValueOnce(
              new HostedToolRecoveryRequiredError(
                'approval writer interrupted',
              ),
            );
      const saved = vi.spyOn(
        approvalContinuation,
        'findHostedApprovalContinuation',
      );
      try {
        const {
          server: original,
          authorize,
          requests,
          executions,
        } = await mockMcpApprovalTurn(
          tool,
          true,
          parks ? { idleSuspendMs: 150 } : undefined,
          hooks,
        );
        await promptMcpApproval(authorize, original);
        let server = original;
        if (parks) {
          await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
            timeout: 5000,
          });
          await vi.waitFor(
            () => expect(statsOf(original).cleanSuspensions).toBe(1),
            { timeout: 5000 },
          );
          expect(state.wakeStamps[0]).toMatchObject({
            parkedTurn: { promptId: PROMPT_ID },
          });
          expect(statsOf(original).parkRefusals).toEqual({});
          expect(requests.filter((r) => r.kind === 'mcp-release')).toEqual([]);
          // A bare load must not answer the parked batch (R9-1).
          const parked = await readSessionJournal();
          await headers(supertest(original).post(`/session/${SESSION_ID}/load`))
            .send(mcpDefinition)
            .expect(409);
          expect(
            (await readSessionJournal()).events
              .slice(parked.events.length)
              .filter((event) =>
                [
                  'message.committed',
                  'action.changed',
                  'turn.settled',
                ].includes(event.kind),
              ),
          ).toEqual([]);
        } else {
          await vi.waitFor(
            async () => {
              expect(
                (
                  await authorize(
                    supertest(original).get(`/session/${SESSION_ID}/status`),
                  )
                ).body,
              ).toMatchObject({
                hasActivePrompt: false,
                recoveryBlocked: true,
              });
            },
            { timeout: 5000 },
          );
          await (
            wakeDeps.last as { session: { managed: ManagedSession } }
          ).session.managed.close();
          wait!.mockRestore();
          server = await app(true);
        }
        requests.length = 0;
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            ...mcpDefinition,
            ...(parks
              ? { passiveManagedRuntimeRecovery: true }
              : { driveRuntimeRecovery: true }),
          })
          .expect(200);
        const resumedClient = loaded.body.clientId as string;
        const requestId = (await readSessionJournal()).events.findLast(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['state'] === 'requested',
        )!.payload['requestId'] as string;
        await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/actions/${requestId}/resolve`,
          ),
        )
          .set('X-Qwen-Client-Id', resumedClient)
          .send({
            optionId: 'allow',
            inputRevision: 1,
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
          })
          .expect(200);
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, resumedClient)).body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: false,
            });
          },
          { timeout: 5000 },
        );
        const execute = vi.mocked(HostedWorkspaceBroker.prototype.execute);
        expect(execute).toHaveBeenCalledOnce();
        const payload = JSON.parse(execute.mock.calls[0]![1]) as {
          toolName: string;
          input: Record<string, unknown>;
        };
        if (tool === 'mcp') {
          // The saved call ran under its own runtime call ID, with a grant
          // issued after the resume.
          const prepared = vi.mocked(HostedWorkspaceBroker.prototype.prepare)
            .mock.calls[0]![0];
          expect(payload.toolName).toBe('managed_mcp_call');
          expect(payload.input['operationId']).toBe(prepared);
          expect(payload.input['request']).toEqual({
            kind: 'tool_call',
            name: 'echo',
            arguments: { message: 'hello' },
          });
          const continuation = (await saved.mock.results[0]!.value) as Awaited<
            ReturnType<
              typeof approvalContinuation.findHostedApprovalContinuation
            >
          >;
          const savedGrant = continuation!.inputs[0]!.input['grant'] as {
            expiresAt: number;
          };
          expect(
            (payload.input['grant'] as { expiresAt: number }).expiresAt,
          ).toBeGreaterThan(savedGrant.expiresAt);
        } else {
          expect(payload.input).toEqual({
            file_path: 'notes.txt',
            content: 'hello',
          });
        }
        if (parks)
          expect(requests.some((r) => r.kind === 'mcp-configure')).toBe(false);
        // The Hooks that ran before the wait are read back, never rerun, and
        // the Allow fires one PostToolUse, all on the durable MCP owner.
        if (hooks) {
          const owner = executions[0]?.owner;
          expect(isHostedDurableMcpOwner(owner ?? '')).toBe(true);
          expect(executions).toEqual([
            { event: HookEventName.PreToolUse, owner },
            { event: HookEventName.PermissionRequest, owner },
            { event: HookEventName.PostToolUse, owner },
          ]);
        } else expect(executions).toEqual([]);
        const journal = await readSessionJournal();
        expect(
          journal.events.filter(
            (event) =>
              event.kind === 'action.changed' &&
              event.payload['state'] === 'requested',
          ),
        ).toHaveLength(1);
        const settled = journal.events.filter(
          (event) => event.kind === 'turn.settled',
        );
        expect(settled).toHaveLength(1);
        expect(settled[0].payload['outcome']).toBe('completed');
        if (parks)
          await vi.waitFor(
            () => expect(statsOf(server).cleanSuspensions).toBe(2),
            { timeout: 5000 },
          );
      } finally {
        wait?.mockRestore();
        saved.mockRestore();
        state.wakeDispatch = false;
        state.actionParking = false;
        state.approvalSelections.clear();
      }
    },
  );

  it('keeps an MCP Session approval resident when the Broker would drain its owner', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    try {
      const { server, authorize } = await mockMcpApprovalTurn('mcp', false);
      await promptMcpApproval(authorize, server);
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(state.wakeStamps).toEqual([]);
      expect(statsOf(server).cleanSuspensions).toBe(0);
      expect(statsOf(server).parkRefusals).toEqual({ mcp_not_parkable: 1 });
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).expect(204);
    } finally {
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // The pin's limit (§4.6): a server that changed its tools during the park
  // comes back under a new catalog revision, so its model tool names differ
  // and recovery declines rather than run a call it can no longer prove.
  it('declines a parked MCP approval whose catalog changed during the park', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    try {
      const { server, authorize, replies } = await mockMcpApprovalTurn('mcp');
      await promptMcpApproval(authorize, server);
      await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(1), {
        timeout: 5000,
      });
      for (const reply of replies.values())
        if (reply.catalog)
          Object.assign(reply.catalog, {
            catalogRevision: reply.catalog.catalogRevision + 1,
          });
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ ...mcpDefinition, passiveManagedRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      const requestId = (await readSessionJournal()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`));
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  const pngImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
    'base64',
  );

  const imageOnlyPrompt = [
    { type: 'image', mimeType: 'image/png', data: pngImage },
  ];

  type ResumedModelInput = {
    prompt?: string;
    history?: readonly ChatRecord[];
  };

  function captureResumedModelInput(): ResumedModelInput[] {
    const live = state.model.getMockImplementation()!;
    const resumed: ResumedModelInput[] = [];
    state.model.mockImplementation(async (input) => {
      if (input.resumeFromToolResults) resumed.push(input as ResumedModelInput);
      return live(input);
    });
    return resumed;
  }

  function expectOriginalImageOnly(resumed: ResumedModelInput) {
    expect(
      resumed.history?.find(
        (record) =>
          record.type === 'user' && record.daemonPromptId === PROMPT_ID,
      )?.message?.parts,
    ).toEqual([{ inlineData: { data: pngImage, mimeType: 'image/png' } }]);
  }

  it('parks an image-only approval and resumes it with its image through cold recovery', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    const resumed = captureResumedModelInput();
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const clientId = await promptApproval(server, imageOnlyPrompt);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      expect(statsOf(server).parkRefusals).toEqual({});
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveLength(1);
      expect(resumed[0].prompt).toBe('');
      expectOriginalImageOnly(resumed[0]);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, resumedClient)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });

  // A park is a crash at the wait point to the journal, so the same image-only
  // wait must also survive its Harness dying in it.
  it('takes an image-only approval over after its Harness dies in the wait', async () => {
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    const resumed = captureResumedModelInput();
    const wait = vi
      .spyOn(HostedApprovalWaiters.prototype, 'wait')
      .mockRejectedValueOnce(
        new HostedToolRecoveryRequiredError('approval writer interrupted'),
      );
    try {
      const original = await app(true);
      const clientId = await promptApproval(original, imageOnlyPrompt);
      await vi.waitFor(
        async () => {
          expect((await statusOf(original, clientId)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 5000 },
      );
      await (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed.close();
      wait.mockRestore();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await headers(
        supertest(replacement).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(replacement, resumedClient)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveLength(1);
      expect(resumed[0].prompt).toBe('');
      expectOriginalImageOnly(resumed[0]);
    } finally {
      wait.mockRestore();
      state.approvalSelections.clear();
    }
  });

  // #18149 Stage 3: a child Session's Turn is a coordinator-dispatched row
  // like a root's. It runs without the live poll, so its certificate
  // carries no approval revision.
  const CHILD_DEFINITION = {
    lineage: {
      parentSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      rootSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      parentChildRunId: 'run-1',
      depth: 1,
    },
  };

  // A public child runs a public Shell profile and repeats it on every load.
  it.each([
    ['a lineage', 'hosted-workspace-files/1', {}],
    [
      'a public',
      'hosted-workspace-shell/1',
      {
        toolProfile: 'hosted-workspace-shell/1',
        publicChildAgentsVersion: 1,
      },
    ],
  ])(
    'parks %s child Session approval and resumes it through cold recovery',
    async (_kind, toolProfile, publicChild) => {
      state.wakeDispatch = true;
      state.actionParking = true;
      state.wakeStamps.length = 0;
      mockApprovalTurn();
      try {
        const server = await app(true, undefined, true, { idleSuspendMs: 150 });
        const clientId = await promptApproval(
          server,
          undefined,
          undefined,
          toolProfile,
          { ...CHILD_DEFINITION, ...publicChild },
        );
        await allowParkedApproval(server, clientId, {
          driveRuntimeRecovery: true,
          ...publicChild,
        });
        expect(state.wakeStamps[0]).toEqual({
          pending: false,
          dueAt: 0,
          parkedTurn: { promptId: PROMPT_ID, wakeAt: expect.any(Number) },
        });
        expect(
          (state.wakeStamps[0] as { parkedTurn: object }).parkedTurn,
        ).not.toHaveProperty('approvalRevision');
        expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(
          1,
        );
        expect(statsOf(server).parkRefusals).toEqual({});
      } finally {
        state.wakeDispatch = false;
        state.actionParking = false;
      }
    },
  );

  it('takes a child Session approval over after its Harness dies in the wait', async () => {
    mockApprovalTurn();
    const wait = vi
      .spyOn(HostedApprovalWaiters.prototype, 'wait')
      .mockRejectedValueOnce(
        new HostedToolRecoveryRequiredError('approval writer interrupted'),
      );
    try {
      const original = await app(true);
      const clientId = await promptApproval(
        original,
        undefined,
        undefined,
        undefined,
        CHILD_DEFINITION,
      );
      await vi.waitFor(
        async () => {
          expect((await statusOf(original, clientId)).body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 5000 },
      );
      await (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed.close();
      wait.mockRestore();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      const resumedClient = loaded.body.clientId as string;
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const requestId = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await headers(
        supertest(replacement).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', resumedClient)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await statusOf(replacement, resumedClient)).body,
          ).toMatchObject({ hasActivePrompt: false, recoveryBlocked: false });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
    } finally {
      wait.mockRestore();
    }
  });

  it('rearms a park attempt whose approval read failed', async () => {
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    mockApprovalTurn();
    // The idle attempt makes the first read once the wait starts: the live
    // poll ticks only after a second.
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    const get = state.approvalSelections.get.bind(state.approvalSelections);
    let failed = false;
    let bumped = false;
    const read = vi
      .spyOn(state.approvalSelections, 'get')
      .mockImplementation((key) => {
        if (failed || waiting.mock.calls.length === 0) {
          const value = get(key);
          if (failed && !bumped) {
            bumped = true;
            // The retry's pre-gate pass still reads revision 1; only the
            // closing gate re-read may observe revision 2, so the sealed
            // stamp witnesses the re-read itself, not the pre-gate pass.
            state.approvalSelections.set(SESSION_ID, {
              mode: 'default',
              revision: 2,
            });
          }
          return value;
        }
        failed = true;
        state.approvalSelections.set(SESSION_ID, {
          mode: 'default',
          revision: 1,
        });
        throw new Error('Approval selection is unavailable.');
      });
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      await promptApproval(server);
      await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
        timeout: 5000,
      });
      expect(failed).toBe(true);
      expect(state.wakeStamps[0]).toMatchObject({
        parkedTurn: { promptId: PROMPT_ID, approvalRevision: 2 },
      });
      // This cell's Turn has no deadline: wakeAt is the approval expiry
      // itself, the other arm of the clamp.
      const wakeAt = (state.wakeStamps[0] as { parkedTurn: { wakeAt: number } })
        .parkedTurn.wakeAt;
      expect(wakeAt).toBeGreaterThan(Date.now() + 55_000);
      expect(wakeAt).toBeLessThanOrEqual(Date.now() + 60_000);
    } finally {
      read.mockRestore();
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.approvalSelections.clear();
    }
  });
});
