/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { CompletionItem } from '../types/completionItemTypes.js';

const {
  mockPostMessage,
  mockOpenCompletion,
  mockCloseCompletion,
  mockMessageState,
  mockMessages,
  mockInsightState,
  mockAddMessage,
  mockEndStreaming,
  mockWebShellTranscriptProps,
  mockWebShellLoadFailure,
  mockCompletionState,
  mockModelSelectorMounts,
  capturedWebViewHandlers,
  capturedSessionHandlers,
  capturedCompletionTriggerCalls,
} = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockOpenCompletion: vi.fn().mockResolvedValue(undefined),
  mockCloseCompletion: vi.fn(),
  mockMessageState: {
    isStreaming: false,
    isWaitingForResponse: false,
  },
  mockMessages: [] as Array<{
    role: string;
    content: string;
    timestamp: number;
    localOnly?: boolean;
  }>,
  mockInsightState: {
    progress: null as null | {
      stage: string;
      progress: number;
      detail?: string;
    },
    reportPath: null as null | string,
  },
  mockAddMessage: vi.fn(),
  mockEndStreaming: vi.fn(),
  mockWebShellTranscriptProps: {
    current: null as null | Record<string, unknown>,
  },
  mockWebShellLoadFailure: { current: false },
  // Completion menu visibility for the mocked useCompletionTrigger. Tests
  // that exercise composer key handling without the menu flip this to
  // false; the default true keeps the /skills picker suites working.
  mockCompletionState: {
    isOpen: true,
  },
  // Records every render in which InputForm receives showModelSelector=true,
  // so tests can detect even a transient selector mount (the open gate must
  // prevent mounting entirely, not merely get cleaned up after the fact).
  mockModelSelectorMounts: vi.fn(),
  // The mocked useWebViewMessages stores the real App setters here so tests
  // can deliver overlay arrivals (permission / question / account) directly.
  capturedWebViewHandlers: {
    handlePermissionRequest: null as null | ((value: unknown) => void),
    handleAskUserQuestion: null as null | ((value: unknown) => void),
    setAccountInfo: null as null | ((value: unknown) => void),
  },
  // The mocked useSessionManagement exposes its real setShowSessionSelector
  // setter here so tests can raise the SessionSelector overlay directly.
  capturedSessionHandlers: {
    setShowSessionSelector: null as null | ((value: boolean) => void),
  },
  // Every call the App makes to the mocked useCompletionTrigger, so tests
  // can assert the suppression argument is actually wired at the call site.
  capturedCompletionTriggerCalls: [] as unknown[][],
}));

const slashSkillsItem: CompletionItem = {
  id: 'skills',
  label: '/skills',
  type: 'command',
  value: 'skills',
};

const modelCommandItem: CompletionItem = {
  id: 'model',
  label: '/model',
  type: 'command',
  value: 'model',
};

const secondarySkillItem: CompletionItem = {
  id: 'skill:code-review',
  label: 'code-review',
  type: 'command',
  value: 'skills code-review',
};

const commitCommandItem: CompletionItem = {
  id: 'commit',
  label: '/commit',
  type: 'command',
  value: 'commit',
};

const clearCommandItem: CompletionItem = {
  id: 'clear',
  label: '/clear',
  type: 'command',
  value: 'clear',
};

vi.mock('./hooks/useVSCode.js', () => ({
  useVSCode: () => ({
    postMessage: mockPostMessage,
  }),
}));

vi.mock('./hooks/session/useSessionManagement.js', async () => {
  const React = await import('react');
  return {
    useSessionManagement: () => {
      const [showSessionSelector, setShowSessionSelector] =
        React.useState(false);
      capturedSessionHandlers.setShowSessionSelector = setShowSessionSelector;
      return {
        showSessionSelector,
        filteredSessions: [],
        currentSessionId: 'session-1',
        sessionSearchQuery: '',
        setSessionSearchQuery: vi.fn(),
        handleSwitchSession: vi.fn(),
        setShowSessionSelector,
        hasMore: false,
        isLoading: false,
        handleLoadMoreSessions: vi.fn(),
        handleLoadQwenSessions: vi.fn(),
        handleNewQwenSession: vi.fn(),
        currentSessionTitle: 'Session 1',
      };
    },
  };
});

vi.mock('./hooks/file/useFileContext.js', () => ({
  useFileContext: () => ({
    hasRequestedFiles: false,
    workspaceFiles: [],
    requestWorkspaceFiles: vi.fn(),
    addFileReference: vi.fn(),
    activeFileName: null,
    activeSelection: null,
    focusActiveEditor: vi.fn(),
  }),
}));

vi.mock('./hooks/message/useMessageHandling.js', () => ({
  useMessageHandling: () => ({
    messages: mockMessages,
    isStreaming: mockMessageState.isStreaming,
    isWaitingForResponse: mockMessageState.isWaitingForResponse,
    addMessage: mockAddMessage,
    endStreaming: mockEndStreaming,
    setWaitingForResponse: vi.fn(),
  }),
}));

vi.mock('./hooks/useToolCalls.js', () => ({
  useToolCalls: () => ({
    inProgressToolCalls: [],
    completedToolCalls: [],
    handleToolCallUpdate: vi.fn(),
    clearToolCalls: vi.fn(),
  }),
}));

vi.mock('./hooks/useWebViewMessages.js', async () => {
  const React = await import('react');
  return {
    useWebViewMessages: ({
      setIsAuthenticated,
      setAvailableCommands,
      setAvailableSkills,
      setInsightProgress,
      setInsightReportPath,
      handlePermissionRequest,
      handleAskUserQuestion,
      setAccountInfo,
    }: {
      setIsAuthenticated: (value: boolean) => void;
      setAvailableCommands: (
        value: Array<{
          name: string;
          description: string;
          input?: { hint: string } | null;
        }>,
      ) => void;
      setAvailableSkills: (value: string[]) => void;
      setInsightProgress?: (
        value: { stage: string; progress: number; detail?: string } | null,
      ) => void;
      setInsightReportPath?: (value: string | null) => void;
      handlePermissionRequest: (value: unknown) => void;
      handleAskUserQuestion: (value: unknown) => void;
      setAccountInfo: (value: unknown) => void;
    }) => {
      capturedWebViewHandlers.handlePermissionRequest = handlePermissionRequest;
      capturedWebViewHandlers.handleAskUserQuestion = handleAskUserQuestion;
      capturedWebViewHandlers.setAccountInfo = setAccountInfo;

      const initializedRef = React.useRef(false);

      React.useEffect(() => {
        if (initializedRef.current) {
          return;
        }
        initializedRef.current = true;
        setIsAuthenticated(true);
        if (mockInsightState.progress) {
          setInsightProgress?.(mockInsightState.progress);
        }
        if (mockInsightState.reportPath) {
          setInsightReportPath?.(mockInsightState.reportPath);
        }
        setAvailableCommands([
          {
            name: 'skills',
            description: 'List available skills',
            input: null,
          },
          {
            name: 'commit',
            description: 'Commit current changes',
            input: { hint: '' },
          },
          {
            name: 'clear',
            description: 'Clear the chat',
            input: null,
          },
        ]);
        setAvailableSkills(['code-review']);
      }, [
        setAvailableCommands,
        setAvailableSkills,
        setIsAuthenticated,
        setInsightProgress,
        setInsightReportPath,
      ]);
    },
  };
});

vi.mock('./hooks/useMessageSubmit.js', () => ({
  useMessageSubmit: () => ({
    handleSubmit: vi.fn(),
  }),
  shouldSendMessage: () => true,
}));

vi.mock('./hooks/useImage.js', () => ({
  useImagePaste: () => ({
    attachedImages: [],
    handleRemoveImage: vi.fn(),
    clearImages: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));

vi.mock('./hooks/useCompletionTrigger.js', async () => {
  const React = await import('react');
  return {
    // Record every call so tests can assert the App actually passes its
    // suppression argument (third positional parameter) — reverting the call
    // site leaves it undefined and fails that assertion. The returned object
    // is memoized on isOpen (as a memoized real hook would): a fresh object
    // every render would recreate handleCompletionSelect every render and
    // mask a missing overlay-gate dependency entry.
    useCompletionTrigger: (...args: unknown[]) => {
      capturedCompletionTriggerCalls.push(args);
      const isOpen = mockCompletionState.isOpen;
      return React.useMemo(
        () => ({
          isOpen,
          triggerChar: '/',
          query: 'skills ',
          items: [
            slashSkillsItem,
            modelCommandItem,
            secondarySkillItem,
            commitCommandItem,
            clearCommandItem,
          ],
          closeCompletion: mockCloseCompletion,
          openCompletion: mockOpenCompletion,
          refreshCompletion: vi.fn(),
        }),
        [isOpen],
      );
    },
  };
});

vi.mock('./utils/contextUsage.js', () => ({
  computeContextUsage: () => null,
}));

vi.mock('./utils/utils.js', () => ({
  hasToolCallOutput: () => false,
}));

vi.mock('./components/messages/toolcalls/ToolCall.js', () => ({
  ToolCall: () => null,
}));

vi.mock('./components/layout/Onboarding.js', () => ({
  Onboarding: () => null,
}));

vi.mock('./components/AccountInfoDialog.js', () => ({
  AccountInfoDialog: () => null,
}));

vi.mock('@qwen-code/webui', () => ({
  AssistantMessage: () => null,
  UserMessage: () => null,
  ThinkingMessage: () => null,
  WaitingMessage: () => null,
  InterruptedMessage: () => null,
  FileIcon: () => null,
  AskUserQuestionDialog: () => null,
  ImageMessageRenderer: () => null,
  ImagePreview: () => null,
  EmptyState: () => null,
  ChatHeader: () => null,
  SessionSelector: () => null,
  // Renders a marker so tests can assert the overlay's presence in the DOM
  // (e.g. that the model selector is already gone by the time the overlay
  // commits — see the overlay-takeover timing test).
  PermissionDrawer: () => <div data-testid="permission-drawer" />,
  InsightProgressCard: ({
    stage,
    progress,
  }: {
    stage: string;
    progress: number;
    detail?: string;
  }) => `${stage} ${Math.round(progress)}%`,
  ZERO_WIDTH_SPACE: '\u200B',
  CloseSmallIcon: () => null,
  stripZeroWidthSpaces: (text: string) => text.replace(/\u200B/g, ''),
}));

vi.mock('./components/layout/InputForm.js', () => ({
  InputForm: ({
    inputText,
    inputFieldRef,
    onCancel,
    onCompletionSelect,
    onCompletionFill,
    onKeyDown,
    showModelSelector,
    onModelSelectorClearance,
  }: {
    inputText: string;
    inputFieldRef: React.RefObject<HTMLDivElement>;
    onCancel: () => void;
    onCompletionSelect: (item: CompletionItem) => void;
    onCompletionFill?: (item: CompletionItem) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    showModelSelector?: boolean;
    onModelSelectorClearance?: (heightPx: number) => void;
  }) => {
    if (showModelSelector) {
      mockModelSelectorMounts();
    }
    return (
      <div>
        <div
          data-testid="input-field"
          ref={inputFieldRef}
          contentEditable
          suppressContentEditableWarning
          onKeyDown={onKeyDown}
        >
          {inputText}
        </div>
        <div data-testid="input-text">{inputText}</div>
        {showModelSelector && (
          <div className="model-selector" data-testid="model-selector" />
        )}
        <button onClick={onCancel}>cancel-input</button>
        <button onClick={() => onCompletionSelect(slashSkillsItem)}>
          select-skills-command
        </button>
        <button
          onClick={() => {
            onModelSelectorClearance?.(184);
            onCompletionSelect(modelCommandItem);
          }}
        >
          select-model-command
        </button>
        <button onClick={() => onCompletionSelect(secondarySkillItem)}>
          select-skill-enter
        </button>
        <button onClick={() => onCompletionFill?.(secondarySkillItem)}>
          select-skill-tab
        </button>
        <button onClick={() => onCompletionSelect(commitCommandItem)}>
          select-commit-enter
        </button>
        <button onClick={() => onCompletionSelect(clearCommandItem)}>
          select-clear-enter
        </button>
        <button onClick={() => onCompletionFill?.(clearCommandItem)}>
          select-clear-tab
        </button>
      </div>
    );
  },
}));

vi.mock('@qwen-code/web-shell', () => ({
  WebShellTranscript: (props: Record<string, unknown>) => {
    // Simulate the lazy chunk failing to load (e.g. a retained webview
    // fetching a content-hashed chunk that an extension auto-update
    // removed). Like a rejected dynamic import, the failure surfaces as a
    // render error escaping Suspense, which only an ErrorBoundary catches.
    if (mockWebShellLoadFailure.current) {
      throw new Error(
        'Failed to fetch dynamically imported module: chunks/web-shell.js',
      );
    }
    mockWebShellTranscriptProps.current = props;
    return null;
  },
}));

import { App } from './App.js';

function createDomRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function clickButton(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  act(() => {
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
      }),
    );
  });
}

function setInputSelection(container: HTMLDivElement, text: string) {
  const input = container.querySelector(
    '[data-testid="input-field"]',
  ) as HTMLDivElement | null;
  if (!input) {
    throw new Error('Input field not found');
  }

  act(() => {
    input.textContent = text;
    if (!input.firstChild) {
      input.appendChild(document.createTextNode(text));
    } else {
      input.firstChild.textContent = text;
    }

    const textNode = input.firstChild;
    if (!textNode) {
      throw new Error('Missing text node');
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, text.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function getRenderedInputText(container: HTMLDivElement): string {
  return (
    container.querySelector('[data-testid="input-text"]')?.textContent ?? ''
  );
}

function renderApp() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<App />);
  });

  return { container, root };
}

/** Reset via a call so tsc does not narrow the prop capture to `null`. */
function resetWebShellTranscriptProps(): void {
  mockWebShellTranscriptProps.current = null;
}

describe('App /skills secondary picker', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages.length = 0;
    mockInsightState.progress = null;
    mockInsightState.reportPath = null;
    mockMessageState.isStreaming = false;
    mockMessageState.isWaitingForResponse = false;
    mockWebShellLoadFailure.current = false;
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => createDomRect(),
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => createDomRect(),
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('opens the secondary picker after selecting /skills', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/');

    clickButton(rendered.container, 'select-skills-command');

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockOpenCompletion).toHaveBeenCalledWith(
      '/',
      'skills ',
      expect.any(Object),
    );
  });

  it('sends /skills <name> when pressing Enter on a skill item', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/skills ');

    clickButton(rendered.container, 'select-skill-enter');

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      data: { text: '/skills code-review' },
    });
    expect(mockCloseCompletion).toHaveBeenCalled();
  });

  it('fills /skills <name> without sending when pressing Tab on a skill item', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/skills ');

    clickButton(rendered.container, 'select-skill-tab');

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(getRenderedInputText(rendered.container)).toBe(
      '/skills code-review ',
    );
  });

  it('fills slash commands that declare input when pressing Enter', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/');

    clickButton(rendered.container, 'select-commit-enter');

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(getRenderedInputText(rendered.container)).toBe('/commit ');
    expect(mockCloseCompletion).toHaveBeenCalled();
  });

  it('auto-submits slash commands without input when pressing Enter', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/');

    clickButton(rendered.container, 'select-clear-enter');

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      data: { text: '/clear' },
    });
    expect(mockCloseCompletion).toHaveBeenCalled();
  });

  it('fills slash commands without input when pressing Tab', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/');

    clickButton(rendered.container, 'select-clear-tab');

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(getRenderedInputText(rendered.container)).toBe('/clear ');
  });

  it('blurs and preserves composer text on idle cancel without cancelling the session', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, 'draft after escape');

    const input = rendered.container.querySelector(
      '[data-testid="input-field"]',
    ) as HTMLDivElement;
    const blurSpy = vi.spyOn(input, 'blur');

    clickButton(rendered.container, 'cancel-input');

    expect(blurSpy).toHaveBeenCalled();
    expect(input.getAttribute('data-empty')).toBe('false');
    expect(getRenderedInputText(rendered.container)).toBe('draft after escape');
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: 'cancelStreaming',
      data: {},
    });
  });

  it('still cancels the session while streaming', async () => {
    mockMessageState.isStreaming = true;
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    clickButton(rendered.container, 'cancel-input');

    expect(mockEndStreaming).toHaveBeenCalled();
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'Interrupted',
        // The transcript only renders ACP frames; the local cancel mark
        // must carry the localOnly flag or it is never shown.
        localOnly: true,
      }),
    );
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'cancelStreaming',
      data: {},
    });
  });

  it('renders locally generated messages in a notice slot beside the transcript', async () => {
    mockMessages.push(
      { role: 'user', content: 'ordinary history', timestamp: 1 },
      {
        role: 'assistant',
        content: 'Failed to connect to Qwen agent: spawn failed',
        timestamp: 2,
        localOnly: true,
      },
      {
        role: 'assistant',
        content: 'Interrupted',
        timestamp: 3,
        localOnly: true,
      },
    );

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const notices = rendered.container.querySelectorAll(
      '[data-testid="local-message-notice"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.textContent).toContain(
      'Failed to connect to Qwen agent: spawn failed',
    );
    expect(notices[1]?.textContent).toBe('Interrupted');
    // Extension-provided history must not leak into the notice slot.
    expect(
      rendered.container.querySelector('[data-testid="local-message-notices"]')
        ?.textContent,
    ).not.toContain('ordinary history');
  });

  it('posts openFile when a file link inside the transcript area is clicked', async () => {
    mockMessages.push({
      role: 'assistant',
      content: 'see the report',
      timestamp: 1,
      localOnly: true,
    });

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const area = rendered.container.querySelector(
      '.flex-1.min-h-0.relative',
    ) as HTMLDivElement;
    expect(area).not.toBeNull();

    const link = document.createElement('a');
    link.setAttribute('href', '/tmp/insight-report.md');
    link.textContent = '/tmp/insight-report.md';
    area.appendChild(link);

    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openFile',
      data: { path: '/tmp/insight-report.md' },
    });
  });

  it('leaves external links alone when clicked in the transcript area', async () => {
    mockMessages.push({
      role: 'assistant',
      content: 'docs',
      timestamp: 1,
      localOnly: true,
    });

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const area = rendered.container.querySelector(
      '.flex-1.min-h-0.relative',
    ) as HTMLDivElement;
    const link = document.createElement('a');
    link.setAttribute('href', 'https://example.com/docs');
    link.textContent = 'docs';
    area.appendChild(link);

    // VS Code webviews never navigate on external links; cancel the jsdom
    // navigation without interfering with the handler under test.
    const preventNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', preventNavigation);
    try {
      act(() => {
        link.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
    } finally {
      document.removeEventListener('click', preventNavigation);
    }

    expect(mockPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openFile' }),
    );
  });

  it('exposes the chat-messages webviewSection context key when content exists', async () => {
    mockMessages.push({
      role: 'assistant',
      content: 'notice',
      timestamp: 1,
      localOnly: true,
    });

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const area = rendered.container.querySelector(
      '.flex-1.min-h-0.relative',
    ) as HTMLDivElement;
    // The contributed copy commands filter on
    // `when: "webviewSection == 'chat-messages'"`; without the attribute
    // the context-menu items never appear.
    expect(area.getAttribute('data-vscode-context')).toBe(
      '{"webviewSection": "chat-messages"}',
    );
  });

  it('reports contextMenuTriggered so copy commands route to this webview', async () => {
    mockMessages.push({
      role: 'assistant',
      content: 'notice',
      timestamp: 1,
      localOnly: true,
    });

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    mockPostMessage.mockClear();

    act(() => {
      document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'contextMenuTriggered',
      data: {},
    });
  });

  async function renderAppWithTranscriptText(text: string) {
    mockMessages.push({
      role: 'assistant',
      content: 'notice',
      timestamp: 1,
      localOnly: true,
    });

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    // Feed one assistant block through the real transcript reducer.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'transcriptUpdate',
            data: {
              sessionId: 'session-copy',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
              },
            },
          },
        }),
      );
    });

    return rendered;
  }

  it('copies the last assistant reply on copyLastReply', async () => {
    await renderAppWithTranscriptText('reply text');
    mockPostMessage.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'copyCommand', data: { action: 'copyLastReply' } },
        }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      data: { text: 'reply text' },
    });
  });

  it('copies labeled conversation text on copyAllMessages', async () => {
    const rendered = await renderAppWithTranscriptText('reply text');
    void rendered;

    // Also feed a user block so the labeled format is exercised.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'transcriptUpdate',
            data: {
              sessionId: 'session-copy',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'the question' },
              },
            },
          },
        }),
      );
    });
    mockPostMessage.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'copyCommand', data: { action: 'copyAllMessages' } },
        }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      data: {
        text: '**Qwen Code:** reply text\n\n---\n\n**User:** the question',
      },
    });
  });

  it('copies the block under the cursor on copyMessage', async () => {
    const rendered = await renderAppWithTranscriptText('reply text');

    const area = rendered.container.querySelector(
      '.flex-1.min-h-0.relative',
    ) as HTMLDivElement;
    // Simulate a MessageList row for the first assistant block
    // (reducer block ids are `assistant-<ordinal>`, ordinal starts at 1).
    const row = document.createElement('div');
    row.setAttribute('data-message-row-key', 'msg:assistant-1');
    row.textContent = 'reply text';
    area.appendChild(row);

    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    mockPostMessage.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'copyCommand', data: { action: 'copyMessage' } },
        }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      data: { text: 'reply text' },
    });
  });

  it('copies the tool block under a tool-group row key on copyMessage', async () => {
    const rendered = await renderAppWithTranscriptText('reply text');

    // Feed a tool block through the real transcript reducer. Block ids use
    // one shared ordinal across kinds, so the assistant block is
    // `assistant-1` and this tool block becomes `tool-2`.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'transcriptUpdate',
            data: {
              sessionId: 'session-copy',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-1',
                title: 'Read file',
                status: 'completed',
              },
            },
          },
        }),
      );
    });

    const area = rendered.container.querySelector(
      '.flex-1.min-h-0.relative',
    ) as HTMLDivElement;
    // MessageList keys tool-group rows as `msg:tg-<first block id>`.
    const row = document.createElement('div');
    row.setAttribute('data-message-row-key', 'msg:tg-tool-2');
    row.textContent = 'Read file';
    area.appendChild(row);

    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    mockPostMessage.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'copyCommand', data: { action: 'copyMessage' } },
        }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'copyToClipboard',
      data: { text: 'Read file' },
    });
  });

  it('renders /insight progress updates from the insightProgress setter', async () => {
    mockInsightState.progress = { stage: 'Analyzing', progress: 40 };

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const card = rendered.container.querySelector(
      '[data-testid="insight-progress"]',
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Analyzing');
    expect(card?.textContent).toContain('40%');
  });

  it('surfaces the generated insight report path and opens it on click', async () => {
    mockInsightState.reportPath = '/tmp/insight-report.md';

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const link = rendered.container.querySelector(
      '[data-testid="insight-report-link"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('/tmp/insight-report.md');

    mockPostMessage.mockClear();
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openInsightReport',
      data: { path: '/tmp/insight-report.md' },
    });
  });

  it('disables WebShell transcript turn auto-collapse while a response is in flight', async () => {
    mockMessageState.isStreaming = true;
    resetWebShellTranscriptProps();

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    // WebShellTranscript hardcodes isResponding={false}; without an
    // explicit opt-out, MessageList would auto-collapse the in-progress
    // turn mid-response.
    const transcriptProps = mockWebShellTranscriptProps.current;
    expect(transcriptProps).not.toBeNull();
    expect(transcriptProps!.collapseCompletedTurns).toBe(false);
  });

  it('reserves measured selector clearance on the WebShell transcript scroll area', async () => {
    mockMessageState.isStreaming = true;
    resetWebShellTranscriptProps();

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    expect(mockWebShellTranscriptProps.current).not.toBeNull();
    expect(mockWebShellTranscriptProps.current!.style).toMatchObject({
      '--web-shell-bottom-panel-inset': '0px',
    });

    setInputSelection(rendered.container, '/');
    clickButton(rendered.container, 'select-model-command');

    expect(mockWebShellTranscriptProps.current!.style).toMatchObject({
      '--web-shell-bottom-panel-inset': '192px',
    });
  });

  it('tracks live VS Code color-theme changes on the transcript theme prop', async () => {
    mockMessageState.isStreaming = true;
    resetWebShellTranscriptProps();
    document.body.setAttribute('data-vscode-theme-kind', 'vscode-dark');

    try {
      const rendered = renderApp();
      root = rendered.root;
      container = rendered.container;

      await act(async () => {});

      expect(mockWebShellTranscriptProps.current).not.toBeNull();
      expect(mockWebShellTranscriptProps.current!.theme).toBe('dark');

      // VS Code applies a color-theme change to an open webview in place by
      // updating the body attribute (no reload); the transcript theme must
      // follow instead of staying on the mount-time snapshot.
      await act(async () => {
        document.body.setAttribute('data-vscode-theme-kind', 'vscode-light');
        await Promise.resolve();
      });

      expect(mockWebShellTranscriptProps.current!.theme).toBe('light');
    } finally {
      document.body.removeAttribute('data-vscode-theme-kind');
    }
  });

  it('shows a recoverable error state instead of blanking the panel when the transcript chunk fails to load', async () => {
    mockMessageState.isStreaming = true;
    mockWebShellLoadFailure.current = true;
    // React logs errors that an error boundary catches; keep output clean.
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      const rendered = renderApp();
      root = rendered.root;
      container = rendered.container;

      await act(async () => {});

      const fallback = rendered.container.querySelector(
        '[data-testid="transcript-load-error"]',
      );
      expect(fallback).not.toBeNull();
      expect(fallback?.textContent).toContain('failed to load');
      expect(fallback?.textContent).toContain('Reload panel');

      // The boundary must be scoped to the transcript subtree: the rest of
      // the panel (here the composer) has to survive the chunk failure
      // instead of being unmounted with the whole root.
      expect(
        rendered.container.querySelector('[data-testid="input-field"]'),
      ).not.toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('feeds reduced transcript blocks from transcriptUpdate messages into the WebShell transcript', async () => {
    mockMessageState.isStreaming = true;
    resetWebShellTranscriptProps();

    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    expect(mockWebShellTranscriptProps.current).not.toBeNull();
    const blocksBefore = JSON.stringify(
      mockWebShellTranscriptProps.current!.blocks,
    );

    // The extension forwards every ACP session/update notification as a
    // `transcriptUpdate` webview message; useAcpTranscript reduces it and
    // App passes the resulting blocks to the renderer.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'transcriptUpdate',
            data: {
              sessionId: 'session-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'timeline-block-content' },
              },
            },
          },
        }),
      );
    });

    expect(mockWebShellTranscriptProps.current).not.toBeNull();
    const blocks = mockWebShellTranscriptProps.current!.blocks;
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(blocks)).toContain('timeline-block-content');
    // The prop must change because of the message, proving the reduced
    // blocks are actually wired through rather than a static prop.
    expect(JSON.stringify(blocks)).not.toBe(blocksBefore);
  });
});

describe('App model selector gating', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const permissionPayload = {
    options: [{ optionId: 'allow_once', name: 'Allow once' }],
    toolCall: { title: 'run: ls' },
  };
  const askQuestionPayload = {
    sessionId: 'session-1',
    questions: [
      {
        question: 'Which one?',
        header: 'Pick',
        options: [{ label: 'A', description: 'option a' }],
        multiSelect: false,
      },
    ],
  };
  const accountPayload = { authType: 'qwen-oauth' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages.length = 0;
    mockInsightState.progress = null;
    mockInsightState.reportPath = null;
    mockMessageState.isStreaming = false;
    mockMessageState.isWaitingForResponse = false;
    mockWebShellLoadFailure.current = false;
    mockCompletionState.isOpen = true;
    capturedWebViewHandlers.handlePermissionRequest = null;
    capturedWebViewHandlers.handleAskUserQuestion = null;
    capturedWebViewHandlers.setAccountInfo = null;
    capturedSessionHandlers.setShowSessionSelector = null;
    capturedCompletionTriggerCalls.length = 0;
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => createDomRect(),
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => createDomRect(),
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  /** Render the app and open the model selector via the /model action. */
  async function renderWithOpenSelector() {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    setInputSelection(rendered.container, '/');
    clickButton(rendered.container, 'select-model-command');

    // Control for the close tests below: the open path works when no
    // overlay is up.
    expect(rendered.container.querySelector('.model-selector')).not.toBeNull();
    return rendered;
  }

  it.each([
    ['conversationLoaded'],
    ['qwenSessionSwitched'],
    ['conversationCleared'],
  ])(
    'closes the selector on session takeover: %s',
    async (messageType: string) => {
      await renderWithOpenSelector();

      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: messageType } }),
        );
      });

      expect(container?.querySelector('.model-selector')).toBeNull();
    },
  );

  // Each case sets exactly ONE overlay state, so mutating the close-effect's
  // `||` to `&&` (close only when both/all overlays are up) fails here.
  it('closes the selector when a permission request arrives', async () => {
    await renderWithOpenSelector();

    act(() => {
      capturedWebViewHandlers.handlePermissionRequest?.(permissionPayload);
    });

    expect(container?.querySelector('.model-selector')).toBeNull();
  });

  it('closes the selector when an ask-user-question request arrives', async () => {
    await renderWithOpenSelector();

    act(() => {
      capturedWebViewHandlers.handleAskUserQuestion?.(askQuestionPayload);
    });

    expect(container?.querySelector('.model-selector')).toBeNull();
  });

  it('closes the selector when the account info dialog arrives', async () => {
    await renderWithOpenSelector();

    act(() => {
      capturedWebViewHandlers.setAccountInfo?.(accountPayload);
    });

    expect(container?.querySelector('.model-selector')).toBeNull();
  });

  it('closes the selector when the session selector opens', async () => {
    await renderWithOpenSelector();

    act(() => {
      capturedSessionHandlers.setShowSessionSelector?.(true);
    });

    expect(container?.querySelector('.model-selector')).toBeNull();
  });

  it.each([
    [
      'permission request',
      () =>
        capturedWebViewHandlers.handlePermissionRequest?.(permissionPayload),
    ],
    [
      'ask-user-question',
      () => capturedWebViewHandlers.handleAskUserQuestion?.(askQuestionPayload),
    ],
    [
      'account info',
      () => capturedWebViewHandlers.setAccountInfo?.(accountPayload),
    ],
    [
      'session selector',
      () => capturedSessionHandlers.setShowSessionSelector?.(true),
    ],
  ])(
    'does not open the selector from /model while a %s is up',
    async (_label: string, raiseOverlay: () => void) => {
      const rendered = renderApp();
      root = rendered.root;
      container = rendered.container;

      await act(async () => {});
      act(() => {
        raiseOverlay();
      });

      setInputSelection(rendered.container, '/');
      clickButton(rendered.container, 'select-model-command');

      expect(rendered.container.querySelector('.model-selector')).toBeNull();
      // The open gate must stop the selector before it mounts at all — a
      // mount that a close-effect later reverts would still arm the
      // selector's capture-phase keydown listener beneath the overlay.
      expect(mockModelSelectorMounts).not.toHaveBeenCalled();
    },
  );

  it('keeps the typed command and the menu when /model is declined under an overlay', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    // Raise the overlay AFTER the completion-select handler exists, then
    // select /model from the still-mounted completion menu. The gate must
    // decline without stripping the typed trigger text: otherwise the
    // composer ends up empty with nothing opened, and the user must dismiss
    // the overlay and retype the command.
    act(() => {
      capturedWebViewHandlers.handlePermissionRequest?.(permissionPayload);
    });

    setInputSelection(rendered.container, '/model');
    clickButton(rendered.container, 'select-model-command');

    expect(rendered.container.querySelector('.model-selector')).toBeNull();
    expect(mockModelSelectorMounts).not.toHaveBeenCalled();
    // Neither the typed trigger text...
    const inputField = rendered.container.querySelector(
      '[data-testid="input-field"]',
    );
    expect(inputField?.textContent).toBe('/model');
    // ...nor the completion menu is taken away; Enter can retry once the
    // overlay clears.
    expect(mockCloseCompletion).not.toHaveBeenCalled();
  });

  /** Dispatch a Tab keydown on the mocked composer input. */
  function dispatchTabOnInput(target: HTMLElement) {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
  }

  // Control for the Tab test below: with the selector closed (and the
  // completion menu closed, since an open menu owns Tab for filling), Tab
  // on the composer cycles the approval mode and posts setApprovalMode.
  it('cycles approval mode with Tab when the selector is closed', async () => {
    mockCompletionState.isOpen = false;
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});
    mockPostMessage.mockClear();

    const input = rendered.container.querySelector(
      '[data-testid="input-field"]',
    );
    expect(input).not.toBeNull();
    dispatchTabOnInput(input as HTMLElement);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setApprovalMode' }),
    );
  });

  it('does not cycle approval mode with Tab while the selector is open', async () => {
    // Completion must be closed here too, so the only thing standing between
    // Tab and the approval-mode toggle is the showModelSelector guard —
    // removing that guard term makes this test fail.
    mockCompletionState.isOpen = false;
    await renderWithOpenSelector();
    mockPostMessage.mockClear();

    const input = container?.querySelector('[data-testid="input-field"]');
    expect(input).not.toBeNull();
    dispatchTabOnInput(input as HTMLElement);

    // The selector does not capture Tab itself; without the guard the
    // keystroke silently cycles the approval mode (up to YOLO) underneath
    // the open dropdown.
    expect(mockPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setApprovalMode' }),
    );
  });

  it('swallows Tab while the selector is open so focus cannot leave the composer', async () => {
    // The selector never takes DOM focus. Without a swallow, the browser
    // default for Tab moves focus to the next tabbable element while the
    // dropdown stays open, and subsequent typing goes nowhere.
    mockCompletionState.isOpen = false;
    await renderWithOpenSelector();

    const input = container?.querySelector('[data-testid="input-field"]');
    expect(input).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      (input as HTMLElement).dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it('wires selector visibility into completion suppression', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const lastSuppressionArg = () => {
      const calls = capturedCompletionTriggerCalls;
      const last = calls[calls.length - 1];
      return last ? last[2] : undefined;
    };

    // Selector closed: completion is not suppressed.
    expect(lastSuppressionArg()).toBe(false);

    setInputSelection(rendered.container, '/');
    clickButton(rendered.container, 'select-model-command');
    expect(rendered.container.querySelector('.model-selector')).not.toBeNull();

    // Selector open: the App must pass showModelSelector as the hook's
    // third argument — dropping it (or hardcoding false) fails here.
    expect(lastSuppressionArg()).toBe(true);
  });

  it('unmounts the selector inside the overlay commit, leaving no armed-keydown window', async () => {
    await renderWithOpenSelector();

    // Deliver the overlay the way production does (a raw state update) and
    // force a synchronous commit with flushSync. A useLayoutEffect close
    // runs inside that commit's flush; a passive useEffect close would only
    // be SCHEDULED here, leaving one commit in which the overlay and the
    // selector are mounted together — the selector's capture-phase document
    // keydown listener armed beneath the visible overlay.
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      flushSync(() => {
        capturedWebViewHandlers.handlePermissionRequest?.(permissionPayload);
      });
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }

    // The overlay is up...
    expect(
      container?.querySelector('[data-testid="permission-drawer"]'),
    ).not.toBeNull();
    // ...and the selector is already gone synchronously — no passive-effect
    // flush has had a chance to run yet.
    expect(container?.querySelector('.model-selector')).toBeNull();
  });
});
