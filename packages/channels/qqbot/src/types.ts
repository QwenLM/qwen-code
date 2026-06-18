/**
 * QQ Bot API protocol types.
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

export const OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** QQ Bot WebSocket intents. */
export const Intent = {
  C2C_MESSAGE: 1 << 12, // C2C 消息
  GROUP_AT_MESSAGE: 1 << 25, // 群聊 @ 消息事件
} as const;

export interface QQMessageEvent {
  id: string;
  author: {
    id: string;
    user_openid: string;
    username?: string;
  };
  content: string;
}

/** Extended fields available on group message events. */
export type QQGroupMessageEvent = QQMessageEvent & {
  group_openid: string;
};

export interface QQChannelConfig {
  appID?: string;
  appSecret?: string;
  sandbox?: boolean;
}
