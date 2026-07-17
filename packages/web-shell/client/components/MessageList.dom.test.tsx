// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '../adapters/types';
import {
  WebShellCustomizationProvider,
  type WebShellAssistantTurnFooterRenderInfo,
  type WebShellCustomization,
} from '../customization';
import { I18nProvider } from '../i18n';
import flashStyles from './MessageLocateFlash.module.css';
import styles from './MessageList.module.css';

// Mock the App context and the heavy row children so this test exercises only
// MessageList's own collapse + deferred-scroll logic, not the whole render tree.
vi.mock('../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});
vi.mock('./MessageItem', async () => {
  const React = await import('react');
  const { useWebShellCustomization } = await import('../customization');
  return {
    MessageItem: ({
      message,
      showAssistantActions,
      isLocateFlashing,
      assistantTurnFooterInfo,
    }: {
      message: Message;
      showAssistantActions?: boolean;
      isLocateFlashing?: boolean;
      assistantTurnFooterInfo?: WebShellAssistantTurnFooterRenderInfo;
    }) => {
      const { renderAssistantTurnFooter } = useWebShellCustomization();
      const assistantTurnFooter = assistantTurnFooterInfo
        ? renderAssistantTurnFooter?.(assistantTurnFooterInfo)
        : undefined;
      return React.createElement(
        'div',
        {
          'data-testid': `msg-${message.id}`,
          'data-assistant-actions': String(Boolean(showAssistantActions)),
          'data-locate-flashing': isLocateFlashing ? 'true' : undefined,
        },
        message.role === 'thinking'
          ? React.createElement('button', {
              'aria-expanded': 'false',
              'data-testid': `disclosure-${message.id}`,
            })
          : null,
        assistantTurnFooter,
      );
    },
  };
});
vi.mock('./messages/tools/ParallelAgentsGroup', async () => {
  const React = await import('react');
  return {
    ParallelAgentsGroup: () =>
      React.createElement('div', { 'data-testid': 'parallel-agents' }),
  };
});
vi.mock('./messages/ToolApproval', () => ({ ToolApproval: () => null }));
vi.mock('./messages/AskUserQuestion', () => ({ AskUserQuestion: () => null }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    enabled,
    getItemKey,
  }: {
    count: number;
    enabled: boolean;
    getItemKey: (index: number) => string | number;
  }) => {
    const virtualItems = enabled
      ? Array.from({ length: Math.min(count, 5) }, (_, index) => ({
          key: getItemKey(index),
          index,
          start: index * 80,
        }))
      : [];
    return {
      getVirtualItems: () => virtualItems,
      getTotalSize: () => (enabled ? count * 80 : 0),
      measureElement: () => {},
      scrollToIndex: () => {},
    };
  },
}));

const { MessageList } = await import('./MessageList');
type MessageListHandle = import('./MessageList').MessageListHandle;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom provides neither ResizeObserver (MessageList's resize guard) nor a real
// scrollIntoView (the non-virtual scroll path) — stub both.
const resizeObserverCallbacks: ResizeObserverCallback[] = [];
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function triggerResizeObservers() {
  for (const callback of resizeObserverCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  resizeObserverCallbacks.length = 0;
  vi.useRealTimers();
});

type UserMessage = Extract<Message, { role: 'user' }>;
type ToolGroupMessage = Extract<Message, { role: 'tool_group' }>;
type AssistantMessage = Extract<Message, { role: 'assistant' }>;
type SystemMessage = Extract<Message, { role: 'system' }>;
type ThinkingMessage = Extract<Message, { role: 'thinking' }>;
type PlanMessage = Extract<Message, { role: 'plan' }>;

const userMsg = (id: string): UserMessage => ({
  id,
  role: 'user',
  content: 'q',
});
const userShellMsg = (
  id: string,
): Extract<Message, { role: 'user_shell' }> => ({
  id,
  role: 'user_shell',
  command: 'npm test',
  output: '',
});
const toolMsg = (id: string): ToolGroupMessage => ({
  id,
  role: 'tool_group',
  tools: [{ callId: `call-${id}`, toolName: 'Read', status: 'completed' }],
});
const agentMsg = (id: string): ToolGroupMessage => ({
  id,
  role: 'tool_group',
  tools: [
    {
      callId: `call-${id}`,
      toolName: 'Task',
      status: 'completed',
      args: { subagent_type: 'explore' },
    },
  ],
});
const asstMsg = (id: string): AssistantMessage => ({
  id,
  role: 'assistant',
  content: 'answer',
});
const systemMsg = (id: string): SystemMessage => ({
  id,
  role: 'system',
  content: 'cancelled',
  variant: 'warning',
  source: 'prompt_cancelled',
});
const thinkingMsg = (id: string): ThinkingMessage => ({
  id,
  role: 'thinking',
  content: 'thinking',
});
const planMsg = (id: string): PlanMessage => ({
  id,
  role: 'plan',
  todos: [{ id: 'todo-1', content: 'step one', status: 'pending' }],
});

function mount(
  messages: Message[],
  ref?: RefObject<MessageListHandle | null>,
  opts: {
    hideSessionTimeline?: boolean;
    loadingTranscript?: boolean;
    catchingUp?: boolean;
    hasOlderHistory?: boolean;
    loadingOlderHistory?: boolean;
    historyCapacityReached?: boolean;
    onLoadOlderHistory?: () => Promise<void>;
    isResponding?: boolean;
    onCanScrollToBottomChange?: (canScrollToBottom: boolean) => void;
    customization?: WebShellCustomization;
  } = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={opts.customization ?? {}}>
          <MessageList
            ref={ref}
            messages={messages}
            pendingApproval={null}
            hideSessionTimeline={opts.hideSessionTimeline}
            loadingTranscript={opts.loadingTranscript}
            catchingUp={opts.catchingUp}
            hasOlderHistory={opts.hasOlderHistory}
            loadingOlderHistory={opts.loadingOlderHistory}
            historyCapacityReached={opts.historyCapacityReached}
            onLoadOlderHistory={opts.onLoadOlderHistory}
            isResponding={opts.isResponding}
            onCanScrollToBottomChange={opts.onCanScrollToBottomChange}
          />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderInto(
  root: Root,
  messages: Message[],
  ref?: RefObject<MessageListHandle | null>,
  opts: {
    loadingTranscript?: boolean;
    catchingUp?: boolean;
    isResponding?: boolean;
    onCanScrollToBottomChange?: (canScrollToBottom: boolean) => void;
  } = {},
) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <MessageList
          ref={ref}
          messages={messages}
          pendingApproval={null}
          loadingTranscript={opts.loadingTranscript}
          catchingUp={opts.catchingUp}
          isResponding={opts.isResponding}
          onCanScrollToBottomChange={opts.onCanScrollToBottomChange}
        />
      </I18nProvider>,
    );
  });
}

const has = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="msg-${id}"]`) !== null;
const assistantActions = (c: HTMLElement, id: string) =>
  c
    .querySelector(`[data-testid="msg-${id}"]`)
    ?.getAttribute('data-assistant-actions');
const isCollapsed = (c: HTMLElement, id: string) =>
  c
    .querySelector(`[data-testid="msg-${id}"]`)
    ?.closest('[data-collapsed="true"]') !== null;
const queryToggle = (c: HTMLElement, turnId: string) =>
  c.querySelector(`[data-testid="toggle-${turnId}"]`) as HTMLElement | null;
const toggle = (c: HTMLElement, turnId: string) =>
  queryToggle(c, turnId) as HTMLElement;
const disclosure = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="disclosure-${id}"]`) as HTMLElement;
const toggleRow = (c: HTMLElement, turnId: string) =>
  toggle(c, turnId).closest('[role="button"]') as HTMLElement;
const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const focusIn = (el: Element) =>
  act(() => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
const focusOut = (el: Element) =>
  act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
const nextFrame = () =>
  act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
const mockMessageListWidth = (width: number) =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 600,
    top: 0,
    right: width,
    bottom: 600,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
const simpleTurns = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => {
    const turn = index + 1;
    return [userMsg(`u${turn}`), asstMsg(`a${turn}`)] as Message[];
  }).flat();

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

  it('renders custom footer on the completed turn final assistant message', () => {
    const renderAssistantTurnFooter = vi.fn(({ turnId, message }) => (
      <span data-testid="assistant-turn-footer">
        {turnId}:{message.id}:{message.content}
      </span>
    ));

    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')], undefined, {
      customization: { renderAssistantTurnFooter },
    });

    expect(renderAssistantTurnFooter).toHaveBeenCalledWith({
      turnId: 'u1',
      message: {
        id: 'a1',
        content: 'answer',
        isStreaming: undefined,
        timestamp: undefined,
      },
    });
    expect(
      c.querySelector('[data-testid="assistant-turn-footer"]')?.textContent,
    ).toBe('u1:a1:answer');
  });

  it('maps each completed turn footer to its own turn id', () => {
    const renderAssistantTurnFooter = vi.fn(({ turnId, message }) => (
      <span data-testid={`assistant-turn-footer-${message.id}`}>
        {turnId}:{message.id}
      </span>
    ));

    const c = mount(
      [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2')],
      undefined,
      {
        customization: { renderAssistantTurnFooter },
      },
    );

    expect(renderAssistantTurnFooter).toHaveBeenCalledTimes(2);
    expect(renderAssistantTurnFooter.mock.calls.map(([info]) => info)).toEqual([
      {
        turnId: 'u1',
        message: {
          id: 'a1',
          content: 'answer',
          isStreaming: undefined,
          timestamp: undefined,
        },
      },
      {
        turnId: 'u2',
        message: {
          id: 'a2',
          content: 'answer',
          isStreaming: undefined,
          timestamp: undefined,
        },
      },
    ]);
    expect(
      c.querySelector('[data-testid="assistant-turn-footer-a1"]')?.textContent,
    ).toBe('u1:a1');
    expect(
      c.querySelector('[data-testid="assistant-turn-footer-a2"]')?.textContent,
    ).toBe('u2:a2');
  });

  it('does not render the custom assistant footer for the active streaming turn', () => {
    const renderAssistantTurnFooter = vi.fn(() => (
      <span data-testid="assistant-turn-footer">footer</span>
    ));

    const c = mount(
      [userMsg('u1'), { ...asstMsg('a1'), isStreaming: true }],
      undefined,
      {
        isResponding: true,
        customization: { renderAssistantTurnFooter },
      },
    );

    expect(renderAssistantTurnFooter).not.toHaveBeenCalled();
    expect(c.querySelector('[data-testid="assistant-turn-footer"]')).toBeNull();
  });

  it('does not render the custom assistant footer when a turn has no final assistant message', () => {
    const renderAssistantTurnFooter = vi.fn(() => (
      <span data-testid="assistant-turn-footer">footer</span>
    ));

    const c = mount([userMsg('u1'), systemMsg('s1')], undefined, {
      customization: { renderAssistantTurnFooter },
    });

    expect(renderAssistantTurnFooter).not.toHaveBeenCalled();
    expect(c.querySelector('[data-testid="assistant-turn-footer"]')).toBeNull();
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

  it('renders virtual scroll rows with sizer and row width classes', () => {
    const c = mount(simpleTurns(110));

    expect(c.querySelector(`.${styles.virtualSizer}`)).not.toBeNull();
    expect(c.querySelectorAll(`.${styles.virtualRow}`).length).toBeGreaterThan(
      0,
    );
  });

  it('renders the session timeline in the left gutter without expanding turns', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount([
      userMsg('u1'),
      thinkingMsg('think1'),
      asstMsg('mid1'),
      toolMsg('g1'),
      planMsg('plan1'),
      asstMsg('a1'),
      userMsg('u2'),
      asstMsg('a2'),
      userMsg('u3'),
      asstMsg('a3'),
      userMsg('u4'),
      asstMsg('a4'),
    ]);
    await nextFrame();

    const timeline = c.querySelector('[data-testid="session-timeline"]');
    expect(timeline).not.toBeNull();
    const entries = Array.from(
      c.querySelectorAll('[data-testid="session-timeline-entry"]'),
    );
    expect(entries.map((entry) => entry.getAttribute('data-turn-id'))).toEqual([
      'u1',
      'u2',
      'u3',
      'u4',
    ]);
    expect(entries[0]?.getAttribute('data-node-kinds')).toBe(
      'thought,commentary,tool,plan',
    );
    expect(
      document.querySelectorAll('[data-testid="session-timeline-detail"]'),
    ).toHaveLength(0);
    const buttons = Array.from(
      c.querySelectorAll<HTMLButtonElement>(
        '[data-testid="session-timeline-entry"] button',
      ),
    );
    expect(buttons[0]?.getAttribute('aria-label')).toBe(
      'Turn 1: q. Current turn',
    );
    expect(buttons[0]?.hasAttribute('title')).toBe(false);
    expect(entries[0]?.getAttribute('data-in-current-range')).toBe('true');
    expect(entries[1]?.getAttribute('data-in-current-range')).toBe('true');
    expect(
      c.querySelector('[data-testid="session-timeline-range"]'),
    ).toBeNull();
    expect(isCollapsed(c, 'g1')).toBe(true);
    expect(c.querySelector('[data-testid="turn-timeline-row"]')).toBeNull();
    rectSpy.mockRestore();
  });

  it('keeps a long session timeline scrollable and preserves first-entry selection', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const offsetTopSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function (this: HTMLElement) {
        const index = this.getAttribute('data-timeline-index');
        return index === null ? 0 : 240 + Number(index) * 60;
      });
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-timeline-index') ? 3 : 0;
      });
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('data-testid') === 'session-timeline-viewport'
          ? 220
          : 0;
      });
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('data-testid') === 'session-timeline-viewport'
          ? 5200
          : 0;
      });
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    try {
      const c = mount(simpleTurns(80));
      await nextFrame();

      const viewport = c.querySelector<HTMLElement>(
        '[data-testid="session-timeline-viewport"]',
      );
      expect(viewport).not.toBeNull();
      expect(viewport!.scrollTop).toBeGreaterThan(0);
      const entries = Array.from(
        c.querySelectorAll('[data-testid="session-timeline-entry"]'),
      );
      expect(entries).toHaveLength(80);
      expect(entries[0]?.getAttribute('data-turn-id')).toBe('u1');
      expect(entries[0]?.getAttribute('data-timeline-index')).toBe('0');
      expect(entries[79]?.getAttribute('data-turn-id')).toBe('u80');
      expect(entries[79]?.getAttribute('data-timeline-index')).toBe('79');
      expect(
        entries[0]?.closest('[data-testid="session-timeline-viewport"]'),
      ).toBe(viewport);

      click(entries[0]!.querySelector('button')!);

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    } finally {
      scrollIntoView.mockRestore();
      scrollHeightSpy.mockRestore();
      clientHeightSpy.mockRestore();
      offsetHeightSpy.mockRestore();
      offsetTopSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('renders timeline details as one body-level tooltip outside the timeline stack', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount(simpleTurns(4));
    await nextFrame();

    const firstEntryButton = c.querySelector<HTMLButtonElement>(
      '[data-turn-id="u1"] button',
    );
    expect(firstEntryButton).not.toBeNull();
    focusIn(firstEntryButton!);

    const detail = document.querySelector(
      '[data-testid="session-timeline-detail"]',
    );
    expect(detail).not.toBeNull();
    expect(detail?.getAttribute('data-detail')).toBe('answer');
    expect(
      detail?.closest('[data-testid="session-timeline-viewport"]'),
    ).toBeNull();
    expect(detail?.closest('[data-testid="session-timeline"]')).toBeNull();
    expect(detail?.parentElement).toBe(document.body);
    expect(c.contains(detail!)).toBe(false);
    expect(detail?.id).toBe('session-timeline-detail-tooltip');
    expect(firstEntryButton?.getAttribute('aria-describedby')).toBe(
      'session-timeline-detail-tooltip',
    );

    focusOut(firstEntryButton!);

    expect(
      document.querySelector('[data-testid="session-timeline-detail"]'),
    ).toBeNull();
    expect(firstEntryButton?.hasAttribute('aria-describedby')).toBe(false);
    rectSpy.mockRestore();
  });

  it('clamps timeline details to the viewport edge', async () => {
    const originalInnerHeight = window.innerHeight;
    const rect = (
      width: number,
      height: number,
      top: number,
      left = 0,
    ): DOMRect => ({
      width,
      height,
      top,
      right: left + width,
      bottom: top + height,
      left,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    let detailRect = rect(240, 50, -5, 80);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('data-testid') === 'session-timeline-detail') {
          return detailRect;
        }
        const item = this.closest('[data-testid="session-timeline-entry"]');
        if (item) return rect(58, 16, 20, 12);
        return rect(1200, 600, 0);
      });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 100,
    });
    const c = mount(simpleTurns(4));
    await nextFrame();

    try {
      const firstEntryButton = c.querySelector<HTMLButtonElement>(
        '[data-turn-id="u1"] button',
      );
      expect(firstEntryButton).not.toBeNull();
      focusIn(firstEntryButton!);

      let detail = document.querySelector<HTMLElement>(
        '[data-testid="session-timeline-detail"]',
      );
      expect(detail?.style.top).toBe('45px');

      focusOut(firstEntryButton!);
      detailRect = rect(240, 100, 30, 80);
      focusIn(firstEntryButton!);

      detail = document.querySelector<HTMLElement>(
        '[data-testid="session-timeline-detail"]',
      );
      expect(detail?.style.top).toBe('-14px');
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
      rectSpy.mockRestore();
    }
  });

  it('keeps timeline details during current-turn centering but hides them on user scroll', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const offsetTopSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function (this: HTMLElement) {
        const index = this.getAttribute('data-timeline-index');
        return index === null ? 0 : 240 + Number(index) * 60;
      });
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-timeline-index') ? 3 : 0;
      });
    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('data-testid') === 'session-timeline-viewport'
          ? 220
          : 0;
      });
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('data-testid') === 'session-timeline-viewport'
          ? 1200
          : 0;
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    try {
      renderInto(root, simpleTurns(3));
      await nextFrame();

      renderInto(root, simpleTurns(80));
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="session-timeline-viewport"]',
      );
      expect(viewport).not.toBeNull();
      expect(viewport!.scrollTop).toBeGreaterThan(0);

      const currentButton = container.querySelector<HTMLButtonElement>(
        '[data-turn-id="u80"] button',
      );
      expect(currentButton).not.toBeNull();
      focusIn(currentButton!);
      expect(
        document.querySelector('[data-testid="session-timeline-detail"]'),
      ).not.toBeNull();

      act(() =>
        viewport!.dispatchEvent(new Event('scroll', { bubbles: true })),
      );
      expect(
        document.querySelector('[data-testid="session-timeline-detail"]'),
      ).not.toBeNull();

      await nextFrame();
      act(() =>
        viewport!.dispatchEvent(new Event('scroll', { bubbles: true })),
      );
      expect(
        document.querySelector('[data-testid="session-timeline-detail"]'),
      ).toBeNull();
    } finally {
      scrollHeightSpy.mockRestore();
      clientHeightSpy.mockRestore();
      offsetHeightSpy.mockRestore();
      offsetTopSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('hides timeline details when the focused marker moves out of view', async () => {
    let markerOffset = 0;
    const rect = (
      width: number,
      height: number,
      top: number,
      left = 0,
    ): DOMRect => ({
      width,
      height,
      top,
      right: left + width,
      bottom: top + height,
      left,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('data-testid') === 'session-timeline-viewport') {
          return rect(70, 220, 0);
        }
        const item = this.closest('[data-testid="session-timeline-entry"]');
        if (item) {
          const index = Number(item.getAttribute('data-timeline-index'));
          return rect(58, 16, 40 + index * 60 - markerOffset);
        }
        return rect(1200, 600, 0);
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    try {
      renderInto(root, simpleTurns(4));
      await nextFrame();

      const focusedButton = container.querySelector<HTMLButtonElement>(
        '[data-turn-id="u2"] button',
      );
      expect(focusedButton).not.toBeNull();
      focusIn(focusedButton!);
      expect(
        document.querySelector('[data-testid="session-timeline-detail"]'),
      ).not.toBeNull();

      markerOffset = 700;
      act(() => window.dispatchEvent(new Event('resize')));

      expect(
        document.querySelector('[data-testid="session-timeline-detail"]'),
      ).toBeNull();
      expect(
        container
          .querySelector<HTMLButtonElement>('[data-turn-id="u2"] button')
          ?.hasAttribute('aria-describedby'),
      ).toBe(false);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('keeps timeline details when focus scrolls the timeline viewport', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount(simpleTurns(4));
    await nextFrame();

    const firstEntryButton = c.querySelector<HTMLButtonElement>(
      '[data-turn-id="u1"] button',
    );
    const viewport = c.querySelector<HTMLElement>(
      '[data-testid="session-timeline-viewport"]',
    );
    expect(firstEntryButton).not.toBeNull();
    expect(viewport).not.toBeNull();
    focusIn(firstEntryButton!);
    expect(
      document.querySelector('[data-testid="session-timeline-detail"]'),
    ).not.toBeNull();

    act(() => viewport!.dispatchEvent(new Event('scroll', { bubbles: true })));

    expect(
      document.querySelector('[data-testid="session-timeline-detail"]'),
    ).not.toBeNull();
    expect(firstEntryButton?.hasAttribute('aria-describedby')).toBe(true);
    rectSpy.mockRestore();
  });

  it('hides timeline details when the user scrolls the timeline viewport', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount(simpleTurns(4));
    await nextFrame();

    const firstEntryButton = c.querySelector<HTMLButtonElement>(
      '[data-turn-id="u1"] button',
    );
    const viewport = c.querySelector<HTMLElement>(
      '[data-testid="session-timeline-viewport"]',
    );
    expect(firstEntryButton).not.toBeNull();
    expect(viewport).not.toBeNull();
    focusIn(firstEntryButton!);
    expect(
      document.querySelector('[data-testid="session-timeline-detail"]'),
    ).not.toBeNull();

    await nextFrame();
    act(() => viewport!.dispatchEvent(new Event('scroll', { bubbles: true })));

    expect(
      document.querySelector('[data-testid="session-timeline-detail"]'),
    ).toBeNull();
    expect(firstEntryButton?.hasAttribute('aria-describedby')).toBe(false);
    rectSpy.mockRestore();
  });

  it('renders scheduled task marker when source is present', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount([
      // Source propagation is owned by the metadata adapter PR; this test covers
      // the timeline rendering contract once that source is present.
      { ...userMsg('u1'), source: 'cron', content: 'scheduled tracking task' },
      asstMsg('a1'),
      userMsg('u2'),
      asstMsg('a2'),
      userMsg('u3'),
      asstMsg('a3'),
      userMsg('u4'),
      asstMsg('a4'),
    ]);
    await nextFrame();

    const scheduledButton = c.querySelector<HTMLButtonElement>(
      '[data-turn-id="u1"] button',
    );
    expect(scheduledButton).not.toBeNull();
    focusIn(scheduledButton!);

    const scheduledDetail = document.querySelector(
      '[data-testid="session-timeline-detail"]',
    );
    expect(scheduledDetail?.getAttribute('data-scheduled-task')).toBe('true');
    expect(
      scheduledDetail?.querySelector(`.${styles.sessionTimelineDetailsIcon}`),
    ).not.toBeNull();
    expect(scheduledDetail?.textContent).toContain('scheduled tracking task');
    rectSpy.mockRestore();
  });

  it('hides the session timeline until there are at least four turns', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const c = mount(simpleTurns(3));
    await nextFrame();

    expect(c.querySelector('[data-testid="session-timeline"]')).toBeNull();
    rectSpy.mockRestore();
  });

  it('clicks a session timeline entry to jump to its turn', async () => {
    const rectSpy = mockMessageListWidth(1200);
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const c = mount(simpleTurns(4));
    await nextFrame();

    const secondEntryButton = c.querySelector<HTMLButtonElement>(
      '[data-turn-id="u2"] button',
    );
    expect(secondEntryButton).not.toBeNull();
    act(() => {
      secondEntryButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    await nextFrame();

    const targetMessage = c.querySelector('[data-testid="msg-u2"]');
    expect(targetMessage?.getAttribute('data-locate-flashing')).toBe('true');
    expect(targetMessage?.closest('[data-index]')?.className).not.toMatch(
      /flash/i,
    );
    scrollIntoView.mockRestore();
    rectSpy.mockRestore();
  });

  it('flashes grouped parallel agents inside the row when locating a tool', async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const ref = createRef<MessageListHandle>();
    const c = mount(
      [userMsg('u1'), agentMsg('g1'), agentMsg('g2'), asstMsg('a1')],
      ref,
    );

    let found = false;
    act(() => {
      found = ref.current!.scrollToMessage('g1', 'call-g1');
    });
    await nextFrame();

    expect(found).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    const parallelAgents = c.querySelector('[data-testid="parallel-agents"]');
    expect(parallelAgents?.parentElement?.className).toContain(
      flashStyles.flash,
    );
    expect(parallelAgents?.closest('[data-index]')?.className).not.toMatch(
      /flash/i,
    );
    scrollIntoView.mockRestore();
  });

  it('hides the session timeline when the message list is narrow', async () => {
    const rectSpy = mockMessageListWidth(1000);

    const c = mount(simpleTurns(4));
    await nextFrame();

    expect(c.querySelector('[data-testid="session-timeline"]')).toBeNull();
    rectSpy.mockRestore();
  });

  it('hides the session timeline when the caller disables it', async () => {
    const rectSpy = mockMessageListWidth(1200);

    const c = mount(simpleTurns(4), undefined, {
      hideSessionTimeline: true,
    });
    await nextFrame();

    expect(c.querySelector('[data-testid="session-timeline"]')).toBeNull();
    rectSpy.mockRestore();
  });

  it('hides the session timeline when the message list has no width', async () => {
    const rectSpy = mockMessageListWidth(0);

    const c = mount(simpleTurns(4));
    await nextFrame();

    expect(c.querySelector('[data-testid="session-timeline"]')).toBeNull();
    rectSpy.mockRestore();
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

  it('smooth-scrolls the page when a new chat prompt appears', async () => {
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

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, [userMsg('u1'), asstMsg('a1')]);
    renderInto(root, [userMsg('u1'), asstMsg('a1'), userMsg('u2')]);
    await nextFrame();

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });

  it('does not smooth-scroll when initial history already contains a user prompt', () => {
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

    mount([userMsg('u1'), asstMsg('a1')]);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('shows a transcript skeleton while loading transcript', () => {
    const c = mount([], undefined, { loadingTranscript: true });

    expect(
      c.querySelector('[data-testid="message-list-loading-skeleton"]'),
    ).not.toBeNull();
    expect(c.querySelector('[role="status"]')?.textContent).toBe(
      'Session is still loading. Try again in a moment.',
    );
  });

  it('shows the transcript skeleton while loading transcript with existing messages', () => {
    const c = mount([userMsg('u1')], undefined, {
      loadingTranscript: true,
    });

    expect(
      c.querySelector('[data-testid="message-list-loading-skeleton"]'),
    ).not.toBeNull();
  });

  it('does not show the transcript skeleton outside transcript loading', () => {
    const idle = mount([]);

    expect(
      idle.querySelector('[data-testid="message-list-loading-skeleton"]'),
    ).toBeNull();
  });

  it('loads earlier history once when the transcript reaches the top', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    const list = c.querySelector('[data-web-shell-message-list]');
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    await act(async () => {
      list?.dispatchEvent(new Event('scroll'));
      list?.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('preserves the scroll anchor after prepending earlier history', async () => {
    let scrollHeight = 1200;
    let scrollTop = 40;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const onLoadOlderHistory = vi.fn(async () => {
      scrollHeight = 1800;
    });
    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    scrollTop = 40;

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(scrollTop).toBe(640);
  });

  it('loads earlier history when the transcript does not overflow', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);

    mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('loads earlier history when a resize removes the overflow', async () => {
    let clientHeight = 600;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);

    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    expect(onLoadOlderHistory).not.toHaveBeenCalled();
    expect(list.scrollHeight).toBe(1200);
    expect(list.clientHeight).toBe(600);

    clientHeight = 1200;
    expect(list.clientHeight).toBe(1200);
    await act(async () => {
      triggerResizeObservers();
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('shows a status while loading earlier history', () => {
    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      loadingOlderHistory: true,
    });

    expect(c.querySelector('[role="status"]')?.textContent).toBe(
      'Loading earlier messages…',
    );
    expect(c.querySelector('button')).toBeNull();
  });

  it('shows when the history display limit is reached', () => {
    const c = mount([userMsg('u1')], undefined, {
      historyCapacityReached: true,
    });

    expect(c.querySelector('[role="status"]')?.textContent).toBe(
      'History display limit reached. Earlier messages remain saved.',
    );
  });

  it('does not smooth-scroll when existing session history loads after an empty render', () => {
    const scrollTo = vi.fn();
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, []);
    renderInto(root, [userMsg('u1'), asstMsg('a1')]);

    expect(scrollTop).toBe(1200);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('smooth-scrolls the first new prompt after an empty render', async () => {
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
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, []);
    renderInto(root, [userMsg('u1')]);
    await nextFrame();

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });

  it('does not smooth-scroll restored history that ends with a user prompt', async () => {
    const scrollTo = vi.fn();
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, [], undefined, { loadingTranscript: true });
    renderInto(root, [userMsg('u1')], undefined, {
      loadingTranscript: false,
    });
    await nextFrame();

    expect(scrollTop).toBe(1200);
    expect(scrollTo).not.toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });

  it('does not smooth-scroll when a user prompt is already followed by an assistant row', async () => {
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
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, [userMsg('u1'), asstMsg('a1')]);
    renderInto(root, [
      userMsg('u1'),
      asstMsg('a1'),
      userMsg('u2'),
      asstMsg('a2'),
    ]);
    await nextFrame();

    expect(scrollTo).not.toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });

  it('snaps to bottom without smooth scrolling when catch-up completes', () => {
    const scrollTo = vi.fn();
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const messages = [userMsg('u1'), asstMsg('a1')];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    renderInto(root, messages, undefined, { catchingUp: true });
    expect(scrollTop).toBe(0);

    renderInto(root, messages, undefined, { catchingUp: false });

    expect(scrollTop).toBe(1200);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not treat a user_shell row as a new chat prompt', () => {
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

    mount([userShellMsg('shell')]);

    expect(scrollTo).not.toHaveBeenCalledWith({
      top: 1200,
      behavior: 'smooth',
    });
  });

  it('shows assistant actions on the final answer of a user_shell turn', () => {
    const c = mount([
      userShellMsg('shell'),
      asstMsg('mid'),
      toolMsg('tool'),
      asstMsg('a1'),
    ]);

    expect(assistantActions(c, 'mid')).toBe('false');
    expect(assistantActions(c, 'a1')).toBe('true');
  });

  it('reports when the user has scrolled away from the bottom', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      value: 600,
      writable: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    const onCanScrollToBottomChange = vi.fn();

    const container = mount([asstMsg('a1')], undefined, {
      onCanScrollToBottomChange,
    });
    await nextFrame();

    const list = container.firstElementChild as HTMLElement;
    list.scrollTop = 600;
    act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    await nextFrame();

    list.scrollTop = 500;
    act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(true);

    list.scrollTop = 600;
    act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('reports no scroll-to-bottom affordance when the list has no scrollbar', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onCanScrollToBottomChange = vi.fn();

    mount([userMsg('u1')], undefined, { onCanScrollToBottomChange });
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('reports no scroll-to-bottom affordance when already at the bottom', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      value: 600,
      writable: true,
    });
    const onCanScrollToBottomChange = vi.fn();

    mount([userMsg('u1')], undefined, { onCanScrollToBottomChange });
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the scroll-to-bottom affordance hidden when followed content grows', async () => {
    let scrollHeight = 600;
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 600));
      },
    });
    const onCanScrollToBottomChange = vi.fn();

    mount([asstMsg('a1')], undefined, { onCanScrollToBottomChange });
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);

    scrollHeight = 1200;
    act(() => triggerResizeObservers());
    await nextFrame();
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('reports scroll-to-bottom affordance when a clicked disclosure grows during streaming', async () => {
    let scrollHeight = 600;
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 600));
      },
    });
    const onCanScrollToBottomChange = vi.fn();
    const c = mount([thinkingMsg('t1'), asstMsg('a1')], undefined, {
      isResponding: true,
      onCanScrollToBottomChange,
    });
    await nextFrame();

    click(disclosure(c, 't1'));

    scrollHeight = 1200;
    act(() => triggerResizeObservers());
    await nextFrame();
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(true);
  });

  it('keeps the scroll-to-bottom affordance hidden when disclosure growth stays near bottom', async () => {
    let scrollHeight = 600;
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 600));
      },
    });
    const onCanScrollToBottomChange = vi.fn();
    const c = mount([thinkingMsg('t1'), asstMsg('a1')], undefined, {
      isResponding: true,
      onCanScrollToBottomChange,
    });
    await nextFrame();

    click(disclosure(c, 't1'));

    scrollHeight = 620;
    act(() => triggerResizeObservers());
    await nextFrame();
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('clears the scroll-to-bottom affordance immediately after scrolling to bottom', async () => {
    let scrollTop = 600;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, 600));
      },
    });
    const onCanScrollToBottomChange = vi.fn();
    const ref = createRef<MessageListHandle>();
    const c = mount([asstMsg('a1')], ref, { onCanScrollToBottomChange });
    await nextFrame();
    await nextFrame();

    const list = c.firstElementChild as HTMLElement;
    scrollTop = 0;
    act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(true);

    act(() => ref.current?.scrollToBottom('auto'));

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(false);
  });

  it('reports scroll-to-bottom affordance when expanding content creates overflow', async () => {
    let scrollHeight = 600;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      value: 0,
      writable: true,
    });
    const onCanScrollToBottomChange = vi.fn();
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')], undefined, {
      onCanScrollToBottomChange,
    });
    await nextFrame();

    click(toggle(c, 'u1'));
    scrollHeight = 1200;
    await nextFrame();
    await nextFrame();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 230)));
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(true);
  });
});
