/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, createElement, type FormEvent, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZERO_WIDTH_SPACE, stripZeroWidthSpaces } from '@qwen-code/webui';
import { shouldSendMessage, useMessageSubmit } from './useMessageSubmit.js';

type UseMessageSubmitProps = Parameters<typeof useMessageSubmit>[0];
type UseMessageSubmitApi = ReturnType<typeof useMessageSubmit>;

function createSubmitEvent(): FormEvent {
  return { preventDefault: vi.fn() } as unknown as FormEvent;
}

function createDefaultProps(
  overrides: Partial<UseMessageSubmitProps> = {},
): UseMessageSubmitProps {
  const inputField = document.createElement('div');
  const fileContext = {
    getFileReference: vi.fn(),
    activeFilePath: null,
    activeFileName: null,
    activeSelection: null,
    clearFileReferences: vi.fn(),
    ...overrides.fileContext,
  };
  const messageHandling = {
    setWaitingForResponse: vi.fn(),
    ...overrides.messageHandling,
  };

  return {
    vscode: {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    },
    inputText: 'hello',
    setInputText: vi.fn(),
    attachedImages: [],
    clearImages: vi.fn(),
    inputFieldRef: {
      current: inputField,
    } as RefObject<HTMLDivElement | null>,
    isStreaming: false,
    isWaitingForResponse: false,
    fileContext,
    messageHandling,
    ...overrides,
  };
}

function renderHookHarness(props: UseMessageSubmitProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latestApi: UseMessageSubmitApi | null = null;

  function Harness() {
    latestApi = useMessageSubmit(props);
    return null;
  }

  act(() => {
    root.render(createElement(Harness));
  });

  return {
    container,
    root,
    get api(): UseMessageSubmitApi {
      if (!latestApi) {
        throw new Error('Hook API is not available');
      }
      return latestApi;
    },
  };
}

describe('ZERO_WIDTH_SPACE and stripZeroWidthSpaces', () => {
  it('ZERO_WIDTH_SPACE is U+200B', () => {
    expect(ZERO_WIDTH_SPACE).toBe('\u200B');
    expect(ZERO_WIDTH_SPACE.length).toBe(1);
  });

  it('strips a single leading zero-width space', () => {
    expect(stripZeroWidthSpaces('\u200B')).toBe('');
  });

  it('strips zero-width space before real text', () => {
    expect(stripZeroWidthSpaces('\u200B/help')).toBe('/help');
  });

  it('strips multiple zero-width spaces', () => {
    expect(stripZeroWidthSpaces('\u200Bhello\u200B world\u200B')).toBe(
      'hello world',
    );
  });

  it('returns unchanged text when no zero-width spaces present', () => {
    expect(stripZeroWidthSpaces('hello world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(stripZeroWidthSpaces('')).toBe('');
  });

  it('preserves other whitespace characters', () => {
    expect(stripZeroWidthSpaces('\u200B \t\n')).toBe(' \t\n');
  });
});

describe('shouldSendMessage', () => {
  const defaults = {
    isStreaming: false,
    isWaitingForResponse: false,
  };

  it('returns false when streaming', () => {
    expect(
      shouldSendMessage({ ...defaults, inputText: 'hello', isStreaming: true }),
    ).toBe(false);
  });

  it('returns false when waiting for response', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: 'hello',
        isWaitingForResponse: true,
      }),
    ).toBe(false);
  });

  it('returns true for non-empty text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: 'hello' })).toBe(true);
  });

  it('returns false for empty text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '' })).toBe(false);
  });

  it('returns false for whitespace-only text', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '   ' })).toBe(false);
  });

  it('returns false when input is only a zero-width space placeholder', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200B' })).toBe(false);
  });

  it('returns false when input is zero-width space plus whitespace', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200B   ' })).toBe(
      false,
    );
  });

  it('returns true when input has real text after zero-width space', () => {
    expect(shouldSendMessage({ ...defaults, inputText: '\u200Bhello' })).toBe(
      true,
    );
  });

  it('returns true when input has only attachments and no text', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: '',
        attachedImages: [
          {
            id: '1',
            name: 'test.png',
            type: 'image/png',
            size: 100,
            data: 'base64data',
            timestamp: Date.now(),
          },
        ],
      }),
    ).toBe(true);
  });

  it('returns true when input has only attachments and zero-width space', () => {
    expect(
      shouldSendMessage({
        ...defaults,
        inputText: '\u200B',
        attachedImages: [
          {
            id: '1',
            name: 'test.png',
            type: 'image/png',
            size: 100,
            data: 'base64data',
            timestamp: Date.now(),
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('useMessageSubmit', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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

  it('posts a normal sendMessage payload for non-edit submissions', () => {
    const props = createDefaultProps({ inputText: 'normal prompt' });
    const rendered = renderHookHarness(props);
    root = rendered.root;
    container = rendered.container;

    act(() => {
      rendered.api.handleSubmit(createSubmitEvent());
    });

    expect(props.vscode.postMessage).toHaveBeenCalledWith({
      type: 'sendMessage',
      data: {
        text: 'normal prompt',
        context: undefined,
        fileContext: undefined,
        attachments: undefined,
      },
    });
  });

  it('posts editMessage with targetTurnIndex for edit submissions', () => {
    const props = createDefaultProps({
      inputText: 'edited prompt',
      editTargetTurnIndex: 2,
    });
    const rendered = renderHookHarness(props);
    root = rendered.root;
    container = rendered.container;

    act(() => {
      rendered.api.handleSubmit(createSubmitEvent());
    });

    expect(props.vscode.postMessage).toHaveBeenCalledWith({
      type: 'editMessage',
      data: {
        text: 'edited prompt',
        context: undefined,
        fileContext: undefined,
        attachments: undefined,
        targetTurnIndex: 2,
      },
    });
  });
});
