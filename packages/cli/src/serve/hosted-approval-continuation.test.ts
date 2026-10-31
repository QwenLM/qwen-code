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
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
} from './hosted-workspace-tool-turn.js';
import {
  HostedWorkspaceBroker,
  hostedRuntimeSessionId,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  endHostedAction,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { hostedPublicPlanActive } from './hosted-plan-mode.js';
import { HostedSkillCatalog } from './hosted-skill-catalog.js';
import { slowHostBudgetMs } from '../test-utils/slow-test-host.js';
import type { HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';

afterEach(() => vi.restoreAllMocks());

// The observed chain is a serial run of fsync-backed publishes and journal
// commits; a fixed 10s budget flaked on a loaded runner (#15176).
const WAIT_TIMEOUT_MS = slowHostBudgetMs(10_000, 45_000);
const TEST_TIMEOUT_MS = slowHostBudgetMs(20_000, 75_000);

it.each(
  ['allow', 'deny', 'cancelled', 'expired']
    .flatMap((decision) =>
      [0, 16].flatMap((round) =>
        [randomUUID(), 'mon_1:notify:3', `arun_${'a'.repeat(32)}:input`].map(
          (promptId) => ({
            decision,
            promptId,
            round,
            planMode: false,
            publicTool: 'write_file',
            profile: 'hosted-workspace-files/1',
          }),
        ),
      ),
    )
    .concat(
      ['allow', 'deny', 'cancelled', 'expired'].map((decision) => ({
        decision,
        promptId: randomUUID(),
        round: 1,
        planMode: false,
        publicTool: 'web_fetch',
        profile: 'hosted-workspace-files/1',
      })),
    )
    .concat(
      ['allow', 'deny', 'cancelled', 'expired'].flatMap((decision) =>
        ['hosted-workspace-files/1', 'hosted-workspace-shell/1'].map(
          (profile) => ({
            decision,
            promptId: randomUUID(),
            round: 1,
            planMode: true,
            publicTool: 'write_file',
            profile,
          }),
        ),
      ),
    )
    .concat(
      ['allow', 'deny'].map((decision) => ({
        decision,
        promptId: randomUUID(),
        round: 1,
        planMode: false,
        profile: 'hosted-workspace-shell/1',
        publicTool: 'skill',
      })),
    )
    .concat(
      ['allow', 'deny', 'cancelled', 'expired'].flatMap((decision) =>
        ['write_file', 'web_fetch', 'agent', 'run_shell_command'].map(
          (publicTool) => ({
            decision,
            promptId: randomUUID(),
            round: 1,
            planMode: false,
            profile: 'hosted-workspace-shell/1',
            publicTool,
          }),
        ),
      ),
    ),
)(
  'restores the original native batch and final Action under a replacement owner ($decision, $promptId, round=$round)',
  async ({ decision, promptId, round, planMode, profile, publicTool }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'g3-step3-baseline-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const options = {
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'g3-step3-baseline',
      activationLeaseDurationMs: 60_000,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const first = await openManagedSession({
      ...options,
      workerId: 'baseline-original',
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              toolProfile: profile,
              ...(profile === 'hosted-workspace-shell/1' && !planMode
                ? { publicChildAgentsVersion: 1 }
                : {}),
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from('{}'),
        ),
        createdBy: 'baseline-probe',
      },
    });
    let closed = false;
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      const harness = createManagedHarnessHandle(first);
      const content = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'write original.txt' }]),
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
          source: planMode ? 'hosted-harness' : 'baseline-probe',
          contentRef: await resources.publish('managed-input', content),
          admissionRef: await resources.publish(
            'managed-admission',
            Buffer.from(
              JSON.stringify(
                planMode
                  ? {
                      promptId,
                      approvalSelection: {
                        mode: 'yolo',
                        revision: 1,
                        planMode: true,
                      },
                    }
                  : {},
              ),
            ),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      await harness.ensureRunnable();
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
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockResolvedValue({
        ownerSessionId: sessionKey.sessionId,
        snapshots: [],
        files: {},
      });
      const prepare = vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare');
      const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
      const publicShell = profile === 'hosted-workspace-shell/1' && !planMode;
      const commandSkills =
        publicTool === 'skill'
          ? new HostedSkillCatalog(
              [],
              [
                {
                  name: 'sample:run',
                  description: 'Run once',
                  prompt: '!{printf %s {{args}}}',
                  extensionId: 'sample',
                  modelInvocable: true,
                },
              ],
            )
          : undefined;
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
      const publication = publicShell
        ? {
            owner: {
              owner: vi.fn(),
              request: vi.fn(),
              rememberAdmission: vi.fn(),
            } as unknown as HttpToolPublicationOwner,
            captureBytes: 1024 * 1024,
          }
        : undefined;
      const turn = new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        first,
        harness,
        promptId,
        async (type, parts, model, identity) => {
          const uuid = identity?.uuid ?? randomUUID();
          await first.sink.write({
            uuid,
            parentUuid: null,
            sessionId: sessionKey.sessionId,
            timestamp: identity?.timestamp ?? new Date().toISOString(),
            type,
            model,
            cwd: root,
            version: 'g3-step3-baseline',
            daemonPromptId: promptId,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
          });
          return uuid;
        },
        () => true,
        publication,
        undefined,
        {
          settings: { mode: planMode ? 'yolo' : 'default', timeoutMs: 60_000 },
          waiters: new HostedApprovalWaiters(),
        },
        {
          profile,
          ...(commandSkills ? { skills: commandSkills, extensionConfig } : {}),
          publicPlanMode: planMode,
          ...(profile === 'hosted-workspace-shell/1' && !planMode
            ? {
                backgroundLane: {
                  resources: first.resources,
                  assertWritable: async () => {},
                },
                childAgents: {
                  funnel: new HostedChildAgentSession(
                    { authority: first.authority, resources: first.resources },
                    sessionKey,
                  ),
                  depth: 0,
                  publicChildren: true,
                  queueConsumption: () => {},
                },
              }
            : {}),
        },
      );
      const call = {
        name: planMode ? 'exit_plan_mode' : publicTool,
        callId: 'original-call',
        args: planMode
          ? { plan: '# Plan\nRead the files, then update original.txt.' }
          : publicTool === 'skill'
            ? { skill: 'sample:run', args: 'argument' }
            : publicTool === 'agent'
              ? {
                  description: 'audit',
                  prompt: 'review the file',
                  run_in_background: true,
                }
              : publicTool === 'run_shell_command'
                ? { command: 'printf once' }
                : publicTool === 'web_fetch'
                  ? { url: 'https://example.com/docs', prompt: 'Summarize' }
                  : {
                      file_path: 'original.txt',
                      content: 'one original batch',
                    },
        isClientInitiated: false,
        prompt_id: promptId,
      };
      turn.setChildModelRoute('fixture-model', {
        authType: 'openai',
        endpointDigest: 'a'.repeat(64),
        providerPin: 'b'.repeat(64),
      });
      turn.setModelRound(round);
      running = turn
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
          controller.signal,
        )
        .catch((cause) => cause);
      let requestId = '';
      await vi.waitFor(
        async () => {
          const authorization = await first.authority.harnessRunAuthorization();
          expect(authorization.status).toBe('runnable');
          if (authorization.status !== 'runnable')
            throw new Error('not runnable');
          expect(authorization.checkpoint.continuation.phase).toBe(
            'await_action',
          );
          requestId = authorization.checkpoint.approval!.requestId;
          expect(first.authority.action(requestId)?.state).toBe('requested');
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const action = first.authority.action(requestId)!;
      const descriptor = JSON.parse(
        (await first.resources.read(action.optionsRef!)).toString(),
      );
      await first.close();
      closed = true;
      controller.abort();
      await running;
      const replacement = await openManagedSession({
        ...options,
        workerId: 'baseline-replacement',
      });
      try {
        expect(replacement.authority.action(requestId)?.state).toBe(
          'requested',
        );
        if (decision === 'allow' || decision === 'deny') {
          const answer = await resolveHostedAction(
            replacement,
            new HostedApprovalWaiters(),
            requestId,
            {
              optionId: decision,
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            },
          );
          expect(answer.status).toBe(200);
        } else {
          await endHostedAction(
            replacement,
            requestId,
            decision as 'cancelled' | 'expired',
          );
        }
        const saved = await findHostedApprovalContinuation(
          replacement,
          promptId,
        );
        expect(saved?.plan).toMatchObject({
          promptId,
          round,
          batchId: first.authority
            .eventsInSequenceRange(1, first.authority.committedSequence)
            .find(
              (event) =>
                event.kind === 'message.committed' &&
                event.payload['role'] === 'assistant',
            )?.payload['messageId'],
          stage: 'approval',
          actionId: requestId,
          runtime: {
            bindingId: 'original-binding',
            generation: '1',
            runtimeSessionId: hostedRuntimeSessionId(promptId),
          },
        });
        expect(saved!.plan.calls[0].call).toEqual(call);
        expect(saved!.plan.calls[0].prepareKey).toBe(
          `${hostedRuntimeSessionId(promptId)}:${saved!.plan.calls[0].runtimeCallId}`,
        );
        expect(saved!.plan.calls[0].prepareReference).toMatchObject({
          sessionId: hostedRuntimeSessionId(promptId),
          promptId,
        });
        expect(saved!.inputs[0].input).toEqual(call.args);
        if (planMode)
          expect(await hostedPublicPlanActive(replacement, promptId)).toBe(
            decision !== 'allow',
          );
        expect(descriptor.v).toBe(3);
        expect(prepare).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        const harness = createManagedHarnessHandle(replacement);
        await harness.resolveDurableWait();
        await harness.adoptPreparedContinuation(promptId);
        const adopted = await replacement.authority.harnessRunAuthorization();
        expect(adopted).toMatchObject({
          status: 'runnable',
          checkpoint: {
            identity: { activationId: replacement.activation.activationId },
            continuation: { phase: 'model_output_committed' },
          },
        });
        if (publicTool === 'skill') {
          expect(saved!.plan.commandStep).toMatchObject({
            toolName: 'shell',
            configRevision: 1,
          });
          if (decision === 'allow') {
            const commandExecute = vi
              .spyOn(HostedWorkspaceBroker.prototype, 'extensionCommand')
              .mockResolvedValue({
                state: 'settled',
                result: {
                  executionStatus: 'success',
                  responseParts: [{ text: 'ran once' }],
                },
              });
            const resumed = new HostedWorkspaceToolTurn(
              { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
              replacement,
              harness,
              promptId,
              vi.fn().mockResolvedValue('unused'),
              () => true,
              publication,
              undefined,
              {
                settings: { mode: 'default', timeoutMs: 60_000 },
                waiters: new HostedApprovalWaiters(),
              },
              { profile, skills: commandSkills, extensionConfig },
            );
            const result = await resumed.resumeSavedNativeBatch(
              saved!,
              1,
              new AbortController().signal,
            );
            expect(JSON.stringify(result)).toContain('ran once');
            expect(commandExecute).toHaveBeenCalledTimes(1);
          }
        }
        if (publicShell && publicTool === 'run_shell_command') {
          expect(saved!.plan.calls[0].publicationId).toMatch(
            /^[a-f0-9-]{36}$/u,
          );
          if (decision === 'allow') {
            const prepareV3 = vi
              .spyOn(HostedWorkspaceBroker.prototype, 'prepareV3')
              .mockRejectedValue(new Error('stop before physical dispatch'));
            const resumed = new HostedWorkspaceToolTurn(
              { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
              replacement,
              harness,
              promptId,
              vi.fn().mockResolvedValue('unused'),
              () => true,
              publication,
              undefined,
              {
                settings: { mode: 'default', timeoutMs: 60_000 },
                waiters: new HostedApprovalWaiters(),
              },
              {
                profile,
                backgroundLane: {
                  resources: replacement.resources,
                  assertWritable: async () => {},
                },
                childAgents: {
                  funnel: new HostedChildAgentSession(
                    {
                      authority: replacement.authority,
                      resources: replacement.resources,
                    },
                    sessionKey,
                  ),
                  depth: 0,
                  publicChildren: true,
                  queueConsumption: () => {},
                },
              },
            );
            await expect(
              resumed.resumeSavedNativeBatch(
                saved!,
                1,
                new AbortController().signal,
              ),
            ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
            expect(prepareV3).toHaveBeenCalledWith(
              saved!.plan.calls[0].runtimeCallId,
              saved!.plan.calls[0].argsDigest,
              saved!.plan.calls[0].requestDigest,
              saved!.plan.calls[0].publicationId,
              promptId,
            );
          }
        }
      } finally {
        await replacement.close();
      }
    } finally {
      controller.abort();
      await running;
      if (!closed) await first.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

// A6 (G1): the saved-batch owner gate refuses a non-commandStep plan under
// a Hook/MCP owner and a commandStep plan whose configRevision no longer
// matches, while a matching-revision commandStep plan proceeds past the
// gate (the A3 commandStep follow-up keeps working). The gate reads
// ownership and revisions, not plan contents — a minimal identity-matching
// plan isolates the clause (the reader has its own suite).
// G2 scope: this pins the tool-turn backstop, including that an
// extensionConfig on the turn does not exempt the owner gate. The harness
// takeover entry's `session.extensions?.enabled` clause is a separate
// route-level surface, recorded as a follow-up in the design doc.
it.each([
  {
    owner: 'hooks',
    hooks: true,
    mcp: false,
    commandStep: 'none',
    extensionConfig: false,
    verdict: 'refuse',
  },
  {
    owner: 'mcp',
    hooks: false,
    mcp: true,
    commandStep: 'none',
    extensionConfig: false,
    verdict: 'refuse',
  },
  {
    owner: 'hooks with a stale commandStep revision',
    hooks: true,
    mcp: false,
    commandStep: 'stale',
    extensionConfig: true,
    verdict: 'refuse',
  },
  {
    owner: 'hooks with a matching commandStep revision',
    hooks: true,
    mcp: false,
    commandStep: 'matching',
    extensionConfig: true,
    verdict: 'pass',
  },
  {
    owner: 'hooks with extensions and no commandStep',
    hooks: true,
    mcp: false,
    commandStep: 'none',
    extensionConfig: true,
    verdict: 'refuse',
  },
])(
  'the saved-batch owner gate: $owner ($verdict)',
  async ({ hooks, mcp, commandStep, extensionConfig, verdict }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'g3-a6-owner-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'g3-a6-owner',
      activationLeaseDurationMs: 60_000,
      workerId: 'a6-owner-probe',
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              toolProfile: 'hosted-workspace-files/1',
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from('{}'),
        ),
        createdBy: 'a6-owner-probe',
      },
    });
    try {
      const promptId = randomUUID();
      const turn = new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        session,
        createManagedHarnessHandle(session),
        promptId,
        vi.fn().mockResolvedValue('unused'),
        () => true,
        undefined,
        undefined,
        {
          settings: { mode: 'default', timeoutMs: 60_000 },
          waiters: new HostedApprovalWaiters(),
        },
        {
          profile: 'hosted-workspace-files/1',
          ...(hooks
            ? {
                hooks:
                  {} as unknown as import('./hosted-hook-session.js').HostedHookSession,
              }
            : {}),
          ...(mcp
            ? {
                mcp: {
                  ensureReady: async () => undefined,
                } as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
              }
            : {}),
          ...(commandStep !== 'none' || extensionConfig
            ? { extensionConfig: { revision: 1, packages: [] } }
            : {}),
        },
      );
      const saved = {
        plan: {
          promptId,
          calls: [],
          ...(commandStep !== 'none'
            ? {
                commandStep: {
                  toolName: 'shell',
                  configRevision: commandStep === 'stale' ? 2 : 1,
                },
              }
            : {}),
          runtime: {
            bindingId: 'binding-1',
            generation: '1',
            workspaceGeneration: '1',
            runtimeSessionId: hostedRuntimeSessionId(promptId),
          },
        },
        parts: [],
        inputs: [],
      } as unknown as import('./hosted-approval-continuation.js').RestoredHostedApprovalContinuation;
      const error = await turn
        .resumeSavedNativeBatch(saved, 1, new AbortController().signal)
        .catch((cause: unknown) => cause);
      if (verdict === 'refuse') {
        expect(error).toBeInstanceOf(HostedToolRecoveryRequiredError);
        expect((error as HostedToolRecoveryRequiredError).cause).toBe(
          'Unsupported saved batch owner.',
        );
      } else {
        // Past the gate: the turn warms against the fixture's unreachable
        // broker, and the resume body wraps that transport failure into the
        // family error with the TypeError as its cause — never the owner
        // refusal's string cause. Dropping `!plan.commandStep &&` from the
        // gate's first arm turns this row into the owner refusal and reds it.
        expect(error).toBeInstanceOf(HostedToolRecoveryRequiredError);
        const cause = (error as HostedToolRecoveryRequiredError).cause;
        expect(cause).toBeInstanceOf(TypeError);
        expect((cause as Error).message).toContain('fetch failed');
      }
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
