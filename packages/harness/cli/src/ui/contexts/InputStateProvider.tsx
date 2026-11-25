/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useLayoutEffect, useMemo } from 'react';
import type { EditorType } from '@qwen-code/core';
import { InputContext, type InputState } from './InputContext.js';
import {
  useTextBuffer,
  type TextBuffer,
} from '../components/shared/text-buffer.js';
import { usePromptStash } from '../hooks/usePromptStash.js';

/**
 * Must be rendered inside a `UIStateContext.Provider`: the prompt stash reads
 * `isInputActive` and `conversationKey` from UI state.
 */
interface InputStateProviderProps {
  children: React.ReactNode;
  userMessages: string[];
  shellModeActive: boolean;
  showEscapePrompt: boolean;
  inputWidth: number;
  suggestionsWidth: number;
  stdin?: NodeJS.ReadStream | null;
  setRawMode?: (mode: boolean) => void;
  getPreferredEditor: () => EditorType | undefined;
  bufferRef: React.MutableRefObject<TextBuffer | null>;
}

export function InputStateProvider({
  children,
  userMessages,
  shellModeActive,
  showEscapePrompt,
  inputWidth,
  suggestionsWidth,
  stdin,
  setRawMode,
  getPreferredEditor,
  bufferRef,
}: InputStateProviderProps): React.JSX.Element {
  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    escapePastedPaths: true,
    shellModeActive,
    getPreferredEditor,
  });

  useLayoutEffect(() => {
    bufferRef.current = buffer;
  }, [buffer, bufferRef]);

  const stash = usePromptStash({ buffer, bufferRef });

  const inputState: InputState = useMemo(
    () => ({
      buffer,
      userMessages,
      shellModeActive,
      showEscapePrompt,
      inputWidth,
      suggestionsWidth,
      stash,
    }),
    [
      buffer,
      userMessages,
      shellModeActive,
      showEscapePrompt,
      inputWidth,
      suggestionsWidth,
      stash,
    ],
  );

  return (
    <InputContext.Provider value={inputState}>{children}</InputContext.Provider>
  );
}
