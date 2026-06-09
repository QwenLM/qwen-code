import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message, ACPToolCall } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import { isSubAgentToolCall } from '../adapters/toolClassification';
import { CompactModeContext } from '../App';
import { MessageItem } from './MessageItem';
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
  catchingUp?: boolean;
  welcomeHeader?: ReactNode;
  workspaceCwd?: string;
  tailContent?: ReactNode;
  tailKey?: string;
  /**
   * When true, scroll the tail content into view the moment it first appears
   * even if the user had scrolled up. Opt-in per caller so unrelated inline
   * panels don't yank the reader to the bottom. Defaults to false.
   */
  autoScrollTailIntoView?: boolean;
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
  | { type: 'parallel_agents'; key: string; agents: ACPToolCall[] };

function isAgentOnlyToolGroup(msg: Message): boolean {
  return (
    msg.role === 'tool_group' &&
    msg.tools.length === 1 &&
    isSubAgentToolCall(msg.tools[0])
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
    if (isAgentOnlyToolGroup(messages[i])) {
      const start = i;
      while (i < messages.length && isAgentOnlyToolGroup(messages[i])) i++;
      if (i - start >= 2) {
        const grouped = messages.slice(start, i);
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          agents: grouped.map((m) => (m as { tools: ACPToolCall[] }).tools[0]),
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

const HEADER_INDEX = 0;
const ESTIMATE_HEADER = 120;
const ESTIMATE_MESSAGE = 80;
const ESTIMATE_APPROVAL = 200;
const ESTIMATE_TAIL = 240;

export function MessageList({
  messages,
  pendingApproval,
  onConfirm,
  catchingUp,
  welcomeHeader,
  workspaceCwd,
  tailContent,
  tailKey = 'tail',
  autoScrollTailIntoView = false,
}: MessageListProps) {
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
    getScrollElement: () => containerRef.current,
    getItemKey: (index) => {
      if (hasHeader && index === HEADER_INDEX) return 'header';
      if (hasTailApproval && index === tailApprovalIndex) {
        return pendingApproval ? `approval-${pendingApproval.id}` : 'approval';
      }
      if (hasTailContent && index === tailContentIndex) return tailKey;
      const item = displayItems[index - headerOffset];
      return item?.key ?? `row-${index}`;
    },
    estimateSize: (index) => {
      if (hasHeader && index === HEADER_INDEX) return ESTIMATE_HEADER;
      if (hasTailApproval && index === tailApprovalIndex) {
        return ESTIMATE_APPROVAL;
      }
      if (hasTailContent && index === tailContentIndex) return ESTIMATE_TAIL;
      return ESTIMATE_MESSAGE;
    },
    overscan: 20,
    useAnimationFrameWithResizeObserver: true,
  });

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

  // Container-resize guard: when floating panels (TodoPanel,
  // ActiveAgentsPanel) appear or disappear the scroll container's
  // clientHeight changes. Snap back to bottom so the user doesn't
  // lose their place while follow mode is active.
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
            <AskUserQuestion request={pendingApproval} onConfirm={onConfirm} />
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
          <ParallelAgentsGroup
            agents={item.agents}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
          />
        );
      }

      return (
        <MessageItem
          message={item.message}
          pendingApproval={pendingApproval}
          onConfirm={onConfirm}
          workspaceCwd={workspaceCwd}
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
      headerOffset,
      displayItems,
      workspaceCwd,
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
  }, [totalVirtualSize, catchingUp, scrollToBottom]);

  return (
    <div ref={containerRef} className={styles.list} onScroll={handleScroll}>
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
    </div>
  );
}
