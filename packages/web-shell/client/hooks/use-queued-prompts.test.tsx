// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionActions,
  DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonTranscriptStore } from '@qwen-code/sdk/daemon';
import { getTranslator } from '../i18n';
import type { EditorHandle } from './useComposerCore';
import {
  useQueuedPrompts,
  type UseQueuedPromptsResult,
} from './useQueuedPrompts';

const daemonMocks = vi.hoisted(() => ({
  pendingEvents: [] as unknown[],
  midTurnBatches: [] as Array<{
    sessionId: string;
    messages: string[];
    originatorClientId?: string;
  }>,
  consumeMidTurn: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  consumePendingPromptEvents: vi.fn(),
  getPendingPromptEvents: () => daemonMocks.pendingEvents,
  getPendingPromptVersion: () => 0,
  subscribePendingPromptEvents: () => () => {},
  subscribePendingPromptVersion: () => () => {},
  useDaemonMidTurnInjected: () => ({
    batches: daemonMocks.midTurnBatches,
    consume: daemonMocks.consumeMidTurn,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = getTranslator('zh-CN');
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  daemonMocks.pendingEvents = [];
  daemonMocks.midTurnBatches = [];
  daemonMocks.consumeMidTurn.mockReset();
});

function setup(enqueueAccepted: boolean) {
  const submitPrompt = vi.fn().mockResolvedValue({ promptId: 'prompt-1' });
  const removePendingPrompt = vi.fn().mockResolvedValue({ removed: true });
  const enqueueMidTurnMessage = vi
    .fn()
    .mockResolvedValue({ accepted: enqueueAccepted });
  const getPendingPrompts = vi.fn().mockResolvedValue({ pendingPrompts: [] });
  const sessionActions = {
    submitPrompt,
    removePendingPrompt,
    enqueueMidTurnMessage,
    getPendingPrompts,
  } as unknown as DaemonSessionActions;
  const editor = {
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    restoreImages: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorHandle;
  const store = {
    appendLocalUserMessage: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as DaemonTranscriptStore;
  const reportError = vi.fn();
  let latest: UseQueuedPromptsResult | undefined;
  let streamingState: DaemonStreamingState = 'responding';

  function Probe({ tick: _tick }: { tick: number }) {
    latest = useQueuedPrompts({
      connected: true,
      sessionId: 'session-1',
      clientId: 'client-1',
      streamingState,
      sessionActions,
      store,
      editorRef: { current: editor },
      reportError,
      t,
    });
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe tick={0} />));

  return {
    value: () => latest!,
    rerender: (tick: number) => act(() => root!.render(<Probe tick={tick} />)),
    setStreamingState: (next: DaemonStreamingState) => {
      streamingState = next;
    },
    submitPrompt,
    removePendingPrompt,
    enqueueMidTurnMessage,
    getPendingPrompts,
    editor,
    reportError,
  };
}

async function enqueueServerPrompt(
  value: () => UseQueuedPromptsResult,
): Promise<void> {
  await act(async () => {
    value().enqueuePrompt('check the tests');
    await Promise.resolve();
  });
  expect(value().queuedPrompts[0]).toMatchObject({
    text: 'check the tests',
    serverPromptId: 'prompt-1',
    serverState: 'queued',
  });
}

describe('useQueuedPrompts mid-turn insertion', () => {
  it('keeps an accepted insert queued until the injected event arrives', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);

    await act(async () => {
      await harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.removePendingPrompt).toHaveBeenCalledWith('prompt-1', {
      sessionId: 'session-1',
    });
    expect(harness.enqueueMidTurnMessage).toHaveBeenCalledWith(
      'check the tests',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.value().queuedPrompts).toMatchObject([
      {
        text: 'check the tests',
        midTurnState: 'queued',
      },
    ]);
    expect(harness.value().queuedPrompts[0]?.serverPromptId).toBeUndefined();
    expect(harness.value().editLastQueuedPrompt()).toBe(true);
    harness.value().removeQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    await harness
      .value()
      .editQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    expect(harness.value().clearQueuedPrompts()).toBe(true);
    expect(harness.value().queuedPrompts).toHaveLength(1);
    expect(harness.editor.setText).not.toHaveBeenCalled();

    daemonMocks.midTurnBatches = [
      {
        sessionId: 'session-1',
        messages: ['check the tests'],
        originatorClientId: 'client-1',
      },
    ];
    harness.rerender(1);

    expect(harness.value().queuedPrompts).toEqual([]);
    expect(daemonMocks.consumeMidTurn).toHaveBeenCalledWith(
      daemonMocks.midTurnBatches,
    );
  });

  it('resubmits an accepted insert as the next turn when the turn ends first', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);

    await act(async () => {
      await harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    });
    harness.submitPrompt.mockClear();

    harness.setStreamingState('idle');
    harness.rerender(1);
    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.submitPrompt).toHaveBeenCalledWith(
      'check the tests',
      expect.objectContaining({
        optimisticUserMessage: false,
        sessionId: 'session-1',
      }),
    );
    expect(harness.value().queuedPrompts).toEqual([]);
  });

  it('resubmits multiple accepted inserts in order when the turn ends first', async () => {
    const harness = setup(true);
    harness.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockResolvedValueOnce({ promptId: 'prompt-2' });

    await act(async () => {
      harness.value().enqueuePrompt('first message');
      harness.value().enqueuePrompt('second message');
      await Promise.resolve();
    });
    expect(harness.value().queuedPrompts).toHaveLength(2);
    harness.getPendingPrompts.mockResolvedValueOnce({
      pendingPrompts: [
        {
          promptId: 'prompt-2',
          text: 'second message',
          state: 'queued',
        },
      ],
    });

    for (const prompt of [...harness.value().queuedPrompts]) {
      await act(async () => {
        await harness.value().insertQueuedPrompt(prompt.id);
      });
    }
    expect(
      harness.value().queuedPrompts.map(({ text, midTurnState }) => ({
        text,
        midTurnState,
      })),
    ).toEqual([
      { text: 'first message', midTurnState: 'queued' },
      { text: 'second message', midTurnState: 'queued' },
    ]);
    harness.submitPrompt.mockClear();

    harness.setStreamingState('idle');
    harness.rerender(1);
    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.submitPrompt).toHaveBeenCalledTimes(2);
    expect(harness.submitPrompt.mock.calls.map(([text]) => text)).toEqual([
      'first message',
      'second message',
    ]);
    expect(harness.value().queuedPrompts).toEqual([]);
  });

  it('does not resubmit when injection and turn completion arrive together', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);

    await act(async () => {
      await harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    });
    harness.submitPrompt.mockClear();
    daemonMocks.midTurnBatches = [
      {
        sessionId: 'session-1',
        messages: ['check the tests'],
        originatorClientId: 'client-1',
      },
    ];

    harness.setStreamingState('idle');
    harness.rerender(1);

    expect(harness.submitPrompt).not.toHaveBeenCalled();
    expect(harness.value().queuedPrompts).toEqual([]);
  });

  it('resubmits when the turn ends while insertion admission is in flight', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.submitPrompt.mockClear();
    let resolveAdmission: ((result: { accepted: boolean }) => void) | undefined;
    harness.enqueueMidTurnMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
        }),
    );

    let insertion: Promise<void> | undefined;
    await act(async () => {
      insertion = harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
      await Promise.resolve();
      await Promise.resolve();
    });
    harness.setStreamingState('idle');
    harness.rerender(1);
    await act(async () => {
      resolveAdmission?.({ accepted: true });
      await insertion;
    });

    expect(harness.submitPrompt).toHaveBeenCalledTimes(1);
    expect(harness.submitPrompt).toHaveBeenCalledWith(
      'check the tests',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('restores a removed server prompt when mid-turn admission is rejected', async () => {
    const harness = setup(false);
    await enqueueServerPrompt(harness.value);

    await act(async () => {
      await harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.value().queuedPrompts).toEqual([]);
    expect(harness.editor.setText).toHaveBeenCalledWith('check the tests');
    expect(harness.reportError).toHaveBeenCalled();
  });

  it('refreshes once when removing the server prompt fails', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.getPendingPrompts.mockClear();
    harness.removePendingPrompt.mockResolvedValueOnce({ removed: false });

    await act(async () => {
      await harness
        .value()
        .insertQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.getPendingPrompts).toHaveBeenCalledTimes(1);
    expect(harness.enqueueMidTurnMessage).not.toHaveBeenCalled();
  });
});

describe('useQueuedPrompts immediate insertion', () => {
  it('keeps the immediate state when the active model call was interrupted', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.enqueueMidTurnMessage.mockResolvedValueOnce({
      accepted: true,
      interruptStatus: 'interrupted',
    });

    await act(async () => {
      await harness
        .value()
        .insertQueuedPromptImmediately(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.value().queuedPrompts).toMatchObject([
      {
        text: 'check the tests',
        midTurnState: 'queued',
        midTurnImmediate: true,
      },
    ]);
  });

  it('keeps waiting for immediate effect when interruption is deferred to a tool boundary', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.enqueueMidTurnMessage.mockResolvedValueOnce({
      accepted: true,
      interruptStatus: 'deferred',
    });

    await act(async () => {
      await harness
        .value()
        .insertQueuedPromptImmediately(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.value().queuedPrompts[0]).toMatchObject({
      midTurnState: 'queued',
      midTurnImmediate: true,
    });
  });

  it('downgrades to ordinary insertion when immediate interruption is unavailable', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.enqueueMidTurnMessage.mockResolvedValueOnce({
      accepted: true,
      interruptStatus: 'unavailable',
    });

    await act(async () => {
      await harness
        .value()
        .insertQueuedPromptImmediately(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.removePendingPrompt).toHaveBeenCalledWith('prompt-1', {
      sessionId: 'session-1',
    });
    expect(harness.enqueueMidTurnMessage).toHaveBeenCalledWith(
      'check the tests',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        immediate: true,
      }),
    );
    expect(harness.value().queuedPrompts).toMatchObject([
      {
        text: 'check the tests',
        midTurnState: 'queued',
        midTurnImmediate: false,
      },
    ]);
    expect(harness.value().editLastQueuedPrompt()).toBe(true);
    harness.value().removeQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    await harness
      .value()
      .editQueuedPrompt(harness.value().queuedPrompts[0]!.id);
    expect(harness.value().clearQueuedPrompts()).toBe(true);
    expect(harness.value().queuedPrompts).toHaveLength(1);
  });

  it('restores the message when immediate insertion fails', async () => {
    const harness = setup(true);
    await enqueueServerPrompt(harness.value);
    harness.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('interrupt failed'),
    );

    await act(async () => {
      await harness
        .value()
        .insertQueuedPromptImmediately(harness.value().queuedPrompts[0]!.id);
    });

    expect(harness.value().queuedPrompts).toEqual([]);
    expect(harness.editor.setText).toHaveBeenCalledWith('check the tests');
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      '立即插入排队消息失败',
    );
  });
});
