import {
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  CommandInfo,
  Message,
  ACPToolCall,
  TurnCollapseHead,
} from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import {
  isBackgroundSubAgentToolCall,
  isSubAgentToolCall,
} from '../adapters/toolClassification';
import { CompactModeContext } from '../App';
import { useWebShellCustomization } from '../customization';
import { MessageItem } from './MessageItem';
import { MessageTimestamp } from './MessageTimestamp';
import { ParallelAgentsGroup } from './messages/tools/ParallelAgentsGroup';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import { toolContainsCallId } from './messages/toolFormatting';
import styles from './MessageList.module.css';

interface MessageListProps {
  messages: Message[];
  pendingApproval: PermissionRequest | null;
  onConfirm: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  catchingUp?: boolean;
  /**
   * True while the agent is still answering. The newest turn then stays
   * expanded and un-collapsible so streaming output is never hidden.
   */
  isResponding?: boolean;
  welcomeHeader?: ReactNode;
  workspaceCwd?: string;
  tailContent?: ReactNode;
  tailKey?: string;
  virtualScrollThreshold?: number;
  shellOutputMaxLines: number;
  commands?: readonly CommandInfo[];
  /**
   * When true, scroll the tail content into view the moment it first appears
   * even if the user had scrolled up. Opt-in per caller so unrelated inline
   * panels don't yank the reader to the bottom. Defaults to false.
   */
  autoScrollTailIntoView?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
}

function isAskUserQuestion(request: PermissionRequest): boolean {
  return (
    !!request.rawInput?.questions && Array.isArray(request.rawInput.questions)
  );
}

function approvalMatchesToolGroup(
  messages: Message[],
  approval: PermissionRequest | null,
): boolean {
  if (!approval?.toolCallId) return false;
  for (const msg of messages) {
    if (msg.role === 'tool_group') {
      if (msg.tools.some((t) => toolContainsCallId(t, approval.toolCallId!)))
        return true;
    }
  }
  return false;
}

function getLastUserMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') return msg.id;
  }
  return null;
}

export type DisplayItem =
  | {
      type: 'message';
      key: string;
      message: Message;
      /**
       * Present only on a turn's leading user-message row when the turn is
       * collapsible; drives the prompt-row expand/collapse toggle.
       */
      collapse?: TurnCollapseHead;
    }
  | {
      type: 'parallel_agents';
      key: string;
      agents: ACPToolCall[];
      /**
       * Wall-clock time of the first grouped launch, carried so the grouped
       * box reveals its time on hover exactly like a standalone message row.
       */
      timestamp?: number;
    };

function isAgentOnlyToolGroup(msg: Message): boolean {
  return (
    msg.role === 'tool_group' &&
    msg.tools.length === 1 &&
    isSubAgentToolCall(msg.tools[0])
  );
}

function isBackgroundAgentOnlyToolGroup(msg: Message): boolean {
  return (
    msg.role === 'tool_group' &&
    msg.tools.length === 1 &&
    isBackgroundSubAgentToolCall(msg.tools[0])
  );
}

function isBackgroundLaunchNarration(msg: Message): boolean {
  // The daemon often streams short main-agent thought text between background
  // launches, e.g. "agent A is running, now starting agent B". The CLI treats
  // those as internal launch narration and shows a single Parallel agents box.
  // Only skip thought-only messages here; any user-facing assistant content
  // still breaks the group and remains visible.
  return msg.role === 'assistant' && Boolean(msg.thinking) && !msg.content;
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

function isHiddenInCompactMode(msg: Message): boolean {
  if (msg.role === 'assistant' && msg.thinking && !msg.content) return true;
  return false;
}

function mergeCompactToolGroups(
  messages: Message[],
  pendingApproval: PermissionRequest | null,
): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== 'tool_group' || isForceExpandGroup(msg, pendingApproval)) {
      if (!isHiddenInCompactMode(msg)) {
        result.push(msg);
      }
      i++;
      continue;
    }

    const mergeableGroups: Message[] = [msg];
    let lastMergedIdx = i;
    let j = i + 1;

    while (j < messages.length) {
      const next = messages[j];

      if (isHiddenInCompactMode(next)) {
        j++;
        continue;
      }

      if (
        next.role === 'tool_group' &&
        !isForceExpandGroup(next, pendingApproval)
      ) {
        mergeableGroups.push(next);
        lastMergedIdx = j;
        j++;
        continue;
      }

      break;
    }

    if (mergeableGroups.length === 1) {
      result.push(msg);
      i++;
      continue;
    }

    const mergedTools = mergeableGroups.flatMap((g) =>
      g.role === 'tool_group' ? g.tools : [],
    );
    result.push({
      id: mergeableGroups[0].id,
      role: 'tool_group',
      tools: mergedTools,
    });
    i = lastMergedIdx + 1;
  }

  return result;
}

export function groupParallelAgents(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < messages.length) {
    if (isBackgroundAgentOnlyToolGroup(messages[i])) {
      const grouped: Message[] = [];
      let j = i;
      while (j < messages.length) {
        const current = messages[j];
        if (isBackgroundAgentOnlyToolGroup(current)) {
          grouped.push(current);
          j++;
          continue;
        }
        if (isBackgroundLaunchNarration(current)) {
          let nextAgentIdx = j + 1;
          while (
            nextAgentIdx < messages.length &&
            isBackgroundLaunchNarration(messages[nextAgentIdx])
          ) {
            nextAgentIdx++;
          }
          if (
            nextAgentIdx < messages.length &&
            isBackgroundAgentOnlyToolGroup(messages[nextAgentIdx])
          ) {
            j = nextAgentIdx;
            continue;
          }
        }
        break;
      }

      if (grouped.length >= 2) {
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          agents: grouped.map((m) => (m as { tools: ACPToolCall[] }).tools[0]),
          timestamp: grouped[0].timestamp,
        });
        i = j;
        continue;
      }
    }

    if (isAgentOnlyToolGroup(messages[i])) {
      const start = i;
      while (i < messages.length && isAgentOnlyToolGroup(messages[i])) i++;
      if (i - start >= 2) {
        const grouped = messages.slice(start, i);
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          agents: grouped.map((m) => (m as { tools: ACPToolCall[] }).tools[0]),
          timestamp: grouped[0].timestamp,
        });
      } else {
        items.push({
          type: 'message',
          key: messages[start].id,
          message: messages[start],
        });
      }
    } else {
      items.push({
        type: 'message',
        key: messages[i].id,
        message: messages[i],
      });
      i++;
    }
  }
  return items;
}

export function getDisplayItemVirtualKey(item: DisplayItem): string {
  return item.type === 'parallel_agents'
    ? `group:${item.key}`
    : `msg:${item.key}`;
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
  /**
   * Tool-call id of a pending approval, if any. The turn containing it is
   * force-expanded so the inline approve/reject UI is never folded away (mirrors
   * compact mode's `isForceExpandGroup`).
   */
  pendingApprovalCallId?: string | null;
  /** Master switch; when false the items pass through untouched. */
  enabled: boolean;
}

function isAssistantAnswer(item: DisplayItem): boolean {
  return (
    item.type === 'message' &&
    item.message.role === 'assistant' &&
    // `content` is typed `string`, but daemon SSE text can be undefined at
    // runtime (transcriptToMessages copies `textBlock.text` through). Guard it:
    // `applyTurnCollapse` runs in render, so a bare `.trim()` would blank the
    // whole transcript.
    !!item.message.content &&
    item.message.content.trim().length > 0
  );
}

/**
 * A turn's hideable "steps": tool activity, plans, and mid-turn assistant text.
 * The final answer and any system/shell/insight rows (errors, cancellations,
 * command output) are kept visible even when the turn is collapsed.
 */
function isHideableStep(item: DisplayItem, isFinalAnswer: boolean): boolean {
  if (item.type === 'parallel_agents') return true;
  switch (item.message.role) {
    case 'tool_group':
    case 'plan':
      return true;
    case 'assistant':
      return !isFinalAnswer;
    case 'user':
    case 'system':
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = item.message;
      return false;
    }
  }
}

function isExecutionWorkStep(item: DisplayItem): boolean {
  if (item.type === 'parallel_agents') return true;
  return item.message.role === 'tool_group' || item.message.role === 'plan';
}

/** Wall-clock stamp of a display row, whichever variant carries it. */
function itemTimestamp(item: DisplayItem): number | undefined {
  return item.type === 'message' ? item.message.timestamp : item.timestamp;
}

/**
 * Per-turn token usage contribution of a row. The SDK reducer folds each round's
 * usage — including the sub-agent rounds a turn spawns — onto the turn's
 * top-level assistant blocks, so summing the turn's assistant messages yields
 * its true total cost.
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

function itemToolCallCount(item: DisplayItem): number {
  if (item.type === 'parallel_agents') return item.agents.length;
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
    if (item.type === 'message' && item.message.role === 'user') {
      return item.message.id;
    }
  }
  return null;
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
/** Does any tool group / parallel-agents row in [start, end] own `callId`? */
function turnOwnsCallId(
  items: DisplayItem[],
  start: number,
  end: number,
  callId: string | null | undefined,
): boolean {
  if (!callId) return false;
  for (let i = start; i <= end; i++) {
    const item = items[i];
    if (item.type === 'parallel_agents') {
      if (item.agents.some((agent) => toolContainsCallId(agent, callId))) {
        return true;
      }
    } else if (item.message.role === 'tool_group') {
      if (item.message.tools.some((tool) => toolContainsCallId(tool, callId))) {
        return true;
      }
    }
  }
  return false;
}

export function applyTurnCollapse(
  items: DisplayItem[],
  {
    overrides,
    isResponding,
    pendingApprovalCallId,
    enabled,
  }: ApplyTurnCollapseOptions,
): DisplayItem[] {
  if (!enabled || items.length === 0) return items;

  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message' && item.message.role === 'user') {
      userIdxs.push(i);
    }
  }
  if (userIdxs.length === 0) return items;

  const result: DisplayItem[] = [];
  // Anything before the first prompt (e.g. a session-restore banner) is not
  // part of any turn and passes through verbatim.
  for (let i = 0; i < userIdxs[0]; i++) result.push(items[i]);

  for (let k = 0; k < userIdxs.length; k++) {
    const start = userIdxs[k];
    const end = (k + 1 < userIdxs.length ? userIdxs[k + 1] : items.length) - 1;
    const head = items[start] as Extract<DisplayItem, { type: 'message' }>;
    const turnId = head.message.id;
    const isActiveTurn = k === userIdxs.length - 1 && isResponding;
    const hasPendingApproval = turnOwnsCallId(
      items,
      start,
      end,
      pendingApprovalCallId,
    );

    // Final answer = last assistant-with-content row after the turn's last
    // non-assistant step. Assistant text that is followed by a tool/plan is
    // narration for the execution trace, not the final answer; marking it as a
    // step immediately keeps the trace indentation stable while a turn streams.
    let answerIdx = -1;
    let lastNonAssistantStepIdx = start;
    for (let i = start + 1; i <= end; i++) {
      if (isExecutionWorkStep(items[i])) lastNonAssistantStepIdx = i;
    }
    for (let i = end; i > lastNonAssistantStepIdx; i--) {
      if (isAssistantAnswer(items[i])) {
        answerIdx = i;
        break;
      }
    }

    let hiddenCount = 0;
    let lastStepTs: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let toolCallCount = 0;
    let hasUsage = false;
    for (let i = start + 1; i <= end; i++) {
      const isStep = isHideableStep(items[i], i === answerIdx);
      if (isStep) hiddenCount++;
      toolCallCount += itemToolCallCount(items[i]);
      const ts =
        isStep || i === answerIdx ? itemTimestamp(items[i]) : undefined;
      if (ts !== undefined) {
        lastStepTs = lastStepTs === undefined ? ts : Math.max(lastStepTs, ts);
      }
      const usage = itemAssistantUsage(items[i]);
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cachedTokens += usage.cachedTokens ?? 0;
        hasUsage = true;
      }
    }

    const promptTs = head.message.timestamp;
    const elapsedMs =
      promptTs !== undefined &&
      lastStepTs !== undefined &&
      lastStepTs >= promptTs
        ? lastStepTs - promptTs
        : undefined;
    const hasMetrics = hasUsage || elapsedMs !== undefined;

    if (hasPendingApproval || (hiddenCount === 0 && !hasMetrics)) {
      // Nothing to add: the inline approve/reject UI must stay reachable, or the
      // turn has neither foldable steps nor a measured metric. Emit it untouched.
      for (let i = start; i <= end; i++) result.push(items[i]);
      continue;
    }

    // A turn with foldable steps gets a chevron and defaults to expanded while
    // streaming, collapsed once complete. A step-less turn (e.g. a plain "hi"
    // reply) has nothing to fold, so it stays expanded and shows a chevron-less
    // metrics line. An explicit user toggle always wins.
    const expanded =
      hiddenCount === 0
        ? true
        : overrides.has(turnId)
          ? (overrides.get(turnId) as boolean)
          : isActiveTurn;
    const collapsed = !expanded;

    result.push({
      type: 'message',
      key: head.key,
      message: head.message,
      collapse: {
        turnId,
        collapsed,
        hiddenCount,
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(hasUsage ? { inputTokens, outputTokens } : {}),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
        ...(toolCallCount > 0 ? { toolCallCount } : {}),
        ...(isActiveTurn && promptTs !== undefined
          ? { liveStartedAt: promptTs }
          : {}),
      },
    });

    if (!collapsed) {
      for (let i = start + 1; i <= end; i++) {
        result.push(items[i]!);
      }
      continue;
    }

    // Collapsed: drop the hideable steps; keep the final answer (its own
    // thinking stripped) and any non-step rows (errors, cancellations, command
    // output) in their original places. On an active turn the "answer" is still
    // streaming, so fold it away too rather than strand a provisional line.
    for (let i = start + 1; i <= end; i++) {
      const item = items[i];
      if (i === answerIdx && isActiveTurn) continue;
      if (isHideableStep(item, i === answerIdx)) continue;
      if (
        i === answerIdx &&
        item.type === 'message' &&
        item.message.role === 'assistant' &&
        item.message.thinking
      ) {
        result.push({
          type: 'message',
          key: item.key,
          message: { ...item.message, thinking: undefined },
        });
      } else {
        result.push(item);
      }
    }
  }

  return result;
}

/**
 * Locate a display item by message id, falling back to the tool call id for
 * tool groups that were merged (compact mode) or grouped (parallel agents)
 * under another message's id.
 */
export function findDisplayItemIndex(
  items: readonly DisplayItem[],
  messageId: string,
  callId?: string,
): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message') {
      if (item.message.id === messageId) return i;
      if (
        callId &&
        item.message.role === 'tool_group' &&
        item.message.tools.some((tool) => toolContainsCallId(tool, callId))
      ) {
        return i;
      }
    } else if (
      callId &&
      item.agents.some((agent) => toolContainsCallId(agent, callId))
    ) {
      return i;
    }
  }
  return -1;
}

export interface MessageListHandle {
  /**
   * Scroll the transcript so the given message is visible and briefly
   * highlight it. Returns false when the message is not in the list.
   */
  scrollToMessage: (messageId: string, callId?: string) => boolean;
}

const HEADER_INDEX = 0;
const ESTIMATE_HEADER = 120;
const ESTIMATE_MESSAGE = 80;
const ESTIMATE_APPROVAL = 200;
const ESTIMATE_TAIL = 240;
export const VIRTUAL_SCROLL_THRESHOLD = 200;

export function shouldUseVirtualScroll(
  totalCount: number,
  threshold = VIRTUAL_SCROLL_THRESHOLD,
): boolean {
  return totalCount > threshold;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      pendingApproval,
      onConfirm,
      onShowContextDetail,
      catchingUp,
      isResponding = false,
      welcomeHeader,
      workspaceCwd,
      tailContent,
      tailKey = 'tail',
      virtualScrollThreshold = VIRTUAL_SCROLL_THRESHOLD,
      shellOutputMaxLines,
      commands,
      autoScrollTailIntoView = false,
      showRetryHint = false,
      onRetryClick,
    },
    ref,
  ) {
    const compactMode = useContext(CompactModeContext);
    const mergedMessages = useMemo(
      () =>
        compactMode
          ? mergeCompactToolGroups(messages, pendingApproval)
          : messages,
      [compactMode, messages, pendingApproval],
    );
    const displayItems = useMemo(
      () => groupParallelAgents(mergedMessages),
      [mergedMessages],
    );

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
    const handleToggleCollapse = useCallback((turnId: string) => {
      // (Un)folding a turn is the user reading history, not following the tail.
      // Pause follow so the height change does not yank the viewport to the
      // bottom — the toggled prompt row stays where it is on screen.
      shouldFollow.current = false;
      setCollapseOverrides((prev) => {
        const currentlyExpanded = prev.get(turnId) ?? false;
        const next = new Map(prev);
        next.set(turnId, !currentlyExpanded);
        return next;
      });
    }, []);
    const visibleItems = useMemo(
      () =>
        applyTurnCollapse(displayItems, {
          overrides: collapseOverrides,
          isResponding,
          pendingApprovalCallId: pendingApproval?.toolCallId ?? null,
          enabled: collapseEnabled,
        }),
      [
        displayItems,
        collapseOverrides,
        isResponding,
        pendingApproval?.toolCallId,
        collapseEnabled,
      ],
    );

    const containerRef = useRef<HTMLDivElement>(null);

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
    //      near the bottom (< 30px from edge), follow mode re-engages
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

    const shouldFollow = useRef(true);
    const lastScrollTop = useRef(0);
    const scrollCooldown = useRef(false);
    const scrollCooldownCount = useRef(0);
    const prevLastUserMsgId = useRef<string | null>(null);
    const prevCatchingUp: MutableRefObject<boolean | undefined> =
      useRef(catchingUp);
    const catchingUpRef = useRef(catchingUp);
    const prevHasTailContent = useRef(false);
    catchingUpRef.current = catchingUp;

    const hasTailApproval = useMemo(() => {
      if (!pendingApproval) return false;
      if (isAskUserQuestion(pendingApproval)) return true;
      return !approvalMatchesToolGroup(messages, pendingApproval);
    }, [pendingApproval, messages]);

    const hasTailContent = tailContent !== undefined && tailContent !== null;
    const hasHeader = !!welcomeHeader;
    const headerOffset = hasHeader ? 1 : 0;
    const tailApprovalIndex = headerOffset + visibleItems.length;
    const tailContentIndex = tailApprovalIndex + (hasTailApproval ? 1 : 0);
    const totalCount = tailContentIndex + (hasTailContent ? 1 : 0);
    const useVirtualScroll = shouldUseVirtualScroll(
      totalCount,
      virtualScrollThreshold,
    );

    const getItemKey = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) return 'slot:header';
        if (hasTailApproval && index === tailApprovalIndex) {
          return pendingApproval
            ? `slot:approval:${pendingApproval.id}`
            : 'slot:approval';
        }
        if (hasTailContent && index === tailContentIndex) {
          return `slot:tail:${tailKey}`;
        }
        const item = visibleItems[index - headerOffset];
        return item ? getDisplayItemVirtualKey(item) : `slot:row:${index}`;
      },
      [
        hasHeader,
        hasTailApproval,
        tailApprovalIndex,
        pendingApproval,
        hasTailContent,
        tailContentIndex,
        tailKey,
        visibleItems,
        headerOffset,
      ],
    );

    // Rule 6: skip if content doesn't overflow (no scrollbar).
    const scrollToBottom = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight) return;
      scrollCooldownCount.current += 1;
      const gen = scrollCooldownCount.current;
      scrollCooldown.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
      requestAnimationFrame(() => {
        if (scrollCooldownCount.current === gen) {
          scrollCooldown.current = false;
        }
      });
    }, []);

    const virtualizer = useVirtualizer({
      count: totalCount,
      enabled: useVirtualScroll,
      getScrollElement: () => containerRef.current,
      getItemKey,
      estimateSize: (index) => {
        if (hasHeader && index === HEADER_INDEX) return ESTIMATE_HEADER;
        if (hasTailApproval && index === tailApprovalIndex) {
          return ESTIMATE_APPROVAL;
        }
        if (hasTailContent && index === tailContentIndex) return ESTIMATE_TAIL;
        return ESTIMATE_MESSAGE;
      },
      overscan: 20,
      useFlushSync: false,
      useAnimationFrameWithResizeObserver: true,
    });

    // Imperative scroll-to-message (e.g. the floating TodoPanel's "show in
    // transcript" button) with a brief highlight on the target row.
    const [flashKey, setFlashKey] = useState<string | null>(null);
    useEffect(() => {
      if (!flashKey) return;
      const timer = setTimeout(() => setFlashKey(null), 1600);
      return () => clearTimeout(timer);
    }, [flashKey]);

    // Scroll a visible row to center and flash it.
    const performScrollToRow = useCallback(
      (rowIndex: number) => {
        // Explicit navigation away from the tail — pause follow so the
        // auto-scroll driver doesn't yank the viewport straight back down,
        // and engage the same cooldown scrollToBottom uses so the scroll
        // events this triggers short-circuit handleScroll. Without it, Rule 3
        // (near-bottom → resume follow) would re-enable follow whenever the
        // target sits near the bottom, and the next streaming height change
        // would pull the viewport back to the tail. An instant (non-smooth)
        // scroll keeps that cooldown window short and deterministic.
        shouldFollow.current = false;
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
          }
        }, 150);
        const key = getItemKey(rowIndex);
        setFlashKey(null);
        requestAnimationFrame(() => setFlashKey(key));
      },
      [useVirtualScroll, virtualizer, getItemKey],
    );

    // A scroll target that currently sits inside a collapsed turn: expand the
    // turn, then finish the scroll once its rows materialize in `visibleItems`.
    const pendingScrollRef = useRef<{
      messageId: string;
      callId?: string;
    } | null>(null);

    const scrollToMessage = useCallback(
      (messageId: string, callId?: string): boolean => {
        const visibleIndex = findDisplayItemIndex(
          visibleItems,
          messageId,
          callId,
        );
        if (visibleIndex >= 0) {
          pendingScrollRef.current = null;
          performScrollToRow(visibleIndex + headerOffset);
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
      [visibleItems, displayItems, headerOffset, performScrollToRow],
    );

    useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage]);

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
      performScrollToRow(idx + headerOffset);
    }, [visibleItems, headerOffset, performScrollToRow]);

    // Rules 2 & 3: detect scroll direction to toggle follow mode.
    // Runs synchronously in the scroll handler — no rAF needed since
    // the browser already coalesces scroll events.
    const handleScroll = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (scrollCooldown.current) {
        lastScrollTop.current = el.scrollTop;
        return;
      }
      const prev = lastScrollTop.current;
      const curr = el.scrollTop;
      lastScrollTop.current = curr;
      const distanceFromBottom = el.scrollHeight - curr - el.clientHeight;

      // Rule 2: scrolling up → pause follow
      if (curr < prev - 1) {
        shouldFollow.current = false;
      }
      // Rule 3: near bottom → resume follow
      // (runs unconditionally so that container-resize-induced scrollTop
      // clamping — which looks like scrolling up — doesn't permanently
      // disable follow when the viewport is still near the bottom)
      if (distanceFromBottom < 30) {
        shouldFollow.current = true;
      }
    }, []);

    // Clear screen (e.g. /clear) → reset to follow mode, drop stale per-turn
    // collapse overrides, and disarm any deferred scroll so it can't fire
    // against the next session.
    useEffect(() => {
      if (messages.length === 0) {
        shouldFollow.current = true;
        pendingScrollRef.current = null;
        setCollapseOverrides((prev) => (prev.size ? new Map() : prev));
      }
    }, [messages.length]);

    // Container-resize guard: when floating panels (e.g. TodoPanel)
    // appear or disappear the scroll container's clientHeight changes.
    // Snap back to bottom so the user doesn't lose their place while
    // follow mode is active.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        if (catchingUpRef.current) return;
        if (!shouldFollow.current) return;
        requestAnimationFrame(() => {
          if (!catchingUpRef.current && shouldFollow.current) {
            scrollToBottom();
          }
        });
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [scrollToBottom]);

    // Rule 4: new user message → force follow on so the model's reply
    // scrolls into view as it streams in.
    useEffect(() => {
      const lastId = getLastUserMessageId(messages);
      if (catchingUp) {
        prevLastUserMsgId.current = lastId;
        return;
      }
      if (lastId && lastId !== prevLastUserMsgId.current) {
        shouldFollow.current = true;
        // A new prompt supersedes any pending "Show in transcript" scroll.
        pendingScrollRef.current = null;
        requestAnimationFrame(scrollToBottom);
      }
      prevLastUserMsgId.current = lastId;
    }, [messages, catchingUp, scrollToBottom]);

    // Rule 5: session restore — when catchingUp flips from true → falsy,
    // replay just finished. Scroll to bottom once so the user sees the
    // latest content without the viewport fighting the replay.
    useEffect(() => {
      if (prevCatchingUp.current && !catchingUp) {
        shouldFollow.current = true;
        requestAnimationFrame(scrollToBottom);
      }
      prevCatchingUp.current = catchingUp;
    }, [catchingUp, scrollToBottom]);

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
        shouldFollow.current = true;
        // Re-check follow inside the frame: if the user scrolls up in the gap
        // before it fires (Rule 2 clears the flag), don't fight them.
        requestAnimationFrame(() => {
          if (shouldFollow.current) scrollToBottom();
        });
      }
      prevHasTailContent.current = hasTailContent;
    }, [autoScrollTailIntoView, hasTailContent, scrollToBottom]);

    const renderVirtualItem = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) {
          return welcomeHeader;
        }

        if (hasTailApproval && index === tailApprovalIndex) {
          if (pendingApproval && isAskUserQuestion(pendingApproval)) {
            return (
              <AskUserQuestion
                request={pendingApproval}
                onConfirm={onConfirm}
              />
            );
          }
          if (pendingApproval) {
            return (
              <ToolApproval request={pendingApproval} onConfirm={onConfirm} />
            );
          }
          return null;
        }

        if (hasTailContent && index === tailContentIndex) {
          return tailContent;
        }

        const itemIndex = index - headerOffset;
        const item = visibleItems[itemIndex];
        if (!item) return null;

        if (item.type === 'parallel_agents') {
          return (
            <MessageTimestamp timestamp={item.timestamp}>
              <ParallelAgentsGroup
                agents={item.agents}
                pendingApproval={pendingApproval}
                onConfirm={onConfirm}
              />
            </MessageTimestamp>
          );
        }

        return (
          <MessageItem
            message={item.message}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
            onShowContextDetail={onShowContextDetail}
            workspaceCwd={workspaceCwd}
            isLatest={itemIndex === visibleItems.length - 1}
            showRetryHint={showRetryHint}
            onRetryClick={onRetryClick}
            shellOutputMaxLines={shellOutputMaxLines}
            commands={commands}
            collapse={item.collapse}
            onToggleCollapse={handleToggleCollapse}
          />
        );
      },
      [
        hasHeader,
        welcomeHeader,
        hasTailContent,
        tailContent,
        tailContentIndex,
        hasTailApproval,
        tailApprovalIndex,
        pendingApproval,
        onConfirm,
        onShowContextDetail,
        headerOffset,
        visibleItems,
        workspaceCwd,
        showRetryHint,
        onRetryClick,
        shellOutputMaxLines,
        commands,
        handleToggleCollapse,
      ],
    );

    const virtualItems = virtualizer.getVirtualItems();
    const totalVirtualSize = virtualizer.getTotalSize();

    const getRowClassName = useCallback(
      (key: string): string | undefined =>
        flashKey === key ? styles.rowFlash : undefined,
      [flashKey],
    );

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
      if (shouldFollow.current) {
        scrollToBottom();
      }
    }, [totalVirtualSize, messages, totalCount, catchingUp, scrollToBottom]);

    return (
      <div ref={containerRef} className={styles.list} onScroll={handleScroll}>
        {useVirtualScroll ? (
          <div
            style={{
              height: totalVirtualSize,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={getRowClassName(String(virtualRow.key))}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderVirtualItem(virtualRow.index)}
              </div>
            ))}
          </div>
        ) : (
          Array.from({ length: totalCount }, (_, index) => {
            const key = getItemKey(index);
            return (
              <div
                key={key}
                data-index={index}
                className={getRowClassName(key)}
              >
                {renderVirtualItem(index)}
              </div>
            );
          })
        )}
      </div>
    );
  },
);
