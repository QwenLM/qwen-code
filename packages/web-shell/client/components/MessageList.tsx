import {
  useContext,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { Message, ACPToolCall } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import { isSubAgentToolCall } from '../adapters/toolClassification';
import { CompactModeContext } from '../App';
import { MessageItem } from './MessageItem';
import { ParallelAgentsGroup } from './messages/tools/ParallelAgentsGroup';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import styles from './MessageList.module.css';

interface MessageListProps {
  messages: Message[];
  pendingApproval: PermissionRequest | null;
  onConfirm: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
  forceScrollToBottom?: boolean;
  welcomeHeader?: ReactNode;
  workspaceCwd?: string;
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
      if (msg.tools.some((t) => t.callId === approval.toolCallId)) return true;
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
    pendingApproval &&
    msg.tools.some((t) => t.callId === pendingApproval.toolCallId)
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

export function MessageList({
  messages,
  pendingApproval,
  onConfirm,
  forceScrollToBottom,
  welcomeHeader,
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
  const shouldAutoScroll = useRef(true);
  const prevMsgCount = useRef(messages.length);
  const prevLastUserMessageId = useRef<string | null>(
    getLastUserMessageId(messages),
  );

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    shouldAutoScroll.current = atBottom;
  }, []);

  useEffect(() => {
    if (prevMsgCount.current > 0 && messages.length === 0) {
      shouldAutoScroll.current = true;
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, pendingApproval]);

  useEffect(() => {
    const lastUserMessageId = getLastUserMessageId(messages);
    if (
      lastUserMessageId &&
      lastUserMessageId !== prevLastUserMessageId.current
    ) {
      shouldAutoScroll.current = true;
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }
    prevLastUserMessageId.current = lastUserMessageId;
  }, [messages]);

  useEffect(() => {
    if (forceScrollToBottom && containerRef.current) {
      shouldAutoScroll.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [forceScrollToBottom]);

  return (
    <div ref={containerRef} className={styles.list} onScroll={handleScroll}>
      {welcomeHeader}

      {displayItems.map((item) =>
        item.type === 'parallel_agents' ? (
          <ParallelAgentsGroup
            key={item.key}
            agents={item.agents}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
          />
        ) : (
          <MessageItem
            key={item.key}
            message={item.message}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
          />
        ),
      )}

      {pendingApproval && isAskUserQuestion(pendingApproval) && (
        <AskUserQuestion request={pendingApproval} onConfirm={onConfirm} />
      )}

      {pendingApproval &&
        !isAskUserQuestion(pendingApproval) &&
        !approvalMatchesToolGroup(messages, pendingApproval) && (
          <ToolApproval request={pendingApproval} onConfirm={onConfirm} />
        )}
    </div>
  );
}
