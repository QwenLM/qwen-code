import { describe, expect, it } from 'bun:test';
import { handleListSessions } from './list-sessions.ts';
import type { ListSessionsOptions, SessionToolContext } from '../context.ts';

function createCtx(
  onListSessions: (options?: ListSessionsOptions) => void,
): SessionToolContext {
  return {
    listSessions: (options?: ListSessionsOptions) => {
      onListSessions(options);
      return {
        total: 1,
        returned: 1,
        sessions: [
          {
            id: 'session-123',
            name: 'Example',
            labels: [],
            status: 'todo',
            createdAt: 1,
          },
        ],
      };
    },
  } as unknown as SessionToolContext;
}

describe('handleListSessions', () => {
  it('rejects malformed pagination values before listing sessions', async () => {
    const cases: Array<{ args: ListSessionsOptions; message: string }> = [
      { args: { limit: 0 }, message: 'limit must be a positive integer.' },
      { args: { limit: -1 }, message: 'limit must be a positive integer.' },
      { args: { limit: 1.5 }, message: 'limit must be a positive integer.' },
      {
        args: { offset: -1 },
        message: 'offset must be a non-negative integer.',
      },
      {
        args: { offset: 1.5 },
        message: 'offset must be a non-negative integer.',
      },
    ];

    for (const { args, message } of cases) {
      const calls: Array<ListSessionsOptions | undefined> = [];
      const ctx = createCtx((options) => calls.push(options));

      const result = await handleListSessions(ctx, args);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(message);
      expect(calls).toEqual([]);
    }
  });

  it('accepts minimum valid pagination boundaries', async () => {
    const calls: Array<ListSessionsOptions | undefined> = [];
    const ctx = createCtx((options) => calls.push(options));

    const result = await handleListSessions(ctx, { limit: 1, offset: 0 });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ limit: 1, offset: 0 }]);
  });

  it('passes valid pagination values through to the session lister', async () => {
    const calls: Array<ListSessionsOptions | undefined> = [];
    const ctx = createCtx((options) => calls.push(options));

    const result = await handleListSessions(ctx, {
      status: 'todo',
      limit: 2,
      offset: 1,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ status: 'todo', limit: 2, offset: 1 }]);
  });

  it('preserves high integer limits for the backend clamp', async () => {
    const calls: Array<ListSessionsOptions | undefined> = [];
    const ctx = createCtx((options) => calls.push(options));

    const result = await handleListSessions(ctx, { limit: 101 });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ limit: 101 }]);
  });
});
