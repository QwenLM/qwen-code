/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { Box, Text } from 'ink';
import type { WizardStepProps } from '../types.js';
import { Colors } from '../../../colors.js';
import { TextInput } from '../../shared/TextInput.js';

interface TextEntryStepProps
  extends Pick<WizardStepProps, 'dispatch' | 'onNext' | 'state'> {
  description: string;
  placeholder?: string;
  /**
   * Visual height of the input viewport in rows. Name entry can be 1, others can be larger.
   */
  height?: number;
  /** Initial text value when the step loads */
  initialText?: string;
  /**
   * Called on every text change to update state.
   */
  onChange: (text: string) => void;
  /**
   * Optional validation. Return error message when invalid.
   */
  validate?: (text: string) => string | null;
}

export function TextEntryStep({
  state,
  dispatch,
  onNext,
  description,
  placeholder,
  height = 1,
  initialText = '',
  onChange,
  validate,
}: TextEntryStepProps) {
  const submit = useCallback(() => {
    const value = initialText ? initialText.trim() : '';
    const error = validate
      ? validate(value)
      : value.length === 0
        ? 'Please enter a value.'
        : null;
    if (error) {
      dispatch({ type: 'SET_VALIDATION_ERRORS', errors: [error] });
      return;
    }
    dispatch({ type: 'SET_VALIDATION_ERRORS', errors: [] });
    onNext();
  }, [dispatch, onNext, validate, initialText]);

  return (
    <Box flexDirection="column" gap={1}>
      {description && (
        <Box>
          <Text color={Colors.Gray}>{description}</Text>
        </Box>
      )}

      <TextInput
        value={initialText}
        onChange={onChange}
        onSubmit={submit}
        placeholder={placeholder}
        height={height}
        isActive={!state.isGenerating}
        validationErrors={state.validationErrors}
      />
    </Box>
  );
}
