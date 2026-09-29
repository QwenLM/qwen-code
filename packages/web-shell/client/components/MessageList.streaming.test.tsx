// @vitest-environment jsdom
import { act, startTransition, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, PermissionRequest } from '../adapters/types';
import {
  WebShellCustomizationProvider,
  type MarkdownRenderContext,
} from '../customization';
import { I18nProvider } from '../i18n';
import { TranscriptRenderModeProvider } from '../transcriptRenderMode';

vi.mock('../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
    TodoTimelineContext: createContext(new Map()),
    TodoDetailContext: createContext(new Map()),
  };
});

const { CompactModeContext } = await import('../WebShellContexts');
const { MessageList } = await import('./MessageList');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

type StreamingRole = 'assistant' | 'thinking' | 'tool_group';
const content = 'Answer [source](https://example.com/incomplete';

function messageFor(role: StreamingRole, isStreaming: boolean): Message {
  if (role === 'tool_group') {
    return {
      id: 'response',
      role,
      tools: [{ callId: 'read-1', toolName: 'ReadFile', status: 'completed' }],
      thoughts: [{ content, isStreaming }],
    };
  }
  return { id: 'response', role, content, isStreaming };
}

function markdownSource(role: StreamingRole): 'assistant' | 'thinking' {
  return role === 'assistant' ? 'assistant' : 'thinking';
}

interface RenderOptions {
  compactMode?: boolean;
  pendingApproval?: PermissionRequest | null;
  sessionKey?: string;
}

function mountMessages(
  messages: Message[],
  renderMode: 'document' | 'interactive' = 'document',
) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const transformMarkdown = vi.fn(
    (_content: string, context: MarkdownRenderContext) =>
      context.isStreaming ? 'citation pending' : 'citation settled',
  );
  const customization = { markdown: { transformMarkdown } };
  const render = (
    isResponding: boolean,
    nextMessages: Message[] = messages,
    options: RenderOptions = {},
  ) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WebShellCustomizationProvider value={customization}>
            <CompactModeContext.Provider value={options.compactMode ?? false}>
              <TranscriptRenderModeProvider value={renderMode}>
                <MessageList
                  messages={nextMessages}
                  pendingApproval={options.pendingApproval ?? null}
                  isResponding={isResponding}
                  sessionKey={options.sessionKey}
                />
              </TranscriptRenderModeProvider>
            </CompactModeContext.Provider>
          </WebShellCustomizationProvider>
        </I18nProvider>,
      );
    });
  };
  return { container, transformMarkdown, render };
}

function mountTranscript(
  role: StreamingRole,
  isStreaming: boolean,
  renderMode: 'document' | 'interactive' = 'document',
) {
  const message = messageFor(role, isStreaming);
  const mountedView = mountMessages(
    [{ id: 'prompt', role: 'user', content: 'Question' }, message],
    renderMode,
  );
  return { ...mountedView, message };
}

describe('MessageList effective Markdown streaming state', () => {
  it('settles the visible interactive assistant row when the session becomes idle', () => {
    const { container, transformMarkdown, render } = mountTranscript(
      'assistant',
      true,
      'interactive',
    );
    render(true);
    expect(container.textContent).toContain('citation pending');
    render(false);
    expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
      source: 'assistant',
      isStreaming: false,
    });
    expect(container.textContent).toContain('citation settled');
    expect(container.textContent).not.toContain('citation pending');
  });

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'settles stale %s content when only the session response state completes',
    (role) => {
      const { container, message, transformMarkdown, render } = mountTranscript(
        role,
        true,
      );
      const source = role === 'assistant' ? 'assistant' : 'thinking';

      render(true);
      expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
        source,
        isStreaming: true,
      });
      expect(container.textContent).toContain('citation pending');
      const activeCalls = transformMarkdown.mock.calls.length;

      render(false);
      expect(transformMarkdown.mock.calls.length).toBeGreaterThan(activeCalls);
      expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
        source,
        isStreaming: false,
      });
      expect(container.textContent).toContain('citation settled');
      expect(container.textContent).not.toContain('citation pending');
      expect(message).toEqual(messageFor(role, true));
    },
  );

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'renders stale historical %s content as settled on initial idle mount',
    (role) => {
      const { container, transformMarkdown, render } = mountTranscript(
        role,
        true,
      );
      render(false);
      expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
        source: role === 'assistant' ? 'assistant' : 'thinking',
        isStreaming: false,
      });
      expect(container.textContent).toContain('citation settled');
      expect(container.textContent).not.toContain('citation pending');
    },
  );

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'keeps an already-settled %s row settled when the session becomes active',
    (role) => {
      const { container, transformMarkdown, render } = mountTranscript(
        role,
        false,
      );
      render(false);
      render(true);
      expect(transformMarkdown.mock.calls.length).toBeGreaterThan(0);
      expect(
        transformMarkdown.mock.calls.every(
          ([, context]) => context.isStreaming === false,
        ),
      ).toBe(true);
      expect(container.textContent).toContain('citation settled');
      expect(container.textContent).not.toContain('citation pending');
    },
  );

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'does not revive a settled stale %s row when the session becomes active',
    (role) => {
      const { container, transformMarkdown, render } = mountTranscript(
        role,
        true,
      );
      render(false);
      expect(container.textContent).toContain('citation settled');

      render(true);
      expect(
        transformMarkdown.mock.calls.every(
          ([, context]) => context.isStreaming === false,
        ),
      ).toBe(true);
      expect(container.textContent).toContain('citation settled');
      expect(container.textContent).not.toContain('citation pending');
    },
  );

  it('keeps a new live turn streaming while a settled stale row stays settled', () => {
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const stale = messageFor('assistant', true);
    const { container, transformMarkdown, render } = mountMessages([
      prompt,
      stale,
    ]);
    render(false);
    expect(container.textContent).toContain('citation settled');

    render(true, [
      prompt,
      stale,
      { id: 'prompt-2', role: 'user', content: 'Follow up' },
      {
        id: 'live',
        role: 'assistant',
        content: 'Live answer',
        isStreaming: true,
      },
    ]);

    const staleCalls = transformMarkdown.mock.calls.filter(
      ([text]) => text === content,
    );
    expect(staleCalls.length).toBeGreaterThan(0);
    expect(
      staleCalls.every(([, context]) => context.isStreaming === false),
    ).toBe(true);
    expect(transformMarkdown).toHaveBeenCalledWith('Live answer', {
      source: 'assistant',
      isStreaming: true,
    });
    expect(container.textContent).toContain('citation settled');
    expect(container.textContent).toContain('citation pending');
  });

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'keeps a %s row streaming when it was not stale at idle',
    (role) => {
      const { transformMarkdown, render } = mountTranscript(role, false);
      render(false);

      // The same row later goes live; never having been latched, it must not
      // be force-settled.
      render(true, [
        { id: 'prompt', role: 'user', content: 'Question' },
        messageFor(role, true),
      ]);
      expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
        source: markdownSource(role),
        isStreaming: true,
      });
    },
  );

  it.each(['assistant', 'thinking', 'tool_group'] as const)(
    'releases a settled %s row whose content grows while responding',
    (role) => {
      // A genuinely live row caught in a false-idle window (e.g. the
      // failed-prompt-retry suppression window) gets latched; it must stream
      // again as soon as its content moves past the settle point.
      const prompt: Message = {
        id: 'prompt',
        role: 'user',
        content: 'Question',
      };
      const stale = messageFor(role, true);
      const { transformMarkdown, render } = mountMessages([prompt, stale]);
      render(false);
      expect(transformMarkdown).toHaveBeenLastCalledWith(content, {
        source: markdownSource(role),
        isStreaming: false,
      });

      const grown =
        role === 'tool_group'
          ? ({
              ...stale,
              thoughts: [{ content: `${content} more`, isStreaming: true }],
            } as Message)
          : ({
              ...stale,
              content: `${content} more`,
              isStreaming: true,
            } as Message);
      render(true, [prompt, grown]);
      expect(transformMarkdown).toHaveBeenLastCalledWith(`${content} more`, {
        source: markdownSource(role),
        isStreaming: true,
      });
    },
  );

  it('does not settle a re-projected row that reuses a latched id', () => {
    const { transformMarkdown, render } = mountMessages([
      { id: 'user-3', role: 'user', content: 'Question' },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Old answer',
        isStreaming: true,
      },
    ]);
    render(false);
    expect(transformMarkdown).toHaveBeenLastCalledWith('Old answer', {
      source: 'assistant',
      isStreaming: false,
    });

    // A transcript reload re-derives the projection and rewinds the block
    // ordinal counter, so the same id now denotes a different, live row.
    render(true, [
      { id: 'user-1', role: 'user', content: 'Question' },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Live answer streaming now',
        isStreaming: true,
      },
    ]);
    expect(transformMarkdown).toHaveBeenLastCalledWith(
      'Live answer streaming now',
      { source: 'assistant', isStreaming: true },
    );
  });

  it('ignores the settled latch of another session', () => {
    const { transformMarkdown, render } = mountMessages([
      { id: 'user-3', role: 'user', content: 'Question' },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Same words',
        isStreaming: true,
      },
    ]);
    render(false, undefined, { sessionKey: 'A' });
    expect(transformMarkdown).toHaveBeenLastCalledWith('Same words', {
      source: 'assistant',
      isStreaming: false,
    });

    // Session B's first commit reuses the block ordinal for a live row whose
    // content happens to match the settled stale row's.
    render(
      true,
      [
        { id: 'user-1', role: 'user', content: 'Question' },
        {
          id: 'assistant-4',
          role: 'assistant',
          content: 'Same words',
          isStreaming: true,
        },
      ],
      { sessionKey: 'B' },
    );
    expect(transformMarkdown).toHaveBeenLastCalledWith('Same words', {
      source: 'assistant',
      isStreaming: true,
    });
  });

  it('clears the settled latch when the transcript empties', () => {
    const { transformMarkdown, render } = mountMessages([
      { id: 'user-3', role: 'user', content: 'Question' },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Same words',
        isStreaming: true,
      },
    ]);
    render(false);
    render(false, []);

    // The rebuilt projection reuses the block ordinal for a row whose content
    // happens to match.
    render(true, [
      { id: 'user-1', role: 'user', content: 'Question' },
      {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Same words',
        isStreaming: true,
      },
    ]);
    expect(transformMarkdown).toHaveBeenLastCalledWith('Same words', {
      source: 'assistant',
      isStreaming: true,
    });
  });

  it('does not promote a latch written by an abandoned idle render', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const transformMarkdown = vi.fn(
      (_content: string, context: MarkdownRenderContext) =>
        context.isStreaming ? 'citation pending' : 'citation settled',
    );
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const stale: Message = {
      id: 'stale',
      role: 'assistant',
      content: 'Stale answer',
      isStreaming: true,
    };
    const live: Message = {
      id: 'live',
      role: 'assistant',
      content: 'Live one',
      isStreaming: true,
    };
    const never = new Promise<void>(() => {});
    const Suspend = () => {
      throw never;
    };
    // The Suspense boundary must be part of every render so the transition
    // render is abandoned rather than committed as a remount.
    const render = (
      isResponding: boolean,
      messages: Message[],
      suspend = false,
    ) => {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <WebShellCustomizationProvider
              value={{ markdown: { transformMarkdown } }}
            >
              <TranscriptRenderModeProvider value="document">
                <Suspense fallback={null}>
                  <MessageList
                    messages={messages}
                    pendingApproval={null}
                    isResponding={isResponding}
                  />
                  {suspend ? <Suspend /> : null}
                </Suspense>
              </TranscriptRenderModeProvider>
            </WebShellCustomizationProvider>
          </I18nProvider>,
        );
      });
    };
    render(false, [prompt, stale]);
    expect(transformMarkdown).toHaveBeenLastCalledWith('Stale answer', {
      source: 'assistant',
      isStreaming: false,
    });

    // An idle render that never commits latches the live row in the pending
    // ref; the next committed (responding) render must not promote it.
    await act(async () => {
      startTransition(() => {
        root.render(
          <I18nProvider language="en">
            <WebShellCustomizationProvider
              value={{ markdown: { transformMarkdown } }}
            >
              <TranscriptRenderModeProvider value="document">
                <Suspense fallback={null}>
                  <MessageList
                    messages={[prompt, stale, live]}
                    pendingApproval={null}
                    isResponding={false}
                  />
                  <Suspend />
                </Suspense>
              </TranscriptRenderModeProvider>
            </WebShellCustomizationProvider>
          </I18nProvider>,
        );
      });
      await Promise.resolve();
    });

    const abandonedCalls = transformMarkdown.mock.calls.length;
    render(true, [prompt, stale, live]);
    render(true, [prompt, stale, { ...live }]);
    const committedCalls = transformMarkdown.mock.calls.slice(abandonedCalls);
    // The abandoned render never committed: the first committed idle render's
    // latch still settles the stale row.
    const staleCalls = committedCalls.filter(
      ([text]) => text === 'Stale answer',
    );
    expect(staleCalls.length).toBeGreaterThan(0);
    expect(
      staleCalls.every(([, context]) => context.isStreaming === false),
    ).toBe(true);
    const liveCalls = committedCalls.filter(([text]) => text === 'Live one');
    expect(liveCalls.length).toBeGreaterThan(0);
    expect(liveCalls.every(([, context]) => context.isStreaming === true)).toBe(
      true,
    );
  });

  it('settles a compact aggregated thought across idle content-only ticks', () => {
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const tools: Message = {
      id: 'g1',
      role: 'tool_group',
      tools: [{ callId: 'call-g1', toolName: 'Read', status: 'completed' }],
    };
    const thought: Message = {
      id: 't1',
      role: 'thinking',
      content: 'plan',
      isStreaming: true,
      timestamp: 1_001,
    };
    const { transformMarkdown, render } = mountMessages([
      prompt,
      tools,
      thought,
    ]);
    render(false, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    render(false, [prompt, tools, { ...thought, content: 'plan delta' }], {
      compactMode: true,
    });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan delta', {
      source: 'thinking',
      isStreaming: false,
    });
  });

  it('keeps a settled compact thought settled when a pending approval force-expands its run', () => {
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const thought: Message = {
      id: 't1',
      role: 'thinking',
      content: 'plan',
      isStreaming: true,
    };
    const tools: Message = {
      id: 'g1',
      role: 'tool_group',
      tools: [{ callId: 'call-g1', toolName: 'Read', status: 'completed' }],
    };
    const approval: PermissionRequest = {
      id: 'perm-1',
      toolCallId: 'call-g1',
      content: [],
    };
    const { transformMarkdown, render } = mountMessages([
      prompt,
      thought,
      tools,
    ]);
    render(false, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    // Responding while still aggregated: stays settled.
    render(true, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    // The approval force-expands the run; the thought re-emits standalone and
    // must stay settled.
    render(true, undefined, { compactMode: true, pendingApproval: approval });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    // The approval resolves; the run re-aggregates and stays settled.
    render(true, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });
  });

  it('keeps a settled standalone thought settled when an adjoined tool group aggregates it', () => {
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const thought: Message = {
      id: 't1',
      role: 'thinking',
      content: 'plan',
      isStreaming: true,
    };
    const tools: Message = {
      id: 'g1',
      role: 'tool_group',
      tools: [{ callId: 'call-g1', toolName: 'Read', status: 'completed' }],
    };
    const { transformMarkdown, render } = mountMessages([prompt, thought]);
    render(false, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    render(true, [prompt, thought, tools], { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });
  });

  it('lets a genuinely live thought stream when it adjoins a settled compact run', () => {
    const prompt: Message = { id: 'prompt', role: 'user', content: 'Question' };
    const thought: Message = {
      id: 't1',
      role: 'thinking',
      content: 'plan',
      isStreaming: true,
    };
    const tools: Message = {
      id: 'g1',
      role: 'tool_group',
      tools: [{ callId: 'call-g1', toolName: 'Read', status: 'completed' }],
    };
    const liveThought: Message = {
      id: 't2',
      role: 'thinking',
      content: 'live thought',
      isStreaming: true,
    };
    const { transformMarkdown, render } = mountMessages([
      prompt,
      thought,
      tools,
    ]);
    render(false, undefined, { compactMode: true });
    expect(transformMarkdown).toHaveBeenLastCalledWith('plan', {
      source: 'thinking',
      isStreaming: false,
    });

    // A continuation turn's thinking folds into the same aggregated run; its
    // content never sat in the latch, so it must keep streaming.
    render(true, [prompt, thought, tools, liveThought], {
      compactMode: true,
    });
    const liveCalls = transformMarkdown.mock.calls.filter(
      ([text]) => text === 'live thought',
    );
    expect(liveCalls.length).toBeGreaterThan(0);
    expect(liveCalls.every(([, context]) => context.isStreaming === true)).toBe(
      true,
    );
  });
});
