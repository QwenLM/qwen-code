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
import { AgentStatus } from '@qwen-code/qwen-code-core';
import { C, SYNTAX } from './theme.js';
import {
  AnsiRows,
  MESSAGE_ICON,
  TOOL_CARD_DESCRIPTION_ROWS,
  TodoRows,
  assistantMessageMeta,
  capToolCardDescription,
  hiddenLinesLabel,
  hiddenTailLinesLabel,
  maxHistoryItemRows,
  pendingCardMaxRows,
  selectionProps,
  STATUS_INDICATOR_WIDTH,
  tailWindow,
  thinkingMeta,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolCardText,
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
  type LiveArenaSessionItem,
} from './live-session-model.js';
import { renderDiffBody } from './diff-render.js';
import { assistantMarkdownForRender } from './markdown-heal.js';
import {
  getCachedStringWidth,
  sanitizeTerminalText,
} from '../utils/textUtils.js';
import { getCompressionStatusText } from '../utils/compression-text.js';
import { ICON } from '../constants.js';
import { formatDuration } from '../utils/formatters.js';
import { getArenaStatusLabel } from '../utils/displayUtils.js';
import type { ArenaAgentCardData } from '../types.js';

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
          terminalHeight={availableTerminalHeight}
          width={availableWidth}
        />
      ))}
    </box>
  );
}

function TranscriptItem({
  item,
  maxRows,
  terminalHeight,
  width,
}: {
  item: LiveHistoryItem;
  maxRows: number;
  terminalHeight: number;
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
      return (
        <ToolCard
          item={item}
          maxRows={maxRows}
          terminalHeight={terminalHeight}
          width={width}
        />
      );
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
    case 'away-recap':
      return <AwayRecapRow text={item.text} />;
    case 'user-shell':
      return <UserShellRow text={item.text} />;
    case 'advisor':
      return <AdvisorRow text={item.text} model={item.model} />;
    case 'arena-agent':
      return <ArenaAgentRow agent={item.agent} />;
    case 'arena-session':
      return <ArenaSessionRow item={item} />;
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
  terminalHeight,
  width,
}: {
  item: LiveToolItem;
  maxRows: number;
  terminalHeight: number;
  width: number;
}) {
  const status = toolStatusMeta(item);
  const name = toolCardName(item.tool);
  const description =
    item.description ?? toolCardDescription(item.tool, item.args);
  // Measure on the same basis the render uses: a live description (e.g. a
  // shell command) can carry newlines that each become a physical row while
  // costing zero columns in the cap math, so fold them first like the
  // fallback path does (R6-2).
  const text = toolCardText(description);
  // The description stays visible while a call awaits approval: an MCP
  // confirmation dialog shows only the server and tool names, so the card
  // is the only surface carrying the arguments (R5-9) — the settled 5-row
  // cap would hide the tail of exactly the payload being approved. The
  // pending budget stays viewport- and payload-aware (pendingCardMaxRows):
  // the dialog renders in flow below the transcript, and a hook-forced
  // confirmation renders this same payload in its body, so the card must
  // yield rows for it or ctrl-s expansion pushes the dialog off screen.
  const cap = capToolCardDescription(
    text,
    name,
    width,
    item.confirm === 'pending' && !item.done
      ? pendingCardMaxRows(terminalHeight, getCachedStringWidth(text), width)
      : TOOL_CARD_DESCRIPTION_ROWS,
  );
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
        {cap.description ? (
          <text fg={C.dim} {...selectionProps()}>
            {` ${sanitizeTerminalText(cap.description)}`}
          </text>
        ) : null}
        {suffix ? <text fg={C.dim}>{sanitizeTerminalText(suffix)}</text> : null}
      </box>
      {cap.hiddenRows > 0 && (
        <text fg={C.dim}>{hiddenTailLinesLabel(cap.hiddenRows)}</text>
      )}
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

// ink AwayRecapMessage parity: `※` gutter + "recap:" label, all dim; the
// recap scrolls with the conversation instead of pinning above the input.
function AwayRecapRow({ text }: { text: string }) {
  return (
    <box flexDirection="row">
      <text fg={C.dim}>{`${ICON.REFERENCE} `}</text>
      <text fg={C.dim} attributes={1}>
        {'recap: '}
      </text>
      <text fg={C.dim} attributes={4} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

// ink UserShellMessage parity: `$ ` prefix (ink's link color → accent) +
// the command text in the primary color.
function UserShellRow({ text }: { text: string }) {
  return (
    <box flexDirection="row">
      <text fg={C.accent}>{'$ '}</text>
      <text fg={C.text} {...selectionProps()}>
        {sanitizeTerminalText(text)}
      </text>
    </box>
  );
}

// ink AdvisorMessage parity: `/advisor · model` header + the review body as
// markdown. The ink card's border is dropped — the transcript's other cards
// separate with indentation, not boxes.
function AdvisorRow({ text, model }: { text: string; model: string }) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {'/advisor'}
        </text>
        <text fg={C.accent}>{` · ${sanitizeTerminalText(model)}`}</text>
      </box>
      <box paddingLeft={2}>
        <markdown
          content={sanitizeTerminalText(text)}
          syntaxStyle={SYNTAX}
          streaming={false}
        />
      </box>
    </box>
  );
}

// ink getArenaStatusLabel colors mapped onto the live palette (the helper
// returns ink theme hexes, which would not track the OpenTUI theme swap).
function arenaStatusColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.IDLE:
    case AgentStatus.COMPLETED:
      return C.green;
    case AgentStatus.CANCELLED:
      return C.yellow;
    case AgentStatus.FAILED:
      return C.red;
    default:
      return C.dim;
  }
}

// ink ArenaAgentCard parity: status line + tokens + tool calls (+ error).
function ArenaAgentRow({ agent }: { agent: ArenaAgentCardData }) {
  const { icon, text } = getArenaStatusLabel(agent.status);
  const failed = agent.failedToolCalls > 0;
  return (
    <box flexDirection="column">
      <text fg={arenaStatusColor(agent.status)}>
        {`${icon} ${sanitizeTerminalText(agent.label)} · ${text} · ${formatDuration(agent.durationMs)}`}
      </text>
      <text fg={C.dim}>
        {`  Tokens: ${agent.totalTokens.toLocaleString()} (in ${agent.inputTokens.toLocaleString()}, out ${agent.outputTokens.toLocaleString()})`}
      </text>
      <text fg={C.dim}>
        {`  Tool Calls: ${agent.toolCalls}`}
        {failed ? ' (' : null}
        {failed ? (
          <span fg={C.green}>{`✓ ${agent.successfulToolCalls}`}</span>
        ) : null}
        {failed ? (
          <span fg={C.red}>{` ✕ ${agent.failedToolCalls}`}</span>
        ) : null}
        {failed ? ')' : null}
      </text>
      {agent.error ? (
        <text fg={C.red}>{`  ${sanitizeTerminalText(agent.error)}`}</text>
      ) : null}
    </box>
  );
}

// ink ArenaSessionCard parity, mirrored helpers (the ink component keeps
// them module-private): diff counts, file lists, and the common/label-only
// file groups compared across agents.
function arenaDiffStats(agent: ArenaAgentCardData): {
  additions: number;
  deletions: number;
} {
  if (agent.diffSummary) {
    return {
      additions: agent.diffSummary.additions,
      deletions: agent.diffSummary.deletions,
    };
  }
  if (!agent.diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of agent.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function arenaAgentFiles(agent: ArenaAgentCardData): string[] {
  return (
    agent.modifiedFiles ?? agent.diffSummary?.files.map((f) => f.path) ?? []
  );
}

const ARENA_MAX_FILE_ITEMS = 4;

function arenaFileList(files: string[]): string {
  if (files.length === 0) return 'none';
  const visible = files.slice(0, ARENA_MAX_FILE_ITEMS);
  const suffix =
    files.length > ARENA_MAX_FILE_ITEMS
      ? `, +${files.length - ARENA_MAX_FILE_ITEMS} more`
      : '';
  return `${visible.join(', ')}${suffix}`;
}

function arenaFileGroups(
  agents: ArenaAgentCardData[],
): Array<{ label: string; files: string[] }> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const file of new Set(arenaAgentFiles(agent))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const common = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
  const groups = [{ label: 'common', files: common }];
  for (const agent of agents) {
    const unique = arenaAgentFiles(agent)
      .filter((file) => counts.get(file) === 1)
      .sort();
    if (unique.length > 0) {
      groups.push({ label: `${agent.label}-only`, files: unique });
    }
  }
  return groups;
}

function ArenaSessionRow({ item }: { item: LiveArenaSessionItem }) {
  const { sessionStatus, agents } = item;
  const comparing = sessionStatus === 'idle' || sessionStatus === 'completed';
  const title = comparing
    ? 'Arena Comparison Summary'
    : sessionStatus === 'cancelled'
      ? 'Arena Cancelled'
      : 'Arena Failed';
  const branch = (index: number, total: number) =>
    index === total - 1 ? '└─' : '├─';
  return (
    <box flexDirection="column">
      <text fg={C.text} attributes={1}>
        {title}
      </text>
      {comparing ? (
        <>
          <text fg={C.text} attributes={1}>
            {'Status Summary:'}
          </text>
          {agents.map((agent, index) => {
            const { text } = getArenaStatusLabel(agent.status);
            return (
              <text key={agent.label} fg={C.dim}>
                {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: `}
                <span fg={arenaStatusColor(agent.status)}>{text}</span>
              </text>
            );
          })}
          <text fg={C.text} attributes={1}>
            {'Files Modified:'}
          </text>
          {arenaFileGroups(agents).map((group, index, groups) => (
            <text key={group.label} fg={C.dim}>
              {`  ${branch(index, groups.length)} ${sanitizeTerminalText(group.label)}: `}
              <span fg={C.text}>
                {sanitizeTerminalText(arenaFileList(group.files))}
              </span>
            </text>
          ))}
          <text fg={C.text} attributes={1}>
            {'Approach Summary:'}
          </text>
          {agents.map((agent, index) => {
            const stats = arenaDiffStats(agent);
            const files = arenaAgentFiles(agent).length;
            const summary =
              agent.approachSummary ?? 'No approach summary available.';
            return (
              <text key={agent.label} fg={C.text}>
                {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: ${sanitizeTerminalText(summary)} `}
                <span fg={C.dim}>
                  {`(${files} ${files === 1 ? 'file' : 'files'}, `}
                </span>
                <span fg={C.green}>{`+${stats.additions}`}</span>
                <span fg={C.dim}> </span>
                <span fg={C.red}>{`-${stats.deletions}`}</span>
                <span fg={C.dim}>{' lines, '}</span>
                <span fg={C.accent}>{agent.toolCalls}</span>
                <span fg={C.dim}>
                  {agent.toolCalls === 1 ? ' tool call)' : ' tool calls)'}
                </span>
              </text>
            );
          })}
          <text fg={C.text} attributes={1}>
            {'Token Efficiency:'}
          </text>
          {agents.map((agent, index) => (
            <text key={agent.label} fg={C.dim}>
              {`  ${branch(index, agents.length)} ${sanitizeTerminalText(agent.label)}: `}
              <span fg={C.text}>
                {`${agent.outputTokens.toLocaleString()} tokens · runtime ${formatDuration(agent.durationMs)}`}
              </span>
            </text>
          ))}
        </>
      ) : null}
      {comparing ? (
        <text fg={C.dim}>
          {'Run '}
          <span fg={C.accent}>{'/arena select'}</span>
          {sessionStatus === 'idle'
            ? ' to view detailed diff or pick a winner.'
            : ' to pick a winner.'}
        </text>
      ) : null}
    </box>
  );
}
