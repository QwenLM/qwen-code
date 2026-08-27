import {
  forwardRef,
  memo,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type {
  ToolGroupMessage as DaemonToolGroupMessage,
  ThinkingMessage as DaemonThinkingMessage,
  Message,
  ACPToolCall,
  TurnCollapseHead,
} from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import {
  groupParallelAgents,
  type ParallelAgentDisplayItem,
} from '../adapters/parallelAgentGrouping';
import {
  backgroundShellTaskId,
  isBackgroundSubAgentToolCall,
  isSubAgentToolCall,
} from '../adapters/toolClassification';
import { CompactModeContext } from '../WebShellContexts';
import {
  useWebShellCustomization,
  type WebShellAssistantTurnFooterRenderInfo,
} from '../customization';
import { useI18n } from '../i18n';
import { formatContextTokens } from '../utils/formatTokenCount';
import { useWebShellPortalRoot } from '../portalRoot';
import { useTranscriptRenderMode } from '../transcriptRenderMode';
import { MessageItem } from './MessageItem';
import { summaryRunFirstMemberId, summaryRunId } from './summaryRunId';
import type { SessionContentGenerator } from './messages/AssistantMessage';
import { MessageTimestamp } from './MessageTimestamp';
import {
  TurnOutputs,
  type TurnOutputFileChange,
  type TurnOutputOpenRequest,
  type TurnOutputScheduledTask,
} from './artifacts/TurnOutputs';
import { ParallelAgentsGroup } from './messages/tools/ParallelAgentsGroup';
import { useSharedNow } from '../hooks/useSharedNow';
import {
  isActiveToolStatus,
  toolContainsCallId,
} from './messages/toolFormatting';
import { getMcpAppDisplay } from './messages/McpApp';
import turnCollapseStyles from './TurnCollapseRow.module.css';
import flashStyles from './MessageLocateFlash.module.css';
import styles from './MessageList.module.css';
import { WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS } from '../constants/sessions';
import type { AttachmentPreviewRequest } from '../adapters/messageTypes';

const noopTurnOutputAction = () => undefined;
const RELOAD_TRANSCRIPT_DELAY_MS = 15_000;
const TURN_LAYOUT_ANIMATION_MS = 180;
const AGENT_SUMMARY_COLLAPSE_DELAY_MS = 400;
// A reconciled-terminal sibling whose completion notification is delayed (not
// lost) lands within moments; bound the unmatched-completion hold so a truly
// lost notification cannot hide the final footer forever.
const UNMATCHED_AGENT_COMPLETION_GRACE_MS = 5_000;

interface MessageListProps {
  messages: Message[];
  terminalBackgroundShellTaskIds?: ReadonlySet<string>;
  pendingApproval: PermissionRequest | null;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  /** Click an uploaded image in a user message to preview it in the right panel. */
  onImagePreview?: (src: string, alt?: string) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
  loadingTranscript?: boolean;
  catchingUp?: boolean;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
  historyCapacityReached?: boolean;
  historyPaginationError?: boolean;
  onLoadOlderHistory?: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Identity of the session whose transcript `messages` show. Block ids are
   * per-session ordinals, so changing it resets every session-scoped UI state
   * (collapse overrides, pagination keep-open, pending page snapshots, the
   * scroll anchor) — a direct session switch never renders empty messages.
   */
  sessionKey?: string;
  transcriptBlockCount?: number;
  transcriptActivity?: {
    getSnapshot(): {
      lastEventId?: number;
      blocks?: { readonly length: number };
    };
    subscribe(listener: () => void): () => void;
  };
  onReloadTranscript?: (signal: AbortSignal) => Promise<void>;
  transcriptReloadPaused?: boolean;
  /**
   * True while the agent is still answering. The newest turn then stays
   * expanded and un-collapsible so streaming output is never hidden.
   */
  isResponding?: boolean;
  welcomeHeader?: ReactNode;
  centerWelcomeHeader?: boolean;
  workspaceCwd?: string;
  tailContent?: ReactNode;
  tailKey?: string;
  virtualScrollThreshold?: number;
  activeTurnStartedAt?: number;
  /**
   * When true, scroll the tail content into view the moment it first appears
   * even if the user had scrolled up. Opt-in per caller so unrelated inline
   * panels don't yank the reader to the bottom. Defaults to false.
   */
  autoScrollTailIntoView?: boolean;
  /**
   * Height reserved for app-level floating UI below the transcript, such as the
   * bottom todo/status panel. When it changes while the transcript is following
   * the bottom, perform one more bottom alignment after layout settles.
   */
  bottomOverlayInset?: number;
  hideSessionTimeline?: boolean;
  hideFirstUserMessage?: boolean;
  firstTurnMetrics?: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
  includeSubagentToolUsageInMetrics?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
  failedPromptMessageId?: string;
  onRetryFailedPrompt?: () => void;
  onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
  onCanScrollToBottomChange?: (canScrollToBottom: boolean) => void;
  turnFileChanges?: ReadonlyMap<string, readonly TurnOutputFileChange[]>;
  turnArtifacts?: ReadonlyMap<string, readonly DaemonSessionArtifact[]>;
  turnScheduledTasks?: ReadonlyMap<string, readonly TurnOutputScheduledTask[]>;
  onReviewChanges?: (
    changes: readonly TurnOutputFileChange[],
    selectedPath?: string,
  ) => void;
  onOpenArtifact?: (artifactId: string, previewContent?: string) => void;
  onOpenScheduledTask?: (task: TurnOutputScheduledTask) => void;
  onTurnOutputOpen?: (request: TurnOutputOpenRequest) => void;
  onError?: (error: unknown, fallback: string) => void;
  generateContent?: SessionContentGenerator;
}

function isStreamingTailContentOnlyUpdate(
  previous: readonly Message[] | undefined,
  current: readonly Message[],
): boolean {
  if (!previous || previous.length !== current.length || current.length === 0) {
    return false;
  }
  for (let i = 0; i < current.length - 1; i += 1) {
    if (previous[i] !== current[i]) return false;
  }
  const before = previous[previous.length - 1];
  const after = current[current.length - 1];
  if (
    before.id !== after.id ||
    before.role !== after.role ||
    (after.role !== 'assistant' && after.role !== 'thinking') ||
    (before.role !== 'assistant' && before.role !== 'thinking') ||
    before.isStreaming !== true ||
    after.isStreaming !== true
  ) {
    return false;
  }
  if (before.role === 'assistant' && after.role === 'assistant') {
    if (
      typeof before.content !== 'string' ||
      typeof after.content !== 'string'
    ) {
      return false;
    }
    return (
      before.branchRecordId === after.branchRecordId &&
      before.usage === after.usage &&
      Boolean(before.content.trim()) === Boolean(after.content.trim())
    );
  }
  return before.role === 'thinking' && after.role === 'thinking';
}

function sameIdentities(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function getLastUserMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') return msg.id;
  }
  return null;
}

function getLastMessage(messages: Message[]): Message | undefined {
  return messages[messages.length - 1];
}

function getLastTurnStartMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isTurnStartMessage(msg)) return msg.id;
  }
  return null;
}

export type DisplayItem =
  | (Extract<ParallelAgentDisplayItem, { type: 'message' }> & {
      /** Metrics info for the final answer assistant message. */
      turnCollapse?: TurnCollapseHead;
    })
  | Extract<ParallelAgentDisplayItem, { type: 'parallel_agents' }>
  | {
      type: 'turn_collapse';
      key: string;
      turnCollapse: TurnCollapseHead;
    }
  | {
      type: 'turn_outputs';
      key: string;
      turnId: string;
      changes: readonly TurnOutputFileChange[];
      artifacts: readonly DaemonSessionArtifact[];
      scheduledTasks: readonly TurnOutputScheduledTask[];
    };

interface LocateFlashTarget {
  messageId: string;
  callId?: string;
}

export type TurnTimelineNodeKind =
  | 'thought'
  | 'commentary'
  | 'tool'
  | 'agents'
  | 'plan'
  | 'status'
  | 'none';

export interface TurnTimelineNode {
  kind: TurnTimelineNodeKind;
  timestamp?: number;
  label?: string;
}

export interface SessionTimelineEntry {
  id: string;
  label: string;
  detail: string;
  timestamp?: number;
  nodeKinds: TurnTimelineNodeKind[];
  isScheduledTask?: boolean;
}

export interface SessionTimelineRange {
  startIndex: number;
  endIndex: number;
  currentIndex: number;
}

function isAgentOnlyToolGroup(message: Message): boolean {
  return (
    message.role === 'tool_group' &&
    !message.id.startsWith('summary-') &&
    message.tools.length === 1 &&
    isSubAgentToolCall(message.tools[0])
  );
}
function isForceExpandGroup(
  msg: Message,
  pendingApproval: PermissionRequest | null,
): boolean {
  if (msg.role !== 'tool_group') return false;
  if (
    pendingApproval?.toolCallId &&
    msg.tools.some((t) => toolContainsCallId(t, pendingApproval.toolCallId!))
  )
    return true;
  return false;
}

function splitMcpAppToolGroups(messages: Message[]): Message[] {
  const result: Message[] = [];
  let changed = false;

  for (const message of messages) {
    if (
      message.role !== 'tool_group' ||
      message.tools.length < 2 ||
      !message.tools.some((tool) => getMcpAppDisplay(tool.rawOutput))
    ) {
      result.push(message);
      continue;
    }

    changed = true;
    let segment: ACPToolCall[] = [];
    let segmentIndex = 0;
    const pushSegment = (tools: ACPToolCall[]) => {
      if (tools.length === 0) return;
      result.push({
        ...message,
        id:
          segmentIndex++ === 0
            ? message.id
            : `${message.id}-${tools[0]!.callId}`,
        tools,
      });
    };

    for (const tool of message.tools) {
      if (getMcpAppDisplay(tool.rawOutput)) {
        pushSegment(segment);
        segment = [];
        pushSegment([tool]);
      } else {
        segment.push(tool);
      }
    }
    pushSegment(segment);
  }

  return changed ? result : messages;
}

function mergeCompactToolGroups(
  messages: Message[],
  pendingApproval: PermissionRequest | null,
): Message[] {
  const result: Message[] = [];
  let i = 0;

  const isMergedToolGroup = (m: Message): boolean =>
    m.role === 'tool_group' &&
    !isForceExpandGroup(m, pendingApproval) &&
    !m.tools.some((tool) => getMcpAppDisplay(tool.rawOutput));

  while (i < messages.length) {
    const msg = messages[i];
    const isThinking = msg.role === 'thinking';

    if (!isThinking && !isMergedToolGroup(msg)) {
      result.push(msg);
      i++;
      continue;
    }

    // A run of thinking + adjacent tool groups aggregates into one summary,
    // keeping the original interleaved order.
    const run: Message[] = [];
    let lastRunIdx = i - 1;
    let j = i;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role === 'thinking' || isMergedToolGroup(next)) {
        run.push(next);
        lastRunIdx = j;
        j++;
        continue;
      }
      break;
    }

    const tools = run
      .filter((m): m is DaemonToolGroupMessage => m.role === 'tool_group')
      .flatMap((group) => group.tools);
    if (
      tools.length === 0 ||
      run.length <= 1 ||
      (run.length >= 2 && run.every(isAgentOnlyToolGroup))
    ) {
      // A lone thought or tool stays a standalone row: only multi-item runs
      // aggregate into a summary. A parallel-agent-only run keeps its direct
      // x/x row; it nests only when thinking or other tools join the run.
      for (const item of run) result.push(item);
      i = lastRunIdx + 1;
      continue;
    }

    // Each thought remembers the tool that follows it. Consecutive agents may
    // later render as one row anchored at the first agent; launch narration
    // bound to later agents follows that aggregate row.
    const thoughts: Array<{
      content: string;
      isStreaming?: boolean;
      beforeToolCallId?: string;
    }> = [];
    const thoughtsAwaitingTool: Array<(typeof thoughts)[number]> = [];
    for (const item of run) {
      if (item.role === 'thinking') {
        const thought = {
          content: item.content,
          ...(item.isStreaming === true ? { isStreaming: true } : {}),
        };
        thoughts.push(thought);
        thoughtsAwaitingTool.push(thought);
      } else if (item.role === 'tool_group' && item.tools.length > 0) {
        const firstToolCallId = item.tools[0]!.callId;
        for (const thought of thoughtsAwaitingTool) {
          thought.beforeToolCallId = firstToolCallId;
        }
        thoughtsAwaitingTool.length = 0;
      }
    }
    result.push({
      // Synthetic id so the aggregated group never collides with an original
      // message key: React then remounts instead of carrying the expanded
      // summary state into non-compact mode.
      id: summaryRunId(run[0]!.id),
      role: 'tool_group',
      tools,
      ...(thoughts.length > 0 ? { thoughts } : {}),
      timestamp: run[0]!.timestamp,
    });
    i = lastRunIdx + 1;
  }

  return result;
}

function updateCompactStreamingThinkingTail(
  messages: readonly Message[],
  tail: DaemonThinkingMessage,
): Message[] | undefined {
  const group = messages[messages.length - 1];
  if (
    group?.role !== 'tool_group' ||
    summaryRunFirstMemberId(group.id) === undefined ||
    !group.thoughts?.length
  ) {
    return undefined;
  }
  const thought = group.thoughts[group.thoughts.length - 1];
  if (thought?.isStreaming !== true) return undefined;

  const thoughts = group.thoughts.slice();
  thoughts[thoughts.length - 1] = {
    ...thought,
    content: tail.content,
    isStreaming: true,
  };
  const result = messages.slice();
  result[result.length - 1] = {
    ...group,
    thoughts,
    ...(group.id === summaryRunId(tail.id)
      ? { timestamp: tail.timestamp }
      : {}),
  };
  return result;
}

export { groupParallelAgents };

export function getDisplayItemVirtualKey(item: DisplayItem): string {
  if (item.type === 'parallel_agents') return `group:${item.key}`;
  if (item.type === 'turn_outputs') return `outputs:${item.key}`;
  if (item.type === 'turn_collapse') {
    const liveKey = item.turnCollapse.liveStartedAt;
    return liveKey === undefined
      ? `tc:${item.key}`
      : `tc:${item.key}:${liveKey}`;
  }
  return `msg:${item.key}`;
}

export function attachTurnOutputs(
  items: DisplayItem[],
  isResponding: boolean,
  turnFileChanges?: ReadonlyMap<string, readonly TurnOutputFileChange[]>,
  turnArtifacts?: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
  turnScheduledTasks?: ReadonlyMap<string, readonly TurnOutputScheduledTask[]>,
): DisplayItem[] {
  if (
    (!turnFileChanges || turnFileChanges.size === 0) &&
    (!turnArtifacts || turnArtifacts.size === 0) &&
    (!turnScheduledTasks || turnScheduledTasks.size === 0)
  ) {
    return items;
  }

  const result: DisplayItem[] = [];
  let currentTurnId: string | null = null;
  const pushTurnOutputs = (turnId: string | null, isFinalTurn: boolean) => {
    if (isFinalTurn && isResponding) return;
    if (!turnId) return;
    const changes = turnFileChanges?.get(turnId) ?? [];
    const artifacts = turnArtifacts?.get(turnId) ?? [];
    const scheduledTasks = turnScheduledTasks?.get(turnId) ?? [];
    if (
      changes.length === 0 &&
      artifacts.length === 0 &&
      scheduledTasks.length === 0
    ) {
      return;
    }
    result.push({
      type: 'turn_outputs',
      key: turnId,
      turnId,
      changes,
      artifacts,
      scheduledTasks,
    });
  };

  for (const item of items) {
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      pushTurnOutputs(currentTurnId, false);
      currentTurnId = item.message.id;
    } else if (!currentTurnId && item.type === 'message') {
      currentTurnId = item.message.id;
    } else if (!currentTurnId && item.type === 'parallel_agents') {
      currentTurnId = item.turnId;
    }
    result.push(item);
  }
  pushTurnOutputs(currentTurnId, true);
  return result;
}

export function pinActiveParallelAgentsToTurnEnd(
  items: DisplayItem[],
  automaticallyExpandedKeys?: ReadonlySet<string>,
): DisplayItem[] {
  const shouldPin = (item: DisplayItem) =>
    item.type === 'parallel_agents' &&
    (automaticallyExpandedKeys?.has(item.key) === true ||
      item.agents.some((agent) => isActiveToolStatus(agent.status)));
  const hasPinnedGroup = items.some((item) => shouldPin(item));
  if (!hasPinnedGroup) return items;

  const result: DisplayItem[] = [];
  let activeGroups: DisplayItem[] = [];
  const flushActiveGroups = () => {
    result.push(...activeGroups);
    activeGroups = [];
  };

  for (const item of items) {
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      flushActiveGroups();
      result.push(item);
    } else if (shouldPin(item)) {
      activeGroups.push(item);
    } else {
      result.push(item);
    }
  }
  flushActiveGroups();
  return result;
}

export interface ApplyTurnCollapseOptions {
  /**
   * Per-turn user override keyed by the turn's user-message id:
   * `true` = forced expanded, `false` = forced collapsed. Turns absent from the
   * map follow the default (completed turns collapse).
   */
  overrides: ReadonlyMap<string, boolean>;
  /**
   * True while the agent is still answering. The final turn then stays expanded
   * and un-collapsible so live output is never hidden.
   */
  isResponding: boolean;
  activeTurnStartedAt?: number;
  backgroundSummaryGraceActive?: boolean;
  /**
   * Whether the final turn's collapse should keep waiting for unmatched
   * background-agent completions. Pass false once the bounded grace expires
   * so a lost notification cannot pin the turn expanded forever.
   */
  waitForUnmatchedAgentCompletions?: boolean;
  /**
   * Bound the matched-notification ordering wait (final answer already on
   * screen before the completion landed, summary narration still expected).
   * Pass false once the caller's grace window expires so a summary that never
   * arrives cannot pin the turn (and its parallel-agents group) open forever.
   */
  waitForOrderedNarration?: boolean;
  terminalBackgroundShellTaskIds?: ReadonlySet<string>;
  automaticallyExpandedAgentKeys?: ReadonlySet<string>;
  /**
   * Tool-call id of a pending approval, if any. The turn containing it is
   * force-expanded so the inline approve/reject UI is never folded away (mirrors
   * compact mode's `isForceExpandGroup`).
   */
  pendingApprovalCallId?: string | null;
  includeSubagentToolUsageInMetrics?: boolean;
  /**
   * Turns kept expanded despite being complete. Two sources: pagination
   * split-turn detection (the tail was on screen before pagination completed
   * the user prompt), and the anchor fallback (a turn collapsed while a
   * history anchor sat on it). Entries persist until the user toggles the
   * turn or the screen is cleared; an explicit user toggle always wins.
   */
  paginatedExpanded?: ReadonlySet<string>;
  /** Master switch; when false the items pass through untouched. */
  enabled: boolean;
}

function isFinalContentCandidate(
  item: DisplayItem,
  includeBackgroundNotifications: boolean,
): boolean {
  return (
    item.type === 'message' &&
    (item.message.role === 'assistant' ||
      (includeBackgroundNotifications &&
        item.message.role === 'system' &&
        item.message.source === 'background_notification')) &&
    // `content` is typed `string`, but daemon SSE text can be undefined at
    // runtime (transcriptToMessages copies `textBlock.text` through). Guard it:
    // `applyTurnCollapse` runs in render, so a bare `.trim()` would blank the
    // whole transcript.
    !!item.message.content &&
    item.message.content.trim().length > 0
  );
}

function findFinalAnswerIndex(
  items: readonly DisplayItem[],
  start: number,
  end: number,
  includeBackgroundNotifications = true,
): number {
  let lastWorkStepIndex = start;
  for (let i = end; i > start; i--) {
    if (isExecutionWorkStep(items[i]!)) {
      lastWorkStepIndex = i;
      break;
    }
  }
  for (let i = end; i > lastWorkStepIndex; i--) {
    if (isFinalContentCandidate(items[i]!, includeBackgroundNotifications)) {
      return i;
    }
  }
  return -1;
}

function collectFinalAssistantTurnIds(
  items: readonly DisplayItem[],
  {
    isResponding,
    latestTurnAwaitsAgentSummary,
    gateBackgroundAgentStatus,
  }: {
    isResponding: boolean;
    latestTurnAwaitsAgentSummary: boolean;
    gateBackgroundAgentStatus: boolean;
  },
): ReadonlyMap<string, string> {
  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      userIdxs.push(i);
    }
  }

  const turnIdByAssistantId = new Map<string, string>();
  for (let k = 0; k < userIdxs.length; k++) {
    const start = userIdxs[k];
    const end = (k + 1 < userIdxs.length ? userIdxs[k + 1] : items.length) - 1;
    if (
      k === userIdxs.length - 1 &&
      (isResponding ||
        (gateBackgroundAgentStatus && latestTurnAwaitsAgentSummary))
    ) {
      continue;
    }
    // A turn that still owns active background-agent work is not final,
    // whether it is the latest turn or the user has moved on to a newer one.
    if (
      gateBackgroundAgentStatus &&
      turnHasActiveBackgroundAgent(items, start, end)
    ) {
      continue;
    }
    const turnHead = items[start];
    const answerIdx = findFinalAnswerIndex(items, start, end, false);
    if (answerIdx < 0) continue;
    const item = items[answerIdx];
    if (
      turnHead?.type === 'message' &&
      item.type === 'message' &&
      item.message.role === 'assistant'
    ) {
      turnIdByAssistantId.set(item.message.id, turnHead.message.id);
    }
  }
  return turnIdByAssistantId;
}

/**
 * A turn's hideable "steps": tool activity, plans, mid-turn assistant text,
 * and non-final background notifications. The final content and any other
 * system/shell/insight rows (errors, cancellations, command output) are kept
 * visible even when the turn is collapsed.
 */
function isHideableStep(item: DisplayItem, isFinalAnswer: boolean): boolean {
  if (item.type === 'parallel_agents') return true;
  if (item.type === 'turn_outputs') return false;
  if (item.type === 'turn_collapse') return false;
  switch (item.message.role) {
    case 'tool_group':
    case 'plan':
      return true;
    case 'assistant':
      return !isFinalAnswer;
    case 'thinking':
      return true;
    case 'system':
      if (item.message.source === 'background_notification') {
        return !isFinalAnswer;
      }
      return item.message.source === 'vision_bridge_notice';
    case 'user':
    case 'user_shell':
    case 'btw':
    case 'insight_progress':
    case 'insight_ready':
    case 'insight_error':
      return false;
    default: {
      // Compile-time exhaustiveness: a newly added DaemonMessage role fails to
      // assign to `never` here. At runtime (e.g. a newer daemon sending an
      // unknown role) it falls through as not-hideable — kept visible rather
      // than crashing the transcript or vanishing from a collapsed turn.
      const _exhaustive: never = item.message;
      return false;
    }
  }
}

function isMidTurnInjectedDebugMessage(message: { source?: string }): boolean {
  return message.source === 'mid_turn_message_injected';
}

export function getTurnTimelineNode(
  item: DisplayItem,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): TurnTimelineNode {
  if (item.type === 'parallel_agents') {
    return {
      kind: 'agents',
      timestamp: item.timestamp,
      label: t ? t('timeline.parallelAgents') : 'Parallel agents',
    };
  }
  if (item.type === 'turn_outputs') return { kind: 'none' };
  if (item.type !== 'message') return { kind: 'none' };

  const { message } = item;
  switch (message.role) {
    case 'thinking':
      return {
        kind: 'thought',
        timestamp: message.timestamp,
        label: t ? t('timeline.thinking') : 'Thinking',
      };
    case 'assistant':
      if (item.turnCollapse)
        return { kind: 'none', timestamp: message.timestamp };
      if (!compactTimelineText(message.content, 1))
        return { kind: 'none', timestamp: message.timestamp };
      return {
        kind: 'commentary',
        timestamp: message.timestamp,
        label: t ? t('timeline.assistantUpdate') : 'Assistant update',
      };
    case 'tool_group': {
      const count = message.tools.length;
      return {
        kind: 'tool',
        timestamp: message.timestamp,
        label: t
          ? t('timeline.toolCalls', { count })
          : `${count} tool call${count === 1 ? '' : 's'}`,
      };
    }
    case 'plan':
      return {
        kind: 'plan',
        timestamp: message.timestamp,
        label: t ? t('timeline.planUpdate') : 'Plan update',
      };
    case 'system':
      return isMidTurnInjectedDebugMessage(message)
        ? {
            kind: 'status',
            timestamp: message.timestamp,
            label: t ? t('timeline.statusUpdate') : 'Status update',
          }
        : { kind: 'none', timestamp: message.timestamp };
    case 'user':
    case 'user_shell':
    case 'btw':
    case 'insight_progress':
    case 'insight_ready':
    case 'insight_error':
      return { kind: 'none', timestamp: message.timestamp };
    default: {
      const _exhaustive: never = message;
      return { kind: 'none' };
    }
  }
}

function compactTimelineText(
  raw: string | null | undefined,
  maxLength: number,
  options: { stripMarkdown?: boolean } = {},
): string {
  const source =
    options.stripMarkdown === true ? cleanTimelineMarkdown(raw) : (raw ?? '');
  const compact = source.replace(/\s+/g, ' ').trim();
  if (maxLength <= 0) return '';
  if (!compact) return '';
  const chars = Array.from(compact);
  return chars.length > maxLength
    ? `${chars.slice(0, maxLength - 1).join('')}…`
    : compact;
}

function cleanTimelineMarkdown(raw: string | null | undefined): string {
  if (!raw) return '';
  const inlinePlaceholders: string[] = [];
  const stashInline = (value: string) => {
    const key = `\u0000${inlinePlaceholders.length}\u0000`;
    inlinePlaceholders.push(value);
    return key;
  };

  let cleaned = raw
    .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code: string) =>
      stashInline(code),
    )
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, (_match, code: string) => stashInline(code))
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '');

  cleaned = stripBalancedTimelineMarker(cleaned, '~~');
  cleaned = stripBalancedTimelineMarker(cleaned, '**');
  cleaned = stripBalancedTimelineMarker(cleaned, '__');
  cleaned = cleaned
    .replace(/\*([^*\s][^*]*?\S)\*/g, '$1')
    .replace(
      /(^|[^\p{L}\p{N}_])_([^_\s][^_]*?\S)_(?=$|[^\p{L}\p{N}_])/gu,
      '$1$2',
    );

  for (const [index, value] of inlinePlaceholders.entries()) {
    cleaned = cleaned.split(`\u0000${index}\u0000`).join(value);
  }
  return cleaned;
}

function stripBalancedTimelineMarker(raw: string, marker: string): string {
  let result = '';
  let index = 0;
  while (index < raw.length) {
    const start = raw.indexOf(marker, index);
    if (start === -1) return result + raw.slice(index);

    const contentStart = start + marker.length;
    const end = raw.indexOf(marker, contentStart);
    if (end === -1) return result + raw.slice(index);

    const content = raw.slice(contentStart, end);
    result +=
      content.trim().length === 0
        ? raw.slice(index, end + marker.length)
        : raw.slice(index, start) + content;
    index = end + marker.length;
  }
  return result;
}

function timelineLabelForTurn(
  message: Message,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const raw =
    message.role === 'user'
      ? message.content
      : message.role === 'user_shell'
        ? message.command
        : '';
  const compact = compactTimelineText(raw, 32);
  if (!compact) return t ? t('timeline.userTurn') : 'User turn';
  return compact;
}

function isScheduledTaskMessage(message: {
  role: Message['role'];
  source?: string;
}): boolean {
  return (
    message.role === 'user' &&
    (message.source === 'cron' || message.source === 'loop')
  );
}

// Collapse and timeline turns start at chat prompts and shell prompts; new-chat
// auto-follow still uses getLastUserMessageId so shell prompts do not jump.
function isTurnStartMessage(message: Message): boolean {
  return message.role === 'user' || message.role === 'user_shell';
}

// Find the turn head (user message id) owning the message referenced by a
// `msg:` row key, when the message is still present.
function turnIdOfMessageRow(
  messages: Message[],
  rowKey: string,
): string | undefined {
  if (!rowKey.startsWith('msg:')) return undefined;
  let messageId = rowKey.slice('msg:'.length);
  // Compact-aggregate row keys embed the run's first member id. Resolve
  // through it so the key still maps to its turn when looked up in the raw
  // message list, including after a page extending the run re-keyed the
  // aggregate.
  messageId = summaryRunFirstMemberId(messageId) ?? messageId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.id !== messageId) continue;
    for (let j = i; j >= 0; j--) {
      const candidate = messages[j];
      if (candidate && isTurnStartMessage(candidate)) return candidate.id;
    }
    return undefined;
  }
  return undefined;
}

// True when the given turn currently renders as a collapsed turn_collapse row.
function isTurnCollapsedInVisibleItems(
  items: DisplayItem[],
  turnId: string,
): boolean {
  for (const item of items) {
    if (item.type === 'turn_collapse' && item.turnCollapse.turnId === turnId) {
      return item.turnCollapse.collapsed;
    }
  }
  return false;
}

function timelineDetailSnippetForMessage(
  message: Message,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (message.role) {
    case 'thinking':
      // Thinking content may include private model reasoning; keep details label-only.
      return t ? t('timeline.kind.thought') : 'thinking';
    case 'assistant':
      return compactTimelineText(message.content, 120, { stripMarkdown: true });
    case 'tool_group': {
      const count = message.tools.length;
      return t
        ? t('timeline.toolCalls', { count })
        : `${count} tool call${count === 1 ? '' : 's'}`;
    }
    case 'plan':
      return t ? t('timeline.planDetail') : 'plan update';
    case 'system':
      return isMidTurnInjectedDebugMessage(message)
        ? compactTimelineText(message.content, 120, { stripMarkdown: true })
        : '';
    case 'user':
    case 'user_shell':
    case 'btw':
    case 'insight_progress':
    case 'insight_ready':
    case 'insight_error':
      return '';
    default: {
      const _exhaustive: never = message;
      return '';
    }
  }
}

function timelineDetailSnippetForItem(
  item: DisplayItem,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (item.type === 'parallel_agents') {
    const count = item.agents.length;
    return t
      ? t('timeline.parallelAgentsDetail', { count })
      : `${count} parallel agent${count === 1 ? '' : 's'}`;
  }
  if (item.type === 'turn_outputs') return '';
  if (item.type !== 'message') return '';
  return timelineDetailSnippetForMessage(item.message, t);
}

function getKindLabel(
  kind: TurnTimelineNodeKind,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!t) return SESSION_TIMELINE_KIND_LABEL[kind];
  return t(`timeline.kind.${kind}`);
}

function timelineDetailForTurn(
  turnItems: readonly DisplayItem[],
  finalAssistantId: string | null,
  nodeKinds: readonly TurnTimelineNodeKind[],
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (finalAssistantId !== null) {
    for (const item of turnItems) {
      if (item.type !== 'message') continue;
      const { message } = item;
      if (message.id !== finalAssistantId || message.role !== 'assistant') {
        continue;
      }
      const finalAnswerDetail = compactTimelineText(message.content, 180, {
        stripMarkdown: true,
      });
      if (finalAnswerDetail) return finalAnswerDetail;
    }
  }

  const snippets: string[] = [];
  for (let i = 0; i < turnItems.length; i += 1) {
    const item = turnItems[i]!;
    if (
      item.type === 'message' &&
      finalAssistantId !== null &&
      item.message.id === finalAssistantId
    ) {
      continue;
    }
    const snippet = timelineDetailSnippetForItem(item, t);
    if (snippet) snippets.push(snippet);
  }

  const detail = compactTimelineText(snippets.join(' · '), 180);
  if (detail) return detail;
  if (nodeKinds.length > 0) {
    return nodeKinds.map((kind) => getKindLabel(kind, t)).join(' · ');
  }
  return t ? t('timeline.noActivity') : 'No activity';
}

export function getSessionTimelineEntries(
  messages: readonly Message[],
  t?: (key: string, vars?: Record<string, string | number>) => string,
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  let turnStart: Message | null = null;
  let turnItems: Message[] = [];

  const pushTurn = () => {
    if (!turnStart) return;
    const timelineItems = groupParallelAgents(turnItems);
    const finalAssistantIndex = findFinalAnswerIndex(
      timelineItems,
      -1,
      timelineItems.length - 1,
      false,
    );
    const finalAssistantItem =
      finalAssistantIndex >= 0 ? timelineItems[finalAssistantIndex] : null;
    const finalAssistantId =
      finalAssistantItem?.type === 'message' &&
      finalAssistantItem.message.role === 'assistant' &&
      !finalAssistantItem.message.isStreaming &&
      compactTimelineText(finalAssistantItem.message.content, 1, {
        stripMarkdown: true,
      }).length > 0
        ? finalAssistantItem.message.id
        : null;
    const nodeKinds: TurnTimelineNodeKind[] = [];
    for (const item of timelineItems) {
      if (
        item.type === 'message' &&
        finalAssistantId !== null &&
        item.message.id === finalAssistantId
      ) {
        continue;
      }
      const node = getTurnTimelineNode(item, t);
      if (node.kind !== 'none' && !nodeKinds.includes(node.kind)) {
        nodeKinds.push(node.kind);
      }
    }

    entries.push({
      id: turnStart.id,
      label: timelineLabelForTurn(turnStart, t),
      detail: timelineDetailForTurn(
        timelineItems,
        finalAssistantId,
        nodeKinds,
        t,
      ),
      timestamp: turnStart.timestamp,
      nodeKinds,
      ...(isScheduledTaskMessage(turnStart) ? { isScheduledTask: true } : {}),
    });
  };

  for (const message of messages) {
    if (isTurnStartMessage(message)) {
      pushTurn();
      turnStart = message;
      turnItems = [];
      continue;
    }
    if (turnStart) {
      turnItems.push(message);
    }
  }
  pushTurn();

  return entries;
}

function TimelineClockIcon() {
  return (
    <svg
      className={styles.sessionTimelineDetailsIcon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5v4l-2.5 2" />
    </svg>
  );
}

function toolTimelineSignature(tool: ACPToolCall): string {
  const rawOutput =
    tool.rawOutput && typeof tool.rawOutput === 'object'
      ? (tool.rawOutput as Record<string, unknown>)
      : undefined;
  return [
    tool.callId,
    tool.toolName,
    tool.kind ?? '',
    tool.status,
    tool.parentToolCallId ?? '',
    tool.subContent ? 'sub-content' : '',
    tool.subTools?.length ?? 0,
    String(tool.args?.subagent_type ?? ''),
    tool.args?.run_in_background === true ? 'background' : '',
    String(rawOutput?.['type'] ?? ''),
    String(rawOutput?.['status'] ?? ''),
  ].join(':');
}

export function getSessionTimelineSignature(
  messages: readonly Message[],
): string {
  return messages
    .map((message) => {
      const base = `${message.id}:${message.role}:${message.timestamp ?? ''}`;
      switch (message.role) {
        case 'assistant':
        case 'thinking':
          return `${base}:${message.isStreaming ? 'streaming' : message.content}`;
        case 'tool_group':
          return `${base}:${message.tools.map(toolTimelineSignature).join(',')}`;
        case 'system':
          return `${base}:${message.variant}:${message.source ?? ''}:${message.content}`;
        case 'user':
          return `${base}:${message.content}`;
        case 'user_shell':
          return `${base}:${message.command}`;
        case 'plan':
        case 'btw':
        case 'insight_progress':
        case 'insight_ready':
        case 'insight_error':
          return base;
        default: {
          const _exhaustive: never = message;
          return base;
        }
      }
    })
    .join('|');
}

function isExecutionWorkStep(item: DisplayItem): boolean {
  if (item.type === 'parallel_agents') return true;
  if (item.type === 'turn_outputs') return false;
  if (item.type === 'turn_collapse') return false;
  return item.message.role === 'tool_group' || item.message.role === 'plan';
}

function activeExecutionKey(item: DisplayItem): string | null {
  if (item.type === 'turn_outputs') return null;

  if (item.type === 'turn_collapse') {
    if (item.turnCollapse.liveStartedAt === undefined) return null;
    if (
      item.turnCollapse.toolCallCount === undefined ||
      item.turnCollapse.toolCallCount <= 0
    ) {
      return null;
    }
    return `turn:${item.turnCollapse.turnId}:${item.turnCollapse.toolCallCount}`;
  }

  if (item.type === 'parallel_agents') {
    const activeAgents = item.agents.filter((agent) =>
      isActiveToolStatus(agent.status),
    );
    if (activeAgents.length === 0) return null;
    return `agents:${item.key}:${activeAgents.map((agent) => agent.callId).join(',')}`;
  }

  if (item.message.role !== 'tool_group') return null;
  const activeTools = item.message.tools.filter((tool) =>
    isActiveToolStatus(tool.status),
  );
  if (activeTools.length === 0) return null;
  return `tools:${item.message.id}:${activeTools.map((tool) => tool.callId).join(',')}`;
}

function latestActiveExecutionKey(
  items: readonly DisplayItem[],
): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const key = activeExecutionKey(items[i]!);
    if (key) return key;
  }
  return null;
}

function terminalTurnTimestamp(item: DisplayItem): number | undefined {
  if (item.type !== 'message' || item.message.role !== 'system') {
    return undefined;
  }
  return item.message.source === 'prompt_cancelled' ||
    item.message.source === 'turn_error'
    ? item.message.timestamp
    : undefined;
}

function isTurnErrorItem(item: DisplayItem): boolean {
  return (
    item.type === 'message' &&
    item.message.role === 'system' &&
    item.message.source === 'turn_error'
  );
}

function assistantContentTimestamp(item: DisplayItem): number | undefined {
  if (item.type !== 'message' || item.message.role !== 'assistant') {
    return undefined;
  }
  return item.message.content?.trim() ? item.message.timestamp : undefined;
}

/**
 * Main-agent token usage contribution of a row. Subagent usage is carried by
 * the root agent tool's execution summary and is added separately below.
 */
function itemAssistantUsage(item: DisplayItem):
  | {
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    }
  | undefined {
  return item.type === 'message' && item.message.role === 'assistant'
    ? item.message.usage
    : undefined;
}

interface TurnTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function subagentUsage(
  tool: ACPToolCall,
): { callId: string; usage: TurnTokenUsage } | undefined {
  if (tool.parentToolCallId || !isSubAgentToolCall(tool)) return undefined;
  const raw =
    tool.rawOutput && typeof tool.rawOutput === 'object'
      ? (tool.rawOutput as Record<string, unknown>)
      : undefined;
  const summary =
    raw?.['executionSummary'] && typeof raw['executionSummary'] === 'object'
      ? (raw['executionSummary'] as Record<string, unknown>)
      : undefined;
  const inputTokens = finiteTokenCount(summary?.['inputTokens']);
  const outputTokens = finiteTokenCount(summary?.['outputTokens']);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cachedTokens = finiteTokenCount(summary?.['cachedTokens']);
  return {
    callId: tool.callId,
    usage: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    },
  };
}

function itemSubagentUsages(
  item: DisplayItem,
): Array<{ callId: string; usage: TurnTokenUsage }> {
  if (item.type === 'parallel_agents') {
    return item.agents.flatMap((agent) => subagentUsage(agent) ?? []);
  }
  if (item.type !== 'message' || item.message.role !== 'tool_group') return [];
  return item.message.tools.flatMap((tool) => subagentUsage(tool) ?? []);
}

function itemToolCallCount(item: DisplayItem): number {
  if (item.type === 'parallel_agents') return item.agents.length;
  if (item.type === 'turn_outputs') return 0;
  if (item.type === 'turn_collapse') return 0;
  return item.message.role === 'tool_group' ? item.message.tools.length : 0;
}

/**
 * Walk backwards from `index` to the user-message row that heads its turn and
 * return that turn's id, or null when `index` precedes the first turn.
 */
export function findTurnIdForIndex(
  items: readonly DisplayItem[],
  index: number,
): string | null {
  for (let i = Math.min(index, items.length - 1); i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      return item.message.id;
    }
  }
  return null;
}

export function getTurnIdByDisplayIndex(
  items: readonly DisplayItem[],
): Array<string | null> {
  const turnIds: Array<string | null> = [];
  let currentTurnId: string | null = null;
  for (const item of items) {
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      currentTurnId = item.message.id;
    }
    turnIds.push(currentTurnId);
  }
  return turnIds;
}

function timelineIndexForDisplayIndex(
  visibleItems: readonly DisplayItem[],
  index: number,
  entryIndexById: ReadonlyMap<string, number>,
  turnIdByDisplayIndex?: readonly (string | null)[],
): number | null {
  const turnId =
    turnIdByDisplayIndex === undefined
      ? findTurnIdForIndex(visibleItems, index)
      : (turnIdByDisplayIndex[index] ?? null);
  if (!turnId) return null;
  return entryIndexById.get(turnId) ?? null;
}

export function getSessionTimelineRangeForIndexes(
  visibleItems: readonly DisplayItem[],
  visibleItemIndexes: readonly number[],
  entryIndexById: ReadonlyMap<string, number>,
  currentItemIndex?: number | null,
  turnIdByDisplayIndex: readonly (string | null)[] = getTurnIdByDisplayIndex(
    visibleItems,
  ),
): SessionTimelineRange | null {
  let startIndex = Number.POSITIVE_INFINITY;
  let endIndex = -1;

  for (const visibleItemIndex of visibleItemIndexes) {
    if (visibleItemIndex < 0 || visibleItemIndex >= visibleItems.length) {
      continue;
    }
    const timelineIndex = timelineIndexForDisplayIndex(
      visibleItems,
      visibleItemIndex,
      entryIndexById,
      turnIdByDisplayIndex,
    );
    if (timelineIndex === null) continue;
    startIndex = Math.min(startIndex, timelineIndex);
    endIndex = Math.max(endIndex, timelineIndex);
  }

  if (endIndex < 0) return null;

  const currentIndex =
    currentItemIndex === undefined || currentItemIndex === null
      ? null
      : timelineIndexForDisplayIndex(
          visibleItems,
          currentItemIndex,
          entryIndexById,
          turnIdByDisplayIndex,
        );

  return {
    startIndex,
    endIndex,
    currentIndex:
      currentIndex !== null &&
      currentIndex >= startIndex &&
      currentIndex <= endIndex
        ? currentIndex
        : endIndex,
  };
}

/**
 * Fold each completed turn down to its prompt and final answer, hiding the
 * intermediate steps (thinking, tool calls, mid-turn assistant text) behind a
 * toggle attached to the prompt row. A turn spans one user message up to the
 * next; its "final answer" is the last assistant row carrying visible content.
 * The leading user row of every collapsible turn is tagged with a
 * `TurnCollapseHead`; when collapsed, the hidden middle rows are dropped and the
 * final answer's own thinking is stripped so only its purple-prefixed content
 * remains. Returns the original array untouched when disabled or when there is
 * nothing to collapse.
 */
/** Does any tool-carrying row in [start, end] hold a tool matching `pred`? */
function someTurnToolCall(
  items: readonly DisplayItem[],
  start: number,
  end: number,
  pred: (tool: ACPToolCall) => boolean,
): boolean {
  for (let i = start; i <= end; i++) {
    const item = items[i];
    if (item.type === 'parallel_agents') {
      if (item.agents.some(pred)) return true;
    } else if (item.type === 'message' && item.message.role === 'tool_group') {
      if (item.message.tools.some(pred)) return true;
    }
  }
  return false;
}

/** Does any tool group / parallel-agents row in [start, end] own `callId`? */
function turnOwnsCallId(
  items: DisplayItem[],
  start: number,
  end: number,
  callId: string | null | undefined,
): boolean {
  if (!callId) return false;
  return someTurnToolCall(items, start, end, (tool) =>
    toolContainsCallId(tool, callId),
  );
}

function turnHasActiveAgent(
  items: DisplayItem[],
  start: number,
  end: number,
): boolean {
  return someTurnToolCall(
    items,
    start,
    end,
    (tool) => isSubAgentToolCall(tool) && isActiveToolStatus(tool.status),
  );
}

function turnHasMcpApp(
  items: DisplayItem[],
  start: number,
  end: number,
): boolean {
  return someTurnToolCall(
    items,
    start,
    end,
    (tool) => getMcpAppDisplay(tool.rawOutput) !== undefined,
  );
}

function completedBackgroundShellTaskIds(
  items: readonly DisplayItem[],
  terminalTaskIds?: ReadonlySet<string>,
) {
  const taskIds = new Set(terminalTaskIds);
  for (const item of items) {
    if (item.type !== 'message' || item.message.role !== 'system') continue;
    if (item.message.source !== 'background_notification') continue;
    const data = item.message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    if (!('kind' in data) || data.kind !== 'shell') continue;
    // Shell background notifications are terminal-only.
    const taskId = 'taskId' in data ? data.taskId : undefined;
    if (typeof taskId === 'string') taskIds.add(taskId);
  }
  return taskIds;
}

function turnHasPendingBackgroundShell(
  items: readonly DisplayItem[],
  start: number,
  end: number,
  completedTaskIds: ReadonlySet<string>,
): boolean {
  return someTurnToolCall(items, start, end, (tool) => {
    const taskId = backgroundShellTaskId(tool);
    return taskId !== undefined && !completedTaskIds.has(taskId);
  });
}

function turnHasActiveBackgroundAgent(
  items: readonly DisplayItem[],
  start: number,
  end: number,
): boolean {
  return someTurnToolCall(
    items,
    start,
    end,
    (tool) =>
      isBackgroundSubAgentToolCall(tool) && isActiveToolStatus(tool.status),
  );
}

function turnHasAutomaticallyExpandedAgent(
  items: DisplayItem[],
  start: number,
  end: number,
  automaticallyExpandedAgentKeys: ReadonlySet<string> | undefined,
): boolean {
  if (!automaticallyExpandedAgentKeys?.size) return false;
  for (let i = start; i <= end; i++) {
    const item = items[i];
    if (
      item.type === 'parallel_agents' &&
      automaticallyExpandedAgentKeys.has(item.key)
    ) {
      return true;
    }
  }
  return false;
}

function backgroundAgentCallIds(item: DisplayItem): string[] {
  // Launches core rejected (status 'failed') never registered a background
  // task, so no completion notification can ever arrive for them; counting
  // them as awaited would keep the turn open forever.
  if (item.type === 'parallel_agents') {
    return item.agents
      .filter(
        (agent) =>
          isBackgroundSubAgentToolCall(agent) && agent.status !== 'failed',
      )
      .map((agent) => agent.callId);
  }
  if (item.type === 'message' && item.message.role === 'tool_group') {
    return item.message.tools
      .filter(
        (tool) =>
          isBackgroundSubAgentToolCall(tool) && tool.status !== 'failed',
      )
      .map((tool) => tool.callId);
  }
  return [];
}

function backgroundAgentCompletionForMessage(
  message: Message,
): { callId?: string } | null {
  if (
    message.role !== 'system' ||
    message.source !== 'background_notification'
  ) {
    return null;
  }
  const identifiesAgent =
    message.content
      ?.trimStart()
      .toLowerCase()
      .startsWith('background agent ') === true;
  const data = message.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return identifiesAgent ? {} : null;
  }
  const { kind, toolUseId } = data as {
    kind?: unknown;
    toolUseId?: unknown;
  };
  if (kind !== 'agent' && !(kind === undefined && identifiesAgent)) return null;
  return typeof toolUseId === 'string' ? { callId: toolUseId } : {};
}

function backgroundAgentCompletion(
  item: DisplayItem,
): { callId?: string } | null {
  return item.type === 'message'
    ? backgroundAgentCompletionForMessage(item.message)
    : null;
}

interface BackgroundAgentSummaryState {
  lastNotificationIndex: number;
  sawAgentCompletion: boolean;
  unmatchedAgentCallIds: ReadonlySet<string>;
}

// Returns null when nothing in this turn's tail awaits a background summary:
// no notification landed, or a terminal turn status precedes every one.
function backgroundAgentSummaryState(
  items: DisplayItem[],
  start: number,
  end: number,
  agentNotificationsOnly: boolean,
): BackgroundAgentSummaryState | null {
  let lastNotificationIndex = -1;
  let latestNotificationAgentCallId: string | undefined;
  for (let i = end; i > start; i--) {
    const item = items[i];
    if (item.type !== 'message' || item.message.role !== 'system') continue;
    if (
      item.message.source === 'turn_error' ||
      item.message.source === 'prompt_cancelled'
    ) {
      if (lastNotificationIndex < 0) return null;
      continue;
    }
    if (item.message.source === 'background_notification') {
      const completion = backgroundAgentCompletion(item);
      if (agentNotificationsOnly && !completion) continue;
      if (lastNotificationIndex < 0) {
        lastNotificationIndex = i;
        latestNotificationAgentCallId = completion?.callId;
      }
    }
  }
  if (lastNotificationIndex < 0) return null;

  let latestAgentLaunchIndex = -1;
  if (latestNotificationAgentCallId) {
    for (let i = end; i >= 0; i--) {
      if (
        backgroundAgentCallIds(items[i]).includes(latestNotificationAgentCallId)
      ) {
        latestAgentLaunchIndex = i;
        break;
      }
    }
  }
  // A notification can land turns after its launch, so the callId-correlated
  // scan above may cross turns. The anonymous fallback must stay inside this
  // turn: sweeping older turns would let a launch whose notification was lost
  // pin this turn open forever.
  for (let i = end; i >= start; i--) {
    if (latestAgentLaunchIndex >= 0) break;
    if (backgroundAgentCallIds(items[i]).length > 0) {
      latestAgentLaunchIndex = i;
      break;
    }
  }

  const unmatchedAgentCallIds = new Set<string>();
  let sawAgentCompletion = false;
  if (latestAgentLaunchIndex >= 0) {
    let batchStart = latestAgentLaunchIndex;
    for (let i = latestAgentLaunchIndex; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'message' && isTurnStartMessage(item.message)) {
        batchStart = i;
        break;
      }
    }

    const anonymousCompletionCandidates: Array<ReadonlySet<string>> = [];
    for (let i = batchStart; i <= end; i++) {
      const item = items[i];
      for (const callId of backgroundAgentCallIds(item)) {
        unmatchedAgentCallIds.add(callId);
      }
      const completion = backgroundAgentCompletion(item);
      if (!completion) continue;
      sawAgentCompletion = true;
      if (completion.callId) {
        unmatchedAgentCallIds.delete(completion.callId);
      } else {
        anonymousCompletionCandidates.push(new Set(unmatchedAgentCallIds));
      }
    }
    for (const candidates of anonymousCompletionCandidates) {
      for (const callId of candidates) {
        if (!unmatchedAgentCallIds.has(callId)) continue;
        unmatchedAgentCallIds.delete(callId);
        break;
      }
    }
  }
  return { lastNotificationIndex, sawAgentCompletion, unmatchedAgentCallIds };
}

function turnAwaitsBackgroundSummary(
  items: DisplayItem[],
  start: number,
  end: number,
  agentNotificationsOnly = false,
  waitForUnmatchedAgentCompletions = true,
  waitForOrderedNarration = true,
): boolean {
  const state = backgroundAgentSummaryState(
    items,
    start,
    end,
    agentNotificationsOnly,
  );
  if (!state) return false;
  // A lost completion may hold the turn only for the caller's grace window;
  // the ordering rule below is reserved for matched notifications whose
  // summary narration is still expected. It is bounded the same way: when the
  // model already delivered its final answer before the notification and no
  // narration follows within the caller's grace window, the wait releases so
  // the turn (and its parallel-agents group) can collapse.
  if (state.sawAgentCompletion && state.unmatchedAgentCallIds.size > 0) {
    return waitForUnmatchedAgentCompletions;
  }
  for (let i = state.lastNotificationIndex + 1; i <= end; i++) {
    const item = items[i];
    if (item.type === 'message' && item.message.role === 'thinking') {
      return false;
    }
  }
  return (
    waitForOrderedNarration &&
    findFinalAnswerIndex(items, start, end, false) < state.lastNotificationIndex
  );
}

export function applyTurnCollapse(
  items: DisplayItem[],
  {
    overrides,
    isResponding,
    activeTurnStartedAt,
    backgroundSummaryGraceActive = true,
    waitForUnmatchedAgentCompletions = true,
    waitForOrderedNarration = true,
    terminalBackgroundShellTaskIds,
    automaticallyExpandedAgentKeys,
    pendingApprovalCallId,
    includeSubagentToolUsageInMetrics = true,
    paginatedExpanded,
    enabled,
  }: ApplyTurnCollapseOptions,
): DisplayItem[] {
  if (!enabled || items.length === 0) return items;

  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message' && isTurnStartMessage(item.message)) {
      userIdxs.push(i);
    }
  }
  if (userIdxs.length === 0) return items;

  const completedShellTaskIds = completedBackgroundShellTaskIds(
    items,
    terminalBackgroundShellTaskIds,
  );

  const result: DisplayItem[] = [];
  // Anything before the first prompt (e.g. a session-restore banner) is not
  // part of any turn and passes through verbatim.
  for (let i = 0; i < userIdxs[0]; i++) result.push(items[i]);

  for (let k = 0; k < userIdxs.length; k++) {
    const start = userIdxs[k];
    const end = (k + 1 < userIdxs.length ? userIdxs[k + 1] : items.length) - 1;
    const head = items[start] as Extract<DisplayItem, { type: 'message' }>;
    const turnId = head.message.id;
    const promptTs = head.message.timestamp;
    const isLastTurn = k === userIdxs.length - 1;
    const isActiveTurn = isLastTurn && isResponding;
    const hasActiveAgent = turnHasActiveAgent(items, start, end);
    const hasMcpApp = turnHasMcpApp(items, start, end);
    const hasPendingBackgroundShell = turnHasPendingBackgroundShell(
      items,
      start,
      end,
      completedShellTaskIds,
    );
    const hasAutomaticallyExpandedAgent = turnHasAutomaticallyExpandedAgent(
      items,
      start,
      end,
      automaticallyExpandedAgentKeys,
    );
    const awaitsBackgroundSummary =
      isLastTurn &&
      backgroundSummaryGraceActive &&
      turnAwaitsBackgroundSummary(
        items,
        start,
        end,
        false,
        waitForUnmatchedAgentCompletions,
        waitForOrderedNarration,
      );
    const hasPendingApproval = turnOwnsCallId(
      items,
      start,
      end,
      pendingApprovalCallId,
    );

    const answerIdx = findFinalAnswerIndex(items, start, end);
    let hiddenCount = 0;
    let terminalTs: number | undefined;
    let assistantTs: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let toolCallCount = 0;
    let thinkingCount = 0;
    let hasUsage = false;
    const countedSubagents = new Set<string>();
    let hasTurnError = false;
    for (let i = start + 1; i <= end; i++) {
      const item = items[i]!;
      const isStep = isHideableStep(item, i === answerIdx);
      if (isStep) {
        hiddenCount++;
      }
      if (isTurnErrorItem(item)) {
        hasTurnError = true;
      }
      toolCallCount += itemToolCallCount(item);
      if (item.type === 'message' && item.message.role === 'thinking') {
        thinkingCount++;
      } else if (
        item.type === 'message' &&
        item.message.role === 'tool_group' &&
        item.message.thoughts
      ) {
        // Compact mode folds thinking into tool summaries; count it too.
        thinkingCount += item.message.thoughts.length;
      }
      const terminalTimestamp = terminalTurnTimestamp(item);
      if (terminalTimestamp !== undefined) {
        terminalTs =
          terminalTs === undefined
            ? terminalTimestamp
            : Math.max(terminalTs, terminalTimestamp);
      }
      const assistantTimestamp = assistantContentTimestamp(item);
      if (assistantTimestamp !== undefined) {
        assistantTs =
          assistantTs === undefined
            ? assistantTimestamp
            : Math.max(assistantTs, assistantTimestamp);
      }
      const usage = itemAssistantUsage(item);
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cachedTokens += usage.cachedTokens ?? 0;
        hasUsage = true;
      }
      if (includeSubagentToolUsageInMetrics) {
        for (const subagent of itemSubagentUsages(item)) {
          if (countedSubagents.has(subagent.callId)) continue;
          countedSubagents.add(subagent.callId);
          inputTokens += subagent.usage.inputTokens;
          outputTokens += subagent.usage.outputTokens;
          cachedTokens += subagent.usage.cachedTokens ?? 0;
          hasUsage = true;
        }
      }
    }

    const liveStartedAt =
      isActiveTurn || awaitsBackgroundSummary
        ? (activeTurnStartedAt ?? promptTs ?? Date.now())
        : undefined;
    const lastStepTs = terminalTs ?? assistantTs;
    const elapsedMs =
      promptTs !== undefined &&
      lastStepTs !== undefined &&
      lastStepTs >= promptTs
        ? lastStepTs - promptTs
        : undefined;
    const hasMetrics =
      hasUsage || elapsedMs !== undefined || liveStartedAt !== undefined;

    if (hasPendingApproval || (hiddenCount === 0 && !hasMetrics)) {
      // Nothing to add: the inline approve/reject UI must stay reachable, or the
      // turn has neither foldable steps nor a measured metric. Emit it untouched.
      for (let i = start; i <= end; i++) result.push(items[i]);
      continue;
    }

    // A turn with foldable steps gets a chevron and defaults to expanded while
    // streaming, while background work is still active, or when the latest
    // turn is incomplete; otherwise it collapses once a newer turn starts. A
    // step-less turn (e.g. a plain "hi" reply) has nothing to fold, so it stays
    // expanded and shows a chevron-less metrics line. An explicit user toggle
    // always wins; a turn whose tail was shown before pagination finished its
    // head stays open so that content never vanishes mid-read.
    const shouldStayOpen =
      isActiveTurn ||
      hasActiveAgent ||
      hasMcpApp ||
      hasPendingBackgroundShell ||
      hasAutomaticallyExpandedAgent ||
      awaitsBackgroundSummary ||
      ((hasTurnError || answerIdx < 0) && isLastTurn);
    const expanded =
      hiddenCount === 0
        ? true
        : overrides.has(turnId)
          ? (overrides.get(turnId) as boolean)
          : paginatedExpanded?.has(turnId)
            ? true
            : shouldStayOpen;
    const collapsed = !expanded;
    // Push the user message
    result.push({
      type: 'message',
      key: head.key,
      message: head.message,
    });

    // Insert standalone turn_collapse item right after user message
    // This keeps the toggle at the top of the turn regardless of expand state
    const turnCollapseInfo: TurnCollapseHead = {
      turnId,
      collapsed,
      hiddenCount,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(hasUsage ? { inputTokens, outputTokens } : {}),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(toolCallCount > 0 ? { toolCallCount } : {}),
      ...(thinkingCount > 0 ? { thinkingCount } : {}),
      ...(liveStartedAt !== undefined ? { liveStartedAt } : {}),
    };
    result.push({
      type: 'turn_collapse',
      key: `tc-${turnId}`,
      turnCollapse: turnCollapseInfo,
    });

    if (!collapsed) {
      for (let i = start + 1; i <= end; i++) {
        const item = items[i]!;
        // Attach turnCollapse to final answer for metrics display
        if (
          i === answerIdx &&
          item.type === 'message' &&
          item.message.role === 'assistant'
        ) {
          result.push({
            ...item,
            turnCollapse: turnCollapseInfo,
          });
        } else {
          result.push(item);
        }
      }
      continue;
    }

    // Collapsed: omit hideable rows so their DOM and layout work disappear.
    // Keep the final answer and non-step rows (errors, cancellations, command
    // output) in their original places. Expanded rows remain individual
    // virtualizer entries instead of one oversized turn wrapper.
    for (let i = start + 1; i <= end; i++) {
      const item = items[i];
      if (i === answerIdx && isActiveTurn) continue;
      if (
        i === answerIdx &&
        item.type === 'message' &&
        item.message.role === 'assistant'
      ) {
        result.push({
          ...item,
          turnCollapse: turnCollapseInfo,
        });
        continue;
      }
      if (!isHideableStep(item, i === answerIdx)) result.push(item);
    }
  }

  return result;
}

/**
 * Locate a tool by call id when available because compacting or splitting can
 * move it under a different message id. Otherwise locate the message itself.
 */
export function findDisplayItemIndex(
  items: readonly DisplayItem[],
  messageId: string,
  callId?: string,
): number {
  if (callId) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (
        (item.type === 'message' &&
          item.message.role === 'tool_group' &&
          item.message.tools.some((tool) =>
            toolContainsCallId(tool, callId),
          )) ||
        (item.type === 'parallel_agents' &&
          item.agents.some((agent) => toolContainsCallId(agent, callId)))
      ) {
        return i;
      }
    }
    return -1;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message' && item.message.id === messageId) {
      return i;
    }
  }
  return -1;
}

function displayItemMatchesLocateTarget(
  item: DisplayItem,
  target: LocateFlashTarget | null,
): boolean {
  if (!target) return false;
  const callId = target.callId;
  if (item.type === 'message') {
    return callId
      ? item.message.role === 'tool_group' &&
          item.message.tools.some((tool) => toolContainsCallId(tool, callId))
      : item.message.id === target.messageId;
  }
  if (item.type === 'parallel_agents') {
    return (
      !!callId && item.agents.some((agent) => toolContainsCallId(agent, callId))
    );
  }
  if (item.type === 'turn_outputs') return false;
  return false;
}

function displayItemSourceBlockIds(
  item: DisplayItem | undefined,
): string | undefined {
  return item?.type === 'message'
    ? item.message.sourceBlockIds?.join(',')
    : undefined;
}

export interface MessageListHandle {
  /**
   * Scroll the transcript so the given message is visible and briefly
   * highlight it. Returns false when the message is not in the list.
   */
  scrollToMessage: (messageId: string, callId?: string) => boolean;
  /** Resume bottom-follow mode and scroll to the latest output. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

const HEADER_INDEX = 0;
const ESTIMATE_HEADER = 120;
const ESTIMATE_MESSAGE = 80;
const ESTIMATE_TURN_COLLAPSE = 32;
const ESTIMATE_TAIL = 240;
const FOLLOW_BOTTOM_THRESHOLD_PX = 30;
const LOAD_OLDER_HISTORY_THRESHOLD_PX = 160;
const OLDER_HISTORY_ANCHOR_WAIT_FRAMES = 30;
export const VIRTUAL_SCROLL_THRESHOLD = 200;
const SESSION_TIMELINE_MIN_VISIBLE_ENTRIES = 4;

export function shouldUseVirtualScroll(
  totalCount: number,
  threshold = VIRTUAL_SCROLL_THRESHOLD,
): boolean {
  return totalCount > threshold;
}

export function shouldAdjustVirtualScrollPosition(
  itemEnd: number,
  scrollOffset: number,
): boolean {
  return itemEnd <= scrollOffset;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds}s`;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

function durationMetricText(elapsedMs: number | undefined): string {
  return elapsedMs !== undefined && elapsedMs > 0
    ? formatDuration(elapsedMs)
    : '';
}

function tokenMetricText(collapse: TurnCollapseHead, t: Translate): string {
  if (
    collapse.inputTokens === undefined ||
    collapse.outputTokens === undefined
  ) {
    return '';
  }
  const cachedTokens = collapse.cachedTokens ?? 0;
  const cached =
    cachedTokens > 0 && collapse.inputTokens > 0
      ? ` (${formatContextTokens(cachedTokens)} ${t('turn.cached')}, ${Math.round(
          (cachedTokens / collapse.inputTokens) * 100,
        )}%)`
      : '';
  return `↑${formatContextTokens(collapse.inputTokens)}${cached} ↓${formatContextTokens(
    collapse.outputTokens,
  )}`;
}

function turnMetricsText(collapse: TurnCollapseHead, t: Translate): string {
  const parts: string[] = [];
  const tokenMetric = tokenMetricText(collapse, t);
  if (tokenMetric) parts.push(tokenMetric);
  if (collapse.toolCallCount !== undefined && collapse.toolCallCount > 0) {
    parts.push(t('turn.toolCalls', { count: collapse.toolCallCount }));
  }
  if (collapse.thinkingCount !== undefined && collapse.thinkingCount > 0) {
    parts.push(t('turn.thinkingCount', { count: collapse.thinkingCount }));
  }
  return parts.join(' · ');
}

function hasNonDurationMetrics(collapse: TurnCollapseHead): boolean {
  return (
    (collapse.inputTokens !== undefined &&
      collapse.outputTokens !== undefined) ||
    (collapse.toolCallCount !== undefined && collapse.toolCallCount > 0)
  );
}

interface TurnCollapseRowProps {
  turnCollapse: TurnCollapseHead;
  onToggleCollapse: (turnId: string, nextExpanded: boolean) => void;
}

const TurnCollapseRow = memo(function TurnCollapseRow({
  turnCollapse,
  onToggleCollapse,
}: TurnCollapseRowProps) {
  const { t } = useI18n();
  const hasToggle = turnCollapse.hiddenCount > 0;
  const liveStartedAt = turnCollapse.liveStartedAt;
  const showMetadataRow =
    hasToggle ||
    liveStartedAt !== undefined ||
    hasNonDurationMetrics(turnCollapse);

  const now = useSharedNow(liveStartedAt !== undefined && showMetadataRow);
  const elapsedSeenRef = useRef(0);
  const previousLiveStartedAtRef = useRef<number | undefined>(liveStartedAt);
  if (previousLiveStartedAtRef.current !== liveStartedAt) {
    previousLiveStartedAtRef.current = liveStartedAt;
    elapsedSeenRef.current = 0;
  }
  let displayElapsedMs: number | undefined;
  if (liveStartedAt !== undefined && showMetadataRow) {
    elapsedSeenRef.current = Math.max(
      elapsedSeenRef.current,
      Math.max(0, now - liveStartedAt),
    );
    displayElapsedMs = elapsedSeenRef.current;
  } else if (showMetadataRow && turnCollapse.elapsedMs !== undefined) {
    elapsedSeenRef.current = 0;
    displayElapsedMs = turnCollapse.elapsedMs;
  } else {
    elapsedSeenRef.current = 0;
    displayElapsedMs = undefined;
  }

  const visibleMetrics = durationMetricText(displayElapsedMs);
  const hiddenMetrics = turnMetricsText(turnCollapse, t);
  const summaryMetrics = turnMetricsText(turnCollapse, t);
  const statusLabel =
    liveStartedAt !== undefined ? t('turn.processing') : t('turn.processed');
  const showVisibleMetrics = !!visibleMetrics && showMetadataRow;
  const showHiddenMetrics = !!hiddenMetrics && showMetadataRow;
  const showSummaryMetrics = !!summaryMetrics && showMetadataRow;

  if (!showMetadataRow) return null;
  const toggleExpanded = () => {
    if (!hasToggle) return;
    const nextExpanded = turnCollapse.collapsed;
    onToggleCollapse(turnCollapse.turnId, nextExpanded);
  };

  return (
    <div
      className={
        hasToggle
          ? `${turnCollapseStyles.collapseRow} ${turnCollapseStyles.collapseRowClickable}`
          : turnCollapseStyles.collapseRow
      }
      role={hasToggle ? 'button' : undefined}
      tabIndex={hasToggle ? 0 : undefined}
      aria-expanded={hasToggle ? !turnCollapse.collapsed : undefined}
      aria-label={
        hasToggle
          ? turnCollapse.collapsed
            ? t('turn.expand')
            : t('turn.collapse')
          : undefined
      }
      title={
        hasToggle
          ? turnCollapse.collapsed
            ? t('turn.expand')
            : t('turn.collapse')
          : undefined
      }
      onClick={hasToggle ? toggleExpanded : undefined}
      onKeyDown={
        hasToggle
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              toggleExpanded();
            }
          : undefined
      }
    >
      <span className={turnCollapseStyles.collapseLabel}>
        <span className={turnCollapseStyles.processedLabel}>
          {statusLabel}
          {showVisibleMetrics && (
            <span className={turnCollapseStyles.processedMeta}>
              {' '}
              {visibleMetrics}
            </span>
          )}
        </span>
        {showSummaryMetrics && (
          <span className={turnCollapseStyles.summaryMetrics}>
            {summaryMetrics}
          </span>
        )}
        {showHiddenMetrics && (
          <span className={turnCollapseStyles.hiddenMetrics}>
            {hiddenMetrics}
          </span>
        )}
      </span>
      {hasToggle && (
        <span
          data-testid={`toggle-${turnCollapse.turnId}`}
          className={turnCollapseStyles.collapseIcon}
          onClick={(event) => {
            event.stopPropagation();
            toggleExpanded();
          }}
        >
          <span
            className={
              turnCollapse.collapsed
                ? turnCollapseStyles.chevronRight
                : turnCollapseStyles.chevronDown
            }
            aria-hidden="true"
          />
        </span>
      )}
    </div>
  );
});

function getChatRowClassName(item: DisplayItem): string | undefined {
  if (item.type === 'turn_collapse') return styles.turnStatusRow;
  if (item.type === 'turn_outputs') return styles.turnContentRow;
  if (item.type !== 'message') return undefined;
  if (item.turnCollapse) return styles.turnAnswerRow;
  return undefined;
}

const SESSION_TIMELINE_KIND_LABEL: Record<TurnTimelineNodeKind, string> = {
  thought: 'thinking',
  commentary: 'assistant update',
  tool: 'tool calls',
  agents: 'parallel agents',
  plan: 'plan update',
  status: 'status update',
  none: 'turn',
};

type SessionTimelineTooltip = {
  entry: SessionTimelineEntry;
  top: number;
  left: number;
  clamped: boolean;
  themeVars: CSSProperties;
};

const SESSION_TIMELINE_TOOLTIP_THEME_VARS = [
  '--background',
  '--foreground',
  '--muted-foreground',
  '--border',
  '--font-sans',
];

const SESSION_TIMELINE_TOOLTIP_ID = 'session-timeline-detail-tooltip';

const SessionTimeline = memo(function SessionTimeline({
  entries,
  currentTurnId,
  currentRange,
  hidden,
  onSelect,
}: {
  entries: readonly SessionTimelineEntry[];
  currentTurnId: string | null;
  currentRange: SessionTimelineRange | null;
  hidden: boolean;
  onSelect: (turnId: string) => void;
}) {
  const portalRoot = useWebShellPortalRoot();
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const focusScrollGuardRef = useRef(false);
  const focusScrollGuardFrameRef = useRef<number | null>(null);
  const focusScrollGuardFallbackRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<SessionTimelineTooltip | null>(null);

  const currentIndex =
    currentRange !== null
      ? currentRange.currentIndex
      : entries.findIndex((entry) => entry.id === currentTurnId);

  const hideTooltip = useCallback(() => setTooltip(null), []);

  const handleViewportScroll = useCallback(() => {
    if (programmaticScrollRef.current || focusScrollGuardRef.current) return;
    hideTooltip();
  }, [hideTooltip]);

  const buildTooltip = useCallback(
    (entry: SessionTimelineEntry, el: HTMLElement) => {
      const panel = panelRef.current;
      if (!panel) return null;
      const computedStyle = getComputedStyle(panel);
      const rect = el.getBoundingClientRect();
      return {
        entry,
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
        clamped: false,
        themeVars: Object.fromEntries(
          SESSION_TIMELINE_TOOLTIP_THEME_VARS.map((name) => [
            name,
            computedStyle.getPropertyValue(name),
          ]),
        ) as CSSProperties,
      };
    },
    [],
  );

  const findTooltipAnchor = useCallback((entry: SessionTimelineEntry) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const item = Array.from(
      viewport.querySelectorAll<HTMLElement>(
        '[data-testid="session-timeline-entry"]',
      ),
    ).find((node) => node.getAttribute('data-turn-id') === entry.id);
    return item?.querySelector<HTMLButtonElement>('button') ?? null;
  }, []);

  const isTooltipAnchorVisible = useCallback((anchor: HTMLElement) => {
    const viewport = viewportRef.current;
    if (!viewport) return false;
    const viewportRect = viewport.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    return (
      anchorRect.bottom >= viewportRect.top &&
      anchorRect.top <= viewportRect.bottom
    );
  }, []);

  const syncTooltip = useCallback(() => {
    setTooltip((current) => {
      if (!current) return null;
      const anchor = findTooltipAnchor(current.entry);
      if (!anchor || !isTooltipAnchorVisible(anchor)) return null;
      return buildTooltip(current.entry, anchor);
    });
  }, [buildTooltip, findTooltipAnchor, isTooltipAnchorVisible]);

  const showTooltip = useCallback(
    (entry: SessionTimelineEntry, el: HTMLElement) => {
      setTooltip(buildTooltip(entry, el));
    },
    [buildTooltip],
  );

  const guardFocusScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (focusScrollGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(focusScrollGuardFrameRef.current);
    }
    if (focusScrollGuardFallbackRef.current !== null) {
      window.clearTimeout(focusScrollGuardFallbackRef.current);
    }
    focusScrollGuardRef.current = true;
    focusScrollGuardFrameRef.current = window.requestAnimationFrame(() => {
      focusScrollGuardFrameRef.current = null;
      focusScrollGuardRef.current = false;
      syncTooltip();
    });
    focusScrollGuardFallbackRef.current = window.setTimeout(() => {
      focusScrollGuardFallbackRef.current = null;
      focusScrollGuardRef.current = false;
    }, 100);
  }, [syncTooltip]);

  useLayoutEffect(() => {
    if (hidden) return;
    const viewport = viewportRef.current;
    if (!viewport || currentIndex < 0) return;
    const item = viewport.querySelector<HTMLElement>(
      `[data-timeline-index="${currentIndex}"]`,
    );
    if (!item) return;
    const itemCenter = item.offsetTop + item.offsetHeight / 2;
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const nextScrollTop = Math.max(
      0,
      Math.min(itemCenter - viewport.clientHeight / 2, maxScrollTop),
    );
    if (viewport.scrollTop === nextScrollTop) return;
    programmaticScrollRef.current = true;
    viewport.scrollTop = nextScrollTop;
    const frame = window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      syncTooltip();
    });
    const fallback = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 100);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
      programmaticScrollRef.current = false;
    };
  }, [currentIndex, hidden, syncTooltip]);

  useLayoutEffect(() => {
    if (!tooltip || typeof window === 'undefined') return;
    window.addEventListener('resize', syncTooltip);
    return () => {
      window.removeEventListener('resize', syncTooltip);
    };
  }, [syncTooltip, tooltip]);

  useLayoutEffect(
    () => () => {
      if (focusScrollGuardFrameRef.current !== null) {
        window.cancelAnimationFrame(focusScrollGuardFrameRef.current);
      }
      if (focusScrollGuardFallbackRef.current !== null) {
        window.clearTimeout(focusScrollGuardFallbackRef.current);
      }
      focusScrollGuardRef.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!tooltip || tooltip.clamped) return;
    const panel = panelRef.current;
    const tooltipEl = tooltipRef.current;
    if (!panel || !tooltipEl || typeof window === 'undefined') return;
    const rect = tooltipEl.getBoundingClientRect();
    const margin = 12;
    let nextTop = tooltip.top;
    if (rect.top < margin) {
      nextTop += margin - rect.top;
    } else if (rect.bottom > window.innerHeight - margin) {
      nextTop -= rect.bottom - (window.innerHeight - margin);
    }
    if (nextTop === tooltip.top) return;
    setTooltip((current) =>
      current?.entry.id === tooltip.entry.id
        ? { ...current, top: nextTop, clamped: true }
        : current,
    );
  }, [tooltip]);

  if (hidden || entries.length === 0) return null;

  return (
    <div className={styles.sessionTimelineLayer} aria-hidden="false">
      <nav
        ref={panelRef}
        className={styles.sessionTimelinePanel}
        aria-label={t('timeline.sessionTimeline')}
        data-testid="session-timeline"
        onMouseLeave={hideTooltip}
      >
        <div
          ref={viewportRef}
          className={styles.sessionTimelineViewport}
          data-testid="session-timeline-viewport"
          onScroll={handleViewportScroll}
        >
          <ol className={styles.sessionTimelineList}>
            {entries.map((entry, index) => {
              const isInCurrentRange =
                currentRange !== null &&
                index >= currentRange.startIndex &&
                index <= currentRange.endIndex;
              const isCurrent =
                currentRange !== null
                  ? index === currentRange.currentIndex
                  : entry.id === currentTurnId;
              const nodeKinds = entry.nodeKinds.join(',');
              const ariaLabel = [
                `${t('timeline.turnPrefix', { index: index + 1 })}: ${entry.label}`,
                isCurrent ? t('timeline.currentTurn') : null,
              ]
                .filter(Boolean)
                .join('. ');
              const revealTooltip = (
                event:
                  | ReactMouseEvent<HTMLButtonElement>
                  | ReactFocusEvent<HTMLButtonElement>,
              ) => showTooltip(entry, event.currentTarget);
              const revealFocusedTooltip = (
                event: ReactFocusEvent<HTMLButtonElement>,
              ) => {
                guardFocusScroll();
                showTooltip(entry, event.currentTarget);
              };
              const describedByTooltip = tooltip?.entry.id === entry.id;
              return (
                <li
                  key={entry.id}
                  className={styles.sessionTimelineItem}
                  data-testid="session-timeline-entry"
                  data-turn-id={entry.id}
                  data-timeline-index={index}
                  data-node-kinds={nodeKinds}
                  data-in-current-range={isInCurrentRange ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className={joinClassNames(
                      styles.sessionTimelineButton,
                      isInCurrentRange
                        ? styles.sessionTimelineButtonInRange
                        : undefined,
                      isCurrent
                        ? styles.sessionTimelineButtonCurrent
                        : undefined,
                    )}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-describedby={
                      describedByTooltip
                        ? SESSION_TIMELINE_TOOLTIP_ID
                        : undefined
                    }
                    aria-label={ariaLabel}
                    onClick={() => onSelect(entry.id)}
                    onFocus={revealFocusedTooltip}
                    onBlur={hideTooltip}
                    onMouseEnter={revealTooltip}
                    onMouseLeave={hideTooltip}
                  >
                    <span className={styles.sessionTimelineTick} />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        {tooltip &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={tooltipRef}
              className={styles.sessionTimelineDetails}
              id={SESSION_TIMELINE_TOOLTIP_ID}
              data-testid="session-timeline-detail"
              data-title={tooltip.entry.label}
              data-detail={tooltip.entry.detail}
              data-scheduled-task={
                tooltip.entry.isScheduledTask ? 'true' : undefined
              }
              role="tooltip"
              style={{
                ...tooltip.themeVars,
                top: tooltip.top,
                left: tooltip.left,
              }}
            >
              <span className={styles.sessionTimelineDetailsTitle}>
                {tooltip.entry.isScheduledTask && <TimelineClockIcon />}
                <span className={styles.sessionTimelineDetailsTitleText}>
                  {tooltip.entry.label}
                </span>
              </span>
              <span className={styles.sessionTimelineDetailsDetail}>
                {tooltip.entry.detail}
              </span>
            </div>,
            portalRoot ?? document.body,
          )}
      </nav>
    </div>
  );
});

function joinClassNames(
  ...classNames: Array<string | undefined>
): string | undefined {
  const result = classNames.filter(Boolean).join(' ');
  return result || undefined;
}

const EMPTY_SESSION_TIMELINE_ENTRIES: SessionTimelineEntry[] = [];

function LoadingTranscriptSkeleton({ label }: { label: string }) {
  return (
    <>
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {label}
      </div>
      <div
        className={styles.loadingSkeleton}
        data-testid="message-list-loading-skeleton"
        aria-hidden="true"
      >
        <div className={styles.loadingSkeletonUserRow}>
          <div className={styles.loadingSkeletonUserBubble}>
            <span className={styles.loadingSkeletonLineWide} />
            <span className={styles.loadingSkeletonLineShort} />
          </div>
        </div>
        <div className={styles.loadingSkeletonAssistantRow}>
          <div className={styles.loadingSkeletonAssistantBlock}>
            <span className={styles.loadingSkeletonLineMedium} />
            <span className={styles.loadingSkeletonLineWide} />
            <span className={styles.loadingSkeletonLineNarrow} />
          </div>
        </div>
        <div className={styles.loadingSkeletonUserRow}>
          <div className={styles.loadingSkeletonUserBubbleCompact}>
            <span className={styles.loadingSkeletonLineMedium} />
          </div>
        </div>
        <div className={styles.loadingSkeletonAssistantRow}>
          <div className={styles.loadingSkeletonAssistantBlock}>
            <span className={styles.loadingSkeletonLineWide} />
            <span className={styles.loadingSkeletonLineMedium} />
          </div>
        </div>
      </div>
    </>
  );
}

export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    {
      messages,
      sessionKey,
      terminalBackgroundShellTaskIds,
      pendingApproval,
      onShowContextDetail,
      onImagePreview,
      onAttachmentPreview,
      loadingTranscript,
      catchingUp,
      hasOlderHistory = false,
      loadingOlderHistory = false,
      historyCapacityReached = false,
      historyPaginationError = false,
      onLoadOlderHistory,
      transcriptBlockCount = 0,
      transcriptActivity,
      onReloadTranscript,
      isResponding = false,
      transcriptReloadPaused = isResponding,
      activeTurnStartedAt,
      welcomeHeader,
      centerWelcomeHeader = false,
      workspaceCwd,
      tailContent,
      tailKey = 'tail',
      virtualScrollThreshold = VIRTUAL_SCROLL_THRESHOLD,
      autoScrollTailIntoView = false,
      bottomOverlayInset = 0,
      hideSessionTimeline = false,
      hideFirstUserMessage = false,
      firstTurnMetrics,
      includeSubagentToolUsageInMetrics = true,
      showRetryHint = false,
      onRetryClick,
      failedPromptMessageId,
      onRetryFailedPrompt,
      onBranchSession,
      onCanScrollToBottomChange,
      turnFileChanges,
      turnArtifacts,
      turnScheduledTasks,
      onReviewChanges,
      onOpenArtifact,
      onOpenScheduledTask,
      onTurnOutputOpen,
      onError,
      generateContent,
    },
    ref,
  ) {
    const { t } = useI18n();
    const transcriptRenderMode = useTranscriptRenderMode();
    const compactMode = useContext(CompactModeContext);
    // Render-phase caches below are reusable only against this post-commit
    // identity. An abandoned render cannot advance it, so its cache writes are
    // rejected by the next committed render.
    const previousMessagesRef = useRef<Message[] | undefined>(undefined);
    const streamingTailContentOnly = isStreamingTailContentOnlyUpdate(
      previousMessagesRef.current,
      messages,
    );
    useLayoutEffect(() => {
      previousMessagesRef.current = messages;
    }, [messages]);
    const mergedMessagesCache = useRef<
      | {
          sourceMessages: readonly Message[];
          compactMode: boolean;
          pendingApproval: PermissionRequest | null;
          value: Message[];
        }
      | undefined
    >(undefined);
    const mergedMessages = useMemo(() => {
      const cached = mergedMessagesCache.current;
      const tail = messages[messages.length - 1];
      let value: Message[] | undefined;
      if (
        streamingTailContentOnly &&
        cached?.sourceMessages === previousMessagesRef.current &&
        cached?.compactMode === compactMode &&
        cached.pendingApproval === pendingApproval
      ) {
        if (
          tail?.role === 'assistant' &&
          cached.value[cached.value.length - 1]?.id === tail.id
        ) {
          value = cached.value.slice();
          value[value.length - 1] = tail;
        } else if (tail?.role === 'thinking') {
          value = compactMode
            ? updateCompactStreamingThinkingTail(cached.value, tail)
            : splitMcpAppToolGroups(messages);
        }
      }
      if (!value) {
        const standaloneMcpApps = splitMcpAppToolGroups(messages);
        value = compactMode
          ? mergeCompactToolGroups(standaloneMcpApps, pendingApproval)
          : standaloneMcpApps;
      }
      mergedMessagesCache.current = {
        sourceMessages: messages,
        compactMode,
        pendingApproval,
        value,
      };
      return value;
    }, [compactMode, messages, pendingApproval, streamingTailContentOnly]);
    const displayItemsCache = useRef<
      | {
          sourceMessages: readonly Message[];
          compactMode: boolean;
          pendingApproval: PermissionRequest | null;
          isResponding: boolean;
          turnFileChanges?: ReadonlyMap<
            string,
            readonly TurnOutputFileChange[]
          >;
          turnArtifacts?: ReadonlyMap<string, readonly DaemonSessionArtifact[]>;
          turnScheduledTasks?: ReadonlyMap<
            string,
            readonly TurnOutputScheduledTask[]
          >;
          value: DisplayItem[];
        }
      | undefined
    >(undefined);
    const displayItems = useMemo(() => {
      const cached = displayItemsCache.current;
      const tail = mergedMessages[mergedMessages.length - 1];
      let value: DisplayItem[] | undefined;
      if (
        streamingTailContentOnly &&
        isResponding &&
        cached?.sourceMessages === previousMessagesRef.current &&
        cached?.compactMode === compactMode &&
        cached.pendingApproval === pendingApproval &&
        cached.isResponding === isResponding &&
        cached.turnFileChanges === turnFileChanges &&
        cached.turnArtifacts === turnArtifacts &&
        cached.turnScheduledTasks === turnScheduledTasks
      ) {
        const previousTail = cached.value[cached.value.length - 1];
        if (
          previousTail?.type === 'message' &&
          previousTail.message.id === tail.id
        ) {
          value = cached.value.slice();
          value[value.length - 1] = {
            ...previousTail,
            message: tail,
          };
        }
      }
      value ??= attachTurnOutputs(
        groupParallelAgents(mergedMessages),
        isResponding,
        turnFileChanges,
        turnArtifacts,
        turnScheduledTasks,
      );
      displayItemsCache.current = {
        sourceMessages: messages,
        compactMode,
        pendingApproval,
        isResponding,
        turnFileChanges,
        turnArtifacts,
        turnScheduledTasks,
        value,
      };
      return value;
    }, [
      mergedMessages,
      messages,
      streamingTailContentOnly,
      compactMode,
      pendingApproval,
      isResponding,
      turnFileChanges,
      turnArtifacts,
      turnScheduledTasks,
    ]);
    const latestBackgroundNotificationId = useMemo(() => {
      for (let i = mergedMessages.length - 1; i >= 0; i -= 1) {
        const message = mergedMessages[i];
        if (
          message?.role === 'system' &&
          message.source === 'background_notification'
        ) {
          return message.id;
        }
      }
      return null;
    }, [mergedMessages]);
    const [
      backgroundNotificationBaselineId,
      setBackgroundNotificationBaselineId,
    ] = useState<string | null>(latestBackgroundNotificationId);
    const loadingBackgroundNotificationHistory = Boolean(
      loadingTranscript || catchingUp,
    );
    const wasLoadingBackgroundNotificationHistory = useRef(
      loadingBackgroundNotificationHistory,
    );
    const hasEstablishedBackgroundNotificationBaseline = useRef(
      mergedMessages.length > 0,
    );
    const firstMessageBatchEstablishesBackgroundNotificationBaseline =
      !hasEstablishedBackgroundNotificationBaseline.current &&
      mergedMessages.length > 0;
    const establishingBackgroundNotificationBaseline =
      loadingBackgroundNotificationHistory ||
      wasLoadingBackgroundNotificationHistory.current ||
      firstMessageBatchEstablishesBackgroundNotificationBaseline;
    useLayoutEffect(() => {
      if (establishingBackgroundNotificationBaseline) {
        setBackgroundNotificationBaselineId(latestBackgroundNotificationId);
      }
      if (mergedMessages.length > 0) {
        hasEstablishedBackgroundNotificationBaseline.current = true;
      }
      wasLoadingBackgroundNotificationHistory.current =
        loadingBackgroundNotificationHistory;
    }, [
      establishingBackgroundNotificationBaseline,
      latestBackgroundNotificationId,
      loadingBackgroundNotificationHistory,
      mergedMessages.length,
    ]);
    const backgroundSummaryGraceActive =
      !establishingBackgroundNotificationBaseline &&
      latestBackgroundNotificationId !== null &&
      backgroundNotificationBaselineId !== latestBackgroundNotificationId;
    const latestTurnStartIndex = useMemo(() => {
      for (let i = displayItems.length - 1; i >= 0; i -= 1) {
        const item = displayItems[i];
        if (item.type === 'message' && isTurnStartMessage(item.message)) {
          return i;
        }
      }
      return 0;
    }, [displayItems]);
    // Forced-'pending' background-agent statuses only mean "live work" where
    // reconciliation can classify them; a static transcript has no live state,
    // so a stale card there must not suppress the final footer.
    const gateBackgroundAgentStatus = transcriptRenderMode === 'interactive';
    const latestTurnHasActiveBackgroundAgent = useMemo(
      () =>
        gateBackgroundAgentStatus &&
        turnHasActiveBackgroundAgent(
          displayItems,
          latestTurnStartIndex,
          displayItems.length - 1,
        ),
      [displayItems, gateBackgroundAgentStatus, latestTurnStartIndex],
    );
    const latestTurnBackgroundSummaryState = useMemo(
      () =>
        backgroundAgentSummaryState(
          displayItems,
          latestTurnStartIndex,
          displayItems.length - 1,
          true,
        ),
      [displayItems, latestTurnStartIndex],
    );
    // The grace reset/timer keys on the unmatched set, not the raw
    // notification id: a notification that cannot change which agents are
    // unmatched — an earlier-turn agent completing, or any monitor/shell-task
    // notification — must neither restart the bound nor re-arm an expired one.
    const latestTurnUnmatchedAgentKey = useMemo(() => {
      const callIds = latestTurnBackgroundSummaryState?.unmatchedAgentCallIds;
      return callIds && callIds.size > 0 ? [...callIds].sort().join('|') : '';
    }, [latestTurnBackgroundSummaryState]);
    const latestTurnHoldsUnmatchedAgentCompletion =
      backgroundSummaryGraceActive &&
      !latestTurnHasActiveBackgroundAgent &&
      (latestTurnBackgroundSummaryState?.sawAgentCompletion ?? false) &&
      (latestTurnBackgroundSummaryState?.unmatchedAgentCallIds.size ?? 0) > 0;
    const [
      unmatchedCompletionGraceExpired,
      setUnmatchedCompletionGraceExpired,
    ] = useState(false);
    // Re-arm the latch only when the episode changes: the unmatched set or
    // the turn itself changed, or streaming ended and the hold can gate the
    // footer again. A benign matched-notification hold never consumes the
    // latch because the timer below only runs for unmatched completions.
    useEffect(() => {
      setUnmatchedCompletionGraceExpired(false);
    }, [latestTurnUnmatchedAgentKey, latestTurnStartIndex, isResponding]);
    useEffect(() => {
      // isResponding hides the turn anyway, so the grace must not be
      // consumed while streaming; the full window starts when the hold can
      // actually gate the final footer.
      if (!latestTurnHoldsUnmatchedAgentCompletion || isResponding) return;
      const timer = setTimeout(
        () => setUnmatchedCompletionGraceExpired(true),
        UNMATCHED_AGENT_COMPLETION_GRACE_MS,
      );
      return () => clearTimeout(timer);
    }, [
      latestTurnHoldsUnmatchedAgentCompletion,
      latestTurnUnmatchedAgentKey,
      latestTurnStartIndex,
      isResponding,
    ]);
    // The ordering rule (the final answer already on screen before a matched
    // completion notification, summary narration still expected) has no
    // natural expiry: a model that finished before its background agents
    // reconciled would pin the turn — and its parallel-agents group — open
    // forever. Bound it with the same grace window as unmatched completions.
    const latestTurnHoldsOrderedSummary = useMemo(
      () =>
        backgroundSummaryGraceActive &&
        !latestTurnHasActiveBackgroundAgent &&
        !isResponding &&
        (latestTurnBackgroundSummaryState?.sawAgentCompletion ?? false) &&
        (latestTurnBackgroundSummaryState?.unmatchedAgentCallIds.size ?? 0) ===
          0 &&
        turnAwaitsBackgroundSummary(
          displayItems,
          latestTurnStartIndex,
          displayItems.length - 1,
          true,
          true,
          true,
        ),
      [
        backgroundSummaryGraceActive,
        displayItems,
        isResponding,
        latestTurnBackgroundSummaryState,
        latestTurnHasActiveBackgroundAgent,
        latestTurnStartIndex,
      ],
    );
    const [orderedSummaryGraceExpired, setOrderedSummaryGraceExpired] =
      useState(false);
    // Key the grace on the latest turn's own agent-completion notification,
    // not the global latest background notification: a monitor/shell-task
    // banner landing mid-wait must neither restart the bound nor re-arm an
    // expired one (the same rule the unmatched latch follows), or an active
    // background task could pin the waiting turn open indefinitely.
    const latestTurnOrderedNotificationId = useMemo(() => {
      const state = latestTurnBackgroundSummaryState;
      if (!state || state.lastNotificationIndex < 0) return '';
      const item = displayItems[state.lastNotificationIndex];
      return item?.type === 'message' ? item.message.id : '';
    }, [displayItems, latestTurnBackgroundSummaryState]);
    useEffect(() => {
      setOrderedSummaryGraceExpired(false);
    }, [latestTurnOrderedNotificationId, latestTurnStartIndex, isResponding]);
    useEffect(() => {
      if (!latestTurnHoldsOrderedSummary) return;
      const timer = setTimeout(
        () => setOrderedSummaryGraceExpired(true),
        UNMATCHED_AGENT_COMPLETION_GRACE_MS,
      );
      return () => clearTimeout(timer);
    }, [
      latestTurnHoldsOrderedSummary,
      latestTurnOrderedNotificationId,
      latestTurnStartIndex,
      isResponding,
    ]);
    const latestTurnAwaitsAgentSummary = useMemo(
      () =>
        backgroundSummaryGraceActive &&
        turnAwaitsBackgroundSummary(
          displayItems,
          latestTurnStartIndex,
          displayItems.length - 1,
          true,
          latestTurnHasActiveBackgroundAgent ||
            !unmatchedCompletionGraceExpired,
          !orderedSummaryGraceExpired,
        ),
      [
        backgroundSummaryGraceActive,
        displayItems,
        latestTurnHasActiveBackgroundAgent,
        latestTurnStartIndex,
        orderedSummaryGraceExpired,
        unmatchedCompletionGraceExpired,
      ],
    );
    const latestTurnParallelAgentKeys = useMemo(() => {
      const keys = new Set<string>();
      for (let i = latestTurnStartIndex; i < displayItems.length; i += 1) {
        const item = displayItems[i];
        if (item.type === 'parallel_agents') keys.add(item.key);
      }
      return keys;
    }, [displayItems, latestTurnStartIndex]);
    const backgroundSummaryAgentContext = useMemo(() => {
      if (!backgroundSummaryGraceActive) {
        return { key: null };
      }
      let notificationIndex = -1;
      let callId: string | undefined;
      for (let i = displayItems.length - 1; i >= 0; i -= 1) {
        const item = displayItems[i];
        if (
          item.type !== 'message' ||
          item.message.role !== 'system' ||
          item.message.source !== 'background_notification'
        ) {
          continue;
        }
        const completion = backgroundAgentCompletion(item);
        if (!completion) continue;
        notificationIndex = i;
        callId = completion.callId;
        break;
      }
      for (let i = notificationIndex - 1; i >= 0; i -= 1) {
        const item = displayItems[i];
        if (item.type !== 'parallel_agents') continue;
        if (!callId || item.agents.some((agent) => agent.callId === callId)) {
          return { key: item.key };
        }
      }
      return { key: null };
    }, [backgroundSummaryGraceActive, displayItems]);
    const [isSessionTimelineVisible, setIsSessionTimelineVisible] =
      useState(false);
    const [automaticallyExpandedAgentKeys, setAutomaticallyExpandedAgentKeys] =
      useState<ReadonlySet<string>>(() => new Set());
    const handleAutomaticAgentExpansionChange = useCallback(
      (key: string, expanded: boolean) => {
        setAutomaticallyExpandedAgentKeys((current) => {
          if (current.has(key) === expanded) return current;
          const next = new Set(current);
          if (expanded) next.add(key);
          else next.delete(key);
          return next;
        });
      },
      [],
    );
    const sessionTimelineCache = useRef<{
      signature: string;
      t: typeof t;
      entries: SessionTimelineEntry[];
    } | null>(null);
    // Signature + entries are O(transcript text); only pay for them while the
    // rail can actually show (container >= 1160px — never on mobile).
    const sessionTimelineEntries = useMemo(() => {
      if (!isSessionTimelineVisible) return EMPTY_SESSION_TIMELINE_ENTRIES;
      const signature = getSessionTimelineSignature(mergedMessages);
      if (
        sessionTimelineCache.current?.signature !== signature ||
        sessionTimelineCache.current?.t !== t
      ) {
        sessionTimelineCache.current = {
          signature,
          t,
          entries: getSessionTimelineEntries(mergedMessages, t),
        };
      }
      return sessionTimelineCache.current.entries;
    }, [isSessionTimelineVisible, mergedMessages, t]);
    const sessionTimelineEntryIndexById = useMemo(
      () =>
        new Map(
          sessionTimelineEntries.map((entry, index) => [entry.id, index]),
        ),
      [sessionTimelineEntries],
    );
    const fallbackCurrentTimelineTurnId = useMemo(
      () => getLastTurnStartMessageId(mergedMessages),
      [mergedMessages],
    );
    const [sessionTimelineRange, setSessionTimelineRange] =
      useState<SessionTimelineRange | null>(null);
    const currentTimelineTurnId =
      sessionTimelineRange !== null
        ? (sessionTimelineEntries[sessionTimelineRange.currentIndex]?.id ??
          fallbackCurrentTimelineTurnId)
        : fallbackCurrentTimelineTurnId;
    const finalAssistantTurnIdsCache = useRef<
      | {
          sourceMessages: readonly Message[];
          isResponding: boolean;
          latestTurnAwaitsAgentSummary: boolean;
          gateBackgroundAgentStatus: boolean;
          value: ReadonlyMap<string, string>;
        }
      | undefined
    >(undefined);
    const finalAssistantTurnIdByAssistantId = useMemo(() => {
      const cached = finalAssistantTurnIdsCache.current;
      let value: ReadonlyMap<string, string>;
      if (
        streamingTailContentOnly &&
        isResponding &&
        cached?.sourceMessages === previousMessagesRef.current &&
        cached?.isResponding === isResponding &&
        cached.latestTurnAwaitsAgentSummary === latestTurnAwaitsAgentSummary &&
        cached.gateBackgroundAgentStatus === gateBackgroundAgentStatus
      ) {
        value = cached.value;
      } else {
        value = collectFinalAssistantTurnIds(displayItems, {
          isResponding,
          latestTurnAwaitsAgentSummary,
          gateBackgroundAgentStatus,
        });
      }
      finalAssistantTurnIdsCache.current = {
        sourceMessages: messages,
        isResponding,
        latestTurnAwaitsAgentSummary,
        gateBackgroundAgentStatus,
        value,
      };
      return value;
    }, [
      displayItems,
      messages,
      streamingTailContentOnly,
      gateBackgroundAgentStatus,
      isResponding,
      latestTurnAwaitsAgentSummary,
    ]);

    // ── Per-turn collapse ────────────────────────────────────────────────
    // Completed turns fold down to their prompt + final answer (toggle on the
    // prompt row). `collapseOverrides` records explicit user toggles keyed by
    // the turn's user-message id; turns absent from it follow the default
    // (collapsed once complete). `displayItems` stays the full, pre-collapse
    // list — used only to locate rows hidden inside a collapsed turn — while
    // `visibleItems` is what actually renders.
    const { collapseCompletedTurns } = useWebShellCustomization();
    const collapseEnabled = collapseCompletedTurns ?? true;
    const [collapseOverrides, setCollapseOverrides] = useState<
      ReadonlyMap<string, boolean>
    >(() => new Map());
    // Turns kept expanded despite being complete. Two sources: pagination
    // split-turn detection (tail was on screen before the user prompt
    // arrived), and the anchor fallback (a turn collapsed while a history
    // anchor sat on it). Entries persist until the user toggles the turn or
    // the screen is cleared.
    const [paginatedExpandedTurns, setPaginatedExpandedTurns] = useState<
      ReadonlySet<string>
    >(() => new Set());
    // Pending split-turn detection snapshots keyed by load generation: a load
    // can resolve SDK-side before its page commits to the transcript, letting
    // a next load enqueue its own snapshot before the earlier page lands.
    const pendingPaginationTurnCompares = useRef(
      new Map<number, { ids: Set<string>; resolved: boolean }>(),
    );
    const [turnLayoutPending, startTurnLayoutTransition] = useTransition();
    const turnLayoutTransitionStarted = useRef(false);
    const turnLayoutRowTops = useRef(new Map<string, number>());
    const turnLayoutAnimationTimer = useRef<number | undefined>(undefined);
    const turnLayoutAnimations = useRef<Animation[]>([]);
    const shouldFollow = useRef(true);
    const followPausedByUserRef = useRef(false);
    const userScrollIntentUntil = useRef(0);
    const lastScrollTop = useRef(0);
    const olderHistoryLoadInFlight = useRef(false);
    const olderHistoryLoadGeneration = useRef(0);
    const scrollCooldown = useRef(false);
    const scrollCooldownCount = useRef(0);
    const pendingBottomFollowAfterCooldown = useRef(false);
    const sessionTimelineFrame = useRef<number | null>(null);
    const lastReportedCanScrollToBottom = useRef<boolean | null>(null);
    const didTrackLastUserMsgRef = useRef(false);
    const prevLastUserMsgId = useRef<string | null>(null);
    const pendingNewUserSmoothScroll = useRef(false);
    const prevLoadingTranscript = useRef(loadingTranscript);
    const pendingTranscriptBottomScroll = useRef(Boolean(loadingTranscript));
    const transcriptBottomScrollFrame = useRef<number | undefined>(undefined);
    const transcriptBottomScrollSettleFrame = useRef<number | undefined>(
      undefined,
    );
    const prevBottomOverlayInset = useRef(bottomOverlayInset);
    const prevActiveExecutionKey = useRef<string | null>(null);
    const prevCatchingUp: MutableRefObject<boolean | undefined> =
      useRef(catchingUp);
    const catchingUpRef = useRef(catchingUp);
    const prevHasTailContent = useRef(false);
    const pendingFollowRecheck = useRef(false);
    const pendingFollowRecheckFrame = useRef<number | undefined>(undefined);
    const pendingOverflowFrame = useRef<number | undefined>(undefined);
    catchingUpRef.current = catchingUp;
    const containerRef = useRef<HTMLDivElement>(null);
    const olderHistoryRetryBlocked = useRef(false);
    const olderHistoryAnchorFrame = useRef<number | undefined>(undefined);
    const olderHistoryAnchorWaitFrame = useRef<number | undefined>(undefined);
    const olderHistoryTopCheckFrame = useRef<number | undefined>(undefined);
    const pendingOlderHistoryTopLoad = useRef<number | undefined>(undefined);
    const reloadTranscriptTimer = useRef<number | undefined>(undefined);
    const reloadTranscriptAbort = useRef<AbortController | undefined>(
      undefined,
    );
    const transcriptReloadBaseline = useRef<
      | {
          lastEventId?: number;
        }
      | undefined
    >(undefined);
    const transcriptBlockCountRef = useRef(transcriptBlockCount);
    const transcriptReloadPausedRef = useRef(transcriptReloadPaused);
    transcriptBlockCountRef.current = transcriptBlockCount;
    transcriptReloadPausedRef.current = transcriptReloadPaused;
    const lastUnderfillAutoLoad = useRef<{
      loader: typeof onLoadOlderHistory;
      totalVirtualSize: number;
    } | null>(null);
    const [olderHistoryAnchor, setOlderHistoryAnchor] = useState<{
      scrollHeight: number;
      scrollTop: number;
      messageCount: number;
      virtual: boolean;
      settled: boolean;
      generation: number;
      rowKey?: string;
      rowTop?: number;
    } | null>(null);
    const restoringOlderHistoryRef = useRef(false);
    restoringOlderHistoryRef.current = olderHistoryAnchor?.virtual === true;
    const mergedMessageCountRef = useRef(mergedMessages.length);
    useLayoutEffect(() => {
      mergedMessageCountRef.current = mergedMessages.length;
    }, [mergedMessages.length]);
    const rawMessagesRef = useRef(messages);
    useLayoutEffect(() => {
      rawMessagesRef.current = messages;
    }, [messages]);
    const [
      suppressOlderHistoryLoadingStatus,
      setSuppressOlderHistoryLoadingStatus,
    ] = useState(false);

    // A direct session switch never renders empty messages (the provider
    // batches the store reset and the replay into one notification), so the
    // /clear reset never runs for it. Block ids are per-session ordinals, so
    // every session-scoped state must drop when the displayed session
    // changes: stale keep-open and snapshot entries would collide with the
    // new session's reused ids, and an old anchor would restore the previous
    // session's scroll metrics into the new transcript.
    const [trackedSessionKey, setTrackedSessionKey] = useState(sessionKey);
    if (trackedSessionKey !== sessionKey) {
      setTrackedSessionKey(sessionKey);
      pendingPaginationTurnCompares.current.clear();
      olderHistoryLoadGeneration.current += 1;
      olderHistoryLoadInFlight.current = false;
      olderHistoryRetryBlocked.current = false;
      setOlderHistoryAnchor(null);
      setCollapseOverrides((prev) => (prev.size ? new Map() : prev));
      setPaginatedExpandedTurns((prev) => (prev.size ? new Set() : prev));
    }

    useEffect(() => {
      if (!hasOlderHistory) {
        olderHistoryRetryBlocked.current = false;
        lastUnderfillAutoLoad.current = null;
      }
    }, [hasOlderHistory]);

    const reportCanScrollToBottom = useCallback(() => {
      const el = containerRef.current;
      const distanceFromBottom = el
        ? el.scrollHeight - el.scrollTop - el.clientHeight
        : 0;
      const canScrollToBottom = !shouldFollow.current && distanceFromBottom > 1;
      if (lastReportedCanScrollToBottom.current === canScrollToBottom) return;
      lastReportedCanScrollToBottom.current = canScrollToBottom;
      onCanScrollToBottomChange?.(canScrollToBottom);
    }, [onCanScrollToBottomChange]);

    const scheduleScrollOverflowReport = useCallback(() => {
      if (pendingOverflowFrame.current !== undefined) {
        window.cancelAnimationFrame(pendingOverflowFrame.current);
      }
      pendingOverflowFrame.current = window.requestAnimationFrame(
        reportCanScrollToBottom,
      );
    }, [reportCanScrollToBottom]);

    const setShouldFollow = useCallback(
      (value: boolean) => {
        if (shouldFollow.current === value) return;
        shouldFollow.current = value;
        scheduleScrollOverflowReport();
      },
      [scheduleScrollOverflowReport],
    );
    const visibleItemsCache = useRef<
      | {
          sourceMessages: readonly Message[];
          dependencies: readonly unknown[];
          value: DisplayItem[];
          virtualizerItems: DisplayItem[];
        }
      | undefined
    >(undefined);
    const reusedVisibleStreamingTailRef = useRef(false);
    const visibleItems = useMemo(() => {
      reusedVisibleStreamingTailRef.current = false;
      const dependencies = [
        collapseOverrides,
        isResponding,
        activeTurnStartedAt,
        terminalBackgroundShellTaskIds,
        backgroundSummaryGraceActive,
        latestTurnHasActiveBackgroundAgent,
        unmatchedCompletionGraceExpired,
        orderedSummaryGraceExpired,
        collapseEnabled,
        hideFirstUserMessage,
        firstTurnMetrics,
        includeSubagentToolUsageInMetrics,
        automaticallyExpandedAgentKeys,
        compactMode,
        pendingApproval,
        turnFileChanges,
        turnArtifacts,
        turnScheduledTasks,
        paginatedExpandedTurns,
      ] as const;
      const cached = visibleItemsCache.current;
      const currentTail = displayItems[displayItems.length - 1];
      if (
        streamingTailContentOnly &&
        isResponding &&
        cached &&
        cached.sourceMessages === previousMessagesRef.current &&
        sameIdentities(cached.dependencies, dependencies) &&
        currentTail?.type === 'message'
      ) {
        const key = getDisplayItemVirtualKey(currentTail);
        let index = -1;
        for (let i = cached.value.length - 1; i >= 0; i -= 1) {
          if (getDisplayItemVirtualKey(cached.value[i]) === key) {
            index = i;
            break;
          }
        }
        if (index >= 0) {
          const previousTail = cached.value[index];
          if (previousTail?.type === 'message') {
            const value = cached.value.slice();
            value[index] = {
              ...previousTail,
              message: currentTail.message,
            };
            visibleItemsCache.current = {
              sourceMessages: messages,
              dependencies,
              value,
              virtualizerItems: cached.virtualizerItems,
            };
            reusedVisibleStreamingTailRef.current = true;
            return value;
          }
        }
      }
      const collapsedItems = applyTurnCollapse(displayItems, {
        overrides: collapseOverrides,
        isResponding,
        activeTurnStartedAt,
        terminalBackgroundShellTaskIds,
        backgroundSummaryGraceActive,
        waitForUnmatchedAgentCompletions:
          latestTurnHasActiveBackgroundAgent ||
          !unmatchedCompletionGraceExpired,
        waitForOrderedNarration: !orderedSummaryGraceExpired,
        automaticallyExpandedAgentKeys,
        pendingApprovalCallId: pendingApproval?.toolCallId ?? null,
        includeSubagentToolUsageInMetrics,
        paginatedExpanded: paginatedExpandedTurns,
        enabled: collapseEnabled,
      });
      let metricsApplied = false;
      const itemsWithMetrics = firstTurnMetrics
        ? collapsedItems.map((item) => {
            if (metricsApplied || item.type !== 'turn_collapse') return item;
            metricsApplied = true;
            return {
              ...item,
              turnCollapse: {
                ...item.turnCollapse,
                ...(firstTurnMetrics.durationMs !== undefined &&
                firstTurnMetrics.durationMs > 0
                  ? { elapsedMs: firstTurnMetrics.durationMs }
                  : {}),
                ...(firstTurnMetrics.inputTokens !== undefined
                  ? { inputTokens: firstTurnMetrics.inputTokens }
                  : {}),
                ...(firstTurnMetrics.outputTokens !== undefined
                  ? { outputTokens: firstTurnMetrics.outputTokens }
                  : {}),
                ...(firstTurnMetrics.cachedTokens !== undefined
                  ? { cachedTokens: firstTurnMetrics.cachedTokens }
                  : {}),
              },
            };
          })
        : collapsedItems;
      const pinnedItems = pinActiveParallelAgentsToTurnEnd(
        itemsWithMetrics,
        automaticallyExpandedAgentKeys,
      );
      if (!hideFirstUserMessage) {
        visibleItemsCache.current = {
          sourceMessages: messages,
          dependencies,
          value: pinnedItems,
          virtualizerItems: pinnedItems,
        };
        return pinnedItems;
      }
      const firstUserId = mergedMessages.find(
        (message) => message.role === 'user',
      )?.id;
      const value = firstUserId
        ? pinnedItems.filter(
            (item) =>
              item.type !== 'message' || item.message.id !== firstUserId,
          )
        : pinnedItems;
      visibleItemsCache.current = {
        sourceMessages: messages,
        dependencies,
        value,
        virtualizerItems: value,
      };
      return value;
    }, [
      displayItems,
      streamingTailContentOnly,
      collapseOverrides,
      isResponding,
      activeTurnStartedAt,
      terminalBackgroundShellTaskIds,
      backgroundSummaryGraceActive,
      latestTurnHasActiveBackgroundAgent,
      unmatchedCompletionGraceExpired,
      orderedSummaryGraceExpired,
      collapseEnabled,
      hideFirstUserMessage,
      firstTurnMetrics,
      includeSubagentToolUsageInMetrics,
      mergedMessages,
      messages,
      automaticallyExpandedAgentKeys,
      compactMode,
      pendingApproval,
      turnFileChanges,
      turnArtifacts,
      turnScheduledTasks,
      paginatedExpandedTurns,
    ]);
    const virtualizerItems =
      visibleItemsCache.current?.sourceMessages === messages
        ? visibleItemsCache.current.virtualizerItems
        : visibleItems;
    const hasVisibleRowKey = useCallback(
      (key: string) =>
        virtualizerItems.some(
          (item) => String(getDisplayItemVirtualKey(item)) === key,
        ),
      [virtualizerItems],
    );
    const visibleTurnIdsCache = useRef<
      | {
          length: number;
          value: Array<string | null>;
        }
      | undefined
    >(undefined);
    const visibleTurnIdByDisplayIndex = useMemo(() => {
      if (
        reusedVisibleStreamingTailRef.current &&
        visibleTurnIdsCache.current?.length === visibleItems.length
      ) {
        return visibleTurnIdsCache.current.value;
      }
      const value = getTurnIdByDisplayIndex(visibleItems);
      visibleTurnIdsCache.current = { length: visibleItems.length, value };
      return value;
    }, [visibleItems]);

    const hasEnoughSessionTimelineEntries =
      sessionTimelineEntries.length >= SESSION_TIMELINE_MIN_VISIBLE_ENTRIES;

    useLayoutEffect(() => {
      if (hideSessionTimeline) {
        setIsSessionTimelineVisible((prev) => (prev ? false : prev));
        return;
      }

      const el = containerRef.current;
      if (!el) return;

      const updateVisibility = () => {
        const width = el.getBoundingClientRect().width;
        const nextVisible = width >= 1160;
        setIsSessionTimelineVisible((prev) =>
          prev === nextVisible ? prev : nextVisible,
        );
      };

      updateVisibility();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(updateVisibility);
      observer.observe(el);
      return () => observer.disconnect();
    }, [hideSessionTimeline]);

    // ── Scroll-follow state ──────────────────────────────────────────────
    //
    // The scroll behavior follows 6 rules:
    //
    //   1. Default follow-bottom — while the user is looking at the bottom,
    //      new content (streaming tokens, tool cards expanding, approval
    //      cards appearing, any height change) keeps the viewport pinned
    //      to the latest output.
    //
    //   2. Scroll-up pauses follow — if the user scrolls up, the page
    //      assumes they want to read history and stops auto-scrolling.
    //      Even if the model is still streaming, the viewport stays put.
    //
    //   3. Scroll-back-to-bottom resumes — when the user scrolls back
    //      near the bottom (within FOLLOW_BOTTOM_THRESHOLD_PX), follow mode
    //      re-engages
    //      and new content resumes sticking.
    //
    //   4. New message resets follow — after the user sends a message,
    //      follow mode is forced on so the model's reply scrolls in
    //      naturally.
    //
    //   5. Session restore / reconnect — during history replay
    //      (`catchingUp === true`), all auto-scrolling is suppressed to
    //      avoid fighting the rapidly replaying transcript. Once replay
    //      finishes (`catchingUp` flips to falsy), a single scroll-to-
    //      bottom fires so the user lands at the latest content.
    //
    //   6. Short content — if the content doesn't overflow the container
    //      (no scrollbar), scrollToBottom is a no-op. This avoids a
    //      visual flash when the model just started replying with a
    //      short first chunk.
    //
    // Implementation: three refs, three effects, one scroll handler.
    //
    //   - `shouldFollow`      — whether auto-scroll is active
    //   - `lastScrollTop`     — previous scrollTop for direction detection
    //   - `prevLastUserMsgId` — tracks when a new user message appears
    //   - `prevCatchingUp`    — tracks the catchingUp → ready transition
    //
    // The single auto-scroll driver is a `useLayoutEffect` on
    // `totalVirtualSize` (the virtualizer's computed content height).
    // Every height change — streaming text, card expand, approval
    // appearance — flows through this one effect.
    // ─────────────────────────────────────────────────────────────────────

    const hasTailContent = tailContent !== undefined && tailContent !== null;
    const showLoadingSkeleton = Boolean(loadingTranscript);
    const hasHeader = !!welcomeHeader;
    const headerOffset = hasHeader ? 1 : 0;
    const tailContentIndex = headerOffset + visibleItems.length;
    const totalCount = tailContentIndex + (hasTailContent ? 1 : 0);
    const uncollapsedTotalCount =
      headerOffset + displayItems.length + (hasTailContent ? 1 : 0);
    const useVirtualScroll = shouldUseVirtualScroll(
      uncollapsedTotalCount,
      virtualScrollThreshold,
    );
    const getScrollElement = useCallback((): HTMLElement | null => {
      return containerRef.current;
    }, []);

    const recheckFollowFromScrollGeometry = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const isNearBottom = distanceFromBottom < FOLLOW_BOTTOM_THRESHOLD_PX;
      followPausedByUserRef.current = !isNearBottom;
      setShouldFollow(isNearBottom);
      scheduleScrollOverflowReport();
    }, [scheduleScrollOverflowReport, setShouldFollow]);

    const markUserScrollIntent = useCallback(() => {
      userScrollIntentUntil.current = Date.now() + 1000;
    }, []);

    const cancelTranscriptReloadTimer = useCallback(() => {
      if (reloadTranscriptTimer.current !== undefined) {
        window.clearTimeout(reloadTranscriptTimer.current);
        reloadTranscriptTimer.current = undefined;
      }
    }, []);

    const cancelTranscriptReload = useCallback(() => {
      cancelTranscriptReloadTimer();
      reloadTranscriptAbort.current?.abort();
      reloadTranscriptAbort.current = undefined;
    }, [cancelTranscriptReloadTimer]);

    const scheduleTranscriptReload = useCallback(() => {
      cancelTranscriptReloadTimer();
      const baseline = transcriptReloadBaseline.current;
      if (baseline) {
        const lastEventId = transcriptActivity?.getSnapshot().lastEventId;
        if (lastEventId === baseline.lastEventId) return;
        transcriptReloadBaseline.current = undefined;
      }
      if (
        !onReloadTranscript ||
        reloadTranscriptAbort.current !== undefined ||
        followPausedByUserRef.current ||
        transcriptReloadPausedRef.current ||
        transcriptBlockCountRef.current <= WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS
      ) {
        return;
      }
      reloadTranscriptTimer.current = window.setTimeout(() => {
        reloadTranscriptTimer.current = undefined;
        if (
          transcriptReloadPausedRef.current ||
          followPausedByUserRef.current ||
          transcriptBlockCountRef.current <= WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS
        ) {
          return;
        }
        const el = containerRef.current;
        if (!el) return;
        const distanceFromBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom >= FOLLOW_BOTTOM_THRESHOLD_PX) return;
        const controller = new AbortController();
        reloadTranscriptAbort.current = controller;
        void onReloadTranscript(controller.signal)
          .then(() => {
            if (controller.signal.aborted) return;
            const snapshot = transcriptActivity?.getSnapshot();
            transcriptReloadBaseline.current = {
              ...(snapshot?.lastEventId !== undefined
                ? { lastEventId: snapshot.lastEventId }
                : {}),
            };
          })
          .catch((error: unknown) => {
            if (!(error instanceof Error && error.name === 'AbortError')) {
              console.warn('[MessageList] transcript reload failed:', error);
            }
          })
          .finally(() => {
            if (reloadTranscriptAbort.current === controller) {
              reloadTranscriptAbort.current = undefined;
            }
          });
      }, RELOAD_TRANSCRIPT_DELAY_MS);
    }, [cancelTranscriptReloadTimer, onReloadTranscript, transcriptActivity]);

    useEffect(() => {
      transcriptReloadBaseline.current = undefined;
    }, [transcriptActivity]);

    useEffect(() => {
      if (!transcriptActivity) return cancelTranscriptReload;
      let lastEventId = transcriptActivity.getSnapshot().lastEventId;
      const unsubscribe = transcriptActivity.subscribe(() => {
        const nextLastEventId = transcriptActivity.getSnapshot().lastEventId;
        if (nextLastEventId === lastEventId) return;
        lastEventId = nextLastEventId;
        scheduleTranscriptReload();
      });
      return () => {
        unsubscribe();
        cancelTranscriptReload();
      };
    }, [transcriptActivity, scheduleTranscriptReload, cancelTranscriptReload]);

    useEffect(() => {
      if (transcriptReloadPaused) {
        cancelTranscriptReload();
        return;
      }
      scheduleTranscriptReload();
    }, [
      cancelTranscriptReload,
      transcriptReloadPaused,
      scheduleTranscriptReload,
      transcriptBlockCount,
    ]);

    const scheduleFollowRecheck = useCallback(() => {
      pendingFollowRecheck.current = true;
      if (pendingFollowRecheckFrame.current !== undefined) {
        window.cancelAnimationFrame(pendingFollowRecheckFrame.current);
      }
      pendingFollowRecheckFrame.current = window.requestAnimationFrame(() => {
        pendingFollowRecheck.current = false;
        pendingFollowRecheckFrame.current = undefined;
        recheckFollowFromScrollGeometry();
      });
    }, [recheckFollowFromScrollGeometry]);

    useEffect(
      () => () => {
        if (pendingFollowRecheckFrame.current !== undefined) {
          window.cancelAnimationFrame(pendingFollowRecheckFrame.current);
        }
        if (pendingOverflowFrame.current !== undefined) {
          window.cancelAnimationFrame(pendingOverflowFrame.current);
        }
        if (olderHistoryAnchorFrame.current !== undefined) {
          window.cancelAnimationFrame(olderHistoryAnchorFrame.current);
        }
        if (olderHistoryAnchorWaitFrame.current !== undefined) {
          window.cancelAnimationFrame(olderHistoryAnchorWaitFrame.current);
        }
        if (olderHistoryTopCheckFrame.current !== undefined) {
          window.cancelAnimationFrame(olderHistoryTopCheckFrame.current);
        }
        cancelTranscriptReload();
        if (transcriptBottomScrollFrame.current !== undefined) {
          window.cancelAnimationFrame(transcriptBottomScrollFrame.current);
        }
        if (transcriptBottomScrollSettleFrame.current !== undefined) {
          window.cancelAnimationFrame(
            transcriptBottomScrollSettleFrame.current,
          );
        }
      },
      [cancelTranscriptReload],
    );

    const handleToggleCollapse = useCallback(
      (turnId: string, nextExpanded: boolean) => {
        // Expanding/collapsing a turn is an explicit reading action. Pause
        // follow so streaming output does not yank the viewport back to the
        // tail while the user is inspecting history.
        const el = containerRef.current;
        // If there is no scrollbar yet, there is no meaningful "not at
        // bottom" state to report. The toggle may create overflow though, so
        // re-check after the expanded/collapsed rows have been laid out.
        if (!el || el.scrollHeight > el.clientHeight + 1) {
          followPausedByUserRef.current = true;
          setShouldFollow(false);
        }
        scheduleFollowRecheck();
        if (turnLayoutAnimationTimer.current !== undefined) {
          window.clearTimeout(turnLayoutAnimationTimer.current);
        }
        turnLayoutRowTops.current.clear();
        containerRef.current
          ?.querySelectorAll<HTMLElement>('[data-message-row-key]')
          .forEach((row) => {
            const key = row.dataset.messageRowKey;
            if (key) {
              turnLayoutRowTops.current.set(
                key,
                row.getBoundingClientRect().top,
              );
            }
          });
        turnLayoutTransitionStarted.current = true;
        startTurnLayoutTransition(() => {
          // An explicit toggle is the user's own decision: it wins over the
          // pagination keep-open and returns the turn to normal collapse
          // semantics.
          setPaginatedExpandedTurns((prev) => {
            if (!prev.has(turnId)) return prev;
            const next = new Set(prev);
            next.delete(turnId);
            return next;
          });
          setCollapseOverrides((prev) => {
            const next = new Map(prev);
            next.set(turnId, nextExpanded);
            return next;
          });
        });
      },
      [scheduleFollowRecheck, setShouldFollow],
    );

    useLayoutEffect(() => {
      if (turnLayoutPending || !turnLayoutTransitionStarted.current) return;
      turnLayoutTransitionStarted.current = false;
      for (const animation of turnLayoutAnimations.current) {
        animation.cancel();
      }
      turnLayoutAnimations.current = [];
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduceMotion) {
        containerRef.current
          ?.querySelectorAll<HTMLElement>('[data-message-row-key]')
          .forEach((row) => {
            if (typeof row.animate !== 'function') return;
            const key = row.dataset.messageRowKey;
            const previousTop = key
              ? turnLayoutRowTops.current.get(key)
              : undefined;
            if (previousTop === undefined) {
              turnLayoutAnimations.current.push(
                row.animate([{ opacity: 0 }, { opacity: 1 }], {
                  duration: TURN_LAYOUT_ANIMATION_MS,
                  easing: 'ease-out',
                }),
              );
              return;
            }
            const delta = previousTop - row.getBoundingClientRect().top;
            if (Math.abs(delta) < 1) return;
            turnLayoutAnimations.current.push(
              row.animate(
                [{ translate: `0 ${delta}px` }, { translate: '0 0' }],
                {
                  duration: TURN_LAYOUT_ANIMATION_MS,
                  easing: 'ease-out',
                },
              ),
            );
          });
      }
      turnLayoutRowTops.current.clear();
      turnLayoutAnimationTimer.current = window.setTimeout(
        () => {
          turnLayoutAnimationTimer.current = undefined;
          scheduleFollowRecheck();
        },
        reduceMotion ? 0 : TURN_LAYOUT_ANIMATION_MS,
      );
    }, [scheduleFollowRecheck, turnLayoutPending]);

    useEffect(
      () => () => {
        if (turnLayoutAnimationTimer.current !== undefined) {
          window.clearTimeout(turnLayoutAnimationTimer.current);
        }
        for (const animation of turnLayoutAnimations.current) {
          animation.cancel();
        }
        turnLayoutAnimations.current = [];
      },
      [],
    );

    const handleDisclosureClickCapture = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.closest('[aria-expanded]')) return;
        followPausedByUserRef.current = true;
        setShouldFollow(false);
        scheduleFollowRecheck();
      },
      [scheduleFollowRecheck, setShouldFollow],
    );

    const getItemKey = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) return 'slot:header';
        if (hasTailContent && index === tailContentIndex) {
          return `slot:tail:${tailKey}`;
        }
        const item = virtualizerItems[index - headerOffset];
        return item ? getDisplayItemVirtualKey(item) : `slot:row:${index}`;
      },
      [
        hasHeader,
        hasTailContent,
        tailContentIndex,
        tailKey,
        virtualizerItems,
        headerOffset,
      ],
    );
    const estimateItemSize = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) return ESTIMATE_HEADER;
        if (hasTailContent && index === tailContentIndex) return ESTIMATE_TAIL;
        const item = virtualizerItems[index - headerOffset];
        if (item?.type === 'turn_collapse') return ESTIMATE_TURN_COLLAPSE;
        return ESTIMATE_MESSAGE;
      },
      [
        hasHeader,
        hasTailContent,
        headerOffset,
        tailContentIndex,
        virtualizerItems,
      ],
    );

    // Rule 6: skip if content doesn't overflow (no scrollbar).
    const scrollToBottom = useCallback(
      (behavior: ScrollBehavior = 'auto') => {
        const el = getScrollElement();
        if (!el) return;
        if (el.scrollHeight <= el.clientHeight) return;
        pendingBottomFollowAfterCooldown.current = false;
        scrollCooldownCount.current += 1;
        const gen = scrollCooldownCount.current;
        scrollCooldown.current = true;
        if (behavior === 'smooth') {
          el.scrollTo({ top: el.scrollHeight, behavior });
        } else {
          el.scrollTop = el.scrollHeight;
        }
        scheduleScrollOverflowReport();
        lastScrollTop.current = Math.max(0, el.scrollHeight - el.clientHeight);
        reportCanScrollToBottom();
        const releaseCooldown = () => {
          if (scrollCooldownCount.current !== gen) return;
          scrollCooldown.current = false;
          if (!pendingBottomFollowAfterCooldown.current) return;
          pendingBottomFollowAfterCooldown.current = false;
          if (catchingUpRef.current || followPausedByUserRef.current) return;
          const current = getScrollElement();
          if (!current || current.scrollHeight <= current.clientHeight) return;
          setShouldFollow(true);
          current.scrollTop = current.scrollHeight;
          scheduleScrollOverflowReport();
          lastScrollTop.current = Math.max(
            0,
            current.scrollHeight - current.clientHeight,
          );
          reportCanScrollToBottom();
        };
        if (behavior === 'smooth') {
          setTimeout(releaseCooldown, 350);
        } else {
          requestAnimationFrame(releaseCooldown);
        }
      },
      [
        getScrollElement,
        reportCanScrollToBottom,
        scheduleScrollOverflowReport,
        setShouldFollow,
      ],
    );

    const resumeBottomFollow = useCallback(
      (behavior: ScrollBehavior = 'smooth') => {
        followPausedByUserRef.current = false;
        setShouldFollow(true);
        scrollToBottom(behavior);
      },
      [scrollToBottom, setShouldFollow],
    );

    const virtualizer = useVirtualizer({
      count: totalCount,
      enabled: useVirtualScroll,
      getScrollElement,
      getItemKey,
      estimateSize: estimateItemSize,
      overscan: 20,
      anchorTo: 'end',
      useFlushSync: false,
      useAnimationFrameWithResizeObserver: true,
      directDomUpdates: true,
    });
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance,
    ) =>
      shouldAdjustVirtualScrollPosition(
        item.end,
        containerRef.current?.scrollTop ?? instance.scrollOffset ?? 0,
      );
    const measureVirtualRow = useCallback(
      (node: HTMLDivElement | null) => {
        virtualizer.measureElement(node);
        if (!node || !restoringOlderHistoryRef.current) return;
        const index = Number(node.dataset.index);
        if (
          Number.isFinite(index) &&
          !virtualizer.itemSizeCache.has(getItemKey(index))
        ) {
          virtualizer.resizeItem(index, node.offsetHeight);
        }
      },
      [getItemKey, virtualizer],
    );
    useLayoutEffect(() => {
      if (!olderHistoryAnchor) return;
      const current = containerRef.current;
      if (
        olderHistoryAnchor.rowKey &&
        !hasVisibleRowKey(olderHistoryAnchor.rowKey)
      ) {
        // The anchor row can vanish because its turn collapsed while the page
        // was loading (a turn completed by pagination). Re-expand that turn so
        // the anchor can be restored instead of dropping the reader's position.
        const anchorTurnId = turnIdOfMessageRow(
          rawMessagesRef.current,
          olderHistoryAnchor.rowKey,
        );
        if (
          anchorTurnId !== undefined &&
          isTurnCollapsedInVisibleItems(visibleItems, anchorTurnId)
        ) {
          // Re-expanding only helps when it can actually take effect: an
          // explicit user collapse override wins over the keep-open, and a
          // turn already marked keep-open yet still hidden cannot be helped.
          // Fall through and drop the anchor in those cases, or pagination
          // state stays pinned in-flight forever (every later load bails at
          // the in-flight guard).
          if (
            collapseOverrides.get(anchorTurnId) !== false &&
            !paginatedExpandedTurns.has(anchorTurnId)
          ) {
            setPaginatedExpandedTurns((prev) =>
              prev.has(anchorTurnId) ? prev : new Set(prev).add(anchorTurnId),
            );
            // A page extending the turn's aggregated run re-keys the captured
            // row, so anchor on the turn's user row instead: the re-expanded
            // turn always renders it, and the restore path then adjusts the
            // scroll position rather than dropping the anchor.
            setOlderHistoryAnchor((anchor) =>
              anchor ? { ...anchor, rowKey: `msg:${anchorTurnId}` } : anchor,
            );
            return;
          }
        }
        if (
          olderHistoryAnchor.generation === olderHistoryLoadGeneration.current
        ) {
          olderHistoryLoadGeneration.current += 1;
        }
        olderHistoryLoadInFlight.current = false;
        pendingOlderHistoryTopLoad.current = undefined;
        setSuppressOlderHistoryLoadingStatus(false);
        setOlderHistoryAnchor(null);
        return;
      }
      if (!olderHistoryAnchor.settled) return;
      if (!current) {
        olderHistoryLoadInFlight.current = false;
        setOlderHistoryAnchor(null);
        return;
      }
      const unchanged = olderHistoryAnchor.virtual
        ? mergedMessages.length === olderHistoryAnchor.messageCount
        : current.scrollHeight === olderHistoryAnchor.scrollHeight;
      if (unchanged) {
        olderHistoryLoadInFlight.current = false;
        if (olderHistoryAnchorFrame.current !== undefined) return;
        // The loader can resolve before the parent commits prepended messages.
        // Keep the anchor through a bounded frame grace instead of clearing it
        // after one busy frame.
        let remainingFrames = OLDER_HISTORY_ANCHOR_WAIT_FRAMES;
        const waitForPrepend = () => {
          olderHistoryAnchorFrame.current = undefined;
          if (
            olderHistoryAnchor.generation !== olderHistoryLoadGeneration.current
          ) {
            return;
          }
          if (
            mergedMessageCountRef.current !== olderHistoryAnchor.messageCount
          ) {
            return;
          }
          remainingFrames -= 1;
          if (remainingFrames > 0) {
            olderHistoryAnchorFrame.current =
              requestAnimationFrame(waitForPrepend);
            return;
          }
          setOlderHistoryAnchor((anchor) =>
            anchor === olderHistoryAnchor ? null : anchor,
          );
        };
        olderHistoryAnchorFrame.current = requestAnimationFrame(waitForPrepend);
        return;
      }
      if (olderHistoryAnchorFrame.current !== undefined) {
        cancelAnimationFrame(olderHistoryAnchorFrame.current);
        olderHistoryAnchorFrame.current = undefined;
      }
      olderHistoryAnchorFrame.current = requestAnimationFrame(() => {
        olderHistoryAnchorFrame.current = undefined;
        if (
          olderHistoryAnchor.generation !== olderHistoryLoadGeneration.current
        ) {
          return;
        }
        if (
          olderHistoryAnchor.rowKey &&
          !hasVisibleRowKey(olderHistoryAnchor.rowKey)
        ) {
          olderHistoryLoadInFlight.current = false;
          setOlderHistoryAnchor(null);
          return;
        }
        const anchorRow = olderHistoryAnchor.rowKey
          ? Array.from(
              current.querySelectorAll<HTMLElement>('[data-message-row-key]'),
            ).find(
              (row) => row.dataset.messageRowKey === olderHistoryAnchor.rowKey,
            )
          : undefined;
        if (anchorRow && olderHistoryAnchor.rowTop !== undefined) {
          current.scrollTop +=
            anchorRow.getBoundingClientRect().top - olderHistoryAnchor.rowTop;
        } else {
          current.scrollTop =
            olderHistoryAnchor.scrollTop +
            Math.max(0, current.scrollHeight - olderHistoryAnchor.scrollHeight);
        }
        olderHistoryLoadInFlight.current = false;
        setOlderHistoryAnchor(null);
      });
    }, [
      hasVisibleRowKey,
      mergedMessages.length,
      olderHistoryAnchor,
      visibleItems,
      collapseOverrides,
      paginatedExpandedTurns,
    ]);
    const virtualItems = virtualizer.getVirtualItems();
    const totalVirtualSize = virtualizer.getTotalSize();
    const sessionTimelineRangeState = useRef<{
      entryIndexById: ReadonlyMap<string, number>;
      headerOffset: number;
      isVisible: boolean;
      turnIdByDisplayIndex: readonly (string | null)[];
      visibleItems: readonly DisplayItem[];
    }>({
      entryIndexById: new Map(),
      headerOffset: 0,
      isVisible: false,
      turnIdByDisplayIndex: [],
      visibleItems: [],
    });
    sessionTimelineRangeState.current = {
      entryIndexById: sessionTimelineEntryIndexById,
      headerOffset,
      isVisible: isSessionTimelineVisible,
      turnIdByDisplayIndex: visibleTurnIdByDisplayIndex,
      visibleItems,
    };

    const updateSessionTimelineRange = useCallback(() => {
      const el = getScrollElement();
      const state = sessionTimelineRangeState.current;
      if (!el || !state.isVisible || state.entryIndexById.size === 0) {
        setSessionTimelineRange((prev) => (prev === null ? prev : null));
        return;
      }

      const viewportRect = el.getBoundingClientRect();
      const viewportTop = viewportRect.top;
      const viewportBottom = viewportRect.bottom;
      const viewportCenter = viewportTop + (viewportBottom - viewportTop) / 2;
      const visibleItemIndexes: number[] = [];
      let currentItemIndex: number | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;

      el.querySelectorAll<HTMLElement>('[data-index]').forEach((row) => {
        const rawIndex = row.dataset.index;
        if (rawIndex === undefined) return;
        const rowIndex = Number(rawIndex);
        if (!Number.isFinite(rowIndex)) return;
        const visibleItemIndex = rowIndex - state.headerOffset;
        if (
          visibleItemIndex < 0 ||
          visibleItemIndex >= state.visibleItems.length
        ) {
          return;
        }

        const rowRect = row.getBoundingClientRect();
        if (rowRect.bottom < viewportTop || rowRect.top > viewportBottom) {
          return;
        }

        visibleItemIndexes.push(visibleItemIndex);
        const rowCenter = rowRect.top + (rowRect.bottom - rowRect.top) / 2;
        const distance = Math.abs(rowCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          currentItemIndex = visibleItemIndex;
        }
      });

      const next = getSessionTimelineRangeForIndexes(
        state.visibleItems,
        visibleItemIndexes,
        state.entryIndexById,
        currentItemIndex,
        state.turnIdByDisplayIndex,
      );
      setSessionTimelineRange((prev) => {
        if (
          prev?.startIndex === next?.startIndex &&
          prev?.endIndex === next?.endIndex &&
          prev?.currentIndex === next?.currentIndex
        ) {
          return prev;
        }
        return next;
      });
    }, [getScrollElement]);

    const scheduleSessionTimelineRangeUpdate = useCallback(() => {
      if (sessionTimelineFrame.current !== null) {
        cancelAnimationFrame(sessionTimelineFrame.current);
      }
      sessionTimelineFrame.current = requestAnimationFrame(() => {
        sessionTimelineFrame.current = null;
        updateSessionTimelineRange();
      });
    }, [updateSessionTimelineRange]);

    useEffect(
      () => () => {
        if (sessionTimelineFrame.current !== null) {
          cancelAnimationFrame(sessionTimelineFrame.current);
          sessionTimelineFrame.current = null;
        }
      },
      [],
    );

    useEffect(() => {
      scheduleSessionTimelineRangeUpdate();
    }, [
      scheduleSessionTimelineRangeUpdate,
      totalCount,
      totalVirtualSize,
      useVirtualScroll,
      virtualItems.length,
      isSessionTimelineVisible,
    ]);

    // Imperative scroll-to-message (e.g. the floating TodoPanel's "show in
    // transcript" button) with a brief highlight on the target message.
    const [flashTarget, setFlashTarget] = useState<LocateFlashTarget | null>(
      null,
    );
    useEffect(() => {
      if (!flashTarget) return;
      const timer = setTimeout(() => setFlashTarget(null), 1600);
      return () => clearTimeout(timer);
    }, [flashTarget]);

    // Scroll a visible row to center and flash the target message inside it.
    const performScrollToRow = useCallback(
      (rowIndex: number, target: LocateFlashTarget) => {
        // Explicit navigation away from the tail — pause follow so the
        // auto-scroll driver doesn't yank the viewport straight back down,
        // and engage the same cooldown scrollToBottom uses so the scroll
        // events this triggers short-circuit handleScroll. Without it, Rule 3
        // (near-bottom → resume follow) would re-enable follow whenever the
        // target sits near the bottom, and the next streaming height change
        // would pull the viewport back to the tail. An instant (non-smooth)
        // scroll keeps that cooldown window short and deterministic.
        followPausedByUserRef.current = true;
        setShouldFollow(false);
        scrollCooldownCount.current += 1;
        const gen = scrollCooldownCount.current;
        scrollCooldown.current = true;
        if (useVirtualScroll) {
          virtualizer.scrollToIndex(rowIndex, { align: 'center' });
        } else {
          containerRef.current
            ?.querySelector(`[data-index="${rowIndex}"]`)
            ?.scrollIntoView({ block: 'center' });
        }
        // Release once the scroll has settled (the virtualizer may re-scroll
        // a frame or two later after measuring the target row).
        setTimeout(() => {
          if (scrollCooldownCount.current === gen) {
            scrollCooldown.current = false;
            scheduleSessionTimelineRangeUpdate();
            scheduleScrollOverflowReport();
          }
        }, 150);
        setFlashTarget(null);
        requestAnimationFrame(() => setFlashTarget(target));
      },
      [
        useVirtualScroll,
        virtualizer,
        setShouldFollow,
        scheduleSessionTimelineRangeUpdate,
        scheduleScrollOverflowReport,
      ],
    );

    const scrollToMessageState = useRef<{
      visibleItems: readonly DisplayItem[];
      displayItems: readonly DisplayItem[];
      headerOffset: number;
      performScrollToRow: (rowIndex: number, target: LocateFlashTarget) => void;
    }>({
      visibleItems: [],
      displayItems: [],
      headerOffset: 0,
      performScrollToRow: () => {},
    });
    scrollToMessageState.current = {
      visibleItems,
      displayItems,
      headerOffset,
      performScrollToRow,
    };

    // A scroll target that currently sits inside a collapsed turn: expand the
    // turn, then finish the scroll once its rows materialize in `visibleItems`.
    const pendingScrollRef = useRef<LocateFlashTarget | null>(null);

    const scrollToMessage = useCallback(
      (messageId: string, callId?: string): boolean => {
        const { visibleItems, displayItems, headerOffset, performScrollToRow } =
          scrollToMessageState.current;
        const visibleIndex = findDisplayItemIndex(
          visibleItems,
          messageId,
          callId,
        );
        if (visibleIndex >= 0) {
          pendingScrollRef.current = null;
          performScrollToRow(visibleIndex + headerOffset, {
            messageId,
            callId,
          });
          return true;
        }
        // Not on screen — it may be folded inside a collapsed turn. Locate it
        // in the full list, expand that turn, and defer the scroll.
        const fullIndex = findDisplayItemIndex(displayItems, messageId, callId);
        if (fullIndex < 0) return false;
        const turnId = findTurnIdForIndex(displayItems, fullIndex);
        if (!turnId) return false;
        pendingScrollRef.current = { messageId, callId };
        setCollapseOverrides((prev) => {
          if (prev.get(turnId) === true) return prev;
          const next = new Map(prev);
          next.set(turnId, true);
          return next;
        });
        return true;
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({ scrollToMessage, scrollToBottom: resumeBottomFollow }),
      [scrollToMessage, resumeBottomFollow],
    );

    // Flush a deferred scroll once the expanded turn's rows are visible.
    useEffect(() => {
      const pending = pendingScrollRef.current;
      if (!pending) return;
      const idx = findDisplayItemIndex(
        visibleItems,
        pending.messageId,
        pending.callId,
      );
      if (idx < 0) return;
      pendingScrollRef.current = null;
      performScrollToRow(idx + headerOffset, pending);
    }, [visibleItems, headerOffset, performScrollToRow]);

    const loadOlderHistory = useCallback(
      async (allowRetry = false, force = false) => {
        const el = containerRef.current;
        if (
          !el ||
          !onLoadOlderHistory ||
          loadingOlderHistory ||
          olderHistoryLoadInFlight.current ||
          (historyPaginationError && !force) ||
          (olderHistoryRetryBlocked.current && !allowRetry)
        ) {
          return;
        }
        olderHistoryRetryBlocked.current = false;
        olderHistoryLoadInFlight.current = true;
        const generation = ++olderHistoryLoadGeneration.current;
        if (olderHistoryAnchorFrame.current !== undefined) {
          cancelAnimationFrame(olderHistoryAnchorFrame.current);
          olderHistoryAnchorFrame.current = undefined;
        }
        setSuppressOlderHistoryLoadingStatus(!force);
        let virtualAnchor:
          | {
              rowKey: string;
              rowTop: number;
            }
          | undefined;
        if (useVirtualScroll) {
          const firstMessageKey = String(getItemKey(headerOffset));
          let remainingFrames = OLDER_HISTORY_ANCHOR_WAIT_FRAMES;
          virtualAnchor = await new Promise<
            | {
                rowKey: string;
                rowTop: number;
              }
            | undefined
          >((resolve) => {
            const waitForTopRange = () => {
              olderHistoryAnchorWaitFrame.current = undefined;
              if (
                generation !== olderHistoryLoadGeneration.current ||
                containerRef.current !== el ||
                !hasVisibleRowKey(firstMessageKey) ||
                remainingFrames-- <= 0
              ) {
                resolve(undefined);
                return;
              }
              const firstMessageRow = Array.from(
                el.querySelectorAll<HTMLElement>('[data-message-row-key]'),
              ).find((row) => row.dataset.messageRowKey === firstMessageKey);
              if (firstMessageRow) {
                resolve({
                  rowKey: firstMessageKey,
                  rowTop: firstMessageRow.getBoundingClientRect().top,
                });
              } else {
                olderHistoryAnchorWaitFrame.current =
                  requestAnimationFrame(waitForTopRange);
              }
            };
            olderHistoryAnchorWaitFrame.current =
              requestAnimationFrame(waitForTopRange);
          });
          if (!virtualAnchor) {
            if (generation === olderHistoryLoadGeneration.current) {
              olderHistoryLoadInFlight.current = false;
              pendingOlderHistoryTopLoad.current = undefined;
              setSuppressOlderHistoryLoadingStatus(false);
            }
            return;
          }
        }
        const previousHeight = el.scrollHeight;
        const previousTop = el.scrollTop;
        const viewportTop = el.getBoundingClientRect().top;
        const anchorRow = virtualAnchor
          ? undefined
          : Array.from(
              el.querySelectorAll<HTMLElement>('[data-message-row-key]'),
            ).find((row) => {
              const key = row.dataset.messageRowKey;
              return (
                key !== undefined &&
                key.startsWith('msg:') &&
                row.getBoundingClientRect().bottom > viewportTop
              );
            });
        followPausedByUserRef.current = true;
        setOlderHistoryAnchor({
          scrollHeight: previousHeight,
          scrollTop: previousTop,
          messageCount: mergedMessages.length,
          virtual: useVirtualScroll,
          settled: false,
          generation,
          ...(virtualAnchor ??
            (anchorRow
              ? {
                  rowKey: anchorRow.dataset.messageRowKey,
                  rowTop: anchorRow.getBoundingClientRect().top,
                }
              : {})),
        });
        try {
          // Remember which messages were on screen before the page arrives so
          // a turn the daemon split across pages (tail shown first, head
          // completing later) can be detected and kept expanded.
          pendingPaginationTurnCompares.current.set(generation, {
            ids: new Set(rawMessagesRef.current.map((message) => message.id)),
            resolved: false,
          });
          await onLoadOlderHistory(force ? { force: true } : undefined);
          // The snapshot belongs to this load regardless of anchor state: a
          // superseding anchor drop bumps the generation mid-flight and would
          // otherwise orphan the entry unresolved at the FIFO head, wedging
          // every later split-turn detection.
          const compare = pendingPaginationTurnCompares.current.get(generation);
          if (compare) compare.resolved = true;
          if (generation === olderHistoryLoadGeneration.current) {
            setOlderHistoryAnchor((anchor) =>
              anchor?.generation === generation
                ? { ...anchor, settled: true }
                : anchor,
            );
          }
        } catch {
          // A failed load commits no page, so its snapshot is always safe to
          // drop, including when the load was superseded mid-flight.
          pendingPaginationTurnCompares.current.delete(generation);
          if (generation === olderHistoryLoadGeneration.current) {
            olderHistoryRetryBlocked.current = true;
            olderHistoryLoadInFlight.current = false;
            setOlderHistoryAnchor(null);
          }
        } finally {
          if (generation === olderHistoryLoadGeneration.current) {
            setSuppressOlderHistoryLoadingStatus(false);
          }
        }
      },
      [
        loadingOlderHistory,
        onLoadOlderHistory,
        historyPaginationError,
        getItemKey,
        hasVisibleRowKey,
        headerOffset,
        mergedMessages.length,
        useVirtualScroll,
      ],
    );

    const retryOlderHistory = useCallback(() => {
      void loadOlderHistory(true, true);
    }, [loadOlderHistory]);

    // After a pagination page commits, mark turns whose user prompt just
    // arrived while their tail was already on screen (the daemon split the
    // turn across pages). `applyTurnCollapse` keeps those expanded so the
    // content the user is reading never silently collapses.
    useLayoutEffect(() => {
      const pending = pendingPaginationTurnCompares.current;
      if (pending.size === 0) return;
      // Skip locally-injected messages (recap ids `local-*`): /recap re-pins
      // them at index 0 on every render and pagination cannot move them, so
      // they never reflect a page landing and would pin the head-change check
      // forever, wedging split-turn detection for the rest of the session.
      const first = messages.find(
        (message) => !message?.id.startsWith('local-'),
      );
      if (!first) return;
      const oldest = pending.entries().next().value;
      if (!oldest) return;
      const [generation, compare] = oldest;
      // A page prepends older messages at the head; live messages that land
      // while the fetch is in flight append at the tail. Wait for the head to
      // change so a mid-flight live update cannot consume the snapshot before
      // the page commits (which would silently skip the split-turn detection).
      // Compare raw message ids, not the compact-mode aggregate ids: a page
      // that extends an aggregated run re-keys the synthetic summary id, but
      // the run members keep their daemon ids.
      if (compare.ids.has(first.id)) return;
      const newTurnIds: string[] = [];
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (
          !message ||
          !isTurnStartMessage(message) ||
          compare.ids.has(message.id)
        ) {
          continue;
        }
        let tailShown = false;
        for (let j = i + 1; j < messages.length; j++) {
          const next = messages[j];
          if (isTurnStartMessage(next)) break;
          if (compare.ids.has(next.id)) {
            tailShown = true;
            break;
          }
        }
        if (tailShown) newTurnIds.push(message.id);
      }
      if (newTurnIds.length === 0) {
        // A changed head while the load is resolved is the page landing, so
        // consume the snapshot even when it completed no split turn —
        // otherwise every later transcript update rescans it for the rest of
        // the session. While the load is still in flight a head change is
        // not the page (a transcript reload or session/branch switch);
        // discarding the snapshot there would let the page commit that
        // follows silently skip detection — the split turn collapses again,
        // the bug this code exists to fix.
        if (!compare.resolved) return;
      } else {
        setPaginatedExpandedTurns((prev) => {
          let next: Set<string> | null = null;
          for (const id of newTurnIds) {
            if (!prev.has(id)) {
              next ??= new Set(prev);
              next.add(id);
            }
          }
          return next ?? prev;
        });
      }
      pending.delete(generation);
      // The page that just committed is visible now: fold its ids into any
      // newer pending snapshot so that load's detection still recognizes the
      // tail a mid-turn page boundary showed.
      for (const remaining of pending.values()) {
        for (const message of messages) {
          if (message) remaining.ids.add(message.id);
        }
      }
    }, [messages]);

    useEffect(() => {
      const pendingGeneration = pendingOlderHistoryTopLoad.current;
      if (
        pendingGeneration === undefined ||
        loadingOlderHistory ||
        olderHistoryAnchor ||
        olderHistoryLoadInFlight.current
      ) {
        return;
      }
      pendingOlderHistoryTopLoad.current = undefined;
      if (
        !hasOlderHistory ||
        pendingGeneration !== olderHistoryLoadGeneration.current
      ) {
        return;
      }
      const el = getScrollElement();
      if (el && el.scrollTop <= LOAD_OLDER_HISTORY_THRESHOLD_PX) {
        void loadOlderHistory(true);
      }
    }, [
      getScrollElement,
      hasOlderHistory,
      loadOlderHistory,
      loadingOlderHistory,
      olderHistoryAnchor,
    ]);

    // Rules 2 & 3: detect scroll direction to toggle follow mode.
    // Runs synchronously in the scroll handler — no rAF needed since
    // the browser already coalesces scroll events.
    const handleScroll = useCallback(() => {
      const el = getScrollElement();
      if (!el) return;
      const curr = el.scrollTop;
      if (hasOlderHistory && curr <= LOAD_OLDER_HISTORY_THRESHOLD_PX) {
        void loadOlderHistory(true);
      }
      const hasUserScrollIntent = Date.now() <= userScrollIntentUntil.current;
      if (scrollCooldown.current && !hasUserScrollIntent) {
        lastScrollTop.current = curr;
        return;
      }
      scheduleSessionTimelineRangeUpdate();
      const prev = lastScrollTop.current;
      lastScrollTop.current = curr;
      const distanceFromBottom = el.scrollHeight - curr - el.clientHeight;
      scheduleScrollOverflowReport();

      // Rule 2: scrolling up → pause follow
      if (curr < prev - 1) {
        // Container resizes can clamp scrollTop downward while the viewport is
        // still at the tail. Treat that as follow mode, not a manual scroll-up.
        const isNearBottom = distanceFromBottom < FOLLOW_BOTTOM_THRESHOLD_PX;
        if (hasUserScrollIntent) {
          cancelTranscriptReload();
          followPausedByUserRef.current = true;
          setShouldFollow(false);
        } else if (isNearBottom) {
          followPausedByUserRef.current = false;
          setShouldFollow(true);
        } else if (!followPausedByUserRef.current) {
          cancelTranscriptReload();
          setShouldFollow(false);
        }
        return;
      }
      // Rule 3: near bottom → resume follow
      // Run only after non-upward scrolls. Otherwise a tiny wheel-up near the
      // tail would pause follow and immediately re-enable it in the same event.
      if (distanceFromBottom < FOLLOW_BOTTOM_THRESHOLD_PX) {
        followPausedByUserRef.current = false;
        setShouldFollow(true);
        scheduleTranscriptReload();
      } else {
        cancelTranscriptReload();
      }
    }, [
      getScrollElement,
      hasOlderHistory,
      loadOlderHistory,
      scheduleScrollOverflowReport,
      scheduleSessionTimelineRangeUpdate,
      scheduleTranscriptReload,
      cancelTranscriptReload,
      setShouldFollow,
    ]);

    useEffect(() => {
      const el = getScrollElement();
      if (!el) return;
      el.addEventListener('scroll', handleScroll, { passive: true });
      return () => el.removeEventListener('scroll', handleScroll);
    }, [getScrollElement, handleScroll]);

    const loadOlderHistoryIfUnderfilled = useCallback(() => {
      if (
        !hasOlderHistory ||
        loadingOlderHistory ||
        catchingUp ||
        showLoadingSkeleton
      ) {
        return;
      }
      const el = getScrollElement();
      if (!el || el.scrollHeight > el.clientHeight + 1) return;
      const previousLoad = lastUnderfillAutoLoad.current;
      if (
        previousLoad !== null &&
        previousLoad.loader === onLoadOlderHistory &&
        previousLoad.totalVirtualSize === totalVirtualSize
      ) {
        olderHistoryRetryBlocked.current = true;
        return;
      }
      lastUnderfillAutoLoad.current = {
        loader: onLoadOlderHistory,
        totalVirtualSize,
      };
      void loadOlderHistory();
    }, [
      catchingUp,
      getScrollElement,
      hasOlderHistory,
      loadOlderHistory,
      loadingOlderHistory,
      onLoadOlderHistory,
      showLoadingSkeleton,
      totalVirtualSize,
    ]);

    useEffect(() => {
      loadOlderHistoryIfUnderfilled();
    }, [loadOlderHistoryIfUnderfilled, totalVirtualSize]);

    useEffect(() => {
      const el = getScrollElement();
      if (!el) return;
      const loadOlderHistoryAtTop = () => {
        olderHistoryTopCheckFrame.current = undefined;
        if (el.scrollTop > LOAD_OLDER_HISTORY_THRESHOLD_PX) return;
        if (loadingOlderHistory || olderHistoryLoadInFlight.current) {
          pendingOlderHistoryTopLoad.current =
            olderHistoryLoadGeneration.current;
          return;
        }
        void loadOlderHistory(true);
      };
      const scheduleOlderHistoryTopCheck = () => {
        if (olderHistoryTopCheckFrame.current !== undefined) {
          cancelAnimationFrame(olderHistoryTopCheckFrame.current);
        }
        olderHistoryTopCheckFrame.current = requestAnimationFrame(
          loadOlderHistoryAtTop,
        );
      };
      const markFromWheel = (event: WheelEvent) => {
        markUserScrollIntent();
        if (event.deltaY < 0) scheduleOlderHistoryTopCheck();
      };
      const markFromTouch = () => {
        markUserScrollIntent();
      };
      const markFromTouchMove = () => scheduleOlderHistoryTopCheck();
      const markFromPointer = (event: PointerEvent) => {
        const rect = el.getBoundingClientRect();
        const scrollbarEdge = 20;
        if (
          event.clientX >= rect.right - scrollbarEdge ||
          event.clientY >= rect.bottom - scrollbarEdge
        ) {
          markUserScrollIntent();
        }
      };
      const markFromKey = (event: KeyboardEvent) => {
        if (
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown' ||
          event.key === 'PageUp' ||
          event.key === 'PageDown' ||
          event.key === 'Home' ||
          event.key === 'End' ||
          event.key === ' '
        ) {
          markUserScrollIntent();
          if (
            event.key === 'ArrowUp' ||
            event.key === 'PageUp' ||
            event.key === 'Home'
          ) {
            scheduleOlderHistoryTopCheck();
          }
        }
      };
      el.addEventListener('wheel', markFromWheel, { passive: true });
      el.addEventListener('touchstart', markFromTouch, {
        passive: true,
      });
      el.addEventListener('touchmove', markFromTouchMove, { passive: true });
      el.addEventListener('pointerdown', markFromPointer, { passive: true });
      el.addEventListener('keydown', markFromKey, { passive: true });
      return () => {
        el.removeEventListener('wheel', markFromWheel);
        el.removeEventListener('touchstart', markFromTouch);
        el.removeEventListener('touchmove', markFromTouchMove);
        el.removeEventListener('pointerdown', markFromPointer);
        el.removeEventListener('keydown', markFromKey);
        if (olderHistoryTopCheckFrame.current !== undefined) {
          cancelAnimationFrame(olderHistoryTopCheckFrame.current);
          olderHistoryTopCheckFrame.current = undefined;
        }
      };
    }, [
      getScrollElement,
      loadOlderHistory,
      loadingOlderHistory,
      markUserScrollIntent,
    ]);

    useEffect(() => {
      const el = getScrollElement();
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        scheduleScrollOverflowReport();
        loadOlderHistoryIfUnderfilled();
        if (catchingUpRef.current || followPausedByUserRef.current) return;
        setShouldFollow(true);
        scrollToBottom();
      });
      observer.observe(el);
      for (const child of Array.from(el.children)) {
        observer.observe(child);
      }
      const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement) observer.observe(node);
          }
          for (const node of Array.from(mutation.removedNodes)) {
            if (node instanceof HTMLElement) observer.unobserve(node);
          }
        }
        scheduleScrollOverflowReport();
      });
      mutationObserver.observe(el, { childList: true });
      scheduleScrollOverflowReport();
      return () => {
        observer.disconnect();
        mutationObserver.disconnect();
      };
    }, [
      getScrollElement,
      loadOlderHistoryIfUnderfilled,
      scheduleScrollOverflowReport,
      scrollToBottom,
      setShouldFollow,
    ]);

    // Clear screen (e.g. /clear) → reset to follow mode, drop stale per-turn
    // collapse overrides, and disarm any deferred scroll so it can't fire
    // against the next session.
    useEffect(() => {
      if (messages.length === 0) {
        followPausedByUserRef.current = false;
        pendingBottomFollowAfterCooldown.current = false;
        setShouldFollow(true);
        pendingScrollRef.current = null;
        // Drop the in-flight pagination snapshots too: without this a stale
        // pre-clear snapshot survives into the next session and can mislabel
        // a complete turn as keep-open (block ids are per-session ordinals).
        pendingPaginationTurnCompares.current.clear();
        setCollapseOverrides((prev) => (prev.size ? new Map() : prev));
        setPaginatedExpandedTurns((prev) => (prev.size ? new Set() : prev));
      }
    }, [messages.length, setShouldFollow]);

    // Container-resize guard: when floating panels (e.g. TodoPanel)
    // appear or disappear the scroll container's clientHeight changes.
    // Snap back to bottom so the user doesn't lose their place while
    // follow mode is active.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        scheduleSessionTimelineRangeUpdate();
        if (catchingUpRef.current) return;
        if (followPausedByUserRef.current) return;
        setShouldFollow(true);
        requestAnimationFrame(() => {
          if (!catchingUpRef.current && !followPausedByUserRef.current) {
            scrollToBottom();
          }
        });
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [scrollToBottom, scheduleSessionTimelineRangeUpdate, setShouldFollow]);

    // Rule 4: new user message → force follow on so the model's reply
    // scrolls into view as it streams in.
    useLayoutEffect(() => {
      const lastId = getLastUserMessageId(messages);
      if (catchingUp || loadingTranscript || prevLoadingTranscript.current) {
        prevLastUserMsgId.current = lastId;
        didTrackLastUserMsgRef.current = true;
        pendingNewUserSmoothScroll.current = false;
        prevLoadingTranscript.current = loadingTranscript;
        return;
      }
      prevLoadingTranscript.current = loadingTranscript;
      if (!didTrackLastUserMsgRef.current) {
        prevLastUserMsgId.current = lastId;
        didTrackLastUserMsgRef.current = true;
        pendingNewUserSmoothScroll.current = false;
        return;
      }
      const lastMessage = getLastMessage(messages);
      if (
        lastId &&
        lastMessage?.role === 'user' &&
        lastId !== prevLastUserMsgId.current
      ) {
        followPausedByUserRef.current = false;
        setShouldFollow(true);
        // A new prompt supersedes any pending "Show in transcript" scroll.
        pendingScrollRef.current = null;
        pendingNewUserSmoothScroll.current = true;
      } else {
        pendingNewUserSmoothScroll.current = false;
      }
      prevLastUserMsgId.current = lastId;
    }, [messages, catchingUp, loadingTranscript, setShouldFollow]);

    // Rule 5: session restore — when catchingUp flips from true → falsy,
    // replay just finished. Scroll to bottom once so the user sees the
    // latest content without the viewport fighting the replay.
    useLayoutEffect(() => {
      if (prevCatchingUp.current && !catchingUp) {
        followPausedByUserRef.current = false;
        setShouldFollow(true);
        scrollToBottom('auto');
      }
      prevCatchingUp.current = catchingUp;
    }, [catchingUp, scrollToBottom, setShouldFollow]);

    useLayoutEffect(() => {
      if (loadingTranscript) {
        pendingTranscriptBottomScroll.current = true;
        return;
      }
      if (!pendingTranscriptBottomScroll.current) return;
      if (catchingUp || messages.length === 0) return;

      pendingTranscriptBottomScroll.current = false;
      followPausedByUserRef.current = false;
      setShouldFollow(true);
      pendingScrollRef.current = null;

      if (transcriptBottomScrollFrame.current !== undefined) {
        window.cancelAnimationFrame(transcriptBottomScrollFrame.current);
      }
      if (transcriptBottomScrollSettleFrame.current !== undefined) {
        window.cancelAnimationFrame(transcriptBottomScrollSettleFrame.current);
      }
      const scrollIfStillFollowing = () => {
        if (catchingUpRef.current || followPausedByUserRef.current) return;
        setShouldFollow(true);
        scrollToBottom('auto');
      };

      transcriptBottomScrollFrame.current = window.requestAnimationFrame(() => {
        transcriptBottomScrollFrame.current = undefined;
        scrollIfStillFollowing();
        transcriptBottomScrollSettleFrame.current =
          window.requestAnimationFrame(() => {
            transcriptBottomScrollSettleFrame.current = undefined;
            scrollIfStillFollowing();
          });
      });
    }, [
      catchingUp,
      loadingTranscript,
      messages.length,
      scrollToBottom,
      setShouldFollow,
    ]);

    useLayoutEffect(() => {
      const insetChanged =
        prevBottomOverlayInset.current !== bottomOverlayInset;
      prevBottomOverlayInset.current = bottomOverlayInset;
      if (!insetChanged) return;
      if (catchingUp) return;
      if (followPausedByUserRef.current) return;
      setShouldFollow(true);
      requestAnimationFrame(() => {
        if (!catchingUpRef.current && !followPausedByUserRef.current) {
          scrollToBottom('auto');
        }
      });
    }, [bottomOverlayInset, catchingUp, scrollToBottom, setShouldFollow]);

    const runningExecutionKey = useMemo(
      () => latestActiveExecutionKey(visibleItems),
      [visibleItems],
    );

    // Tool summaries and parallel-agent boxes can grow after their first
    // render, which used to leave the row clipped behind the fixed composer.
    // Instead of observing every row resize (too noisy while streaming), scroll
    // once when a new execution row starts, and only while the user is already
    // following the bottom.
    useLayoutEffect(() => {
      if (catchingUp) return;
      if (!runningExecutionKey) {
        prevActiveExecutionKey.current = null;
        return;
      }
      if (runningExecutionKey === prevActiveExecutionKey.current) return;
      prevActiveExecutionKey.current = runningExecutionKey;
      if (shouldFollow.current || !followPausedByUserRef.current) {
        requestAnimationFrame(() => {
          if (!followPausedByUserRef.current) {
            setShouldFollow(true);
            scrollToBottom();
          }
        });
      }
    }, [catchingUp, runningExecutionKey, scrollToBottom, setShouldFollow]);

    // Rule 6: an inline picker/dialog (tailContent) just appeared. It renders
    // at the very bottom of the virtualized list, so if the user had scrolled
    // up it would open below the fold and the action would look like a no-op.
    // Only opt-in callers (autoScrollTailIntoView) force-follow it into view, so
    // unrelated tail panels keep the reader's scroll position.
    useEffect(() => {
      if (
        autoScrollTailIntoView &&
        hasTailContent &&
        !prevHasTailContent.current
      ) {
        followPausedByUserRef.current = false;
        setShouldFollow(true);
        // Re-check follow inside the frame: if the user scrolls up in the gap
        // before it fires (Rule 2 clears the flag), don't fight them.
        requestAnimationFrame(() => {
          if (!followPausedByUserRef.current) scrollToBottom();
        });
      }
      prevHasTailContent.current = hasTailContent;
    }, [
      autoScrollTailIntoView,
      hasTailContent,
      scrollToBottom,
      setShouldFollow,
    ]);

    const renderVirtualItem = useCallback(
      (index: number) => {
        const renderDisplayItem = (displayItem: DisplayItem): ReactNode => {
          if (displayItem.type === 'parallel_agents') {
            return (
              <MessageTimestamp timestamp={displayItem.timestamp}>
                <div
                  className={
                    displayItemMatchesLocateTarget(displayItem, flashTarget)
                      ? flashStyles.flash
                      : undefined
                  }
                >
                  <ParallelAgentsGroup
                    agents={displayItem.agents}
                    autoManageExpansion={
                      transcriptRenderMode === 'interactive' && !catchingUp
                    }
                    automaticCollapseDelayMs={
                      backgroundSummaryAgentContext.key === displayItem.key &&
                      !latestTurnAwaitsAgentSummary
                        ? AGENT_SUMMARY_COLLAPSE_DELAY_MS
                        : undefined
                    }
                    deferAutomaticCollapse={
                      // Defer only while the completion narration is still
                      // expected after the group's last agent notification.
                      // A group whose agents are all terminal otherwise
                      // collapses — and returns to its chronological
                      // position — even while the main agent keeps working.
                      backgroundSummaryAgentContext.key === displayItem.key &&
                      latestTurnAwaitsAgentSummary
                    }
                    expandActiveWhenLive={
                      isResponding &&
                      latestTurnParallelAgentKeys.has(displayItem.key)
                    }
                    onAutomaticExpansionChange={(expanded) =>
                      handleAutomaticAgentExpansionChange(
                        displayItem.key,
                        expanded,
                      )
                    }
                    pendingApproval={pendingApproval}
                  />
                </div>
              </MessageTimestamp>
            );
          }

          if (displayItem.type === 'turn_outputs') {
            return (
              <TurnOutputs
                changes={displayItem.changes}
                turnId={displayItem.turnId}
                artifacts={displayItem.artifacts}
                scheduledTasks={displayItem.scheduledTasks}
                workspaceCwd={workspaceCwd}
                onOpenRequest={onTurnOutputOpen}
                onReviewChanges={onReviewChanges ?? noopTurnOutputAction}
                onOpenArtifact={onOpenArtifact ?? noopTurnOutputAction}
                onOpenScheduledTask={
                  onOpenScheduledTask ?? noopTurnOutputAction
                }
                onError={onError}
              />
            );
          }

          if (displayItem.type === 'turn_collapse') {
            return (
              <TurnCollapseRow
                turnCollapse={displayItem.turnCollapse}
                onToggleCollapse={handleToggleCollapse}
              />
            );
          }

          const finalAssistantTurnId =
            displayItem.message.role === 'assistant'
              ? finalAssistantTurnIdByAssistantId.get(displayItem.message.id)
              : undefined;
          let assistantTurnFooterInfo:
            | WebShellAssistantTurnFooterRenderInfo
            | undefined;
          if (
            displayItem.message.role === 'assistant' &&
            finalAssistantTurnId
          ) {
            assistantTurnFooterInfo = {
              turnId: finalAssistantTurnId,
              message: {
                id: displayItem.message.id,
                content: displayItem.message.content,
                isStreaming: displayItem.message.isStreaming,
                timestamp: displayItem.message.timestamp,
              },
            };
          }
          const branchRecordId =
            displayItem.message.role === 'assistant'
              ? displayItem.message.branchRecordId
              : undefined;

          return (
            <MessageItem
              message={displayItem.message}
              pendingApproval={pendingApproval}
              onShowContextDetail={onShowContextDetail}
              onImagePreview={onImagePreview}
              onAttachmentPreview={onAttachmentPreview}
              workspaceCwd={workspaceCwd}
              showRetryHint={showRetryHint}
              onRetryClick={onRetryClick}
              sendFailed={
                displayItem.message.role === 'user' &&
                displayItem.message.id === failedPromptMessageId
              }
              onRetrySend={onRetryFailedPrompt}
              onBranchSession={onBranchSession}
              branchRecordId={branchRecordId}
              showAssistantActions={
                displayItem.message.role === 'assistant' &&
                finalAssistantTurnIdByAssistantId.has(displayItem.message.id)
              }
              showAssistantBranch={
                displayItem.message.role === 'assistant' &&
                !isResponding &&
                branchRecordId !== undefined
              }
              isLocateFlashing={displayItemMatchesLocateTarget(
                displayItem,
                flashTarget,
              )}
              assistantTurnFooterInfo={assistantTurnFooterInfo}
              generateContent={generateContent}
            />
          );
        };

        if (hasHeader && index === HEADER_INDEX) {
          return welcomeHeader;
        }

        if (hasTailContent && index === tailContentIndex) {
          return tailContent;
        }

        const itemIndex = index - headerOffset;
        const item = visibleItems[itemIndex];
        if (!item) return null;

        return renderDisplayItem(item);
      },
      [
        hasHeader,
        welcomeHeader,
        hasTailContent,
        tailContent,
        tailContentIndex,
        pendingApproval,
        catchingUp,
        isResponding,
        latestTurnAwaitsAgentSummary,
        latestTurnParallelAgentKeys,
        backgroundSummaryAgentContext,
        transcriptRenderMode,
        handleAutomaticAgentExpansionChange,
        onShowContextDetail,
        onImagePreview,
        onAttachmentPreview,
        generateContent,
        headerOffset,
        visibleItems,
        flashTarget,
        finalAssistantTurnIdByAssistantId,
        workspaceCwd,
        showRetryHint,
        onRetryClick,
        failedPromptMessageId,
        onRetryFailedPrompt,
        onBranchSession,
        handleToggleCollapse,
        onOpenArtifact,
        onOpenScheduledTask,
        onReviewChanges,
        onTurnOutputOpen,
        onError,
      ],
    );

    const getRowClassName = useCallback(
      (item?: DisplayItem): string | undefined =>
        item ? getChatRowClassName(item) : undefined,
      [],
    );
    const autoScrollContentSignal = useVirtualScroll
      ? totalVirtualSize
      : messages;

    // ── Single auto-scroll driver (rules 1, 5, 6) ──────────────────────
    // Fires whenever the virtualizer's total content height changes —
    // this captures every scenario: streaming tokens appending, tool
    // cards expanding/collapsing, approval cards appearing, etc.
    //
    // Rule 5: during replay (catchingUp) → skip, avoid fighting rapid
    //         transcript replay. The catchingUp→ready transition effect
    //         above handles the final scroll.
    // Rule 1: when shouldFollow is true → scroll to bottom.
    // Rule 6: scrollToBottom itself checks scrollHeight <= clientHeight
    //         and is a no-op when there's no overflow.
    useLayoutEffect(() => {
      if (catchingUp) return;
      const isNewUserMessage = pendingNewUserSmoothScroll.current;
      if (scrollCooldown.current && !isNewUserMessage) {
        if (!followPausedByUserRef.current) {
          pendingBottomFollowAfterCooldown.current = true;
        }
        return;
      }
      // Preserve the new-prompt scroll even if a previous disclosure resize is
      // still settling; it targets the latest virtualizer size from this render.
      if (pendingFollowRecheck.current && !isNewUserMessage) return;
      if (
        shouldFollow.current ||
        isNewUserMessage ||
        !followPausedByUserRef.current
      ) {
        if (!followPausedByUserRef.current) {
          setShouldFollow(true);
        }
        scrollToBottom(isNewUserMessage ? 'smooth' : 'auto');
        pendingNewUserSmoothScroll.current = false;
      }
    }, [
      autoScrollContentSignal,
      totalCount,
      catchingUp,
      scrollToBottom,
      setShouldFollow,
    ]);

    useLayoutEffect(() => {
      scheduleScrollOverflowReport();
    }, [autoScrollContentSignal, scheduleScrollOverflowReport, totalCount]);

    return (
      <div
        ref={containerRef}
        className={joinClassNames(
          styles.list,
          hasHeader && centerWelcomeHeader
            ? styles.listWithWelcomeHeader
            : undefined,
        )}
        data-web-shell-message-list
        onClickCapture={handleDisclosureClickCapture}
      >
        {showLoadingSkeleton && (
          <LoadingTranscriptSkeleton label={t('editor.sessionLoading')} />
        )}
        {loadingOlderHistory &&
          !showLoadingSkeleton &&
          !suppressOlderHistoryLoadingStatus && (
            <div className={styles.historyStatus} role="status">
              {t('history.loadingEarlier')}
            </div>
          )}
        {historyCapacityReached && !showLoadingSkeleton && (
          <div className={styles.historyStatus} role="status">
            {t('history.capacityReached')}
          </div>
        )}
        {historyPaginationError &&
          !showLoadingSkeleton &&
          !historyCapacityReached && (
            <div className={styles.historyStatus}>
              <span role="status">{t('history.paginationError')}</span>
              {onLoadOlderHistory && (
                <button
                  type="button"
                  className={styles.historyRetryButton}
                  onClick={retryOlderHistory}
                >
                  {t('history.retry')}
                </button>
              )}
            </div>
          )}
        <SessionTimeline
          entries={sessionTimelineEntries}
          currentTurnId={currentTimelineTurnId}
          currentRange={sessionTimelineRange}
          hidden={!isSessionTimelineVisible || !hasEnoughSessionTimelineEntries}
          onSelect={scrollToMessage}
        />
        {useVirtualScroll ? (
          <div ref={virtualizer.containerRef} className={styles.virtualSizer}>
            {virtualItems.map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={measureVirtualRow}
                className={joinClassNames(
                  styles.virtualRow,
                  getRowClassName(
                    visibleItems[virtualRow.index - headerOffset],
                  ),
                )}
                data-message-row-key={String(getItemKey(virtualRow.index))}
                data-source-block-ids={displayItemSourceBlockIds(
                  visibleItems[virtualRow.index - headerOffset],
                )}
                data-web-shell-message-row
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                }}
              >
                {renderVirtualItem(virtualRow.index)}
              </div>
            ))}
          </div>
        ) : (
          Array.from({ length: totalCount }, (_, index) => {
            const key = getItemKey(index);
            const item = visibleItems[index - headerOffset];
            return (
              <div
                key={key}
                data-index={index}
                className={getRowClassName(item)}
                data-message-row-key={String(key)}
                data-source-block-ids={displayItemSourceBlockIds(item)}
                data-web-shell-message-row
              >
                {renderVirtualItem(index)}
              </div>
            );
          })
        )}
      </div>
    );
  }),
);
