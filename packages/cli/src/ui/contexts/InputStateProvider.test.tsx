/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { act, type MutableRefObject } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '../../test-utils/render.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { useInputState } from './InputContext.js';
import { InputStateProvider } from './InputStateProvider.js';
import { UIStateContext, type UIState } from './UIStateContext.js';
import { waitFor } from '../../test-utils/async.js';

// InputStateProvider reads isInputActive/conversationKey for the prompt stash.
const stashUiState = {
  isInputActive: true,
  conversationKey: 0,
} as unknown as UIState;

const Consumer = ({
  bufferRef,
}: {
  bufferRef: MutableRefObject<TextBuffer | null>;
}) => {
  const { buffer } = useInputState();
  bufferRef.current = buffer;
  return <Text>{buffer.text}</Text>;
};

const NonConsumer = ({
  renderCountRef,
}: {
  renderCountRef: MutableRefObject<number>;
}) => {
  renderCountRef.current += 1;
  return <Text>static history</Text>;
};

const Parent = ({
  renderCountRef,
  nonConsumerRenderCountRef,
  providerBufferRef,
  consumerBufferRef,
}: {
  renderCountRef: MutableRefObject<number>;
  nonConsumerRenderCountRef: MutableRefObject<number>;
  providerBufferRef: MutableRefObject<TextBuffer | null>;
  consumerBufferRef: MutableRefObject<TextBuffer | null>;
}) => {
  renderCountRef.current += 1;
  return (
    <UIStateContext.Provider value={stashUiState}>
      <InputStateProvider
        userMessages={[]}
        shellModeActive={false}
        showEscapePrompt={false}
        inputWidth={80}
        suggestionsWidth={80}
        getPreferredEditor={() => undefined}
        bufferRef={providerBufferRef}
      >
        <NonConsumer renderCountRef={nonConsumerRenderCountRef} />
        <Consumer bufferRef={consumerBufferRef} />
      </InputStateProvider>
    </UIStateContext.Provider>
  );
};

describe('InputStateProvider', () => {
  it('keeps text buffer edits local to the input provider', async () => {
    const renderCountRef: MutableRefObject<number> = { current: 0 };
    const nonConsumerRenderCountRef: MutableRefObject<number> = { current: 0 };
    const providerBufferRef: MutableRefObject<TextBuffer | null> = {
      current: null,
    };
    const consumerBufferRef: MutableRefObject<TextBuffer | null> = {
      current: null,
    };

    const { unmount } = await render(
      <Parent
        renderCountRef={renderCountRef}
        nonConsumerRenderCountRef={nonConsumerRenderCountRef}
        providerBufferRef={providerBufferRef}
        consumerBufferRef={consumerBufferRef}
      />,
    );

    expect(renderCountRef.current).toBe(1);
    expect(nonConsumerRenderCountRef.current).toBe(1);
    expect(providerBufferRef.current).toBe(consumerBufferRef.current);

    act(() => {
      consumerBufferRef.current?.insert('a');
    });

    await waitFor(() => {
      expect(consumerBufferRef.current?.text).toBe('a');
    });
    expect(providerBufferRef.current).toBe(consumerBufferRef.current);
    expect(renderCountRef.current).toBe(1);
    expect(nonConsumerRenderCountRef.current).toBe(1);

    unmount();
  });
});
