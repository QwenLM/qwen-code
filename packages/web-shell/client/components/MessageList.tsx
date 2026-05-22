import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Message } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import { MessageItem } from './MessageItem';
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

export function MessageList({
  messages,
  pendingApproval,
  onConfirm,
  forceScrollToBottom,
  welcomeHeader,
}: MessageListProps) {
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

      {messages.map((msg) => (
        <MessageItem
          key={msg.id}
          message={msg}
          pendingApproval={pendingApproval}
          onConfirm={onConfirm}
        />
      ))}

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
