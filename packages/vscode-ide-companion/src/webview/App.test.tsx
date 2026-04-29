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

const { mockPostMessage, mockOpenCompletion, mockCloseCompletion } = vi.hoisted(
  () => ({
    mockPostMessage: vi.fn(),
    mockOpenCompletion: vi.fn().mockResolvedValue(undefined),
    mockCloseCompletion: vi.fn(),
  }),
);

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
    isStreaming: false,
    isWaitingForResponse: false,
    loadingMessage: null,
    addMessage: vi.fn(),
    endStreaming: vi.fn(),
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
    }: {
      setIsAuthenticated: (value: boolean) => void;
      setAvailableCommands: (
        value: Array<{ name: string; description?: string }>,
      ) => void;
      setAvailableSkills: (value: string[]) => void;
    }) => {
      const initializedRef = React.useRef(false);

      React.useEffect(() => {
        if (initializedRef.current) {
          return;
        }
        initializedRef.current = true;
        setIsAuthenticated(true);
        setAvailableCommands([
          { name: 'skills', description: 'List available skills' },
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
    items: [slashSkillsItem, secondarySkillItem],
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
}));

vi.mock('./components/layout/InputForm.js', () => ({
  InputForm: ({
    inputText,
    inputFieldRef,
    onCompletionSelect,
    onCompletionFill,
  }: {
    inputText: string;
    inputFieldRef: React.RefObject<HTMLDivElement>;
    onCompletionSelect: (item: CompletionItem) => void;
    onCompletionFill?: (item: CompletionItem) => void;
  }) => (
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
      <button onClick={() => onCompletionSelect(slashSkillsItem)}>
        select-skills-command
      </button>
      <button onClick={() => onCompletionSelect(secondarySkillItem)}>
        select-skill-enter
      </button>
      <button onClick={() => onCompletionFill?.(secondarySkillItem)}>
        select-skill-tab
      </button>
    </div>
  ),
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

describe('App /skills secondary picker', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
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
});
