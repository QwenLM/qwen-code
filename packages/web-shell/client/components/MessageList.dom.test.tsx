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
import {
  TranscriptRenderModeProvider,
  type TranscriptRenderMode,
} from '../transcriptRenderMode';
import { WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS } from '../constants/sessions';
import flashStyles from './MessageLocateFlash.module.css';
import styles from './MessageList.module.css';

const virtualizerTestState = vi.hoisted(() => ({
  itemSizeCache: new Map<string | number, number>(),
  resizeItem: vi.fn(),
  renderItems: true,
}));

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
      showAssistantBranch,
      onBranchSession,
      branchRecordId,
      isLocateFlashing,
      assistantTurnFooterInfo,
      sendFailed,
      onRetrySend,
    }: {
      message: Message;
      showAssistantActions?: boolean;
      showAssistantBranch?: boolean;
      onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
      branchRecordId?: string;
      isLocateFlashing?: boolean;
      assistantTurnFooterInfo?: WebShellAssistantTurnFooterRenderInfo;
      sendFailed?: boolean;
      onRetrySend?: () => void;
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
          'data-send-failed': sendFailed ? 'true' : undefined,
          'data-timestamp': message.timestamp,
          'data-tool-ids':
            message.role === 'tool_group'
              ? message.tools.map((tool) => tool.callId).join(',')
              : undefined,
        },
        sendFailed
          ? React.createElement(
              'button',
              {
                'data-testid': `retry-${message.id}`,
                onClick: onRetrySend,
                type: 'button',
              },
              'retry',
            )
          : null,
        message.role === 'thinking'
          ? React.createElement('button', {
              'aria-expanded': 'false',
              'data-testid': `disclosure-${message.id}`,
            })
          : null,
        showAssistantBranch
          ? React.createElement('button', {
              'data-testid': `branch-${message.id}`,
              onClick: () => onBranchSession?.(branchRecordId),
            })
          : null,
        assistantTurnFooter,
      );
    },
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
    const virtualItems =
      enabled && virtualizerTestState.renderItems
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
      resizeItem: virtualizerTestState.resizeItem,
      itemSizeCache: virtualizerTestState.itemSizeCache,
      scrollToIndex: () => {},
    };
  },
}));

const { MessageList } = await import('./MessageList');
const { CompactModeContext } = await import('../App');
type MessageListHandle = import('./MessageList').MessageListHandle;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom provides neither ResizeObserver (MessageList's resize guard) nor a real
// scrollIntoView (the non-virtual scroll path) — stub both.
const resizeObserverCallbacks: ResizeObserverCallback[] = [];
let resizeObserversFireOnObserve = true;
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {
    if (resizeObserversFireOnObserve) {
      this.callback([], this as unknown as ResizeObserver);
    }
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

const mounted: Array<{
  root: Root;
  container: HTMLElement;
  transcriptRenderMode: TranscriptRenderMode;
  compactMode: boolean;
}> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  resizeObserverCallbacks.length = 0;
  resizeObserversFireOnObserve = true;
  virtualizerTestState.itemSizeCache.clear();
  virtualizerTestState.resizeItem.mockClear();
  virtualizerTestState.renderItems = true;
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      toolName: 'Agent',
      status: 'completed',
      args: { subagent_type: 'explore', run_in_background: true },
    },
  ],
});
const standaloneToolMsg = (id: string, toolName: string): ToolGroupMessage => ({
  id,
  role: 'tool_group',
  tools: [{ callId: `call-${id}`, toolName, status: 'completed' }],
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
const backgroundNotificationMsg = (
  id: string,
  toolUseId?: string,
): SystemMessage => ({
  id,
  role: 'system',
  content: 'Background agent completed.',
  variant: 'info',
  source: 'background_notification',
  ...(toolUseId ? { data: { kind: 'agent', toolUseId } } : {}),
});
const monitorNotificationMsg = (id: string): SystemMessage => ({
  id,
  role: 'system',
  content: 'Background monitor completed.',
  variant: 'info',
  source: 'background_notification',
  data: { kind: 'monitor' },
});
const describedAgentMsg = (
  id: string,
  description: string,
): ToolGroupMessage => ({
  id,
  role: 'tool_group',
  tools: [
    {
      callId: `call-${id}`,
      toolName: 'Agent',
      status: 'completed',
      args: { subagent_type: 'explore', description, run_in_background: true },
    },
  ],
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
    historyPaginationError?: boolean;
    onLoadOlderHistory?: (options?: { force?: boolean }) => Promise<void>;
    transcriptBlockCount?: number;
    transcriptActivity?: {
      getSnapshot(): {
        lastEventId?: number;
        blocks?: { readonly length: number };
      };
      subscribe(listener: () => void): () => void;
    };
    onReloadTranscript?: (signal: AbortSignal) => Promise<void>;
    isResponding?: boolean;
    transcriptRenderMode?: TranscriptRenderMode;
    hideFirstUserMessage?: boolean;
    firstTurnMetrics?: {
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
    };
    includeSubagentToolUsageInMetrics?: boolean;
    onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
    onCanScrollToBottomChange?: (canScrollToBottom: boolean) => void;
    customization?: WebShellCustomization;
    compactMode?: boolean;
    failedPromptMessageId?: string;
    onRetryFailedPrompt?: () => void;
  } = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={opts.customization ?? {}}>
          <CompactModeContext.Provider value={opts.compactMode ?? false}>
            <TranscriptRenderModeProvider
              value={opts.transcriptRenderMode ?? 'interactive'}
            >
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
                historyPaginationError={opts.historyPaginationError}
                onLoadOlderHistory={opts.onLoadOlderHistory}
                transcriptBlockCount={opts.transcriptBlockCount}
                transcriptActivity={opts.transcriptActivity}
                onReloadTranscript={opts.onReloadTranscript}
                isResponding={opts.isResponding}
                hideFirstUserMessage={opts.hideFirstUserMessage}
                firstTurnMetrics={opts.firstTurnMetrics}
                includeSubagentToolUsageInMetrics={
                  opts.includeSubagentToolUsageInMetrics
                }
                onBranchSession={opts.onBranchSession}
                onCanScrollToBottomChange={opts.onCanScrollToBottomChange}
                failedPromptMessageId={opts.failedPromptMessageId}
                onRetryFailedPrompt={opts.onRetryFailedPrompt}
              />
            </TranscriptRenderModeProvider>
          </CompactModeContext.Provider>
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({
    root,
    container,
    transcriptRenderMode: opts.transcriptRenderMode ?? 'interactive',
    compactMode: opts.compactMode ?? false,
  });
  return container;
}

function rerenderMessages(
  container: HTMLElement,
  messages: Message[],
  opts: {
    loadingTranscript?: boolean;
    catchingUp?: boolean;
    isResponding?: boolean;
  } = {},
): void {
  const entry = mounted.find((item) => item.container === container);
  if (!entry) throw new Error('Expected mounted MessageList root');
  act(() => {
    entry.root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={{}}>
          <CompactModeContext.Provider value={entry.compactMode}>
            <TranscriptRenderModeProvider value={entry.transcriptRenderMode}>
              <MessageList
                messages={messages}
                pendingApproval={null}
                loadingTranscript={opts.loadingTranscript}
                catchingUp={opts.catchingUp}
                isResponding={opts.isResponding}
              />
            </TranscriptRenderModeProvider>
          </CompactModeContext.Provider>
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
}

function parallelAgentsSummary(
  container: HTMLElement,
): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Parallel agents'),
    ) ?? null
  );
}

function renderInto(
  root: Root,
  messages: Message[],
  ref?: RefObject<MessageListHandle | null>,
  opts: {
    loadingTranscript?: boolean;
    catchingUp?: boolean;
    isResponding?: boolean;
    onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
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
          onBranchSession={opts.onBranchSession}
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
  c.querySelector(`[data-testid="msg-${id}"]`) === null;
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

describe('MessageList — failed prompt retry', () => {
  it('marks only the matching user message and forwards retry', () => {
    const onRetry = vi.fn();
    const container = mount([userMsg('u1'), userMsg('u2')], undefined, {
      failedPromptMessageId: 'u1',
      onRetryFailedPrompt: onRetry,
    });

    expect(
      container
        .querySelector('[data-testid="msg-u1"]')
        ?.getAttribute('data-send-failed'),
    ).toBe('true');
    expect(
      container
        .querySelector('[data-testid="msg-u2"]')
        ?.getAttribute('data-send-failed'),
    ).toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry-u1"]')
        ?.click(),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('MessageList — compact mode', () => {
  it('keeps thinking without adjacent tools visible in compact mode', () => {
    const container = mount(
      [userMsg('u1'), thinkingMsg('t1'), asstMsg('a1')],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(container.querySelector('[data-testid="msg-u1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-t1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();

    rerenderMessages(container, [
      userMsg('u1'),
      thinkingMsg('t1'),
      thinkingMsg('t2'),
      asstMsg('a1'),
    ]);
    // With turn collapsing back on, the completed thinking folds behind the
    // turn summary instead of hiding the surrounding transcript.
    expect(container.querySelector('[data-testid="msg-t2"]')).toBeNull();
    expect(container.querySelector('[data-testid="msg-u1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();
  });

  it('merges tool groups separated by completed thinking', () => {
    const container = mount(
      [
        userMsg('u1'),
        { ...toolMsg('g1'), timestamp: 1_000 },
        thinkingMsg('t1'),
        { ...toolMsg('g2'), timestamp: 2_000 },
        asstMsg('a1'),
        userMsg('u2'),
        toolMsg('g3'),
      ],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(
      container.querySelector('[data-testid="msg-summary-g1"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-g2"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="msg-summary-g1"]')
        ?.getAttribute('data-timestamp'),
    ).toBe('1000');
    expect(
      container
        .querySelector('[data-testid="msg-summary-g1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-g1,call-g2');
    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="msg-summary-g3"]'),
    ).not.toBeNull();
  });

  it('keeps visible thinking and tool groups in transcript order', () => {
    const container = mount(
      [
        userMsg('u1'),
        toolMsg('g1'),
        thinkingMsg('t1'),
        toolMsg('g2'),
        asstMsg('a1'),
      ],
      undefined,
      { customization: { collapseCompletedTurns: false } },
    );

    expect(container.querySelector('[data-testid="msg-t1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-g1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-g2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('[data-testid^="msg-"]')).map(
        (element) => element.getAttribute('data-testid'),
      ),
    ).toEqual(['msg-u1', 'msg-g1', 'msg-t1', 'msg-g2', 'msg-a1']);
  });

  it('keeps agent groups on their parallel-agent path', () => {
    const container = mount(
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        thinkingMsg('t1'),
        agentMsg('agent-2'),
      ],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(parallelAgentsSummary(container)).not.toBeNull();
  });

  it.each(['TodoWrite', 'AskUserQuestion'])(
    'keeps %s groups separate across hidden thinking',
    (toolName) => {
      const container = mount(
        [
          toolMsg('g1'),
          thinkingMsg('t1'),
          standaloneToolMsg('special', toolName),
        ],
        undefined,
        {
          compactMode: true,
          customization: { collapseCompletedTurns: false },
        },
      );

      expect(
        container.querySelector('[data-testid="msg-summary-g1"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="msg-special"]'),
      ).not.toBeNull();
    },
  );

  it.each([
    ['TodoWrite', standaloneToolMsg('special', 'TodoWrite')],
    ['AskUserQuestion', standaloneToolMsg('special', 'AskUserQuestion')],
    ['agent', agentMsg('special')],
  ])('does not merge a leading %s group with later tools', (_name, special) => {
    const container = mount(
      [special, thinkingMsg('t1'), toolMsg('g2')],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(
      container.querySelector('[data-testid="msg-special"]'),
    ).not.toBeNull();
    // The completed thinking folds into the adjacent tool group, which keeps
    // the tool while the standalone group stays separate.
    expect(
      container
        .querySelector('[data-testid="msg-special"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-special');
    expect(
      container
        .querySelector('[data-testid="msg-summary-t1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-g2');
    expect(container.querySelector('[data-testid="msg-g2"]')).toBeNull();
  });
});

describe('MessageList — turn collapse (DOM)', () => {
  it('reloads an oversized transcript after 120 quiet seconds at the tail', async () => {
    vi.useFakeTimers();
    const onReloadTranscript = vi.fn().mockResolvedValue(undefined);
    let lastEventId = 10;
    let notifyActivity = () => undefined;
    mount([userMsg('u1'), asstMsg('a1')], undefined, {
      transcriptBlockCount: WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 1,
      transcriptActivity: {
        getSnapshot: () => ({ lastEventId }),
        subscribe: (listener) => {
          notifyActivity = listener;
          return () => undefined;
        },
      },
      onReloadTranscript,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      lastEventId++;
      notifyActivity();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onReloadTranscript).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(onReloadTranscript).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(onReloadTranscript).toHaveBeenCalledOnce();

    lastEventId++;
    notifyActivity();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(onReloadTranscript).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight transcript reload when the reader leaves the tail', async () => {
    vi.useFakeTimers();
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
    let resolveReload = () => undefined;
    let reloadSignal: AbortSignal | undefined;
    const onReloadTranscript = vi.fn((signal: AbortSignal) => {
      reloadSignal = signal;
      return new Promise<void>((resolve) => {
        resolveReload = resolve;
      });
    });
    const container = mount([userMsg('u1'), asstMsg('a1')], undefined, {
      transcriptBlockCount: WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 1,
      onReloadTranscript,
    });

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(reloadSignal?.aborted).toBe(false);

    const list = container.firstElementChild as HTMLElement;
    list.scrollTop = 400;
    act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(reloadSignal?.aborted).toBe(true);

    await act(async () => resolveReload());
  });

  it('hides only the first user message and overrides first-turn metrics', () => {
    const c = mount(
      [
        { ...userMsg('u1'), content: 'first prompt' },
        toolMsg('g1'),
        asstMsg('a1'),
        { ...userMsg('u2'), content: 'second prompt' },
        toolMsg('g2'),
        asstMsg('a2'),
      ],
      undefined,
      {
        hideFirstUserMessage: true,
        firstTurnMetrics: {
          durationMs: 9_000,
          inputTokens: 1_200,
          outputTokens: 45,
          cachedTokens: 800,
        },
      },
    );

    expect(has(c, 'u1')).toBe(false);
    expect(has(c, 'u2')).toBe(true);
    expect(c.textContent).toContain('9s');
    expect(c.textContent).toContain('↑1.2k (800 cached, 67%) ↓45');
  });

  it('collapses a completed turn: hides the step, keeps prompt + answer, shows the toggle', () => {
    const c = mount([userMsg('u1'), toolMsg('g1'), asstMsg('a1')]);
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'a1')).toBe(true);
    expect(isCollapsed(c, 'g1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps latest assistant content when active agents are pinned after it', () => {
    const activeAgent = agentMsg('agent-1');
    activeAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      activeAgent,
      agentMsg('agent-2'),
      asstMsg('a1'),
    ]);

    expect(assistantActions(c, 'a1')).toBe('false');
    click(toggle(c, 'u1'));
    expect(has(c, 'a1')).toBe(true);
    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('does not mark narration as final before agents are summarized', () => {
    const activeAgent = agentMsg('agent-1');
    activeAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      activeAgent,
      agentMsg('agent-2'),
      asstMsg('a1'),
    ]);

    expect(assistantActions(c, 'a1')).toBe('false');

    const awaitingSummaryMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('a1'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
    ];
    rerenderMessages(c, awaitingSummaryMessages);
    expect(assistantActions(c, 'a1')).toBe('false');

    rerenderMessages(c, [...awaitingSummaryMessages, asstMsg('summary')]);
    expect(assistantActions(c, 'a1')).toBe('false');
    expect(assistantActions(c, 'summary')).toBe('true');
  });

  it('keeps actions suppressed for stale agents until they reconcile terminal', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const messages = [userMsg('u1'), firstAgent, secondAgent, asstMsg('a1')];
    const c = mount(messages, undefined, {
      catchingUp: true,
      isResponding: false,
    });

    rerenderMessages(c, messages, {
      catchingUp: false,
      isResponding: false,
    });
    expect(assistantActions(c, 'a1')).toBe('false');

    rerenderMessages(
      c,
      [userMsg('u1'), agentMsg('agent-1'), agentMsg('agent-2'), asstMsg('a1')],
      { catchingUp: false, isResponding: false },
    );
    expect(assistantActions(c, 'a1')).toBe('true');
  });

  it('shows final actions for stale agents in a readonly transcript', () => {
    const staleAgent = agentMsg('agent-1');
    staleAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), staleAgent, asstMsg('a1')], undefined, {
      transcriptRenderMode: 'readonly',
    });

    expect(assistantActions(c, 'a1')).toBe('true');
  });

  it('keeps final actions for a pending foreground agent in a completed turn', () => {
    const foregroundAgent = agentMsg('agent-1');
    foregroundAgent.tools[0]!.status = 'pending';
    foregroundAgent.tools[0]!.args = {
      subagent_type: 'explore',
      run_in_background: false,
    };
    const c = mount([userMsg('u1'), foregroundAgent, asstMsg('a1')]);

    expect(assistantActions(c, 'a1')).toBe('true');
  });

  it('keeps turn-2 final actions while a turn-1 agent stays pending', () => {
    const pendingAgent = agentMsg('agent-1');
    pendingAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      pendingAgent,
      asstMsg('a1'),
      userMsg('u2'),
      asstMsg('a2'),
    ]);

    expect(assistantActions(c, 'a2')).toBe('true');
    expect(assistantActions(c, 'a1')).toBe('false');
  });

  it('releases a delayed sibling footer hold only after a bounded grace', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('launched'),
    ]);

    const secondAgentStillActive = agentMsg('agent-2');
    secondAgentStillActive.tools[0]!.status = 'pending';
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      secondAgentStillActive,
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
    ]);
    expect(assistantActions(c, 'waiting')).toBe('false');

    // The sibling reconciles terminal before its notification arrives: the
    // hold stays until the grace expires, in case the notification is merely
    // delayed.
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
    ]);
    expect(assistantActions(c, 'waiting')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(assistantActions(c, 'waiting')).toBe('true');

    // A late notification still re-hides the narration until the summary.
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
      asstMsg('summary'),
    ]);
    expect(assistantActions(c, 'waiting')).toBe('false');
    expect(assistantActions(c, 'summary')).toBe('true');
  });

  it('restores final actions when a completed sibling notification is lost', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('launched'),
    ]);

    const secondAgentStillActive = agentMsg('agent-2');
    secondAgentStillActive.tools[0]!.status = 'pending';
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      secondAgentStillActive,
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
    ]);
    expect(assistantActions(c, 'waiting')).toBe('false');

    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('summary'),
    ]);
    // The hold survives until the grace expires, in case the sibling
    // notification is merely delayed; afterwards the lost notification can
    // no longer hide the final answer.
    expect(assistantActions(c, 'summary')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(assistantActions(c, 'summary')).toBe('true');
  });

  it('does not restart the unmatched-completion grace for a non-agent notification', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('launched'),
    ]);

    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('summary'),
    ]);
    // The sibling's completion notification is lost: the hold is bounded.
    expect(assistantActions(c, 'summary')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    // A non-agent notification must not restart the grace timer; the bound
    // still runs from the agent notification.
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('summary'),
      monitorNotificationMsg('monitor'),
    ]);
    expect(assistantActions(c, 'summary')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(assistantActions(c, 'summary')).toBe('true');
  });

  it('keeps a released footer released for a monitor notification after a catch-up cycle', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('launched'),
    ]);

    const secondAgentStillActive = agentMsg('agent-2');
    secondAgentStillActive.tools[0]!.status = 'pending';
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      secondAgentStillActive,
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
    ]);
    expect(assistantActions(c, 'waiting')).toBe('false');

    // The second sibling reconciles terminal before its notification arrives;
    // the hold lasts until the bounded grace expires.
    const settled = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('waiting'),
    ];
    rerenderMessages(c, settled);
    expect(assistantActions(c, 'waiting')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(assistantActions(c, 'waiting')).toBe('true');

    // A catch-up cycle re-establishes the notification baseline, so the
    // grace deactivates without any agent notification or turn change.
    rerenderMessages(c, settled, { catchingUp: true });
    rerenderMessages(c, settled, { catchingUp: false });
    expect(assistantActions(c, 'waiting')).toBe('true');

    // A non-agent notification reactivates the coarse grace afterwards but
    // cannot change which agents are unmatched, so it must not re-arm the
    // expired latch and re-hide the already-released footer. The turn stays
    // released: `undefined` means it even collapsed (the narration row is
    // folded away), which is the opposite of a re-hide.
    rerenderMessages(c, [...settled, monitorNotificationMsg('monitor')], {
      catchingUp: false,
    });
    expect(assistantActions(c, 'waiting')).not.toBe('false');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(assistantActions(c, 'waiting')).not.toBe('false');

    // A genuine new lost-completion episode in the same turn still receives
    // a full grace window after the catch-up cycle. The model narrates after
    // launching agent-3, so the turn's final footer is gated again.
    rerenderMessages(
      c,
      [
        ...settled,
        monitorNotificationMsg('monitor'),
        agentMsg('agent-3'),
        asstMsg('final'),
      ],
      { catchingUp: false },
    );
    expect(assistantActions(c, 'final')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(assistantActions(c, 'final')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(assistantActions(c, 'final')).toBe('true');
  });

  it('does not consume the unmatched-completion grace while the turn is still streaming', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount(
      [userMsg('u1'), firstAgent, secondAgent, asstMsg('launched')],
      undefined,
      { isResponding: true },
    );

    // Agent-1 completes mid-response while the model keeps streaming.
    const secondAgentStillActive = agentMsg('agent-2');
    secondAgentStillActive.tools[0]!.status = 'pending';
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        secondAgentStillActive,
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
      ],
      { isResponding: true },
    );

    // Agent-2 reconciles terminal with its notification delayed. isResponding
    // hides the turn anyway, so streaming past the grace window must not
    // consume the budget before the hold can actually gate the footer.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        agentMsg('agent-2'),
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
      ],
      { isResponding: true },
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // When streaming ends, the full grace window must still be available.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        agentMsg('agent-2'),
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
      ],
      { isResponding: false },
    );
    expect(assistantActions(c, 'launched')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(assistantActions(c, 'launched')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(assistantActions(c, 'launched')).toBe('true');
  });

  it('releases the footer after grace when the final narration precedes the notification', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('launched'),
    ]);

    // The sibling's notification lands after the turn's final narration (the
    // ordinary placement) and agent-2 reconciles terminal without its own
    // notification ever arriving.
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
    ]);
    expect(assistantActions(c, 'launched')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // Grace expiry must release the footer even though the narration
    // precedes the notification; a truly lost notification cannot hide the
    // final footer forever.
    expect(assistantActions(c, 'launched')).toBe('true');
  });

  it('gives a later lost-completion episode a full grace after an earlier matched hold', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    firstAgent.tools[0]!.status = 'pending';
    const c = mount(
      [userMsg('u1'), firstAgent, asstMsg('launched')],
      undefined,
      {
        isResponding: true,
      },
    );

    // Agent-1 completes mid-turn and its (matched) notification lands while
    // the model keeps working: a benign hold arms the grace timer.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
      ],
      { isResponding: true },
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    // The model launches agent-2 in the same turn and emits the final
    // answer; agent-2 is still active, so the footer stays suppressed.
    const secondAgent = agentMsg('agent-2');
    secondAgent.tools[0]!.status = 'pending';
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
        secondAgent,
        asstMsg('final'),
      ],
      { isResponding: false },
    );
    expect(assistantActions(c, 'final')).toBe('false');

    // Agent-2 reconciles terminal but its notification is lost. The genuine
    // unmatched episode must receive a fresh grace window even though the
    // benign mid-turn hold already expired the latch.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        asstMsg('launched'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
        agentMsg('agent-2'),
        asstMsg('final'),
      ],
      { isResponding: false },
    );
    expect(assistantActions(c, 'final')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(assistantActions(c, 'final')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(assistantActions(c, 'final')).toBe('true');
  });

  it('restarts the unmatched-completion grace when another agent notification lands mid-hold', () => {
    vi.useFakeTimers();
    const agents = [
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      agentMsg('agent-3'),
    ];
    for (const agent of agents) {
      agent.tools[0]!.status = 'pending';
    }
    const c = mount([userMsg('u1'), ...agents, asstMsg('launched')]);

    // All three reconcile terminal but only agent-1's notification arrives,
    // so the hold arms a 5s bound from T0.
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      agentMsg('agent-3'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      asstMsg('summary'),
    ]);
    expect(assistantActions(c, 'summary')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    // Agent-2's notification lands mid-hold while agent-3 stays unmatched;
    // the bound restarts from the new notification (keep the final narration
    // after it so the ordering rule does not mask the grace state).
    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      agentMsg('agent-3'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
      asstMsg('summary'),
    ]);
    expect(assistantActions(c, 'summary')).toBe('false');

    // The original bound (T0+5s) has passed; the restarted one still holds.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(assistantActions(c, 'summary')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(assistantActions(c, 'summary')).toBe('true');
  });

  it('keeps completed turn actions while the latest turn awaits agents', () => {
    const activeAgent = agentMsg('agent-2');
    activeAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      asstMsg('a1'),
      userMsg('u2'),
      agentMsg('agent-1'),
      activeAgent,
      asstMsg('a2'),
    ]);

    expect(assistantActions(c, 'a1')).toBe('true');
    expect(assistantActions(c, 'a2')).toBe('false');
  });

  it('keeps an automatically expanded terminal group mounted until its delay expires', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const activeMessages = [
      userMsg('u1'),
      firstAgent,
      secondAgent,
      asstMsg('answer'),
    ];
    const c = mount(activeMessages);

    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('answer'),
    ]);

    act(() => vi.advanceTimersByTime(1_499));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');

    act(() => vi.advanceTimersByTime(1));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
    expect(parallelAgentsSummary(c)?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    click(parallelAgentsSummary(c)!);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');

    act(() => vi.advanceTimersByTime(180));
    expect(parallelAgentsSummary(c)).toBeNull();
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('collapses a background notification before the final assistant content', () => {
    const c = mount([
      userMsg('u1'),
      backgroundNotificationMsg('bg1'),
      asstMsg('a1'),
    ]);

    expect(has(c, 'bg1')).toBe(false);
    expect(has(c, 'a1')).toBe(true);
    click(toggle(c, 'u1'));
    expect(has(c, 'bg1')).toBe(true);
  });

  it('does not reopen an initial history ending in a background notification', () => {
    const c = mount([
      userMsg('u1'),
      asstMsg('a1'),
      backgroundNotificationMsg('bg1'),
    ]);

    expect(has(c, 'a1')).toBe(false);
    expect(has(c, 'bg1')).toBe(true);
    click(toggle(c, 'u1'));
    expect(has(c, 'a1')).toBe(true);
  });

  it('expands active agents from the current turn after catch-up', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const messages = [userMsg('u1'), firstAgent, secondAgent];
    const c = mount(messages, undefined, {
      catchingUp: true,
      isResponding: false,
    });

    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    rerenderMessages(c, messages, {
      catchingUp: false,
      isResponding: false,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    rerenderMessages(c, messages, {
      catchingUp: false,
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('expands active agents when catch-up ends mid-response', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const messages = [userMsg('u1'), firstAgent, secondAgent];
    const c = mount(messages, undefined, {
      catchingUp: true,
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerenderMessages(c, messages, {
      catchingUp: false,
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('keeps agent groups static in a readonly transcript', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const messages = [userMsg('u1'), firstAgent, secondAgent];
    const c = mount(messages, undefined, {
      transcriptRenderMode: 'readonly',
      isResponding: true,
    });

    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    act(() => vi.advanceTimersByTime(3_000));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('keeps an earlier turn group collapsed when an unrelated response starts', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const messages = [userMsg('u1'), firstAgent, secondAgent, asstMsg('a1')];
    const c = mount(messages, undefined, { catchingUp: true });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerenderMessages(c, messages, { catchingUp: false });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerenderMessages(
      c,
      [...messages, userMsg('u2'), thinkingMsg('u2-thinking')],
      { catchingUp: false, isResponding: true },
    );
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('does not reopen a background notification loaded with transcript history', () => {
    const c = mount([], undefined, { loadingTranscript: true });

    rerenderMessages(
      c,
      [userMsg('u1'), asstMsg('a1'), backgroundNotificationMsg('bg1')],
      { loadingTranscript: false },
    );

    expect(has(c, 'a1')).toBe(false);
    expect(has(c, 'bg1')).toBe(true);
  });

  it('does not flash a grace window when catch-up delivers a notification', () => {
    const initialMessages = [
      userMsg('u1'),
      asstMsg('a1'),
      backgroundNotificationMsg('bg-old'),
    ];
    const c = mount(initialMessages);
    expect(has(c, 'a1')).toBe(false);

    rerenderMessages(c, initialMessages, { catchingUp: true });
    rerenderMessages(
      c,
      [...initialMessages, backgroundNotificationMsg('bg-new')],
      { catchingUp: false },
    );

    expect(has(c, 'a1')).toBe(false);
    expect(has(c, 'bg-new')).toBe(true);
  });

  it('does not briefly reopen agent history after an idle empty first render', () => {
    vi.useFakeTimers();
    const c = mount([]);

    rerenderMessages(c, [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('a1'),
      backgroundNotificationMsg('bg1'),
    ]);

    expect(parallelAgentsSummary(c)).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('keeps a newly appended background notification open until assistant content follows', () => {
    vi.useFakeTimers();
    const initialMessages = [userMsg('u1'), asstMsg('a1')];
    const c = mount(initialMessages);

    rerenderMessages(c, [...initialMessages, backgroundNotificationMsg('bg1')]);

    expect(has(c, 'a1')).toBe(true);
    expect(has(c, 'bg1')).toBe(true);

    act(() => vi.advanceTimersByTime(3_000));

    expect(has(c, 'a1')).toBe(true);
    expect(has(c, 'bg1')).toBe(true);

    rerenderMessages(c, [
      ...initialMessages,
      backgroundNotificationMsg('bg1'),
      asstMsg('summary'),
    ]);

    expect(has(c, 'a1')).toBe(false);
    expect(has(c, 'bg1')).toBe(false);
    expect(has(c, 'summary')).toBe(true);
  });

  it('starts collapsing when summary thinking begins', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    const thirdAgent = agentMsg('agent-3');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    thirdAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      secondAgent,
      thirdAgent,
      asstMsg('launched'),
    ]);
    const completedMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      agentMsg('agent-3'),
      asstMsg('launched'),
      backgroundNotificationMsg('bg1'),
      asstMsg('waiting-2'),
      backgroundNotificationMsg('bg2'),
      asstMsg('waiting-1'),
      backgroundNotificationMsg('bg3'),
    ];

    rerenderMessages(c, completedMessages.slice(0, 5));
    act(() => vi.advanceTimersByTime(1_000));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, completedMessages);
    act(() => vi.advanceTimersByTime(3_000));

    expect(has(c, 'bg1')).toBe(true);
    expect(has(c, 'bg2')).toBe(true);
    expect(has(c, 'bg3')).toBe(true);
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(
      c,
      [...completedMessages, thinkingMsg('summary-thinking')],
      { isResponding: true },
    );
    expect(has(c, 'bg1')).toBe(true);
    expect(has(c, 'bg2')).toBe(true);
    expect(has(c, 'bg3')).toBe(true);
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    act(() => vi.advanceTimersByTime(399));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    act(() => vi.advanceTimersByTime(1));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    act(() => vi.advanceTimersByTime(180));

    const streamingSummary = { ...asstMsg('summary'), isStreaming: true };
    rerenderMessages(c, [...completedMessages, streamingSummary], {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerenderMessages(c, [...completedMessages, asstMsg('summary')]);
    expect(has(c, 'bg1')).toBe(false);
    expect(has(c, 'bg2')).toBe(false);
    expect(has(c, 'bg3')).toBe(false);
    expect(has(c, 'summary')).toBe(true);
  });

  it('does not defer a completed agent group for an unrelated new turn', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent]);

    const completedTurn = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      backgroundNotificationMsg('bg1', 'call-agent-1'),
      backgroundNotificationMsg('bg2', 'call-agent-2'),
      asstMsg('u1-summary'),
    ];
    rerenderMessages(c, completedTurn);
    // Stay inside the 400ms summary-collapse window so the pending collapse
    // is live when the unrelated turn arrives.
    act(() => vi.advanceTimersByTime(200));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(
      c,
      [...completedTurn, userMsg('u2'), thinkingMsg('u2-thinking')],
      { isResponding: true },
    );
    act(() => vi.advanceTimersByTime(500));

    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('does not snap a mid-collapse agent group open for an unrelated new turn', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent]);

    const completedTurn = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      backgroundNotificationMsg('bg1', 'call-agent-1'),
      backgroundNotificationMsg('bg2', 'call-agent-2'),
      asstMsg('u1-summary'),
    ];
    rerenderMessages(c, completedTurn);
    // Advance into the 180ms exit animation (the collapse fires at 400ms).
    act(() => vi.advanceTimersByTime(500));
    expect(c.querySelector('[data-agent-collapse-exit="true"]')).not.toBeNull();

    rerenderMessages(
      c,
      [...completedTurn, userMsg('u2'), thinkingMsg('u2-thinking')],
      { isResponding: true },
    );
    act(() => vi.advanceTimersByTime(300));

    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('does not defer an agent group for a non-agent notification', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent]);
    const completedMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      backgroundNotificationMsg('bg1', 'call-agent-1'),
      backgroundNotificationMsg('bg2', 'call-agent-2'),
      asstMsg('agent-summary'),
    ];

    rerenderMessages(c, completedMessages);
    // Stay inside the 400ms summary-collapse window so the pending collapse
    // is live when the monitor notification arrives.
    act(() => vi.advanceTimersByTime(200));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(
      c,
      [...completedMessages, monitorNotificationMsg('monitor')],
      { isResponding: true },
    );
    // Observe between the scheduled 400ms collapse and a restarted window's
    // 600ms collapse: a restarted deferral would still be expanded here.
    act(() => vi.advanceTimersByTime(300));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    act(() => vi.advanceTimersByTime(200));

    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('defers an earlier turn agent group that completes in the current turn', () => {
    vi.useFakeTimers();
    const firstActiveAgent = agentMsg('agent-1');
    const secondActiveAgent = agentMsg('agent-2');
    firstActiveAgent.tools[0]!.status = 'pending';
    secondActiveAgent.tools[0]!.status = 'pending';
    const c = mount(
      [
        userMsg('u1'),
        firstActiveAgent,
        secondActiveAgent,
        asstMsg('u1-summary'),
        userMsg('u2'),
        thinkingMsg('waiting'),
      ],
      undefined,
      { isResponding: true },
    );
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    const completedMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('u1-summary'),
      userMsg('u2'),
      thinkingMsg('waiting'),
      backgroundNotificationMsg('bg1', 'call-agent-1'),
      backgroundNotificationMsg('bg2', 'call-agent-2'),
    ];

    rerenderMessages(c, completedMessages, { isResponding: true });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    act(() => vi.advanceTimersByTime(3_000));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, [...completedMessages, asstMsg('u2-summary')]);
    act(() => vi.advanceTimersByTime(1_500));
    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('defers automatic collapse of a latest-turn group while still responding', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent], undefined, {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    const completedMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('u1-answer'),
    ];

    rerenderMessages(c, completedMessages, { isResponding: true });
    act(() => vi.advanceTimersByTime(3_000));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, completedMessages, { isResponding: false });
    act(() => vi.advanceTimersByTime(1_500));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    act(() => vi.advanceTimersByTime(180));
    expect(parallelAgentsSummary(c)).toBeNull();
  });

  it('defers only the group that owns the awaited agent notification', () => {
    vi.useFakeTimers();
    const agentA1 = describedAgentMsg('agent-a1', 'group A task');
    const agentA2 = describedAgentMsg('agent-a2', 'group A task');
    const agentB1 = describedAgentMsg('agent-b1', 'group B task');
    const agentB2 = describedAgentMsg('agent-b2', 'group B task');
    agentA1.tools[0]!.status = 'pending';
    agentA2.tools[0]!.status = 'pending';
    agentB1.tools[0]!.status = 'pending';
    agentB2.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      agentA1,
      agentA2,
      asstMsg('narration'),
      agentB1,
      agentB2,
    ]);

    const summaries = () =>
      Array.from(c.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Parallel agents'),
      );
    expect(summaries()).toHaveLength(2);
    expect(
      summaries().every((b) => b.getAttribute('aria-expanded') === 'true'),
    ).toBe(true);

    rerenderMessages(c, [
      userMsg('u1'),
      describedAgentMsg('agent-a1', 'group A task'),
      describedAgentMsg('agent-a2', 'group A task'),
      asstMsg('narration'),
      describedAgentMsg('agent-b1', 'group B task'),
      describedAgentMsg('agent-b2', 'group B task'),
      backgroundNotificationMsg('bg-a1', 'call-agent-a1'),
      backgroundNotificationMsg('bg-a2', 'call-agent-a2'),
    ]);

    // Past group B's 1500ms collapse plus its 180ms exit; group A stays
    // deferred while the turn awaits its summary.
    act(() => vi.advanceTimersByTime(1_680));
    expect(c.textContent).toContain('group A task');
    expect(c.textContent).not.toContain('group B task');
    expect(summaries().map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('keeps deferring a latest-turn agent group when a monitor notification arrives mid-response', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent], undefined, {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    const completedMessages = [
      userMsg('u1'),
      agentMsg('agent-1'),
      agentMsg('agent-2'),
      asstMsg('u1-answer'),
      monitorNotificationMsg('monitor'),
    ];

    rerenderMessages(c, completedMessages, { isResponding: true });
    // A non-agent notification must not strip the latest-turn deferral while
    // the response is still streaming.
    act(() => vi.advanceTimersByTime(3_000));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, completedMessages, { isResponding: false });
    act(() => vi.advanceTimersByTime(1_500));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    act(() => vi.advanceTimersByTime(180));
    // The turn itself stays open for the monitor notification's reply.
    expect(c.querySelector('[data-agent-collapse-exit="true"]')).toBeNull();
    expect(parallelAgentsSummary(c)?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('defers every latest-turn group while the response awaits the agent summary', () => {
    vi.useFakeTimers();
    const agentA1 = describedAgentMsg('agent-a1', 'group A task');
    const agentA2 = describedAgentMsg('agent-a2', 'group A task');
    const agentB1 = describedAgentMsg('agent-b1', 'group B task');
    const agentB2 = describedAgentMsg('agent-b2', 'group B task');
    agentA1.tools[0]!.status = 'pending';
    agentA2.tools[0]!.status = 'pending';
    agentB1.tools[0]!.status = 'pending';
    agentB2.tools[0]!.status = 'pending';
    const c = mount(
      [userMsg('u1'), agentA1, agentA2, asstMsg('narration'), agentB1, agentB2],
      undefined,
      { isResponding: true },
    );
    const summaries = () =>
      Array.from(c.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Parallel agents'),
      );
    expect(summaries()).toHaveLength(2);

    const completedMessages = [
      userMsg('u1'),
      describedAgentMsg('agent-a1', 'group A task'),
      describedAgentMsg('agent-a2', 'group A task'),
      asstMsg('narration'),
      describedAgentMsg('agent-b1', 'group B task'),
      describedAgentMsg('agent-b2', 'group B task'),
      backgroundNotificationMsg('bg-a1', 'call-agent-a1'),
      backgroundNotificationMsg('bg-a2', 'call-agent-a2'),
    ];
    rerenderMessages(c, completedMessages, { isResponding: true });

    // Past group B's 1500ms window: the non-owning group stays deferred too
    // while the latest background item is the awaited agent notification.
    act(() => vi.advanceTimersByTime(1_680));
    expect(c.textContent).toContain('group A task');
    expect(c.textContent).toContain('group B task');
    expect(summaries().map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'true',
      'true',
    ]);

    // Once the response ends, only the owner group stays deferred. The
    // collapsed group keeps its launch position while the pinned owner group
    // renders at the turn's tail.
    rerenderMessages(c, completedMessages);
    act(() => vi.advanceTimersByTime(1_680));
    expect(c.textContent).toContain('group A task');
    expect(c.textContent).not.toContain('group B task');
    expect(summaries().map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
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

  it('does not add tool summary usage when full transcript usage includes it', () => {
    const agent = agentMsg('nested');
    agent.tools[0]!.rawOutput = {
      executionSummary: { inputTokens: 100, outputTokens: 20 },
    };
    const c = mount(
      [
        userMsg('u1'),
        agent,
        {
          ...asstMsg('a1'),
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      ],
      undefined,
      { includeSubagentToolUsageInMetrics: false },
    );

    expect(c.textContent).toContain('↑100 ↓20');
    expect(c.textContent).not.toContain('↑200 ↓40');
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

  it('folds streaming thinking into the tool summary while it runs', () => {
    const c = mount(
      [
        userMsg('u1'),
        { ...thinkingMsg('t1'), isStreaming: true },
        toolMsg('g1'),
      ],
      undefined,
      { isResponding: true, compactMode: true },
    );
    // Streaming thinking merges into the group like a running tool.
    expect(
      c
        .querySelector('[data-testid="msg-summary-t1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-g1');
    expect(c.querySelector('[data-testid="msg-g1"]')).toBeNull();
  });

  it('folds completed thinking into the merged tool summary in compact mode', () => {
    const c = mount(
      [userMsg('u1'), thinkingMsg('t1'), toolMsg('g1'), asstMsg('a1')],
      undefined,
      { isResponding: true, compactMode: true },
    );
    // The thinking and the adjacent tool collapse into one group carrying
    // the tool; the standalone thinking row is gone.
    expect(
      c
        .querySelector('[data-testid="msg-summary-t1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-g1');
    expect(c.querySelector('[data-testid="msg-g1"]')).toBeNull();
  });

  it('does not fold completed thinking without adjacent tools', () => {
    const c = mount(
      [userMsg('u1'), thinkingMsg('t1'), asstMsg('a1')],
      undefined,
      { isResponding: true, compactMode: true },
    );
    // No adjacent tool group: the thinking stays a standalone row.
    expect(c.querySelector('[data-testid="msg-t1"]')).not.toBeNull();
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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    const parallelAgents = parallelAgentsSummary(c);
    expect(parallelAgents?.closest(`.${flashStyles.flash}`)).not.toBeNull();
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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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

  it('loads earlier history after a fast wheel reaches the top', async () => {
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
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    await nextFrame();
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 200,
    });

    await act(async () => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
      list.scrollTop = 0;
      await Promise.resolve();
    });
    await nextFrame();

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
    await nextFrame();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(scrollTop).toBe(640);
  });

  it('drops a pending history anchor when the transcript changes', async () => {
    resizeObserversFireOnObserve = false;
    const rectSpy = mockMessageListWidth(1000);
    let scrollHeight = 1200;
    let scrollTop = 40;
    const resolveLoads: Array<() => void> = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoads.push(resolve);
        }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });
    const render = (messages: Message[]) =>
      root.render(
        <I18nProvider language="en">
          <MessageList
            messages={messages}
            pendingApproval={null}
            hasOlderHistory
            onLoadOlderHistory={onLoadOlderHistory}
          />
        </I18nProvider>,
      );

    act(() => render([userMsg('old')]));
    const list = container.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(list, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      list.dispatchEvent(new Event('scroll'));
    });
    await Promise.resolve();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    scrollHeight = 1300;
    act(() => render([userMsg('old'), asstMsg('streaming')]));
    await nextFrame();
    expect(scrollTop).toBe(40);

    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    });
    await nextFrame();

    scrollHeight = 1800;
    act(() => render([userMsg('new')]));
    await nextFrame();

    expect(scrollTop).toBe(40);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      list.dispatchEvent(new Event('scroll'));
    });
    await Promise.resolve();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);

    await act(async () => resolveLoads[0]?.());
    await nextFrame();
    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      list.dispatchEvent(new Event('scroll'));
    });
    await Promise.resolve();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);

    await act(async () => resolveLoads[1]?.());
    await nextFrame();
    rectSpy.mockRestore();
  });

  it('releases pagination when a virtual anchor never mounts', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const messages = simpleTurns(110);
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });
    const render = (nextMessages: Message[]) =>
      root.render(
        <I18nProvider language="en">
          <MessageList
            messages={nextMessages}
            pendingApproval={null}
            hasOlderHistory
            onLoadOlderHistory={onLoadOlderHistory}
          />
        </I18nProvider>,
      );

    virtualizerTestState.renderItems = false;
    act(() => render(messages));
    const list = container.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    for (let frame = 0; frame < 32; frame++) await nextFrame();
    expect(onLoadOlderHistory).not.toHaveBeenCalled();

    virtualizerTestState.renderItems = true;
    act(() => render([...messages]));
    await nextFrame();
    expect(
      container.querySelectorAll('[data-message-row-key]').length,
    ).toBeGreaterThan(0);
    list.scrollTop = 0;
    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      list.dispatchEvent(new Event('scroll'));
    });
    await nextFrame();
    await nextFrame();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it('measures newly prepended virtual rows before they can overlap the anchor', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const currentMessages = simpleTurns(110);
    const earlierMessages = simpleTurns(3).map((message) => ({
      ...message,
      id: `earlier-${message.id}`,
    }));
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });
    const render = (messages: Message[]) =>
      root.render(
        <I18nProvider language="en">
          <MessageList
            messages={messages}
            pendingApproval={null}
            hasOlderHistory
            onLoadOlderHistory={onLoadOlderHistory}
          />
        </I18nProvider>,
      );

    act(() => render(currentMessages));
    const list = container.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    await nextFrame();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    virtualizerTestState.resizeItem.mockClear();
    act(() => render([...earlierMessages, ...currentMessages]));

    expect(virtualizerTestState.resizeItem).toHaveBeenCalled();
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

  it('does not auto-load again when an underfill page adds no content', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });
    const render = (loadingOlderHistory: boolean) => {
      root.render(
        <I18nProvider language="en">
          <MessageList
            messages={[userMsg('u1')]}
            pendingApproval={null}
            hasOlderHistory
            loadingOlderHistory={loadingOlderHistory}
            onLoadOlderHistory={onLoadOlderHistory}
          />
        </I18nProvider>,
      );
    };

    await act(async () => {
      render(false);
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    await nextFrame();

    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    await act(async () => {
      render(false);
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    const list = container.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });
    await act(async () => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      await Promise.resolve();
    });
    await nextFrame();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it('waits for another upward scroll intent before retrying a failed underfill load', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);

    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      await Promise.resolve();
    });
    await nextFrame();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
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

  it('suppresses the loading status during automatic pagination', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );

    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
  });

  it('shows when the history display limit is reached', () => {
    const c = mount([userMsg('u1')], undefined, {
      historyCapacityReached: true,
    });

    expect(c.querySelector('[role="status"]')?.textContent).toBe(
      'History display limit reached. Earlier messages remain saved.',
    );
  });

  it('shows a persistent error when history pagination fails', () => {
    const c = mount([userMsg('u1')], undefined, {
      historyPaginationError: true,
    });
    expect(c.querySelector('[role="status"]')?.textContent).toBe(
      'Earlier history could not be loaded.',
    );
  });

  it('does not auto-load older history when a pagination error is present', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    // historyPaginationError is true, hasOlderHistory is true
    const c = mount([userMsg('u1')], undefined, {
      hasOlderHistory: true,
      historyPaginationError: true,
      onLoadOlderHistory,
    });

    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });

    // It should NOT call loadMore because paginationError blocks it
    expect(onLoadOlderHistory).not.toHaveBeenCalled();
  });

  it('retries loading older history with force when the retry button is clicked', async () => {
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const c = mount([userMsg('u1')], undefined, {
      historyPaginationError: true,
      onLoadOlderHistory,
    });

    const button = Array.from(c.querySelectorAll('button')).find(
      (el) => el.textContent === 'Retry',
    );
    expect(button).toBeDefined();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(onLoadOlderHistory).toHaveBeenCalledWith({ force: true });
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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

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
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

    renderInto(root, messages, undefined, { catchingUp: true });
    expect(scrollTop).toBe(0);

    renderInto(root, messages, undefined, { catchingUp: false });

    expect(scrollTop).toBe(1200);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('finishes cooldown following unless the user scrolls up', () => {
    resizeObserversFireOnObserve = false;
    let scrollHeight = 1200;
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
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    const messages = [userMsg('u1'), thinkingMsg('t1')];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref = createRef<MessageListHandle>();
    mounted.push({ root, container, transcriptRenderMode: 'interactive' });

    renderInto(root, messages, ref, {
      catchingUp: true,
      isResponding: true,
    });
    renderInto(root, messages, ref, {
      catchingUp: false,
      isResponding: true,
    });
    expect(scrollTop).toBe(600);

    scrollHeight = 1800;
    renderInto(
      root,
      [userMsg('u1'), { ...thinkingMsg('t1'), content: 'thinking more' }],
      ref,
      {
        catchingUp: false,
        isResponding: true,
      },
    );
    expect(scrollTop).toBe(600);

    act(() => {
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach((callback) => callback(0));
    });
    expect(scrollTop).toBe(1200);

    frames.clear();
    act(() => ref.current?.scrollToBottom('auto'));
    scrollHeight = 2400;
    renderInto(
      root,
      [userMsg('u1'), { ...thinkingMsg('t1'), content: 'thinking even more' }],
      ref,
      {
        catchingUp: false,
        isResponding: true,
      },
    );
    const list = container.querySelector('[data-web-shell-message-list]');
    act(() => {
      list?.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
      );
      scrollTop = 900;
      list?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    act(() => {
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach((callback) => callback(0));
    });
    expect(scrollTop).toBe(900);
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

    expect(has(c, 'mid')).toBe(false);
    expect(assistantActions(c, 'a1')).toBe('true');
  });

  it('shows branch only for anchored replies and forwards the checkpoint', () => {
    const onBranchSession = vi.fn();
    const anchored = {
      ...asstMsg('anchored'),
      branchRecordId: 'checkpoint-1',
    };
    const c = mount(
      [userMsg('u1'), anchored, userMsg('u2'), asstMsg('unanchored')],
      undefined,
      { onBranchSession },
    );

    expect(c.querySelector('[data-testid="branch-unanchored"]')).toBeNull();
    click(c.querySelector('[data-testid="branch-anchored"]')!);
    expect(onBranchSession).toHaveBeenCalledWith('checkpoint-1');
  });

  it('hides branch actions while a later turn is responding', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onBranchSession = vi.fn();
    const anchored = {
      ...asstMsg('anchored'),
      branchRecordId: 'checkpoint-1',
    };
    const messages = [userMsg('u1'), anchored, userMsg('u2'), asstMsg('live')];

    renderInto(root, messages, undefined, {
      isResponding: false,
      onBranchSession,
    });
    expect(
      container.querySelector('[data-testid="branch-anchored"]'),
    ).not.toBeNull();

    renderInto(root, messages, undefined, {
      isResponding: true,
      onBranchSession,
    });

    expect(
      container.querySelector('[data-testid="branch-anchored"]'),
    ).toBeNull();
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

  it('pauses bottom follow for a small upward wheel during scroll cooldown', async () => {
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
    const container = mount([asstMsg('a1')], undefined, {
      isResponding: true,
      onCanScrollToBottomChange,
    });
    const list = container.firstElementChild as HTMLElement;

    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -8 }));
      list.scrollTop = 592;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await nextFrame();

    expect(onCanScrollToBottomChange).toHaveBeenLastCalledWith(true);
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

    expect(scrollTop).toBe(600);
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
