import { memo, type ReactElement } from 'react';
import type {
  ACPToolCall,
  Message,
  PermissionRequest,
  TodoItem,
} from '../adapters/types';
import { MessageTimestamp } from './MessageTimestamp';
import { UserMessage } from './messages/UserMessage';
import { AssistantMessage } from './messages/AssistantMessage';
import { SystemMessage } from './messages/SystemMessage';
import { ToolGroup } from './messages/ToolGroup';
import { PlanMessage } from './messages/PlanMessage';
import { BtwMessage } from './messages/BtwMessage';
import { UserShellMessage } from './messages/UserShellMessage';
import { InsightProgress } from './InsightProgress';
import { InsightReady } from './InsightReady';

interface MessageItemProps {
  message: Message;
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  workspaceCwd?: string;
  isLatest?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
  shellOutputMaxLines: number;
}

export const MessageItem = memo(function MessageItem({
  message,
  pendingApproval,
  onConfirm,
  onShowContextDetail,
  workspaceCwd,
  isLatest = false,
  showRetryHint = false,
  onRetryClick,
  shellOutputMaxLines,
}: MessageItemProps) {
  const body = ((): ReactElement | null => {
    switch (message.role) {
      case 'user':
        return (
          <UserMessage content={message.content} images={message.images} />
        );
      case 'assistant':
        return (
          <AssistantMessage
            content={message.content}
            thinking={message.thinking}
            isStreaming={message.isStreaming}
          />
        );
      case 'tool_group':
        return (
          <ToolGroup
            tools={message.tools}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
            workspaceCwd={workspaceCwd}
            shellOutputMaxLines={shellOutputMaxLines}
          />
        );
      case 'plan':
        return <PlanMessage todos={message.todos} />;
      case 'system':
        return (
          <SystemMessage
            content={message.content}
            variant={message.variant}
            source={message.source}
            data={message.data}
            onShowContextDetail={onShowContextDetail}
            isLatest={isLatest}
            showRetryHint={showRetryHint && message.retryable === true}
            onRetryClick={onRetryClick}
          />
        );
      case 'user_shell':
        return (
          <UserShellMessage command={message.command} output={message.output} />
        );
      case 'btw':
        return (
          <BtwMessage
            question={message.question}
            answer={message.answer}
            isPending={message.isPending}
          />
        );
      case 'insight_progress':
        return (
          <InsightProgress
            progress={{
              stage: message.stage,
              progress: message.progress,
              detail: message.detail,
            }}
          />
        );
      case 'insight_ready':
        return <InsightReady path={message.path} />;
      case 'insight_error':
        return (
          <div style={{ color: 'var(--error-color, #e06c75)' }}>
            {message.error}
          </div>
        );
      default:
        return null;
    }
  })();

  if (body === null) return null;

  return (
    <MessageTimestamp timestamp={message.timestamp}>{body}</MessageTimestamp>
  );
}, areMessageItemPropsEqual);

function areMessageItemPropsEqual(
  prev: MessageItemProps,
  next: MessageItemProps,
): boolean {
  if (prev.pendingApproval?.id !== next.pendingApproval?.id) return false;
  if (prev.onConfirm !== next.onConfirm) return false;
  if (prev.onShowContextDetail !== next.onShowContextDetail) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.isLatest !== next.isLatest) return false;
  if (prev.showRetryHint !== next.showRetryHint) return false;
  if (prev.onRetryClick !== next.onRetryClick) return false;
  if (prev.shellOutputMaxLines !== next.shellOutputMaxLines) return false;
  return areMessagesEqual(prev.message, next.message);
}

function areMessagesEqual(prev: Message, next: Message): boolean {
  if (prev === next) return true;
  if (prev.id !== next.id || prev.role !== next.role) return false;
  if (prev.timestamp !== next.timestamp) return false;
  switch (prev.role) {
    case 'user':
      return (
        next.role === 'user' &&
        prev.content === next.content &&
        stableImagesEqual(prev.images, next.images)
      );
    case 'assistant':
      return (
        next.role === 'assistant' &&
        prev.content === next.content &&
        prev.thinking === next.thinking &&
        prev.isStreaming === next.isStreaming
      );
    case 'system':
      return (
        next.role === 'system' &&
        prev.content === next.content &&
        prev.variant === next.variant &&
        prev.retryable === next.retryable &&
        prev.source === next.source &&
        prev.data === next.data
      );
    case 'user_shell':
      return (
        next.role === 'user_shell' &&
        prev.command === next.command &&
        prev.output === next.output &&
        prev.cwd === next.cwd
      );
    case 'btw':
      return (
        next.role === 'btw' &&
        prev.question === next.question &&
        prev.answer === next.answer &&
        prev.isPending === next.isPending
      );
    case 'insight_progress':
      return (
        next.role === 'insight_progress' &&
        prev.stage === next.stage &&
        prev.progress === next.progress &&
        prev.detail === next.detail
      );
    case 'insight_ready':
      return next.role === 'insight_ready' && prev.path === next.path;
    case 'insight_error':
      return next.role === 'insight_error' && prev.error === next.error;
    case 'plan':
      return next.role === 'plan' && areTodosEqual(prev.todos, next.todos);
    case 'tool_group':
      return (
        next.role === 'tool_group' &&
        prev.tools.length === next.tools.length &&
        prev.tools.every((tool, index) =>
          areToolCallsEqual(tool, next.tools[index]),
        )
      );
    default:
      return false;
  }
}

function areTodosEqual(prev: TodoItem[], next: TodoItem[]): boolean {
  return (
    prev.length === next.length &&
    prev.every((todo, index) => {
      const other = next[index];
      return (
        other &&
        todo.id === other.id &&
        todo.content === other.content &&
        todo.status === other.status &&
        todo.priority === other.priority
      );
    })
  );
}

function areToolCallsEqual(
  prev: ACPToolCall,
  next: ACPToolCall | undefined,
): boolean {
  if (!next) return false;
  return (
    prev.callId === next.callId &&
    prev.toolName === next.toolName &&
    prev.status === next.status &&
    prev.title === next.title &&
    prev.kind === next.kind &&
    prev.startTime === next.startTime &&
    prev.endTime === next.endTime &&
    prev.subContent === next.subContent &&
    stableJson(prev.args) === stableJson(next.args) &&
    stableJson(prev.rawOutput) === stableJson(next.rawOutput) &&
    stableJson(prev.locations) === stableJson(next.locations) &&
    stableJson(prev.content) === stableJson(next.content) &&
    areToolListsEqual(prev.subTools, next.subTools)
  );
}

function areToolListsEqual(
  prev: ACPToolCall[] | undefined,
  next: ACPToolCall[] | undefined,
): boolean {
  if (!prev && !next) return true;
  if (!prev || !next || prev.length !== next.length) return false;
  return prev.every((tool, index) => areToolCallsEqual(tool, next[index]));
}

const jsonCache = new WeakMap<object, string>();

function stableImagesEqual(
  a: Array<{ data: string; mimeType: string }> | undefined,
  b: Array<{ data: string; mimeType: string }> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (img, i) => img.data === b[i].data && img.mimeType === b[i].mimeType,
  );
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  if (value !== null && typeof value === 'object') {
    let cached = jsonCache.get(value);
    if (cached !== undefined) return cached;
    try {
      cached = JSON.stringify(value);
    } catch {
      cached = String(value);
    }
    jsonCache.set(value, cached);
    return cached;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
