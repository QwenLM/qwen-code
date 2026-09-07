/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transcript renderer for the OpenTUI backend (Batch 6): maps the folded
 * {@link LiveHistoryItem} list onto screen rows, reusing the ink-parity
 * helpers in messages.tsx (glyphs, colors, tail windows, todo/ansi rows) and
 * the native `<markdown>` renderable for assistant bodies.
 *
 * Every history kind renders something — a kind that fell through would be a
 * silent no-op, which the composition-root contract forbids.
 */

import { useEffect, useState } from 'react';
import { C, SYNTAX } from './theme.js';
import {
  AnsiRows,
  MESSAGE_ICON,
  TodoRows,
  assistantMessageMeta,
  hiddenLinesLabel,
  maxHistoryItemRows,
  selectionProps,
  STATUS_INDICATOR_WIDTH,
  tailWindow,
  thinkingMeta,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolStatusMeta,
  truncateResultDisplayChars,
  userMessageMeta,
} from './messages.js';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  type GoalCardColor,
  type LiveGoalLegacyData,
  type LiveHistoryItem,
  type LiveToolItem,
} from './live-session-model.js';
import { renderDiffBody } from './diff-render.js';
import { assistantMarkdownForRender } from './markdown-heal.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { getCompressionStatusText } from '../utils/compression-text.js';
import { ICON } from '../constants.js';

const GOAL_COLOR: Record<GoalCardColor, string> = {
  secondary: C.dim,
  accent: C.accent,
  warning: C.yellow,
  error: C.red,
  success: C.green,
};

export interface TranscriptViewProps {
  items: readonly LiveHistoryItem[];
  /** Width budget for ANSI grids / wrapping (defaults to a safe 80). */
  availableWidth?: number;
  /** Terminal height; per-item row caps follow ink staticAreaMaxItemHeight. */
  availableTerminalHeight?: number;
}

export function OpenTuiTranscriptView({
  items,
  availableWidth = 80,
  availableTerminalHeight = 24,
}: TranscriptViewProps) {
  const maxRows = maxHistoryItemRows(availableTerminalHeight);
  return (
    <box flexDirection="column">
      {items.map((item) => (
        <TranscriptItem
          key={item.id}
          item={item}
          maxRows={maxRows}
          width={availableWidth}
        />
      ))}
    </box>
  );
}

function TranscriptItem({
  item,
  maxRows,
  width,
}: {
  item: LiveHistoryItem;
  maxRows: number;
  width: number;
}) {
  switch (item.kind) {
    case 'user':
      return <UserRow text={item.text} />;
    case 'assistant':
      return <AssistantRow text={item.text} streaming={item.streaming} />;
    case 'thinking':
      return <ThinkingRow text={item.text} done={item.done} />;
    case 'tool':
      return <ToolCard item={item} maxRows={maxRows} width={width} />;
    case 'task':
      return <TaskCard item={item} />;
    case 'image':
      return (
        <text fg={C.dim} {...selectionProps()}>
          {`[inline image: ${item.mimeType}]`}
        </text>
      );
    case 'compaction':
      return <CompactionRow compression={item.compression} />;
    case 'info':
      return (
        <box flexDirection="row">
          <text fg={C.dim}>{`${MESSAGE_ICON.CIRCLE_FILLED} `}</text>
          <text fg={C.dim} {...selectionProps()}>
            {sanitizeTerminalText(item.text)}
          </text>
        </box>
      );
    case 'error':
      return <ErrorRow text={item.text} hint={item.hint} />;
    case 'warning':
      return (
        <text fg={C.yellow} {...selectionProps()}>
          {sanitizeTerminalText(item.text)}
        </text>
      );
    case 'retry':
      return (
        <RetryRows
          message={item.message}
          attempt={item.attempt}
          maxRetries={item.maxRetries}
          delayMs={item.delayMs}
          startedAt={item.startedAt}
        />
      );
    case 'stop-hook':
      return <StopHookRow message={item.message} />;
    case 'goal':
      return <GoalCard item={item} />;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function UserRow({ text }: { text: string }) {
  const meta = userMessageMeta();
  return (
    <box flexDirection="row">
      <text fg={meta.color}>{`${meta.glyph} `}</text>
      <text fg={meta.color} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

function AssistantRow({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const meta = assistantMessageMeta();
  const content = sanitizeTerminalText(
    assistantMarkdownForRender(text, streaming),
  );
  return (
    <box flexDirection="row">
      <text fg={meta.color}>{`${meta.glyph} `}</text>
      <box flexGrow={1}>
        <markdown
          content={content}
          syntaxStyle={SYNTAX}
          streaming={streaming}
        />
      </box>
    </box>
  );
}

function ThinkingRow({ text, done }: { text: string; done: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = thinkingMeta(done, expanded, false);
  return (
    <box
      flexDirection="column"
      onMouseUp={() => {
        if (done) setExpanded((v) => !v);
      }}
    >
      <box flexDirection="row">
        <text fg={meta.color}>
          {meta.icon} {meta.label}
          {meta.hint ? ` ${meta.hint}` : ''}
        </text>
      </box>
      {!meta.collapsed && text ? (
        <text fg={C.dim} attributes={4} {...selectionProps()}>
          {sanitizeTerminalText(text)}
        </text>
      ) : null}
    </box>
  );
}

function ToolCard({
  item,
  maxRows,
  width,
}: {
  item: LiveToolItem;
  maxRows: number;
  width: number;
}) {
  const status = toolStatusMeta(item);
  const name = toolCardName(item.tool);
  const description =
    item.description ?? toolCardDescription(item.tool, item.args);
  const suffix = toolCardSummarySuffix(item.done, item.summary);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <box width={STATUS_INDICATOR_WIDTH}>
          <text
            fg={status.color}
            attributes={(status.strikethrough ? 128 : 0) | 1}
          >
            {status.glyph}
          </text>
        </box>
        <text fg={C.text} attributes={status.strikethrough ? 129 : 1}>
          {name}
        </text>
        {description ? (
          <text fg={C.dim} {...selectionProps()}>
            {` ${sanitizeTerminalText(description)}`}
          </text>
        ) : null}
        {suffix ? <text fg={C.dim}>{sanitizeTerminalText(suffix)}</text> : null}
      </box>
      {item.confirm === 'pending' && !item.done ? (
        <text fg={C.yellow}> (awaiting approval)</text>
      ) : null}
      <ToolCardBody item={item} maxRows={maxRows} width={width} />
    </box>
  );
}

function ToolCardBody({
  item,
  maxRows,
  width,
}: {
  item: LiveToolItem;
  maxRows: number;
  width: number;
}) {
  if (item.todos) {
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH}>
        <TodoRows todos={item.todos} />
      </box>
    );
  }
  if (item.ansi) {
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH}>
        <AnsiRows
          grid={item.ansi.grid}
          maxWidth={width - STATUS_INDICATOR_WIDTH}
          totalLines={item.ansi.totalLines}
          totalBytes={item.ansi.totalBytes}
        />
      </box>
    );
  }
  if (item.diff) {
    const lines = renderDiffBody(item.diff.fileDiff);
    const window = tailWindow(lines, maxRows);
    return (
      <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
        {window.hiddenCount > 0 && (
          <text fg={C.dim}>{hiddenLinesLabel(window.hiddenCount)}</text>
        )}
        {window.visible.map((line, i) => (
          <box key={`${i}`} flexDirection="row">
            {line.map((span, j) => (
              <text key={`${j}`} fg={span.color} {...selectionProps()}>
                {span.text}
              </text>
            ))}
          </box>
        ))}
      </box>
    );
  }
  const output = truncateResultDisplayChars(item.output);
  if (!output) return null;
  const lines = sanitizeTerminalText(output).split('\n');
  const window = tailWindow(lines, maxRows);
  return (
    <box paddingLeft={STATUS_INDICATOR_WIDTH} flexDirection="column">
      {window.hiddenCount > 0 && (
        <text fg={C.dim}>{hiddenLinesLabel(window.hiddenCount)}</text>
      )}
      {window.visible.map((line, i) => (
        <text key={`${i}`} fg={C.text} {...selectionProps()}>
          {line}
        </text>
      ))}
      {item.visionBridgeNotice ? (
        <text fg={C.dim}>{sanitizeTerminalText(item.visionBridgeNotice)}</text>
      ) : null}
    </box>
  );
}

function TaskCard({
  item,
}: {
  item: Extract<LiveHistoryItem, { kind: 'task' }>;
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={item.done ? C.green : C.text} attributes={1}>
          {item.done ? TOOL_GLYPH_DONE : TOOL_GLYPH_RUNNING}
        </text>
        <text fg={C.text} attributes={1}>
          {` ${sanitizeTerminalText(item.name)}`}
        </text>
        {item.description ? (
          <text fg={C.dim}> {sanitizeTerminalText(item.description)}</text>
        ) : null}
        {item.stats ? <text fg={C.dim}>{` · ${item.stats}`}</text> : null}
      </box>
      {item.progress.map((line, i) => (
        <text key={`${i}`} fg={C.dim} {...selectionProps()}>
          {sanitizeTerminalText(line)}
        </text>
      ))}
    </box>
  );
}

const TOOL_GLYPH_DONE = ICON.CHECK;
const TOOL_GLYPH_RUNNING = ICON.CIRCLE_LEFT_HALF;

function CompactionRow({
  compression,
}: {
  compression: Extract<LiveHistoryItem, { kind: 'compaction' }>['compression'];
}) {
  const text = getCompressionStatusText({
    isPending: compression.isPending,
    originalTokenCount: compression.originalTokenCount,
    newTokenCount: compression.newTokenCount,
    compressionStatus: compression.compressionStatus,
    originalTokenCountIsEstimated: compression.originalTokenCountIsEstimated,
    newTokenCountIsEstimated: compression.newTokenCountIsEstimated,
  });
  const color = compression.isPending ? C.accent : C.green;
  return (
    <box flexDirection="row">
      <box width={2}>
        <text fg={color}>{compression.isPending ? '…' : ICON.DIAMOND}</text>
      </box>
      <text fg={color} {...selectionProps()}>
        {text}
      </text>
    </box>
  );
}

function ErrorRow({ text, hint }: { text: string; hint?: string }) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={C.red}>{`${ICON.CROSS} `}</text>
        <text fg={C.red} {...selectionProps()}>
          {sanitizeTerminalText(text)}
        </text>
      </box>
      {hint ? (
        <text fg={C.accent} {...selectionProps()}>
          {sanitizeTerminalText(hint)}
        </text>
      ) : null}
    </box>
  );
}

function RetryRows({
  message,
  attempt,
  maxRetries,
  delayMs,
  startedAt,
}: {
  message?: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remainingSec = Math.max(
    0,
    Math.ceil((delayMs - (now - startedAt)) / 1000),
  );
  return (
    <box flexDirection="column">
      <text fg={C.red} {...selectionProps()}>
        {sanitizeTerminalText(
          message ?? `Attempt ${attempt} of ${maxRetries} failed`,
        )}
      </text>
      <text fg={C.yellow}>
        {`↻ Retrying in ${remainingSec}s… (attempt ${attempt} of ${maxRetries})`}
      </text>
    </box>
  );
}

function StopHookRow({ message }: { message: string }) {
  return (
    <box flexDirection="column">
      <text fg={C.accent}>{'⎿ Stop says:'}</text>
      <text fg={C.text} {...selectionProps()}>
        {`  ${sanitizeTerminalText(message)}`}
      </text>
    </box>
  );
}

function GoalCard({
  item,
}: {
  item: Extract<LiveHistoryItem, { kind: 'goal' }>;
}) {
  if (item.legacy) {
    return <LegacyGoalCard legacy={item.legacy} />;
  }
  const view = describeGoalCard(item.snapshot, item.cause);
  if (view.state === 'hidden') return null;
  if (view.state === 'cleared') {
    return <text fg={C.dim}>Goal cleared</text>;
  }
  const color = GOAL_COLOR[view.color];
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={color}>
          {view.icon} {view.title}
        </text>
        {view.subtitle ? <text fg={C.dim}>{` · ${view.subtitle}`}</text> : null}
      </box>
      <text fg={C.text} {...selectionProps()}>
        {`  ${sanitizeTerminalText(view.objective)}`}
      </text>
      {view.reason ? (
        <text fg={C.dim} {...selectionProps()}>
          {`  ${sanitizeTerminalText(view.reason)}`}
        </text>
      ) : null}
    </box>
  );
}

function LegacyGoalCard({ legacy }: { legacy: LiveGoalLegacyData }) {
  const view = describeLegacyGoalCard(legacy);
  if (view.state === 'hidden') return null;
  if (view.state === 'checking') {
    return (
      <box flexDirection="column">
        <text fg={C.yellow}>{view.title}</text>
        <text fg={C.dim}>{`  ${sanitizeTerminalText(view.condition)}`}</text>
        {view.judgeReason ? (
          <text
            fg={C.dim}
          >{`  ${sanitizeTerminalText(view.judgeReason)}`}</text>
        ) : null}
      </box>
    );
  }
  const color = GOAL_COLOR[view.color];
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={color}>
          {view.icon} {view.title}
        </text>
        {view.subtitle ? <text fg={C.dim}>{` · ${view.subtitle}`}</text> : null}
      </box>
      <text fg={C.dim}>{`  ${sanitizeTerminalText(view.condition)}`}</text>
      {view.lastCheck ? (
        <text fg={C.dim}>{`  ${sanitizeTerminalText(view.lastCheck)}`}</text>
      ) : null}
    </box>
  );
}
