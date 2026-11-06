/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  HOSTED_QUESTION_POLICY,
  hostedQuestions,
  assertHostedQuestions,
  normalizeHostedQuestionAnswers,
  hostedQuestionDecisionBytes,
} from './hosted-user-question.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HostedApprovalWaiters,
  resolveHostedAction,
  readHostedActionOptions,
  hostedLiveApprovalPoll,
  endHostedAction,
  type HostedApprovalMode,
} from './hosted-tool-approval.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import { hostedPublicPlanActive } from './hosted-plan-mode.js';

const input = {
  questions: [
    {
      question: 'Which features should be enabled?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Read, write', description: 'First option' },
        {
          label: 'Read, write',
          description: 'Second option with the same label',
        },
      ],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('Hosted question protocol', () => {
  it('preserves option identity and canonicalizes order without changing text', () => {
    const questions = hostedQuestions(input);
    assertHostedQuestions(questions);
    const answer = normalizeHostedQuestionAnswers(questions, [
      {
        questionId: 'q1',
        optionIds: ['q1o2', 'q1o1'],
        text: '中文 / "quote"\n\u000b',
      },
    ]);
    expect(answer).toEqual([
      {
        questionId: 'q1',
        optionIds: ['q1o1', 'q1o2'],
        text: '中文 / "quote"\n\u000b',
      },
    ]);
    expect(
      hostedQuestionDecisionBytes(answer, 1, HOSTED_QUESTION_POLICY).toString(),
    ).toBe(
      '{"v":2,"answers":[{"questionId":"q1","optionIds":["q1o1","q1o2"],"text":"中文 / \\"quote\\"\\n\\u000b"}],"inputRevision":1,"policyRevision":"hosted-user-question/1"}',
    );
  });

  it.each(
    [
      [],
      [{ questionId: 'unknown', optionIds: ['q1o1'] }],
      [{ questionId: 'q1' }],
      [{ questionId: 'q1', optionIds: [] }],
      [{ questionId: 'q1', optionIds: ['q1o1', 'q1o1'] }],
      [{ questionId: 'q1', optionIds: ['unknown'] }],
      [{ questionId: 'q1', text: ' ' }],
      [{ questionId: 'q1', text: '\ud800' }],
      [{ questionId: 'q1', text: 'x'.repeat(8193) }],
      [{ questionId: 'q1', optionIds: ['q1o1'], extra: true }],
    ].map((answer, index) => ({ answer, index })),
  )(
    'rejects invalid answer $index without producing a decision',
    ({ answer }) => {
      expect(() =>
        normalizeHostedQuestionAnswers(hostedQuestions(input), answer),
      ).toThrow();
    },
  );

  it('requires a single choice or custom text and bounds the aggregate bytes', () => {
    const single = hostedQuestions({
      questions: [{ ...input.questions[0], multiSelect: false }],
    });
    expect(() =>
      normalizeHostedQuestionAnswers(single, [
        { questionId: 'q1', optionIds: ['q1o1'], text: 'both' },
      ]),
    ).toThrow();
    expect(
      normalizeHostedQuestionAnswers(single, [
        { questionId: 'q1', text: 'another approach' },
      ]),
    ).toEqual([{ questionId: 'q1', text: 'another approach' }]);
    const four = hostedQuestions({
      questions: Array.from({ length: 4 }, () => input.questions[0]),
    });
    expect(() =>
      normalizeHostedQuestionAnswers(
        four,
        four.map((q) => ({ questionId: q.id, text: '文'.repeat(8192) })),
      ),
    ).toThrow('32 KiB');
    expect(() =>
      hostedQuestions({ ...input, metadata: { source: 'x'.repeat(16384) } }),
    ).toThrow('16 KiB');
    expect(() =>
      hostedQuestions({
        questions: [{ ...input.questions[0], multiSelect: 'true' }],
      }),
    ).toThrow();
    expect(() =>
      hostedQuestions({
        questions: [{ ...input.questions[0], question: '\ud800' }],
      }),
    ).toThrow();
    expect(() =>
      hostedQuestions({ questions: [{ ...input.questions[0], extra: true }] }),
    ).toThrow();
  });
});

const scenarios: Array<{
  mode: HostedApprovalMode;
  profile: string;
  restart: string;
  planMode: boolean;
  terminal?: 'cancelled' | 'expired';
  mixed?: boolean;
}> = [
  ...(['yolo', 'auto', 'default', 'auto-edit'] as const).map((mode) => ({
    mode,
    profile: 'hosted-workspace-files/1',
    restart: 'none',
    planMode: false,
  })),
  ...['hosted-workspace-files/1', 'hosted-workspace-shell/1'].flatMap(
    (profile) =>
      ['waiting', 'decided'].map((restart) => ({
        mode: 'yolo' as const,
        profile,
        restart,
        planMode: false,
      })),
  ),
  {
    mode: 'yolo' as const,
    profile: 'hosted-workspace-shell/1',
    restart: 'waiting',
    planMode: true,
  },
  ...['hosted-workspace-files/2', 'hosted-workspace-files/3'].map(
    (profile) => ({
      mode: 'yolo' as const,
      profile,
      restart: 'none',
      planMode: false,
    }),
  ),
  ...(['cancelled', 'expired'] as const).map((terminal) => ({
    mode: 'yolo' as const,
    profile: 'hosted-workspace-files/1',
    restart: 'none',
    planMode: false,
    terminal,
  })),
  {
    mode: 'yolo',
    profile: 'hosted-workspace-files/1',
    restart: 'none',
    planMode: false,
    mixed: true,
  },
];

it.each(scenarios)(
  'handles the original question ($mode, $profile, restart=$restart, plan=$planMode, terminal=$terminal, mixed=$mixed)',
  async ({ mode, profile, restart, planMode, terminal, mixed }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'managed-user-questions-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const promptId = randomUUID();
    const sessionOptions = {
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'question-test',
      activationLeaseDurationMs: 60000,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    let session = await openManagedSession({
      ...sessionOptions,
      workerId: 'original',
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({ engine: 'managed', toolProfile: profile }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from('{}'),
        ),
        createdBy: 'question-test',
      },
    });
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      const content = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'Ask before proceeding' }]),
      );
      await session.authority.submitInput(
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
          contentRef: await resources.publish('managed-input', content),
          admissionRef: await resources.publish(
            'managed-admission',
            Buffer.from(
              JSON.stringify({
                promptId,
                approvalSelection: {
                  mode,
                  revision: 1,
                  ...(planMode ? { planMode: true } : {}),
                },
              }),
            ),
          ),
          deadline: null,
          wakeReason: 'input',
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
      const waiters = new HostedApprovalWaiters();
      if (restart !== 'none')
        vi.spyOn(waiters, 'wait').mockImplementation(
          async (_id, _expiry, signal) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          },
        );
      const makeTurn = (
        owner: ManagedSession,
        ownerWaiters: HostedApprovalWaiters,
        extra?: { childDepth?: number; foregroundOnly?: boolean },
      ) =>
        new HostedWorkspaceToolTurn(
          { baseUrl: 'http://127.0.0.1:1', token: 'test-no-network' },
          owner,
          createManagedHarnessHandle(owner),
          promptId,
          async (type, parts, model, identity) => {
            const uuid = identity?.uuid ?? randomUUID();
            await owner.sink.write({
              uuid,
              parentUuid: null,
              sessionId: sessionKey.sessionId,
              timestamp: new Date().toISOString(),
              type,
              model,
              cwd: root,
              version: 'question-test',
              daemonPromptId: promptId,
              message: { role: type === 'assistant' ? 'model' : 'user', parts },
            });
            return uuid;
          },
          () => true,
          undefined,
          undefined,
          {
            settings: {
              mode,
              timeoutMs: terminal === 'expired' ? 1000 : 60000,
            },
            waiters: ownerWaiters,
          },
          { profile, publicPlanMode: planMode, ...extra },
        );
      await createManagedHarnessHandle(session).ensureRunnable();
      if (!planMode) {
        for (const extra of [{ childDepth: 1 }, { foregroundOnly: true }])
          expect(
            (
              await makeTurn(session, waiters, extra).declarations(
                controller.signal,
              )
            ).map((tool) => tool.name),
          ).not.toContain('ask_user_question');
      }
      const turn = makeTurn(session, waiters);
      const classifier = vi.fn();
      turn.setPermissionClassifier(classifier);
      expect(
        (await turn.declarations(controller.signal)).map((tool) => tool.name),
      ).toContain('ask_user_question');
      const call = {
        name: 'ask_user_question',
        callId: 'question-call',
        args: input,
        isClientInitiated: false,
        prompt_id: promptId,
      };
      const calls = mixed
        ? [
            call,
            {
              ...call,
              name: 'write_file',
              callId: 'mixed-write',
              args: { file_path: 'must-not-exist', content: 'No effects' },
            },
          ]
        : [call];
      running = turn
        .execute(
          calls,
          calls.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'model',
          controller.signal,
        )
        .catch((error) => error);
      if (mixed) {
        expect(JSON.stringify(await running)).toContain(
          'must be the only call',
        );
        expect(
          session.authority
            .eventsInSequenceRange(1, session.authority.committedSequence)
            .some((event) => event.kind === 'action.changed'),
        ).toBe(false);
        expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        return;
      }
      let actionId = '';
      await vi.waitFor(
        async () => {
          const auth = await session.authority.harnessRunAuthorization();
          expect(auth).toMatchObject({
            status: 'runnable',
            checkpoint: { continuation: { phase: 'await_action' } },
          });
          if (auth.status === 'runnable')
            actionId = auth.checkpoint.approval!.requestId;
        },
        { timeout: 15000 },
      );
      const action = session.authority.action(actionId)!;
      const options = await readHostedActionOptions(session, action);
      expect(options).toMatchObject({
        v: 4,
        requiresHumanDecision: true,
        policyRevision: HOSTED_QUESTION_POLICY,
      });
      expect(action.kind).toBe('question');
      await hostedLiveApprovalPoll(
        session,
        waiters,
        options,
        async () => ({ mode: 'yolo', timeoutMs: 60000 }),
        controller.signal,
      )();
      expect(session.authority.action(actionId)?.state).toBe('requested');
      expect(classifier).not.toHaveBeenCalled();
      const body = {
        answers: [
          {
            questionId: 'q1',
            optionIds: ['q1o2', 'q1o1'],
            text: 'Custom, with comma',
          },
        ],
        inputRevision: 1,
        policyRevision: HOSTED_QUESTION_POLICY,
      };
      expect(
        (
          await resolveHostedAction(session, waiters, actionId, {
            optionId: 'allow',
            inputRevision: 1,
            policyRevision: HOSTED_QUESTION_POLICY,
          })
        ).status,
      ).toBe(400);
      if (terminal) {
        if (terminal === 'cancelled') controller.abort();
        const result = await running;
        if (terminal === 'cancelled')
          expect(result).toMatchObject({ name: 'AbortError' });
        else expect(result).not.toBeInstanceOf(Error);
        expect(session.authority.action(actionId)?.state).toBe(terminal);
        expect(session.authority.action(actionId)?.decisionRef).toBeNull();
        expect(
          (await resolveHostedAction(session, waiters, actionId, body)).status,
        ).toBe(409);
        expect(JSON.stringify(result)).not.toContain(
          'User provided the following answers',
        );
        expect(prepare).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        return;
      }
      if (restart === 'decided')
        expect(
          (
            await resolveHostedAction(
              session,
              new HostedApprovalWaiters(),
              actionId,
              body,
            )
          ).status,
        ).toBe(200);
      if (restart !== 'none') {
        await session.close();
        controller.abort();
        await running;
        session = await openManagedSession({
          ...sessionOptions,
          workerId: 'replacement',
        });
        expect(session.authority.action(actionId)?.state).toBe(
          restart === 'waiting' ? 'requested' : 'decided',
        );
      }
      expect(
        (await resolveHostedAction(session, waiters, actionId, body)).status,
      ).toBe(200);
      expect(
        (
          await resolveHostedAction(session, waiters, actionId, {
            ...body,
            answers: [{ ...body.answers[0], optionIds: ['q1o1', 'q1o2'] }],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await resolveHostedAction(session, waiters, actionId, {
            ...body,
            answers: [{ questionId: 'q1', optionIds: ['q1o1'] }],
          })
        ).status,
      ).toBe(409);
      let result;
      if (restart === 'none') result = await running;
      else {
        const saved = await findHostedApprovalContinuation(session, promptId);
        expect(saved?.plan.actionId).toBe(actionId);
        const harness = createManagedHarnessHandle(session);
        await harness.resolveDurableWait();
        await harness.adoptPreparedContinuation(promptId);
        result = await makeTurn(
          session,
          new HostedApprovalWaiters(),
        ).resumeSavedNativeBatch(saved!, 1, new AbortController().signal);
      }
      expect(result).not.toBeInstanceOf(Error);
      expect(JSON.stringify(result)).toContain('Selected q1o2: Read, write');
      expect(JSON.stringify(result)).toContain('Custom, with comma');
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(
        (await session.sink.project()).filter(
          (item) => item.type === 'tool_result',
        ),
      ).toHaveLength(1);
      expect(
        await findHostedApprovalContinuation(session, promptId),
      ).toBeUndefined();
      if (planMode)
        expect(await hostedPublicPlanActive(session, promptId)).toBe(true);
      await endHostedAction(session, actionId, 'cancelled');
      expect(session.authority.action(actionId)?.state).toBe('decided');
    } finally {
      controller.abort();
      if (running) await running;
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
