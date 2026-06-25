/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, useStdin } from 'ink';
import stringWidth from 'string-width';
import { useTextBuffer } from './text-buffer.js';
import { usePreferredEditor } from '../../hooks/usePreferredEditor.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { cpSlice, cpLen } from '../../utils/textUtils.js';
import { theme } from '../../semantic-colors.js';
import { Colors } from '../../colors.js';
import type { Key } from '../../hooks/useKeypress.js';
import { useCallback, useRef, useEffect, useState } from 'react';
import { renderSoftwareCursor } from '../../utils/software-cursor.js';

export interface TextInputProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit?: () => void;
  /** Called when Tab is pressed; if provided, prevents the default tab-insertion behaviour. */
  onTab?: (key: Key) => void;
  /** Called when ↑ is pressed; if provided, prevents cursor-up in the buffer. */
  onUp?: () => void;
  /** Called when ↓ is pressed; if provided, prevents cursor-down in the buffer. */
  onDown?: () => void;
  placeholder?: string;
  height?: number; // lines in viewport; >1 enables multiline
  isActive?: boolean; // when false, ignore keypresses
  validationErrors?: string[];
  inputWidth?: number;
  initialCursorOffset?: number;
  ellipsizeOverflow?: boolean;
}

function ellipsizeMiddle(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width <= 3) return cpSlice(text, 0, width);

  const available = width - 3;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${cpSlice(text, 0, headLength)}...${cpSlice(
    text,
    cpLen(text) - tailLength,
  )}`;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onUp,
  onDown,
  placeholder,
  height = 1,
  isActive = true,
  validationErrors = [],
  inputWidth = 80,
  initialCursorOffset,
  ellipsizeOverflow = false,
}: TextInputProps) {
  const allowMultiline = height > 1;
  const [cursorVisible, setCursorVisible] = useState(isActive);

  // Stabilize onChange to avoid triggering useTextBuffer's onChange effect every render
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const stableOnChange = useCallback((text: string) => {
    onChangeRef.current?.(text);
  }, []);

  const preferredEditor = usePreferredEditor();
  const { stdin, setRawMode } = useStdin();

  const buffer = useTextBuffer({
    initialText: value || '',
    initialCursorOffset,
    viewport: { height, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath: () => false,
    onChange: stableOnChange,
    preferredEditor,
  });

  useEffect(() => {
    if (!isActive) {
      setCursorVisible(false);
      return;
    }

    setCursorVisible(true);
    const interval = setInterval(() => {
      setCursorVisible((visible) => !visible);
    }, 530);
    return () => clearInterval(interval);
  }, [isActive]);

  const handleSubmit = () => {
    if (!onSubmit) return;
    onSubmit();
  };

  useKeypress(
    (key: Key) => {
      if (!buffer || !isActive) return;

      // Tab completion: delegate to caller instead of inserting a tab character
      // During paste, let tab through as literal content (e.g. Excel tab-separated data)
      if (key.name === 'tab' && !key.paste) {
        onTab?.(key);
        return;
      }

      // Arrow-key completion navigation: delegate to caller
      if (key.name === 'up' && onUp) {
        onUp();
        return;
      }
      if (key.name === 'down' && onDown) {
        onDown();
        return;
      }

      // Multiline newline insertion (Shift+Enter etc.) — check before SUBMIT
      // so that modified-Return keys aren't swallowed by the submit branch.
      if (allowMultiline && keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return;
      }

      // Submit on Enter (plain Return). In single-line mode any Return
      // variant submits since there is no newline concept.
      if (
        keyMatchers[Command.SUBMIT](key) ||
        (!allowMultiline && key.name === 'return')
      ) {
        handleSubmit();
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
  const shouldRenderCursor = isActive && cursorVisible;

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text color={theme.text.accent}>{'> '}</Text>
        <Box flexGrow={1} flexDirection="column">
          {buffer.text.length === 0 && placeholder ? (
            shouldRenderCursor ? (
              <Text>
                {renderSoftwareCursor(placeholder.slice(0, 1))}
                <Text color={Colors.Gray}>{placeholder.slice(1)}</Text>
              </Text>
            ) : (
              <Text color={Colors.Gray}>{placeholder}</Text>
            )
          ) : ellipsizeOverflow && stringWidth(buffer.text) > inputWidth ? (
            <Text>{ellipsizeMiddle(buffer.text, inputWidth)}</Text>
          ) : (
            linesToRender.map((lineText, visualIdxInRenderedSet) => {
              const cursorVisualRow = cursorVisualRowAbsolute - scrollVisualRow;
              let display = cpSlice(lineText, 0, inputWidth);
              const currentVisualWidth = stringWidth(display);
              if (currentVisualWidth < inputWidth) {
                display = display + ' '.repeat(inputWidth - currentVisualWidth);
              }

              if (
                shouldRenderCursor &&
                visualIdxInRenderedSet === cursorVisualRow
              ) {
                const relativeVisualColForHighlight = cursorVisualColAbsolute;
                if (relativeVisualColForHighlight >= 0) {
                  if (relativeVisualColForHighlight < cpLen(display)) {
                    const charToHighlight =
                      cpSlice(
                        display,
                        relativeVisualColForHighlight,
                        relativeVisualColForHighlight + 1,
                      ) || ' ';
                    const highlighted = renderSoftwareCursor(charToHighlight);
                    display =
                      cpSlice(display, 0, relativeVisualColForHighlight) +
                      highlighted +
                      cpSlice(display, relativeVisualColForHighlight + 1);
                  } else if (
                    relativeVisualColForHighlight === cpLen(display) &&
                    cpLen(display) === inputWidth
                  ) {
                    display = display + renderSoftwareCursor(' ');
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
