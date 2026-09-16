// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import {
  WebShellCustomizationProvider,
  type WebShellAssistantTurnFooterRenderInfo,
  type WebShellCustomization,
} from '../customization';
import type { ACPToolCall, Message } from '../adapters/types';
import { summaryRunId } from './summaryRunId';
import timestampStyles from './MessageTimestamp.module.css';
import { TranscriptRenderModeProvider } from '../transcriptRenderMode';

vi.mock('../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});

// Stub the message body components so MessageItem's own wiring — not the bodies
// — is under test. UserMessage/AssistantMessage throw on a sentinel so we can
// drive the message-level ErrorBoundary (the real one, imported below); the
// rest are inert. MessageTimestamp remains real to verify row spacing.
const captured = vi.hoisted(() => ({
  userMessageProps: null as null | {
    editing?: boolean;
    submittingEdit?: boolean;
  },
}));

vi.mock('./messages/UserMessage', async () => {
  const React = await import('react');
  return {
    UserMessage: (props: {
      content: string;
      editing?: boolean;
      submittingEdit?: boolean;
      onEditSubmit?: (content: string) => void;
    }) => {
      if (props.content.includes('__BOOM__')) throw new Error('user boom');
      captured.userMessageProps = props;
      return React.createElement(
        'div',
        { 'data-testid': 'user-ok' },
        props.content,
        props.editing
          ? React.createElement(
              'button',
              {
                'data-testid': 'edit-submit',
                onClick: () => props.onEditSubmit?.(props.content),
                type: 'button',
              },
              'submit',
            )
          : null,
      );
    },
  };
});
vi.mock('./messages/AssistantMessage', async () => {
  const React = await import('react');
  const { useWebShellCustomization } = await import('../customization');
  return {
    AssistantMessage: ({
      content,
      customFooterInfo,
      onBranchSession,
    }: {
      content: string;
      customFooterInfo?: WebShellAssistantTurnFooterRenderInfo;
      onBranchSession?: () => void | Promise<void>;
    }) => {
      if (content.includes('__BOOM__')) throw new Error('assistant boom');
      const { renderAssistantTurnFooter } = useWebShellCustomization();
      const customFooter = customFooterInfo
        ? renderAssistantTurnFooter?.(customFooterInfo)
        : undefined;
      return React.createElement(
        'div',
        { 'data-testid': 'assistant-ok' },
        content,
        customFooter,
        onBranchSession
          ? React.createElement(
              'button',
              {
                'data-testid': 'assistant-branch',
                onClick: () => void onBranchSession(),
              },
              'branch',
            )
          : null,
      );
    },
    ThinkingMessage: ({ generateContent }: { generateContent?: unknown }) =>
      React.createElement('div', {
        'data-testid': 'thinking',
        'data-has-generator': generateContent !== undefined ? 'true' : 'false',
      }),
  };
});
vi.mock('./messages/SystemMessage', () => ({ SystemMessage: () => null }));
vi.mock('./messages/ToolGroup', async () => {
  const React = await import('react');
  return {
    ToolGroup: ({
      compactSummary,
      tools,
    }: {
      compactSummary?: boolean;
      tools: ACPToolCall[];
    }) =>
      React.createElement('div', {
        'data-testid': 'tool-group',
        'data-compact-summary': String(compactSummary === true),
        'data-agent-ready': String(
          (tools[0]?.subTools?.[0] ?? tools[0])?.subagentSessionReady,
        ),
      }),
  };
});
vi.mock('./messages/PlanMessage', () => ({ PlanMessage: () => null }));
vi.mock('./messages/BtwMessage', () => ({ BtwMessage: () => null }));
vi.mock('./messages/UserShellMessage', () => ({
  UserShellMessage: () => null,
}));
vi.mock('./InsightProgress', () => ({ InsightProgress: () => null }));
vi.mock('./InsightReady', () => ({ InsightReady: () => null }));

const { MessageItem } = await import('./MessageItem');
const { CompactModeContext } = await import('../WebShellContexts');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RENDER_ERROR = 'This message could not be displayed.';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderWithRoot(node: React.ReactNode): {
  root: Root;
  container: HTMLElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { root, container };
}

function render(node: React.ReactNode): HTMLElement {
  return renderWithRoot(node).container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

const userMsg = (id: string, content: string): Message =>
  ({ id, role: 'user', content, timestamp: 0 }) as Message;
const assistantMsg = (id: string, content: string): Message =>
  ({ id, role: 'assistant', content, timestamp: 0 }) as Message;
const thinkingMsg = (id: string, content: string): Message =>
  ({ id, role: 'thinking', content, timestamp: 0 }) as Message;
const toolMsg = (id: string): Message => ({
  id,
  role: 'tool_group',
  tools: [],
  timestamp: 0,
});

function item(message: Message) {
  return <MessageItem message={message} />;
}

it.each([false, true])(
  'propagates readiness-only changes with nested=%s',
  (nested) => {
    const agent: ACPToolCall = {
      callId: 'agent-1',
      toolName: 'agent',
      status: 'in_progress',
      subagentSessionReady: false,
    };
    const tools = nested
      ? [{ ...agent, callId: 'parent', subTools: [agent] }]
      : [agent];
    const message: Message = {
      id: 'agent-message',
      role: 'tool_group',
      tools,
      timestamp: 0,
    };
    const { root, container } = renderWithRoot(
      <I18nProvider language="en">{item(message)}</I18nProvider>,
    );
    expect(
      container
        .querySelector('[data-testid="tool-group"]')
        ?.getAttribute('data-agent-ready'),
    ).toBe('false');
    const readyAgent = { ...agent, subagentSessionReady: true };
    act(() =>
      root.render(
        <I18nProvider language="en">
          {item({
            ...message,
            tools: nested
              ? [{ ...tools[0], subTools: [readyAgent] }]
              : [readyAgent],
          })}
        </I18nProvider>,
      ),
    );
    expect(
      container
        .querySelector('[data-testid="tool-group"]')
        ?.getAttribute('data-agent-ready'),
    ).toBe('true');
  },
);

describe('MessageItem error isolation', () => {
  it('renders a healthy message normally (no fallback)', () => {
    const container = render(
      <I18nProvider language="en">{item(userMsg('1', 'hello'))}</I18nProvider>,
    );
    expect(
      container.querySelector('[data-testid="user-ok"]')?.textContent,
    ).toBe('hello');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('degrades a crashing message to an inline notice while a sibling survives', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(
      <I18nProvider language="en">
        {item(userMsg('ok', 'hello'))}
        {item(userMsg('bad', '__BOOM__'))}
      </I18nProvider>,
    );
    // The healthy sibling still renders — one bad message doesn't take down the
    // transcript.
    expect(
      container.querySelector('[data-testid="user-ok"]')?.textContent,
    ).toBe('hello');
    // The crashing message degrades to the localized inline notice.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      RENDER_ERROR,
    );
  });

  it('right-aligns the fallback for a user message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(
      <I18nProvider language="en">
        {item(userMsg('1', '__BOOM__'))}
      </I18nProvider>,
    );
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.style.justifyContent).toBe('flex-end');
  });

  it('left-aligns the fallback for an assistant message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(
      <I18nProvider language="en">
        {item(assistantMsg('1', '__BOOM__'))}
      </I18nProvider>,
    );
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.style.justifyContent).toBe('flex-start');
  });
});

describe('MessageItem selectable wrapper', () => {
  it('keeps the user-selectable wrapper out of layout via display: contents', () => {
    // The wrapper only exists to carry the `data-user-selectable` CSS marker
    // (standalone.css re-enables text selection through it). It must NOT
    // generate a layout box: several parents are flex containers whose item
    // used to be the message body itself — a plain div here becomes the flex
    // item instead and shrinks to content width, squeezing the user chat
    // bubble (max-width: 80% of the shrunken wrapper) so even short messages
    // wrap mid-word.
    const container = render(
      <I18nProvider language="en">{item(userMsg('1', 'hello'))}</I18nProvider>,
    );
    const wrapper = container.querySelector(
      '[data-user-selectable]',
    ) as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.style.display).toBe('contents');
    // The message body renders inside the wrapper, so the CSS descendant
    // selector `[data-user-selectable] *` still re-enables selection.
    expect(wrapper.querySelector('[data-testid="user-ok"]')).not.toBeNull();
  });
});

describe('MessageItem tool group spacing', () => {
  it('marks only synthetic groups as compact summaries', () => {
    const synthetic = render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={true}>
          {item(toolMsg(summaryRunId('agent-1')))}
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
    const regular = render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={true}>
          {item(toolMsg('agent-1'))}
        </CompactModeContext.Provider>
      </I18nProvider>,
    );

    expect(
      synthetic
        .querySelector('[data-testid="tool-group"]')
        ?.getAttribute('data-compact-summary'),
    ).toBe('true');
    expect(
      regular
        .querySelector('[data-testid="tool-group"]')
        ?.getAttribute('data-compact-summary'),
    ).toBe('false');
  });

  it('uses larger row spacing only in compact mode', () => {
    const compact = render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={true}>
          {item(toolMsg('compact'))}
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
    const regular = render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={false}>
          {item(toolMsg('regular'))}
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
    const compactAssistant = render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={true}>
          {item(assistantMsg('assistant', 'answer'))}
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
    const defaultTool = render(
      <I18nProvider language="en">{item(toolMsg('default'))}</I18nProvider>,
    );

    expect(compact.firstElementChild?.classList).toContain(
      timestampStyles.toolGroupSpacing,
    );
    for (const container of [regular, compactAssistant, defaultTool]) {
      expect(container.firstElementChild?.classList).not.toContain(
        timestampStyles.toolGroupSpacing,
      );
    }
  });
});

describe('MessageItem generation updates', () => {
  it('rerenders a thinking message when generation becomes available', () => {
    const message = thinkingMsg('1', 'reasoning');
    const { root, container } = renderWithRoot(
      <I18nProvider language="en">
        <MessageItem message={message} />
      </I18nProvider>,
    );
    expect(
      container
        .querySelector('[data-testid="thinking"]')
        ?.getAttribute('data-has-generator'),
    ).toBe('false');

    const generateContent = async function* () {};
    act(() =>
      root.render(
        <I18nProvider language="en">
          <MessageItem message={message} generateContent={generateContent} />
        </I18nProvider>,
      ),
    );
    expect(
      container
        .querySelector('[data-testid="thinking"]')
        ?.getAttribute('data-has-generator'),
    ).toBe('true');
  });
});

describe('MessageItem assistant turn footer', () => {
  const customization = (
    renderAssistantTurnFooter: WebShellCustomization['renderAssistantTurnFooter'],
  ): WebShellCustomization => ({ renderAssistantTurnFooter });
  const footerInfo = (
    turnId: string,
    messageId = '1',
  ): WebShellAssistantTurnFooterRenderInfo => ({
    turnId,
    message: {
      id: messageId,
      content: 'hello',
      isStreaming: false,
      timestamp: 0,
    },
  });

  it('passes custom footer info to assistant messages', () => {
    const renderAssistantTurnFooter = vi.fn(({ turnId }) => (
      <div data-testid="assistant-footer">{turnId}</div>
    ));
    const container = render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={customization(renderAssistantTurnFooter)}
        >
          <MessageItem
            message={assistantMsg('1', 'hello')}
            assistantTurnFooterInfo={footerInfo('u1')}
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );

    expect(renderAssistantTurnFooter).toHaveBeenCalledWith(footerInfo('u1'));
    expect(
      container.querySelector('[data-testid="assistant-footer"]')?.textContent,
    ).toBe('u1');
  });

  it('updates custom footer content when only footer info changes', () => {
    const message = assistantMsg('1', 'hello');
    const renderAssistantTurnFooter = vi.fn(({ turnId }) => (
      <div data-testid="assistant-footer">{turnId}</div>
    ));
    const value = customization(renderAssistantTurnFooter);
    const { root, container } = renderWithRoot(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={value}>
          <MessageItem
            message={message}
            assistantTurnFooterInfo={footerInfo('u1')}
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );

    expect(
      container.querySelector('[data-testid="assistant-footer"]')?.textContent,
    ).toBe('u1');

    act(() =>
      root.render(
        <I18nProvider language="en">
          <WebShellCustomizationProvider value={value}>
            <MessageItem
              message={message}
              assistantTurnFooterInfo={footerInfo('u2')}
            />
          </WebShellCustomizationProvider>
        </I18nProvider>,
      ),
    );

    expect(
      container.querySelector('[data-testid="assistant-footer"]')?.textContent,
    ).toBe('u2');
  });

  it('degrades a crashing custom footer renderer to an inline notice', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderAssistantTurnFooter = vi.fn(() => {
      throw new Error('footer boom');
    });

    const container = render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider
          value={customization(renderAssistantTurnFooter)}
        >
          <MessageItem
            message={assistantMsg('1', 'hello')}
            assistantTurnFooterInfo={footerInfo('u1')}
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      RENDER_ERROR,
    );
  });
});

describe('MessageItem background notification spacing', () => {
  it.each(['interactive', 'document'] as const)(
    'keeps consecutive notification rows without hover times in %s mode',
    (mode) => {
      const messages = [
        'background_task_completed',
        'background_notification_turn_started',
      ].map((source) => ({
        id: source,
        role: 'system' as const,
        content: 'Background task',
        timestamp: Date.now(),
        source,
      }));
      const container = render(
        <I18nProvider language="en">
          <TranscriptRenderModeProvider value={mode}>
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} />
            ))}
          </TranscriptRenderModeProvider>
        </I18nProvider>,
      );
      const rows = Array.from(container.children).filter((element) =>
        element.classList.contains(timestampStyles.row),
      );
      expect(rows).toHaveLength(mode === 'interactive' ? 2 : 0);
      expect(container.querySelectorAll('[data-user-selectable]')).toHaveLength(
        2,
      );
      expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    },
  );
});

describe('MessageItem inline message editing', () => {
  function renderEditableUserMessage(
    onSubmitUserMessageEdit: (content: string) => boolean | Promise<boolean>,
  ): HTMLElement {
    return render(
      <I18nProvider language="en">
        <MessageItem
          message={userMsg('u1', 'hello')}
          onEditUserMessage={() => undefined}
          onSubmitUserMessageEdit={onSubmitUserMessageEdit}
        />
      </I18nProvider>,
    );
  }

  it('closes the editor once the resend is accepted', async () => {
    const onSubmitUserMessageEdit = vi.fn().mockResolvedValue(true);
    const container = renderEditableUserMessage(onSubmitUserMessageEdit);

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')
        ?.click();
    });
    expect(captured.userMessageProps?.editing).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="edit-submit"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSubmitUserMessageEdit).toHaveBeenCalledWith('hello');
    expect(captured.userMessageProps?.editing).toBe(false);
  });

  it('keeps the editor open when the resend is refused', async () => {
    const onSubmitUserMessageEdit = vi.fn().mockResolvedValue(false);
    const container = renderEditableUserMessage(onSubmitUserMessageEdit);

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')
        ?.click();
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="edit-submit"]')
        ?.click();
      await Promise.resolve();
    });

    // The refusal must not drop the user's text on the floor.
    expect(captured.userMessageProps?.editing).toBe(true);
    expect(captured.userMessageProps?.submittingEdit).toBe(false);
  });
});
