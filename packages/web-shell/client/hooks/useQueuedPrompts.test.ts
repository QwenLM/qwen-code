// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mergeRestoredPromptText,
  useQueuedPrompts,
  type UseQueuedPromptsResult,
} from './useQueuedPrompts';

const pendingPromptMock = vi.hoisted(() => {
  type Listener = () => void;
  type Event = {
    type: 'turn_complete' | 'turn_error';
    originatorClientId?: string;
    data: { sessionId: string; promptId: string };
  };
  let events: Event[] = [];
  let midTurnBatches: Array<{
    sessionId: string;
    messages: string[];
    originatorClientId?: string;
  }> = [];
  const listeners = new Set<Listener>();
  const midTurnListeners = new Set<Listener>();
  return {
    getEvents: () => events,
    subscribeEvents: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    consumeEvents: (handled: readonly Event[]) => {
      const handledSet = new Set(handled);
      events = events.filter((event) => !handledSet.has(event));
      for (const listener of listeners) listener();
    },
    publish: (event: Event) => {
      events = [...events, event];
      for (const listener of listeners) listener();
    },
    getMidTurnBatches: () => midTurnBatches,
    subscribeMidTurnBatches: (listener: Listener) => {
      midTurnListeners.add(listener);
      return () => midTurnListeners.delete(listener);
    },
    consumeMidTurnBatches: (handled: readonly unknown[]) => {
      const handledSet = new Set(handled);
      midTurnBatches = midTurnBatches.filter((batch) => !handledSet.has(batch));
      for (const listener of midTurnListeners) listener();
    },
    publishMidTurnBatch: (batch: {
      sessionId: string;
      messages: string[];
      originatorClientId?: string;
    }) => {
      midTurnBatches = [...midTurnBatches, batch];
      for (const listener of midTurnListeners) listener();
    },
    reset: () => {
      events = [];
      midTurnBatches = [];
      listeners.clear();
      midTurnListeners.clear();
    },
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const ReactModule = await import('react');
  return {
    ...(await importOriginal()),
    consumePendingPromptEvents: pendingPromptMock.consumeEvents,
    getPendingPromptEvents: pendingPromptMock.getEvents,
    getPendingPromptVersion: () => 0,
    subscribePendingPromptEvents: pendingPromptMock.subscribeEvents,
    subscribePendingPromptVersion: () => () => undefined,
    useDaemonMidTurnInjected: () => ({
      batches: ReactModule.useSyncExternalStore(
        pendingPromptMock.subscribeMidTurnBatches,
        pendingPromptMock.getMidTurnBatches,
        pendingPromptMock.getMidTurnBatches,
      ),
      consume: pendingPromptMock.consumeMidTurnBatches,
    }),
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error('deferred promise did not initialize');
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestResult: UseQueuedPromptsResult | undefined;
let submitResult: Deferred<{ promptId: string }>;
let submitPrompt: ReturnType<typeof vi.fn>;
let appendLocalUserMessage: ReturnType<typeof vi.fn>;
let onComplete: ReturnType<typeof vi.fn>;
let getPendingPrompts: ReturnType<typeof vi.fn>;
let removePendingPrompt: ReturnType<typeof vi.fn>;
let enqueueMidTurnMessage: ReturnType<typeof vi.fn>;
let reportError: ReturnType<typeof vi.fn>;
let holdQueuedPromptsLocally: boolean;
let testSessionId: string;
let testStreamingState: 'idle' | 'streaming';
let testSessionSequence = 0;

function TestHost() {
  latestResult = useQueuedPrompts({
    connected: true,
    sessionId: testSessionId,
    clientId: 'client-a',
    streamingState: testStreamingState,
    holdQueuedPromptsLocally,
    sessionActions: {
      submitPrompt,
      getPendingPrompts,
      removePendingPrompt,
      enqueueMidTurnMessage,
    },
    store: { appendLocalUserMessage },
    editorRef: { current: null },
    reportError,
    notifySuccess: vi.fn(),
    t: (key: string) => key,
  } as unknown as Parameters<typeof useQueuedPrompts>[0]);
  return null;
}

async function renderHookHost() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(TestHost));
  });
}

async function publishTerminal(
  promptId: string,
  type: 'turn_complete' | 'turn_error' = 'turn_complete',
) {
  await act(async () => {
    pendingPromptMock.publish({
      type,
      originatorClientId: 'client-a',
      data: { sessionId: testSessionId, promptId },
    });
  });
}

beforeEach(() => {
  pendingPromptMock.reset();
  latestResult = undefined;
  submitResult = deferred();
  submitPrompt = vi.fn(() => submitResult.promise);
  appendLocalUserMessage = vi.fn();
  onComplete = vi.fn();
  getPendingPrompts = vi.fn(() => Promise.resolve({ pendingPrompts: [] }));
  removePendingPrompt = vi.fn(() => Promise.resolve({ removed: true }));
  enqueueMidTurnMessage = vi.fn(() => Promise.resolve({ accepted: true }));
  reportError = vi.fn();
  holdQueuedPromptsLocally = false;
  testSessionId = `session-${++testSessionSequence}`;
  testStreamingState = 'streaming';
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

// Regression for #7128: restoration paths can fire more than once for the
// same prompt (failed submit + reconnect/refresh, queue clear racing an
// abort), and a user retrying an identical message restores identical text.
// Stacking those copies is what surfaced as "sent messages concatenated back
// into the input box after refresh".
describe('mergeRestoredPromptText', () => {
  it('fills an empty editor with the restored text', () => {
    expect(mergeRestoredPromptText('', 'hello')).toBe('hello');
    expect(mergeRestoredPromptText('   ', 'hello')).toBe('hello');
  });

  it('prepends above a different draft the user is typing', () => {
    expect(mergeRestoredPromptText('draft', 'restored')).toBe(
      'restored\ndraft',
    );
  });

  it('is a no-op when the same text was already restored', () => {
    expect(mergeRestoredPromptText('hello', 'hello')).toBe('hello');
  });

  it('is a no-op when the text already sits at the top of the editor', () => {
    expect(mergeRestoredPromptText('hello\ndraft', 'hello')).toBe(
      'hello\ndraft',
    );
  });

  it('stays idempotent across repeated restores of the same prompt', () => {
    let editor = '';
    for (let i = 0; i < 3; i++) {
      editor = mergeRestoredPromptText(editor, '用python写一个hello world');
    }
    expect(editor).toBe('用python写一个hello world');
  });

  it('does not treat a same-prefix but different first line as a duplicate', () => {
    expect(mergeRestoredPromptText('hello world\ndraft', 'hello')).toBe(
      'hello\nhello world\ndraft',
    );
  });
});

describe('useQueuedPrompts terminal reconciliation', () => {
  it('clears an immediate prompt when acceptance arrives before turn_complete', async () => {
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('test', undefined, onComplete);
    });
    await act(async () => {
      submitResult.resolve({ promptId: 'prompt-1' });
      await submitResult.promise;
    });
    expect(latestResult?.queuedTexts).toEqual(['test']);

    await publishTerminal('prompt-1');

    expect(latestResult?.queuedTexts).toEqual([]);
    expect(appendLocalUserMessage).toHaveBeenCalledTimes(1);
    expect(appendLocalUserMessage).toHaveBeenCalledWith(
      'test',
      undefined,
      undefined,
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('clears an immediate prompt when turn_complete arrives before acceptance', async () => {
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('test', undefined, onComplete);
    });
    await publishTerminal('prompt-1');
    expect(latestResult?.queuedTexts).toEqual(['test']);

    await act(async () => {
      submitResult.resolve({ promptId: 'prompt-1' });
      await submitResult.promise;
    });

    expect(latestResult?.queuedTexts).toEqual([]);
    expect(appendLocalUserMessage).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('clears an immediate prompt when turn_error arrives before acceptance', async () => {
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('test', undefined, onComplete);
    });
    await publishTerminal('prompt-1', 'turn_error');
    await act(async () => {
      submitResult.resolve({ promptId: 'prompt-1' });
      await submitResult.promise;
    });

    expect(latestResult?.queuedTexts).toEqual([]);
    expect(appendLocalUserMessage).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('useQueuedPrompts mid-turn insertion', () => {
  it('restores a held Goal prompt after the composer remounts', async () => {
    holdQueuedPromptsLocally = true;
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('keep in session a');
    });

    await act(async () => {
      root?.unmount();
    });
    root = createRoot(container!);

    await act(async () => {
      root?.render(React.createElement(TestHost));
    });
    expect(latestResult?.queuedTexts).toEqual(['keep in session a']);
    expect(submitPrompt).not.toHaveBeenCalled();

    act(() => {
      latestResult?.enqueuePrompt('new prompt after remount');
    });
    expect(latestResult?.queuedPrompts.map((prompt) => prompt.id)).toEqual([
      1, 2,
    ]);
  });

  it('restores a held Goal prompt from session storage after reload', async () => {
    holdQueuedPromptsLocally = true;
    window.sessionStorage.setItem(
      `qwen-web-shell:queued-prompts:${testSessionId}`,
      JSON.stringify([{ id: 7, text: 'keep across reload' }]),
    );

    await renderHookHost();

    expect(latestResult?.queuedTexts).toEqual(['keep across reload']);
    expect(latestResult?.queuedPrompts[0]?.id).toBe(7);
  });

  it('submits a held prompt normally after the Goal releases ownership', async () => {
    holdQueuedPromptsLocally = true;
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('send after goal', undefined, onComplete);
    });

    holdQueuedPromptsLocally = false;
    testStreamingState = 'idle';
    await act(async () => {
      root?.render(React.createElement(TestHost));
    });
    await act(async () => {
      await latestResult?.insertQueuedPrompt(1);
    });

    expect(submitPrompt).toHaveBeenCalledWith(
      'send after goal',
      expect.objectContaining({
        optimisticUserMessage: false,
        sessionId: testSessionId,
      }),
    );
    expect(enqueueMidTurnMessage).not.toHaveBeenCalled();
  });

  it('uses the latest Goal ownership when an older enqueue callback fires', async () => {
    await renderHookHost();
    const enqueueBeforeGoalHydration = latestResult?.enqueuePrompt;

    holdQueuedPromptsLocally = true;
    await act(async () => {
      root?.render(React.createElement(TestHost));
    });
    act(() => {
      enqueueBeforeGoalHydration?.('wait after hydration');
    });

    expect(latestResult?.queuedTexts).toEqual(['wait after hydration']);
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it('keeps prompts local while an active Goal owns the running turn', async () => {
    holdQueuedPromptsLocally = true;
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('wait here', undefined, onComplete);
    });

    expect(latestResult?.queuedTexts).toEqual(['wait here']);
    expect(latestResult?.queuedPrompts[0]).toMatchObject({
      text: 'wait here',
    });
    expect(latestResult?.queuedPrompts[0]?.serverPromptId).toBeUndefined();
    expect(latestResult?.queuedPrompts[0]?.serverState).toBeUndefined();
    expect(submitPrompt).not.toHaveBeenCalled();

    await act(async () => {
      await latestResult?.insertQueuedPrompt(1);
    });

    expect(enqueueMidTurnMessage).toHaveBeenCalledWith('wait here', {
      signal: expect.any(AbortSignal),
    });
    expect(removePendingPrompt).not.toHaveBeenCalled();
    expect(latestResult?.queuedTexts).toEqual(['wait here']);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      pendingPromptMock.publishMidTurnBatch({
        sessionId: testSessionId,
        messages: ['wait here'],
        originatorClientId: 'client-a',
      });
    });

    expect(latestResult?.queuedTexts).toEqual([]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('keeps a rejected insertion queued without showing an error', async () => {
    holdQueuedPromptsLocally = true;
    enqueueMidTurnMessage.mockResolvedValueOnce({ accepted: false });
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('try later');
    });
    await act(async () => {
      await latestResult?.insertQueuedPrompt(1);
    });

    expect(latestResult?.queuedTexts).toEqual(['try later']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does not abort a prompt that became running before queued removal', async () => {
    await renderHookHost();

    act(() => {
      latestResult?.enqueuePrompt('qqq');
    });
    await act(async () => {
      submitResult.resolve({ promptId: 'prompt-1' });
      await submitResult.promise;
    });
    removePendingPrompt.mockResolvedValueOnce({
      removed: false,
      currentState: 'running',
    });
    getPendingPrompts.mockResolvedValueOnce({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'qqq',
          queuedAt: Date.now(),
          state: 'running',
        },
      ],
    });

    await act(async () => {
      await latestResult?.insertQueuedPrompt(1);
    });

    expect(removePendingPrompt).toHaveBeenCalledWith('prompt-1', {
      sessionId: testSessionId,
      ifState: 'queued',
    });
    expect(enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
