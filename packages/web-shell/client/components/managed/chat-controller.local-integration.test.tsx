// @vitest-environment jsdom

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../ChatEditor.js', () => ({
  ChatEditor: () => null,
}));

import { act } from 'react';
import { I18nProvider } from '../../i18n';
import { regionsToCapabilities } from '../../chat-core/capabilities';
import { ChatSurface } from '../../chat-core/ChatSurface';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';
import { createManagedChatController } from './chat-controller';
import type { ManagedAgentQuestionAnswer } from './managed-agent-provider';

afterEach(cleanupReact);

it('submits exact managed option ids and separately typed text through the real surface', async () => {
  let submitted: readonly ManagedAgentQuestionAnswer[] | undefined;
  const submitQuestion = vi.fn(
    async (_id: string, answers: readonly ManagedAgentQuestionAnswer[]) => {
      submitted = answers;
      return { admission: 'accepted' as const };
    },
  );
  const onError = vi.fn();
  const controller = createManagedChatController({
    sessionId: 'managed-live-fixture',
    storageKey: 'managed-live-fixture',
    sessionPhase: 'created',
    messages: [],
    transcriptState: 'error',
    pendingActions: [
      {
        actionId: 'question-real-surface',
        sessionId: 'managed-live-fixture',
        turnId: 'turn-1',
        functionCallId: 'call-1',
        toolName: 'ask_user_question',
        kind: 'question',
        inputRevision: 1,
        policyRevision: 'policy-1',
        expiresAt: Date.now() + 60_000,
        questions: [
          {
            id: 'env',
            prompt: 'Target environment?',
            required: true,
            multiple: false,
            allowText: true,
            options: [
              { id: 'dev', label: 'Dev' },
              { id: 'prod', label: 'Prod' },
            ],
          },
          {
            id: 'notes',
            prompt: 'Extra flags?',
            required: true,
            multiple: true,
            allowText: true,
            options: [
              { id: 'dry', label: 'Dry run' },
              { id: 'verbose', label: 'Verbose' },
            ],
          },
        ],
      },
    ],
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    submitPrompt: vi.fn(async () => ({ admission: 'rejected' as const })),
    cancelTurn: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitApproval: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitQuestion,
  });
  const container = mountReact(
    <I18nProvider language="en">
      <ChatSurface controller={controller} onError={onError} />
    </I18nProvider>,
  );
  const question = container.querySelector('[data-testid="question-overlay"]');
  expect(question).not.toBeNull();
  const next = Array.from(question!.querySelectorAll('button')).at(-2)!;
  act(() => next.click());
  const options = question!.querySelectorAll<HTMLButtonElement>(
    '[data-web-shell-ask-option]',
  );
  act(() => options[0]!.click());
  act(() => options[2]!.click());
  const input = question!.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, 'Verbose');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = question!.querySelector<HTMLButtonElement>(
    '[aria-keyshortcuts="Control+Enter Meta+Enter"]',
  )!;
  expect(submit.disabled).toBe(false);
  act(() => submit.click());
  await flushReact();
  expect(submitQuestion).toHaveBeenCalledTimes(1);
  expect(
    controller.operations.find((operation) => operation.kind === 'question')
      ?.state,
  ).toBe('pending');
  expect(submitted).toEqual([
    { questionId: 'env', optionIds: ['dev'] },
    { questionId: 'notes', optionIds: ['dry'], text: 'Verbose' },
  ]);
  expect(onError).not.toHaveBeenCalled();
});
