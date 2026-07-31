// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionActions } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonTranscriptStore } from '@qwen-code/sdk/daemon';
import { getTranslator } from '../i18n';
import {
  useQueuedPrompts,
  type UseQueuedPromptsResult,
} from './useQueuedPrompts';

const sdk = vi.hoisted(() => ({
  pendingEvents: [],
  batches: [] as Array<{
    sessionId: string;
    messages: readonly string[];
    originatorClientId?: string;
  }>,
  consume: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  consumePendingPromptEvents: vi.fn(),
  getPendingPromptEvents: () => sdk.pendingEvents,
  getPendingPromptVersion: () => 0,
  subscribePendingPromptEvents: () => () => {},
  subscribePendingPromptVersion: () => () => {},
  useDaemonMidTurnInjected: () => ({
    batches: sdk.batches,
    consume: sdk.consume,
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = getTranslator('zh-CN');
let container: HTMLElement;
let root: Root;
let latest: UseQueuedPromptsResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking',
  sessionActions: DaemonSessionActions,
) {
  const editor = {
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    focus: vi.fn(),
    restoreImages: vi.fn(),
  };
  const store = {
    appendLocalUserMessage: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as DaemonTranscriptStore;

  function Harness({ state }: { state: typeof streamingState }) {
    latest = useQueuedPrompts({
      connected: false,
      sessionId: 'session-1',
      clientId: 'client-1',
      streamingState: state,
      sessionActions,
      store,
      editorRef: { current: editor as never },
      reportError: vi.fn(),
      t,
    });
    return null;
  }

  const render = (state: typeof streamingState) => {
    act(() => root.render(<Harness state={state} />));
  };
  render(streamingState);
  return { render };
}

function createActions() {
  const pendingSubmit = deferred<{ promptId: string }>();
  return {
    actions: {
      enqueueMidTurnMessage: vi.fn(),
      submitPrompt: vi.fn(() => pendingSubmit.promise),
    } as unknown as DaemonSessionActions,
    pendingSubmit,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sdk.batches = [];
  sdk.consume.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useQueuedPrompts default mid-turn insertion', () => {
  it('keeps an accepted message queued until its injection event', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
    });
    const { render } = mount('responding', actions);

    act(() => {
      latest.enqueuePrompt('补充信息');
    });
    await act(async () => {});

    expect(actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
      '补充信息',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: '补充信息', midTurnState: 'queued' },
    ]);

    sdk.batches = [
      {
        sessionId: 'session-1',
        originatorClientId: 'client-1',
        messages: ['补充信息'],
      },
    ];
    render('idle');

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(sdk.consume).toHaveBeenCalledWith(sdk.batches);
  });

  it('falls back to one ordinary submission when mid-turn admission fails', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: false,
    });
    mount('responding', actions);

    act(() => {
      latest.enqueuePrompt('下一步');
    });
    await act(async () => {});

    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(actions.submitPrompt).toHaveBeenCalledWith(
      '下一步',
      expect.objectContaining({ optimisticUserMessage: false }),
    );
    expect(latest.queuedPrompts).toMatchObject([
      { text: '下一步', serverState: 'submitting' },
    ]);
  });

  it('falls back once when the running turn ends before injection', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
    });
    const { render } = mount('thinking', actions);

    act(() => {
      latest.enqueuePrompt('继续处理');
    });
    await act(async () => {});
    render('idle');
    await act(async () => {});

    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(latest.queuedPrompts).toMatchObject([
      { text: '继续处理', serverState: 'submitting' },
    ]);
  });

  it('ignores a late admission result after idle fallback claimed the prompt', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions);

    act(() => {
      latest.enqueuePrompt('不要重复');
    });
    render('idle');
    render('responding');
    await act(async () => admission.resolve({ accepted: true }));

    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '不要重复',
        serverState: 'submitting',
        midTurnState: undefined,
      },
    ]);
  });

  it('keeps idle, image, and command submissions on the ordinary path', () => {
    const { actions } = createActions();
    const { render } = mount('idle', actions);

    act(() => latest.enqueuePrompt('普通消息'));
    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();

    render('responding');
    act(() => latest.enqueuePrompt('图片', [{ data: 'x', media_type: 'x' }]));
    act(() => latest.enqueuePrompt('/help'));

    expect(actions.submitPrompt).toHaveBeenCalledTimes(3);
    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
  });
});
