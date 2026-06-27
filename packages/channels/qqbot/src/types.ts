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
    /** C2C: user_openid (present). Group: member_openid (present). */
    user_openid?: string;
    /** Group messages (both @ and all): the member's openid. */
    member_openid?: string;
    /** Group: member role. */
    member_role?: string;
    /** Group: whether the author is a bot. */
    bot?: boolean;
    /** Legacy field — may not be present in all event types. */
    id?: string;
    /** Legacy field — may not be present in all event types. */
    username?: string;
  };
  content: string;
}

/** Extended fields available on group message events. */
export type QQGroupMessageEvent = QQMessageEvent & {
  group_openid: string;
  mentions?: Array<{
    member_openid?: string;
    username?: string;
    is_you?: boolean;
    bot?: boolean;
    scope?: 'all' | 'single';
  }>;
};

export interface QQChannelConfig {
  appID?: string;
  appSecret?: string;
  sandbox?: boolean;
  /**
   * GROUP_MESSAGE_CREATE handling policy:
   * - 'log' (default): log only, no LLM
   * - 'keyword': trigger LLM when content includes any keywordTriggers entry
   * - 'all': trigger LLM on every group message
   */
  groupAllPolicy?: 'log' | 'keyword' | 'all';
  /** Case-insensitive keyword triggers. Only used when groupAllPolicy='keyword'. */
  keywordTriggers?: string[];
}

/** Robot added to a group. */
export interface GroupAddRobotEvent {
  group_openid: string;
  op_member_openid: string;
  timestamp: number;
}

/** Robot removed from a group. */
export interface GroupDelRobotEvent {
  group_openid: string;
  op_member_openid: string;
  timestamp: number;
}

/** Active message permission toggle. */
export interface GroupMsgToggleEvent {
  group_openid: string;
  op_member_openid: string;
  timestamp: number;
}
