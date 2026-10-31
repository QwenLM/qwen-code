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
  GROUP_MESSAGE: 1 << 26, // 群聊全量消息事件 (GROUP_MESSAGE_CREATE)
} as const;

export interface QQMessageAttachment {
  url: string;
  content_type?: string;
  /** Present on `content_type: voice`: the SILK-converted WAV file URL. */
  voice_wav_url?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
}

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
  attachments?: QQMessageAttachment[];
}

/** Extended fields available on group message events. */
export type QQGroupMessageEvent = QQMessageEvent & {
  group_openid: string;
  mentions?: Array<{
    id?: string;
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
  /**
   * When true (default), raw `<@OPENID>` tags are preserved in group messages
   * sent to the LLM, allowing the model to @mention group members.
   * When false, `<@OPENID>` tags are stripped before reaching the LLM.
   */
  allowMention?: boolean;
  /** Route overrides for chat IDs that haven't been seen inbound yet.
   *  Key: chat openid (group_openid or user_openid).
   *  Value: 'group' or 'c2c'.
   *  Used by resolveRoute() as fallback when chatTypeMap has no entry.
   *  Essential for cron/scheduled messages to known groups.
   */
  chatTypes?: Record<string, 'c2c' | 'group'>;
  /** Enable experimental cron-msg features. Use at your own risk. */
  'cron-msg-experimental'?: boolean;
  /**
   * Expose the QQ group-management tools to the agent in this channel's
   * sessions. Default false: the tools are destructive and run with the bot's
   * own token, so an existing deployment keeps them off until an operator sets
   * `true`. The platform's own rules still apply once enabled: recalling a
   * member's message needs the bot to be a group admin.
   */
  moderationTools?: boolean;
  /**
   * How long, in milliseconds, the channel keeps an inbound message in the
   * per-chat history the recall tool resolves a member's last message from.
   * - `-1` (default): no time limit; entries are bounded only by the per-chat
   *   count cap.
   * - `0`: disable member-targeted recall. The history is not recorded and
   *   `member_openid` is rejected; an explicit `message_id` still works.
   * - `N > 0`: keep an entry for N milliseconds.
   * A non-integer or a value below -1 warns on stderr and falls back to `-1`.
   */
  moderationRecallWindowMs?: number;
  /**
   * Expose the outbound file tool (`qq_send_file`) to the agent in this
   * channel's sessions. Default false: the tool lets the model hand a local
   * file to QQ under the bot's own identity, so it stays off until the channel
   * opts in. Only files inside the session workspace or the system temporary
   * directory, non-empty and at most 20 MB, can be sent.
   */
  fileTools?: boolean;

  /** Max buffer chars before forcing an immediate flush (stream+cron). Default 4096. */
  bufferFlushLength?: number;
  /** Max reconnect attempts before giving up. Default 20. 0 = unlimited. */
  maxReconnectAttempts?: number;
  /**
   * Max flush retries for streaming message delivery. Default 3. 0 =
   * unlimited on the background/fire-and-forget flush paths; the final
   * segment of a completed turn is awaited inside that turn, so it is capped
   * at 3 attempts, then reports the loss rather than holding the turn lock.
   */
  maxFlushRetries?: number;
  /** Max gateway retries per reconnect cycle. Default 5. 0 = unlimited. */
  maxGwRetries?: number;
  /**
   * Delete this channel's legacy single-scope `<channel>:__single__` key and
   * legacy user-scope `<channel>:<senderId>:<chatId>` routes when the current
   * `sessionScope` can never route to them. Default false: the default scope
   * changing is not the operator asking to delete persisted conversations.
   * Enabling it also releases the routes' daemon-side sessions.
   */
  purgeLegacySessions?: boolean;
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
