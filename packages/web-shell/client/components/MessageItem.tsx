import type { Message } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import { UserMessage } from './messages/UserMessage';
import { AssistantMessage } from './messages/AssistantMessage';
import { SystemMessage } from './messages/SystemMessage';
import { ToolGroup } from './messages/ToolGroup';
import { PlanMessage } from './messages/PlanMessage';

interface MessageItemProps {
  message: Message;
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
}

export function MessageItem({
  message,
  pendingApproval,
  onConfirm,
}: MessageItemProps) {
  switch (message.role) {
    case 'user':
      return <UserMessage content={message.content} />;
    case 'assistant':
      return (
        <AssistantMessage
          content={message.content}
          thinking={message.thinking}
        />
      );
    case 'tool_group':
      return (
        <ToolGroup
          tools={message.tools}
          pendingApproval={pendingApproval}
          onConfirm={onConfirm}
        />
      );
    case 'plan':
      return <PlanMessage todos={message.todos} />;
    case 'system':
      return (
        <SystemMessage content={message.content} variant={message.variant} />
      );
    default:
      return null;
  }
}
