/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { parseManagedToolStage } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-stage-record.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import {
  HostedWorkspaceBroker,
  hostedRuntimeSessionId,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedSkillCatalog } from './hosted-skill-catalog.js';
import type { HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  hostedHookOccurrenceId,
  HostedHookSession,
} from './hosted-hook-session.js';
import { slowHostBudgetMs } from '../test-utils/slow-test-host.js';

const WAIT_TIMEOUT_MS = slowHostBudgetMs(10_000, 45_000);
const TEST_TIMEOUT_MS = slowHostBudgetMs(30_000, 90_000);
const ORIGINAL_FIRST = 'printf original-first';
const ORIGINAL_SECOND = 'printf original-second';
const REWRITTEN_FIRST = 'printf rewritten-first';
const REWRITTEN_SECOND = 'printf rewritten-second';

afterEach(() => vi.restoreAllMocks());

it(
  'replays rewritten command steps without inheriting Allow or rerunning Hooks',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hosted-command-hook-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const promptId = randomUUID();
    const options = {
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'a3-command-hook',
      activationLeaseDurationMs: 60_000,
    };
    const skills = new HostedSkillCatalog(
      [],
      [
        {
          name: 'sample:run',
          description: 'Run two commands',
          prompt: `!{${ORIGINAL_FIRST}}\n!{${ORIGINAL_SECOND}}`,
          extensionId: 'sample',
          modelInvocable: true,
        },
      ],
    );
    const extensionConfig = {
      revision: 1,
      packages: [
        {
          pin: {
            extensionId: 'sample',
            packageRevision: 1,
            packageDigest: 'a'.repeat(64),
          },
          assetRoot: 'extension://sample/',
        },
      ],
    };
    const pin = {
      catalogId: 'command-policy',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const physicalHooks: Array<{
      event: string;
      occurrenceId: unknown;
      command: unknown;
    }> = [];
    const commands: Array<{ stageId: string; command: unknown }> = [];
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...pin,
              hooks: [HookEventName.PreToolUse, HookEventName.PostToolUse].map(
                (eventName) => ({
                  hookId: `hook-${eventName}`,
                  eventName,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command', command: 'fixture' },
                }),
              ),
            },
          };
        if (operation.kind === 'hook-execute') {
          const input = operation.input as unknown as Record<string, unknown>;
          const event = String(input['hook_event_name']);
          const toolInput = input['tool_input'] as
            | { command?: unknown }
            | undefined;
          const original = toolInput?.command;
          const command =
            original === ORIGINAL_FIRST
              ? REWRITTEN_FIRST
              : original === ORIGINAL_SECOND
                ? REWRITTEN_SECOND
                : original;
          physicalHooks.push({
            event,
            occurrenceId: input['tool_use_id'],
            command,
          });
          return {
            operationId: operation.operationId,
            state: 'settled',
            result: {
              success: true,
              outcome: 'success',
              duration: 1,
              output:
                event === HookEventName.PreToolUse &&
                input['tool_name'] === 'run_shell_command'
                  ? {
                      hookSpecificOutput: {
                        permissionDecision: 'ask',
                        updatedInput: { command, timeout: 120000 },
                      },
                    }
                  : {},
            },
          };
        }
        throw new Error(`Unexpected Hook control: ${operation.kind}`);
      },
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'resolveCapabilities',
    ).mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: sessionKey.sessionId,
      snapshots: [],
      files: {},
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'extensionCommand',
    ).mockImplementation(async (operation) => {
      const command = (operation.input as Record<string, unknown>)['command'];
      commands.push({ stageId: operation.operationId, command });
      return {
        state: 'settled',
        result: {
          executionStatus: 'success',
          responseParts: [{ text: `ran:${String(command)}` }],
        },
      };
    });
    const fireSpy = vi.spyOn(HostedHookSession.prototype, 'fire');

    const open = async (workerId: string, create = false) => {
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: root,
        sessionKey,
      });
      return openManagedSession({
        ...options,
        workerId,
        ...(create
          ? {
              create: {
                definitionRef: await resources.publish(
                  'managed-definition',
                  Buffer.from(
                    JSON.stringify({
                      engine: 'managed',
                      toolProfile: 'hosted-workspace-shell/1',
                      publicChildAgentsVersion: 1,
                    }),
                  ),
                ),
                rootSnapshotRef: await resources.publish(
                  'managed-root',
                  Buffer.from('{}'),
                ),
                createdBy: 'a3-command-hook',
              },
            }
          : {}),
      });
    };
    const hooksOf = (session: ManagedSession) =>
      new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        session,
        pin,
        {
          runtimeSessionId: hostedRuntimeSessionId(promptId),
          runtime: {
            bindingId: 'original-binding',
            generation: '1',
            workspaceGeneration: '1',
          },
          warm: async () => undefined,
          acquire: async () => undefined,
          authorizeLifecycle: async () => undefined,
          fileHistory: async () => ({
            ownerSessionId: sessionKey.sessionId,
            snapshots: [],
            files: {},
          }),
          extensionCommand: async (
            operation: Parameters<HostedWorkspaceBroker['extensionCommand']>[0],
          ) => {
            const command = (operation.input as Record<string, unknown>)[
              'command'
            ];
            commands.push({ stageId: operation.operationId, command });
            return {
              state: 'settled',
              result: {
                executionStatus: 'success',
                responseParts: [{ text: `ran:${String(command)}` }],
              },
            };
          },
          hookControl,
        } as unknown as HostedWorkspaceBroker,
      );
    const turnOf = (session: ManagedSession) => {
      const publication = {
        owner: {
          owner: vi.fn(),
          request: vi.fn(),
          rememberAdmission: vi.fn(),
        } as unknown as HttpToolPublicationOwner,
        captureBytes: 1024 * 1024,
      };
      const turn = new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        session,
        createManagedHarnessHandle(session),
        promptId,
        async (type, parts, model, identity) => {
          const uuid = identity?.uuid ?? randomUUID();
          await session.sink.write({
            uuid,
            parentUuid: null,
            sessionId: sessionKey.sessionId,
            timestamp: identity?.timestamp ?? new Date().toISOString(),
            type,
            model,
            cwd: root,
            version: 'a3-command-hook',
            daemonPromptId: promptId,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
          });
          return uuid;
        },
        () => true,
        publication,
        undefined,
        {
          settings: { mode: 'default', timeoutMs: 60_000 },
          waiters: new HostedApprovalWaiters(),
        },
        {
          profile: 'hosted-workspace-shell/1',
          skills,
          extensionConfig,
          hooks: hooksOf(session),
          childAgents: {
            funnel: new HostedChildAgentSession(
              { authority: session.authority, resources: session.resources },
              sessionKey,
            ),
            depth: 0,
            publicChildren: true,
            queueConsumption: () => {},
          },
        },
      );
      return turn;
    };
    const waitForAction = async (
      session: ManagedSession,
      previous?: string,
    ) => {
      let requestId = '';
      await vi.waitFor(
        async () => {
          const authorization =
            await session.authority.harnessRunAuthorization();
          expect(authorization.status).toBe('runnable');
          if (authorization.status !== 'runnable') return;
          expect(authorization.checkpoint.continuation.phase).toBe(
            'await_action',
          );
          const candidate = authorization.checkpoint.approval!.requestId;
          if (candidate === previous)
            throw new Error('The next command approval is not durable yet.');
          requestId = candidate;
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      expect(requestId).toMatch(/^command_approval_/u);
      return requestId;
    };
    const actionInput = async (session: ManagedSession, actionId: string) => {
      const action = session.authority.action(actionId)!;
      const options = JSON.parse(
        (await session.resources.read(action.optionsRef!)).toString(),
      ) as { inputRef: Parameters<ManagedSession['resources']['read']>[0] };
      const input = JSON.parse(
        (await session.resources.read(options.inputRef)).toString(),
      ) as { command: string };
      return input.command;
    };
    const hookCount = (event: HookEventName, stageId: string) =>
      physicalHooks.filter(
        (hook) => hook.event === event && hook.occurrenceId === stageId,
      ).length;
    const hookResult = (
      session: ManagedSession,
      event: HookEventName,
      id: string,
    ) => {
      const record = session.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(event, id),
      );
      return record ? parseHookExecution(record.record) : undefined;
    };

    const first = await open('command-hook-gen1', true);
    let firstClosed = false;
    const controller1 = new AbortController();
    let running1: Promise<unknown> | undefined;
    try {
      const content = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'run two commands' }]),
      );
      await first.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: promptId,
          sessionKey,
          contentDigest: createHash('sha256').update(content).digest('hex'),
        },
        {
          inputId: promptId,
          turnId: promptId,
          source: 'hosted-harness',
          contentRef: await first.resources.publish('managed-input', content),
          admissionRef: await first.resources.publish(
            'managed-admission',
            Buffer.from('{}'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      await createManagedHarnessHandle(first).ensureRunnable();
      const call = {
        name: 'skill',
        callId: 'outer-skill',
        args: { skill: 'sample:run', args: '' },
        isClientInitiated: false,
        prompt_id: promptId,
      };
      running1 = turnOf(first)
        .execute(
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
          'fixture-model',
          controller1.signal,
        )
        .catch((cause) => cause);
      const action1Id = await waitForAction(first);
      expect(await actionInput(first, action1Id)).toBe(REWRITTEN_FIRST);
      await first.close();
      firstClosed = true;
      controller1.abort();
      await running1;

      const second = await open('command-hook-gen2');
      const controller2 = new AbortController();
      let running2: Promise<unknown> | undefined;
      try {
        const saved1 = await findHostedApprovalContinuation(second, promptId);
        const stageId1 = saved1!.plan.commandStep!.toolStageId;
        expect(saved1!.plan.commandStep!.inputRef).toBeDefined();
        expect(second.authority.action(action1Id)?.state).toBe('requested');
        expect(
          await resolveHostedAction(
            second,
            new HostedApprovalWaiters(),
            action1Id,
            {
              optionId: 'allow',
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            },
          ),
        ).toMatchObject({ status: 200 });
        running2 = turnOf(second)
          .resumeSavedNativeBatch(saved1!, 1, controller2.signal)
          .catch((cause) => cause);
        const action2Id = await waitForAction(second, action1Id);
        expect(action2Id).not.toBe(action1Id);
        expect(await actionInput(second, action2Id)).toBe(REWRITTEN_SECOND);
        expect(second.authority.action(action1Id)?.state).toBe('decided');
        expect(commands).toEqual([
          { stageId: stageId1, command: REWRITTEN_FIRST },
        ]);
        expect(hookCount(HookEventName.PreToolUse, stageId1)).toBe(1);
        expect(hookCount(HookEventName.PostToolUse, stageId1)).toBe(1);
        const post1 = hookResult(second, HookEventName.PostToolUse, stageId1);
        expect(post1?.resultRef).toBeTruthy();
        const stage1 = second.authority.extensionRecord('tool_stage', stageId1);
        expect(stage1).toBeDefined();
        expect(parseManagedToolStage(stage1!.record).resultRef).toBeTruthy();
        const action2Options = JSON.parse(
          (
            await second.resources.read(
              second.authority.action(action2Id)!.optionsRef!,
            )
          ).toString(),
        ) as { expiresAt: number };
        await second.close();
        controller2.abort();
        await running2;

        const third = await open('command-hook-gen3');
        const controller3 = new AbortController();
        let running3: Promise<unknown> | undefined;
        try {
          const saved2 = await findHostedApprovalContinuation(third, promptId);
          const stageId2 = saved2!.plan.commandStep!.toolStageId;
          expect(stageId2).not.toBe(stageId1);
          expect(saved2!.plan.actionId).toBe(action2Id);
          expect(third.authority.action(action2Id)?.state).toBe('requested');
          const action2RecoveredOptions = JSON.parse(
            (
              await third.resources.read(
                third.authority.action(action2Id)!.optionsRef!,
              )
            ).toString(),
          ) as { expiresAt: number };
          expect(action2RecoveredOptions.expiresAt).toBe(
            action2Options.expiresAt,
          );
          expect(await actionInput(third, action2Id)).toBe(REWRITTEN_SECOND);
          const post1ReplaysBefore = fireSpy.mock.calls.filter(
            ([event, occurrenceId]) =>
              event === HookEventName.PostToolUse && occurrenceId === stageId1,
          ).length;
          running3 = turnOf(third)
            .resumeSavedNativeBatch(saved2!, 1, controller3.signal)
            .catch((cause) => cause);
          await vi.waitFor(
            () => {
              const replays = fireSpy.mock.calls.filter(
                ([event, occurrenceId]) =>
                  event === HookEventName.PostToolUse &&
                  occurrenceId === stageId1,
              ).length;
              expect(replays).toBeGreaterThan(post1ReplaysBefore);
            },
            { timeout: WAIT_TIMEOUT_MS },
          );
          expect(hookCount(HookEventName.PreToolUse, stageId1)).toBe(1);
          expect(hookCount(HookEventName.PostToolUse, stageId1)).toBe(1);
          expect(commands).toEqual([
            { stageId: stageId1, command: REWRITTEN_FIRST },
          ]);
          expect(
            await resolveHostedAction(
              third,
              new HostedApprovalWaiters(),
              action2Id,
              {
                optionId: 'allow',
                inputRevision: 1,
                policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
              },
            ),
          ).toMatchObject({ status: 200 });
          const result = await running3;
          expect(JSON.stringify(result)).toContain(REWRITTEN_SECOND);
          expect(commands).toEqual([
            { stageId: stageId1, command: REWRITTEN_FIRST },
            { stageId: stageId2, command: REWRITTEN_SECOND },
          ]);
          for (const stageId of [stageId1, stageId2]) {
            expect(hookCount(HookEventName.PreToolUse, stageId)).toBe(1);
            expect(hookCount(HookEventName.PostToolUse, stageId)).toBe(1);
          }
          expect(third.authority.action(action1Id)?.state).toBe('decided');
          expect(third.authority.action(action2Id)?.state).toBe('decided');
        } finally {
          controller3.abort();
          await running3;
          await third.close();
        }
      } finally {
        controller2.abort();
        await running2;
        await second.close();
      }
    } finally {
      controller1.abort();
      await running1;
      if (!firstClosed) await first.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
