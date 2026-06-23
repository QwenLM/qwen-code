/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview BaseTextInput — shared text input component with rendering
 * and common readline keyboard handling.
 *
 * Provides:
 *  - Viewport line rendering from a TextBuffer with cursor display
 *  - Placeholder support when buffer is empty
 *  - Configurable border/prefix styling
 *  - Standard readline shortcuts (Ctrl+A/E/K/U/W, Escape, etc.)
 *  - An `onKeypress` interceptor so consumers can layer custom behavior
 *
 * Used by both InputPrompt (with syntax highlighting + complex key handling)
 * and AgentComposer (with minimal customization).
 */

import type { ReactNode } from 'react';
import { useCallback, useInsertionEffect, useRef } from 'react';
import { Box, Text, type DOMElement, useBoxMetrics, useCursor } from 'ink';
import type { TextBuffer } from './shared/text-buffer.js';
import type { Key } from '../hooks/useKeypress.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import stringWidth from 'string-width';
import { cpSlice, cpLen } from '../utils/textUtils.js';
import { theme } from '../semantic-colors.js';
import { renderSoftwareCursor } from '../utils/software-cursor.js';

// ─── Types ──────────────────────────────────────────────────

export interface RenderLineOptions {
  /** The text content of this visual line. */
  lineText: string;
  /** Whether the cursor is on this visual line. */
  isOnCursorLine: boolean;
  /** The cursor column within this visual line (visual col, not logical). */
  cursorCol: number;
  /** Whether the cursor should be rendered. */
  showCursor: boolean;
  /** Index of this line within the rendered viewport (0-based). */
  visualLineIndex: number;
  /** Absolute visual line index (scrollVisualRow + visualLineIndex). */
  absoluteVisualIndex: number;
  /** The underlying text buffer. */
  buffer: TextBuffer;
  /** The first visible visual row (scroll offset). */
  scrollVisualRow: number;
}

export interface BaseTextInputProps {
  /** The text buffer driving this input. */
  buffer: TextBuffer;
  /** Called when the user submits (Enter). Buffer is cleared automatically. */
  onSubmit: (text: string) => void;
  /**
   * Optional key interceptor. Called before default readline handling.
   * Return `true` if the key was handled (skips default processing).
   */
  onKeypress?: (key: Key) => boolean;
  /** Whether to show the blinking block cursor. Defaults to true. */
  showCursor?: boolean;
  /** Placeholder text shown when the buffer is empty. */
  placeholder?: string;
  /** Custom prefix node (defaults to `> `). */
  prefix?: ReactNode;
  /** Width of the prefix in terminal columns. Defaults to 2 (for "> "). */
  prefixWidth?: number;
  /** Border color for the input box. */
  borderColor?: string;
  /** Label rendered on the top border line (right-aligned). Plain string for width calculation. */
  topRightLabel?: string;
  /** Whether keyboard handling is active. Defaults to true. */
  isActive?: boolean;
  /**
   * Custom line renderer for advanced rendering (e.g. syntax highlighting).
   * When not provided, lines are rendered as plain text with cursor overlay.
   */
  renderLine?: (opts: RenderLineOptions) => ReactNode;
}

// ─── Default line renderer ──────────────────────────────────

/**
 * Renders a single visual line with a high-contrast block cursor.
 * Uses codepoint-aware string operations for Unicode/emoji safety.
 */
export function defaultRenderLine({
  lineText,
  isOnCursorLine,
  cursorCol,
  showCursor,
}: RenderLineOptions): ReactNode {
  if (!isOnCursorLine || !showCursor) {
    return <Text>{lineText || ' '}</Text>;
  }

  const len = cpLen(lineText);

  // Cursor past end of line — append cursor space
  if (cursorCol >= len) {
    return (
      <Text>
        {lineText}
        {renderSoftwareCursor(' ') + '\u200B'}
      </Text>
    );
  }

  const before = cpSlice(lineText, 0, cursorCol);
  const cursorChar = cpSlice(lineText, cursorCol, cursorCol + 1);
  const after = cpSlice(lineText, cursorCol + 1);

  return (
    <Text>
      {before}
      {renderSoftwareCursor(cursorChar)}
      {after}
    </Text>
  );
}

// ─── Helpers ────────────────────────────────────────────────

export type PhysicalCursorState = {
  hasMeasured: boolean;
  showCursor: boolean;
  cursorVisualRow: number;
  cursorVisualCol: number;
  scrollVisualRow: number;
  linesToRender: string[];
  prefixWidth: number;
};

export function getAbsolutePosition(
  node: DOMElement | null,
): { top: number; left: number } | undefined {
  if (!node) return undefined;

  let top = 0;
  let left = 0;
  let current: DOMElement | undefined = node;
  while (current) {
    const layout = current.yogaNode?.getComputedLayout();
    if (layout) {
      top += layout.top;
      left += layout.left;
    }
    current = current.parentNode;
  }

  return { top, left };
}

export function getPhysicalCursorPosition(
  node: DOMElement | null,
  {
    hasMeasured,
    showCursor,
    cursorVisualRow,
    cursorVisualCol,
    scrollVisualRow,
    linesToRender,
    prefixWidth,
  }: PhysicalCursorState,
): { x: number; y: number } | undefined {
  if (!showCursor || !hasMeasured) return undefined;

  const position = getAbsolutePosition(node);
  if (!position) return undefined;

  const relativeRow = cursorVisualRow - scrollVisualRow;
  const lineText = linesToRender[relativeRow] || '';
  const textBeforeCursor = cpSlice(lineText, 0, cursorVisualCol);
  const physicalCol = stringWidth(textBeforeCursor);
  return {
    x: position.left + prefixWidth + physicalCol,
    y: position.top + relativeRow + 1,
  };
}

// ─── Component ──────────────────────────────────────────────

export const BaseTextInput = ({
  buffer,
  onSubmit,
  onKeypress,
  showCursor = true,
  placeholder,
  prefix,
  prefixWidth = 2,
  borderColor,
  topRightLabel,
  isActive = true,
  renderLine = defaultRenderLine,
}: BaseTextInputProps): ReactNode => {
  // ── Keyboard handling ──

  const handleKey = useCallback(
    (key: Key) => {
      // Let the consumer intercept first
      if (onKeypress?.(key)) {
        return;
      }

      if (keyMatchers[Command.TOGGLE_RENDER_MODE](key)) {
        return;
      }

      // ── Standard readline shortcuts ──

      // Submit (Enter, no modifiers)
      if (keyMatchers[Command.SUBMIT](key)) {
        if (buffer.text.trim()) {
          const text = buffer.text;
          buffer.setText('');
          onSubmit(text);
        }
        return;
      }

      // Newline (Shift+Enter, Ctrl+Enter, Ctrl+J)
      if (keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return;
      }

      // Escape → clear input
      if (keyMatchers[Command.ESCAPE](key)) {
        if (buffer.text.length > 0) {
          buffer.setText('');
        }
        return;
      }

      // Ctrl+C → clear input
      if (keyMatchers[Command.CLEAR_INPUT](key)) {
        if (buffer.text.length > 0) {
          buffer.setText('');
        }
        return;
      }

      // Ctrl+A → home
      if (keyMatchers[Command.HOME](key)) {
        buffer.move('home');
        return;
      }

      // Ctrl+E → end
      if (keyMatchers[Command.END](key)) {
        buffer.move('end');
        return;
      }

      // Ctrl+K → kill to end of line
      if (keyMatchers[Command.KILL_LINE_RIGHT](key)) {
        buffer.killLineRight();
        return;
      }

      // Ctrl+U → kill to start of line
      if (keyMatchers[Command.KILL_LINE_LEFT](key)) {
        buffer.killLineLeft();
        return;
      }

      // Ctrl+W / Alt+Backspace → delete word backward
      if (keyMatchers[Command.DELETE_WORD_BACKWARD](key)) {
        buffer.deleteWordLeft();
        return;
      }

      // Ctrl+X Ctrl+E → open in external editor
      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        buffer.openInExternalEditor();
        return;
      }

      // Tab — never insert literal tab characters into the buffer;
      // consumers that need Tab behaviour should intercept it via onKeypress.
      if ((key.name === 'tab' || key.sequence === '\t') && !key.paste) {
        return;
      }

      // Backspace
      if (
        key.name === 'backspace' ||
        key.sequence === '\x7f' ||
        (key.ctrl && key.name === 'h')
      ) {
        buffer.backspace();
        return;
      }

      // Fallthrough — delegate to buffer's built-in input handler
      buffer.handleInput(key);
    },
    [buffer, onSubmit, onKeypress],
  );

  useKeypress(handleKey, { isActive });

  // ── Rendering ──

  const linesToRender = buffer.viewportVisualLines;
  const [cursorVisualRow, cursorVisualCol] = buffer.visualCursor;
  const scrollVisualRow = buffer.visualScrollRow;

  // ── Physical cursor positioning for IME ──
  const boxRef = useRef<DOMElement | null>(null);
  const { hasMeasured } = useBoxMetrics(boxRef);
  const { setCursorPosition } = useCursor();
  const cursorPosition = getPhysicalCursorPosition(boxRef.current, {
    hasMeasured,
    showCursor,
    cursorVisualRow,
    cursorVisualCol,
    scrollVisualRow,
    linesToRender,
    prefixWidth,
  });

  useInsertionEffect(() => {
    setCursorPosition(cursorPosition);
    return () => setCursorPosition(undefined);
  }, [setCursorPosition, cursorPosition]);

  const resolvedBorderColor = borderColor ?? theme.border.focused;
  const resolvedPrefix = prefix ?? (
    <Text color={theme.text.accent}>{'> '}</Text>
  );

  const columns = process.stdout.columns || 80;
  // Build the top border line: ─────── label ──
  // Label takes: 1 space + text + 1 space + 2 trailing dashes = label.length + 4
  const labelWidth = topRightLabel ? stringWidth(topRightLabel) + 4 : 0;
  const dashCount = Math.max(1, columns - labelWidth);
  const topBorderLine = topRightLabel
    ? `${'─'.repeat(dashCount)} ${topRightLabel} ${'─'.repeat(2)}`
    : '─'.repeat(columns);

  return (
    <Box ref={boxRef} flexDirection="column">
      <Text color={resolvedBorderColor} wrap="truncate-end">
        {topBorderLine}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderColor={resolvedBorderColor}
      >
        {resolvedPrefix}
        <Box
          flexGrow={1}
          flexDirection="column"
          backgroundColor={theme.background.primary}
        >
          {buffer.text.length === 0 && placeholder ? (
            showCursor ? (
              <Text>
                {renderSoftwareCursor(placeholder.slice(0, 1))}
                <Text color={theme.text.secondary}>{placeholder.slice(1)}</Text>
              </Text>
            ) : (
              <Text color={theme.text.secondary}>{placeholder}</Text>
            )
          ) : (
            linesToRender.map((lineText, idx) => {
              const absoluteVisualIndex = scrollVisualRow + idx;
              const isOnCursorLine = absoluteVisualIndex === cursorVisualRow;

              return (
                <Box key={idx} height={1}>
                  {renderLine({
                    lineText,
                    isOnCursorLine,
                    cursorCol: cursorVisualCol,
                    showCursor,
                    visualLineIndex: idx,
                    absoluteVisualIndex,
                    buffer,
                    scrollVisualRow,
                  })}
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
};
