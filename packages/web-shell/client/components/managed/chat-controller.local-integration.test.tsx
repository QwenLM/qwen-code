// @vitest-environment jsdom

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { I18nProvider } from '../../i18n';
import { regionsToCapabilities } from '../../chat-core/capabilities';
import { ChatSurface } from '../../chat-core/ChatSurface';
import { cleanupReact, flushReact, mountReact } from '../../test/reactHarness';
import { createManagedChatController } from './chat-controller';
import type {
  ManagedAgentPendingAction,
  ManagedAgentQuestionAnswer,
} from './managed-agent-provider';

afterEach(cleanupReact);

it('renders real messages without DaemonSessionProvider and submits exact managed option ids and text through the real surface', async () => {
  let submitted: readonly ManagedAgentQuestionAnswer[] | undefined;
  const submitQuestion = vi.fn(
    async (_id: string, answers: readonly ManagedAgentQuestionAnswer[]) => {
      submitted = answers;
      return { admission: 'accepted' as const };
    },
  );
  const onError = vi.fn();
  const pendingAction: ManagedAgentPendingAction = {
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
  };
  const controller = createManagedChatController({
    sessionId: 'managed-live-fixture',
    storageKey: 'managed-live-fixture',
    sessionPhase: 'created',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'Real Managed transcript line',
        timestamp: 1,
      },
    ],
    transcriptState: 'ready',
    pendingActions: [pendingAction],
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    submitPrompt: vi.fn(async () => ({ admission: 'rejected' as const })),
    cancelTurn: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitApproval: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitQuestion,
  });
  let parentRenders = 0;
  let rerenderParent!: () => void;
  function Host() {
    parentRenders += 1;
    const [, setGeneration] = useState(0);
    rerenderParent = () => setGeneration((generation) => generation + 1);
    return (
      <I18nProvider language="en">
        <ChatSurface controller={controller} onError={onError} />
      </I18nProvider>
    );
  }
  const container = mountReact(<Host />);
  // Real TranscriptViewport renders live MessageList with no DaemonSessionProvider.
  expect(
    container.querySelector('[data-history-viewport="live"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-web-shell-message-list]'),
  ).not.toBeNull();
  const question = container.querySelector('[data-testid="question-overlay"]');
  expect(question).not.toBeNull();
  // Managed questions carry no dismiss wire variant, so no dead Ignore button.
  expect(
    Array.from(question!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Ignore',
    ),
  ).toBeUndefined();
  const next = Array.from(question!.querySelectorAll('button')).at(-2)!;
  act(() => next.click());
  const options = question!.querySelectorAll<HTMLButtonElement>(
    '[data-web-shell-ask-option]',
  );
  act(() => options[0]!.click());
  expect(options[0]!.getAttribute('aria-pressed')).toBe('true');
  const previousRenderCount = parentRenders;
  act(() => rerenderParent());
  expect(parentRenders).toBeGreaterThan(previousRenderCount);
  expect(options[0]!.getAttribute('aria-pressed')).toBe('true');
  act(() => options[2]!.click());
  const input = question!.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(input, 'Verbose\nline 2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    pendingAction.expiresAt += 60_000;
    rerenderParent();
  });
  expect(parentRenders).toBeGreaterThan(previousRenderCount);
  expect(options[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(input.value).toBe('Verbose\nline 2');
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
    { questionId: 'notes', optionIds: ['dry'], text: 'Verbose\nline 2' },
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it('handles optional, allowText: false, and text-only managed questions end-to-end through real ChatSurface', async () => {
  let submitted: readonly ManagedAgentQuestionAnswer[] | undefined;
  const submitQuestion = vi.fn(
    async (_id: string, answers: readonly ManagedAgentQuestionAnswer[]) => {
      submitted = answers;
      return { admission: 'accepted' as const };
    },
  );
  const onError = vi.fn();
  const pendingAction: ManagedAgentPendingAction = {
    actionId: 'question-managed-parity',
    sessionId: 'managed-parity',
    turnId: 'turn-1',
    functionCallId: 'call-1',
    toolName: 'ask_user_question',
    kind: 'question',
    inputRevision: 1,
    policyRevision: 'policy-1',
    expiresAt: Date.now() + 60_000,
    questions: [
      {
        id: 'strict',
        prompt: 'Strict duplicate labels?',
        required: true,
        multiple: false,
        allowText: false,
        options: [
          { id: 'opt-1', label: 'Dry run' },
          { id: 'opt-2', label: 'Dry run' },
        ],
      },
      {
        id: 'optional',
        prompt: 'Optional preference?',
        required: false,
        multiple: false,
        allowText: true,
        options: [{ id: 'fast', label: 'Fast' }],
      },
      {
        id: 'note',
        prompt: 'Required note?',
        required: true,
        multiple: false,
        allowText: true,
        options: [],
      },
    ],
  };
  const controller = createManagedChatController({
    sessionId: 'managed-parity',
    storageKey: 'managed-parity',
    sessionPhase: 'created',
    messages: [],
    transcriptState: 'ready',
    pendingActions: [pendingAction],
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
  const question = container.querySelector('[data-testid="question-overlay"]')!;
  // Q1: allowText: false -> exactly 2 option buttons, no custom row.
  const q1Options = question.querySelectorAll<HTMLButtonElement>(
    '[data-web-shell-ask-option]',
  );
  expect(q1Options).toHaveLength(2);
  act(() => q1Options[1]!.click());

  const nextButton = () =>
    Array.from(question.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'next',
    )!;
  // Q2: optional -> NOT pre-selected, skip it untouched.
  act(() => nextButton().click());
  const q2Options = question.querySelectorAll<HTMLButtonElement>(
    '[data-web-shell-ask-option]',
  );
  expect(q2Options[0]!.getAttribute('aria-checked')).toBe('false');

  // Q3: text-only -> single custom trigger, maxLength=8192.
  act(() => nextButton().click());
  const q3Options = question.querySelectorAll<HTMLButtonElement>(
    '[data-web-shell-ask-option]',
  );
  expect(q3Options).toHaveLength(1);
  act(() => q3Options[0]!.click());
  const input = question.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(input.maxLength).toBe(8192);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(input, 'Required explanation');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = question.querySelector<HTMLButtonElement>(
    '[aria-keyshortcuts="Control+Enter Meta+Enter"]',
  )!;
  expect(submit.disabled).toBe(false);
  act(() => submit.click());
  await flushReact();
  expect(submitQuestion).toHaveBeenCalledTimes(1);
  expect(submitted).toEqual([
    { questionId: 'strict', optionIds: ['opt-2'] },
    { questionId: 'note', text: 'Required explanation' },
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it('degrades to the live transcript even when sessionViewportEnabled is set outside DaemonSessionProvider', () => {
  const controller = createManagedChatController({
    sessionId: 'managed-standalone-opt-in',
    storageKey: 'managed-standalone-opt-in',
    sessionPhase: 'created',
    messages: [
      {
        id: 'msg-standalone',
        role: 'assistant',
        content: 'Standalone transcript line',
        timestamp: 1,
      },
    ],
    transcriptState: 'ready',
    pendingActions: [],
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    submitPrompt: vi.fn(async () => ({ admission: 'rejected' as const })),
    cancelTurn: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitApproval: vi.fn(async () => ({ admission: 'rejected' as const })),
    submitQuestion: vi.fn(async () => ({ admission: 'rejected' as const })),
  });
  const container = mountReact(
    <I18nProvider language="en">
      <ChatSurface controller={controller} sessionViewportEnabled />
    </I18nProvider>,
  );
  expect(
    container.querySelector('[data-history-viewport="live"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-web-shell-message-list]'),
  ).not.toBeNull();
});
