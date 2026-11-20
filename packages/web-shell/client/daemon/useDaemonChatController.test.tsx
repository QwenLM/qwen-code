// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useReducer } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { SessionChatController } from '../chat-core/contract.js';

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
    const annotations = [{ type: 'file', path: '/w/a.ts' }];
    await controller!.submit({
      text: 'hi',
      metadata: { inputAnnotations: annotations as never },
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
});
