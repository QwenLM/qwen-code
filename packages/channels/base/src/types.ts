import type { AcpBridge } from './AcpBridge.js';
import type { ChannelBase, ChannelBaseOptions } from './ChannelBase.js';

export type SenderPolicy = 'allowlist' | 'pairing' | 'open';
export type SessionScope = 'user' | 'thread' | 'single';
export type ChannelType = string;
export type GroupPolicy = 'disabled' | 'allowlist' | 'open';

export interface GroupConfig {
  requireMention?: boolean; // default: true
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
  model?: string;
  groupPolicy: GroupPolicy; // default: "disabled"
  groups: Record<string, GroupConfig>; // "*" for defaults, group IDs for overrides
}

export interface Envelope {
  channelName: string;
  senderId: string;
  senderName: string;
  chatId: string;
  text: string;
  threadId?: string;
  isGroup: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  /** Text of the message being replied to (quoted/referenced message). */
  referencedText?: string;
  /** Base64-encoded image data (e.g. from WeChat CDN download). */
  imageBase64?: string;
  /** MIME type for the image (e.g. "image/jpeg", "image/png"). */
  imageMimeType?: string;
}

export interface SessionTarget {
  channelName: string;
  senderId: string;
  chatId: string;
  threadId?: string;
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
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ): ChannelBase;
}
