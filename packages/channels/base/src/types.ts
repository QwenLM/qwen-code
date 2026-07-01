import type {
  ChannelAgentBridge,
  ToolCallEvent,
} from './ChannelAgentBridge.js';
import type { ChannelBase, ChannelBaseOptions } from './ChannelBase.js';

export type SenderPolicy = 'allowlist' | 'pairing' | 'open';
export type SessionScope = 'user' | 'thread' | 'single';
export type ChannelType = string;
export type GroupPolicy = 'disabled' | 'allowlist' | 'open';
export type DispatchMode = 'collect' | 'steer' | 'followup';

export interface ChannelIdentityConfig {
  id?: string;
  displayName?: string;
  description?: string;
}

export interface ChannelRuntimeIdentity {
  id: string;
  displayName: string;
  description?: string;
}

export type ChannelMemoryScopeMode = 'metadata-only';

export interface ChannelMemoryScopeConfig {
  namespace?: string;
  mode?: ChannelMemoryScopeMode;
}

export interface ChannelRuntimeMemoryScope {
  namespace: string;
  mode: ChannelMemoryScopeMode;
}

export interface GroupConfig {
  requireMention?: boolean; // default: true
  dispatchMode?: DispatchMode;
  groupHistoryLimit?: number;
}

export interface BlockStreamingChunkConfig {
  /** Minimum characters before emitting a block. Default: 400. */
  minChars?: number;
  /** Force-emit when buffer exceeds this size. Default: 1000. */
  maxChars?: number;
}

export interface BlockStreamingCoalesceConfig {
  /** Emit buffered text after this many ms of inactivity. Default: 1500. */
  idleMs?: number;
}

export interface ChannelConfig {
  type: ChannelType;
  token: string;
  clientId?: string;
  clientSecret?: string;
  senderPolicy: SenderPolicy;
  allowedUsers: string[];
  sessionScope: SessionScope;
  cwd: string;
  approvalMode?: string;
  instructions?: string;
  identity?: ChannelIdentityConfig;
  memoryScope?: ChannelMemoryScopeConfig;
  model?: string;
  groupPolicy: GroupPolicy; // default: "disabled"
  groupHistoryLimit?: number;
  groups: Record<string, GroupConfig>; // "*" for defaults, group IDs for overrides

  /** Dispatch mode for concurrent messages. Default: 'steer' (resolved in ChannelBase.handleInbound). */
  dispatchMode?: DispatchMode;

  /** Enable block streaming — emit completed blocks as separate messages. */
  blockStreaming?: 'on' | 'off';
  /** Chunk size bounds for block streaming. */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /** Idle coalescing for block streaming. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
}

export interface Attachment {
  /** Content category. */
  type: 'image' | 'file' | 'audio' | 'video';
  /** Base64-encoded data (for images or small files). */
  data?: string;
  /** Absolute path to a local file (for large files saved to disk). */
  filePath?: string;
  /** MIME type (e.g. "image/jpeg", "application/pdf"). */
  mimeType: string;
  /** Original file name from the platform. */
  fileName?: string;
}

export interface Envelope {
  channelName: string;
  senderId: string;
  senderName: string;
  chatId: string;
  text: string;
  threadId?: string;
  /** Platform-specific message ID for response correlation. */
  messageId?: string;
  isGroup: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  /** Text of the message being replied to (quoted/referenced message). */
  referencedText?: string;
  /** Base64-encoded image data (e.g. from WeChat CDN download). */
  imageBase64?: string;
  /** MIME type for the image (e.g. "image/jpeg", "image/png"). */
  imageMimeType?: string;
  /** Structured attachments (images, files, audio, video). */
  attachments?: Attachment[];
  /**
   * Marks an envelope whose `text` ALREADY carries its `[sender]` attribution, so
   * handleInbound must NOT re-prefix it. Set in two places: on a synthetic
   * collect-mode re-entry (coalesced text already carries each message's prefix), AND
   * by the QQ adapter on a REAL inbound it self-prefixes as `[name]: …`. QQ
   * neutralizes that embedded name with sanitizeSenderName at the source (QQChannel),
   * so the self-prefixed name reaching the prompt is already sanitized — setting this
   * flag does not bypass sanitization.
   */
  alreadyPrefixed?: true;
}

export interface SessionTarget {
  channelName: string;
  senderId: string;
  chatId: string;
  threadId?: string;
  isGroup?: boolean;
}

interface ChannelTaskLifecycleBase {
  channelName: string;
  chatId: string;
  sessionId: string;
  messageId?: string;
  identity: ChannelRuntimeIdentity;
  memoryScope: ChannelRuntimeMemoryScope;
}

export type ChannelTaskLifecycleEvent =
  | (ChannelTaskLifecycleBase & { type: 'started' })
  | (ChannelTaskLifecycleBase & { type: 'text_chunk'; chunk: string })
  | (Omit<ChannelTaskLifecycleBase, 'messageId'> & {
      type: 'tool_call';
      toolCall: ToolCallEvent;
    })
  | (ChannelTaskLifecycleBase & {
      type: 'cancelled';
      reason: 'cancel_command' | 'clear' | 'steer' | 'timeout';
    })
  | (ChannelTaskLifecycleBase & { type: 'completed' })
  | (ChannelTaskLifecycleBase & { type: 'failed'; error: string });

export interface ChannelMemoryTarget {
  channelName: string;
  chatId: string;
  threadId?: string;
}

export interface ChannelMemoryWriteResult {
  changed: boolean;
  filePath?: string;
}

export interface ChannelMemoryCallbacks {
  readChannelMemory(target: ChannelMemoryTarget): Promise<string>;
  appendChannelMemory(
    target: ChannelMemoryTarget,
    text: string,
  ): Promise<ChannelMemoryWriteResult>;
  clearChannelMemory(
    target: ChannelMemoryTarget,
  ): Promise<ChannelMemoryWriteResult>;
}

/**
 * A channel plugin registers a channel type and provides a factory
 * to create adapter instances. Both built-in adapters and external
 * plugins conform to this interface.
 */
export interface ChannelPlugin {
  /** Unique channel type ID (e.g., "telegram", "tmcp-dingtalk"). */
  channelType: string;

  /** Human-readable name for CLI output. */
  displayName: string;

  /**
   * Config fields required by this channel type, beyond the shared
   * ChannelConfig fields. Validated at startup.
   */
  requiredConfigFields?: string[];

  /** Create a channel adapter instance. */
  createChannel(
    name: string,
    config: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ): ChannelBase;
}
