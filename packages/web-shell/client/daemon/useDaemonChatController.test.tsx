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
  history: {
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: false,
  },
  surfaceEditor: null as Record<string, unknown> | null,
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
  useDaemonTranscriptHistory: () => harness.history,
  useDaemonPromptSettled: (listener: unknown) => {
    harness.promptSettledListener = listener as (event: unknown) => void;
  },
  useOptionalDaemonPromptSettled: (listener: unknown) => {
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
vi.mock('../components/TranscriptViewport.js', () => ({
  TranscriptViewport: () => null,
}));
vi.mock('../components/messages/ToolApproval.js', () => ({
  ToolApproval: () => null,
}));
vi.mock('../components/messages/AskUserQuestion.js', () => ({
  AskUserQuestion: () => null,
}));
vi.mock('../components/ChatEditor.js', () => ({
  ChatEditor: (props: Record<string, unknown>) => {
    harness.surfaceEditor = props;
    return null;
  },
}));

import { ChatSurface } from '../chat-core/ChatSurface.js';
import {
  useDaemonChatController,
  useDaemonChatControllerFromState,
  type DaemonChatControllerFromStateOptions,
} from './useDaemonChatController.js';
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
  harness.history.loadMore.mockClear();
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

  it('binds loadOlder to the transcript history loader and forwards retry options', async () => {
    mountReact(<Probe />);
    // Dropping the loadOlder binding leaves the capability undefined, so the
    // surface would silently lose older-history pagination; dropping the
    // options parameter loses { force: true } on pagination-error retries;
    // dropping the per-render ref update pins the mount-time history handle.
    expect(controller!.loadOlder).toBeDefined();
    await controller!.loadOlder!();
    expect(harness.history.loadMore).toHaveBeenCalledTimes(1);
    expect(harness.history.loadMore).toHaveBeenLastCalledWith(undefined);
    const originalHistory = harness.history;
    const nextLoadMore = vi.fn(async () => {});
    harness.history = { ...originalHistory, loadMore: nextLoadMore };
    try {
      forceRerender!();
      await controller!.loadOlder!({ force: true });
      expect(originalHistory.loadMore).toHaveBeenCalledTimes(1);
      expect(nextLoadMore).toHaveBeenCalledTimes(1);
      expect(nextLoadMore).toHaveBeenLastCalledWith({ force: true });
    } finally {
      harness.history = originalHistory;
    }
  });

  it('projects reactive transcript history pagination facts through the session-stable controller', () => {
    mountReact(<Probe />);
    const initialController = controller!;
    expect([
      initialController.hasOlderHistory,
      initialController.loadingOlderHistory,
      initialController.historyCapacityReached,
      initialController.historyPaginationError,
    ]).toEqual([false, false, false, false]);
    const originalHistory = harness.history;
    const cases: Array<{
      wire: 'hasMore' | 'loading' | 'capacityReached' | 'paginationError';
      expected: [boolean, boolean, boolean, boolean];
    }> = [
      { wire: 'hasMore', expected: [true, false, false, false] },
      { wire: 'loading', expected: [false, true, false, false] },
      { wire: 'capacityReached', expected: [false, false, true, false] },
      { wire: 'paginationError', expected: [false, false, false, true] },
    ];
    try {
      for (const { wire, expected } of cases) {
        harness.history = {
          ...originalHistory,
          hasMore: false,
          loading: false,
          capacityReached: false,
          paginationError: false,
          [wire]: true,
        };
        forceRerender!();
        expect(controller).toBe(initialController);
        expect([
          controller!.hasOlderHistory,
          controller!.loadingOlderHistory,
          controller!.historyCapacityReached,
          controller!.historyPaginationError,
        ]).toEqual(expected);
      }
    } finally {
      harness.history = originalHistory;
    }
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

  it('tracks activeTurnId across admitted prompts and prompt settlements', async () => {
    mountReact(<Probe />);
    expect(controller!.activeTurnId).toBeUndefined();
    harness.submitPrompt.mockResolvedValueOnce({ promptId: 'p1' });
    await controller!.submit({ text: 'turn 1' });
    expect(controller!.activeTurnId).toBe('p1');
    harness.submitPrompt.mockResolvedValueOnce({ promptId: 'p2' });
    await controller!.submit({ text: 'turn 2' });
    expect(controller!.activeTurnId).toBe('p1');
    harness.cancel.mockRejectedValueOnce(new Error('cancel timeout'));
    const cancelRes = await controller!.cancel();
    expect(cancelRes.admission).toBe('unknown');
    expect(cancelRes.target.turnId).toBe('p1');
    harness.promptSettledListener?.({ promptId: 'p1', outcome: 'completed' });
    expect(controller!.activeTurnId).toBe('p2');
    harness.promptSettledListener?.({ promptId: 'p2', outcome: 'completed' });
    expect(controller!.activeTurnId).toBeUndefined();
  });

  it('preserves activeTurnId across a session switch round-trip and clears it when settled away (R2-1)', async () => {
    mountReact(<Probe />);
    const first = controller!;
    harness.submitPrompt.mockResolvedValueOnce({ promptId: 'p1' });
    await first.submit({ text: 'turn 1' });
    expect(first.activeTurnId).toBe('p1');
    // Switch s1 -> s2 -> s1: each switch rebuilds the controller, yet the
    // returned s1 controller must still report p1 as its active turn.
    harness.connection.sessionId = 's2';
    forceRerender!();
    const second = controller!;
    expect(second).not.toBe(first);
    expect(second.activeTurnId).toBeUndefined();
    harness.connection.sessionId = 's1';
    forceRerender!();
    const third = controller!;
    expect(third).not.toBe(first);
    expect(third.activeTurnId).toBe('p1');
    // If p1 settles while viewing s2, returning to s1 must report undefined.
    harness.connection.sessionId = 's2';
    forceRerender!();
    harness.promptSettledListener?.({
      sessionId: 's1',
      promptId: 'p1',
      outcome: 'completed',
    });
    harness.connection.sessionId = 's1';
    forceRerender!();
    expect(controller!.activeTurnId).toBeUndefined();
  });

  it('reports a delayed stop failure after a real s1 -> s2 -> s1 controller rebuild round-trip (R2-1 / F1)', async () => {
    const onError = vi.fn();
    let rerenderSurface: (() => void) | undefined;
    function ComposedSurface() {
      const [, bump] = useReducer((x: number) => x + 1, 0);
      rerenderSurface = () => act(() => bump());
      const bound = useDaemonChatController();
      return <ChatSurface controller={bound} onError={onError} />;
    }
    harness.surfaceEditor = null;
    mountReact(<ComposedSurface />);
    harness.submitPrompt.mockResolvedValueOnce({ promptId: 'p1' });
    await act(async () => {
      (
        harness.surfaceEditor?.onSubmit as (
          text: string,
          images?: unknown,
          files?: unknown,
          commitAccepted?: () => void,
        ) => unknown
      )('turn 1', undefined, undefined, vi.fn());
    });
    let rejectCancel!: (err: unknown) => void;
    harness.cancel.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    await act(async () => {
      (harness.surfaceEditor?.onCancel as () => void)();
    });
    // Switch s1 -> s2 -> s1 while p1 is still running on the daemon:
    // useDaemonChatController builds a brand-new controller for s1 on return.
    harness.connection.sessionId = 's2';
    rerenderSurface!();
    harness.connection.sessionId = 's1';
    rerenderSurface!();
    await act(async () => {
      rejectCancel(new Error('stop transport timeout'));
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('chat.stopNotConfirmed');
  });

  it('does not seed a prompt that already settled before submitPrompt resolved', async () => {
    mountReact(<Probe />);
    let resolveSubmit!: (value: { promptId: string }) => void;
    harness.submitPrompt.mockImplementationOnce(
      () =>
        new Promise<{ promptId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const pending = controller!.submit({ text: 'fast turn' });
    // Terminal settlement arrives while the submit POST is still in flight.
    harness.promptSettledListener?.({
      sessionId: 's1',
      promptId: 'p-fast',
      outcome: 'completed',
    });
    resolveSubmit({ promptId: 'p-fast' });
    await pending;
    // Round-trip s1 -> s2 -> s1: p-fast must NOT be seeded into the rebuilt
    // controller (dropping !settledDuringSubmit.has(accepted.promptId) latches
    // p-fast permanently as activeTurnId).
    harness.connection.sessionId = 's2';
    forceRerender!();
    harness.connection.sessionId = 's1';
    forceRerender!();
    expect(controller!.activeTurnId).toBeUndefined();
  });
});

describe('useDaemonChatControllerFromState', () => {
  beforeEach(() => {
    harness.connection = {
      sessionId: 's-shared',
      workspaceCwd: '/w',
      loadingTranscript: false,
      missingSession: false,
      error: undefined,
      capabilities: { features: [] },
    };
    harness.submitPrompt.mockReset();
    harness.cancel.mockReset().mockResolvedValue(undefined);
    harness.submitPermission.mockReset().mockResolvedValue(true);
    harness.respondToPermission.mockReset().mockResolvedValue(true);
    harness.history.loadMore.mockReset().mockResolvedValue(undefined);
    harness.promptSettledListener = undefined;
  });

  afterEach(() => {
    cleanupReact();
  });

  it('binds caller-owned state, routes custom submitPermission + questions + cancel + loadOlder, derives permission settlement, and rejects submit when submitPrompt is omitted', async () => {
    let controller: SessionChatController | undefined;
    let rerender!: () => void;
    let pendingApprovals: DaemonChatControllerFromStateOptions['pendingApprovals'] =
      [
        {
          id: 'perm-1',
          status: 'pending',
          request: {
            id: 'perm-1',
            toolName: 'write_file',
            content: [],
            options: [{ id: 'allow-1', label: 'Allow', kind: 'allow_once' }],
            rawInput: {},
          },
        },
      ];
    let pendingQuestions: DaemonChatControllerFromStateOptions['pendingQuestions'] =
      [];
    let pendingSignature = 'a:perm-1';
    const customSubmitPermission = vi
      .fn<
        NonNullable<DaemonChatControllerFromStateOptions['submitPermission']>
      >()
      .mockResolvedValueOnce('rejected')
      .mockResolvedValueOnce('accepted');

    function SharedProbe() {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      rerender = () => act(() => bump());
      controller = useDaemonChatControllerFromState({
        connection:
          harness.connection as unknown as DaemonChatControllerFromStateOptions['connection'],
        actions: {
          cancel: harness.cancel,
          submitPermission: harness.submitPermission,
          respondToPermission: harness.respondToPermission,
        },
        transcriptHistory: harness.history,
        messages: [],
        pendingApprovals,
        pendingQuestions,
        pendingSignature,
        transcriptState: 'ready',
        statusFacts: { queueLength: 2, goalActive: true },
        submitPermission: customSubmitPermission,
      });
      return null;
    }

    mountReact(<SharedProbe />);
    expect(controller!.sessionId).toBe('s-shared');
    expect(controller!.transcriptState).toBe('ready');
    expect(controller!.statusFacts).toEqual({
      queueLength: 2,
      goalActive: true,
    });

    // Omitting actions.submitPrompt rejects submit() fail-closed.
    const submitRes = await controller!.submit({ text: 'hi' });
    expect(submitRes.admission).toBe('rejected');

    // First custom submitPermission rejects -> clears answered tracking so a
    // retry succeeds and settles as established once perm-1 leaves pending.
    const rejected = await controller!.respondApproval('perm-1', 'allow-1');
    expect(rejected.admission).toBe('rejected');
    expect(customSubmitPermission).toHaveBeenCalledTimes(1);

    const accepted = await controller!.respondApproval('perm-1', 'allow-1');
    expect(accepted.admission).toBe('accepted');
    expect(accepted.outcome).toBe('unsettled');

    pendingApprovals = [];
    pendingSignature = '';
    rerender();
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');

    // Question answers validate decimal indices and forward submitPermission.
    pendingQuestions = [
      {
        id: 'q-1',
        request: {
          id: 'q-1',
          content: [],
          options: [
            { id: 'submit-opt', label: 'Submit', kind: 'allow_once' },
            { id: 'ignore-opt', label: 'Ignore', kind: 'reject_once' },
          ],
          rawInput: {
            questions: [{ question: 'Choose', options: [{ label: 'One' }] }],
          },
        },
      },
    ];
    pendingSignature = 'q:q-1';
    rerender();

    const invalidQ = await controller!.respondQuestion('q-1', [
      { questionId: '9', value: 'One' },
    ]);
    expect(invalidQ.admission).toBe('rejected');
    expect(harness.submitPermission).not.toHaveBeenCalled();

    const validQ = await controller!.respondQuestion('q-1', [
      { questionId: '0', value: 'One' },
    ]);
    expect(validQ.admission).toBe('accepted');
    expect(harness.submitPermission).toHaveBeenCalledWith('q-1', 'submit-opt', {
      '0': 'One',
    });

    // Cancel and loadOlder delegate cleanly to caller-owned actions/history.
    await controller!.cancel();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    await controller!.loadOlder?.({ force: true });
    expect(harness.history.loadMore).toHaveBeenCalledWith({ force: true });
  });

  it('routes ExitPlanMode approval through respondToPermission using pendingApprovals when submitPermission override is omitted', async () => {
    harness.connection.planExecutionMode = 'auto-edit';
    let controller: SessionChatController | undefined;
    const planApprovals: DaemonChatControllerFromStateOptions['pendingApprovals'] =
      [
        {
          id: 'plan-shared',
          status: 'pending',
          request: {
            id: 'plan-shared',
            toolName: 'exit_plan_mode',
            toolKind: 'switch_mode',
            content: [],
            options: [
              { id: 'approve-plan', label: 'Approve', kind: 'allow_once' },
            ],
            rawInput: {},
          },
        },
      ];
    function DefaultPlanProbe() {
      controller = useDaemonChatControllerFromState({
        connection:
          harness.connection as unknown as DaemonChatControllerFromStateOptions['connection'],
        actions: {
          cancel: harness.cancel,
          submitPermission: harness.submitPermission,
          respondToPermission: harness.respondToPermission,
        },
        transcriptHistory: harness.history,
        messages: [],
        pendingApprovals: planApprovals,
        pendingQuestions: [],
        pendingSignature: 'a:plan-shared',
      });
      return null;
    }

    mountReact(<DefaultPlanProbe />);
    const res = await controller!.respondApproval(
      'plan-shared',
      'approve-plan',
    );
    expect(res.admission).toBe('accepted');
    expect(harness.respondToPermission).toHaveBeenCalledWith('plan-shared', {
      outcome: { outcome: 'selected', optionId: 'approve-plan' },
      expectedPlanExecutionMode: 'auto-edit',
    });
    expect(harness.submitPermission).not.toHaveBeenCalled();
  });

  it('re-seeds prevPendingRef across a session switch even when both sessions share the same pendingSignature', async () => {
    let controller: SessionChatController | undefined;
    let rerender!: () => void;
    let pendingApprovals: DaemonChatControllerFromStateOptions['pendingApprovals'] =
      [
        {
          id: 'shared-perm',
          status: 'pending',
          request: {
            id: 'shared-perm',
            toolName: 'write_file',
            content: [],
            options: [{ id: 'allow-1', label: 'Allow', kind: 'allow_once' }],
            rawInput: {},
          },
        },
      ];
    let pendingSignature = 'a:shared-perm';

    function SwitchProbe() {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      rerender = () => act(() => bump());
      controller = useDaemonChatControllerFromState({
        connection:
          harness.connection as unknown as DaemonChatControllerFromStateOptions['connection'],
        actions: {
          cancel: harness.cancel,
          submitPermission: harness.submitPermission,
          respondToPermission: harness.respondToPermission,
        },
        transcriptHistory: harness.history,
        messages: [],
        pendingApprovals,
        pendingQuestions: [],
        pendingSignature,
      });
      return null;
    }

    mountReact(<SwitchProbe />);
    // Switch from s-shared -> s-other while pendingSignature stays 'a:shared-perm'.
    harness.connection = { ...harness.connection, sessionId: 's-other' };
    rerender();

    const accepted = await controller!.respondApproval(
      'shared-perm',
      'allow-1',
    );
    expect(accepted.admission).toBe('accepted');

    pendingApprovals = [];
    pendingSignature = '';
    rerender();
    expect(
      controller!.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');
  });
});
