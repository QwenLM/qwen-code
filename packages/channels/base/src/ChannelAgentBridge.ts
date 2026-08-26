import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export const CHANNEL_PROMPT_DISPLAY_TEXT_META_KEY =
  'qwen.daemon.promptDisplayText';
export const CHANNEL_PROMPT_AUTHORIZATION_META_KEY =
  'qwen.daemon.channelPromptAuthorization';
// Channel-turn classification marker. Trusted-parent metadata: the daemon
// strips it from untrusted callers and honors it only when an authenticated
// channel worker (or a private-parent channel bridge) set it.
export const CHANNEL_PROMPT_META_KEY = 'qwen.channel.prompt';
// Private-parent capability handshake with the spawned `qwen --acp` child
// (packages/core/src/utils/invocation-context.ts owns the same constants).
// channel-base keeps a minimal dependency footprint, so the wire contract is
// pinned by value in a cross-package test instead of imported.
export const ACP_PRIVATE_PARENT_CAPABILITY_META_KEY =
  'qwen-code/private-parent-capability';
export const ACP_PRIVATE_PARENT_CAPABILITY_ENV =
  'QWEN_CODE_PRIVATE_ACP_CAPABILITY';

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
  backgroundResponse: [sessionId: string, text: string];
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
  /**
   * Channel instance name (e.g. `feishu-main`) stamped as the daemon `sourceId`
   * on **new** sessions — creation-time attribution paired with
   * `sourceType: 'channel'`. Ignored by `loadSession`: loading an existing
   * session never re-stamps its creation attribution.
   */
  sourceId?: string;
}

export interface ChannelPromptImage {
  data: string;
  mimeType: string;
}

export interface ChannelAgentBridgePromptOptions {
  images?: ChannelPromptImage[];
  imageBase64?: string;
  imageMimeType?: string;
  /** User-authored text shown in transcripts when `text` includes hidden context.
   * `''` means no user-visible text and must not be treated as unset. */
  displayText?: string;
}

/**
 * Resolves the ordered `images` contract, falling back to the legacy
 * single-image pair, and normalizes MIME types in one place: channel
 * adapters forward CDN `content-type` headers verbatim, so values arrive
 * with parameters and mixed case (e.g. `image/png; charset=binary`), and
 * the non-standard `image/jpg` alias rides them too. Entries missing
 * `data` or `mimeType` are dropped so one malformed attachment degrades
 * to a prompt without that image, like the legacy field guards did.
 */
export function resolvePromptImages(
  options?: ChannelAgentBridgePromptOptions,
): ChannelPromptImage[] {
  const images =
    options?.images && options.images.length > 0
      ? options.images
      : options?.imageBase64 && options.imageMimeType
        ? [{ data: options.imageBase64, mimeType: options.imageMimeType }]
        : [];
  return images
    .filter(
      (image) =>
        !!image &&
        typeof image.data === 'string' &&
        image.data.length > 0 &&
        typeof image.mimeType === 'string' &&
        image.mimeType.length > 0,
    )
    .map((image) => {
      const cleaned =
        image.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      return {
        data: image.data,
        // Normalize the alias like the daemon attachment store's own naming.
        mimeType: cleaned === 'image/jpg' ? 'image/jpeg' : cleaned,
      };
    });
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
    options?: ChannelAgentBridgePromptOptions,
  ): Promise<string>;
  cancelSession(sessionId: string): Promise<void>;
  /** Release a bridge-owned session that will not be routed to a caller. */
  discardSession?(
    sessionId: string,
    expectedBindingToken?: object,
  ): Promise<void>;
  /**
   * Daemon-mode hook for permanently removing an internal session's data.
   * Standalone bridges may omit it and fall back to discardSession.
   */
  deleteSessionData?(sessionId: string): Promise<void>;
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
