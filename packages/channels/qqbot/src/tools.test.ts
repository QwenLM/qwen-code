import { describe, it, expect, vi } from 'vitest';
import {
  buildModerationTools,
  type ModerationApiResult,
  type ModerationToolDeps,
} from './moderation-tools.js';

interface Recorded {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function harness(
  overrides: Partial<ModerationToolDeps> = {},
  response: ModerationApiResult = { ok: true, status: 200, data: {} },
) {
  const calls: Recorded[] = [];
  const logs: string[] = [];
  const dropped: Array<{ chatId: string; messageId: string }> = [];
  const deps: ModerationToolDeps = {
    resolveChat: () => ({ chatId: 'G123', isGroup: true }),
    memberRecallDisabled: false,
    recentMemberMessage: () => undefined,
    dropRecentMessage: (chatId, messageId) => {
      dropped.push({ chatId, messageId });
    },
    request: async (input) => {
      calls.push(input as Recorded);
      return response;
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  const tools = buildModerationTools(deps);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    sessionId = 'S1',
  ) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.handler(args, { sessionId });
  };
  return { tools, byName, call, calls, logs, dropped };
}

function textOf(result: unknown): string {
  return typeof result === 'string'
    ? result
    : (result as { text: string }).text;
}

function isError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: boolean }).isError === true
  );
}

describe('buildModerationTools', () => {
  it('exposes the recall tool once', () => {
    const { tools } = harness();
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['qq_recall_message']);
  });

  it('every tool declares a JSON-schema object input', () => {
    for (const tool of harness().tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('declares the argument properties the model calls the tool with', () => {
    const tool = harness().tools[0];
    const properties = (
      tool!.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    expect(properties).toHaveProperty('message_id');
    expect(properties).toHaveProperty('member_openid');
    expect(tool!.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it('tells the model a target is required and never claims a time limit', () => {
    const description = harness().tools[0]!.description;
    expect(description).toContain('requires a target');
    expect(description).toContain('There is no implicit target');
    expect(description).toContain("never recalls the bot's own messages");
    expect(description).not.toMatch(/2.minute|two.minute/i);
  });
});

describe('qq_recall_message', () => {
  it('rejects a call that names no target', async () => {
    const { call, calls } = harness();
    const result = await call('qq_recall_message');
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('needs a target');
    expect(textOf(result)).toContain('member_openid');
    expect(textOf(result)).toContain('message_id');
    expect(textOf(result)).toContain('no implicit target');
    expect(calls).toHaveLength(0);
  });

  it("recalls a member's most recent tracked message", async () => {
    const { call, calls } = harness({
      recentMemberMessage: () => 'M-MEMBER',
    });
    await call('qq_recall_message', { member_openid: 'A'.repeat(32) });
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: '/v2/groups/G123/messages/M-MEMBER',
    });
  });

  it('uses the explicit message id first', async () => {
    const { call, calls } = harness({
      recentMemberMessage: () => 'M-MEMBER',
    });
    await call('qq_recall_message', { message_id: 'M-EXPLICIT' });
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: '/v2/groups/G123/messages/M-EXPLICIT',
    });
  });

  it('rejects every direct-chat call, even with an explicit id', async () => {
    const { call, calls } = harness({
      resolveChat: () => ({ chatId: 'U9', isGroup: false }),
    });
    const result = await call('qq_recall_message', { message_id: 'M-DM' });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('does not support direct chats');
    expect(textOf(result)).toContain("bot's own messages");
    expect(calls).toHaveLength(0);
  });

  it('rejects a direct-chat call that names no target', async () => {
    const { call, calls } = harness({
      resolveChat: () => ({ chatId: 'U9', isGroup: false }),
    });
    const result = await call('qq_recall_message');
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('direct chat');
    expect(calls).toHaveLength(0);
  });

  it('reports when a member has no tracked message', async () => {
    const { call, calls } = harness();
    const result = await call('qq_recall_message', {
      member_openid: 'A'.repeat(32),
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('still tracked');
    expect(textOf(result)).toContain('per-chat history');
    expect(textOf(result)).toContain('never delivered to the bot');
    expect(textOf(result)).not.toMatch(/2.minute/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects member_openid when member-targeted recall is disabled', async () => {
    const { call, calls } = harness({ memberRecallDisabled: true });
    const result = await call('qq_recall_message', {
      member_openid: 'A'.repeat(32),
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('disabled');
    expect(calls).toHaveLength(0);
  });

  it('still recalls an explicit id when member-targeted recall is disabled', async () => {
    const { call, calls } = harness({ memberRecallDisabled: true });
    const result = await call('qq_recall_message', {
      message_id: 'M-EXPLICIT',
    });
    expect(isError(result)).toBe(false);
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: '/v2/groups/G123/messages/M-EXPLICIT',
    });
  });

  it('resolves the chat bound to the calling session', async () => {
    const resolveChat = vi.fn(() => ({ chatId: 'G123', isGroup: true }));
    const { call } = harness({ resolveChat });
    await call('qq_recall_message', { message_id: 'M1' });
    expect(resolveChat).toHaveBeenCalledWith('S1');
  });

  it('rejects a non-string message id as a tool error', async () => {
    const { call, calls } = harness();
    const result = await call('qq_recall_message', { message_id: 123 });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('message_id must be a string');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unrecognized argument instead of falling back to the implicit target', async () => {
    const { call, calls } = harness({
      recentMemberMessage: () => 'M-MEMBER',
    });
    const result = await call('qq_recall_message', { openid: 'A'.repeat(32) });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('Unrecognized argument');
    expect(textOf(result)).toContain('openid');
    expect(calls).toHaveLength(0);
  });

  it('drops the recalled message from the ring after a successful call', async () => {
    const { call, dropped } = harness({
      recentMemberMessage: () => 'M-MEMBER',
    });
    await call('qq_recall_message', { member_openid: 'A'.repeat(32) });
    expect(dropped).toEqual([{ chatId: 'G123', messageId: 'M-MEMBER' }]);
  });

  it('keeps the target when the platform call failed, so it can be retried', async () => {
    const { call, dropped } = harness(
      { recentMemberMessage: () => 'M-MEMBER' },
      { ok: false, status: 500, code: 50065001, message: '撤回失败' },
    );
    await call('qq_recall_message', { member_openid: 'A'.repeat(32) });
    expect(dropped).toHaveLength(0);
  });
});

describe('platform failure mapping', () => {
  it('maps 11253 to the allowlist explanation', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 403,
        code: 11253,
        message: '应用无接口访问权限',
      },
    );
    const result = await call('qq_recall_message', { message_id: 'M1' });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('allowlist-only');
    expect(textOf(result)).toContain('11253');
  });

  it('maps 40062003 to the group-admin explanation', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 403,
        code: 40062003,
        message: '无操作权限',
      },
    );
    const result = await call('qq_recall_message', { message_id: 'M1' });
    expect(textOf(result)).toContain('group admin');
  });

  it('maps 40064004 to a no-longer-recallable explanation', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 403,
        code: 40064004,
        message: '已超出消息撤回时限',
      },
    );
    const result = textOf(
      await call('qq_recall_message', { message_id: 'M1' }),
    );
    expect(result).toContain('can no longer be recalled');
    expect(result).not.toMatch(/2.minute/i);
  });

  it('keeps the raw status and message for unknown failures', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 500,
        message: 'boom',
      },
    );
    const result = textOf(
      await call('qq_recall_message', { message_id: 'M1' }),
    );
    expect(result).toContain('HTTP 500');
    expect(result).toContain('boom');
  });

  it('maps 50065001 to the retry explanation', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 500,
        code: 50065001,
        message: '撤回失败',
      },
    );
    const result = textOf(
      await call('qq_recall_message', { message_id: 'M1' }),
    );
    expect(result).toContain('50065001');
    expect(result).toContain('safe to retry');
    expect(result).toContain('M1');
  });

  it('reports a call that never reached the platform without a status', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 0,
        message: 'connection reset',
      },
    );
    const result = textOf(
      await call('qq_recall_message', { message_id: 'M1' }),
    );
    expect(result).toContain('did not complete');
    expect(result).toContain('connection reset');
  });
});

describe('request shapes', () => {
  it('encodes ids so a crafted value cannot escape its path segment', async () => {
    const { call, calls } = harness();
    await call('qq_recall_message', { message_id: 'a/../b' });
    expect(calls[0]?.path).toBe('/v2/groups/G123/messages/a%2F..%2Fb');
  });

  it('logs each call outcome with the tool name and the resolved target', async () => {
    const { call, logs } = harness();
    await call('qq_recall_message', { message_id: 'M1' });
    expect(logs.join('\n')).toContain('qq_recall_message ok');
    expect(logs.join('\n')).toContain('target=G123/M1 via=message_id');
  });
});
