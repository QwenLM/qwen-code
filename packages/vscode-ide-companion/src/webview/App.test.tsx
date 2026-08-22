/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { CompletionItem } from '../types/completionItemTypes.js';

const {
  mockPostMessage,
  mockOpenCompletion,
  mockCloseCompletion,
  mockMessageState,
  mockAddMessage,
  mockEndStreaming,
  mockModelSelectorMounts,
  capturedWebViewHandlers,
} = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockOpenCompletion: vi.fn().mockResolvedValue(undefined),
  mockCloseCompletion: vi.fn(),
  mockMessageState: {
    isStreaming: false,
    isWaitingForResponse: false,
  },
  mockAddMessage: vi.fn(),
  mockEndStreaming: vi.fn(),
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
}));

const slashSkillsItem: CompletionItem = {
  id: 'skills',
  label: '/skills',
  type: 'command',
  value: 'skills',
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

const modelCommandItem: CompletionItem = {
  id: 'model',
  label: '/model',
  type: 'command',
  value: 'model',
};

vi.mock('./hooks/useVSCode.js', () => ({
  useVSCode: () => ({
    postMessage: mockPostMessage,
  }),
}));

vi.mock('./hooks/session/useSessionManagement.js', () => ({
  useSessionManagement: () => ({
    showSessionSelector: false,
    filteredSessions: [],
    currentSessionId: 'session-1',
    sessionSearchQuery: '',
    setSessionSearchQuery: vi.fn(),
    handleSwitchSession: vi.fn(),
    setShowSessionSelector: vi.fn(),
    hasMore: false,
    isLoading: false,
    handleLoadMoreSessions: vi.fn(),
    handleLoadQwenSessions: vi.fn(),
    handleNewQwenSession: vi.fn(),
    currentSessionTitle: 'Session 1',
  }),
}));

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
    messages: [],
    isStreaming: mockMessageState.isStreaming,
    isWaitingForResponse: mockMessageState.isWaitingForResponse,
    loadingMessage: null,
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
      }, [setAvailableCommands, setAvailableSkills, setIsAuthenticated]);
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

vi.mock('./hooks/useCompletionTrigger.js', () => ({
  useCompletionTrigger: () => ({
    isOpen: true,
    triggerChar: '/',
    query: 'skills ',
    items: [
      slashSkillsItem,
      secondarySkillItem,
      commitCommandItem,
      clearCommandItem,
    ],
    closeCompletion: mockCloseCompletion,
    openCompletion: mockOpenCompletion,
    refreshCompletion: vi.fn(),
  }),
}));

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
  PermissionDrawer: () => null,
  AskUserQuestionDialog: () => null,
  ImageMessageRenderer: () => null,
  ImagePreview: () => null,
  EmptyState: () => null,
  ChatHeader: () => null,
  SessionSelector: () => null,
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
    showModelSelector,
  }: {
    inputText: string;
    inputFieldRef: React.RefObject<HTMLDivElement>;
    onCancel: () => void;
    onCompletionSelect: (item: CompletionItem) => void;
    onCompletionFill?: (item: CompletionItem) => void;
    showModelSelector?: boolean;
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
        <button onClick={() => onCompletionSelect(modelCommandItem)}>
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

import { App, getLastUserTurnIndex, type MessageListItem } from './App.js';

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

// Shared lifecycle for every suite that renders the real App: file scope so
// all describes run with identical environment stubs (no duplicated blocks).
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockMessageState.isStreaming = false;
  mockMessageState.isWaitingForResponse = false;
  capturedWebViewHandlers.handlePermissionRequest = null;
  capturedWebViewHandlers.handleAskUserQuestion = null;
  capturedWebViewHandlers.setAccountInfo = null;
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

describe('getLastUserTurnIndex', () => {
  it('returns the latest user turn and ignores assistant messages', () => {
    const messages: MessageListItem[] = [
      {
        type: 'message',
        timestamp: 1,
        data: { role: 'user', content: 'first', timestamp: 1, turnIndex: 0 },
      },
      {
        type: 'message',
        timestamp: 2,
        data: { role: 'assistant', content: 'reply', timestamp: 2 },
      },
      {
        type: 'message',
        timestamp: 3,
        data: { role: 'user', content: 'second', timestamp: 3, turnIndex: 1 },
      },
    ];

    expect(getLastUserTurnIndex(messages)).toBe(1);
  });

  it('keeps image and text parts in the same explicit user turn', () => {
    const messages: MessageListItem[] = [
      {
        type: 'message',
        timestamp: 1,
        data: { role: 'user', content: 'first', timestamp: 1, turnIndex: 0 },
      },
      {
        type: 'message',
        timestamp: 2,
        data: {
          role: 'user',
          content: '',
          timestamp: 2,
          turnIndex: 1,
          kind: 'image',
          imagePath: '/tmp/image.png',
        },
      },
      {
        type: 'message',
        timestamp: 2,
        data: { role: 'user', content: 'caption', timestamp: 2, turnIndex: 1 },
      },
    ];

    expect(getLastUserTurnIndex(messages)).toBe(1);
  });
});

describe('App /skills secondary picker', () => {
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
      }),
    );
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'cancelStreaming',
      data: {},
    });
  });
});

describe('App model selector gating', () => {
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
});

describe('App messages container bottom clearance', () => {
  it('keeps only a small bottom padding now that the form is an in-flow sibling', async () => {
    const rendered = renderApp();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {});

    const messages = rendered.container.querySelector('.chat-messages');
    expect(messages).not.toBeNull();
    // The input form's wrapper is an in-flow flex child sized to the
    // measured form height (InputForm's ResizeObserver wrapper), so the
    // messages viewport already ends at the form's top edge. The old
    // overlay layout floated the form over the messages and needed
    // pb-[140px] of scroll clearance; keeping it would strand ~140px of
    // dead space between the last message and the form (#8617 follow-up).
    expect(messages?.className ?? '').toContain('pb-2');
    expect(messages?.className ?? '').not.toContain('pb-[140px]');
  });
});
