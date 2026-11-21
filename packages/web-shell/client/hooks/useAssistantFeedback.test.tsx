// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellAssistantFeedbackRating } from '../customization';
import { AssistantMessage } from '../components/messages/AssistantMessage';
import { I18nProvider } from '../i18n';
import {
  ASSISTANT_FEEDBACK_STORAGE_KEY,
  MAX_ASSISTANT_FEEDBACK_SESSIONS,
  readAssistantFeedbackStore,
  writeAssistantFeedbackStore,
  type AssistantFeedbackStore,
} from '../utils/assistantFeedback';
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
  turnId = TURN_ID,
  onHostRate,
}: {
  sessionId: string;
  turnId?: string;
  onHostRate?: (call: HostCall) => void;
}) {
  const { ratings, rate, ratingForTurn } = useAssistantFeedback(sessionId);
  return (
    <AssistantMessage
      content="answer"
      showFooterActions
      showAssistantFeedback
      assistantFeedbackRating={ratings[turnId]}
      onAssistantFeedbackRate={(rating) => {
        const previousRating = ratingForTurn(turnId);
        rate(turnId, rating);
        onHostRate?.({ rating, previousRating });
      }}
    />
  );
}

function mount(
  sessionId = 'session-1',
  onHostRate?: (call: HostCall) => void,
  turnId = TURN_ID,
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <Transcript
          sessionId={sessionId}
          turnId={turnId}
          onHostRate={onHostRate}
        />
      </I18nProvider>,
    );
  });
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

function mountPair(firstSession: string, secondSession: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <section data-pane="first">
          <Transcript sessionId={firstSession} turnId="turn-a" />
        </section>
        <section data-pane="second">
          <Transcript sessionId={secondSession} turnId="turn-b" />
        </section>
      </I18nProvider>,
    );
  });
}

function rateInPane(pane: 'first' | 'second', label: string): void {
  const control = container.querySelector<HTMLButtonElement>(
    `[data-pane="${pane}"] button[aria-label="${label}"]`,
  );
  expect(control).not.toBeNull();
  act(() => control!.click());
}

const button = (title: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`);
const isLit = (title: string) =>
  button(title)?.getAttribute('aria-pressed') === 'true';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('preserves both sessions when two mounted transcripts save feedback', () => {
    mountPair('session-a', 'session-b');
    try {
      rateInPane('first', 'Satisfied');
      rateInPane('second', 'Not satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'session-a': { 'turn-a': 'up' },
        'session-b': { 'turn-b': 'down' },
      });
    } finally {
      unmount();
    }
  });

  it('preserves distinct turns rated by two views of the same session', () => {
    mountPair('shared-session', 'shared-session');
    try {
      rateInPane('first', 'Satisfied');
      rateInPane('second', 'Not satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'shared-session': { 'turn-a': 'up', 'turn-b': 'down' },
      });
    } finally {
      unmount();
    }
  });

  it('does not restore a cleared rating when another mounted transcript saves', () => {
    writeAssistantFeedbackStore({
      'session-a': { 'turn-a': 'up' },
      'session-b': { 'turn-b': 'down' },
    });
    mountPair('session-a', 'session-b');
    try {
      rateInPane('first', 'Satisfied');
      rateInPane('second', 'Satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'session-b': { 'turn-b': 'up' },
      });
    } finally {
      unmount();
    }
  });

  it("retries local edits after storage becomes writable without losing another pane's changes", () => {
    mountPair('session-a', 'session-b');
    try {
      const write = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('quota exceeded');
        });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      rateInPane('first', 'Satisfied');
      expect(write).toHaveBeenCalledOnce();
      rateInPane('second', 'Not satisfied');

      act(() => {
        root.render(
          <I18nProvider language="en">
            <section data-pane="first">
              <Transcript sessionId="session-a" turnId="turn-c" />
            </section>
            <section data-pane="second">
              <Transcript sessionId="session-b" turnId="turn-b" />
            </section>
          </I18nProvider>,
        );
      });
      rateInPane('first', 'Not satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'session-a': { 'turn-a': 'up', 'turn-c': 'down' },
        'session-b': { 'turn-b': 'down' },
      });
    } finally {
      unmount();
    }
  });

  it("keeps a mounted pane's earlier marks after storage ages its session out", () => {
    const stored: AssistantFeedbackStore = {};
    for (let index = 0; index < MAX_ASSISTANT_FEEDBACK_SESSIONS; index++) {
      stored[`session-${index}`] = { 'turn-1': 'up' };
    }
    stored['session-0'] = {
      'turn-1': 'up',
      'turn-2': 'up',
      'turn-3': 'up',
    };
    writeAssistantFeedbackStore(stored);
    mount('session-0', undefined, 'turn-4');
    try {
      writeAssistantFeedbackStore({
        ...stored,
        'session-10': { 'turn-1': 'up' },
        'session-11': { 'turn-1': 'up' },
      });
      expect(readAssistantFeedbackStore()['session-0']).toBeUndefined();

      act(() => button('Satisfied')?.click());

      const persisted = readAssistantFeedbackStore();
      expect(persisted['session-0']).toEqual({
        'turn-1': 'up',
        'turn-2': 'up',
        'turn-3': 'up',
        'turn-4': 'up',
      });
      expect(Object.keys(persisted)).toHaveLength(
        MAX_ASSISTANT_FEEDBACK_SESSIONS,
      );
    } finally {
      unmount();
    }
  });
});
