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
    currentSenderId: () => undefined,
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
  it('exposes the full group-management surface once each', () => {
    const { tools } = harness();
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'qq_recall_message',
      'qq_get_group_info',
      'qq_get_bot_state',
      'qq_list_join_requests',
      'qq_review_join_request',
      'qq_get_mute_status',
      'qq_set_mute',
      'qq_list_join_approval_strategies',
      'qq_create_join_approval_strategy',
      'qq_update_join_approval_strategy',
      'qq_delete_join_approval_strategy',
      'qq_execute_join_approval_strategy',
      'qq_set_join_approval_whitelist',
      'qq_list_group_members',
      'qq_get_group_member',
      'qq_kick_member',
      'qq_list_member_blacklist',
      'qq_update_member_blacklist',
    ]);
  });

  it('every tool declares a JSON-schema object input', () => {
    for (const tool of harness().tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('declares additionalProperties false and the argument properties the model calls with', () => {
    for (const tool of harness().tools) {
      expect(tool.inputSchema).toMatchObject({
        additionalProperties: false,
      });
    }
    const tool = harness().tools[0];
    const properties = (
      tool!.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    expect(properties).toHaveProperty('message_id');
    expect(properties).toHaveProperty('member_openid');
  });

  it('tells the model a target is required and never claims a time limit', () => {
    const description = harness().tools[0]!.description;
    expect(description).toContain('requires a target');
    expect(description).toContain('There is no implicit target');
    expect(description).toContain("never recalls the bot's own messages");
    expect(description).toContain('allowMention');
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
    expect(textOf(result)).toContain('moderationRecallWindowMs is 0');
    expect(textOf(result)).toContain('ask the operator for the message_id');
    expect(textOf(result)).not.toContain('pass message_id explicitly instead');
    expect(calls).toHaveLength(0);
  });

  it('refuses to recall another member’s message for the requester', async () => {
    const { call, calls, dropped } = harness({
      currentSenderId: () => 'REQUESTER',
      recentMemberMessage: () => 'M-MEMBER',
    });
    const result = await call('qq_recall_message', {
      member_openid: 'OTHER',
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("sender's own message");
    expect(textOf(result)).toContain('REQUESTER');
    expect(calls).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it('allows a member to recall their own message and an operator turn to target a member', async () => {
    const own = harness({
      currentSenderId: () => 'M1',
      recentMemberMessage: () => 'M-OWN',
    });
    await own.call('qq_recall_message', { member_openid: 'M1' });
    expect(own.calls[0]?.path).toBe('/v2/groups/G123/messages/M-OWN');

    const operator = harness({
      currentSenderId: () => undefined,
      recentMemberMessage: () => 'M-MEMBER',
    });
    await operator.call('qq_recall_message', { member_openid: 'OTHER' });
    expect(operator.calls[0]?.path).toBe('/v2/groups/G123/messages/M-MEMBER');
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

  it('drops the target when the platform call never completed', async () => {
    // No platform verdict: the id may or may not be gone, so a later recall
    // must resolve the previous message instead of retrying this one.
    const requests: Recorded[] = [];
    let attempt = 0;
    const { call, dropped } = harness({
      recentMemberMessage: () => (attempt === 0 ? 'M2' : 'M1'),
      request: async (input) => {
        requests.push(input as Recorded);
        attempt += 1;
        return attempt === 1
          ? { ok: false, status: 0, message: 'The operation was aborted' }
          : { ok: true, status: 204, data: undefined };
      },
    });
    const first = await call('qq_recall_message', {
      member_openid: 'A'.repeat(32),
    });
    expect(textOf(first)).toContain('message_id="M2"');
    expect(dropped).toEqual([{ chatId: 'G123', messageId: 'M2' }]);

    const second = await call('qq_recall_message', {
      member_openid: 'A'.repeat(32),
    });
    expect(second).toBe('Message recalled (M1).');
    expect(requests[1]?.path).toBe('/v2/groups/G123/messages/M1');
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
    expect(textOf(result)).not.toContain('ordinary member');
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

describe('group-scoped guards', () => {
  it('rejects group tools in a direct-message session', async () => {
    const { call, calls } = harness({
      resolveChat: () => ({ chatId: 'U9', isGroup: false }),
    });
    const result = await call('qq_kick_member', { member_openid: 'M1' });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('only applies to a group chat');
    expect(calls).toHaveLength(0);
  });

  it('rejects group tools before the session has a chat binding', async () => {
    const { call, calls } = harness({ resolveChat: () => undefined });
    const result = await call('qq_get_bot_state');
    expect(isError(result)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('lets bot-scoped strategy tools run without a chat binding', async () => {
    const { call, calls } = harness({ resolveChat: () => undefined });
    await call('qq_list_join_approval_strategies');
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/v2/groups/join_approval_strategy',
    });
  });

  it('binds each call to the chat of the calling session', async () => {
    const resolveChat = vi.fn(() => ({ chatId: 'G123', isGroup: true }));
    const { call } = harness({ resolveChat });
    await call('qq_get_group_info');
    expect(resolveChat).toHaveBeenCalledWith('S1');
  });
});

describe('platform failure mapping for the group tools', () => {
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
    const result = await call('qq_kick_member', { member_openid: 'M1' });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('allowlist-only');
    expect(textOf(result)).toContain('11253');
  });

  it('maps 40062003 to the admin and ordinary-member explanation', async () => {
    const { call } = harness(
      {},
      {
        ok: false,
        status: 403,
        code: 40062003,
        message: '无操作权限',
      },
    );
    const result = textOf(
      await call('qq_set_mute', { member_openid: 'M1', op: 'add' }),
    );
    expect(result).toContain('group admin');
    expect(result).toContain('ordinary member');
  });
});

describe('group-management request shapes', () => {
  it('get group info and bot state use the group path', async () => {
    const { call, calls } = harness();
    await call('qq_get_group_info');
    await call('qq_get_bot_state');
    expect(calls.map((entry) => entry.path)).toEqual([
      '/v2/groups/G123/info',
      '/v2/groups/G123/bot_state',
    ]);
  });

  it('passes pagination as query parameters', async () => {
    const { call, calls } = harness();
    await call('qq_list_join_requests', { cursor: 'C1', limit: 10 });
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/v2/groups/G123/join_request_list?cursor=C1&limit=10',
    });
  });

  it('reviews a join request with op and optional fields', async () => {
    const { call, calls } = harness();
    await call('qq_review_join_request', {
      member_openid: 'M1',
      op: 'decline',
      join_request_id: 'JR1',
      reject_reason: 'spam',
      add_to_member_blacklist: true,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/G123/approval_join_request/M1',
      body: {
        op: 'decline',
        join_request_id: 'JR1',
        reject_reason: 'spam',
        add_to_member_blacklist: true,
      },
    });
  });

  it('requires an approval op', async () => {
    const { call, calls } = harness();
    const result = await call('qq_review_join_request', {
      member_openid: 'M1',
      op: 'maybe',
    });
    expect(isError(result)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sets a single member mute with an expiry', async () => {
    const { call, calls } = harness();
    await call('qq_set_mute', {
      member_openid: 'M1',
      op: 'add',
      mute_expire_at: '2026-08-05T11:23:05+08:00',
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/G123/restrict_chat_setting',
      body: {
        members: [
          {
            op: 'add',
            member_openid: 'M1',
            mute_expire_at: '2026-08-05T11:23:05+08:00',
          },
        ],
      },
    });
  });

  it('forwards a single-member mute without an expiry, like the bulk form', async () => {
    const { call, calls } = harness();
    await call('qq_set_mute', { member_openid: 'M1', op: 'add' });
    expect(calls[0]?.body).toEqual({
      members: [{ op: 'add', member_openid: 'M1' }],
    });
  });

  it('accepts the bulk mute form and rejects more than 20 members', async () => {
    const { call, calls } = harness();
    await call('qq_set_mute', {
      members: [{ op: 'del', member_openid: 'M1' }],
    });
    expect(calls[0]?.body).toEqual({
      members: [{ op: 'del', member_openid: 'M1' }],
    });
    const tooMany = await call('qq_set_mute', {
      members: Array.from({ length: 21 }, (_, index) => ({
        op: 'del',
        member_openid: `M${index}`,
      })),
    });
    expect(textOf(tooMany)).toContain('At most 20');
  });

  it('creates a strategy with group_ids as numbers', async () => {
    const { call, calls } = harness();
    await call('qq_create_join_approval_strategy', {
      group_ids: ['123456'],
      is_enable: 'off',
      remark: 'class group',
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/join_approval_strategy',
      body: {
        group_ids: [123456],
        is_enable: 'off',
        remark: 'class group',
      },
    });
  });

  it('rejects a strategy with both or neither group selector', async () => {
    const { call, calls } = harness();
    expect(
      textOf(await call('qq_create_join_approval_strategy', {})),
    ).toContain('exactly one of');
    expect(
      textOf(
        await call('qq_create_join_approval_strategy', {
          group_ids: ['1'],
          group_openids: ['A'.repeat(32)],
        }),
      ),
    ).toContain('exactly one of');
    expect(calls).toHaveLength(0);
  });

  it('caps the client-side limits the platform documents', async () => {
    const { call, calls } = harness();
    expect(
      textOf(await call('qq_list_join_requests', { limit: 51 })),
    ).toContain('between 1 and 50');
    expect(
      textOf(await call('qq_list_member_blacklist', { limit: 101 })),
    ).toContain('between 1 and 100');
    expect(
      textOf(
        await call('qq_create_join_approval_strategy', {
          group_ids: Array.from({ length: 101 }, (_, i) => String(i + 1)),
        }),
      ),
    ).toContain('at most 100 entries');
    expect(
      textOf(
        await call('qq_create_join_approval_strategy', {
          group_ids: ['1'],
          remark: 'x'.repeat(256),
        }),
      ),
    ).toContain('at most 255 characters');
    expect(
      textOf(
        await call('qq_update_join_approval_strategy', {
          strategy_id: 'st_1',
          remark: 'x'.repeat(256),
        }),
      ),
    ).toContain('at most 255 characters');
    expect(calls).toHaveLength(0);
  });

  it('rejects a group number too long to survive a JSON number', async () => {
    const { call, calls } = harness();
    const result = await call('qq_create_join_approval_strategy', {
      group_ids: ['9999999999999999'],
    });
    expect(textOf(result)).toContain('is not a QQ group number');
    expect(calls).toHaveLength(0);
  });

  it('updates a strategy through PATCH with a group action', async () => {
    const { call, calls } = harness();
    await call('qq_update_join_approval_strategy', {
      strategy_id: 'st_1',
      group_action: { op: 'add', group_openids: ['A'.repeat(32)] },
    });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/v2/groups/join_approval_strategy/st_1',
      body: { group_action: { op: 'add', group_openids: ['A'.repeat(32)] } },
    });
  });

  it('rejects an update with no fields', async () => {
    const { call, calls } = harness();
    expect(
      textOf(
        await call('qq_update_join_approval_strategy', {
          strategy_id: 'st_1',
        }),
      ),
    ).toContain('Provide at least one of');
    expect(calls).toHaveLength(0);
  });

  it('deletes and executes strategies on their own paths', async () => {
    const { call, calls } = harness();
    await call('qq_delete_join_approval_strategy', { strategy_id: 'st_1' });
    await call('qq_execute_join_approval_strategy', { strategy_id: 'st_1' });
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v2/groups/join_approval_strategy/st_1' },
      {
        method: 'POST',
        path: '/v2/groups/join_approval_strategy/st_1/execute',
      },
    ]);
  });

  it('keeps whitelist numbers as strings and caps the batch', async () => {
    const { call, calls } = harness();
    await call('qq_set_join_approval_whitelist', {
      strategy_id: 'st_1',
      op: 'add',
      whitelist_users: ['12345678901234567890'],
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/join_approval_strategy/st_1/whitelist_users',
      body: { op: 'add', whitelist_users: ['12345678901234567890'] },
    });
    const tooMany = await call('qq_set_join_approval_whitelist', {
      strategy_id: 'st_1',
      op: 'add',
      whitelist_users: Array.from({ length: 10001 }, (_, i) => String(i)),
    });
    expect(textOf(tooMany)).toContain('At most 10000');
  });

  it('lists members and member details on the reserved endpoints', async () => {
    const { call, calls } = harness();
    await call('qq_list_group_members', { cursor: 'C2' });
    await call('qq_get_group_member', { member_openid: 'M1' });
    expect(calls).toEqual([
      { method: 'GET', path: '/v2/groups/G123/members?cursor=C2' },
      { method: 'GET', path: '/v2/groups/G123/members/M1' },
    ]);
  });

  it('kicks members with the blacklist flag', async () => {
    const { call, calls } = harness();
    await call('qq_kick_member', {
      member_openids: ['M1', 'M2'],
      add_to_member_blacklist: true,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/G123/batch_remove_members',
      body: { member_openids: ['M1', 'M2'], add_to_member_blacklist: true },
    });
  });

  it('rejects a kick that names both target forms instead of dropping one', async () => {
    const { call, calls } = harness();
    const result = await call('qq_kick_member', {
      member_openid: 'M1',
      member_openids: ['M2'],
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('not both');
    expect(calls).toHaveLength(0);
  });

  it('treats an empty member_openids array as absent', async () => {
    const { call, calls } = harness();
    await call('qq_kick_member', {
      member_openid: 'M1',
      member_openids: [],
    });
    expect(calls[0]?.body).toEqual({ member_openids: ['M1'] });
  });

  it('updates the blacklist with an op', async () => {
    const { call, calls } = harness();
    await call('qq_update_member_blacklist', {
      op: 'add',
      member_openids: ['M1'],
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v2/groups/G123/member_blacklist',
      body: { op: 'add', member_openids: ['M1'] },
    });
    const badOp = await call('qq_update_member_blacklist', {
      op: 'remove',
      member_openids: ['M1'],
    });
    expect(textOf(badOp)).toContain('must be one of');
  });

  it('encodes ids so a crafted value cannot escape its path segment', async () => {
    const { call, calls } = harness();
    await call('qq_get_group_member', { member_openid: 'a/../b' });
    expect(calls[0]?.path).toBe('/v2/groups/G123/members/a%2F..%2Fb');
  });

  it('logs each call outcome with the tool name', async () => {
    const { call, logs } = harness();
    await call('qq_get_group_info');
    expect(logs.join('\n')).toContain('qq_get_group_info ok');
  });
});

describe('argument validation the schemas promise', () => {
  it('rejects an unrecognized argument on every tool instead of dropping it', async () => {
    const h = harness();
    for (const tool of h.tools) {
      const result = await tool.handler(
        { __probe_unknown_key__: true },
        { sessionId: 'S1' },
      );
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('Unrecognized argument');
    }
    // qq_recall_message keeps its own wording for the accepted pair.
    const recall = h.tools.find((tool) => tool.name === 'qq_recall_message');
    const recallResult = await recall!.handler(
      { openid: 'A'.repeat(32) },
      { sessionId: 'S1' },
    );
    expect(textOf(recallResult)).toContain(
      'qq_recall_message accepts only message_id and member_openid',
    );
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a misspelled strategy argument instead of creating the strategy', async () => {
    const { call, calls } = harness();
    const result = await call('qq_create_join_approval_strategy', {
      group_ids: ['123456'],
      is_enabled: 'off',
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('is_enabled');
    expect(calls).toHaveLength(0);
  });

  it('marks every reserved endpoint in the model-facing description', () => {
    const descriptions = new Map(
      harness().tools.map((tool) => [tool.name, tool.description]),
    );
    for (const name of [
      'qq_get_group_info',
      'qq_get_bot_state',
      'qq_list_group_members',
      'qq_get_group_member',
      'qq_kick_member',
      'qq_list_member_blacklist',
      'qq_update_member_blacklist',
    ]) {
      expect(descriptions.get(name)).toContain('Reserved interface');
    }
  });

  it('forwards an explicit empty mute expiry so op=del lifts the mute now', async () => {
    const { call, calls } = harness();
    await call('qq_set_mute', {
      member_openid: 'M1',
      op: 'del',
      mute_expire_at: '',
    });
    expect(calls[0]?.body).toEqual({
      members: [{ op: 'del', member_openid: 'M1', mute_expire_at: '' }],
    });
  });

  it('forwards an explicit empty mute expiry on a bulk entry too', async () => {
    const { call, calls } = harness();
    await call('qq_set_mute', {
      members: [{ op: 'del', member_openid: 'M1', mute_expire_at: '' }],
    });
    expect(calls[0]?.body).toEqual({
      members: [{ op: 'del', member_openid: 'M1', mute_expire_at: '' }],
    });
  });

  it('rejects a bulk mute entry that omits op and names the entry', async () => {
    const { call, calls } = harness();
    const result = await call('qq_set_mute', {
      members: [{ member_openid: 'M1' }],
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('members[0].op');
    expect(calls).toHaveLength(0);
  });

  it('declares op required on bulk mute items', () => {
    const setMute = harness().byName.get('qq_set_mute')!;
    const members = (
      setMute.inputSchema as {
        properties: { members: { items: Record<string, unknown> } };
      }
    ).properties.members.items;
    expect(members).toMatchObject({ required: ['member_openid', 'op'] });
  });

  it('rejects a non-array members value instead of falling back to member_openid', async () => {
    const { call, calls } = harness();
    const result = await call('qq_set_mute', {
      members: { member_openid: 'M1', op: 'add' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('must be an array');
    expect(calls).toHaveLength(0);

    const worse = harness();
    const result2 = await worse.call('qq_set_mute', {
      members: { member_openid: 'M1', op: 'add' },
      member_openid: 'M2',
    });
    expect(isError(result2)).toBe(true);
    expect(textOf(result2)).toContain('must be an array');
    expect(worse.calls).toHaveLength(0);
  });

  it('requires op on the single-member mute form', async () => {
    const { call, calls } = harness();
    const result = await call('qq_set_mute', { member_openid: 'M1' });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('op is required');
    expect(calls).toHaveLength(0);
  });

  it('reports the mute direction in the result text and the log', async () => {
    const added = harness();
    const addedText = await added.call('qq_set_mute', {
      member_openid: 'M1',
      op: 'add',
    });
    const deleted = harness();
    const deletedText = await deleted.call('qq_set_mute', {
      member_openid: 'M1',
      op: 'del',
    });
    expect(addedText).not.toBe(deletedText);
    expect(String(addedText)).toContain('add M1');
    expect(String(deletedText)).toContain('del M1');
    expect(added.logs.join('\n')).toContain('add M1');
    expect(deleted.logs.join('\n')).toContain('del M1');
  });

  it('converts group_action group ids to JSON numbers on update', async () => {
    const { call, calls } = harness();
    await call('qq_update_join_approval_strategy', {
      strategy_id: 'st_1',
      group_action: { op: 'add', group_ids: ['123456'] },
    });
    expect(calls[0]?.body).toEqual({
      group_action: { op: 'add', group_ids: [123456] },
    });
  });
});
