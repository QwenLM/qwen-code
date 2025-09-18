/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// no hooks needed beyond keypress handled inside
import { Box, Text } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { useTextBuffer } from './text-buffer.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { cpSlice, cpLen } from '../../utils/textUtils.js';
import { theme } from '../../semantic-colors.js';
import { Colors } from '../../colors.js';
import type { Key } from '../../hooks/useKeypress.js';
import { useCallback, useRef, useEffect } from 'react';

export interface TextInputProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  height?: number; // lines in viewport; >1 enables multiline
  isActive?: boolean; // when false, ignore keypresses
  validationErrors?: string[];
  inputWidth?: number;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  height = 1,
  isActive = true,
  validationErrors = [],
  inputWidth = 80,
}: TextInputProps) {
  const allowMultiline = height > 1;

  // Stabilize onChange to avoid triggering useTextBuffer's onChange effect every render
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const stableOnChange = useCallback((text: string) => {
    onChangeRef.current?.(text);
  }, []);

  const buffer = useTextBuffer({
    initialText: value || '',
    viewport: { height, width: inputWidth },
    isValidPath: () => false,
    onChange: stableOnChange,
  });

  const handleSubmit = () => {
    if (!onSubmit) return;
    onSubmit();
  };

  useKeypress(
    (key: Key) => {
      if (!buffer || !isActive) return;

      // Submit on Enter
      if (keyMatchers[Command.SUBMIT](key) || key.name === 'return') {
        if (allowMultiline) {
          const [row, col] = buffer.cursor;
          const line = buffer.lines[row];
          const charBefore = col > 0 ? cpSlice(line, col - 1, col) : '';
          if (charBefore === '\\') {
            buffer.backspace();
            buffer.newline();
          } else {
            handleSubmit();
          }
        } else {
          handleSubmit();
        }
        return;
      }

      // Multiline newline insertion (Shift+Enter etc.)
      if (allowMultiline && keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return;
      }

      // Navigation helpers
      if (keyMatchers[Command.HOME](key)) {
        buffer.move('home');
        return;
      }
      if (keyMatchers[Command.END](key)) {
        buffer.move('end');
        buffer.moveToOffset(cpLen(buffer.text));
        return;
      }

      if (keyMatchers[Command.CLEAR_INPUT](key)) {
        if (buffer.text.length > 0) buffer.setText('');
        return;
      }
      if (keyMatchers[Command.KILL_LINE_RIGHT](key)) {
        buffer.killLineRight();
        return;
      }
      if (keyMatchers[Command.KILL_LINE_LEFT](key)) {
        buffer.killLineLeft();
        return;
      }

      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        buffer.openInExternalEditor();
        return;
      }

      buffer.handleInput(key);
    },
    { isActive },
  );

  if (!buffer) return null;

  const linesToRender = buffer.viewportVisualLines;
  const [cursorVisualRowAbsolute, cursorVisualColAbsolute] =
    buffer.visualCursor;
  const scrollVisualRow = buffer.visualScrollRow;

  return (
    <Box flexDirection="column" gap={1}>
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
              const cursorVisualRow = cursorVisualRowAbsolute - scrollVisualRow;
              let display = cpSlice(lineText, 0, inputWidth);
              const currentVisualWidth = stringWidth(display);
              if (currentVisualWidth < inputWidth) {
                display = display + ' '.repeat(inputWidth - currentVisualWidth);
              }

              if (visualIdxInRenderedSet === cursorVisualRow) {
                const relativeVisualColForHighlight = cursorVisualColAbsolute;
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
                <Text key={`line-${visualIdxInRenderedSet}`}>{display}</Text>
              );
            })
          )}
        </Box>
      </Box>

      {validationErrors.length > 0 && (
        <Box flexDirection="column">
          {validationErrors.map((error, index) => (
            <Text key={index} color={theme.status.error}>
              ⚠ {error}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
