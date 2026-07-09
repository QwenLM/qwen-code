// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import type { Message } from '../adapters/types';

// Stub the message body components so MessageItem's own wiring — not the bodies
// — is under test. UserMessage/AssistantMessage throw on a sentinel so we can
// drive the message-level ErrorBoundary (the real one, imported below); the
// rest are inert. MessageTimestamp is a passthrough so its chrome doesn't
// interfere with querying the fallback.
vi.mock('./MessageTimestamp', async () => {
  const React = await import('react');
  return {
    MessageTimestamp: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    formatTimestamp: () => '',
  };
});
vi.mock('./messages/UserMessage', async () => {
  const React = await import('react');
  return {
    UserMessage: ({ content }: { content: string }) => {
      if (content.includes('__BOOM__')) throw new Error('user boom');
      return React.createElement('div', { 'data-testid': 'user-ok' }, content);
    },
  };
});
vi.mock('./messages/AssistantMessage', async () => {
  const React = await import('react');
  return {
    AssistantMessage: ({
      content,
      customFooter,
    }: {
      content: string;
      customFooter?: React.ReactNode;
    }) => {
      if (content.includes('__BOOM__')) throw new Error('assistant boom');
      return React.createElement(
        'div',
        { 'data-testid': 'assistant-ok' },
        content,
        customFooter,
      );
    },
    ThinkingMessage: () => null,
  };
});
vi.mock('./messages/SystemMessage', () => ({ SystemMessage: () => null }));
vi.mock('./messages/ToolGroup', () => ({ ToolGroup: () => null }));
vi.mock('./messages/PlanMessage', () => ({ PlanMessage: () => null }));
vi.mock('./messages/BtwMessage', () => ({ BtwMessage: () => null }));
vi.mock('./messages/UserShellMessage', () => ({
  UserShellMessage: () => null,
}));
vi.mock('./InsightProgress', () => ({ InsightProgress: () => null }));
vi.mock('./InsightReady', () => ({ InsightReady: () => null }));

const { MessageItem } = await import('./MessageItem');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RENDER_ERROR = 'This message could not be displayed.';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
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

function item(message: Message) {
  return <MessageItem message={message} />;
}

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

describe('MessageItem assistant turn footer', () => {
  it('passes custom footer content to assistant messages', () => {
    const container = render(
      <I18nProvider language="en">
        <MessageItem
          message={assistantMsg('1', 'hello')}
          assistantTurnFooter={
            <div data-testid="assistant-footer">artifact</div>
          }
        />
      </I18nProvider>,
    );

    expect(
      container.querySelector('[data-testid="assistant-footer"]')?.textContent,
    ).toBe('artifact');
  });
});
