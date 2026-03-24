export type SenderPolicy = 'allowlist' | 'pairing' | 'open';
export type SessionScope = 'user' | 'thread' | 'single';
export type ChannelType = 'telegram' | 'discord' | 'webhook';

export interface ChannelConfig {
  type: ChannelType;
  token: string;
  senderPolicy: SenderPolicy;
  allowedUsers: string[];
  sessionScope: SessionScope;
  cwd: string;
  approvalMode?: string;
  instructions?: string;
}

export interface Envelope {
  channelName: string;
  senderId: string;
  senderName: string;
  chatId: string;
  text: string;
  threadId?: string;
}

export interface SessionTarget {
  channelName: string;
  senderId: string;
  chatId: string;
  threadId?: string;
}
