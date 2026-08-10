/* eslint-disable react/no-unknown-property, default-case */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/** @jsxImportSource @opentui/react */

/**
 * Message list aligned with the original MainContent rendering semantics
 * (packages/cli/src/ui/components/HistoryItemDisplay.tsx → UserMessage /
 * AssistantMessage / ThinkMessage / ToolMessage). The ink components render:
 *
 *  - user turns as `> text` in theme.text.accent;
 *  - assistant turns behind a `◆` (ICON.DIAMOND) accent prefix with a
 *    markdown body;
 *  - thinking turns as dim-italic `∵`/`∴` (BECAUSE/THEREFORE) lines that
 *    collapse to a one-line hint when done;
 *  - tool turns with a fixed-width TOOL_STATUS glyph (✓/o/⊷/?/-/x) colored by
 *    status, a bold tool name and a dim description, result below.
 *
 * The pure `*-Meta` helpers below compute the exact glyph/color/label the ink
 * components produce so they can be unit-tested; the MessageList component is
 * a thin OpenTUI rendering of them plus the existing click-to-expand cards.
 */

import { MouseButton } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { useState } from 'react';
import { C, SYNTAX } from './theme.js';
import type { LiveHistoryItem, LiveToolItem } from './live-session-model.js';

/** The original TOOL_STATUS glyphs (ui/constants.ts). */
export const TOOL_STATUS = {
  SUCCESS: '✓',
  PENDING: 'o',
  EXECUTING: '⊷',
  CONFIRMING: '?',
  CANCELED: '-',
  ERROR: 'x',
} as const;

/** The original narrow-presentation icons (ui/constants.ts). */
export const MESSAGE_ICON = {
  DIAMOND: '◆',
  THEREFORE: '∴',
  BECAUSE: '∵',
  CIRCLE_FILLED: '●',
} as const;

/** Width the ink ToolStatusIndicator reserves for the glyph column. */
export const STATUS_INDICATOR_WIDTH = 2;

/** TextAttributes bitmask (1 << 7) for the canceled strikethrough. */
const STRIKETHROUGH_ATTR = 128;

export function userMessageMeta(): { glyph: string; color: string } {
  // UserMessage → PrefixedTextMessage with theme.text.accent (purple).
  return { glyph: '>', color: C.purple };
}

export function assistantMessageMeta(): { glyph: string; color: string } {
  // AssistantMessage → ICON.DIAMOND prefix, theme.text.accent.
  return { glyph: MESSAGE_ICON.DIAMOND, color: C.purple };
}

export interface ThinkingMeta {
  icon: string;
  label: string;
  /** Collapsed hint suffix; empty when the block is expanded. */
  hint: string;
  color: string;
  collapsed: boolean;
}

/**
 * ThinkMessage semantics: a live thought shows `∵ Thinking…`, a committed
 * thought collapses to `∴ Thought for … (… to expand)` unless expanded. The
 * click hint mirrors the VP-mode "click or ctrl+o" affordance.
 */
export function thinkingMeta(
  done: boolean,
  expanded: boolean,
  clickable: boolean,
): ThinkingMeta {
  const expandHint = clickable
    ? '(click or ctrl+o to expand)'
    : '(ctrl+o to expand)';
  if (!done) {
    return {
      icon: MESSAGE_ICON.BECAUSE,
      label: 'Thinking…',
      hint: '',
      color: C.dim,
      collapsed: false,
    };
  }
  if (!expanded) {
    return {
      icon: MESSAGE_ICON.THEREFORE,
      label: 'Thought',
      hint: expandHint,
      color: C.dim,
      collapsed: true,
    };
  }
  return {
    icon: MESSAGE_ICON.THEREFORE,
    label: 'Thought',
    hint: '(ctrl+o to collapse)',
    color: C.dim,
    collapsed: false,
  };
}

export interface ToolStatusMeta {
  glyph: string;
  color: string;
  /** Ink renders the tool name struck through when canceled. */
  strikethrough: boolean;
}

/**
 * ToolStatusIndicator + ToolInfo semantics for one live tool item: pending
 * `o` (green), executing `⊷`, success `✓` (green), confirming `?`, canceled
 * `-`, error `x` (red).
 */
export function toolStatusMeta(item: LiveToolItem): ToolStatusMeta {
  if (item.confirm === 'pending' && !item.done) {
    return {
      glyph: TOOL_STATUS.CONFIRMING,
      color: C.yellow,
      strikethrough: false,
    };
  }
  if (!item.done) {
    return {
      glyph: TOOL_STATUS.EXECUTING,
      color: C.text,
      strikethrough: false,
    };
  }
  if (item.success) {
    return { glyph: TOOL_STATUS.SUCCESS, color: C.green, strikethrough: false };
  }
  const canceled =
    item.summary === 'interrupted' || item.summary === 'canceled';
  if (canceled) {
    return { glyph: TOOL_STATUS.CANCELED, color: C.text, strikethrough: true };
  }
  return { glyph: TOOL_STATUS.ERROR, color: C.red, strikethrough: false };
}

interface ThinkingBlockProps {
  item: Extract<LiveHistoryItem, { kind: 'thinking' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function ThinkingBlock({ item, expanded, onToggle }: ThinkingBlockProps) {
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const meta = thinkingMeta(item.done, expanded, true);
  return (
    <box flexDirection="column" marginTop={0}>
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) {
            const sel = renderer.getSelection();
            if (!sel?.getSelectedText()) onToggle(item.id);
          }
        }}
        backgroundColor={hover ? C.hover : undefined}
      >
        <text fg={meta.color} attributes={6}>
          {meta.icon} {meta.label}
          {meta.hint ? ` ${meta.hint}` : ''}
        </text>
      </box>
      {!meta.collapsed && item.text.length > 0 && (
        <box paddingLeft={2} marginTop={0}>
          <text fg={C.dim}>{item.text}</text>
        </box>
      )}
    </box>
  );
}

interface ToolCardProps {
  item: LiveToolItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function ToolCard({ item, expanded, onToggle }: ToolCardProps) {
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const meta = toolStatusMeta(item);
  const suffix = item.done && item.summary ? ` · ${item.summary}` : '';
  const confirmLabel =
    item.confirm === 'pending'
      ? ' · awaiting approval…'
      : item.confirm === 'rejected'
        ? ' · rejected'
        : '';
  const description = `${item.title}${suffix}${confirmLabel}`;

  return (
    <box flexDirection="column">
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) {
            const sel = renderer.getSelection();
            if (!sel?.getSelectedText()) onToggle(item.id);
          }
        }}
        backgroundColor={hover ? C.hover : undefined}
      >
        <box width={STATUS_INDICATOR_WIDTH} flexShrink={0}>
          <text fg={meta.color} attributes={1}>
            {meta.glyph}
          </text>
        </box>
        <box flexGrow={1}>
          <text
            fg={C.text}
            attributes={1 | (meta.strikethrough ? STRIKETHROUGH_ATTR : 0)}
          >
            {item.tool}
          </text>
          <text fg={C.dim}> {description}</text>
        </box>
      </box>
      {item.args && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH}>
          <text fg={C.dim}>{argsPreview(item.args)}</text>
        </box>
      )}
      {expanded && item.output.length > 0 && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={0}>
          <code
            content={item.output}
            filetype="txt"
            syntaxStyle={SYNTAX}
            fg={C.dim}
          />
        </box>
      )}
    </box>
  );
}

/** One-line truncated preview of the tool-call args JSON. */
const argsPreview = (args: string) => {
  const line = args.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

interface TaskCardProps {
  item: Extract<LiveHistoryItem, { kind: 'task' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function TaskCard({ item, expanded, onToggle }: TaskCardProps) {
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const icon = !item.done ? TOOL_STATUS.EXECUTING : TOOL_STATUS.SUCCESS;
  const iconColor = !item.done ? C.text : C.green;
  const suffix = item.done && item.stats ? ` · ${item.stats}` : '';
  const live =
    !item.done && item.progress.length > 0
      ? item.progress[item.progress.length - 1]
      : undefined;

  return (
    <box flexDirection="column">
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) {
            const sel = renderer.getSelection();
            if (!sel?.getSelectedText()) onToggle(item.id);
          }
        }}
        backgroundColor={hover ? C.hover : undefined}
      >
        <box width={STATUS_INDICATOR_WIDTH} flexShrink={0}>
          <text fg={iconColor} attributes={1}>
            {icon}
          </text>
        </box>
        <box flexGrow={1}>
          <text fg={C.text}>Task — {item.description}</text>
          <text fg={C.dim}>{suffix}</text>
        </box>
      </box>
      {!item.done && live && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH}>
          <text fg={C.dim}>{live}</text>
        </box>
      )}
      {expanded && item.progress.length > 0 && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
          {item.progress.map((p, i) => (
            <text key={i} fg={C.dim}>
              {p}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

export interface MessageListProps {
  items: readonly LiveHistoryItem[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

/**
 * Renders the live history the way MainContent renders the committed one:
 * user/assistant turns get their accent prefix columns, thinking and tool
 * turns render through the collapse/expand cards above.
 */
export function MessageList({ items, expanded, onToggle }: MessageListProps) {
  const user = userMessageMeta();
  const assistant = assistantMessageMeta();
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <box
                key={item.id}
                flexDirection="row"
                marginTop={1}
                alignSelf="flex-start"
              >
                <box width={2} flexShrink={0}>
                  <text fg={user.color}>{user.glyph}</text>
                </box>
                <box flexGrow={1}>
                  <text fg={user.color}>{item.text}</text>
                </box>
              </box>
            );
          case 'assistant':
            return (
              <box key={item.id} flexDirection="row" marginTop={1}>
                <box width={2} flexShrink={0}>
                  <text fg={assistant.color}>{assistant.glyph}</text>
                </box>
                <box flexGrow={1} flexDirection="column">
                  {item.text.length > 0 && (
                    <markdown
                      content={item.text}
                      streaming={item.streaming}
                      syntaxStyle={SYNTAX}
                      fg={C.text}
                    />
                  )}
                </box>
              </box>
            );
          case 'thinking':
            return (
              <ThinkingBlock
                key={item.id}
                item={item}
                expanded={expanded.has(item.id)}
                onToggle={onToggle}
              />
            );
          case 'tool':
            return (
              <ToolCard
                key={item.id}
                item={item}
                expanded={expanded.has(item.id)}
                onToggle={onToggle}
              />
            );
          case 'task':
            return (
              <TaskCard
                key={item.id}
                item={item}
                expanded={expanded.has(item.id)}
                onToggle={onToggle}
              />
            );
        }
      })}
    </>
  );
}
