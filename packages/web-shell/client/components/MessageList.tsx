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
import type { Message, ACPToolCall } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import {
  isBackgroundSubAgentToolCall,
  isSubAgentToolCall,
} from '../adapters/toolClassification';
import { CompactModeContext } from '../App';
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
  welcomeHeader?: ReactNode;
  workspaceCwd?: string;
  tailContent?: ReactNode;
  tailKey?: string;
  virtualScrollThreshold?: number;
  shellOutputMaxLines: number;
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
  | { type: 'message'; key: string; message: Message }
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
      welcomeHeader,
      workspaceCwd,
      tailContent,
      tailKey = 'tail',
      virtualScrollThreshold = VIRTUAL_SCROLL_THRESHOLD,
      shellOutputMaxLines,
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
    const tailApprovalIndex = headerOffset + displayItems.length;
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
        const item = displayItems[index - headerOffset];
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
        displayItems,
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

    const scrollToMessage = useCallback(
      (messageId: string, callId?: string): boolean => {
        const itemIndex = findDisplayItemIndex(displayItems, messageId, callId);
        if (itemIndex < 0) return false;
        const rowIndex = itemIndex + headerOffset;
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
        return true;
      },
      [displayItems, headerOffset, useVirtualScroll, virtualizer, getItemKey],
    );

    useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage]);

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

    // Clear screen (e.g. /clear) → reset to follow mode.
    useEffect(() => {
      if (messages.length === 0) {
        shouldFollow.current = true;
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
        const item = displayItems[itemIndex];
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
            isLatest={itemIndex === displayItems.length - 1}
            showRetryHint={showRetryHint}
            onRetryClick={onRetryClick}
            shellOutputMaxLines={shellOutputMaxLines}
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
        displayItems,
        workspaceCwd,
        showRetryHint,
        onRetryClick,
        shellOutputMaxLines,
      ],
    );

    const virtualItems = virtualizer.getVirtualItems();
    const totalVirtualSize = virtualizer.getTotalSize();

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
                className={
                  flashKey === String(virtualRow.key)
                    ? styles.rowFlash
                    : undefined
                }
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
                className={flashKey === key ? styles.rowFlash : undefined}
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
