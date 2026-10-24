/**
 * QQ group-management tools exposed to the agent as client MCP tools.
 *
 * The model calls these tools autonomously during a turn; the adapter owns the
 * chat binding and the credentials, this module owns the schemas, argument
 * validation, and the mapping from QQ error codes to text the model can act
 * on.
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
  /** Message id of the turn that is invoking the tool, when there is one. */
  currentMessageId(sessionId: string): string | undefined;
  /** Newest still-recallable message from a member in the chat. */
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

/** The message a request resolved to, for logging and the model-visible echo. */
interface RecallTarget {
  chatId: string;
  messageId: string;
  /** Which argument resolved the target. */
  source: 'message_id' | 'member_openid' | 'turn';
}

interface ToolRequest {
  method: QQApiMethod;
  path: string;
  body?: Record<string, unknown>;
  target: RecallTarget;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build(
    args: Record<string, unknown>,
    deps: ModerationToolDeps,
    chat: ModerationChat | undefined,
    sessionId: string,
  ): ToolRequest;
  format?(data: unknown, target: RecallTarget): string;
}

/** The recall tool acts inside a group, so it needs the bound chat. */
function requireGroup(chat: ModerationChat | undefined): ModerationChat {
  if (!chat || !chat.isGroup) {
    throw new ToolInputError(
      'This tool only applies to a QQ group chat session.',
    );
  }
  return chat;
}

const RECALL_TOOL: ToolSpec = {
  name: 'qq_recall_message',
  description:
    "Recall a message in the current QQ chat. With no arguments it recalls the message that triggered your current turn — the inbound message the bot is answering, not the bot's own reply; with member_openid it recalls that member's most recent message. Within 2 minutes only, and only for messages this channel received: ordinary non-@ group messages arrive only when groupAllPolicy is 'keyword', 'all' or 'log'. Recalling another member's message requires the bot to be a group admin; in a direct chat the platform only recalls messages the bot sent itself, so pass message_id explicitly there.",
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description:
          'Explicit message id. Normally omit in a group chat and let the tool resolve the target; required in a direct chat.',
      },
      member_openid: {
        type: 'string',
        description:
          "The member's openid whose most recent message should be recalled.",
      },
    },
    additionalProperties: false,
  },
  build(args, deps, chat, sessionId) {
    // The schema declares additionalProperties: false, but the model can still
    // send a renamed key. Silently ignoring it would fall through to the
    // destructive implicit target, so reject the call instead.
    const unknown = Object.keys(args).filter(
      (key) => key !== 'message_id' && key !== 'member_openid',
    );
    if (unknown.length > 0) {
      throw new ToolInputError(
        `Unrecognized argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. qq_recall_message accepts only message_id and member_openid.`,
      );
    }
    const explicit = readOptionalString(args, 'message_id');
    const member = readOptionalString(args, 'member_openid');
    const resolvedChat = chat ?? requireGroup(chat);
    // The C2C endpoint only recalls the bot's own messages, and this turn's
    // id belongs to the user, so resolving it would send a guaranteed failure.
    if (!resolvedChat.isGroup && !explicit) {
      throw new ToolInputError(
        "A direct chat can only recall the bot's own messages, and this turn carries no such message id — pass message_id explicitly (group chats can recall a member's message with member_openid).",
      );
    }
    // A named member never falls back to "this turn's message": that id may
    // belong to someone else, and recalling the wrong message is worse than
    // reporting that the target cannot be resolved.
    let messageId = explicit;
    if (!messageId && member) {
      messageId = deps.recentMemberMessage(resolvedChat.chatId, member);
      if (!messageId) {
        throw new ToolInputError(
          `No message from ${member} is still tracked for recall in this chat — it may be outside the 2-minute recall window, evicted from the per-chat ring, or never delivered to the bot (ordinary group messages need groupAllPolicy 'keyword', 'all' or 'log').`,
        );
      }
    }
    messageId ??= deps.currentMessageId(sessionId);
    if (!messageId) {
      throw new ToolInputError(
        'No message id could be resolved for this turn; pass message_id explicitly.',
      );
    }
    const scope = resolvedChat.isGroup ? 'groups' : 'users';
    return {
      method: 'DELETE',
      path: `/v2/${scope}/${encodePart(resolvedChat.chatId)}/messages/${encodePart(messageId)}`,
      target: {
        chatId: resolvedChat.chatId,
        messageId,
        source: explicit ? 'message_id' : member ? 'member_openid' : 'turn',
      },
    };
  },
  format: (_data, target) => `Message recalled (${target.messageId}).`,
};

const TOOL_SPECS: ToolSpec[] = [RECALL_TOOL];

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
      if (!chat) {
        return fail(
          'No QQ chat is bound to this session yet, so no group action is possible.',
        );
      }
      let request: ToolRequest;
      try {
        request = spec.build(args, deps, chat, context.sessionId);
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
        `${spec.name} ok (HTTP ${result.status}) target=${request.target.chatId}/${request.target.messageId} via=${request.target.source}`,
      );
      // A successful recall destroys the target, so a repeat member-targeted
      // call must resolve the previous message rather than this one. The
      // eviction is success-only: a failed DELETE must leave the target so the
      // operator can retry the same message.
      deps.dropRecentMessage(request.target.chatId, request.target.messageId);
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
  target: RecallTarget,
): string {
  switch (result.code) {
    case 11253:
      return `${tool}: the platform refused (11253 ${result.message}) — this endpoint is allowlist-only for the bot app.`;
    case 40062003:
      return `${tool}: the platform refused (40062003 ${result.message}) — no permission for this operation: the bot must be a group admin.`;
    case 40064004:
      return `${tool}: the platform refused (40064004 ${result.message}) — the message is older than the 2-minute recall window.`;
    case 50065001:
      return `${tool}: the platform failed to recall the message (50065001 ${result.message}); it is safe to retry with message_id="${target.messageId}" so the same message is recalled.`;
    case 40061001:
      return `${tool}: the platform rejected the parameters (40061001 ${result.message}).`;
    default:
      return result.status === 0
        ? `${tool}: the platform call did not complete: ${result.message}`
        : `${tool}: platform call failed (HTTP ${result.status}${result.code === undefined ? '' : `, code ${result.code}`}): ${result.message}`;
  }
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
