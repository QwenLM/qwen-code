/**
 * QQ group-management tools exposed to the agent as client MCP tools.
 *
 * The model calls these tools autonomously during a turn; the adapter owns the
 * chat binding and the credentials, this module owns the schemas, argument
 * validation, and the mapping from QQ error codes to text the model can act
 * on. Tools marked `reserved` call an endpoint the open platform currently
 * gates behind an invite-only allowlist: they are wired and callable, and
 * surface the platform's refusal instead of a silent no-op.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/group/manage/
 */

import type {
  ChannelLoopToolResult,
  ChannelToolDefinition,
} from '@qwen-code/channel-base';
import type { QQApiMethod } from './api.js';

export type ModerationApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; code?: number; message: string };

export interface ModerationChat {
  chatId: string;
  isGroup: boolean;
}

export interface ModerationToolDeps {
  /** Chat bound to the agent session that invoked the tool. */
  resolveChat(sessionId: string): ModerationChat | undefined;
  /** True when the channel is configured not to resolve targets by member. */
  memberRecallDisabled: boolean;
  /** Newest still-tracked message from a member in the chat. */
  recentMemberMessage(chatId: string, senderId: string): string | undefined;
  /** Forget a message that was just recalled, so a later call resolves the previous one. */
  dropRecentMessage(chatId: string, messageId: string): void;
  request(input: {
    method: QQApiMethod;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<ModerationApiResult>;
  log(message: string): void;
}

/** The message a recall request resolved to, for logging and the model-visible echo. */
interface RecallTarget {
  chatId: string;
  messageId: string;
  /** Which argument resolved the target. */
  source: 'message_id' | 'member_openid';
}

interface ToolRequest {
  method: QQApiMethod;
  path: string;
  body?: Record<string, unknown>;
  /** Only recall resolves a concrete message; the other tools carry no target. */
  target?: RecallTarget;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Group-scoped endpoints reject direct-message sessions. */
  groupOnly?: boolean;
  /** Bot-scoped endpoints (join-approval strategies) need no chat binding. */
  botLevel?: boolean;
  build(
    args: Record<string, unknown>,
    deps: ModerationToolDeps,
    chat: ModerationChat | undefined,
  ): ToolRequest;
  format?(data: unknown, target: RecallTarget | undefined): string;
}

const ADMIN_NOTE =
  'Requires the bot to be a group admin; the platform refuses otherwise.';
const RESERVED_NOTE =
  'Reserved interface: this endpoint is currently invite-only on the QQ open platform (error 11253 unless the bot app is allowlisted), so report the platform answer instead of assuming success.';

/** `groupPath` needs the chat bound to the session. */
function requireGroup(chat: ModerationChat | undefined): ModerationChat {
  if (!chat || !chat.isGroup) {
    throw new ToolInputError(
      'This tool only applies to a QQ group chat session.',
    );
  }
  return chat;
}

/** The handler rejects a missing binding first; this narrows the type for tools that require one. */
function requireBoundChat(chat: ModerationChat | undefined): ModerationChat {
  if (!chat) {
    throw new ToolInputError(
      'No QQ chat is bound to this session yet, so no group action is possible.',
    );
  }
  return chat;
}

function groupPath(chat: ModerationChat | undefined, suffix: string): string {
  const group = requireGroup(chat);
  return `/v2/groups/${encodePart(group.chatId)}${suffix}`;
}

function strategyPath(strategyId: string, suffix = ''): string {
  return `/v2/groups/join_approval_strategy/${encodePart(strategyId)}${suffix}`;
}

function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

const RECALL_TOOL: ToolSpec = {
  name: 'qq_recall_message',
  description:
    "Recall a message in the current QQ group chat. The call requires a target: pass member_openid to recall that member's most recent message the channel still remembers from this chat, or message_id for an explicit platform message id. There is no implicit target, and the tool never recalls the bot's own messages. Member-targeted recall only reaches messages the channel actually received and still tracks: ordinary non-@ group messages arrive only when groupAllPolicy is 'keyword', 'all' or 'log'. Recalling another member's message requires the bot to be a group admin. Direct chats are unsupported, because the platform only recalls the bot's own messages there.",
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Explicit id of a message in this group chat.',
      },
      member_openid: {
        type: 'string',
        description:
          "The member's openid whose most recent recorded message should be recalled.",
      },
    },
    additionalProperties: false,
  },
  build(args, deps, chat) {
    const bound = requireBoundChat(chat);
    // The schema declares additionalProperties: false, but the model can still
    // send a renamed key. Silently ignoring it would recall something other
    // than what the model named, so reject the call instead.
    const unknown = Object.keys(args).filter(
      (key) => key !== 'message_id' && key !== 'member_openid',
    );
    if (unknown.length > 0) {
      throw new ToolInputError(
        `Unrecognized argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. qq_recall_message accepts only message_id and member_openid.`,
      );
    }
    // The platform recalls only the bot's own messages in a direct chat, and
    // this tool never recalls those, so every direct-chat call is unsupported.
    if (!bound.isGroup) {
      throw new ToolInputError(
        "qq_recall_message does not support direct chats: the platform only recalls the bot's own messages there, and this tool never recalls a message the bot sent.",
      );
    }
    const explicit = readOptionalString(args, 'message_id');
    const member = readOptionalString(args, 'member_openid');
    let messageId = explicit;
    if (!messageId) {
      // There is no implicit target: a call that names neither cannot say
      // which message it meant, and guessing would sooner or later destroy
      // the wrong one.
      if (!member) {
        throw new ToolInputError(
          "qq_recall_message needs a target: pass member_openid to recall that member's most recent message the channel still remembers, or message_id for an explicit platform message id. There is no implicit target.",
        );
      }
      if (deps.memberRecallDisabled) {
        throw new ToolInputError(
          'Member-targeted recall is disabled for this channel (moderationRecallWindowMs is 0); pass message_id explicitly instead.',
        );
      }
      messageId = deps.recentMemberMessage(bound.chatId, member);
      if (!messageId) {
        throw new ToolInputError(
          `No message from ${member} is still tracked for recall in this chat — it may have fallen out of the per-chat history the channel keeps, or was never delivered to the bot (ordinary group messages need groupAllPolicy 'keyword', 'all' or 'log').`,
        );
      }
    }
    return {
      method: 'DELETE',
      path: `/v2/groups/${encodePart(bound.chatId)}/messages/${encodePart(messageId)}`,
      target: {
        chatId: bound.chatId,
        messageId,
        source: explicit ? 'message_id' : 'member_openid',
      },
    };
  },
  format: (_data, target) =>
    target === undefined
      ? 'Message recalled.'
      : `Message recalled (${target.messageId}).`,
};

const GROUP_INFO_TOOL: ToolSpec = {
  name: 'qq_get_group_info',
  description:
    'Get the current QQ group profile: name, description, category, tags and member count.',
  inputSchema: { type: 'object', properties: {} },
  groupOnly: true,
  build: (_args, _deps, chat) => ({
    method: 'GET',
    path: groupPath(chat, '/info'),
  }),
};

const BOT_STATE_TOOL: ToolSpec = {
  name: 'qq_get_bot_state',
  description:
    "Get the bot's own state in the current QQ group: member role (member/admin/owner), join time, whether proactive push is allowed, and which messages the group lets the bot receive.",
  inputSchema: { type: 'object', properties: {} },
  groupOnly: true,
  build: (_args, _deps, chat) => ({
    method: 'GET',
    path: groupPath(chat, '/bot_state'),
  }),
};

const LIST_JOIN_REQUESTS_TOOL: ToolSpec = {
  name: 'qq_list_join_requests',
  description: `List pending join requests for the current QQ group, newest first. ${ADMIN_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous call; omit for page 1.',
      },
      limit: {
        type: 'integer',
        description: 'Page size, default 20, maximum 50.',
      },
    },
  },
  groupOnly: true,
  build(args, _deps, chat) {
    return {
      method: 'GET',
      path: withQuery(groupPath(chat, '/join_request_list'), {
        cursor: readOptionalString(args, 'cursor'),
        limit: readPageSize(args, 'limit', 50),
      }),
    };
  },
};

const REVIEW_JOIN_REQUEST_TOOL: ToolSpec = {
  name: 'qq_review_join_request',
  description: `Approve or decline a pending join request for the current QQ group. ${ADMIN_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      member_openid: {
        type: 'string',
        description: 'Openid of the applicant (from qq_list_join_requests).',
      },
      op: {
        type: 'string',
        enum: ['approve', 'decline'],
        description: 'approve to let them in, decline to reject.',
      },
      join_request_id: {
        type: 'string',
        description: 'Join request id from qq_list_join_requests.',
      },
      reject_reason: {
        type: 'string',
        description: 'Reason shown when declining.',
      },
      add_to_member_blacklist: {
        type: 'boolean',
        description: 'Also blacklist the applicant when declining.',
      },
    },
    required: ['member_openid', 'op'],
  },
  groupOnly: true,
  build(args, _deps, chat) {
    const body: Record<string, unknown> = {
      op: readEnum(args, 'op', ['approve', 'decline']),
    };
    const joinRequestId = readOptionalString(args, 'join_request_id');
    if (joinRequestId) body['join_request_id'] = joinRequestId;
    const rejectReason = readOptionalString(args, 'reject_reason');
    if (rejectReason) body['reject_reason'] = rejectReason;
    const blacklist = readOptionalBoolean(args, 'add_to_member_blacklist');
    if (blacklist !== undefined) body['add_to_member_blacklist'] = blacklist;
    return {
      method: 'POST',
      path: groupPath(
        chat,
        `/approval_join_request/${encodePart(
          readString(args, 'member_openid'),
        )}`,
      ),
      body,
    };
  },
  format: (data) => `Join request handled. ${stringify(data)}`,
};

const GET_MUTE_STATUS_TOOL: ToolSpec = {
  name: 'qq_get_mute_status',
  description: `Query the current QQ group mute state: the group-wide mute rule and every member-level mute still in effect. ${ADMIN_NOTE}`,
  inputSchema: { type: 'object', properties: {} },
  groupOnly: true,
  build: (_args, _deps, chat) => ({
    method: 'GET',
    path: groupPath(chat, '/restrict_chat_setting'),
  }),
};

const SET_MUTE_TOOL: ToolSpec = {
  name: 'qq_set_mute',
  description: `Mute or unmute group members in the current QQ group. ${ADMIN_NOTE} Max mute duration is 30 days; only ordinary members can be muted (not the owner, other admins or bots).`,
  inputSchema: {
    type: 'object',
    properties: {
      member_openid: {
        type: 'string',
        description: 'Single member to mute or unmute.',
      },
      members: {
        type: 'array',
        description:
          'Bulk form, at most 20 entries, each {member_openid, op, mute_expire_at}.',
        items: {
          type: 'object',
          properties: {
            member_openid: { type: 'string' },
            op: { type: 'string', enum: ['add', 'update', 'del'] },
            mute_expire_at: {
              type: 'string',
              description:
                'RFC3339 expiry, e.g. 2026-08-05T11:23:05+08:00. For op=del an empty string lifts the mute now.',
            },
          },
        },
      },
      op: {
        type: 'string',
        enum: ['add', 'update', 'del'],
        description: 'Operation for the single-member form. Default add.',
      },
      mute_expire_at: {
        type: 'string',
        description:
          'RFC3339 expiry for the single-member form, e.g. 2026-08-05T11:23:05+08:00. For op=del an empty string lifts the mute now.',
      },
    },
  },
  groupOnly: true,
  build(args, _deps, chat) {
    const members = readMembers(args);
    if (members.length === 0) {
      throw new ToolInputError('member_openid or members is required.');
    }
    if (members.length > 20) {
      throw new ToolInputError('At most 20 members per call.');
    }
    return {
      method: 'POST',
      path: groupPath(chat, '/restrict_chat_setting'),
      body: { members },
    };
  },
  format: () => 'Mute state updated.',
};

const LIST_STRATEGIES_TOOL: ToolSpec = {
  name: 'qq_list_join_approval_strategies',
  description:
    'List the bot-level auto-join-approval strategies currently in effect (bot-wide, not per group), newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous call.',
      },
      limit: {
        type: 'integer',
        description: 'Page size, default 20, maximum 50.',
      },
    },
  },
  botLevel: true,
  build(args) {
    return {
      method: 'GET',
      path: withQuery('/v2/groups/join_approval_strategy', {
        cursor: readOptionalString(args, 'cursor'),
        limit: readPageSize(args, 'limit', 50),
      }),
    };
  },
};

const CREATE_STRATEGY_TOOL: ToolSpec = {
  name: 'qq_create_join_approval_strategy',
  description:
    'Create a bot-level auto-join-approval strategy: join requests from whitelisted QQ numbers are approved automatically once the strategy runs. The strategy is created enabled-free (default on) but only takes effect while the bot is a group admin. Provide exactly one of group_openids / group_ids. A bot may hold at most 20 strategies. Whitelist numbers are added separately with qq_set_join_approval_whitelist.',
  inputSchema: {
    type: 'object',
    properties: {
      group_openids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Group openids the strategy covers, at most 100. Mutually exclusive with group_ids.',
      },
      group_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'QQ group numbers the strategy covers (strings, at most 100). Mutually exclusive with group_openids.',
      },
      is_enable: {
        type: 'string',
        enum: ['on', 'off'],
        description: 'Default on.',
      },
      expire_at: {
        type: 'string',
        description: 'RFC3339 expiry; defaults to one year from now.',
      },
      remark: {
        type: 'string',
        description: 'Human-readable note, at most 255 characters.',
      },
    },
  },
  botLevel: true,
  build(args) {
    const openids = readStringArray(args, 'group_openids');
    const groupIds = readStringArray(args, 'group_ids');
    if ((openids === undefined) === (groupIds === undefined)) {
      throw new ToolInputError(
        'Pass exactly one of group_openids or group_ids.',
      );
    }
    const body: Record<string, unknown> = {};
    assertMaxEntries(openids, 100, 'group_openids');
    assertMaxEntries(groupIds, 100, 'group_ids');
    if (openids) body['group_openids'] = openids;
    if (groupIds) body['group_ids'] = groupIds.map(toGroupNumber);
    const isEnable = readOptionalEnum(args, 'is_enable', ['on', 'off']);
    if (isEnable) body['is_enable'] = isEnable;
    const expireAt = readOptionalString(args, 'expire_at');
    if (expireAt) body['expire_at'] = expireAt;
    const remark = readOptionalString(args, 'remark');
    assertMaxChars(remark, 255, 'remark');
    if (remark) body['remark'] = remark;
    return { method: 'POST', path: '/v2/groups/join_approval_strategy', body };
  },
  format: (data) => `Strategy created. ${stringify(data)}`,
};

const UPDATE_STRATEGY_TOOL: ToolSpec = {
  name: 'qq_update_join_approval_strategy',
  description:
    'Update a bot-level auto-join-approval strategy: enable/disable it, change its expiry, add or remove covered groups, or change the remark. Group identifiers must use the same form the strategy was created with.',
  inputSchema: {
    type: 'object',
    properties: {
      strategy_id: { type: 'string', description: 'Strategy id.' },
      is_enable: { type: 'string', enum: ['on', 'off'] },
      expire_at: { type: 'string', description: 'RFC3339 expiry.' },
      group_action: {
        type: 'object',
        description: 'Add or remove covered groups.',
        properties: {
          op: { type: 'string', enum: ['add', 'del'] },
          group_openids: { type: 'array', items: { type: 'string' } },
          group_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['op'],
      },
      remark: { type: 'string' },
    },
    required: ['strategy_id'],
  },
  botLevel: true,
  build(args) {
    const body: Record<string, unknown> = {};
    const isEnable = readOptionalEnum(args, 'is_enable', ['on', 'off']);
    if (isEnable) body['is_enable'] = isEnable;
    const expireAt = readOptionalString(args, 'expire_at');
    if (expireAt) body['expire_at'] = expireAt;
    const remark = readOptionalString(args, 'remark');
    assertMaxChars(remark, 255, 'remark');
    if (remark) body['remark'] = remark;
    const action = readGroupAction(args);
    if (action) body['group_action'] = action;
    if (Object.keys(body).length === 0) {
      throw new ToolInputError(
        'Provide at least one of is_enable, expire_at, group_action or remark.',
      );
    }
    return {
      method: 'PATCH',
      path: strategyPath(readString(args, 'strategy_id')),
      body,
    };
  },
  format: (data) => `Strategy updated. ${stringify(data)}`,
};

const DELETE_STRATEGY_TOOL: ToolSpec = {
  name: 'qq_delete_join_approval_strategy',
  description: 'Delete a bot-level auto-join-approval strategy.',
  inputSchema: {
    type: 'object',
    properties: {
      strategy_id: { type: 'string', description: 'Strategy id.' },
    },
    required: ['strategy_id'],
  },
  botLevel: true,
  build(args) {
    return {
      method: 'DELETE',
      path: strategyPath(readString(args, 'strategy_id')),
    };
  },
  format: () => 'Strategy deleted.',
};

const EXECUTE_STRATEGY_TOOL: ToolSpec = {
  name: 'qq_execute_join_approval_strategy',
  description:
    'Run a bot-level auto-join-approval strategy now: it scans every covered group and approves pending join requests whose QQ number is whitelisted. Asynchronous, roughly 10 minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      strategy_id: { type: 'string', description: 'Strategy id.' },
    },
    required: ['strategy_id'],
  },
  botLevel: true,
  build(args) {
    return {
      method: 'POST',
      path: strategyPath(readString(args, 'strategy_id'), '/execute'),
    };
  },
  format: () => 'Strategy execution started (asynchronous, about 10 minutes).',
};

const SET_WHITELIST_TOOL: ToolSpec = {
  name: 'qq_set_join_approval_whitelist',
  description:
    'Add or remove whitelisted QQ numbers on a bot-level auto-join-approval strategy. At most 10000 numbers per call; a strategy holds at most 100000. Numbers must be strings to avoid precision loss. There is no API to read the numbers back — only the count.',
  inputSchema: {
    type: 'object',
    properties: {
      strategy_id: { type: 'string', description: 'Strategy id.' },
      op: { type: 'string', enum: ['add', 'del'] },
      whitelist_users: {
        type: 'array',
        items: { type: 'string' },
        description: 'QQ numbers as strings, at most 10000 per call.',
      },
    },
    required: ['strategy_id', 'op', 'whitelist_users'],
  },
  botLevel: true,
  build(args) {
    const users = readStringArray(args, 'whitelist_users') ?? [];
    if (users.length === 0) {
      throw new ToolInputError('whitelist_users must not be empty.');
    }
    if (users.length > 10000) {
      throw new ToolInputError('At most 10000 numbers per call.');
    }
    return {
      method: 'POST',
      path: strategyPath(readString(args, 'strategy_id'), '/whitelist_users'),
      body: {
        op: readEnum(args, 'op', ['add', 'del']),
        whitelist_users: users.map(toQqNumber),
      },
    };
  },
  format: (data) => `Whitelist updated. ${stringify(data)}`,
};

const LIST_MEMBERS_TOOL: ToolSpec = {
  name: 'qq_list_group_members',
  description: `List group members, up to 30 per page. ${RESERVED_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
  },
  groupOnly: true,
  build(args, _deps, chat) {
    return {
      method: 'GET',
      path: withQuery(groupPath(chat, '/members'), {
        cursor: readOptionalString(args, 'cursor'),
      }),
    };
  },
};

const GET_MEMBER_TOOL: ToolSpec = {
  name: 'qq_get_group_member',
  description: `Get one group member's details (nickname, role, join time). ${RESERVED_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      member_openid: { type: 'string', description: "The member's openid." },
    },
    required: ['member_openid'],
  },
  groupOnly: true,
  build(args, _deps, chat) {
    return {
      method: 'GET',
      path: groupPath(
        chat,
        `/members/${encodePart(readString(args, 'member_openid'))}`,
      ),
    };
  },
};

const KICK_TOOL: ToolSpec = {
  name: 'qq_kick_member',
  description: `Remove one or more members from the current QQ group, optionally blacklisting them. ${RESERVED_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      member_openid: {
        type: 'string',
        description: 'The group member to remove.',
      },
      member_openids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Bulk form, at most 20 members. Use instead of member_openid.',
      },
      add_to_blacklist: {
        type: 'boolean',
        description: 'Also add them to the group blacklist. Default false.',
      },
    },
  },
  groupOnly: true,
  build(args, _deps, chat) {
    const single = readOptionalString(args, 'member_openid');
    const bulk = readStringArray(args, 'member_openids');
    const memberOpenids = bulk ?? (single ? [single] : []);
    if (memberOpenids.length === 0) {
      throw new ToolInputError('member_openid or member_openids is required.');
    }
    if (memberOpenids.length > 20) {
      throw new ToolInputError('At most 20 members per call.');
    }
    const addToBlacklist = readOptionalBoolean(args, 'add_to_blacklist');
    return {
      method: 'POST',
      path: groupPath(chat, '/batch_remove_members'),
      body: {
        member_openids: memberOpenids,
        ...(addToBlacklist === undefined
          ? {}
          : { add_to_member_blacklist: addToBlacklist }),
      },
    };
  },
  format: (data) => `Platform response: ${stringify(data)}`,
};

const LIST_BLACKLIST_TOOL: ToolSpec = {
  name: 'qq_list_member_blacklist',
  description: `List the group blacklist, up to 100 per page. ${RESERVED_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'Pagination cursor.' },
      limit: {
        type: 'integer',
        description: 'Page size, default 20, maximum 100.',
      },
    },
  },
  groupOnly: true,
  build(args, _deps, chat) {
    return {
      method: 'GET',
      path: withQuery(groupPath(chat, '/member_blacklist'), {
        cursor: readOptionalString(args, 'cursor'),
        limit: readPageSize(args, 'limit', 100),
      }),
    };
  },
};

const UPDATE_BLACKLIST_TOOL: ToolSpec = {
  name: 'qq_update_member_blacklist',
  description: `Add members to or remove them from the group blacklist. A member who is still in the group cannot be blacklisted — remove them first. ${RESERVED_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'del'] },
      member_openids: {
        type: 'array',
        items: { type: 'string' },
        description: 'At most 20 openids.',
      },
    },
    required: ['op', 'member_openids'],
  },
  groupOnly: true,
  build(args, _deps, chat) {
    const openids = readStringArray(args, 'member_openids') ?? [];
    if (openids.length === 0) {
      throw new ToolInputError('member_openids must not be empty.');
    }
    if (openids.length > 20) {
      throw new ToolInputError('At most 20 members per call.');
    }
    return {
      method: 'POST',
      path: groupPath(chat, '/member_blacklist'),
      body: {
        op: readEnum(args, 'op', ['add', 'del']),
        member_openids: openids,
      },
    };
  },
  format: (data) => `Platform response: ${stringify(data)}`,
};

const TOOL_SPECS: ToolSpec[] = [
  RECALL_TOOL,
  GROUP_INFO_TOOL,
  BOT_STATE_TOOL,
  LIST_JOIN_REQUESTS_TOOL,
  REVIEW_JOIN_REQUEST_TOOL,
  GET_MUTE_STATUS_TOOL,
  SET_MUTE_TOOL,
  LIST_STRATEGIES_TOOL,
  CREATE_STRATEGY_TOOL,
  UPDATE_STRATEGY_TOOL,
  DELETE_STRATEGY_TOOL,
  EXECUTE_STRATEGY_TOOL,
  SET_WHITELIST_TOOL,
  LIST_MEMBERS_TOOL,
  GET_MEMBER_TOOL,
  KICK_TOOL,
  LIST_BLACKLIST_TOOL,
  UPDATE_BLACKLIST_TOOL,
];

export function buildModerationTools(
  deps: ModerationToolDeps,
): ChannelToolDefinition[] {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async handler(
      args: Record<string, unknown>,
      context: { sessionId: string },
    ): Promise<string | ChannelLoopToolResult> {
      const fail = (text: string): ChannelLoopToolResult => ({
        text,
        isError: true,
      });
      const chat = deps.resolveChat(context.sessionId);
      if (!chat && !spec.botLevel) {
        return fail(
          'No QQ chat is bound to this session yet, so no group action is possible.',
        );
      }
      if (spec.groupOnly && !chat?.isGroup) {
        return fail(`${spec.name} only applies to a group chat session.`);
      }
      let request: ToolRequest;
      try {
        request = spec.build(args, deps, chat);
      } catch (error) {
        if (error instanceof ToolInputError) return fail(error.message);
        throw error;
      }
      const result = await deps.request({
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (!result.ok) {
        const text = describeFailure(spec.name, result, request.target);
        deps.log(`${spec.name} failed: ${text}`);
        return fail(text);
      }
      deps.log(
        request.target === undefined
          ? `${spec.name} ok (HTTP ${result.status})`
          : `${spec.name} ok (HTTP ${result.status}) target=${request.target.chatId}/${request.target.messageId} via=${request.target.source}`,
      );
      if (request.target !== undefined) {
        // A successful recall destroys the target, so a repeat member-targeted
        // call must resolve the previous message rather than this one. The
        // eviction is success-only: a failed DELETE must leave the target so
        // the operator can retry the same message.
        deps.dropRecentMessage(request.target.chatId, request.target.messageId);
      }
      const formatted =
        spec.format?.(result.data, request.target) ?? stringify(result.data);
      return formatted;
    },
  }));
}

/** Argument errors are reported to the model, not thrown at the bridge. */
class ToolInputError extends Error {}

function describeFailure(
  tool: string,
  result: Extract<ModerationApiResult, { ok: false }>,
  target: RecallTarget | undefined,
): string {
  switch (result.code) {
    case 11253:
      return `${tool}: the platform refused (11253 ${result.message}) — this endpoint is allowlist-only for the bot app.`;
    case 40062003:
      return `${tool}: the platform refused (40062003 ${result.message}) — no permission for this operation: the bot must be a group admin, and the target must be an ordinary member (not the owner, an admin or a bot).`;
    case 40064004:
      return `${tool}: the platform refused (40064004 ${result.message}) — the message can no longer be recalled.`;
    case 50065001:
      return `${tool}: the platform failed to recall the message (50065001 ${result.message}); it is safe to retry${target === undefined ? '' : ` with message_id="${target.messageId}"`} so the same message is recalled.`;
    case 40061001:
      return `${tool}: the platform rejected the parameters (40061001 ${result.message}).`;
    default:
      return result.status === 0
        ? `${tool}: the platform call did not complete: ${result.message}`
        : `${tool}: platform call failed (HTTP ${result.status}${result.code === undefined ? '' : `, code ${result.code}`}): ${result.message}`;
  }
}

function readMembers(args: Record<string, unknown>): unknown[] {
  const bulk = args['members'];
  if (Array.isArray(bulk)) {
    return bulk.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new ToolInputError('members entries must be objects.');
      }
      const record = entry as Record<string, unknown>;
      const expireAt = readOptionalString(record, 'mute_expire_at');
      return {
        op: readEnum(record, 'op', ['add', 'update', 'del']),
        member_openid: readString(record, 'member_openid'),
        ...(expireAt === undefined ? {} : { mute_expire_at: expireAt }),
      };
    });
  }
  const single = readOptionalString(args, 'member_openid');
  if (!single) return [];
  const op = readOptionalEnum(args, 'op', ['add', 'update', 'del']) ?? 'add';
  const expireAt = readOptionalString(args, 'mute_expire_at');
  // mute_expire_at is optional in the platform schema, and the bulk form
  // forwards it the same way: requiring it here alone would make the two
  // forms disagree about the same request.
  return [
    {
      op,
      member_openid: single,
      ...(expireAt === undefined ? {} : { mute_expire_at: expireAt }),
    },
  ];
}

function readGroupAction(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = args['group_action'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new ToolInputError('group_action must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const openids = readStringArray(record, 'group_openids');
  const groupIds = readStringArray(record, 'group_ids');
  if ((openids === undefined) === (groupIds === undefined)) {
    throw new ToolInputError(
      'group_action needs exactly one of group_openids or group_ids.',
    );
  }
  assertMaxEntries(openids, 100, 'group_action.group_openids');
  assertMaxEntries(groupIds, 100, 'group_action.group_ids');
  return {
    op: readEnum(record, 'op', ['add', 'del']),
    ...(openids ? { group_openids: openids } : {}),
    ...(groupIds ? { group_ids: groupIds.map(toGroupNumber) } : {}),
  };
}

/**
 * QQ group numbers go over the wire as uint64, which JSON carries as a number.
 * Capping the digit count keeps the value inside Number.MAX_SAFE_INTEGER so the
 * conversion cannot silently round a group number to a different group.
 */
function toGroupNumber(value: string): number {
  if (!/^\d{1,15}$/.test(value)) {
    throw new ToolInputError(`${value} is not a QQ group number.`);
  }
  return Number(value);
}

/** Whitelist entries are documented as strings to avoid precision loss. */
function toQqNumber(value: string): string {
  if (!/^\d{1,20}$/.test(value)) {
    throw new ToolInputError(`${value} is not a QQ number.`);
  }
  return value;
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = readOptionalString(args, key);
  if (value === undefined) {
    throw new ToolInputError(`${key} is required.`);
  }
  return value;
}

function readOptionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`${key} must be a string.`);
  }
  return value.trim() === '' ? undefined : value.trim();
}

function readStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ToolInputError(`${key} must be an array of strings.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ToolInputError(`${key} entries must be non-empty strings.`);
    }
    return item.trim();
  });
}

function readOptionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`${key} must be a boolean.`);
  }
  return value;
}

function readOptionalInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolInputError(`${key} must be an integer.`);
  }
  return value;
}

/** Page sizes the platform caps; rejecting them here saves a round trip. */
function readPageSize(
  args: Record<string, unknown>,
  key: string,
  max: number,
): number | undefined {
  const value = readOptionalInteger(args, key);
  if (value === undefined) return undefined;
  if (value < 1 || value > max) {
    throw new ToolInputError(`${key} must be between 1 and ${max}.`);
  }
  return value;
}

function assertMaxEntries(
  values: string[] | undefined,
  max: number,
  key: string,
): void {
  if (values && values.length > max) {
    throw new ToolInputError(`${key} accepts at most ${max} entries.`);
  }
}

function assertMaxChars(
  value: string | undefined,
  max: number,
  key: string,
): void {
  if (value !== undefined && [...value].length > max) {
    throw new ToolInputError(`${key} accepts at most ${max} characters.`);
  }
}

function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = readOptionalEnum(args, key, allowed);
  if (value === undefined) {
    throw new ToolInputError(`${key} is required.`);
  }
  return value;
}

function readOptionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readOptionalString(args, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new ToolInputError(`${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function stringify(data: unknown): string {
  if (data === undefined) return '{}';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
