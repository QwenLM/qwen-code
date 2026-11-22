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
import * as assistantFeedback from '../utils/assistantFeedback';
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

function renderPairTurns(firstTurn: string, secondTurn: string): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <section data-pane="first">
          <Transcript sessionId="shared-session" turnId={firstTurn} />
        </section>
        <section data-pane="second">
          <Transcript sessionId="shared-session" turnId={secondTurn} />
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
const isLitInPane = (pane: 'first' | 'second', title: string) =>
  container
    .querySelector(`[data-pane="${pane}"] button[aria-label="${title}"]`)
    ?.getAttribute('aria-pressed') === 'true';

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

  it('does not restore the last cleared rating in a shared session', () => {
    writeAssistantFeedbackStore({
      'shared-session': { 'turn-a': 'up' },
    });
    mountPair('shared-session', 'shared-session');
    try {
      rateInPane('first', 'Satisfied');
      rateInPane('second', 'Not satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'shared-session': { 'turn-b': 'down' },
      });
    } finally {
      unmount();
    }
  });

  it('does not restore a clear after the session was pruned and refilled', () => {
    const stored: AssistantFeedbackStore = {
      'shared-session': { 'turn-a': 'up' },
    };
    for (let index = 0; index < MAX_ASSISTANT_FEEDBACK_SESSIONS - 1; index++) {
      stored[`session-${index}`] = { 'turn-1': 'up' };
    }
    writeAssistantFeedbackStore(stored);
    mountPair('shared-session', 'shared-session');
    try {
      writeAssistantFeedbackStore({
        ...stored,
        [`session-${MAX_ASSISTANT_FEEDBACK_SESSIONS - 1}`]: { 'turn-1': 'up' },
      });
      expect(readAssistantFeedbackStore()['shared-session']).toBeUndefined();
      rateInPane('first', 'Satisfied');
      writeAssistantFeedbackStore({
        ...readAssistantFeedbackStore(),
        'session-third': { 'turn-c': 'up' },
      });
      expect(Object.keys(readAssistantFeedbackStore())).toHaveLength(
        MAX_ASSISTANT_FEEDBACK_SESSIONS,
      );

      rateInPane('second', 'Not satisfied');

      expect(readAssistantFeedbackStore()['shared-session']).toEqual({
        'turn-b': 'down',
      });
    } finally {
      unmount();
    }
  });

  it('does not overwrite a newer rating with a queued retry', () => {
    mountPair('shared-session', 'shared-session');
    try {
      vi.spyOn(
        assistantFeedback,
        'writeAssistantFeedbackStore',
      ).mockReturnValueOnce(false);
      rateInPane('first', 'Satisfied');
      expect(isLitInPane('first', 'Satisfied')).toBe(true);
      act(() => {
        root.render(
          <I18nProvider language="en">
            <section data-pane="first">
              <Transcript sessionId="shared-session" turnId="turn-a" />
            </section>
            <section data-pane="second">
              <Transcript sessionId="shared-session" turnId="turn-a" />
            </section>
          </I18nProvider>,
        );
      });
      rateInPane('second', 'Not satisfied');
      expect(readAssistantFeedbackStore()).toEqual({
        'shared-session': { 'turn-a': 'down' },
      });

      act(() => {
        root.render(
          <I18nProvider language="en">
            <section data-pane="first">
              <Transcript sessionId="shared-session" turnId="turn-c" />
            </section>
            <section data-pane="second">
              <Transcript sessionId="shared-session" turnId="turn-b" />
            </section>
          </I18nProvider>,
        );
      });
      rateInPane('first', 'Satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'shared-session': { 'turn-a': 'down', 'turn-c': 'up' },
      });
    } finally {
      unmount();
    }
  });

  it('does not restore a pruned rating when clearing it fails to write', () => {
    const stored: AssistantFeedbackStore = {
      'shared-session': { 'turn-a': 'up' },
    };
    for (let index = 0; index < MAX_ASSISTANT_FEEDBACK_SESSIONS - 1; index++) {
      stored[`session-${index}`] = { 'turn-1': 'up' };
    }
    writeAssistantFeedbackStore(stored);
    mountPair('shared-session', 'shared-session');
    try {
      writeAssistantFeedbackStore({
        ...stored,
        'session-10': { 'turn-1': 'up' },
      });
      const write = vi
        .spyOn(assistantFeedback, 'writeAssistantFeedbackStore')
        .mockReturnValueOnce(false);
      rateInPane('first', 'Satisfied');
      expect(write).toHaveBeenCalledOnce();

      rateInPane('second', 'Not satisfied');

      expect(readAssistantFeedbackStore()['shared-session']).toEqual({
        'turn-b': 'down',
      });
    } finally {
      unmount();
    }
  });

  it('keeps a failed clear cleared when another pane restores the session', () => {
    const stored: AssistantFeedbackStore = {
      'shared-session': { 'turn-a': 'up', 'turn-b': 'down' },
    };
    for (let index = 0; index < MAX_ASSISTANT_FEEDBACK_SESSIONS - 1; index++) {
      stored[`session-${index}`] = { 'turn-1': 'up' };
    }
    writeAssistantFeedbackStore(stored);
    mountPair('shared-session', 'shared-session');
    try {
      writeAssistantFeedbackStore({
        ...stored,
        'session-10': { 'turn-1': 'up' },
      });
      expect(readAssistantFeedbackStore()['shared-session']).toBeUndefined();
      // A real storage failure, so the write path's own snapshot bookkeeping
      // runs — mocking the write function would skip exactly that code.
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('quota exceeded');
        });
      rateInPane('first', 'Satisfied');
      expect(setItem).toHaveBeenCalledOnce();

      renderPairTurns('turn-a', 'turn-c');
      rateInPane('second', 'Satisfied');
      renderPairTurns('turn-d', 'turn-c');
      rateInPane('first', 'Not satisfied');

      expect(readAssistantFeedbackStore()['shared-session']).toEqual({
        'turn-b': 'down',
        'turn-c': 'up',
        'turn-d': 'down',
      });
    } finally {
      unmount();
    }
  });

  it('replays a queued edit over its pruned base', () => {
    writeAssistantFeedbackStore({
      'shared-session': { 'turn-a': 'up' },
    });
    mountPair('shared-session', 'shared-session');
    try {
      const write = vi
        .spyOn(assistantFeedback, 'writeAssistantFeedbackStore')
        .mockReturnValueOnce(false);
      rateInPane('first', 'Not satisfied');
      expect(write).toHaveBeenCalledOnce();
      const evicting: AssistantFeedbackStore = {
        ...readAssistantFeedbackStore(),
      };
      for (let index = 0; index < MAX_ASSISTANT_FEEDBACK_SESSIONS; index++) {
        evicting[`session-${index}`] = { 'turn-1': 'up' };
      }
      writeAssistantFeedbackStore(evicting);
      renderPairTurns('turn-c', 'turn-b');

      rateInPane('first', 'Satisfied');

      expect(readAssistantFeedbackStore()['shared-session']).toEqual({
        'turn-a': 'down',
        'turn-c': 'up',
      });
    } finally {
      unmount();
    }
  });

  it('retires a queued edit superseded by a rating round trip', () => {
    mountPair('shared-session', 'shared-session');
    try {
      const write = vi
        .spyOn(assistantFeedback, 'writeAssistantFeedbackStore')
        .mockReturnValueOnce(false);
      rateInPane('first', 'Satisfied');
      expect(write).toHaveBeenCalledOnce();
      renderPairTurns('turn-a', 'turn-a');
      rateInPane('second', 'Satisfied');
      rateInPane('second', 'Satisfied');
      expect(readAssistantFeedbackStore()).toEqual({});
      renderPairTurns('turn-c', 'turn-b');

      rateInPane('first', 'Satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'shared-session': { 'turn-c': 'up' },
      });
    } finally {
      unmount();
    }
  });

  it("retries local edits after storage becomes writable without losing another pane's changes", () => {
    mountPair('session-a', 'session-a');
    try {
      const write = vi
        .spyOn(assistantFeedback, 'writeAssistantFeedbackStore')
        .mockReturnValueOnce(false);
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
              <Transcript sessionId="session-a" turnId="turn-b" />
            </section>
          </I18nProvider>,
        );
      });
      rateInPane('first', 'Not satisfied');

      expect(readAssistantFeedbackStore()).toEqual({
        'session-a': {
          'turn-a': 'up',
          'turn-b': 'down',
          'turn-c': 'down',
        },
      });
    } finally {
      unmount();
    }
  });

  it('adopts the persisted store after a successful write', () => {
    writeAssistantFeedbackStore({ 'session-0': { 'turn-a': 'up' } });
    mount('session-0', undefined, 'turn-a');
    try {
      expect(isLit('Satisfied')).toBe(true);
      writeAssistantFeedbackStore({});
      act(() => {
        root.render(
          <I18nProvider language="en">
            <Transcript sessionId="session-0" turnId="turn-b" />
          </I18nProvider>,
        );
      });
      act(() => button('Not satisfied')?.click());
      act(() => {
        root.render(
          <I18nProvider language="en">
            <Transcript sessionId="session-0" turnId="turn-a" />
          </I18nProvider>,
        );
      });

      expect(isLit('Satisfied')).toBe(false);
      expect(readAssistantFeedbackStore()).toEqual({
        'session-0': { 'turn-b': 'down' },
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

  it('restores the ratings that were actually evicted, not a mount snapshot', () => {
    const stored: AssistantFeedbackStore = {
      'session-0': { 'turn-1': 'up', 'turn-2': 'up' },
    };
    for (let index = 1; index < MAX_ASSISTANT_FEEDBACK_SESSIONS; index++) {
      stored[`session-${index}`] = { 'turn-1': 'up' };
    }
    writeAssistantFeedbackStore(stored);
    mount('session-0', undefined, 'turn-4');
    try {
      writeAssistantFeedbackStore({
        ...stored,
        'session-0': { 'turn-1': 'down', 'turn-3': 'up' },
        'session-10': { 'turn-1': 'up' },
      });
      expect(readAssistantFeedbackStore()['session-0']).toBeUndefined();

      act(() => button('Satisfied')?.click());

      expect(readAssistantFeedbackStore()['session-0']).toEqual({
        'turn-1': 'down',
        'turn-3': 'up',
        'turn-4': 'up',
      });
    } finally {
      unmount();
    }
  });
});
