// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useReducer } from 'react';
import type {
  DaemonInputAnnotation,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type { SessionChatController } from '../chat-core/contract.js';
import type { PromptFile, PromptImage } from '../adapters/promptTypes.js';

const harness = vi.hoisted(() => ({
  connection: {
    sessionId: 's1',
    workspaceCwd: '/w',
    loadingTranscript: false,
    missingSession: false,
    error: undefined as string | undefined,
    capabilities: { features: [] as string[] },
  } as Record<string, unknown>,
  submitPrompt: vi.fn(async () => ({ promptId: 'p1' })),
  cancel: vi.fn(async () => {}),
  submitPermission: vi.fn(async () => true),
  respondToPermission: vi.fn(async () => true),
  blocks: [] as readonly DaemonTranscriptBlock[],
  pendingPermissions: [] as readonly DaemonTranscriptBlock[],
  promptSettledListener: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('./session/DaemonSessionProvider.js', () => ({
  useDaemonConnection: () => harness.connection,
  useDaemonActions: () => ({
    submitPrompt: harness.submitPrompt,
    cancel: harness.cancel,
    submitPermission: harness.submitPermission,
    respondToPermission: harness.respondToPermission,
  }),
  useDaemonTranscriptBlocks: () => harness.blocks,
  useDaemonPendingPermissions: () => harness.pendingPermissions,
  useDaemonPromptSettled: (listener: unknown) => {
    harness.promptSettledListener = listener as (event: unknown) => void;
  },
}));
vi.mock('../i18n.js', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../hooks/useMessages.js', () => ({
  useMessagesFromBlocks: () => [],
}));
vi.mock('../hooks/useComposerCore.js', () => ({
  getComposerDraftStorageKey: (sessionId: string) => `draft:${sessionId}`,
}));

import { useDaemonChatController } from './useDaemonChatController.js';
import { cleanupReact, mountReact } from '../test/reactHarness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let controller: SessionChatController | undefined;
let forceRerender: (() => void) | undefined;
function Probe() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  forceRerender = () => act(() => bump());
  controller = useDaemonChatController();
  return null;
}

function permissionBlock(
  requestId: string,
  opts: { questions?: boolean; allowOnce?: boolean; plan?: boolean } = {},
): DaemonTranscriptBlock {
  const options = [
    ...(opts.allowOnce === false
      ? []
      : [{ optionId: 'submit', label: 'Submit', raw: { kind: 'allow_once' } }]),
    { optionId: 'cancel', label: 'Cancel', raw: { kind: 'reject_once' } },
  ];
  const toolCall = opts.plan
    ? {
        kind: 'switch_mode',
        _meta: { toolName: 'exit_plan_mode' },
        rawInput: {},
      }
    : opts.questions
      ? { rawInput: { questions: [{ question: 'Q0?' }, { question: 'Q1?' }] } }
      : { rawInput: {} };
  return {
    id: `perm-${requestId}`,
    kind: 'permission',
    requestId,
    sessionId: 's1',
    title: 'permission',
    resolved: undefined,
    options,
    toolCall,
    preview: { kind: 'generic' },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DaemonTranscriptBlock;
}

beforeEach(() => {
  harness.connection.sessionId = 's1';
  harness.connection.loadingTranscript = false;
  harness.connection.missingSession = false;
  harness.connection.error = undefined;
  harness.connection.planExecutionMode = undefined;
  harness.connection.capabilities = { features: [] };
  harness.submitPrompt.mockClear();
  harness.submitPrompt.mockResolvedValue({ promptId: 'p1' });
  harness.cancel.mockClear();
  harness.cancel.mockResolvedValue(undefined);
  harness.submitPermission.mockClear();
  harness.submitPermission.mockResolvedValue(true);
  harness.respondToPermission.mockClear();
  harness.respondToPermission.mockResolvedValue(true);
  harness.blocks = [];
  harness.pendingPermissions = [];
  harness.promptSettledListener = undefined;
  controller = undefined;
  forceRerender = undefined;
});

afterEach(() => {
  cleanupReact();
});

describe('useDaemonChatController', () => {
  it('forwards inputAnnotations to the submit action', async () => {
    mountReact(<Probe />);
    const annotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: '@a.ts',
        reference: { id: 'ref-1', kind: 'file', value: '/w/a.ts' },
      },
    ];
    await controller!.submit({
      text: 'hi',
      metadata: { inputAnnotations: annotations },
    });
    expect(harness.submitPrompt).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ inputAnnotations: annotations }),
    );
  });

  it('splits question permissions from tool approvals', () => {
    harness.pendingPermissions = [
      permissionBlock('q1', { questions: true }),
      permissionBlock('a1'),
    ];
    mountReact(<Probe />);
    expect(controller!.pendingQuestions.map((q) => q.id)).toEqual(['q1']);
    expect(controller!.pendingApprovals.map((a) => a.id)).toEqual(['a1']);
    // The render-ready request payload is pinned, not just the ids: emptying
    // request.options at the binding must turn this red.
    expect(
      controller!.pendingApprovals[0].request.options.map((o) => o.id),
    ).toEqual(['submit', 'cancel']);
    expect(
      (
        controller!.pendingQuestions[0].request.rawInput as {
          questions?: unknown;
        }
      ).questions,
    ).toEqual([{ question: 'Q0?' }, { question: 'Q1?' }]);
  });

  it('refreshes the cached request when a re-emitted payload changes under the same id', () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    const before = controller!.pendingApprovals[0].request;
    expect(before.title).toBe('permission');
    // The daemon re-emits permission.request for the same requestId with a
    // changed title and a bumped revision; id and classification are unchanged.
    harness.pendingPermissions = [
      {
        ...permissionBlock('a1'),
        title: 'Run ls',
        updatedAt: 2,
      } as DaemonTranscriptBlock,
    ];
    forceRerender!();
    const after = controller!.pendingApprovals[0].request;
    expect(after.title).toBe('Run ls');
    expect(after).not.toBe(before);
  });

  it('refreshes the cached request on a rawInput-only re-emit via the updatedAt term', () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    expect(
      (controller!.pendingApprovals[0].request.rawInput as { command?: string })
        .command,
    ).toBeUndefined();
    // Same id, title and option ids; only toolCall.rawInput changes and the
    // revision bumps. Only the updatedAt term can catch this shape, so dropping
    // it from the revision must turn this red.
    harness.pendingPermissions = [
      {
        ...permissionBlock('a1'),
        toolCall: { rawInput: { command: 'pwd' } },
        updatedAt: 2,
      } as DaemonTranscriptBlock,
    ];
    forceRerender!();
    expect(
      (controller!.pendingApprovals[0].request.rawInput as { command?: string })
        .command,
    ).toBe('pwd');
  });

  it('refreshes the cached request on a title-only re-emit at the same revision', () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    // Same updatedAt and option ids; only the title changes. Only the title term
    // can catch this shape, so dropping it from the revision must turn this red.
    harness.pendingPermissions = [
      { ...permissionBlock('a1'), title: 'Run pwd' } as DaemonTranscriptBlock,
    ];
    forceRerender!();
    expect(controller!.pendingApprovals[0].request.title).toBe('Run pwd');
  });

  it('refreshes the cached request on an option-id-only re-emit at the same revision', () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    expect(
      controller!.pendingApprovals[0].request.options.map((o) => o.id),
    ).toEqual(['submit', 'cancel']);
    // Same updatedAt and title; only the option ids change. Only the option-id
    // term can catch this shape, so dropping it must turn this red.
    harness.pendingPermissions = [
      {
        ...permissionBlock('a1'),
        options: [
          { optionId: 'allow', label: 'Allow', raw: { kind: 'allow_once' } },
          { optionId: 'deny', label: 'Deny', raw: { kind: 'reject_once' } },
        ],
      } as DaemonTranscriptBlock,
    ];
    forceRerender!();
    expect(
      controller!.pendingApprovals[0].request.options.map((o) => o.id),
    ).toEqual(['allow', 'deny']);
  });

  it('answers a question by voting its allow_once option with indexed answers', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: '0', value: 'Alice' },
      { questionId: '1', value: 'Bob' },
    ]);
    expect(result.admission).toBe('accepted');
    expect(harness.submitPermission).toHaveBeenCalledWith('q1', 'submit', {
      '0': 'Alice',
      '1': 'Bob',
    });
  });

  it('rejects a question answer whose questionId is not a valid index', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: 'not-an-index', value: 'Alice' },
    ]);
    expect(result.admission).toBe('rejected');
    expect(harness.submitPermission).not.toHaveBeenCalled();
  });

  it('rejects a question with no allow_once submit option', async () => {
    harness.pendingPermissions = [
      permissionBlock('q1', { questions: true, allowOnce: false }),
    ];
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
    expect(result.admission).toBe('rejected');
    expect(harness.submitPermission).not.toHaveBeenCalled();
  });

  it('reports an error transcript state for a missing session', () => {
    harness.connection.missingSession = true;
    mountReact(<Probe />);
    expect(controller!.transcriptState).toBe('error');
  });

  it('skips Object.prototype feature tags without throwing', () => {
    harness.connection.capabilities = { features: ['toString', '__proto__'] };
    mountReact(<Probe />);
    expect(controller!.capabilities.modelSelection).toBe(false);
  });

  it('settles a submitted prompt when its terminal event arrives', async () => {
    mountReact(<Probe />);
    const result = await controller!.submit({ text: 'hi' });
    expect(result.admission).toBe('accepted');
    // Admission is not establishment: the turn runs until its terminal event.
    expect(controller!.phase).toBe('running');
    expect(
      controller!.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('running');
    act(() => {
      harness.promptSettledListener!({ promptId: 'p1', outcome: 'completed' });
    });
    expect(
      controller!.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('established');
    expect(controller!.phase).toBe('idle');
  });

  it('reports an unknown submit admission when the prompt transport throws', async () => {
    harness.submitPrompt.mockRejectedValue(new Error('network'));
    mountReact(<Probe />);
    const result = await controller!.submit({ text: 'hi' });
    expect(result.admission).toBe('unknown');
  });

  it('reports a rejected approval admission when the vote is not applied', async () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    harness.submitPermission.mockResolvedValue(false);
    mountReact(<Probe />);
    const result = await controller!.respondApproval('a1', 'submit');
    expect(result.admission).toBe('rejected');
    expect(controller!.operations.some((op) => op.kind === 'approval')).toBe(
      false,
    );
  });

  it('reports an unknown approval admission when the vote throws', async () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    harness.submitPermission.mockRejectedValue(new Error('network'));
    mountReact(<Probe />);
    const result = await controller!.respondApproval('a1', 'submit');
    expect(result.admission).toBe('unknown');
  });

  it('establishes an answered approval when its permission leaves the pending set', async () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    const result = await controller!.respondApproval('a1', 'submit');
    expect(result.admission).toBe('accepted');
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('unsettled');
    // The daemon resolved the answered permission: the derived decision
    // settlement must reach the controller and establish the attempt.
    harness.pendingPermissions = [];
    forceRerender!();
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');
  });

  it('votes a plan approval through respondToPermission with the current mode', async () => {
    harness.connection.planExecutionMode = 'default';
    harness.pendingPermissions = [permissionBlock('plan1', { plan: true })];
    mountReact(<Probe />);
    const result = await controller!.respondApproval('plan1', 'submit');
    expect(result.admission).toBe('accepted');
    expect(harness.respondToPermission).toHaveBeenCalledWith('plan1', {
      outcome: { outcome: 'selected', optionId: 'submit' },
      expectedPlanExecutionMode: 'default',
    });
    expect(harness.submitPermission).not.toHaveBeenCalled();
  });

  it('does not establish an approval answered after its request was superseded', async () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    // a1 leaves the pending set without an answer: superseded, no decision.
    harness.pendingPermissions = [];
    forceRerender!();
    const result = await controller!.respondApproval('a1', 'submit');
    expect(result.admission).toBe('accepted');
    forceRerender!();
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('unsettled');
  });

  it('keeps the approval/question arrays stable when the provider re-selects the same pending content', () => {
    const approval = permissionBlock('a1');
    const question = permissionBlock('q1', { questions: true });
    harness.pendingPermissions = [approval, question];
    mountReact(<Probe />);
    const approvals = controller!.pendingApprovals;
    const questions = controller!.pendingQuestions;
    // The provider's uncached selector hands out a fresh array on every
    // streaming delta even when the pending content is unchanged.
    harness.pendingPermissions = [approval, question];
    forceRerender!();
    expect(controller!.pendingApprovals).toBe(approvals);
    expect(controller!.pendingQuestions).toBe(questions);
  });

  it('reclassifies a permission whose payload changes under the same request id', () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    mountReact(<Probe />);
    expect(controller!.pendingApprovals.map((a) => a.id)).toEqual(['a1']);
    expect(controller!.pendingQuestions).toHaveLength(0);
    harness.pendingPermissions = [permissionBlock('a1', { questions: true })];
    forceRerender!();
    expect(controller!.pendingApprovals).toHaveLength(0);
    expect(controller!.pendingQuestions.map((q) => q.id)).toEqual(['a1']);
  });

  it('keeps the transcript readable under a connection error with a live session', () => {
    harness.connection.error = 'session_writer_conflict';
    mountReact(<Probe />);
    expect(controller!.transcriptState).toBe('ready');
  });

  it('reports loading while the transcript loads', () => {
    harness.connection.loadingTranscript = true;
    mountReact(<Probe />);
    expect(controller!.transcriptState).toBe('loading');
  });

  it('forwards images and files to the submit action', async () => {
    mountReact(<Probe />);
    const images: PromptImage[] = [{ data: 'aW1n', media_type: 'image/png' }];
    const files: PromptFile[] = [{ name: 'a.ts', media_type: 'text/plain' }];
    await controller!.submit({
      text: 'hi',
      images,
      files,
    });
    expect(harness.submitPrompt).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ images, files }),
    );
  });

  it('establishes a cancel only when the turn ends cancelled', async () => {
    mountReact(<Probe />);
    await controller!.submit({ text: 'hi' });
    const result = await controller!.cancel();
    expect(result.admission).toBe('accepted');
    expect(controller!.phase).toBe('cancelling');
    act(() => {
      harness.promptSettledListener!({ promptId: 'p1', outcome: 'cancelled' });
    });
    expect(
      controller!.operations.find((op) => op.kind === 'cancel')?.state,
    ).toBe('established');
    expect(controller!.phase).toBe('idle');
  });

  it('fails a cancel when the turn completes on its own', async () => {
    mountReact(<Probe />);
    await controller!.submit({ text: 'hi' });
    await controller!.cancel();
    act(() => {
      harness.promptSettledListener!({ promptId: 'p1', outcome: 'completed' });
    });
    expect(
      controller!.operations.find((op) => op.kind === 'cancel')?.state,
    ).toBe('failed');
    expect(
      controller!.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('established');
  });

  it('settles a cancel with no live turn as failed', async () => {
    mountReact(<Probe />);
    const result = await controller!.cancel();
    expect(result.admission).toBe('accepted');
    expect(
      controller!.operations.find((op) => op.kind === 'cancel')?.state,
    ).toBe('failed');
    expect(controller!.phase).toBe('idle');
  });

  it('reports an unknown cancel admission when the cancel transport throws', async () => {
    harness.cancel.mockRejectedValue(new Error('network'));
    mountReact(<Probe />);
    const result = await controller!.cancel();
    expect(result.admission).toBe('unknown');
  });

  it('establishes an answered question when its permission leaves the pending set', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
    expect(result.admission).toBe('accepted');
    expect(
      controller!.operations.find((op) => op.kind === 'question')?.state,
    ).toBe('unsettled');
    harness.pendingPermissions = [];
    forceRerender!();
    expect(
      controller!.operations.find((op) => op.kind === 'question')?.state,
    ).toBe('established');
  });

  it('reports a rejected question admission when the vote is not applied', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    harness.submitPermission.mockResolvedValue(false);
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
    expect(result.admission).toBe('rejected');
  });

  it('reports an unknown question admission when the vote throws', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    harness.submitPermission.mockRejectedValue(new Error('network'));
    mountReact(<Probe />);
    const result = await controller!.respondQuestion('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
    expect(result.admission).toBe('unknown');
  });

  it('establishes an approval applied while its vote is still in flight', async () => {
    harness.pendingPermissions = [permissionBlock('a1')];
    let resolveVote: ((applied: boolean) => void) | undefined;
    harness.submitPermission.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveVote = resolve;
        }),
    );
    mountReact(<Probe />);
    let result:
      | ReturnType<SessionChatController['respondApproval']>
      | undefined;
    await act(async () => {
      result = controller!.respondApproval('a1', 'submit');
      await Promise.resolve();
    });
    // The daemon applies the permission and drops it before the POST resolves;
    // the answer must already be tracked so this reads as a decision, not a
    // supersession.
    harness.pendingPermissions = [];
    forceRerender!();
    await act(async () => {
      resolveVote!(true);
      await result;
    });
    expect((await result)!.admission).toBe('accepted');
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');
  });

  it('establishes a question applied while its vote is still in flight', async () => {
    harness.pendingPermissions = [permissionBlock('q1', { questions: true })];
    let resolveVote: ((applied: boolean) => void) | undefined;
    harness.submitPermission.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveVote = resolve;
        }),
    );
    mountReact(<Probe />);
    let result:
      | ReturnType<SessionChatController['respondQuestion']>
      | undefined;
    await act(async () => {
      result = controller!.respondQuestion('q1', [
        { questionId: '0', value: 'Alice' },
      ]);
      await Promise.resolve();
    });
    harness.pendingPermissions = [];
    forceRerender!();
    await act(async () => {
      resolveVote!(true);
      await result;
    });
    expect((await result)!.admission).toBe('accepted');
    expect(
      controller!.operations.find((op) => op.kind === 'question')?.state,
    ).toBe('established');
  });
});
