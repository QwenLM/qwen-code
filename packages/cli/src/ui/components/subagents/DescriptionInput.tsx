/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import { WizardStepProps, WizardAction } from './types.js';
import { sanitizeInput } from './utils.js';
import { Config, subagentGenerator } from '@qwen-code/qwen-code-core';
import { useTextBuffer } from '../shared/text-buffer.js';
import { useKeypress, Key } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { theme } from '../../semantic-colors.js';
import { cpSlice, cpLen } from '../../utils/textUtils.js';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { Colors } from '../../colors.js';

/**
 * Step 3: Description input with LLM generation.
 */
export function DescriptionInput({
  state,
  dispatch,
  onNext,
  config,
}: WizardStepProps) {
  const [inputWidth] = useState(80); // Fixed width for now
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleTextChange = useCallback(
    (text: string) => {
      const sanitized = sanitizeInput(text);
      dispatch({
        type: 'SET_USER_DESCRIPTION',
        description: sanitized,
      });
    },
    [dispatch],
  );

  const buffer = useTextBuffer({
    initialText: state.userDescription || '',
    viewport: { height: 10, width: inputWidth },
    isValidPath: () => false, // For subagent description, we don't need file path validation
    onChange: handleTextChange,
  });

  const handleGenerate = useCallback(
    async (
      userDescription: string,
      dispatch: (action: WizardAction) => void,
      config: Config,
    ): Promise<void> => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const generated = await subagentGenerator(
          userDescription,
          config.getGeminiClient(),
          abortController.signal,
        );

        // Only dispatch if not aborted
        if (!abortController.signal.aborted) {
          dispatch({
            type: 'SET_GENERATED_CONTENT',
            name: generated.name,
            description: generated.description,
            systemPrompt: generated.systemPrompt,
          });
          onNext();
        }
      } finally {
        abortControllerRef.current = null;
      }
    },
    [onNext],
  );

  const handleSubmit = useCallback(async () => {
    if (!state.canProceed || state.isGenerating || !buffer) {
      return;
    }

    const inputValue = buffer.text.trim();
    if (!inputValue) {
      return;
    }

    // Start LLM generation
    dispatch({ type: 'SET_GENERATING', isGenerating: true });

    try {
      if (!config) {
        throw new Error('Configuration not available');
      }

      // Use real LLM integration
      await handleGenerate(inputValue, dispatch, config);
    } catch (error) {
      dispatch({ type: 'SET_GENERATING', isGenerating: false });

      // Don't show error if it was cancelled by user
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      dispatch({
        type: 'SET_VALIDATION_ERRORS',
        errors: [
          `Failed to generate subagent: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ],
      });
    }
  }, [
    state.canProceed,
    state.isGenerating,
    buffer,
    dispatch,
    config,
    handleGenerate,
  ]);

  // Handle keyboard input during generation
  const handleGenerationKeypress = useCallback(
    (key: Key) => {
      if (keyMatchers[Command.ESCAPE](key)) {
        if (abortControllerRef.current) {
          // Cancel the ongoing generation
          abortControllerRef.current.abort();
          dispatch({ type: 'SET_GENERATING', isGenerating: false });
        }
      }
    },
    [dispatch],
  );

  // Handle keyboard input for text editing
  const handleInput = useCallback(
    (key: Key) => {
      if (!buffer) {
        return;
      }

      if (keyMatchers[Command.SUBMIT](key)) {
        if (buffer.text.trim()) {
          const [row, col] = buffer.cursor;
          const line = buffer.lines[row];
          const charBefore = col > 0 ? cpSlice(line, col - 1, col) : '';
          if (charBefore === '\\') {
            buffer.backspace();
            buffer.newline();
          } else {
            handleSubmit();
          }
        }
        return;
      }

      // Newline insertion
      if (keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return;
      }

      // Ctrl+A (Home) / Ctrl+E (End)
      if (keyMatchers[Command.HOME](key)) {
        buffer.move('home');
        return;
      }
      if (keyMatchers[Command.END](key)) {
        buffer.move('end');
        buffer.moveToOffset(cpLen(buffer.text));
        return;
      }

      // Ctrl+C (Clear input)
      if (keyMatchers[Command.CLEAR_INPUT](key)) {
        if (buffer.text.length > 0) {
          buffer.setText('');
        }
        return;
      }

      // Kill line commands
      if (keyMatchers[Command.KILL_LINE_RIGHT](key)) {
        buffer.killLineRight();
        return;
      }
      if (keyMatchers[Command.KILL_LINE_LEFT](key)) {
        buffer.killLineLeft();
        return;
      }

      // External editor
      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        buffer.openInExternalEditor();
        return;
      }

      // Fall back to the text buffer's default input handling for all other keys
      buffer.handleInput(key);
    },
    [buffer, handleSubmit],
  );

  // Use separate keypress handlers for different states
  useKeypress(handleGenerationKeypress, {
    isActive: state.isGenerating,
  });

  useKeypress(handleInput, {
    isActive: !state.isGenerating,
  });

  if (!buffer) {
    return null;
  }

  const linesToRender = buffer.viewportVisualLines;
  const [cursorVisualRowAbsolute, cursorVisualColAbsolute] =
    buffer.visualCursor;
  const scrollVisualRow = buffer.visualScrollRow;
  const placeholder =
    'e.g., Expert code reviewer that reviews code based on best practices...';

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text color={Colors.Gray}>
          Describe what this subagent should do and when it should be used. (Be
          comprehensive for best results)
        </Text>
      </Box>

      {state.isGenerating ? (
        <Box>
          <Text color={theme.text.accent}>
            ⏳ Generating subagent configuration...
          </Text>
        </Box>
      ) : (
        <>
          <Box>
            <Text color={theme.text.accent}>{'> '}</Text>
            <Box flexGrow={1} flexDirection="column">
              {buffer.text.length === 0 && placeholder ? (
                <Text>
                  {chalk.inverse(placeholder.slice(0, 1))}
                  <Text color={Colors.Gray}>{placeholder.slice(1)}</Text>
                </Text>
              ) : (
                linesToRender.map((lineText, visualIdxInRenderedSet) => {
                  const cursorVisualRow =
                    cursorVisualRowAbsolute - scrollVisualRow;
                  let display = cpSlice(lineText, 0, inputWidth);
                  const currentVisualWidth = stringWidth(display);
                  if (currentVisualWidth < inputWidth) {
                    display =
                      display + ' '.repeat(inputWidth - currentVisualWidth);
                  }

                  if (visualIdxInRenderedSet === cursorVisualRow) {
                    const relativeVisualColForHighlight =
                      cursorVisualColAbsolute;

                    if (relativeVisualColForHighlight >= 0) {
                      if (relativeVisualColForHighlight < cpLen(display)) {
                        const charToHighlight =
                          cpSlice(
                            display,
                            relativeVisualColForHighlight,
                            relativeVisualColForHighlight + 1,
                          ) || ' ';
                        const highlighted = chalk.inverse(charToHighlight);
                        display =
                          cpSlice(display, 0, relativeVisualColForHighlight) +
                          highlighted +
                          cpSlice(display, relativeVisualColForHighlight + 1);
                      } else if (
                        relativeVisualColForHighlight === cpLen(display) &&
                        cpLen(display) === inputWidth
                      ) {
                        display = display + chalk.inverse(' ');
                      }
                    }
                  }
                  return (
                    <Text key={`line-${visualIdxInRenderedSet}`}>
                      {display}
                    </Text>
                  );
                })
              )}
            </Box>
          </Box>

          {state.validationErrors.length > 0 && (
            <Box flexDirection="column">
              {state.validationErrors.map((error, index) => (
                <Text key={index} color={theme.status.error}>
                  ⚠ {error}
                </Text>
              ))}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
