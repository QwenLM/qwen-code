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
    messageIds?: readonly string[];
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function mount(
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking',
  sessionActions: DaemonSessionActions,
  canMutateMidTurn = true,
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
  const reportError = vi.fn();

  function Harness({ state }: { state: typeof streamingState }) {
    latest = useQueuedPrompts({
      connected: false,
      sessionId: 'session-1',
      clientId: 'client-1',
      canMutateMidTurn,
      streamingState: state,
      sessionActions,
      store,
      editorRef: { current: editor as never },
      reportError,
      t,
    });
    return null;
  }

  const render = (state: typeof streamingState) => {
    act(() => root.render(<Harness state={state} />));
  };
  render(streamingState);
  return { editor, render, reportError };
}

function createActions() {
  const pendingSubmit = deferred<{ promptId: string }>();
  return {
    actions: {
      enqueueMidTurnMessage: vi.fn(),
      removeMidTurnMessage: vi.fn(),
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
      messageId: 'mid-1',
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
      {
        text: '补充信息',
        midTurnState: 'queued',
        midTurnMessageId: 'mid-1',
      },
    ]);

    sdk.batches = [
      {
        sessionId: 'session-1',
        originatorClientId: 'client-1',
        messages: ['补充信息'],
        messageIds: ['mid-1'],
      },
    ];
    render('idle');

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(sdk.consume).toHaveBeenCalledWith(sdk.batches);
  });

  it('does not resend when injection arrives before admission resolves', async () => {
    const { actions } = createActions();
    const admission = deferred<{
      accepted: boolean;
      messageId?: string;
    }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('提前注入'));
    sdk.batches = [
      {
        sessionId: 'session-1',
        originatorClientId: 'client-1',
        messages: ['提前注入'],
        messageIds: ['mid-early'],
      },
    ];
    render('responding');

    expect(latest.queuedPrompts).toEqual([]);
    await act(async () =>
      admission.resolve({ accepted: true, messageId: 'mid-early' }),
    );
    render('idle');

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
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
      messageId: 'mid-2',
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
    await act(async () =>
      admission.resolve({ accepted: true, messageId: 'mid-late' }),
    );

    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '不要重复',
        serverState: 'submitting',
        midTurnState: undefined,
      },
    ]);
  });

  it('deletes an accepted message from the daemon queue', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-delete',
    });
    vi.mocked(actions.removeMidTurnMessage).mockResolvedValue({
      removed: true,
    });
    mount('responding', actions);

    act(() => latest.enqueuePrompt('删除我'));
    await act(async () => {});
    await act(async () => latest.removeQueuedPrompt(1));

    expect(actions.removeMidTurnMessage).toHaveBeenCalledWith('mid-delete', {
      sessionId: 'session-1',
    });
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('edits by removing the daemon message before restoring the composer', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-edit',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { editor } = mount('responding', actions);

    act(() => latest.enqueuePrompt('修改我'));
    await act(async () => {});
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = latest.editQueuedPrompt(1);
    });
    await act(async () => {});

    // Restoration must WAIT for the daemon removal: handing the composer back
    // while the message is still queued would let the user resubmit a message
    // that remains in the mid-turn queue.
    expect(editor.setText).not.toHaveBeenCalled();
    expect(actions.removeMidTurnMessage).toHaveBeenCalledWith('mid-edit', {
      sessionId: 'session-1',
    });

    await act(async () => {
      removal.resolve({ removed: true });
      await editPromise;
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).toHaveBeenCalledWith('修改我');
    expect(editor.focus).toHaveBeenCalled();
  });

  it('keeps the row when removal loses the race with drain or idle', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-race',
    });
    vi.mocked(actions.removeMidTurnMessage).mockResolvedValue({
      removed: false,
    });
    const { render, reportError } = mount('responding', actions);

    act(() => latest.enqueuePrompt('竞态消息'));
    await act(async () => {});
    await act(async () => latest.removeQueuedPrompt(1));

    // An active-turn rejection parks the row with a `delete` failed-action flag
    // (cleared of the in-flight marker) so the idle pass drops it without
    // resending.
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '竞态消息',
        midTurnState: 'queued',
        isRemoving: false,
        midTurnFailedAction: 'delete',
      },
    ]);
    expect(reportError).toHaveBeenCalled();

    render('idle');
    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('restores a failed active-turn edit at idle without resending', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-active-edit',
    });
    vi.mocked(actions.removeMidTurnMessage).mockResolvedValue({
      removed: false,
    });
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('稍后编辑'));
    await act(async () => {});
    await act(async () => latest.editQueuedPrompt(1));

    expect(editor.setText).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { midTurnFailedAction: 'edit' },
    ]);

    render('idle');
    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).toHaveBeenCalledWith('稍后编辑');
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('waits for a pending delete before handling the turn becoming idle', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-idle-delete',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('删除竞态'));
    await act(async () => {});
    act(() => latest.removeQueuedPrompt(1));
    render('idle');

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    await act(async () => removal.resolve({ removed: true }));

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('does not resend after a pending delete loses the idle race', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-idle-fallback',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('保留竞态'));
    await act(async () => {});
    act(() => latest.removeQueuedPrompt(1));
    render('idle');
    await act(async () => removal.resolve({ removed: false }));

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('restores an edit locally without resending when removal loses the idle race', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-idle-edit',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('编辑竞态'));
    await act(async () => {});
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = latest.editQueuedPrompt(1);
    });
    render('idle');
    await act(async () => {
      removal.resolve({ removed: false });
      await editPromise;
    });

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).toHaveBeenCalledWith('编辑竞态');
  });

  it('does not resend a deleted message after an idle transport failure', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-idle-error',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('删除失败竞态'));
    await act(async () => {});
    act(() => latest.removeQueuedPrompt(1));
    render('idle');
    await act(async () => removal.reject(new Error('network failed')));

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
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
    act(() =>
      latest.enqueuePrompt('@file.ts fix', undefined, undefined, [
        {
          type: 'reference',
          start: 0,
          end: 7,
          text: '@file.ts',
          reference: { id: 'ref-1' },
        },
      ]),
    );

    expect(actions.submitPrompt).toHaveBeenCalledTimes(4);
    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
  });

  it('retains mid-turn rows and clears ordinary rows on clearQueuedPrompts', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-1',
    });
    const { render } = mount('idle', actions);

    act(() => latest.enqueuePrompt('普通排队'));
    render('responding');
    act(() => latest.enqueuePrompt('中途消息'));
    await act(async () => {});

    expect(latest.queuedPrompts).toHaveLength(2);

    act(() => latest.clearQueuedPrompts());

    expect(latest.queuedPrompts).toMatchObject([
      { text: '中途消息', midTurnState: 'queued', midTurnMessageId: 'mid-1' },
    ]);
    expect(actions.removeMidTurnMessage).not.toHaveBeenCalled();
  });

  it('edits the last mid-turn row via editLastQueuedPrompt', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-1',
    });
    vi.mocked(actions.removeMidTurnMessage).mockResolvedValue({
      removed: true,
    });
    const { editor } = mount('responding', actions);

    act(() => latest.enqueuePrompt('编辑最后'));
    await act(async () => {});

    act(() => latest.editLastQueuedPrompt());
    await act(async () => {});

    expect(actions.removeMidTurnMessage).toHaveBeenCalledWith('mid-1', {
      sessionId: 'session-1',
    });
    expect(editor.setText).toHaveBeenCalledWith('编辑最后');
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('consumes the keypress without editing while mid-turn is submitting', () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    mount('responding', actions);

    act(() => latest.enqueuePrompt('正在提交'));

    const consumed = latest.editLastQueuedPrompt();
    expect(consumed).toBe(true);
    expect(actions.removeMidTurnMessage).not.toHaveBeenCalled();
  });

  it('does not send a mid-turn delete when the daemon lacks the mutation capability', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-1',
    });
    const { editor } = mount('responding', actions, false);

    act(() => latest.enqueuePrompt('无能力'));
    await act(async () => {});

    // The keyboard path consumes the keypress but must not hit a route the
    // daemon doesn't advertise (an older daemon answers the DELETE with a 404).
    const consumed = latest.editLastQueuedPrompt();
    await act(async () => {});

    expect(consumed).toBe(true);
    expect(actions.removeMidTurnMessage).not.toHaveBeenCalled();
    expect(editor.setText).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: '无能力', midTurnState: 'queued' },
    ]);
  });
});
