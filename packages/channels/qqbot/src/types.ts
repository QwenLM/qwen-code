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

// ── Ark message ──────────────────────────────────────────────────

/** Key-value pair for Ark template variable substitution. */
export interface ArkKV {
  key: string;
  value?: string;
  /** Object array for list-type template variables. */
  obj?: Array<{ obj_kv: ArkKV[] }>;
}

/** Ark message payload (msg_type=3). */
export interface ArkPayload {
  template_id: number;
  kv: ArkKV[];
}

// ── Media message ───────────────────────────────────────────────

/** File type for media upload. 4 (file) is C2C-only; groups block it. */
export const FileType = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
} as const;

/** Media upload request body. */
export interface MediaUploadRequest {
  file_type: number;
  url: string;
  srv_send_msg: boolean;
}

/** Media upload response. */
export interface MediaUploadResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

/** Media message payload (msg_type=7). */
export interface MediaPayload {
  file_info: string;
}
