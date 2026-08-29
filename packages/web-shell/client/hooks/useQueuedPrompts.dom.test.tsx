// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionActions } from '@qwen-code/webui/daemon-react-sdk';
import {
  DaemonHttpError,
  type DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
import { getTranslator } from '../i18n';
import {
  useQueuedPrompts,
  type UseQueuedPromptsResult,
} from './useQueuedPrompts';

const sdk = vi.hoisted(() => ({
  pendingEvents: [] as Array<{
    type:
      | 'pending_prompt_started'
      | 'pending_prompt_completed'
      | 'turn_complete'
      | 'turn_error';
    originatorClientId?: string;
    data: {
      sessionId: string;
      promptId?: string;
      text?: string;
      state?: string;
      stopReason?: string;
    };
  }>,
  batches: [] as Array<{
    sessionId: string;
    messages: readonly string[];
    messageIds?: readonly string[];
    originatorClientId?: string;
  }>,
  consume: vi.fn(),
  ownerVersion: 0,
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
  useDaemonSessionOwnerGuard: () => ({
    capture: () => {
      const ownerVersion = sdk.ownerVersion;
      return { isCurrent: () => sdk.ownerVersion === ownerVersion };
    },
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
  connected = false,
  writeBlocked = false,
  holdQueuedPromptsLocally = false,
  // `null` = the workspace has not resolved yet (an explicit `undefined`
  // argument would take the default).
  workspaceCwd: string | null = '/workspace',
) {
  const editor = {
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    focus: vi.fn(),
    restoreImages: vi.fn(),
    restoreInputAnnotations: vi.fn(),
  };
  const store = {
    appendLocalUserMessage: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as DaemonTranscriptStore;
  const reportError = vi.fn();

  function Harness({
    state,
    activeSessionId,
    blocked,
    hold,
    cwd,
  }: {
    state: typeof streamingState;
    activeSessionId: string;
    blocked: boolean;
    hold: boolean;
    cwd: string | null;
  }) {
    latest = useQueuedPrompts({
      connected,
      writeBlocked: blocked,
      sessionId: activeSessionId,
      workspaceCwd: cwd ?? undefined,
      clientId: 'client-1',
      canMutateMidTurn,
      // This suite pins the legacy local-fallback lifecycle.
      canQueryMidTurn: false,
      canInjectMidTurnMedia: false,
      streamingState: state,
      holdQueuedPromptsLocally: hold,
      sessionActions,
      store,
      editorRef: { current: editor as never },
      reportError,
      t,
    });
    return null;
  }

  let activeSessionId = 'session-1';
  let blocked = writeBlocked;
  let held = holdQueuedPromptsLocally;
  let cwd = workspaceCwd;
  const render = (
    state: typeof streamingState,
    nextSessionId = activeSessionId,
    replaceOwner = false,
    nextWriteBlocked = blocked,
    nextHold = held,
    nextCwd: string | null = cwd,
  ) => {
    if (replaceOwner) sdk.ownerVersion += 1;
    activeSessionId = nextSessionId;
    blocked = nextWriteBlocked;
    held = nextHold;
    cwd = nextCwd;
    act(() =>
      root.render(
        <Harness
          state={state}
          activeSessionId={activeSessionId}
          blocked={blocked}
          hold={held}
          cwd={cwd}
        />,
      ),
    );
  };
  render(streamingState);
  return { editor, render, reportError, store };
}

function createActions() {
  const pendingSubmit = deferred<{
    promptId: string;
    removedAfterAbort?: true;
  }>();
  return {
    actions: {
      enqueueMidTurnMessage: vi.fn(),
      removeMidTurnMessage: vi.fn(),
      removePendingPrompt: vi.fn(),
      getPendingPrompts: vi.fn().mockResolvedValue({ pendingPrompts: [] }),
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
  sdk.pendingEvents = [];
  sdk.consume.mockReset();
  sdk.ownerVersion = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useQueuedPrompts default mid-turn insertion', () => {
  it('holds Goal follow-ups locally until an explicit insert', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'inserted-1',
    });
    mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('wait for explicit insert'));

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'wait for explicit insert' },
    ]);

    await act(async () => latest.insertQueuedPrompt(1));

    // An explicit insert is deliberately uncancellable: it carries no abort
    // signal so an owner rotation cannot kill a send the user asked for.
    expect(actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
      'wait for explicit insert',
      expect.not.objectContaining({ signal: expect.anything() }),
    );
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: 'wait for explicit insert',
        midTurnState: 'queued',
        midTurnMessageId: 'inserted-1',
      },
    ]);
  });

  it('does not insert a held prompt between turns', async () => {
    const { actions } = createActions();
    mount('idle', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('wait for a running turn'));
    await act(async () => latest.insertQueuedPrompt(1));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'wait for a running turn' },
    ]);
  });

  it('does not insert a held prompt with input annotations', async () => {
    const { actions } = createActions();
    mount('responding', actions, true, false, false, true);

    act(() =>
      latest.enqueuePrompt(
        'inspect this file',
        undefined,
        undefined,
        undefined,
        [
          {
            type: 'reference',
            start: 8,
            end: 17,
            text: 'this file',
            reference: {
              id: 'file-1',
              kind: 'data-table',
              label: 'File',
              value: '/tmp/a.ts',
              serialized: 'this file',
            },
          },
        ],
      ),
    );
    await act(async () => latest.insertQueuedPrompt(1));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toHaveLength(1);
  });

  it('does not insert a held prompt carrying images', async () => {
    // `enqueueMidTurnMessage` transmits text only, so inserting an image-bearing
    // row would silently drop the attachment. The display hides Insert for this
    // shape; the hook guard is the backstop on the public API.
    const { actions } = createActions();
    mount('responding', actions, true, false, false, true);

    act(() =>
      latest.enqueuePrompt('look at this', [
        { data: 'abc', media_type: 'image/png' },
      ]),
    );
    await act(async () => latest.insertQueuedPrompt(1));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'look at this', images: [{ media_type: 'image/png' }] },
    ]);
  });

  it('does not insert a held slash command', async () => {
    // A command injected mid-turn arrives as literal text the daemon never
    // executes, so it must stay queued for the ordinary path.
    const { actions } = createActions();
    mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('/compact'));
    await act(async () => latest.insertQueuedPrompt(1));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([{ text: '/compact' }]);
  });

  it('does not insert a held prompt with file attachments', async () => {
    const { actions } = createActions();
    mount('responding', actions, true, false, false, true);

    act(() =>
      latest.enqueuePrompt('inspect this file', undefined, [
        {
          name: 'a.ts',
          media_type: 'text/typescript',
          text: 'export {};',
        },
      ]),
    );
    await act(async () => latest.insertQueuedPrompt(1));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'inspect this file', files: [{ name: 'a.ts' }] },
    ]);
  });

  it('preserves an accepted explicit insert across a session switch', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('stay with session one'));
    let insertPromise: Promise<void> | undefined;
    act(() => {
      insertPromise = latest.insertQueuedPrompt(1);
    });
    render('idle', 'session-2', true, false, true);
    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'mid-1' });
      await insertPromise;
    });
    render('responding', 'session-1', true, false, true);

    expect(latest.queuedPrompts).toMatchObject([
      {
        text: 'stay with session one',
        midTurnState: 'queued',
        midTurnMessageId: 'mid-1',
        isInserting: false,
      },
    ]);
  });

  it('locks edit and clear while an explicit insert is in flight', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { editor } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('in flight'));
    act(() => {
      void latest.insertQueuedPrompt(1);
    });
    await act(async () => latest.editQueuedPrompt(1));
    let consumed = false;
    let cleared = false;
    act(() => {
      consumed = latest.editLastQueuedPrompt();
      cleared = latest.clearQueuedPrompts();
    });

    expect(consumed).toBe(true);
    expect(cleared).toBe(false);
    expect(editor.setText).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'in flight', isInserting: true },
    ]);
  });

  it('keeps an explicit insert in flight when the turn becomes idle', () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(
      new Promise(() => undefined),
    );
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('in flight'));
    act(() => {
      void latest.insertQueuedPrompt(1);
    });
    const signal = vi.mocked(actions.enqueueMidTurnMessage).mock.calls[0]?.[1]
      ?.signal;
    render('idle', 'session-1', false, false, true);

    // Nothing can cancel an explicit insert: it is issued without a signal.
    expect(signal).toBeUndefined();
  });

  it('does not resubmit a legacy explicit insert accepted as the turn becomes idle', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render, reportError } = mount(
      'responding',
      actions,
      true,
      false,
      false,
      true,
    );

    act(() => latest.enqueuePrompt('submit after settle'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    render('idle', 'session-1', false, false, false);
    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'accepted-once' });
      await insertion;
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('resubmits a legacy explicit insert after an idle transport failure', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render, reportError } = mount(
      'responding',
      actions,
      true,
      false,
      false,
      true,
    );

    act(() => latest.enqueuePrompt('recover after failure'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    render('idle', 'session-1', false, false, false);
    await act(async () => {
      admission.reject(new Error('connection lost'));
      await insertion;
    });

    expect(reportError).toHaveBeenCalledOnce();
    expect(actions.submitPrompt).toHaveBeenCalledWith(
      'recover after failure',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(actions.submitPrompt).toHaveBeenCalledOnce();
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: 'recover after failure',
        serverState: 'submitting',
        isInserting: false,
      },
    ]);
  });

  it('silently holds an explicit insert rejected while a Goal remains active', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render, reportError } = mount(
      'responding',
      actions,
      true,
      false,
      false,
      true,
    );

    act(() => latest.enqueuePrompt('keep held'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    render('idle', 'session-1', false, false, true);
    await act(async () => {
      admission.resolve({ accepted: false });
      await insertion;
    });

    expect(reportError).toHaveBeenCalledOnce();
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([{ text: 'keep held' }]);
    expect(latest.queuedPrompts[0]?.midTurnState).toBeUndefined();
    expect(latest.queuedPrompts[0]?.isInserting).toBe(false);
  });

  it('lets an explicit insert settle into its source-session stash', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockImplementation(
      (_message, opts) => {
        opts?.signal?.addEventListener(
          'abort',
          () => admission.reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
        return admission.promise;
      },
    );
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('insert once'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    const signal = vi.mocked(actions.enqueueMidTurnMessage).mock.calls[0]?.[1]
      ?.signal;
    render('idle', 'session-2', true, false, true);

    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'inserted-once' });
      await insertion;
    });
    render('responding', 'session-1', true, false, true);

    expect(signal).toBeUndefined();
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: 'insert once',
        midTurnState: 'queued',
        midTurnMessageId: 'inserted-once',
      },
    ]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('settles an explicit insert into the stash a cwd relocation moved', async () => {
    // The workspace half of the owner key resolves mid-insert, which relocates
    // the whole stash onto the new key and DELETES the old one. Settling
    // through the key captured when the insert started would write nothing:
    // the row would come back from the stash still `isInserting`, and every
    // release/edit/delete/clear path skips such a row — bricked until reload.
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount(
      'responding',
      actions,
      true,
      false,
      false,
      true,
      null,
    );

    act(() => latest.enqueuePrompt('insert once'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    // cwd resolves for the SAME session: the stash relocates.
    render('responding', 'session-1', false, false, true, '/workspace');
    // Then the user leaves, so the settle lands with the row stashed.
    render('responding', 'session-2', false, false, true, '/workspace');

    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'inserted-once' });
      await insertion;
    });
    render('responding', 'session-1', false, false, true, '/workspace');

    expect(latest.queuedPrompts).toMatchObject([
      {
        text: 'insert once',
        midTurnState: 'queued',
        midTurnMessageId: 'inserted-once',
        isInserting: false,
      },
    ]);
  });

  it('keeps one explicit insert in flight across an A-to-B-to-A switch', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockImplementation(
      (_message, opts) => {
        opts?.signal?.addEventListener(
          'abort',
          () => admission.reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
        return admission.promise;
      },
    );
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('insert exactly once'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    const signal = vi.mocked(actions.enqueueMidTurnMessage).mock.calls[0]?.[1]
      ?.signal;
    render('responding', 'session-2', true, false, true);
    render('responding', 'session-1', true, false, true);

    expect(latest.queuedPrompts).toMatchObject([
      { text: 'insert exactly once', isInserting: true },
    ]);
    await act(async () => latest.insertQueuedPrompt(1));
    expect(actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);

    render('idle', 'session-1', false, false, true);
    expect(signal).toBeUndefined();
    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'inserted-once' });
      await insertion;
    });
    expect(actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('submits locally held Goal follow-ups after the Goal stops', () => {
    const { actions } = createActions();
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('run after goal'));
    expect(actions.submitPrompt).not.toHaveBeenCalled();

    render('idle', 'session-1', false, false, false);

    expect(actions.submitPrompt).toHaveBeenCalledWith(
      'run after goal',
      expect.objectContaining({ optimisticUserMessage: false }),
    );
  });

  it('releases held Goal follow-ups one at a time, in queue order', async () => {
    // A prompt carrying media waits for its uploads before its admission POST,
    // so releasing the whole batch at once lets a later plain prompt overtake
    // it and land in the daemon's queue first.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'second' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first with media'));
    act(() => latest.enqueuePrompt('second plain'));

    render('idle', 'session-1', false, false, false);

    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
    });

    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media', 'second plain']);
  });

  it('stops the release chain when the Goal re-activates mid-drain', async () => {
    // The chain is built synchronously when the hold lifts, but each link runs
    // only after the previous admission settles. Resuming the Goal inside that
    // window must stop the remaining links — otherwise the queue keeps draining
    // into an active Goal after the user changed their mind.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'second' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first'));
    act(() => latest.enqueuePrompt('second'));

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first']);

    // Goal resumed while the first admission is still in flight.
    render('idle', 'session-1', false, false, true);
    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
    });

    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first']);
    // The unsent row goes back to held, so the next inactive transition
    // re-drains it rather than stranding it as 'submitting'.
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'second', serverState: undefined },
    ]);

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first', 'second']);
  });

  it('stashes the undrained release chain when the session changes mid-drain', async () => {
    // The chain marks the whole batch `submitting` up front and then releases
    // it serially, so a switch inside that window used to orphan every row it
    // had not reached: the stash only saved `serverState === undefined` rows,
    // and the remaining links POSTed against the wrong session and were
    // swallowed by the chain's own `.catch`. Both prompts were gone for good.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'second' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first with media'));
    act(() => latest.enqueuePrompt('second plain'));

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    // The user switches away while the first admission is still in flight.
    render('idle', 'session-2', false, false, false);
    expect(latest.queuedPrompts).toEqual([]);
    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
    });

    // The second link must not POST into session-2.
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    // Coming back, the row the chain never reached is in session-1's queue
    // again and the fresh drain releases it -- to session-1, in order.
    render('idle', 'session-1', false, false, false);
    expect(latest.queuedPrompts).toMatchObject([{ text: 'second plain' }]);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media', 'second plain']);
  });

  it('holds a prompt typed mid-drain behind the release chain', async () => {
    // The chain preserves order only inside the batch it drains. A prompt typed
    // while it is still in flight used to POST immediately -- overtaking the
    // older rows it was typed after, and, while link 1's uploads were still
    // running, even starting the turn ahead of link 1 itself.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'later' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first with media'));
    act(() => latest.enqueuePrompt('second plain'));

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    // Typed inside the drain window: it must queue behind the chain, not race
    // it. The row is still stamped `submitting` -- it is spoken for, just not
    // POSTed yet.
    act(() => latest.enqueuePrompt('typed during drain'));
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media', 'second plain', 'typed during drain']);
  });

  it('stashes a chain link that bails before the owner change commits', async () => {
    // The owner token is replaced in the render body while the stash is a
    // passive effect flushed after commit. A link firing in that window used
    // to delete its id from the unreleased set before the owner check, so the
    // stash -- which saves a stamped row only while its id is still there --
    // discarded a prompt the chain never POSTed.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'second' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first with media'));
    act(() => latest.enqueuePrompt('second plain'));

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    // Token replaced, stash not flushed yet -- link 2 runs inside the window.
    sdk.ownerVersion += 1;
    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
      await Promise.resolve();
    });
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    // The commit that follows must still find the row stashable.
    render('idle', 'session-2', false, false, false);
    render('idle', 'session-1', false, false, false);
    expect(latest.queuedPrompts).toMatchObject([{ text: 'second plain' }]);
  });

  it('drops the undrained release chain when the queue is cleared mid-drain', async () => {
    // Before the serial chain, every `submitting` row had its abort controller
    // created synchronously with the stamp, so clearing the queue aborted it.
    // The chain defers submission past the stamp, so the links it has not
    // fired yet are reachable only through the row's absence from the queue.
    const { actions } = createActions();
    const firstAdmission = deferred<{ promptId: string }>();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstAdmission.promise as never)
      .mockResolvedValue({ promptId: 'second' } as never);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('first with media'));
    act(() => latest.enqueuePrompt('second plain'));

    render('idle', 'session-1', false, false, false);
    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);

    act(() => {
      latest.clearQueuedPrompts();
    });
    await act(async () => {
      firstAdmission.resolve({ promptId: 'first' });
      await Promise.resolve();
    });

    expect(
      vi.mocked(actions.submitPrompt).mock.calls.map((call) => call[0]),
    ).toEqual(['first with media']);
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('keeps locally held Goal follow-ups isolated across session switches', () => {
    const { actions } = createActions();
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('stay with session one'));
    render('responding', 'session-2', true, false, true);
    expect(latest.queuedPrompts).toEqual([]);

    act(() => latest.enqueuePrompt('stay with session two'));
    render('responding', 'session-1', true, false, true);
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'stay with session one' },
    ]);

    render('responding', 'session-2', true, false, true);
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'stay with session two' },
    ]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
  });

  it('restores an unaccepted mid-turn prompt when its owner is replaced', () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(
      new Promise(() => undefined),
    );
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('belongs to the source attachment'));
    expect(latest.queuedPrompts).toHaveLength(1);

    render('responding', 'session-1', true);

    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).toHaveBeenCalledWith(
      'belongs to the source attachment',
    );
    const signal = vi.mocked(actions.enqueueMidTurnMessage).mock.calls[0]?.[1]
      ?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('queues and submits an image-only prompt without using mid-turn text insertion', () => {
    const { actions } = createActions();
    mount('responding', actions);
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];

    act(() => latest.enqueuePrompt('', images));

    expect(actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
    expect(actions.submitPrompt).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        images,
        optimisticUserMessage: false,
      }),
    );
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '',
        images,
        payloadCompleteness: 'complete',
        serverState: 'submitting',
      },
    ]);
  });

  it('materializes daemon-only queue rows as summary-only payloads', async () => {
    const { actions } = createActions();
    vi.mocked(actions.getPendingPrompts).mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'server-image',
          text: '[image]',
          state: 'queued',
        },
      ],
    });
    const { editor } = mount('responding', actions, true, true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '[image]',
        serverPromptId: 'server-image',
        serverState: 'queued',
        payloadCompleteness: 'summary-only',
      },
    ]);
    await act(async () => latest.editQueuedPrompt(1));
    expect(editor.setText).not.toHaveBeenCalled();
    expect(editor.restoreImages).not.toHaveBeenCalled();
  });

  it('buffers an image-only started event until its exact response binds', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('responding', actions);
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];

    act(() => latest.enqueuePrompt('', images));
    sdk.pendingEvents = [
      {
        type: 'pending_prompt_started',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-image',
          text: '[image]',
        },
      },
    ];
    render('responding');
    expect(store.appendLocalUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      pendingSubmit.resolve({ promptId: 'server-image' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).toHaveBeenCalledOnce();
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      '',
      [{ data: 'Ym1w', mimeType: 'image/bmp' }],
      undefined,
      undefined,
    );
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '',
        images,
        serverPromptId: 'server-image',
        serverState: 'queued',
      },
    ]);
  });

  it('keeps another prompt started buffer when one admission is unknown', async () => {
    const firstSubmit = deferred<{ promptId: string }>();
    const secondSubmit = deferred<{ promptId: string }>();
    const { actions } = createActions();
    vi.mocked(actions.submitPrompt)
      .mockReturnValueOnce(firstSubmit.promise)
      .mockReturnValueOnce(secondSubmit.promise);
    const { render, store } = mount('responding', actions);
    const firstImages = [{ data: 'Zmlyc3Q=', media_type: 'image/png' }];
    const secondImages = [{ data: 'c2Vjb25k', media_type: 'image/png' }];

    act(() => latest.enqueuePrompt('', firstImages));
    act(() => latest.enqueuePrompt('', secondImages));
    sdk.pendingEvents = [
      {
        type: 'pending_prompt_started',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-second',
          text: '[image]',
        },
      },
    ];
    render('responding');

    await act(async () => {
      firstSubmit.reject(new TypeError('response lost'));
      await Promise.resolve();
      secondSubmit.resolve({ promptId: 'server-second' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).toHaveBeenCalledOnce();
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      '',
      [{ data: 'c2Vjb25k', mimeType: 'image/png' }],
      undefined,
      undefined,
    );
  });

  it('binds an image prompt when its terminal event precedes admission response', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('responding', actions);
    const images = [{ data: 'dGVybWluYWw=', media_type: 'image/png' }];

    act(() => latest.enqueuePrompt('', images));
    sdk.pendingEvents = [
      {
        type: 'pending_prompt_started',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-terminal',
          text: '[image]',
        },
      },
      {
        type: 'turn_complete',
        data: {
          sessionId: 'session-1',
          promptId: 'server-terminal',
        },
      },
    ];
    render('responding');

    await act(async () => {
      pendingSubmit.resolve({ promptId: 'server-terminal' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).toHaveBeenCalledOnce();
    expect(store.appendLocalUserMessage).toHaveBeenCalledWith(
      '',
      [{ data: 'dGVybWluYWw=', mimeType: 'image/png' }],
      undefined,
      undefined,
    );
  });

  it('does not append text twice when its terminal precedes admission response', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('idle', actions);

    act(() => latest.enqueuePrompt('run once'));
    sdk.pendingEvents = [
      {
        type: 'pending_prompt_started',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-text-terminal',
          text: 'run once',
        },
      },
      {
        type: 'turn_complete',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-text-terminal',
        },
      },
    ];
    render('idle');
    expect(store.appendLocalUserMessage).toHaveBeenCalledOnce();

    await act(async () => {
      pendingSubmit.resolve({ promptId: 'server-text-terminal' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).toHaveBeenCalledOnce();
  });

  it('does not append a prompt removed before its admission response', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('responding', actions);

    act(() =>
      latest.enqueuePrompt('', [
        { data: 'cmVtb3ZlZA==', media_type: 'image/png' },
      ]),
    );
    sdk.pendingEvents = [
      {
        type: 'pending_prompt_completed',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-removed',
          state: 'removed',
        },
      },
      {
        type: 'turn_complete',
        originatorClientId: 'client-1',
        data: {
          sessionId: 'session-1',
          promptId: 'server-removed',
          stopReason: 'cancelled',
        },
      },
    ];
    render('idle');

    await act(async () => {
      pendingSubmit.resolve({ promptId: 'server-removed' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).not.toHaveBeenCalled();
  });

  it('does not create a duplicate summary while an image response is pending', async () => {
    const { actions } = createActions();
    const refresh = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        state: 'queued';
      }>;
    }>();
    vi.mocked(actions.getPendingPrompts).mockReturnValue(refresh.promise);
    mount('responding', actions, true, true);
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];

    act(() => latest.enqueuePrompt('', images));
    await act(async () => {
      refresh.resolve({
        pendingPrompts: [
          { promptId: 'server-image', text: '[image]', state: 'queued' },
        ],
      });
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toHaveLength(1);
    expect(latest.queuedPrompts[0]).toMatchObject({
      text: '',
      images,
      serverState: 'submitting',
      payloadCompleteness: 'complete',
    });
  });

  it('refreshes deferred server summaries after an image response binds exactly', async () => {
    const { actions, pendingSubmit } = createActions();
    const initialRefresh = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        state: 'queued';
      }>;
    }>();
    vi.mocked(actions.getPendingPrompts)
      .mockReturnValueOnce(initialRefresh.promise)
      .mockResolvedValue({
        pendingPrompts: [
          { promptId: 'server-image', text: '[image]', state: 'queued' },
          { promptId: 'server-other', text: 'other', state: 'queued' },
        ],
      });
    mount('responding', actions, true, true);
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];

    act(() => latest.enqueuePrompt('', images));
    await act(async () => {
      initialRefresh.resolve({
        pendingPrompts: [
          { promptId: 'server-image', text: '[image]', state: 'queued' },
          { promptId: 'server-other', text: 'other', state: 'queued' },
        ],
      });
      await Promise.resolve();
    });
    expect(latest.queuedPrompts).toHaveLength(1);

    await act(async () => {
      pendingSubmit.resolve({ promptId: 'server-image' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actions.getPendingPrompts).toHaveBeenCalledTimes(2);
    expect(latest.queuedPrompts).toMatchObject([
      {
        text: '',
        images,
        serverPromptId: 'server-image',
        payloadCompleteness: 'complete',
      },
      {
        text: 'other',
        serverPromptId: 'server-other',
        payloadCompleteness: 'summary-only',
      },
    ]);
  });

  it('ignores an old submit response after an S1 to S2 to S1 owner change', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('responding', actions);

    act(() =>
      latest.enqueuePrompt('', [{ data: 'b2xk', media_type: 'image/png' }]),
    );
    render('responding', 'session-2');
    render('responding', 'session-1');
    await act(async () => {
      pendingSubmit.resolve({ promptId: 'old-server-prompt' });
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.removePendingPrompt).not.toHaveBeenCalled();
    expect(store.appendLocalUserMessage).not.toHaveBeenCalled();
  });

  it('fences an old submit before the replacement owner rerenders', async () => {
    const { actions, pendingSubmit } = createActions();
    const { render, store } = mount('responding', actions);

    act(() =>
      latest.enqueuePrompt('', [{ data: 'b2xk', media_type: 'image/png' }]),
    );
    sdk.ownerVersion += 1;
    await act(async () => {
      pendingSubmit.resolve({ promptId: 'old-server-prompt' });
      await Promise.resolve();
    });

    expect(store.appendLocalUserMessage).not.toHaveBeenCalled();
    render('responding', 'session-1');
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('ignores an old refresh after an S1 to S2 to S1 owner change', async () => {
    const { actions } = createActions();
    const oldRefresh = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        state: 'queued';
      }>;
    }>();
    vi.mocked(actions.getPendingPrompts)
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValue({ pendingPrompts: [] });
    const { render } = mount('responding', actions, true, true);

    render('responding', 'session-2');
    render('responding', 'session-1');
    await act(async () => {
      oldRefresh.resolve({
        pendingPrompts: [
          { promptId: 'stale-prompt', text: 'stale', state: 'queued' },
        ],
      });
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
  });

  it('restores image-only payloads when submission never starts', async () => {
    const { actions, pendingSubmit } = createActions();
    const { editor } = mount('responding', actions);
    const images = [{ data: 'cG5n', media_type: 'image/png' }];

    act(() => latest.enqueuePrompt('', images));
    await act(async () => {
      pendingSubmit.reject(new DaemonHttpError(413, undefined, 'Too large'));
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).not.toHaveBeenCalled();
    expect(editor.restoreImages).toHaveBeenCalledWith(images);
  });

  it('restores image-only payloads alongside an existing draft', async () => {
    const { actions, pendingSubmit } = createActions();
    const { editor } = mount('responding', actions);
    vi.mocked(editor.getText).mockReturnValue('current draft');
    const images = [{ data: 'cG5n', media_type: 'image/png' }];

    act(() => latest.enqueuePrompt('', images));
    await act(async () => {
      pendingSubmit.reject(new DaemonHttpError(413, undefined, 'Too large'));
      await Promise.resolve();
    });

    expect(editor.setText).not.toHaveBeenCalled();
    expect(editor.restoreImages).toHaveBeenCalledWith(images);
  });

  it('does not duplicate attachments when restored text is already present', async () => {
    const { actions, pendingSubmit } = createActions();
    const { editor } = mount('responding', actions);
    vi.mocked(editor.getText).mockReturnValue('describe');
    const images = [{ data: 'cG5n', media_type: 'image/png' }];
    const inputAnnotations = [
      {
        type: 'reference' as const,
        start: 0,
        end: 8,
        text: 'describe',
        reference: { id: 'file:describe', kind: 'file', value: 'describe' },
      },
    ];

    act(() =>
      latest.enqueuePrompt(
        'describe',
        images,
        undefined,
        undefined,
        inputAnnotations,
      ),
    );
    await act(async () => {
      pendingSubmit.reject(new DaemonHttpError(413, undefined, 'Too large'));
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).not.toHaveBeenCalled();
    expect(editor.restoreImages).not.toHaveBeenCalled();
    expect(editor.restoreInputAnnotations).not.toHaveBeenCalled();
  });

  it('drops a dispatched payload and refreshes from the backend', async () => {
    const { actions, pendingSubmit } = createActions();
    const { editor, reportError } = mount('responding', actions, true, true);
    const images = [{ data: 'cG5n', media_type: 'image/png' }];

    act(() => latest.enqueuePrompt('', images));
    vi.mocked(actions.submitPrompt).mock.calls[0]?.[1]?.onAdmissionStarted?.();
    await act(async () => {
      pendingSubmit.reject(new TypeError('network disconnected'));
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.restoreImages).not.toHaveBeenCalled();
    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
    expect(actions.getPendingPrompts).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(TypeError),
      t('queue.queueFailed'),
    );
  });

  it('restores queued input annotations when submission never starts', async () => {
    const { actions, pendingSubmit } = createActions();
    const { editor } = mount('responding', actions);
    const inputAnnotations = [
      {
        type: 'reference' as const,
        start: 0,
        end: 8,
        text: '@file.ts',
        reference: { id: 'file:file.ts', kind: 'file', value: 'file.ts' },
      },
    ];

    act(() =>
      latest.enqueuePrompt(
        '@file.ts\n\nfix it',
        undefined,
        undefined,
        undefined,
        inputAnnotations,
      ),
    );
    await act(async () => {
      pendingSubmit.reject(new TypeError('response lost'));
      await Promise.resolve();
    });
    expect(latest.queuedPrompts).toEqual([]);
    expect(editor.setText).toHaveBeenCalledWith('@file.ts\n\nfix it');
    expect(editor.restoreInputAnnotations).toHaveBeenCalledWith(
      inputAnnotations,
    );
  });

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

  it('does not resend an explicit insert when its echo beats the admission ack', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('explicit early injection'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    sdk.batches = [
      {
        sessionId: 'session-1',
        originatorClientId: 'client-1',
        messages: ['explicit early injection'],
      },
    ];
    render('responding');
    expect(latest.queuedPrompts).toEqual([]);

    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'mid-early' });
      await insertion;
    });
    render('idle', 'session-1', false, false, false);

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

  it('holds an idle admission rejection while a Goal is active', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('wait for the Goal'));
    render('idle', 'session-1', false, false, true);
    await act(async () => admission.resolve({ accepted: false }));

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([{ text: 'wait for the Goal' }]);
    expect(latest.queuedPrompts[0]).not.toHaveProperty('serverState');

    render('idle', 'session-1', false, false, false);
    expect(actions.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not resubmit a legacy explicit insert accepted after idle', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean; messageId?: string }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions, true, false, false, true);

    act(() => latest.enqueuePrompt('do not lose me'));
    let insertion!: Promise<void>;
    act(() => {
      insertion = latest.insertQueuedPrompt(1);
    });
    render('idle', 'session-1', false, false, true);
    await act(async () => {
      admission.resolve({ accepted: true, messageId: 'legacy-accepted' });
      await insertion;
    });

    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();

    render('idle', 'session-1', false, false, false);
    expect(latest.queuedPrompts).toEqual([]);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('does not hold a legacy insert accepted before Goal hold', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'accepted-before-idle',
    });
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('already accepted'));
    await act(async () => {});
    expect(latest.queuedPrompts).toMatchObject([
      { midTurnMessageId: 'accepted-before-idle', midTurnState: 'queued' },
    ]);

    render('idle', 'session-1', false, false, true);
    expect(latest.queuedPrompts).toEqual([]);
    render('idle', 'session-1', false, false, false);

    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });

  it('freezes mid-turn fallback while a session switch is preparing', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockReturnValue(admission.promise);
    const { render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('留在当前会话'));
    render('responding', 'session-1', false, true);
    await act(async () => admission.resolve({ accepted: false }));
    render('idle', 'session-1', false, true);

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toMatchObject([
      { text: '留在当前会话', midTurnState: undefined },
    ]);

    render('idle', 'session-1', false, false);
    expect(actions.submitPrompt).toHaveBeenCalledOnce();
  });

  it('does not resubmit an accepted legacy message when the running turn ends', async () => {
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

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('does not resubmit a late accepted legacy admission at idle', async () => {
    const { actions } = createActions();
    const admission = deferred<{ accepted: boolean }>();
    let signal: AbortSignal | undefined;
    vi.mocked(actions.enqueueMidTurnMessage).mockImplementation(
      (_message, options) => {
        signal = options?.signal;
        return admission.promise;
      },
    );
    const { render } = mount('responding', actions);

    act(() => {
      latest.enqueuePrompt('不要重复');
    });
    render('idle');
    expect(signal?.aborted).toBe(false);
    await act(async () =>
      admission.resolve({ accepted: true, messageId: 'mid-late' }),
    );

    expect(actions.submitPrompt).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('resubmits a legacy admission after a transport failure', async () => {
    const { actions } = createActions();
    vi.mocked(actions.enqueueMidTurnMessage).mockRejectedValue(
      new Error('connection lost'),
    );
    mount('responding', actions);

    act(() => latest.enqueuePrompt('do not lose me'));
    await act(async () => {});

    expect(actions.submitPrompt).toHaveBeenCalledWith(
      'do not lose me',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(actions.submitPrompt).toHaveBeenCalledOnce();
    expect(latest.queuedPrompts).toMatchObject([
      { text: 'do not lose me', serverState: 'submitting' },
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

  it('restores an edited prompt after a same-id attachment replacement', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-edit',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('修改后保留'));
    await act(async () => {});
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = latest.editQueuedPrompt(1);
    });
    render('responding', 'session-1', true);
    await act(async () => {
      removal.resolve({ removed: true });
      await editPromise;
    });

    expect(editor.setText).toHaveBeenCalledWith('修改后保留');
    expect(editor.setText).toHaveBeenCalledOnce();
    expect(editor.focus).toHaveBeenCalled();
  });

  it('restores an edited prompt when switching to a different session', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-cross-session-edit',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('切换后保留'));
    await act(async () => {});
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = latest.editQueuedPrompt(1);
    });
    render('responding', 'session-2', true);
    await act(async () => {
      removal.resolve({ removed: true });
      await editPromise;
    });

    expect(editor.setText).toHaveBeenCalledWith('切换后保留');
    expect(editor.setText).toHaveBeenCalledOnce();
    expect(latest.queuedPrompts).toEqual([]);
  });

  it('does not restore an edited prompt when cross-session removal loses', async () => {
    const { actions } = createActions();
    const removal = deferred<{ removed: boolean }>();
    vi.mocked(actions.enqueueMidTurnMessage).mockResolvedValue({
      accepted: true,
      messageId: 'mid-cross-session-edit-lost',
    });
    vi.mocked(actions.removeMidTurnMessage).mockReturnValue(removal.promise);
    const { editor, render } = mount('responding', actions);

    act(() => latest.enqueuePrompt('仍在服务端'));
    await act(async () => {});
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = latest.editQueuedPrompt(1);
    });
    render('responding', 'session-2', true);
    expect(editor.setText).not.toHaveBeenCalled();
    await act(async () => {
      removal.resolve({ removed: false });
      await editPromise;
    });

    expect(editor.setText).not.toHaveBeenCalled();
    expect(latest.queuedPrompts).toEqual([]);
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
      latest.enqueuePrompt('@file.ts fix', undefined, undefined, undefined, [
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

  it('retains mid-turn rows and drops in-flight pending admissions on clear', async () => {
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

  it('clears a submitting row after the server confirms abort cleanup', async () => {
    const { actions, pendingSubmit } = createActions();
    mount('responding', actions);

    act(() =>
      latest.enqueuePrompt('clear me', [
        { data: 'eA==', media_type: 'image/png' },
      ]),
    );
    act(() => latest.clearQueuedPrompts());
    expect(latest.queuedPrompts).toEqual([]);

    await act(async () => {
      pendingSubmit.resolve({
        promptId: 'server-cleared',
        removedAfterAbort: true,
      });
      await Promise.resolve();
    });

    expect(latest.queuedPrompts).toEqual([]);
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
