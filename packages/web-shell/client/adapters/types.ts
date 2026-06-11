import type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageToolCallLocation,
  DaemonMessageTodoItem,
  DaemonAssistantMessage,
  DaemonInsightErrorMessage,
  DaemonInsightProgressMessage,
  DaemonInsightReadyMessage,
  DaemonPlanMessage,
  DaemonSystemMessage,
  DaemonToolGroupMessage,
  DaemonUserMessage,
  DaemonUserShellMessage,
} from './messageTypes';
import type { DaemonStreamingState } from '@qwen-code/webui/daemon-react-sdk';

export type Message = DaemonMessage;
export type ACPToolCall = DaemonMessageToolCall;
export type ToolCallContent = DaemonMessageToolCallContent;
export type ToolCallStatus = DaemonMessageToolCallStatus;
export type ToolKind = DaemonMessageToolKind;
export type ToolCallLocation = DaemonMessageToolCallLocation;
export type TodoItem = DaemonMessageTodoItem;
export type StreamingState = DaemonStreamingState;

export type UserMessage = DaemonUserMessage;
export type AssistantMessage = DaemonAssistantMessage;
export type InsightErrorMessage = DaemonInsightErrorMessage;
export type InsightProgressMessage = DaemonInsightProgressMessage;
export type InsightReadyMessage = DaemonInsightReadyMessage;
export type ToolGroupMessage = DaemonToolGroupMessage;
export type PlanMessage = DaemonPlanMessage;
export type SystemMessage = DaemonSystemMessage;
export type UserShellMessage = DaemonUserShellMessage;

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  id: string;
  label: string;
  kind?: PermissionOptionKind;
}

export interface PermissionRequest {
  id: string;
  sessionId?: string;
  toolCallId?: string;
  title?: string;
  toolKind?: string;
  content: ContentBlock[];
  options: PermissionOption[];
  rawInput?: Record<string, unknown>;
  kind?: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  subcommands?: string[];
  source?: string;
  displayCategory?: 'custom' | 'skill' | 'system';
}

export interface ModelInfo {
  id: string;
  baseModelId?: string;
  label?: string;
  authType?: string;
  contextWindow?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  isRuntime?: boolean;
}
