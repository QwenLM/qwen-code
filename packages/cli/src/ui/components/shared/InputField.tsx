/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { InputFrame, type InputFrameWidth } from './InputFrame.js';
import { TextInput, type TextInputProps } from './TextInput.js';

export interface InputFieldProps extends TextInputProps {
  prefix?: React.ReactNode;
  width?: InputFrameWidth;
  /** Standalone fields use the shared frame; selection-embedded fields stay inline. */
  variant?: 'framed' | 'inline';
}

const INLINE_SELECTION_INPUT_MAX_WIDTH = 60;

export const INLINE_SELECTION_INPUT_VIEWPORT_HEIGHT = 2;
/** Description + maximum visible text rows. */
export const INLINE_SELECTION_INPUT_WITH_DESCRIPTION_HEIGHT =
  INLINE_SELECTION_INPUT_VIEWPORT_HEIGHT + 1;

export interface InlineSelectionInputLayout {
  fieldWidth: number;
  viewport: { width: number; height: number };
}

/** Shared sizing policy for text fields embedded in selection options. */
export function resolveInlineSelectionInputLayout(
  availableWidth: number,
): InlineSelectionInputLayout {
  const fieldWidth = Math.max(
    1,
    Math.min(INLINE_SELECTION_INPUT_MAX_WIDTH, availableWidth),
  );
  return {
    fieldWidth,
    viewport: {
      width: fieldWidth,
      height: INLINE_SELECTION_INPUT_VIEWPORT_HEIGHT,
    },
  };
}

/** Standard composition of the shared input frame and editing behavior. */
export function InputField({
  prefix,
  width,
  variant = 'framed',
  focus = true,
  ...textInputProps
}: InputFieldProps): React.JSX.Element {
  const content = (
    <>
      {prefix !== undefined && (
        <Box flexShrink={0}>
          {typeof prefix === 'string' ? <Text>{prefix}</Text> : prefix}
        </Box>
      )}
      <Box flexGrow={1} minWidth={0} flexDirection="column">
        <TextInput {...textInputProps} focus={focus} />
      </Box>
    </>
  );

  if (variant === 'inline') {
    return (
      <Box width={width} flexDirection="row" alignItems="flex-start">
        {content}
      </Box>
    );
  }

  return (
    <InputFrame active={focus} width={width}>
      {content}
    </InputFrame>
  );
}
