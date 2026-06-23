// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '../adapters/types';
import { I18nProvider } from '../i18n';

// Mock the App context and the heavy row children so this test exercises only
// MessageList's own collapse + deferred-scroll logic, not the whole render tree.
vi.mock('../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});
vi.mock('./MessageItem', async () => {
  const React = await import('react');
  return {
    MessageItem: ({ message }: { message: Message }) =>
      React.createElement('div', { 'data-testid': `msg-${message.id}` }),
  };
});
vi.mock('./messages/tools/ParallelAgentsGroup', () => ({
  ParallelAgentsGroup: () => null,
}));
vi.mock('./messages/ToolApproval', () => ({ ToolApproval: () => null }));
vi.mock('./messages/AskUserQuestion', () => ({ AskUserQuestion: () => null }));

const { MessageList } = await import('./MessageList');
type MessageListHandle = import('./MessageList').MessageListHandle;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom provides neither ResizeObserver (MessageList's resize guard) nor a real
// scrollIntoView (the non-virtual scroll path) — stub both.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

type UserMessage = Extract<Message, { role: 'user' }>;
type ToolGroupMessage = Extract<Message, { role: 'tool_group' }>;
type AssistantMessage = Extract<Message, { role: 'assistant' }>;

const userMsg = (id: string): UserMessage => ({
  id,
  role: 'user',
  content: 'q',
});
const toolMsg = (id: string): ToolGroupMessage => ({
  id,
  role: 'tool_group',
  tools: [{ callId: `call-${id}`, toolName: 'Read', status: 'completed' }],
});
const asstMsg = (id: string): AssistantMessage => ({
  id,
  role: 'assistant',
  content: 'answer',
});

function mount(
  messages: Message[],
  ref?: RefObject<MessageListHandle | null>,
  opts: { isResponding?: boolean } = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <MessageList
          ref={ref}
          messages={messages}
          pendingApproval={null}
          onConfirm={() => {}}
          isResponding={opts.isResponding}
          shellOutputMaxLines={50}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

const has = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="msg-${id}"]`) !== null;
const isCollapsed = (c: HTMLElement, id: string) =>
  c
    .querySelector(`[data-testid="msg-${id}"]`)
    ?.closest('[data-collapsed="true"]') !== null;
const queryToggle = (c: HTMLElement, turnId: string) =>
  c.querySelector(`[data-testid="toggle-${turnId}"]`) as HTMLElement | null;
const toggle = (c: HTMLElement, turnId: string) =>
  queryToggle(c, turnId) as HTMLElement;
const toggleRow = (c: HTMLElement, turnId: string) =>
  toggle(c, turnId).closest('[role="button"]') as HTMLElement;
const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('MessageList — turn collapse (DOM)', () => {
  it('collapses a completed turn: hides the step, keeps prompt + answer, shows the toggle', () => {
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')]);
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'a1')).toBe(true);
    expect(isCollapsed(c, 'g1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('renders collapse metrics in the standalone turn row', () => {
    const c = mount([
      { ...userMsg('u1'), timestamp: 1_000 },
      { ...toolMsg('g1'), timestamp: 2_000 },
      {
        id: 't1',
        role: 'thinking',
        content: 'checking the tool result',
        timestamp: 2_500,
      },
      {
        ...asstMsg('a1'),
        timestamp: 13_400,
        usage: { inputTokens: 3100, outputTokens: 5100, cachedTokens: 2800 },
      },
    ]);
    const text = c.textContent ?? '';
    expect(text).toContain('Processed');
    expect(text).toContain('13s');
    expect(text).toContain('↑3.1k (2.8k cached, 90%) ↓5.1k');
    expect(text).toContain('1 tool call');
    expect(text).toContain('1 thought');
    expect(text).not.toContain('1 step');
    expect(text.indexOf('↓5.1k')).toBeLessThan(text.indexOf('1 tool call'));
  });

  it('renders step-less metrics without a toggle', () => {
    const c = mount([
      { ...userMsg('u1'), timestamp: 1_000 },
      {
        ...asstMsg('a1'),
        timestamp: 1_900,
        usage: { inputTokens: 1200, outputTokens: 45 },
      },
    ]);
    const text = c.textContent ?? '';
    expect(queryToggle(c, 'u1')).toBeNull();
    expect(text).toContain('Processed 1s');
    expect(text).toContain('↑1.2k ↓45');
    expect(text).not.toContain('step');
  });

  it('omits elapsed-only completed metrics when there is no toggle', () => {
    const c = mount([
      { ...userMsg('u1'), timestamp: 1_000 },
      { ...asstMsg('a1'), timestamp: 13_400 },
    ]);
    const text = c.textContent ?? '';
    expect(queryToggle(c, 'u1')).toBeNull();
    expect(text).not.toContain('Processed');
    expect(text).not.toContain('13s');
  });

  it('shows live elapsed time for a running step-less turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const c = mount([{ ...userMsg('u1'), timestamp: 7_600 }], undefined, {
      isResponding: true,
    });
    expect(queryToggle(c, 'u1')).toBeNull();
    expect(c.textContent).toContain('Processing 3s');
  });

  it('toggle round-trip reveals then re-hides the step', () => {
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')]);
    click(toggle(c, 'u1'));
    expect(has(c, 'g1')).toBe(true);
    expect(isCollapsed(c, 'g1')).toBe(false);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
    click(toggle(c, 'u1'));
    expect(isCollapsed(c, 'g1')).toBe(true);
  });

  it('scrollToMessage auto-expands the collapsed turn that holds the target', () => {
    const ref = createRef<MessageListHandle>();
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')], ref);
    expect(isCollapsed(c, 'g1')).toBe(true);
    let found = false;
    act(() => {
      found = ref.current!.scrollToMessage('g1', 'call-g1');
    });
    expect(found).toBe(true);
    expect(has(c, 'g1')).toBe(true);
    expect(isCollapsed(c, 'g1')).toBe(false);
  });

  it('smooth-scrolls the page when a new chat prompt appears', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    mount([userMsg('u1')]);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });
});
