export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type StreamingState = 'idle' | 'waiting' | 'responding' | 'thinking';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolCallLocation {
  file: string;
  line?: number;
}

export interface DiffContent {
  type: 'diff';
  path: string;
  oldText?: string;
  newText: string;
}

export interface TextContent {
  type: 'content';
  content: ContentBlock;
}

export interface TerminalContent {
  type: 'terminal';
  terminalId: string;
}

export type ToolCallContent = TextContent | DiffContent | TerminalContent;

export interface ACPToolCall {
  callId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: ToolCallStatus;
  parentToolCallId?: string;
  title?: string;
  content?: ToolCallContent[];
  rawOutput?: unknown;
  locations?: ToolCallLocation[];
  kind?: ToolKind;
  startTime?: number;
  endTime?: number;
  subContent?: string;
  subTools?: ACPToolCall[];
}

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
  content: ContentBlock[];
  options: PermissionOption[];
  rawInput?: Record<string, unknown>;
  kind?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  subcommands?: string[];
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  turnIndex?: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
}

export interface ToolGroupMessage {
  id: string;
  role: 'tool_group';
  tools: ACPToolCall[];
}

export interface PlanMessage {
  id: string;
  role: 'plan';
  todos: TodoItem[];
}

export interface SystemMessage {
  id: string;
  role: 'system';
  content: string;
  variant: 'info' | 'error' | 'warning';
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolGroupMessage
  | PlanMessage
  | SystemMessage;
