// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '../adapters/types';

// Mock the App context and the heavy row children so this test exercises only
// MessageList's own collapse + deferred-scroll logic, not the whole render tree.
vi.mock('../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});
vi.mock('./MessageItem', async () => {
  const React = await import('react');
  return {
    MessageItem: ({
      message,
      collapse,
      onToggleCollapse,
    }: {
      message: Message;
      collapse?: { turnId: string; collapsed: boolean; hiddenCount: number };
      onToggleCollapse?: (id: string) => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': `msg-${message.id}` },
        collapse
          ? React.createElement(
              'button',
              {
                'data-testid': `toggle-${collapse.turnId}`,
                'aria-expanded': String(!collapse.collapsed),
                onClick: () => onToggleCollapse?.(collapse.turnId),
              },
              collapse.collapsed
                ? `expand-${collapse.hiddenCount}`
                : 'collapse',
            )
          : null,
      ),
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
});

const userMsg = (id: string): Message => ({ id, role: 'user', content: 'q' });
const toolMsg = (id: string): Message => ({
  id,
  role: 'tool_group',
  tools: [{ callId: `call-${id}`, toolName: 'Read', status: 'completed' }],
});
const asstMsg = (id: string): Message => ({
  id,
  role: 'assistant',
  content: 'answer',
});

function mount(
  messages: Message[],
  ref?: RefObject<MessageListHandle | null>,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MessageList
        ref={ref}
        messages={messages}
        pendingApproval={null}
        onConfirm={() => {}}
        shellOutputMaxLines={50}
      />,
    );
  });
  mounted.push({ root, container });
  return container;
}

const has = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="msg-${id}"]`) !== null;
const toggle = (c: HTMLElement, turnId: string) =>
  c.querySelector(`[data-testid="toggle-${turnId}"]`) as HTMLElement;
const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('MessageList — turn collapse (DOM)', () => {
  it('collapses a completed turn: hides the step, keeps prompt + answer, shows the toggle', () => {
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')]);
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'a1')).toBe(true);
    expect(has(c, 'g1')).toBe(false);
    expect(toggle(c, 'u1').textContent).toContain('expand-1');
    expect(toggle(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('toggle round-trip reveals then re-hides the step', () => {
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')]);
    click(toggle(c, 'u1'));
    expect(has(c, 'g1')).toBe(true);
    expect(toggle(c, 'u1').getAttribute('aria-expanded')).toBe('true');
    click(toggle(c, 'u1'));
    expect(has(c, 'g1')).toBe(false);
  });

  it('scrollToMessage auto-expands the collapsed turn that holds the target', () => {
    const ref = createRef<MessageListHandle>();
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')], ref);
    expect(has(c, 'g1')).toBe(false);
    let found = false;
    act(() => {
      found = ref.current!.scrollToMessage('g1', 'call-g1');
    });
    expect(found).toBe(true);
    expect(has(c, 'g1')).toBe(true);
  });
});
