// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellAssistantFeedbackRating } from '../customization';
import { AssistantMessage } from '../components/messages/AssistantMessage';
import { I18nProvider } from '../i18n';
import { ASSISTANT_FEEDBACK_STORAGE_KEY } from '../utils/assistantFeedback';
import { useAssistantFeedback } from './useAssistantFeedback';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TURN_ID = 'turn-1';

let root: Root;
let container: HTMLDivElement;

interface HostCall {
  rating: WebShellAssistantFeedbackRating | null;
  previousRating?: WebShellAssistantFeedbackRating;
}

/**
 * Mirrors the wiring in MessageList + MessageItem: the hook owns the mark, the
 * message reports the click, and the host is told afterwards.
 */
function Transcript({
  sessionId,
  onHostRate,
}: {
  sessionId: string;
  onHostRate?: (call: HostCall) => void;
}) {
  const { ratings, rate, ratingForTurn } = useAssistantFeedback(sessionId);
  return (
    <AssistantMessage
      content="answer"
      showFooterActions
      showAssistantFeedback
      assistantFeedbackRating={ratings[TURN_ID]}
      onAssistantFeedbackRate={(rating) => {
        const previousRating = ratingForTurn(TURN_ID);
        rate(TURN_ID, rating);
        onHostRate?.({ rating, previousRating });
      }}
    />
  );
}

function mount(
  sessionId = 'session-1',
  onHostRate?: (call: HostCall) => void,
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <Transcript sessionId={sessionId} onHostRate={onHostRate} />
      </I18nProvider>,
    );
  });
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

const button = (title: string) =>
  container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
const isLit = (title: string) =>
  button(title)?.getAttribute('aria-pressed') === 'true';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useAssistantFeedback through the answer footer', () => {
  it('marks the answer immediately, without a host handler', () => {
    mount();
    act(() => button('Satisfied')?.click());
    expect(isLit('Satisfied')).toBe(true);
    expect(isLit('Not satisfied')).toBe(false);
    unmount();
  });

  it('tells the host, and switches without clearing first', () => {
    const calls: HostCall[] = [];
    mount('session-1', (call) => calls.push(call));
    act(() => button('Satisfied')?.click());
    expect(calls).toEqual([{ rating: 'up', previousRating: undefined }]);
    act(() => button('Not satisfied')?.click());
    expect(calls).toEqual([
      { rating: 'up', previousRating: undefined },
      { rating: 'down', previousRating: 'up' },
    ]);
    expect(isLit('Not satisfied')).toBe(true);
    unmount();
  });

  it('clears the mark when the lit icon is clicked again', () => {
    const calls: HostCall[] = [];
    mount('session-1', (call) => calls.push(call));
    act(() => button('Satisfied')?.click());
    act(() => button('Satisfied')?.click());
    expect(isLit('Satisfied')).toBe(false);
    expect(calls[1]).toEqual({ rating: null, previousRating: 'up' });
    expect(
      window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY),
    ).not.toContain(TURN_ID);
    unmount();
  });

  it('restores the mark after a reload', () => {
    mount();
    act(() => button('Not satisfied')?.click());
    unmount();

    mount();
    expect(isLit('Not satisfied')).toBe(true);
    unmount();
  });

  it('keeps marks per session', () => {
    mount('session-1');
    act(() => button('Satisfied')?.click());
    unmount();

    mount('session-2');
    expect(isLit('Satisfied')).toBe(false);
    unmount();
  });
});
