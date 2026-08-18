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
import { useMemo, useState } from 'react';
import { C, SYNTAX } from './theme.js';
import { renderDiffBody } from './diff-render.js';
import { TOOL_DISPLAY_BY_NAME } from '../utils/tool-display-map.js';
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

/**
 * Theme-aware mouse-selection colors. OpenTUI's default invert fallback
 * (selection bg = cell fg, fg = black) is unreadable on light themes, so
 * every selectable text/code renderable gets explicit colors.
 */
export const selectionProps = () => ({
  selectionBg: C.selectionBg,
  selectionFg: C.selectionFg,
});

/** TextAttributes bitmask (1 << 7) for the canceled strikethrough. */
const STRIKETHROUGH_ATTR = 128;

/**
 * Tool-card naming/status parity with the original ToolMessage: a card line
 * is `{glyph} {DisplayName} {description}`, where the display name comes
 * from the shared internal-name → display-name map
 * (`run_shell_command` → `Shell`, ui/utils/tool-display-map.ts) and the
 * description reproduces the tool invocation's own `getDescription()` — a
 * shell card renders `echo PARITY-OK (Echo PARITY-OK)`. The status glyph
 * alone carries the outcome; the original appends no `· ok` / `· skipped`
 * suffix, so generic summaries are suppressed (custom ones like a line
 * count stay).
 */
export function toolCardName(rawName: string): string {
  return TOOL_DISPLAY_BY_NAME[rawName] ?? rawName;
}

/** Tool summaries that carry no information beyond the status glyph. */
export const GENERIC_TOOL_SUMMARIES: ReadonlySet<string> = new Set([
  'ok',
  'error',
  'cancelled',
  'canceled',
  'interrupted',
  'skipped',
]);

export function toolCardSummarySuffix(
  done: boolean,
  summary: string | undefined,
): string {
  if (!done || !summary || GENERIC_TOOL_SUMMARIES.has(summary)) return '';
  return ` · ${summary}`;
}

/**
 * Reconstructs the invocation description from the tool-call args (the live
 * event stream carries args, not the core `getDescription()` string):
 * parity of ShellToolInvocation.getDescription for the shell tool and of the
 * path-based descriptions for the file tools.
 */
export function toolCardDescription(rawName: string, args?: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args ?? '{}') as Record<string, unknown>;
  } catch {
    return '';
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const oneLine = (v: string) => v.replace(/\s*\n\s*/g, ' ').trim();
  switch (rawName) {
    case 'run_shell_command': {
      const cmd = str(parsed['command'] ?? parsed['cmd']);
      if (!cmd) return '';
      const desc = str(parsed['description']);
      return desc ? `${oneLine(cmd)} (${oneLine(desc)})` : oneLine(cmd);
    }
    case 'read_file':
    case 'write_file':
    case 'edit':
    case 'notebook_edit': {
      const p = str(
        parsed['file_path'] ?? parsed['path'] ?? parsed['filePath'],
      );
      return p ? oneLine(p) : '';
    }
    case 'list_directory':
    case 'glob': {
      const p = str(parsed['path'] ?? parsed['dir'] ?? parsed['pattern']);
      return p ? oneLine(p) : '';
    }
    case 'grep_search': {
      const pat = str(parsed['pattern']);
      return pat ? oneLine(pat) : '';
    }
    default:
      return '';
  }
}

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
        <text fg={meta.color} attributes={6} {...selectionProps()}>
          {meta.icon} {meta.label}
          {meta.hint ? ` ${meta.hint}` : ''}
        </text>
      </box>
      {!meta.collapsed && item.text.length > 0 && (
        <box paddingLeft={2} marginTop={0}>
          <text fg={C.dim} {...selectionProps()}>
            {item.text}
          </text>
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
  const suffix = toolCardSummarySuffix(item.done, item.summary);
  const confirmLabel =
    item.confirm === 'pending'
      ? ' · awaiting approval…'
      : item.confirm === 'rejected'
        ? ' · rejected'
        : '';
  const description = `${toolCardDescription(item.tool, item.args)}${suffix}${confirmLabel}`;
  // FileDiff results render as colored gutter+diff lines (ink
  // DiffResultRenderer parity), always visible like the original — not
  // gated behind the click-to-expand output block.
  const diffLines = useMemo(
    () => (item.diff ? renderDiffBody(item.diff.fileDiff) : null),
    [item.diff],
  );

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
          <text fg={meta.color} attributes={1} {...selectionProps()}>
            {meta.glyph}
          </text>
        </box>
        <box flexGrow={1}>
          <text
            fg={C.text}
            attributes={1 | (meta.strikethrough ? STRIKETHROUGH_ATTR : 0)}
            {...selectionProps()}
          >
            {toolCardName(item.tool)}
          </text>
          <text fg={C.dim} {...selectionProps()}>
            {' '}
            {description}
          </text>
        </box>
      </box>
      {diffLines && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
          {diffLines.map((spans, i) => (
            <box key={`${i}`} flexDirection="row">
              {spans.map((span, j) => (
                <text key={`${j}`} fg={span.color} {...selectionProps()}>
                  {span.text}
                </text>
              ))}
            </box>
          ))}
        </box>
      )}
      {item.args && expanded && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH}>
          <text fg={C.dim} {...selectionProps()}>
            {argsPreview(item.args)}
          </text>
        </box>
      )}
      {expanded && item.output.length > 0 && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={0}>
          <code
            content={item.output}
            filetype="txt"
            syntaxStyle={SYNTAX}
            fg={C.dim}
            {...selectionProps()}
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
          <text fg={iconColor} attributes={1} {...selectionProps()}>
            {icon}
          </text>
        </box>
        <box flexGrow={1}>
          <text fg={C.text} {...selectionProps()}>
            Task — {item.description}
          </text>
          <text fg={C.dim} {...selectionProps()}>
            {suffix}
          </text>
        </box>
      </box>
      {!item.done && live && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH}>
          <text fg={C.dim} {...selectionProps()}>
            {live}
          </text>
        </box>
      )}
      {expanded && item.progress.length > 0 && (
        <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
          {item.progress.map((p, i) => (
            <text key={i} fg={C.dim} {...selectionProps()}>
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
                  <text fg={user.color} {...selectionProps()}>
                    {user.glyph}
                  </text>
                </box>
                <box flexGrow={1}>
                  <text fg={user.color} {...selectionProps()}>
                    {item.text}
                  </text>
                </box>
              </box>
            );
          case 'assistant':
            // TODO(opentui parity — mermaid/image rendering): the ink
            // renderer turns ```mermaid blocks and inline model images into
            // terminal pictures (mermaidImageRenderer: kitty/sixel/ANSI via
            // the capability probe). OpenTUI has no such pipeline yet — the
            // renderer already probes the kitty graphics protocol at
            // startup, but nothing consumes it — so mermaid output falls
            // back to a plain code block and inline image parts are dropped
            // upstream in the event adapter. Not implemented here by design;
            // tracked as residual gap P2-6 in the display/render audit.
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
                      bg={C.bg}
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
          case 'image':
            // Text-only surface: placeholder for inline model images.
            return (
              <box key={item.id} flexDirection="row" marginTop={1}>
                <text fg={C.dim}>{`[image: ${item.mimeType}]`}</text>
              </box>
            );
        }
      })}
    </>
  );
}
