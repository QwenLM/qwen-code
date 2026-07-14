import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
  /**
   * Aliases the agent's parser also accepts for this command (for example
   * `summarize` for `compress`).
   */
  altNames?: string[];
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  kind: string;
  title: string;
  status: string;
  rawInput?: Record<string, unknown>;
}

export interface ChannelLoopToolCreateInput {
  cron: string;
  prompt: string;
  recurring?: boolean;
}

export interface ChannelLoopToolResult {
  text: string;
  isError?: boolean;
}

export interface ChannelLoopToolHandler {
  canHandle?(sessionId: string): boolean;
  create(
    sessionId: string,
    input: ChannelLoopToolCreateInput,
  ): Promise<string | ChannelLoopToolResult>;
  list(sessionId: string): Promise<string | ChannelLoopToolResult>;
  cancel(
    sessionId: string,
    id: string,
  ): Promise<string | ChannelLoopToolResult>;
}

export interface SessionDiedEvent {
  sessionId: string;
  reason?: string;
}

export interface PermissionRequestEvent {
  requestId: string;
  sessionId: string;
  request: RequestPermissionRequest;
}

export interface PermissionResolvedEvent {
  requestId: string;
  outcome?: RequestPermissionResponse['outcome'];
}

interface ChannelAgentBridgeEventMap {
  sessionDied: [SessionDiedEvent];
  textChunk: [sessionId: string, chunk: string];
  responseBoundary: [sessionId: string];
  toolCall: [ToolCallEvent];
  permissionRequest: [PermissionRequestEvent];
  permissionResolved: [PermissionResolvedEvent];
}

export interface BridgeSessionInfo {
  sessionId: string;
  workspaceCwd: string;
  hasActivePrompt: boolean;
}

export interface ChannelAgentBridgeSessionOptions {
  approvalMode?: string;
}

export type ChannelInvocationIngress = 'channel' | 'scheduler' | 'internal';

export interface ChannelPromptOptions {
  imageBase64?: string;
  imageMimeType?: string;
  invocationIngress?: ChannelInvocationIngress;
}

export interface ChannelAgentBridge {
  readonly availableCommands: AvailableCommand[];
  getAvailableCommands?(sessionId: string): AvailableCommand[];
  on<K extends keyof ChannelAgentBridgeEventMap>(
    eventName: K,
    listener: (...args: ChannelAgentBridgeEventMap[K]) => void,
  ): unknown;
  off<K extends keyof ChannelAgentBridgeEventMap>(
    eventName: K,
    listener: (...args: ChannelAgentBridgeEventMap[K]) => void,
  ): unknown;
  newSession(
    cwd: string,
    options?: ChannelAgentBridgeSessionOptions,
    bindingToken?: object,
  ): Promise<string>;
  loadSession(
    sessionId: string,
    cwd: string,
    options?: ChannelAgentBridgeSessionOptions,
    bindingToken?: object,
  ): Promise<string>;
  prompt(
    sessionId: string,
    text: string,
    options?: ChannelPromptOptions,
  ): Promise<string>;
  cancelSession(sessionId: string): Promise<void>;
  /** Release a bridge-owned session that will not be routed to a caller. */
  discardSession?(
    sessionId: string,
    expectedBindingToken?: object,
  ): Promise<void>;
  respondToPermission?(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
  shellCommand?(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
  listSessions?(): BridgeSessionInfo[];
  registerChannelLoopToolHandler?(handler: ChannelLoopToolHandler): void;
}
