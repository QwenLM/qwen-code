// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../adapters/types';
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
  ) => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WebShellCustomizationProvider value={customization}>
            <TranscriptRenderModeProvider value={renderMode}>
              <MessageList
                messages={nextMessages}
                pendingApproval={null}
                isResponding={isResponding}
              />
            </TranscriptRenderModeProvider>
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
});
