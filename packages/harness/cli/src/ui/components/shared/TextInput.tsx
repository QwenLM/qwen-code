/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { Text, Box } from 'ink';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import chalk from 'chalk';
import { theme } from '../../semantic-colors.js';
import { expandPastePlaceholders, type TextBuffer } from './text-buffer.js';
import { cpSlice, cpIndexToOffset } from '../../utils/textUtils.js';
import stringWidth from 'string-width';
import { Command } from '../../key/keyMatchers.js';
import { useKeyMatchers } from '../../hooks/useKeyMatchers.js';
import { useRegisterActionHandlers } from '../../contexts/ActionHandlerRegistry.js';
import { useDeclaredCursor } from '../../../ink/hooks/use-declared-cursor.js';

export interface TextInputProps {
  buffer: TextBuffer;
  placeholder?: string;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  onPaste?: (sequence: string) => boolean;
  /**
   * Consulted before the key reaches the text buffer; return true to consume
   * it. This is the only way for a container to claim keys the buffer would
   * otherwise handle: the focused input subscribes to keypresses directly and
   * runs ahead of context routing, so a Dialog action handler never sees them.
   *
   * Used for keys that mean "leave this field" — e.g. a search box that hands
   * focus back to its list on the arrow keys, which the buffer would otherwise
   * spend moving the cursor between wrapped visual rows.
   */
  onKeyBeforeInput?: (key: Key) => boolean;
  focus?: boolean;
  cursorStyle?: 'inverse' | 'terminal';
  /**
   * When set, every visible character is replaced with this string for
   * display (e.g. `mask="*"`).  The underlying buffer value is unaffected;
   * `onSubmit` still receives the real text.
   */
  mask?: string;
}

export function TextInput({
  buffer,
  placeholder = '',
  onSubmit,
  onCancel,
  onPaste,
  onKeyBeforeInput,
  focus = true,
  cursorStyle = 'inverse',
  mask,
}: TextInputProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const {
    text,
    handleInput,
    visualCursor,
    viewportVisualLines,
    visualScrollRow,
  } = buffer;
  const [cursorVisualRowAbsolute, cursorVisualColAbsolute] = visualCursor;

  // Declare the terminal cursor position so the OS IME candidate window
  // follows the text caret (critical for CJK input methods).
  const cursorRef = useDeclaredCursor({
    line: cursorVisualRowAbsolute - visualScrollRow,
    column: stringWidth(
      cpSlice(
        viewportVisualLines[cursorVisualRowAbsolute - visualScrollRow] ?? '',
        0,
        cursorVisualColAbsolute,
      ),
    ),
    active: Boolean(focus && text.length >= 0),
  });

  const handleKeyPress = useCallback(
    (key: Key) => {
      if (onKeyBeforeInput?.(key)) {
        return true;
      }

      if (key.name === 'escape' && onCancel) {
        onCancel();
        return true;
      }

      if (keyMatchers[Command.SUBMIT](key) && onSubmit) {
        onSubmit(expandPastePlaceholders(text, buffer.pastedContent));
        return true;
      }

      if (key.name === 'paste' && onPaste && onPaste(key.sequence ?? '')) {
        return true;
      }

      const handled = handleInput(key);
      return handled;
    },
    [
      handleInput,
      onCancel,
      onSubmit,
      onPaste,
      onKeyBeforeInput,
      text,
      buffer.pastedContent,
      keyMatchers,
    ],
  );

  useKeypress(handleKeyPress, { isActive: focus });

  // When the text input is focused and has content, intercept left/right arrow
  // keys on the Dialog context so they move the cursor instead of switching
  // tabs in BaseTabDialog.  These child handlers fire before BTD's handlers
  // due to React's child-first effect ordering.
  // Always return true when text has content — even at cursor boundaries —
  // so that left/right never triggers tab switching while editing.
  //
  // IMPORTANT: We register with isActive=focus (not focus && hasContent).
  // The handler must be in the stack from mount time so it sits BEFORE BTD's
  // handler in the array (child effects run before parent effects). If we
  // deferred registration until hasContent flips to true, the handler would
  // be pushed AFTER BTD's and invokeAction would hit BTD first.
  // The hasContent check is done dynamically inside the handler via a ref.
  const hasContentRef = useRef(text.length > 0);
  hasContentRef.current = text.length > 0;
  const textNavHandlers = useMemo(
    (): Record<string, (key: Key) => boolean> => ({
      'dialog:navigate:left': (key: Key) => {
        if (!hasContentRef.current) return false;
        handleInput(key);
        return true;
      },
      'dialog:navigate:right': (key: Key) => {
        if (!hasContentRef.current) return false;
        handleInput(key);
        return true;
      },
    }),
    [handleInput],
  );
  useRegisterActionHandlers('Dialog', textNavHandlers, focus, {
    prepend: true,
  });

  const showPlaceholder = text.length === 0 && placeholder;

  if (showPlaceholder) {
    return (
      <Box ref={cursorRef}>
        {focus ? (
          <Text terminalCursorFocus={focus} terminalCursorPosition={0}>
            {cursorStyle === 'inverse' && chalk.inverse(placeholder[0] || ' ')}
            <Text color={theme.text.secondary}>
              {cursorStyle === 'inverse' ? placeholder.slice(1) : placeholder}
            </Text>
          </Text>
        ) : (
          <Text color={theme.text.secondary}>{placeholder}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box ref={cursorRef} flexDirection="column">
      {viewportVisualLines.map((lineText, idx) => {
        const currentVisualRow = visualScrollRow + idx;
        const isCursorLine =
          focus && currentVisualRow === cursorVisualRowAbsolute;

        const displayText = mask
          ? Array.from(lineText)
              .map((ch) => (/\s/.test(ch) ? ch : mask))
              .join('')
          : lineText;

        const lineDisplay =
          isCursorLine && cursorStyle === 'inverse'
            ? cpSlice(displayText, 0, cursorVisualColAbsolute) +
              chalk.inverse(
                cpSlice(
                  displayText,
                  cursorVisualColAbsolute,
                  cursorVisualColAbsolute + 1,
                ) || ' ',
              ) +
              cpSlice(displayText, cursorVisualColAbsolute + 1)
            : displayText;

        return (
          <Box key={idx} height={1}>
            <Text
              terminalCursorFocus={isCursorLine}
              terminalCursorPosition={cpIndexToOffset(
                lineText,
                cursorVisualColAbsolute,
              )}
            >
              {lineDisplay}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
