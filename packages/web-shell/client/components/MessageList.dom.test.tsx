// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createRef,
  startTransition,
  Suspense,
  type RefObject,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, PermissionRequest } from '../adapters/types';
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
  getItemKeys: [] as Array<(index: number) => string | number>,
  itemSizeCache: new Map<string | number, number>(),
  resizeItem: vi.fn(),
  renderItems: true,
}));
const messageItemTestState = vi.hoisted(() => ({
  toolArrays: [] as unknown[][],
}));

// Mock the shared context and the heavy row children so this test exercises only
// MessageList's own collapse + deferred-scroll logic, not the whole render tree.
vi.mock('../WebShellContexts', async () => {
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
      if (message.role === 'tool_group') {
        messageItemTestState.toolArrays.push(message.tools);
      }
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
          'data-message-content':
            'content' in message ? message.content : undefined,
          'data-tool-ids':
            message.role === 'tool_group'
              ? message.tools.map((tool) => tool.callId).join(',')
              : undefined,
          'data-thought-content':
            message.role === 'tool_group'
              ? message.thoughts?.map((thought) => thought.content).join('|')
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
    virtualizerTestState.getItemKeys.push(getItemKey);
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
const { CompactModeContext } = await import('../WebShellContexts');
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
  virtualizerTestState.getItemKeys.length = 0;
  messageItemTestState.toolArrays.length = 0;
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
const recapMsg = (id: string): SystemMessage => ({
  id,
  role: 'system',
  content: 'Recap: earlier work',
  variant: 'info',
  source: 'recap',
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
    sessionKey?: string;
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
    pendingApproval?: PermissionRequest | null;
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
                pendingApproval={opts.pendingApproval ?? null}
                hideSessionTimeline={opts.hideSessionTimeline}
                loadingTranscript={opts.loadingTranscript}
                catchingUp={opts.catchingUp}
                hasOlderHistory={opts.hasOlderHistory}
                loadingOlderHistory={opts.loadingOlderHistory}
                historyCapacityReached={opts.historyCapacityReached}
                historyPaginationError={opts.historyPaginationError}
                onLoadOlderHistory={opts.onLoadOlderHistory}
                sessionKey={opts.sessionKey}
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
    hasOlderHistory?: boolean;
    onLoadOlderHistory?: (options?: { force?: boolean }) => Promise<void>;
    sessionKey?: string;
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
                hasOlderHistory={opts.hasOlderHistory}
                onLoadOlderHistory={opts.onLoadOlderHistory}
                sessionKey={opts.sessionKey}
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
  it('keeps MCP Apps standalone', async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    try {
      const mixed: ToolGroupMessage = {
        id: 'mixed',
        role: 'tool_group',
        tools: [
          { callId: 'read', toolName: 'Read', status: 'completed' },
          { callId: 'edit', toolName: 'Edit', status: 'completed' },
          {
            callId: 'app',
            toolName: 'mcp__demo__dashboard',
            status: 'completed',
            rawOutput: {
              type: 'mcp_app',
              serverName: 'demo',
              resourceUri: 'ui://demo/dashboard',
              html: '<main>Dashboard</main>',
              toolResult: { content: [] },
              toolArguments: {},
              fallbackText: 'Dashboard ready',
            },
          },
          { callId: 'shell', toolName: 'Shell', status: 'completed' },
          { callId: 'glob', toolName: 'Glob', status: 'completed' },
        ],
      };
      const ref = createRef<MessageListHandle>();
      const container = mount([mixed], ref, {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      });

      expect(
        Array.from(container.querySelectorAll('[data-tool-ids]')).map((row) =>
          row.getAttribute('data-tool-ids'),
        ),
      ).toEqual(['read,edit', 'app', 'shell,glob']);

      let found = false;
      act(() => {
        found = ref.current!.scrollToMessage('mixed', 'app');
      });
      await nextFrame();
      expect(found).toBe(true);
      const appRow = container.querySelector('[data-tool-ids="app"]');
      expect(
        container
          .querySelector('[data-tool-ids="read,edit"]')
          ?.getAttribute('data-locate-flashing'),
      ).toBeNull();
      expect(appRow?.getAttribute('data-locate-flashing')).toBe('true');
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(
        appRow?.closest('[data-index]'),
      );
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('updates a lone streaming thinking tail in place without nesting', () => {
    const user = userMsg('u1');
    const thinking = {
      ...thinkingMsg('t1'),
      content: 'first',
      isStreaming: true,
    };
    const container = mount([user, thinking], undefined, {
      compactMode: true,
      isResponding: true,
    });
    const row = container.querySelector('[data-testid="msg-t1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-message-content')).toBe('first');
    // A lone thought stays a standalone row — no summary nesting.
    expect(
      container.querySelector('[data-testid="msg-summary-t1"]'),
    ).toBeNull();

    rerenderMessages(
      container,
      [user, { ...thinking, content: 'first second' }],
      { isResponding: true },
    );

    expect(container.querySelector('[data-testid="msg-t1"]')).toBe(row);
    expect(row?.getAttribute('data-message-content')).toBe('first second');
  });

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

  it('does not create a tool summary for consecutive thinking only', () => {
    const container = mount(
      [userMsg('u1'), thinkingMsg('t1'), thinkingMsg('t2'), asstMsg('a1')],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(container.querySelector('[data-testid="msg-t1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-t2"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="msg-summary-t1"]'),
    ).toBeNull();
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
    // The trailing lone tool has no thought or sibling to merge with, so it
    // stays a standalone row like a single tool in non-compact mode.
    expect(container.querySelector('[data-testid="msg-g3"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="msg-summary-g3"]'),
    ).toBeNull();
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

  it('keeps a parallel-agent-only run on its direct path', () => {
    const container = mount(
      [userMsg('u1'), agentMsg('agent-1'), agentMsg('agent-2')],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(parallelAgentsSummary(container)).not.toBeNull();
  });

  it('folds a single agent and adjacent thinking into one summary', () => {
    const container = mount(
      [userMsg('u1'), thinkingMsg('t1'), agentMsg('agent-1'), asstMsg('a1')],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(
      container
        .querySelector('[data-testid="msg-summary-t1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-agent-1');
    expect(container.querySelector('[data-testid="msg-t1"]')).toBeNull();
    expect(container.querySelector('[data-testid="msg-agent-1"]')).toBeNull();
  });

  it('keeps a folded single-agent summary separate from an approving agent', () => {
    const container = mount(
      [thinkingMsg('t1'), agentMsg('agent-1'), agentMsg('agent-2')],
      undefined,
      {
        compactMode: true,
        pendingApproval: {
          id: 'req-1',
          toolCallId: 'call-agent-2',
          content: [],
          options: [],
        },
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(
      container.querySelector('[data-testid="msg-summary-t1"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="msg-agent-2"]'),
    ).not.toBeNull();
    expect(parallelAgentsSummary(container)).toBeNull();
  });

  it('folds parallel agents and trailing thinking into one compact summary', () => {
    const container = mount(
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        agentMsg('agent-2'),
        thinkingMsg('t1'),
        asstMsg('a1'),
      ],
      undefined,
      {
        compactMode: true,
        customization: { collapseCompletedTurns: false },
      },
    );

    expect(parallelAgentsSummary(container)).toBeNull();
    expect(
      container
        .querySelector('[data-testid="msg-summary-agent-1"]')
        ?.getAttribute('data-tool-ids'),
    ).toBe('call-agent-1,call-agent-2');
    expect(container.querySelector('[data-testid="msg-t1"]')).toBeNull();
    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();
  });

  it('does not fold parallel agents with thinking outside compact mode', () => {
    const container = mount(
      [
        userMsg('u1'),
        agentMsg('agent-1'),
        agentMsg('agent-2'),
        thinkingMsg('t1'),
        asstMsg('a1'),
      ],
      undefined,
      { customization: { collapseCompletedTurns: false } },
    );

    expect(parallelAgentsSummary(container)).not.toBeNull();
    expect(container.querySelector('[data-testid="msg-t1"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="msg-summary-agent-1"]'),
    ).toBeNull();
  });

  it.each(['TodoWrite', 'AskUserQuestion'])(
    'folds %s groups into the summary across hidden thinking',
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
        container
          .querySelector('[data-testid="msg-summary-g1"]')
          ?.getAttribute('data-tool-ids'),
      ).toBe('call-g1,call-special');
      expect(container.querySelector('[data-testid="msg-special"]')).toBeNull();
    },
  );

  it.each([
    ['TodoWrite', standaloneToolMsg('special', 'TodoWrite')],
    ['AskUserQuestion', standaloneToolMsg('special', 'AskUserQuestion')],
    ['agent', agentMsg('special')],
  ])(
    'merges a leading %s group with later thinking and tools',
    (_name, special) => {
      const container = mount(
        [special, thinkingMsg('t1'), toolMsg('g2')],
        undefined,
        {
          compactMode: true,
          customization: { collapseCompletedTurns: false },
        },
      );

      expect(
        container
          .querySelector('[data-testid="msg-summary-special"]')
          ?.getAttribute('data-tool-ids'),
      ).toBe('call-special,call-g2');
      expect(container.querySelector('[data-testid="msg-special"]')).toBeNull();
      expect(container.querySelector('[data-testid="msg-g2"]')).toBeNull();
    },
  );
});

describe('MessageList — turn collapse (DOM)', () => {
  it('does not reload a responding transcript when pause is implicit', async () => {
    vi.useFakeTimers();
    const onReloadTranscript = vi.fn().mockResolvedValue(undefined);
    mount([userMsg('u1'), asstMsg('a1')], undefined, {
      transcriptBlockCount: WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 1,
      onReloadTranscript,
      isResponding: true,
    });

    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(onReloadTranscript).not.toHaveBeenCalled();
  });

  it('reloads an oversized transcript after 15 quiet seconds at the tail', async () => {
    vi.useFakeTimers();
    const onReloadTranscript = vi.fn().mockResolvedValue(undefined);
    let lastEventId = 10;
    let notifyActivity = () => undefined;
    const transcriptActivity = {
      getSnapshot: () => ({ lastEventId }),
      subscribe: (listener: () => void) => {
        notifyActivity = listener;
        return () => undefined;
      },
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({
      root,
      container,
      transcriptRenderMode: 'interactive',
      compactMode: false,
    });
    const render = (
      transcriptBlockCount: number,
      transcriptReloadPaused = false,
    ) => {
      root.render(
        <I18nProvider language="en">
          <MessageList
            messages={[userMsg('u1'), asstMsg('a1')]}
            pendingApproval={null}
            transcriptBlockCount={transcriptBlockCount}
            transcriptActivity={transcriptActivity}
            onReloadTranscript={onReloadTranscript}
            transcriptReloadPaused={transcriptReloadPaused}
          />
        </I18nProvider>,
      );
    };
    act(() => render(WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500);
      lastEventId++;
      notifyActivity();
      await vi.advanceTimersByTimeAsync(7_500);
    });
    expect(onReloadTranscript).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(7_500));

    expect(onReloadTranscript).toHaveBeenCalledOnce();

    act(() => render(WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 2));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onReloadTranscript).toHaveBeenCalledOnce();

    lastEventId++;
    notifyActivity();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onReloadTranscript).toHaveBeenCalledTimes(2);

    lastEventId++;
    notifyActivity();
    const clearTimeout = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation(() => undefined);
    act(() => render(WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 2, true));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onReloadTranscript).toHaveBeenCalledTimes(2);
    clearTimeout.mockRestore();

    let reloadSignal: AbortSignal | undefined;
    let resolveReload = () => undefined;
    onReloadTranscript.mockImplementationOnce((signal: AbortSignal) => {
      reloadSignal = signal;
      return new Promise<void>((resolve) => {
        resolveReload = resolve;
      });
    });
    act(() => render(WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 2));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(onReloadTranscript).toHaveBeenCalledTimes(3);
    expect(reloadSignal?.aborted).toBe(false);

    act(() => render(WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS + 2, true));
    expect(reloadSignal?.aborted).toBe(true);
    await act(async () => resolveReload());
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

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
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

  it('keeps a turn expanded when pagination completes its head after its tail was shown', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    // The daemon split turn B: only its tail (t1/a1) is loaded; turn C is
    // complete in the window, so the tail renders as pre-prompt passthrough.
    const c = mount(
      [
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    expect(has(c, 't1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // The next page brings turn B's head. The turn must stay expanded instead
    // of collapsing the steps the user is already reading.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
    // The unrelated complete turn still collapses as usual.
    expect(isCollapsed(c, 't2')).toBe(true);
  });

  it('still collapses a turn whose head arrives in one complete page', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const c = mount(
      [userMsg('u2'), thinkingMsg('t2'), asstMsg('a2')],
      undefined,
      { hasOlderHistory: true, onLoadOlderHistory },
    );
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
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    // A head that arrives together with its whole turn was never shown
    // before, so the default collapse behavior applies unchanged.
    expect(has(c, 'u1')).toBe(true);
    expect(isCollapsed(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('lets an explicit toggle re-collapse a pagination-expanded turn for good', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const c = mount(
      [
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { hasOlderHistory: true, onLoadOlderHistory },
    );
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
    const completed = [
      userMsg('u1'),
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    rerenderMessages(c, completed, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(has(c, 't1')).toBe(true);

    // The user collapses the turn: the toggle must stick across later
    // re-renders instead of the pagination keep-open re-asserting itself.
    click(toggle(c, 'u1'));
    expect(isCollapsed(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');

    rerenderMessages(c, completed, {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(isCollapsed(c, 't1')).toBe(true);
  });

  it('re-expands the anchored turn when its collapse hides the anchor row', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
        const rowKey = this.getAttribute('data-message-row-key');
        if (rowKey === 'msg:u1') return rect(800, 50, 50);
        if (rowKey === 'msg:t1') return rect(800, 50, 100);
        if (rowKey === 'msg:a1') return rect(800, 50, 150);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );
    const messages = [userMsg('u1'), thinkingMsg('t1'), asstMsg('a1')];
    // The turn is live (expanded) while a history page is requested; the
    // anchor captures the topmost visible message row (t1).
    const c = mount(messages, undefined, {
      isResponding: true,
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

    expect(has(c, 't1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    try {
      // The session ends while the page is still in flight: the turn
      // collapses and the anchored row disappears.
      rerenderMessages(c, messages, { isResponding: false });
      expect(has(c, 't1')).toBe(true);

      // The anchor restore re-expands the turn instead of dropping the
      // anchor, so the reader keeps their position and the content.
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      await nextFrame();
      expect(has(c, 't1')).toBe(true);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('drops the anchor instead of re-expanding when the user collapsed the anchored turn', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
        const rowKey = this.getAttribute('data-message-row-key');
        if (rowKey === 'msg:u1') return rect(800, 50, 50);
        if (rowKey === 'msg:t1') return rect(800, 50, 100);
        if (rowKey === 'msg:a1') return rect(800, 50, 150);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );
    const tail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const completed = [userMsg('u1'), ...tail];
    const c = mount(tail, undefined, {
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

    try {
      // Page 1 completes the split turn's head: the keep-open expands it.
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      rerenderMessages(c, completed, {
        hasOlderHistory: true,
        onLoadOlderHistory,
      });
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      await nextFrame();
      expect(has(c, 't1')).toBe(true);

      // Page 2 anchors on the now-visible t1 row while the fetch is in flight.
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);

      // The user collapses the turn before the page commits.
      click(toggle(c, 'u1'));
      expect(isCollapsed(c, 't1')).toBe(true);

      // The commit lands: the explicit collapse wins over the keep-open, so
      // the fallback must drop the anchor instead of re-expanding...
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      await nextFrame();
      expect(isCollapsed(c, 't1')).toBe(true);

      // ...and pagination is not stuck: a third load still fires.
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(3);

      // The superseded load's snapshot must not wedge later detection: page 3
      // lands mid-turn...
      rerenderMessages(c, [thinkingMsg('tC1'), asstMsg('aC1'), ...completed], {
        hasOlderHistory: true,
        onLoadOlderHistory,
      });
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      // ...page 4 then completes that turn's head while its tail is already
      // on screen, so it stays expanded.
      // Re-top the container: re-renders snap it to the bottom while
      // following; the scroll event must start near the top to trigger.
      list.scrollTop = 0;
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(4);
      rerenderMessages(
        c,
        [userMsg('uC'), thinkingMsg('tC1'), asstMsg('aC1'), ...completed],
        { hasOlderHistory: true, onLoadOlderHistory },
      );
      expect(has(c, 'tC1')).toBe(true);
      expect(toggleRow(c, 'uC').getAttribute('aria-expanded')).toBe('true');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('keeps split-turn detection alive when a superseded load fails', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
        const rowKey = this.getAttribute('data-message-row-key');
        if (rowKey === 'msg:u1') return rect(800, 50, 50);
        if (rowKey === 'msg:t1') return rect(800, 50, 100);
        if (rowKey === 'msg:a1') return rect(800, 50, 150);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let rejectLoad!: (error: Error) => void;
    const onLoadOlderHistory = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectLoad = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const tail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const completed = [userMsg('u1'), ...tail];
    const c = mount(tail, undefined, {
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

    try {
      // Page 1 completes the split turn's head; the keep-open expands it.
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      rerenderMessages(c, completed, {
        hasOlderHistory: true,
        onLoadOlderHistory,
      });
      expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');

      // Page 2 anchors on the visible t1 row; the user collapses the turn
      // before the fetch settles, superseding the load.
      list.scrollTop = 0;
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
      click(toggle(c, 'u1'));
      expect(isCollapsed(c, 't1')).toBe(true);

      // The superseded load fails: its snapshot must still be dropped.
      await act(async () => {
        rejectLoad(new Error('load failed'));
        await Promise.resolve();
      });

      // Page 3 lands mid-turn...
      rerenderMessages(c, [thinkingMsg('tC1'), asstMsg('aC1'), ...completed], {
        hasOlderHistory: true,
        onLoadOlderHistory,
      });
      // ...and page 4 completes turn uC, whose tail page 3 showed: it stays
      // expanded instead of collapsing mid-read behind the orphan snapshot.
      list.scrollTop = 0;
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(3);
      rerenderMessages(
        c,
        [userMsg('uC'), thinkingMsg('tC1'), asstMsg('aC1'), ...completed],
        { hasOlderHistory: true, onLoadOlderHistory },
      );
      expect(has(c, 'tC1')).toBe(true);
      expect(toggleRow(c, 'uC').getAttribute('aria-expanded')).toBe('true');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('resets pagination state on a direct session switch without empty messages', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
        const rowKey = this.getAttribute('data-message-row-key');
        if (rowKey === 'msg:u1') return rect(800, 50, 50);
        if (rowKey === 'msg:t1') return rect(800, 50, 100);
        if (rowKey === 'msg:a1') return rect(800, 50, 150);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const tail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(tail, undefined, {
      sessionKey: 'session-a',
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

    try {
      // Page 1 completes the split turn's head: a keep-open entry for u1.
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      rerenderMessages(c, [userMsg('u1'), ...tail], {
        sessionKey: 'session-a',
        hasOlderHistory: true,
        onLoadOlderHistory,
      });
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');

      // The user expands turn u2 explicitly: an override entry.
      click(toggle(c, 'u2'));
      expect(has(c, 't2')).toBe(true);

      // Load 2 flies with an anchor on the visible t1 row.
      list.scrollTop = 0;
      await act(async () => {
        list.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
      });
      expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);

      // Direct switch to session B, which reuses the same ids, with no empty
      // render in between and load 2 still pending: B's complete turns
      // collapse by default — neither A's keep-open entry, nor A's override,
      // nor A's orphaned anchor may force them open.
      rerenderMessages(
        c,
        [
          userMsg('u1'),
          thinkingMsg('t1'),
          asstMsg('a1'),
          userMsg('u2'),
          thinkingMsg('t2'),
          asstMsg('a2'),
        ],
        { sessionKey: 'session-b', hasOlderHistory: true, onLoadOlderHistory },
      );
      expect(isCollapsed(c, 't1')).toBe(true);
      expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
      expect(isCollapsed(c, 't2')).toBe(true);
      expect(toggleRow(c, 'u2').getAttribute('aria-expanded')).toBe('false');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('lets the next session paginate after switching away from an in-flight load', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const resolvers: Array<() => void> = [];
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const sessionATail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(sessionATail, undefined, {
      sessionKey: 'session-a',
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

    // Session A's load never settles: its snapshot is pending at switch time.
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Direct switch to session B with distinct ids and no empty intermediate.
    rerenderMessages(c, [userMsg('u5'), thinkingMsg('t5'), asstMsg('a5')], {
      sessionKey: 'session-b',
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(isCollapsed(c, 't5')).toBe(true);

    // B paginates: page 1 lands mid-turn u4...
    list.scrollTop = 0;
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[1]?.();
      await Promise.resolve();
    });
    rerenderMessages(
      c,
      [
        thinkingMsg('t4'),
        asstMsg('a4'),
        userMsg('u5'),
        thinkingMsg('t5'),
        asstMsg('a5'),
      ],
      { sessionKey: 'session-b', hasOlderHistory: true, onLoadOlderHistory },
    );

    // ...page 2 completes u4's head while its tail is on screen: the turn
    // must stay expanded, detected through B's own snapshot.
    list.scrollTop = 0;
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(3);
    await act(async () => {
      resolvers[2]?.();
      await Promise.resolve();
    });
    rerenderMessages(
      c,
      [
        userMsg('u4'),
        thinkingMsg('t4'),
        asstMsg('a4'),
        userMsg('u5'),
        thinkingMsg('t5'),
        asstMsg('a5'),
      ],
      { sessionKey: 'session-b', hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 't4')).toBe(true);
    expect(toggleRow(c, 'u4').getAttribute('aria-expanded')).toBe('true');
  });

  it('does not block the next session when the previous load fails after a switch', async () => {
    let scrollHeight = 1200;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const rejects: Array<(error: Error) => void> = [];
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejects.push(reject);
        }),
    );
    const c = mount(
      [
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { sessionKey: 'session-a', hasOlderHistory: true, onLoadOlderHistory },
    );
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
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Switch while A's load is still in flight.
    rerenderMessages(c, [userMsg('u5'), thinkingMsg('t5'), asstMsg('a5')], {
      sessionKey: 'session-b',
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    // A's load fails only after the switch: its stale failure must not
    // retry-block the new session's pagination.
    await act(async () => {
      rejects[0]?.(new Error('session A load failed'));
      await Promise.resolve();
    });

    // B's transcript is short: pagination is underfill-driven. A live update
    // re-renders, and the auto-load must fire.
    scrollHeight = 600;
    rerenderMessages(
      c,
      [userMsg('u5'), thinkingMsg('t5'), asstMsg('a5'), asstMsg('a5b')],
      { sessionKey: 'session-b', hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it('clears the retry block of a failed previous-session load on switch', async () => {
    let scrollHeight = 1200;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValue(undefined);
    const c = mount(
      [
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { sessionKey: 'session-a', hasOlderHistory: true, onLoadOlderHistory },
    );
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
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Switch to session B, whose transcript is short (underfill-driven
    // pagination): A's failed load must not block B's auto-load.
    scrollHeight = 600;
    rerenderMessages(c, [userMsg('u5'), thinkingMsg('t5'), asstMsg('a5')], {
      sessionKey: 'session-b',
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it('does not let a live message landing mid-fetch consume the split-turn detection', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );
    const tail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(tail, undefined, {
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
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // A live message appends while the page is in flight; it must not
    // consume the detection snapshot (the head has not changed yet).
    rerenderMessages(c, [...tail, asstMsg('live')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });

    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });

    // The page then commits the split turn's head; detection still fires and
    // keeps the turn expanded.
    rerenderMessages(c, [userMsg('u1'), ...tail, asstMsg('live')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the snapshot across a non-pagination head change mid-fetch', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );
    const tail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(tail, undefined, {
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
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // A non-pagination head change (transcript reload / session switch with
    // fresh ids) lands while the fetch is in flight; it must NOT consume the
    // snapshot, or the page commit below would silently skip detection.
    rerenderMessages(c, [userMsg('x1'), thinkingMsg('x2'), asstMsg('x3')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });

    // The real page then commits the split turn's head; detection still
    // fires because the snapshot survived.
    rerenderMessages(c, [userMsg('u1'), ...tail], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps split-turn detection alive when a recap message is pinned at the head', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const recap = recapMsg('local-recap-1');
    // A /recap issued after Ctrl+L pins a local recap message at index 0;
    // pagination prepends cannot move it. The daemon split turn u1: only its
    // tail (t1/a1) is loaded, plus a complete turn u2 after it.
    const c = mount(
      [
        recap,
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    expect(has(c, 't1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // The page completes the split turn's head, landing right after the
    // pinned recap; the recap stays at index 0.
    rerenderMessages(
      c,
      [
        recap,
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
  });

  it('clears the pagination snapshot and keep-open set on /clear so the next session is not mislabeled', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    // Session A tail; the block ids below are reused verbatim by session B,
    // mirroring the daemon's per-session ordinal id scheme.
    const sessionATail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(sessionATail, undefined, {
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
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });

    // The page completes the split turn's head first, so the keep-open set
    // holds an entry by the time the screen clears.
    rerenderMessages(c, [userMsg('u1'), ...sessionATail], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');

    // /clear must drop the snapshot and the keep-open entry alike, or the
    // entry leaks into the next session.
    rerenderMessages(c, [], { hasOlderHistory: true, onLoadOlderHistory });

    // Session B arrives with a complete, never-split turn that reuses the
    // same ids; it must collapse by default, not stay expanded off a stale
    // pre-clear snapshot.
    rerenderMessages(c, [userMsg('u1'), thinkingMsg('t1'), asstMsg('a1')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(has(c, 'u1')).toBe(true);
    expect(isCollapsed(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the pagination-completed turn expanded while the tail streams', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const streamingTail = (content: string): AssistantMessage => ({
      ...asstMsg('a2'),
      content,
      isStreaming: true,
    });
    const tail: Message[] = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      streamingTail('partial'),
    ];
    const c = mount(tail, undefined, {
      isResponding: true,
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
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // The page commits while the tail is still streaming. The head object is
    // reused verbatim by the later snapshots, mirroring how the daemon reuses
    // message identities and only replaces the streaming tail.
    const head = userMsg('u1');
    rerenderMessages(c, [head, ...tail], {
      isResponding: true,
      hasOlderHistory: true,
      onLoadOlderHistory,
    });

    // Streaming keeps updating the tail over the same messages; the keep-open
    // added by the detection must not be masked by the streaming-tail
    // fast-path cache serving the page-commit render's collapsed value.
    rerenderMessages(
      c,
      [head, ...tail.slice(0, -1), streamingTail('partial answer')],
      { isResponding: true, hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a split turn expanded in compact mode when the page extends its aggregated run', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    // Interrupted (assistant-less) turn: only its thinking/tool tail fragment
    // is loaded, aggregated into one summary row in compact mode, plus a
    // newer complete turn.
    const c = mount(
      [
        thinkingMsg('t1'),
        toolMsg('g1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { compactMode: true, hasOlderHistory: true, onLoadOlderHistory },
    );
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    // Sanity: aggregation is live — the fragment renders as one summary row.
    expect(has(c, 'summary-t1')).toBe(true);
    expect(has(c, 't1')).toBe(false);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // The page prepends the turn's head and extends the aggregated run
    // (summary-t1 re-keys to summary-t0); the turn the user is reading must
    // stay expanded.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        thinkingMsg('t0'),
        toolMsg('g0'),
        thinkingMsg('t1'),
        toolMsg('g1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'summary-t0')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
  });

  it('re-expands the anchored turn through a compact aggregate row key', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
        const rowKey = this.getAttribute('data-message-row-key');
        if (rowKey === 'msg:u1') return rect(800, 50, 50);
        if (rowKey === 'msg:summary-t1') return rect(800, 50, 100);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () => new Promise<void>((resolve) => (resolveLoad = resolve)),
    );
    const messages = [userMsg('u1'), thinkingMsg('t1'), toolMsg('g1')];
    // Compact mode aggregates the run into one row; the anchor captures it.
    const c = mount(messages, undefined, {
      compactMode: true,
      isResponding: true,
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

    expect(has(c, 'summary-t1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    try {
      // The response completes while the page is still in flight: the turn
      // collapses and the anchored aggregate row disappears.
      rerenderMessages(c, [...messages, asstMsg('a1')], {
        isResponding: false,
      });

      // The anchor restore resolves the aggregate row key and re-expands the
      // turn instead of dropping the anchor.
      expect(has(c, 'summary-t1')).toBe(true);
      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      await nextFrame();
      expect(has(c, 'summary-t1')).toBe(true);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('restores the scroll position when the page extends the anchored compact run', async () => {
    let scrollHeight = 1200;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
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
    // After the page lands, the prepended history pushes the anchored turn's
    // rows down while the scroll position has not followed yet.
    let shifted = false;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const rowKey = this.getAttribute('data-message-row-key');
        const shift = shifted ? 600 : 0;
        if (rowKey === 'msg:summary-t1') return rect(800, 50, 100);
        if (rowKey === 'msg:u1') return rect(800, 50, 100 + shift);
        if (rowKey === 'msg:summary-t0') return rect(800, 50, 150 + shift);
        if (this.hasAttribute('data-web-shell-message-list')) {
          return rect(800, 600, 100);
        }
        return rect(800, 50, 0);
      });
    let resolveLoad!: () => void;
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = () => {
            scrollHeight = 1800;
            resolve();
          };
        }),
    );
    // The daemon split turn u1 across pages: only its tail (t1/g1) is loaded,
    // aggregated into one summary row in compact mode, before a newer turn.
    const c = mount(
      [
        thinkingMsg('t1'),
        toolMsg('g1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { compactMode: true, hasOlderHistory: true, onLoadOlderHistory },
    );
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    expect(has(c, 'summary-t1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    try {
      // The page completes the split turn and extends its aggregated run: the
      // summary row re-keys from summary-t1 to summary-t0 while the anchor
      // still holds the captured key.
      shifted = true;
      rerenderMessages(
        c,
        [
          userMsg('u1'),
          thinkingMsg('t0'),
          toolMsg('g0'),
          thinkingMsg('t1'),
          toolMsg('g1'),
          userMsg('u2'),
          thinkingMsg('t2'),
          asstMsg('a2'),
        ],
        { hasOlderHistory: true, onLoadOlderHistory },
      );
      expect(has(c, 'summary-t0')).toBe(true);

      await act(async () => {
        resolveLoad();
        await Promise.resolve();
      });
      await nextFrame();
      // The keep-open re-expanded the turn, and the anchor restore followed
      // the re-keyed run to a visible row instead of dropping: the scroll
      // position moved with the prepended history.
      expect(has(c, 'summary-t0')).toBe(true);
      expect(list.scrollTop).toBe(600);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('resets the pagination snapshot when a history load fails', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('load failed'));
    const sessionATail = [
      thinkingMsg('t1'),
      asstMsg('a1'),
      userMsg('u2'),
      thinkingMsg('t2'),
      asstMsg('a2'),
    ];
    const c = mount(sessionATail, undefined, {
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
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Session B reuses the tail ids in a complete, never-split turn: it must
    // collapse by default, not stay expanded off the failed load's snapshot.
    rerenderMessages(c, [userMsg('u1'), thinkingMsg('t1'), asstMsg('a1')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(has(c, 'u1')).toBe(true);
    expect(isCollapsed(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');
  });

  it('consumes the pagination snapshot when the page completes no split turn', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const onLoadOlderHistory = vi.fn().mockResolvedValue(undefined);
    const c = mount(
      [userMsg('u2'), thinkingMsg('t2'), asstMsg('a2')],
      undefined,
      {
        hasOlderHistory: true,
        onLoadOlderHistory,
      },
    );
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
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // The page lands a whole turn at once: no split turn, so nothing is
    // marked keep-open and the snapshot is consumed.
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(isCollapsed(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('false');

    // A later head change must not be compared against the stale snapshot:
    // reused tail ids alone cannot force a turn open.
    rerenderMessages(c, [userMsg('u3'), thinkingMsg('t2'), asstMsg('a2')], {
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    expect(isCollapsed(c, 't2')).toBe(true);
    expect(toggleRow(c, 'u3').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a later page split turn expanded when its load raced the earlier page commit', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    const resolvers: Array<() => void> = [];
    const onLoadOlderHistory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    // Turns uC and u1 are both split across pages: only turn u1's tail
    // (t1/a1) is loaded, plus a complete newer turn.
    const c = mount(
      [
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      undefined,
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    const list = c.querySelector(
      '[data-web-shell-message-list]',
    ) as HTMLElement;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    expect(has(c, 't1')).toBe(true);

    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Load 1 resolves SDK-side before its page commits to the transcript, and
    // the anchor effect clears the in-flight flag while the render commit is
    // still throttled: a fast scroll-up starts load 2 against the same
    // pre-page-1 snapshot.
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
    });
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    });
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);

    // Page 1 completes turn u1 and lands mid-turn uC, consuming the pending
    // detection.
    rerenderMessages(
      c,
      [
        thinkingMsg('tC1'),
        asstMsg('aC1'),
        thinkingMsg('tC2'),
        asstMsg('aC2'),
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 't1')).toBe(true);
    expect(toggleRow(c, 'u1').getAttribute('aria-expanded')).toBe('true');
    expect(has(c, 'tC2')).toBe(true);

    // Page 2 completes turn uC. Its tail was already on screen, so it must
    // stay expanded even though its load's snapshot raced page 1's commit.
    await act(async () => {
      resolvers[1]?.();
      await Promise.resolve();
    });
    rerenderMessages(
      c,
      [
        userMsg('uC'),
        thinkingMsg('tC1'),
        asstMsg('aC1'),
        thinkingMsg('tC2'),
        asstMsg('aC2'),
        userMsg('u1'),
        thinkingMsg('t1'),
        asstMsg('a1'),
        userMsg('u2'),
        thinkingMsg('t2'),
        asstMsg('a2'),
      ],
      { hasOlderHistory: true, onLoadOlderHistory },
    );
    expect(has(c, 'tC2')).toBe(true);
    expect(toggleRow(c, 'uC').getAttribute('aria-expanded')).toBe('true');
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

  it('does not render final actions while AskUserQuestion is waiting', () => {
    const renderAssistantTurnFooter = vi.fn(() => (
      <span data-testid="assistant-turn-footer">footer</span>
    ));
    const c = mount(
      [
        userMsg('review-request'),
        asstMsg('critical-findings'),
        standaloneToolMsg('ask-user', 'AskUserQuestion'),
      ],
      undefined,
      { customization: { renderAssistantTurnFooter } },
    );

    expect(assistantActions(c, 'critical-findings')).toBe('false');
    expect(renderAssistantTurnFooter).not.toHaveBeenCalled();
    expect(c.querySelector('[data-testid="assistant-turn-footer"]')).toBeNull();
  });

  it('restores final actions and collapses the intermediate report after matched agent notifications', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const renderAssistantTurnFooter = vi.fn(() => (
      <span data-testid="assistant-turn-footer">footer</span>
    ));

    const c = mount(
      [
        userMsg('review-request'),
        asstMsg('critical-findings'),
        standaloneToolMsg('ask-user', 'AskUserQuestion'),
        userMsg('ask-user-answer'),
        firstAgent,
        secondAgent,
        asstMsg('report'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
        backgroundNotificationMsg('bg-2', 'call-agent-2'),
        thinkingMsg('late-thinking'),
        asstMsg('final-supplement'),
      ],
      undefined,
      { customization: { renderAssistantTurnFooter } },
    );

    expect(isCollapsed(c, 'report')).toBe(true);
    expect(assistantActions(c, 'final-supplement')).toBe('true');
    expect(renderAssistantTurnFooter.mock.calls.map(([info]) => info)).toEqual(
      expect.arrayContaining([
        {
          turnId: 'ask-user-answer',
          message: {
            id: 'final-supplement',
            content: 'answer',
            isStreaming: undefined,
            timestamp: undefined,
          },
        },
      ]),
    );
    expect(
      renderAssistantTurnFooter.mock.calls.every(
        ([info]) => info.message.id === 'final-supplement',
      ),
    ).toBe(true);
    expect(
      c.querySelectorAll('[data-testid="assistant-turn-footer"]'),
    ).toHaveLength(1);
  });

  it('releases the latest turn after matched delayed agent notifications', () => {
    vi.useFakeTimers();
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([userMsg('u1'), firstAgent, secondAgent, asstMsg('a1')]);

    expect(assistantActions(c, 'a1')).toBe('false');

    const staleFirstAgent = agentMsg('agent-1');
    const staleSecondAgent = agentMsg('agent-2');
    staleFirstAgent.tools[0]!.status = 'pending';
    staleSecondAgent.tools[0]!.status = 'pending';
    rerenderMessages(c, [
      userMsg('u1'),
      staleFirstAgent,
      staleSecondAgent,
      asstMsg('a1'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
    ]);

    expect(assistantActions(c, 'a1')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(assistantActions(c, 'a1')).toBe('true');
    expect(parallelAgentsSummary(c)?.textContent).toContain('2/2 done');
  });

  it('does not release an older turn for another agent completion', () => {
    const firstAgent = agentMsg('agent-1');
    const secondAgent = agentMsg('agent-2');
    firstAgent.tools[0]!.status = 'pending';
    secondAgent.tools[0]!.status = 'pending';
    const c = mount([
      userMsg('u1'),
      firstAgent,
      asstMsg('a1'),
      userMsg('u2'),
      secondAgent,
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
      asstMsg('a2'),
    ]);

    expect(assistantActions(c, 'a1')).toBe('false');
    expect(assistantActions(c, 'a2')).toBe('true');
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

  it('restores the custom footer during readonly transcript replay', () => {
    const staleAgent = agentMsg('agent-1');
    staleAgent.tools[0]!.status = 'pending';
    const renderAssistantTurnFooter = vi.fn(() => (
      <span data-testid="assistant-turn-footer">footer</span>
    ));
    const c = mount([userMsg('u1'), staleAgent, asstMsg('a1')], undefined, {
      transcriptRenderMode: 'readonly',
      customization: { renderAssistantTurnFooter },
    });

    expect(assistantActions(c, 'a1')).toBe('true');
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
      c.querySelectorAll('[data-testid="assistant-turn-footer"]'),
    ).toHaveLength(1);
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

  it('defers only the owner group while the response awaits the agent summary', () => {
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

    // Past group B's 1500ms window: only the group owning the awaited
    // notification stays deferred; group B, whose completion is already on
    // screen, collapses to its summary row even while the response streams.
    act(() => vi.advanceTimersByTime(1_680));
    expect(c.textContent).toContain('group A task');
    expect(c.textContent).not.toContain('group B task');
    expect(summaries().map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);

    // Once the response ends the outcome is unchanged: the collapsed group
    // keeps its launch position while the pinned owner group renders at the
    // turn's tail.
    rerenderMessages(c, completedMessages);
    act(() => vi.advanceTimersByTime(1_680));
    expect(c.textContent).toContain('group A task');
    expect(c.textContent).not.toContain('group B task');
    expect(summaries().map((b) => b.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('collapses a completed agent group despite a monitor notification mid-response', () => {
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
    // A non-agent notification does not defer the agent group: it collapses
    // as soon as the agents finish, even while the response is streaming.
    act(() => vi.advanceTimersByTime(1_680));
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    rerenderMessages(c, completedMessages, { isResponding: false });
    act(() => vi.advanceTimersByTime(1_500));
    // No exit sequence re-runs for an already-collapsed group, and the turn
    // stays open for the monitor notification's reply, so the summary row
    // remains in place.
    expect(c.querySelector('[data-agent-collapse-exit="true"]')).toBeNull();
    expect(parallelAgentsSummary(c)?.hasAttribute('aria-disabled')).toBe(false);
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

  it.each([false, true])(
    'renders the latest content through the streamed-tail fast path (compact: %s)',
    (compactMode) => {
      const assistant = {
        ...asstMsg('a1'),
        content: 'first chunk',
        isStreaming: true,
        timestamp: 1_001,
      };
      const messages = [userMsg('u1'), assistant];
      const container = mount(messages, undefined, {
        isResponding: true,
        compactMode,
      });
      const getItemKey = virtualizerTestState.getItemKeys.at(-1);

      rerenderMessages(
        container,
        [
          messages[0],
          {
            ...assistant,
            content: 'first chunk plus delta',
            timestamp: 1_002,
          },
        ],
        { isResponding: true, compactMode },
      );

      expect(
        container
          .querySelector('[data-testid="msg-a1"]')
          ?.getAttribute('data-message-content'),
      ).toBe('first chunk plus delta');
      expect(virtualizerTestState.getItemKeys.at(-1)).toBe(getItemKey);
    },
  );

  it('falls back safely when streamed assistant content is undefined', () => {
    const assistant = {
      ...asstMsg('a1'),
      content: undefined as unknown as string,
      isStreaming: true,
    };
    const messages = [userMsg('u1'), assistant];
    const container = mount(messages, undefined, { isResponding: true });

    rerenderMessages(container, [messages[0], { ...assistant }], {
      isResponding: true,
    });

    expect(container.querySelector('[data-testid="msg-a1"]')).not.toBeNull();
  });

  it('does not reuse streamed-tail derivations when an earlier row changes', () => {
    const assistant = {
      ...asstMsg('a1'),
      content: 'first chunk',
      isStreaming: true,
    };
    const status = { ...systemMsg('s1'), timestamp: 1 };
    const messages = [userMsg('u1'), status, assistant];
    const container = mount(messages, undefined, { isResponding: true });

    const changedStatus = { ...status, timestamp: 2 };
    rerenderMessages(
      container,
      [
        messages[0],
        changedStatus,
        { ...assistant, content: 'first chunk plus delta' },
      ],
      { isResponding: true },
    );

    expect(
      container
        .querySelector('[data-testid="msg-s1"]')
        ?.getAttribute('data-timestamp'),
    ).toBe('2');
    expect(
      container
        .querySelector('[data-testid="msg-a1"]')
        ?.getAttribute('data-message-content'),
    ).toBe('first chunk plus delta');
  });

  it('does not reuse caches written by an abandoned concurrent render', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({
      root,
      container,
      transcriptRenderMode: 'interactive',
      compactMode: false,
    });
    const userA = { ...userMsg('u1'), content: 'committed' };
    const assistant = {
      ...asstMsg('a1'),
      content: 'first chunk',
      isStreaming: true,
    };
    const never = new Promise<void>(() => {});
    const Suspend = () => {
      throw never;
    };
    const render = (messages: Message[], suspend = false) =>
      root.render(
        <I18nProvider language="en">
          <Suspense fallback={null}>
            <MessageList
              messages={messages}
              pendingApproval={null}
              isResponding
            />
            {suspend ? <Suspend /> : null}
          </Suspense>
        </I18nProvider>,
      );

    act(() => render([userA, assistant]));
    const committedGetItemKey = virtualizerTestState.getItemKeys.at(-1);
    await act(async () => {
      startTransition(() =>
        render(
          [{ ...userA, id: 'u-abandoned', content: 'abandoned' }, assistant],
          true,
        ),
      );
      await Promise.resolve();
    });
    expect(committedGetItemKey?.(0)).toBe('msg:u1');
    act(() =>
      render([userA, { ...assistant, content: 'latest committed chunk' }]),
    );

    expect(
      container
        .querySelector('[data-testid="msg-u1"]')
        ?.getAttribute('data-message-content'),
    ).toBe('committed');
    expect(
      container
        .querySelector('[data-testid="msg-a1"]')
        ?.getAttribute('data-message-content'),
    ).toBe('latest committed chunk');
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
    await nextFrame();
    await nextFrame();
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

    for (let frame = 0; frame < 32; frame += 1) await nextFrame();
    await act(async () => {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      await Promise.resolve();
    });
    await nextFrame();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(3);
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

  it('does not scroll again for a content-only update in a virtual transcript', async () => {
    let scrollTop = 0;
    const getScrollHeight = vi.fn(() => 20_000);
    const setScrollTop = vi.fn((value: number) => {
      scrollTop = value;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: getScrollHeight,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: setScrollTop,
    });
    const messages = simpleTurns(101);
    messages[messages.length - 1] = {
      ...(messages[messages.length - 1] as AssistantMessage),
      isStreaming: true,
    };
    const container = mount(messages, undefined, { isResponding: true });
    await nextFrame();
    await nextFrame();
    getScrollHeight.mockClear();
    setScrollTop.mockClear();

    const updated = messages.slice();
    updated[updated.length - 1] = {
      ...(updated[updated.length - 1] as AssistantMessage),
      content: 'answer with one more streamed token',
    };
    rerenderMessages(container, updated, { isResponding: true });
    await nextFrame();

    expect(getScrollHeight).not.toHaveBeenCalled();
    expect(setScrollTop).not.toHaveBeenCalled();
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

  it('collapses an automatically expanded parallel-agents group as soon as its agents finish, even while the main agent keeps responding', () => {
    vi.useFakeTimers();
    const active1 = agentMsg('agent-1');
    active1.tools[0]!.status = 'in_progress';
    const active2 = agentMsg('agent-2');
    active2.tools[0]!.status = 'in_progress';
    const c = mount([userMsg('u1'), active1, active2], undefined, {
      isResponding: true,
    });

    // The group auto-expands while the agents are live.
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // Both agents finish while the main agent still streams its answer; the
    // group collapses without waiting for the whole turn to end.
    const done1 = agentMsg('agent-1');
    done1.tools[0]!.status = 'completed';
    const done2 = agentMsg('agent-2');
    done2.tools[0]!.status = 'completed';
    rerenderMessages(c, [userMsg('u1'), done1, done2, asstMsg('a1')], {
      isResponding: true,
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(has(c, 'a1')).toBe(true);

    // Once the turn ends, the completed turn folds the summary away.
    rerenderMessages(c, [userMsg('u1'), done1, done2, asstMsg('a1')], {
      isResponding: false,
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(parallelAgentsSummary(c)).toBeNull();
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'a1')).toBe(true);
  });

  it('returns a completed parallel-agents group to its chronological position while later tools run', () => {
    vi.useFakeTimers();
    const active1 = agentMsg('agent-1');
    active1.tools[0]!.status = 'in_progress';
    const active2 = agentMsg('agent-2');
    active2.tools[0]!.status = 'in_progress';
    const c = mount([userMsg('u1'), active1, active2], undefined, {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // Agents complete while the main agent continues with a new tool call.
    const done1 = agentMsg('agent-1');
    done1.tools[0]!.status = 'completed';
    const done2 = agentMsg('agent-2');
    done2.tools[0]!.status = 'completed';
    rerenderMessages(c, [userMsg('u1'), done1, done2, toolMsg('g1')], {
      isResponding: true,
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    // The group collapsed back to its summary row and returned above the
    // later tool (chronological order) instead of staying pinned at the
    // bottom of the turn.
    const summary = parallelAgentsSummary(c);
    expect(summary?.getAttribute('aria-expanded')).toBe('false');
    const laterTool = c.querySelector('[data-testid="msg-g1"]');
    expect(laterTool).toBeTruthy();
    expect(
      (summary as HTMLElement).compareDocumentPosition(
        laterTool as HTMLElement,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('auto-collapses a background-agent group once the summary narration lands', () => {
    vi.useFakeTimers();
    const active1 = agentMsg('agent-1');
    active1.tools[0]!.status = 'in_progress';
    const active2 = agentMsg('agent-2');
    active2.tools[0]!.status = 'in_progress';
    const c = mount([userMsg('u1'), active1, active2], undefined, {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // Both agents complete; completion notifications land and the model
    // narrates the summary afterwards.
    const done1 = agentMsg('agent-1');
    done1.tools[0]!.status = 'completed';
    const done2 = agentMsg('agent-2');
    done2.tools[0]!.status = 'completed';
    const settled = [
      userMsg('u1'),
      done1,
      done2,
      asstMsg('launched'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
      thinkingMsg('t1'),
      asstMsg('summary'),
    ];
    rerenderMessages(c, settled, { isResponding: true });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerenderMessages(c, settled, { isResponding: false });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(parallelAgentsSummary(c)).toBeNull();
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'summary')).toBe(true);
  });

  it('collapses a background-agent group once the awaited summary grace expires', () => {
    vi.useFakeTimers();
    const active1 = agentMsg('agent-1');
    active1.tools[0]!.status = 'in_progress';
    const active2 = agentMsg('agent-2');
    active2.tools[0]!.status = 'in_progress';
    const c = mount([userMsg('u1'), active1, active2], undefined, {
      isResponding: true,
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // The model already answered before the agents reconciled; their
    // completion notifications land afterwards with no follow-up narration.
    const done1 = agentMsg('agent-1');
    done1.tools[0]!.status = 'completed';
    const done2 = agentMsg('agent-2');
    done2.tools[0]!.status = 'completed';
    rerenderMessages(
      c,
      [
        userMsg('u1'),
        done1,
        done2,
        asstMsg('final'),
        backgroundNotificationMsg('bg-1', 'call-agent-1'),
        backgroundNotificationMsg('bg-2', 'call-agent-2'),
      ],
      { isResponding: false },
    );
    // The turn is awaiting the summary the model is expected to narrate, so
    // the group stays expanded through the bounded grace window…
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );

    // …but a summary that never arrives cannot pin it open forever: once the
    // grace expires the group collapses and the completed turn folds it back
    // into the turn summary (the trailing completion notification stays as
    // the turn's final content, mirroring the pre-notification answer fold).
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(parallelAgentsSummary(c)).toBeNull();
    expect(has(c, 'u1')).toBe(true);
    expect(has(c, 'bg-2')).toBe(true);
    expect(has(c, 'final')).toBe(false);
  });

  it('does not restart the awaited-summary grace for a monitor notification', () => {
    vi.useFakeTimers();
    const active1 = agentMsg('agent-1');
    active1.tools[0]!.status = 'in_progress';
    const active2 = agentMsg('agent-2');
    active2.tools[0]!.status = 'in_progress';
    const c = mount([userMsg('u1'), active1, active2], undefined, {
      isResponding: true,
    });
    const done1 = agentMsg('agent-1');
    done1.tools[0]!.status = 'completed';
    const done2 = agentMsg('agent-2');
    done2.tools[0]!.status = 'completed';
    const settled = [
      userMsg('u1'),
      done1,
      done2,
      asstMsg('final'),
      backgroundNotificationMsg('bg-1', 'call-agent-1'),
      backgroundNotificationMsg('bg-2', 'call-agent-2'),
    ];
    rerenderMessages(c, settled, { isResponding: false });

    // A monitor banner lands mid-wait. It is not the awaited agent summary,
    // so it must neither restart the 5s bound nor re-arm an expired one;
    // the group still collapses when the grace window closes.
    rerenderMessages(c, [...settled, monitorNotificationMsg('monitor')], {
      isResponding: false,
    });
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(parallelAgentsSummary(c)?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(parallelAgentsSummary(c)).toBeNull();
  });
});
