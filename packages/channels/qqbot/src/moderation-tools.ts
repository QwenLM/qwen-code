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
  request(input: {
    method: QQApiMethod;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<ModerationApiResult>;
  log(message: string): void;
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
  ): { method: QQApiMethod; path: string; body?: unknown };
  format?(data: unknown): string;
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
    "Recall a message in the current QQ chat. With no arguments it recalls the message that triggered your current turn; with member_openid it recalls that member's most recent message. Within 2 minutes only. Recalling another member's message requires the bot to be a group admin; in a direct chat the platform only recalls messages the bot sent itself, so pass message_id explicitly there.",
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
  },
  build(args, deps, chat, sessionId) {
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
          `No message from ${member} in this chat is still inside the 2-minute recall window.`,
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
    };
  },
  format: () => 'Message recalled.',
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
      let request: { method: QQApiMethod; path: string; body?: unknown };
      try {
        request = spec.build(args, deps, chat, context.sessionId);
      } catch (error) {
        if (error instanceof ToolInputError) return fail(error.message);
        throw error;
      }
      const result = await deps.request({
        method: request.method,
        path: request.path,
        ...(request.body === undefined
          ? {}
          : { body: request.body as Record<string, unknown> }),
      });
      if (!result.ok) {
        const text = describeFailure(spec.name, result);
        deps.log(`${spec.name} failed: ${text}`);
        return fail(text);
      }
      deps.log(`${spec.name} ok (HTTP ${result.status})`);
      const formatted = spec.format?.(result.data) ?? stringify(result.data);
      return formatted;
    },
  }));
}

/** Argument errors are reported to the model, not thrown at the bridge. */
class ToolInputError extends Error {}

function describeFailure(
  tool: string,
  result: Extract<ModerationApiResult, { ok: false }>,
): string {
  switch (result.code) {
    case 11253:
      return `${tool}: the platform refused (11253 ${result.message}) — this endpoint is allowlist-only for the bot app.`;
    case 40062003:
      return `${tool}: the platform refused (40062003 ${result.message}) — no permission for this operation: the bot must be a group admin, and the target must be an ordinary member (not the owner, an admin or a bot).`;
    case 40064004:
      return `${tool}: the platform refused (40064004 ${result.message}) — the message is older than the 2-minute recall window.`;
    case 50065001:
      return `${tool}: the platform failed to recall the message (50065001 ${result.message}); it is safe to retry.`;
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
