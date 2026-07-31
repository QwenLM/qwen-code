// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  type ComposerSubmitCommit,
  useComposerCore,
  type UseComposerCoreOptions,
  type UseComposerCoreReturn,
} from './useComposerCore';
import { getPromptHistoryStorageKey } from './useInputHistory';
import type {
  UserMessageContentParser,
  WebShellComposerInput,
} from '../customization';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function Harness({
  composerInput,
  onSubmit,
  renderComposerTag,
  renderComposerTagTooltip,
  parseUserMessageContent,
  followupState,
  sessionId,
  atWorkspaceCwd,
  commands,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
  parseUserMessageContent?: UserMessageContentParser;
  followupState?: {
    isVisible: boolean;
    shownAt: number;
    suggestion: string | null;
  };
  sessionId?: string;
  atWorkspaceCwd?: string;
  commands?: UseComposerCoreOptions['commands'];
}) {
  const composer = useComposerCore({
    onSubmit,
    commands: commands ?? [],
    editorTheme: {},
    renderComposerTag,
    renderComposerTagTooltip,
    parseUserMessageContent,
    followupState,
    sessionId,
    atWorkspaceCwd,
    composerInput,
    composerInputVersion: composerInput ? 1 : undefined,
  });
  latest = composer;

  return <div ref={composer.containerRef} />;
}

async function mount({
  composerInput,
  onSubmit = vi.fn(),
  renderComposerTag,
  renderComposerTagTooltip,
  parseUserMessageContent,
  followupState,
  sessionId,
  atWorkspaceCwd,
  commands,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit?: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
  parseUserMessageContent?: UserMessageContentParser;
  followupState?: {
    isVisible: boolean;
    shownAt: number;
    suggestion: string | null;
  };
  sessionId?: string;
  atWorkspaceCwd?: string;
  commands?: UseComposerCoreOptions['commands'];
} = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  let currentPortalRoot: HTMLElement | null = null;
  let currentSessionId = sessionId;
  let currentWorkspaceCwd = atWorkspaceCwd;
  const render = () => {
    root!.render(
      <WebShellPortalRootContext.Provider value={currentPortalRoot}>
        <I18nProvider language="en">
          <Harness
            composerInput={composerInput}
            onSubmit={onSubmit}
            renderComposerTag={renderComposerTag}
            renderComposerTagTooltip={renderComposerTagTooltip}
            parseUserMessageContent={parseUserMessageContent}
            followupState={followupState}
            sessionId={currentSessionId}
            atWorkspaceCwd={currentWorkspaceCwd}
            commands={commands}
          />
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    );
  };

  await act(async () => {
    render();
  });
  return {
    onSubmit,
    setPortalRoot(portalRoot: HTMLElement | null) {
      currentPortalRoot = portalRoot;
      act(() => render());
    },
    switchSession(
      nextSessionId: string | undefined,
      nextWorkspaceCwd: string | undefined,
    ) {
      currentSessionId = nextSessionId;
      currentWorkspaceCwd = nextWorkspaceCwd;
      act(() => render());
    },
    rerender() {
      act(() => render());
    },
  };
}

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  container?.remove();
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (
      key === 'qwen-web-shell-command-history' ||
      key?.startsWith('qwen-web-shell-history') ||
      key?.startsWith('qwen-web-shell-session-draft:') ||
      key?.startsWith('qwen-web-shell-pending-task-draft:')
    ) {
      localStorage.removeItem(key);
    }
  }
  document.getElementById('web-shell-tooltip-styles')?.remove();
  root = null;
  container = null;
  latest = null;
});

function pressHistoryKey(key: 'ArrowUp' | 'ArrowDown') {
  const editor = container!.querySelector('.cm-content')!;
  editor.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code: key,
      bubbles: true,
    }),
  );
}

function blurEditor() {
  container!.querySelector('.cm-editor')!.dispatchEvent(new FocusEvent('blur'));
}

function getSessionDraftKey(sessionId: string): string {
  return `qwen-web-shell-session-draft:${encodeURIComponent(sessionId)}`;
}

function getPendingTaskDraftKey(workspaceCwd: string): string {
  return `qwen-web-shell-pending-task-draft:${encodeURIComponent(workspaceCwd)}`;
}

describe('useComposerCore tooltip portal', () => {
  it('moves the CodeMirror tooltip portal and styles into the shared shadow root', async () => {
    const { setPortalRoot } = await mount();
    const tooltipPortal = document.querySelector(
      '[data-web-shell-tooltip-portal]',
    );
    expect(tooltipPortal?.parentElement).toBe(document.body);

    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const portalRoot = document.createElement('div');
    shadowRoot.append(portalRoot);

    setPortalRoot(portalRoot);

    expect(tooltipPortal?.parentElement).toBe(portalRoot);
    expect(
      shadowRoot.getElementById('web-shell-tooltip-styles'),
    ).not.toBeNull();
    host.remove();
  });
});

describe('useComposerCore history and drafts', () => {
  it('does not serialize the whole document again for a slash menu refresh', async () => {
    await mount();
    const doc = latest!.viewRef.current!.state.doc;
    const textPrototype = Object.getPrototypeOf(
      Object.getPrototypeOf(doc),
    ) as typeof doc;
    const toString = vi.spyOn(textPrototype, 'toString');

    act(() =>
      latest!.setText(
        `${Array.from({ length: 10_000 }, () => 'draft').join('\n')}\n/`,
      ),
    );

    expect(toString).toHaveBeenCalledOnce();
  });

  it('keeps slash completion replacement coordinates absolute', async () => {
    await mount({
      commands: [
        {
          name: 'help',
          description: 'Show help',
          source: 'builtin-command',
        },
      ],
    });

    act(() => latest!.setText('context\n/he'));

    expect(latest!.slashMenu).toMatchObject({ from: 8, to: 11 });
    act(() => latest!.acceptSlashCompletion());
    expect(latest!.getText()).toBe('context\n/help ');
  });

  it('does not reread history storage on unrelated rerenders', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });
    const readsAfterMount = getItem.mock.calls.length;

    mounted.rerender();

    expect(getItem).toHaveBeenCalledTimes(readsAfterMount);
  });

  it('falls back to legacy prompt history until the workspace has its own history', async () => {
    localStorage.setItem(
      getPromptHistoryStorageKey(),
      JSON.stringify(['legacy prompt']),
    );
    await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });

    act(() => pressHistoryKey('ArrowUp'));
    expect(latest!.getText()).toBe('legacy prompt');

    act(() => latest!.submitText());
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/a')) ??
          '[]',
      ),
    ).toEqual(['legacy prompt']);

    act(() => {
      latest!.setText('workspace prompt');
      latest!.submitText();
    });
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/a')) ??
          '[]',
      ),
    ).toEqual(['legacy prompt', 'workspace prompt']);
  });

  it('isolates prompt history by workspace and reloads it when the workspace changes', async () => {
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });

    act(() => {
      latest!.setText('prompt from a');
      latest!.submitText();
    });

    mounted.switchSession('session-b', '/workspace/b');
    act(() => {
      latest!.setText('prompt from b');
      latest!.submitText();
      pressHistoryKey('ArrowUp');
    });
    expect(latest!.getText()).toBe('prompt from b');

    mounted.switchSession('session-a', '/workspace/a');
    act(() => pressHistoryKey('ArrowUp'));
    expect(latest!.getText()).toBe('prompt from a');

    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/a')) ??
          '[]',
      ),
    ).toEqual(['prompt from a']);
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/b')) ??
          '[]',
      ),
    ).toEqual(['prompt from b']);
  });

  it('resets history navigation when the session changes', async () => {
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/shared',
    });

    act(() => {
      latest!.setText('oldest');
      latest!.submitText();
      latest!.setText('newest');
      latest!.submitText();
      latest!.setText('draft a');
      pressHistoryKey('ArrowUp');
    });
    expect(latest!.getText()).toBe('newest');

    mounted.switchSession('session-b', '/workspace/shared');
    act(() => pressHistoryKey('ArrowUp'));
    expect(latest!.getText()).toBe('newest');

    mounted.switchSession('session-a', '/workspace/shared');
    expect(latest!.getText()).toBe('draft a');
  });

  it('restores unsent text for each session and clears accepted drafts', async () => {
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/shared',
    });

    act(() => latest!.setText('draft a'));
    mounted.switchSession('session-b', '/workspace/shared');
    expect(latest!.getText()).toBe('');

    act(() => latest!.setText('draft b'));
    mounted.switchSession('session-a', '/workspace/shared');
    expect(latest!.getText()).toBe('draft a');

    mounted.switchSession('session-b', '/workspace/shared');
    expect(latest!.getText()).toBe('draft b');

    act(() => latest!.submitText());
    expect(localStorage.getItem(getSessionDraftKey('session-b'))).toBeNull();
  });

  it('restores an unsent new-task draft after leaving and returning', async () => {
    vi.useFakeTimers();
    const workspaceCwd = '/workspace/shared';
    const mounted = await mount({ atWorkspaceCwd: workspaceCwd });

    act(() => latest!.setText('new task draft still typing'));
    expect(
      localStorage.getItem(getPendingTaskDraftKey(workspaceCwd)),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(1999));
    expect(
      localStorage.getItem(getPendingTaskDraftKey(workspaceCwd)),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(localStorage.getItem(getPendingTaskDraftKey(workspaceCwd))).toBe(
      'new task draft still typing',
    );

    act(() => latest!.setText('draft flushed on switch'));
    mounted.switchSession('session-a', workspaceCwd);
    expect(latest!.getText()).toBe('');
    expect(localStorage.getItem(getPendingTaskDraftKey(workspaceCwd))).toBe(
      'draft flushed on switch',
    );

    mounted.switchSession(undefined, '/workspace/other');
    expect(latest!.getText()).toBe('');

    mounted.switchSession(undefined, workspaceCwd);
    expect(latest!.getText()).toBe('draft flushed on switch');

    act(() => latest!.setText('draft flushed on unmount'));
    act(() => root?.unmount());
    expect(localStorage.getItem(getPendingTaskDraftKey(workspaceCwd))).toBe(
      'draft flushed on unmount',
    );
    container?.remove();
    root = null;
    container = null;
    latest = null;

    await mount({ atWorkspaceCwd: workspaceCwd });
    expect(latest!.getText()).toBe('draft flushed on unmount');
  });

  it('keeps an unscoped new-task draft in memory until its workspace resolves', async () => {
    localStorage.setItem(
      'qwen-web-shell-pending-task-draft:',
      'draft from another workspace',
    );
    const mounted = await mount();

    expect(latest!.getText()).toBe('');
    act(() => latest!.setText('current pending draft'));

    mounted.switchSession(undefined, '/workspace/current');

    expect(latest!.getText()).toBe('current pending draft');
    expect(
      localStorage.getItem(getPendingTaskDraftKey('/workspace/current')),
    ).toBe('current pending draft');
    expect(localStorage.getItem('qwen-web-shell-pending-task-draft:')).toBe(
      'draft from another workspace',
    );
  });

  it('keeps newer unscoped input when the resolved workspace has an older draft', async () => {
    const workspaceCwd = '/workspace/current';
    localStorage.setItem(
      getPendingTaskDraftKey(workspaceCwd),
      'older persisted draft',
    );
    const mounted = await mount();

    act(() => latest!.setText('newer in-memory draft'));
    mounted.switchSession(undefined, workspaceCwd);

    expect(latest!.getText()).toBe('newer in-memory draft');
    expect(localStorage.getItem(getPendingTaskDraftKey(workspaceCwd))).toBe(
      'newer in-memory draft',
    );
  });

  it('restores an older workspace draft after a programmatic unscoped reset', async () => {
    const workspaceCwd = '/workspace/current';
    localStorage.setItem(
      getPendingTaskDraftKey(workspaceCwd),
      'persisted workspace draft',
    );
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });

    mounted.switchSession(undefined, undefined);
    mounted.switchSession(undefined, workspaceCwd);

    expect(latest!.getText()).toBe('persisted workspace draft');
  });

  it('commits a new-task prompt after its session is allocated', async () => {
    let commitPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitPrompt = commitAccepted;
        return false;
      },
    );
    const workspaceCwd = '/workspace/new-task';
    const mounted = await mount({ onSubmit, atWorkspaceCwd: workspaceCwd });

    act(() => {
      latest!.setText('first prompt');
      latest!.submitText();
    });
    mounted.switchSession('session-created', workspaceCwd);
    expect(latest!.getText()).toBe('');

    act(() => commitPrompt?.());

    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey(workspaceCwd)) ?? '[]',
      ),
    ).toEqual(['first prompt']);
    expect(
      localStorage.getItem(getPendingTaskDraftKey(workspaceCwd)),
    ).toBeNull();
  });

  it('commits a delayed queued prompt to history exactly once', async () => {
    let commitQueuedPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitQueuedPrompt = commitAccepted;
        return false;
      },
    );
    await mount({
      onSubmit,
      sessionId: 'queued-session',
      atWorkspaceCwd: '/workspace/queue',
    });

    act(() => latest!.setText('stale saved draft'));
    act(() => blurEditor());
    expect(localStorage.getItem(getSessionDraftKey('queued-session'))).toBe(
      'stale saved draft',
    );

    act(() => {
      latest!.setText('queued prompt');
      latest!.submitText();
    });
    expect(latest!.getText()).toBe('queued prompt');
    expect(
      localStorage.getItem(getPromptHistoryStorageKey('/workspace/queue')),
    ).toBeNull();

    act(() => {
      commitQueuedPrompt?.();
      commitQueuedPrompt?.();
    });
    expect(latest!.getText()).toBe('');
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/queue')) ??
          '[]',
      ),
    ).toEqual(['queued prompt']);
    expect(
      localStorage.getItem(getSessionDraftKey('queued-session')),
    ).toBeNull();
  });

  it('does not clear newer input when a prompt is accepted in the same session', async () => {
    vi.useFakeTimers();
    let commitQueuedPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitQueuedPrompt = commitAccepted;
        return false;
      },
    );
    await mount({
      onSubmit,
      sessionId: 'queued-session',
      atWorkspaceCwd: '/workspace/queue',
    });

    act(() => {
      latest!.setText('queued prompt');
      latest!.submitText();
      latest!.setText('newer draft');
      latest!.addTags([
        {
          id: 'newer-tag',
          value: 'newer tag',
          serialized: '@newer-tag',
        },
      ]);
    });
    act(() => commitQueuedPrompt?.());

    expect(latest!.getText()).toBe('newer draft');
    expect(latest!.composerTags).toEqual([
      expect.objectContaining({ id: 'newer-tag' }),
    ]);
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/queue')) ??
          '[]',
      ),
    ).toEqual(['queued prompt']);

    act(() => vi.advanceTimersByTime(2000));
    expect(localStorage.getItem(getSessionDraftKey('queued-session'))).toBe(
      'newer draft',
    );
  });

  it('does not clear retyped identical input after delayed acceptance', async () => {
    let commitQueuedPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitQueuedPrompt = commitAccepted;
        return false;
      },
    );
    await mount({
      onSubmit,
      sessionId: 'queued-session',
      atWorkspaceCwd: '/workspace/queue',
    });

    act(() => {
      latest!.setText('same text');
      latest!.submitText();
      latest!.setText('');
      latest!.setText('same text');
    });
    act(() => commitQueuedPrompt?.());

    expect(latest!.getText()).toBe('same text');
  });

  it('does not clear the next session when a delayed prompt is accepted', async () => {
    let commitQueuedPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitQueuedPrompt = commitAccepted;
        return false;
      },
    );
    const mounted = await mount({
      onSubmit,
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });

    act(() => {
      latest!.setText('queued in a');
      latest!.submitText();
    });
    mounted.switchSession('session-b', '/workspace/b');
    act(() => latest!.setText('draft b'));
    act(() => commitQueuedPrompt?.());

    expect(latest!.getText()).toBe('draft b');
    expect(localStorage.getItem(getSessionDraftKey('session-b'))).toBeNull();
    act(() => blurEditor());
    expect(localStorage.getItem(getSessionDraftKey('session-b'))).toBe(
      'draft b',
    );
    expect(
      JSON.parse(
        localStorage.getItem(getPromptHistoryStorageKey('/workspace/a')) ??
          '[]',
      ),
    ).toEqual(['queued in a']);
    expect(
      localStorage.getItem(getPromptHistoryStorageKey('/workspace/b')),
    ).toBeNull();
  });

  it('updates in-memory history for a delayed prompt in the same workspace', async () => {
    vi.useFakeTimers();
    let commitQueuedPrompt: ComposerSubmitCommit | undefined;
    const onSubmit = vi.fn<UseComposerCoreOptions['onSubmit']>(
      (_text, _images, commitAccepted) => {
        commitQueuedPrompt = commitAccepted;
        return false;
      },
    );
    const mounted = await mount({
      onSubmit,
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/shared',
    });

    act(() => {
      latest!.setText('queued in a');
      latest!.submitText();
    });
    mounted.switchSession('session-b', '/workspace/shared');
    act(() => latest!.setText('draft b'));
    act(() => commitQueuedPrompt?.());
    act(() => pressHistoryKey('ArrowUp'));

    expect(latest!.getText()).toBe('queued in a');
    act(() => vi.advanceTimersByTime(2000));
    expect(localStorage.getItem(getSessionDraftKey('session-b'))).toBe(
      'draft b',
    );
  });

  it('closes history search when the session or workspace changes', async () => {
    const mounted = await mount({
      sessionId: 'session-a',
      atWorkspaceCwd: '/workspace/a',
    });
    act(() => {
      latest!.setText('prompt from a');
      latest!.submitText();
      latest!.searchState.openHistorySearch();
    });
    expect(latest!.searchState.searchMode).toBe(true);
    expect(latest!.searchState.searchMatches).toEqual(['prompt from a']);

    mounted.switchSession('session-b', '/workspace/b');
    expect(latest!.searchState.searchMode).toBe(false);
    expect(latest!.searchState.searchMatches).toEqual([]);
  });

  it('flushes the draft to localStorage on visibilitychange and pagehide', async () => {
    vi.useFakeTimers();
    await mount({
      sessionId: 'vis-session',
      atWorkspaceCwd: '/workspace/vis',
    });

    act(() => latest!.setText('draft before hide'));
    expect(localStorage.getItem(getSessionDraftKey('vis-session'))).toBeNull();

    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(localStorage.getItem(getSessionDraftKey('vis-session'))).toBe(
      'draft before hide',
    );

    act(() => latest!.setText('draft before pagehide'));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });
    expect(localStorage.getItem(getSessionDraftKey('vis-session'))).toBe(
      'draft before pagehide',
    );

    Object.defineProperty(document, 'visibilityState', {
      value: originalVisibility,
      configurable: true,
    });
  });
});

describe('useComposerCore tags', () => {
  it('keeps the composer API stable across tag updates', async () => {
    await mount();
    const api = latest!.handle;

    act(() => {
      api.addTags([{ id: 'orders', value: 'orders' }]);
    });

    expect(latest!.handle).toBe(api);
  });

  it('does not rerender when removing a missing tag', async () => {
    await mount();
    const render = latest;
    const dispatch = vi.spyOn(latest!.viewRef.current!, 'dispatch');

    act(() => {
      latest!.handle.removeTag('missing');
    });

    expect(latest).toBe(render);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls back when inline custom tag rendering throws', async () => {
    const error = new Error('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTag: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag renderContent failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('falls back when inline custom tag tooltip rendering throws', async () => {
    const error = new Error('bad tooltip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag tooltip render failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('uses a custom inline tooltip without a native title', async () => {
    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => 'Details',
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Details');
    expect(tooltip?.parentElement?.getAttribute('title')).toBeNull();
    expect(tooltip?.id).toBeTruthy();
    expect(tooltip?.parentElement?.getAttribute('aria-describedby')).toBe(
      tooltip?.id,
    );
  });

  it('falls back to a native title when attaching an inline tooltip fails', async () => {
    const error = new Error('append failed');
    const appendChild = HTMLElement.prototype.appendChild;
    let failingTooltip: HTMLElement | null = null;
    let readFailingChipTitle: (() => string) | null = null;
    let dispatchOnFailingChip: ((event: Event) => boolean) | null = null;
    const appendChildSpy = vi
      .spyOn(HTMLElement.prototype, 'appendChild')
      .mockImplementation(function (child) {
        if (
          child instanceof HTMLElement &&
          child.getAttribute('role') === 'tooltip'
        ) {
          failingTooltip = child;
          readFailingChipTitle = () => this.title;
          dispatchOnFailingChip = (event) => this.dispatchEvent(event);
          throw error;
        }
        return appendChild.call(this, child);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      expect(readFailingChipTitle?.()).toBe('Details');
    });

    try {
      await mount({
        composerInput: {
          tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
          tagPlacement: 'inline',
        },
        renderComposerTagTooltip: () => 'Details',
      });

      expect(warn).toHaveBeenCalledWith(
        '[WebShell] inline tag tooltip render failed',
        error,
      );
      const chip = document.body.querySelector('[title="Details"]');
      expect(chip).not.toBeNull();
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      dispatchOnFailingChip?.(new MouseEvent('mouseenter'));
      expect(failingTooltip?.style.display).toBe('none');
    } finally {
      warn.mockRestore();
      appendChildSpy.mockRestore();
    }
  });

  it('guards inline mask icon sources', async () => {
    await mount({
      composerInput: {
        tags: [
          {
            id: 'orders',
            label: 'Table',
            value: 'orders',
            icon: 'javascript:alert(1)',
          },
        ],
        tagPlacement: 'inline',
      },
    });

    expect(document.body.innerHTML).not.toContain('javascript:alert');
    expect(
      document.body.querySelector('[style*="--composer-tag-icon-url"]'),
    ).toBeNull();
  });

  it('renders built-in icons for inline composer tags', async () => {
    const kinds = ['extension', 'file', 'mcp', 'skill'] as const;
    await mount({
      composerInput: {
        tags: kinds.map((kind) => ({
          id: `${kind}:reference`,
          kind,
          value: kind,
          serialized: `@${kind}:reference`,
        })),
        tagPlacement: 'inline',
      },
    });

    expect(
      document.body.querySelectorAll('[style*="--composer-tag-icon-url"]'),
    ).toHaveLength(kinds.length);
  });

  it('reports inline composer tags as attachments', async () => {
    await mount();

    expect(latest!.handle.hasAttachments()).toBe(false);
    expect(latest!.hasAttachments).toBe(false);

    act(() => {
      latest!.addTags(
        [{ id: 'orders', value: 'orders', serialized: '@orders' }],
        { placement: 'inline' },
      );
    });
    expect(latest!.handle.hasAttachments()).toBe(true);
    expect(latest!.hasAttachments).toBe(true);

    act(() => {
      latest!.removeInlineTags();
    });
    expect(latest!.handle.hasAttachments()).toBe(false);
    expect(latest!.hasAttachments).toBe(false);
  });

  it('updates inline tag state when a document change removes the last tag', async () => {
    await mount();

    act(() => {
      latest!.addTags(
        [{ id: 'orders', value: 'orders', serialized: '@orders' }],
        { placement: 'inline' },
      );
    });
    expect(latest!.hasAttachments).toBe(true);

    const view = latest!.viewRef.current!;
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
      });
    });

    expect(latest!.hasAttachments).toBe(false);
  });

  it('keeps inline tags after trimming leading whitespace on submit', async () => {
    const { onSubmit } = await mount();

    act(() => {
      latest!.setText('  ');
      latest!.addTags(
        [{ id: 'orders', value: 'orders', serialized: '<table />' }],
        { placement: 'inline' },
      );
      latest!.insertText('explain');
      latest!.submitText();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      '<table /> explain',
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          {
            end: 9,
            reference: {
              id: 'orders',
              serialized: '<table />',
              value: 'orders',
            },
            start: 0,
            text: '<table />',
            type: 'reference',
          },
        ],
      },
    );
  });

  it('restores parsed inline tags when arrow keys browse prompt history', async () => {
    const serialized = '<context id="orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) => {
      if (content !== prompt) return undefined;
      return [
        { type: 'text', text: 'inspect ' },
        {
          type: 'tag',
          tag: { id: 'orders', value: 'orders', serialized },
        },
        { type: 'text', text: ' now' },
      ];
    };
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(editor.textContent).toContain('inspect');
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );

    act(() => {
      latest!.setText('draft');
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          code: 'ArrowDown',
          bubbles: true,
        }),
      );
    });
    expect(latest!.getText()).toBe('draft');
    expect(editor.textContent).not.toContain('orders');
  });

  it('restores shell history as raw command text without parsing tags', async () => {
    const serialized = '<context id="orders">orders</context>';
    const command = `echo ${serialized}`;
    const parseUserMessageContent = vi.fn<UserMessageContentParser>(
      (content) =>
        content === command
          ? [
              { type: 'text', text: 'echo ' },
              {
                type: 'tag',
                tag: { id: 'orders', value: 'orders', serialized },
              },
            ]
          : undefined,
    );
    await mount({ parseUserMessageContent });

    act(() => {
      latest!.setShellMode(true);
    });
    act(() => {
      latest!.setText(command);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(command);
    expect(editor.textContent).toBe(command);
    expect(
      editor.querySelectorAll('button[aria-label^="Remove "]'),
    ).toHaveLength(0);
    expect(parseUserMessageContent).not.toHaveBeenCalled();
  });

  it('restores draft top tags after ArrowDown exits prompt history', async () => {
    const historyText = 'previous prompt';
    const draftText = 'draft prompt';
    const draftTag = {
      id: 'file:draft.txt',
      value: 'draft.txt',
      serialized: '@draft.txt',
    };
    await mount();

    act(() => {
      latest!.setText(historyText);
      latest!.submitText();
      latest!.setText(draftText);
      latest!.addTags([draftTag]);
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(historyText);
    expect(latest!.composerTags).toEqual([]);

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          code: 'ArrowDown',
          bubbles: true,
        }),
      );
    });

    expect(latest!.getText()).toBe(draftText);
    expect(latest!.composerTags).toEqual([draftTag]);
  });

  it('restores tags when Tab or a search-result selection recalls history', async () => {
    const serialized = '<context id="search-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });

    const preventDefault = vi.fn();
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Tab',
        nativeEvent: { isComposing: false },
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });

    const editor = container!.querySelector('.cm-content')!;
    expect(preventDefault).toHaveBeenCalled();
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => latest!.searchState.restoreSearchMatch?.(prompt));
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Enter',
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
  });

  it('does not prepend stale top tags when Ctrl-R submits a recalled inline tag', async () => {
    const serialized = '<context id="search-stale-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
    });
    act(() => {
      latest!.addTags([
        {
          id: 'stale',
          value: 'stale',
          serialized: '<context id="stale">stale</context>',
        },
      ]);
    });
    expect(latest!.composerTags).toHaveLength(1);

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
    });
    act(() => {
      latest!.searchState.handleSearchKeyDown({
        key: 'Enter',
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>);
    });

    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
  });

  it('submits the selected plain Ctrl-R history text instead of a visible followup', async () => {
    const historyText = 'inspect the orders';
    localStorage.setItem(
      'qwen-web-shell-history',
      JSON.stringify([historyText]),
    );
    const { onSubmit } = await mount({
      followupState: {
        isVisible: true,
        shownAt: Date.now(),
        suggestion: 'inspect the orders table and summarize',
      },
    });

    act(() => {
      latest!.setText('draft');
      latest!.searchState.openHistorySearch();
      latest!.searchState.submitSearchMatch(historyText);
    });

    expect(onSubmit).toHaveBeenLastCalledWith(
      historyText,
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('keeps history source text and skips annotations for mismatched parser output', async () => {
    const prompt = '<context id="orders">orders</context>';
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            {
              type: 'tag',
              tag: {
                id: 'orders',
                value: 'orders',
                serialized: '<context id="other">other</context>',
              },
            },
          ]
        : undefined;
    const { onSubmit } = await mount({ parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.setText('draft');
    });

    const editor = container!.querySelector('.cm-content')!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });

    expect(editor.textContent).toContain(prompt);
    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('restores tags when a history search submission is rejected', async () => {
    const serialized = '<context id="rejected-orders">orders</context>';
    const prompt = `inspect ${serialized} now`;
    const parseUserMessageContent: UserMessageContentParser = (content) =>
      content === prompt
        ? [
            { type: 'text', text: 'inspect ' },
            {
              type: 'tag',
              tag: { id: 'orders', value: 'orders', serialized },
            },
            { type: 'text', text: ' now' },
          ]
        : undefined;
    const onSubmit = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(false);
    await mount({ onSubmit, parseUserMessageContent });

    act(() => {
      latest!.setText(prompt);
      latest!.submitText();
      latest!.searchState.submitSearchMatch(prompt);
    });

    const editor = container!.querySelector('.cm-content')!;
    expect(onSubmit).toHaveBeenLastCalledWith(
      prompt,
      undefined,
      expect.any(Function),
      {
        inputAnnotations: [
          expect.objectContaining({
            start: 8,
            end: 8 + serialized.length,
            text: serialized,
            reference: expect.objectContaining({ id: 'orders', serialized }),
          }),
        ],
      },
    );
    expect(editor.textContent).toContain('orders');
    expect(editor.textContent).not.toContain(serialized);
  });
});
