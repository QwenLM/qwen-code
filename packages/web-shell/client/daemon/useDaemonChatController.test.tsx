// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
function Probe() {
  controller = useDaemonChatController();
  return null;
}

function permissionBlock(
  requestId: string,
  opts: { questions?: boolean; allowOnce?: boolean } = {},
): DaemonTranscriptBlock {
  const options = [
    ...(opts.allowOnce === false
      ? []
      : [{ optionId: 'submit', label: 'Submit', raw: { kind: 'allow_once' } }]),
    { optionId: 'cancel', label: 'Cancel', raw: { kind: 'reject_once' } },
  ];
  return {
    id: `perm-${requestId}`,
    kind: 'permission',
    requestId,
    sessionId: 's1',
    title: 'permission',
    resolved: undefined,
    options,
    toolCall: opts.questions
      ? { rawInput: { questions: [{ question: 'Q0?' }, { question: 'Q1?' }] } }
      : { rawInput: {} },
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
  harness.connection.capabilities = { features: [] };
  harness.submitPrompt.mockClear();
  harness.submitPermission.mockClear();
  harness.submitPermission.mockResolvedValue(true);
  harness.blocks = [];
  harness.pendingPermissions = [];
  controller = undefined;
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
});
