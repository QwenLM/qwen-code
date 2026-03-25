export type SenderPolicy = 'allowlist' | 'pairing' | 'open';
export type SessionScope = 'user' | 'thread' | 'single';
export type ChannelType = 'telegram' | 'weixin' | 'discord' | 'webhook';
export type GroupPolicy = 'disabled' | 'allowlist' | 'open';

export interface GroupConfig {
  requireMention?: boolean; // default: true
}

export interface ChannelConfig {
  type: ChannelType;
  token: string;
  senderPolicy: SenderPolicy;
  allowedUsers: string[];
  sessionScope: SessionScope;
  cwd: string;
  approvalMode?: string;
  instructions?: string;
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
}

export interface SessionTarget {
  channelName: string;
  senderId: string;
  chatId: string;
  threadId?: string;
}
