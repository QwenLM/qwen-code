/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  BtwSession,
  type BtwRunParams,
  type BtwRunResult,
} from '@qwen-code/qwen-code-core/agents/btw-session.js';
import type { BtwProps, HistoryItemBtw } from '../types.js';
import {
  browseBtwHistory,
  clearBtwHistory,
  copyBtwAnswer,
  dismissBtwView,
  handleBtwViewKey,
  showBtwRequest,
} from './btw-view.js';
import type { Key } from '../contexts/KeypressContext.js';
import { copyToClipboard } from './commandUtils.js';

vi.mock('./commandUtils.js', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) =>
    Object.entries(params ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      key,
    ),
}));

const config = { getSessionId: () => 'session' } as unknown as Config;

function makeUi() {
  const items: Array<HistoryItemBtw | null> = [];
  return {
    items,
    current: (): BtwProps | undefined => items.at(-1)?.btw,
    ui: {
      setBtwItem: (item: HistoryItemBtw | null) => items.push(item),
      btwAbortControllerRef: { current: null as AbortController | null },
    },
  };
}

/** A session whose requests stay pending until the test settles them. */
function makeSession() {
  const pending: Array<{
    params: BtwRunParams;
    resolve: (result: BtwRunResult) => void;
  }> = [];
  const session = new BtwSession(
    config,
    (params) =>
      new Promise<BtwRunResult>((resolve, reject) => {
        pending.push({ params, resolve });
        params.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  return { session, pending };
}

function key(overrides: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...overrides,
  };
}

describe('btw view', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }));
  afterEach(() => {
    dismissBtwView();
    vi.useRealTimers();
  });

  it('follows a request from pending to answered', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');

    showBtwRequest(view.ui, session, id);
    expect(view.current()).toMatchObject({ isPending: true, answer: '' });

    await pending[0].params.onText('because');
    expect(view.current()).toMatchObject({
      isPending: true,
      answer: 'because',
    });

    pending[0].resolve({ text: 'because' });
    await done;
    expect(view.current()).toEqual({
      question: 'why?',
      answer: 'because',
      isPending: false,
      historyCount: 0,
    });
  });

  it('counts down a pending retry', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    await pending[0].params.onRetry({
      restart: true,
      retryInfo: {
        attempt: 2,
        maxRetries: 5,
        delayMs: 3_000,
        message: 'Rate limited\ndetails',
        skipDelay: () => {},
      },
    });
    expect(view.current()?.retryStatus).toBe(
      'Rate limited · retrying in 3s · attempt 2/5',
    );

    vi.advanceTimersByTime(1_000);
    expect(view.current()?.retryStatus).toBe(
      'Rate limited · retrying in 2s · attempt 2/5',
    );
  });

  it('cancels a running request through the abort controller', () => {
    const { session } = makeSession();
    const view = makeUi();
    const { id } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    view.ui.btwAbortControllerRef.current!.abort();

    expect(session.getRequest(id)?.outcome).toEqual({ kind: 'cancelled' });
  });

  it('detaches without cancelling when another request is shown or dismissed', () => {
    const { session } = makeSession();
    const view = makeUi();
    const first = session.ask('first?');
    showBtwRequest(view.ui, session, first.id);
    const firstController = view.ui.btwAbortControllerRef.current!;

    const second = session.ask('second?');
    showBtwRequest(view.ui, session, second.id);
    firstController.abort();
    dismissBtwView();

    expect(session.getRequest(first.id)?.outcome).toBeNull();
    expect(session.getRequest(second.id)?.outcome).toBeNull();
    expect(view.items.at(-1)).toBeNull();
  });

  it('browses earlier answers and clears them', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    for (const question of ['one?', 'two?', 'three?']) {
      const request = session.ask(question);
      pending.at(-1)!.resolve({ text: `answer ${question}` });
      await request.done;
    }
    const current = session.getSnapshot().exchanges.at(-1)!;
    showBtwRequest(view.ui, session, current.id);
    expect(view.current()).toMatchObject({
      question: 'three?',
      historyCount: 2,
    });

    expect(browseBtwHistory('older')).toBe(true);
    expect(view.current()).toMatchObject({
      question: 'two?',
      browsePosition: 2,
    });
    browseBtwHistory('older');
    browseBtwHistory('older');
    expect(view.current()).toMatchObject({
      question: 'one?',
      browsePosition: 1,
    });
    browseBtwHistory('newer');
    browseBtwHistory('newer');
    expect(view.current()).toMatchObject({ question: 'three?' });
    expect(view.current()?.browsePosition).toBeUndefined();

    expect(clearBtwHistory()).toBe(true);
    expect(session.getSnapshot().exchanges.map((e) => e.question)).toEqual([
      'three?',
    ]);
    expect(view.current()).toMatchObject({
      question: 'three?',
      historyCount: 0,
    });
    expect(browseBtwHistory('older')).toBe(false);
    expect(clearBtwHistory()).toBe(false);
  });

  it('copies the shown answer and reports the result', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');
    showBtwRequest(view.ui, session, id);
    const copy = vi.fn().mockResolvedValue(undefined);

    expect(copyBtwAnswer(copy)).toBe(false);
    pending[0].resolve({ text: 'because' });
    await done;

    expect(copyBtwAnswer(copy)).toBe(true);
    await vi.waitFor(() =>
      expect(view.current()?.notice).toEqual({
        text: 'Copied to clipboard',
      }),
    );
    expect(copy).toHaveBeenCalledWith('because');
    vi.advanceTimersByTime(2_000);
    expect(view.current()?.notice).toBeUndefined();

    copyBtwAnswer(vi.fn().mockRejectedValue(new Error('no clipboard')));
    await vi.waitFor(() =>
      expect(view.current()?.notice).toEqual({
        text: 'Copy failed',
        isError: true,
      }),
    );
  });

  it('closes when the session drops the request', () => {
    const { session } = makeSession();
    const view = makeUi();
    const { id } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    session.dispose();

    expect(view.items.at(-1)).toBeNull();
    expect(view.ui.btwAbortControllerRef.current).toBeNull();
  });

  it('consumes only the keys that apply to the shown item', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    // Pending, no history: nothing to browse, copy or dismiss.
    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(false);
    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(false);
    expect(handleBtwViewKey(key({ name: 'space', sequence: ' ' }))).toBe(false);

    pending[0].resolve({ text: 'because' });
    await done;
    expect(
      handleBtwViewKey(key({ name: 'c', sequence: 'c', ctrl: true })),
    ).toBe(false);
    expect(
      handleBtwViewKey(key({ name: 'c', sequence: 'c', paste: true })),
    ).toBe(false);
    expect(
      handleBtwViewKey(key({ name: 'c', sequence: 'c', meta: true })),
    ).toBe(false);
    expect(handleBtwViewKey(key({ name: 'x', sequence: 'x' }))).toBe(false);
    expect(handleBtwViewKey(key({ name: 'return', sequence: '\r' }))).toBe(
      true,
    );
    expect(view.items.at(-1)).toBeNull();
    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(false);
  });

  it('does not arm the shortcuts when an arrow has nothing to browse', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');
    showBtwRequest(view.ui, session, id);
    pending[0].resolve({ text: 'because' });
    await done;
    vi.mocked(copyToClipboard).mockClear();

    expect(handleBtwViewKey(key({ name: 'right' }))).toBe(false);
    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(handleBtwViewKey(key({ name: 'x', sequence: 'x' }))).toBe(false);
    expect(view.current()).toMatchObject({ historyCount: 0 });
  });

  it('leaves browse mode for the next other key, including meta combos', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    for (const question of ['one?', 'two?']) {
      const request = session.ask(question);
      pending.at(-1)!.resolve({ text: `answer ${question}` });
      await request.done;
    }
    showBtwRequest(view.ui, session, session.getSnapshot().exchanges[1].id);
    vi.mocked(copyToClipboard).mockClear();

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(view.current()?.browsing).toBe(true);
    expect(
      handleBtwViewKey(key({ name: 'c', sequence: 'c', meta: true })),
    ).toBe(false);
    expect(view.current()?.browsing).toBeUndefined();
    expect(copyToClipboard).not.toHaveBeenCalled();

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(
      handleBtwViewKey(key({ name: 'x', sequence: 'x', meta: true })),
    ).toBe(false);
    expect(session.getSnapshot().exchanges).toHaveLength(2);

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(handleBtwViewKey({ ...key({ name: 'left' }), meta: true })).toBe(
      false,
    );
    expect(view.current()?.browsing).toBeUndefined();
  });

  it("dismisses only once the view's own request has settled", async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const first = session.ask('first?');
    pending[0].resolve({ text: 'first answer' });
    await first.done;
    const second = session.ask('second?');
    showBtwRequest(view.ui, session, second.id);

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(view.current()).toMatchObject({
      question: 'first?',
      isPending: false,
      ownRequestPending: true,
    });
    expect(handleBtwViewKey(key({ name: 'return', sequence: '\r' }))).toBe(
      false,
    );
    expect(view.items.at(-1)).not.toBeNull();

    pending[1].resolve({ text: 'second answer' });
    await second.done;
    expect(view.current()?.ownRequestPending).toBeUndefined();
    expect(handleBtwViewKey(key({ name: 'return', sequence: '\r' }))).toBe(
      true,
    );
    expect(view.items.at(-1)).toBeNull();
  });

  it('keeps the browsed answer anchored when the history window trims', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    for (let index = 0; index < 20; index += 1) {
      const request = session.ask(`q${index}?`);
      pending.at(-1)!.resolve({ text: `answer ${index}` });
      await request.done;
    }
    const current = session.getSnapshot().exchanges.at(-1)!;
    showBtwRequest(view.ui, session, current.id);
    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(view.current()).toMatchObject({
      question: 'q17?',
      browsePosition: 18,
    });

    const next = session.ask('q20?');
    pending.at(-1)!.resolve({ text: 'answer 20' });
    await next.done;

    expect(view.current()).toMatchObject({
      question: 'q17?',
      browsePosition: 17,
    });
  });

  it('routes the arrow, c and x keys to browse, copy and clear', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    for (const question of ['one?', 'two?']) {
      const request = session.ask(question);
      pending.at(-1)!.resolve({ text: `answer ${question}` });
      await request.done;
    }
    showBtwRequest(view.ui, session, session.getSnapshot().exchanges[1].id);

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(view.current()).toMatchObject({ question: 'one?' });
    expect(handleBtwViewKey(key({ name: 'right' }))).toBe(true);
    expect(view.current()).toMatchObject({ question: 'two?' });

    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(true);
    expect(copyToClipboard).toHaveBeenCalledWith('answer two?');

    expect(handleBtwViewKey(key({ name: 'x', sequence: 'x' }))).toBe(true);
    expect(session.getSnapshot().exchanges.map((e) => e.question)).toEqual([
      'two?',
    ]);
  });

  it('leaves a plain c or x to the composer until browse mode starts', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    for (const question of ['one?', 'two?']) {
      const request = session.ask(question);
      pending.at(-1)!.resolve({ text: `answer ${question}` });
      await request.done;
    }
    showBtwRequest(view.ui, session, session.getSnapshot().exchanges[1].id);
    vi.mocked(copyToClipboard).mockClear();

    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(handleBtwViewKey(key({ name: 'x', sequence: 'x' }))).toBe(false);
    expect(session.getSnapshot().exchanges).toHaveLength(2);

    // Browse mode starts with an arrow and ends on the next typed character.
    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(true);
    expect(copyToClipboard).toHaveBeenCalledWith('answer one?');

    expect(handleBtwViewKey(key({ name: 'left' }))).toBe(true);
    expect(handleBtwViewKey(key({ name: 'a', sequence: 'a' }))).toBe(false);
    vi.mocked(copyToClipboard).mockClear();
    expect(handleBtwViewKey(key({ name: 'c', sequence: 'c' }))).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('shows the no-response fallback for an empty outcome', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    pending[0].resolve({ text: null });
    await done;

    expect(view.current()).toMatchObject({
      answer: 'No response received.',
      isPending: false,
    });
  });

  it('shows a localized notice when the model only tried to call a tool', async () => {
    const { session, pending } = makeSession();
    const view = makeUi();
    const { id, done } = session.ask('why?');
    showBtwRequest(view.ui, session, id);

    pending[0].resolve({ text: null, toolCallName: 'shell' });
    await done;

    expect(view.current()).toMatchObject({
      answer:
        '(The model tried to call shell instead of answering directly. Try rephrasing or ask in the main conversation.)',
      isPending: false,
    });
  });
});
