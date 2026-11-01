/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { parseRefreshSessionIds, requireSessionId } from './request-helpers.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnValue({ json: vi.fn() });
  return { res: { status } as unknown as Response, status };
}

describe('requireSessionId', () => {
  it('normalizes caller-visible UUID route parameters', () => {
    const { res, status } = mockRes();
    const req = {
      params: { id: '550E8400-E29B-41D4-A716-446655440000' },
    } as unknown as Request;

    expect(requireSessionId(req, res)).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(status).not.toHaveBeenCalled();
  });
});

describe('parseRefreshSessionIds', () => {
  it.each([undefined, {}])('accepts an omitted selection in %j', (body) => {
    const { res, status } = mockRes();
    const getSessionSummary = vi.fn();
    expect(parseRefreshSessionIds(body, res, { getSessionSummary })).toEqual(
      {},
    );
    expect(status).not.toHaveBeenCalled();
    expect(getSessionSummary).not.toHaveBeenCalled();
  });

  it.each(['[]', '["session-1"]', 'null', '42', '"session-1"', 'true'])(
    'rejects a non-object request body %s without looking up sessions',
    (json) => {
      const { res, status } = mockRes();
      const getSessionSummary = vi.fn();
      expect(
        parseRefreshSessionIds(JSON.parse(json), res, { getSessionSummary }),
      ).toBeUndefined();
      expect(status).toHaveBeenCalledWith(400);
      expect(getSessionSummary).not.toHaveBeenCalled();
    },
  );

  it('normalizes caller UUIDs before deduplication and lookup', () => {
    const { res, status } = mockRes();
    const getSessionSummary = vi.fn();
    const id = '550e8400-e29b-41d4-a716-446655440000';

    expect(
      parseRefreshSessionIds({ sessionIds: [id.toUpperCase(), id] }, res, {
        getSessionSummary,
      }),
    ).toEqual({ sessionIds: [id] });
    expect(getSessionSummary).toHaveBeenCalledExactlyOnceWith(id);
    expect(status).not.toHaveBeenCalled();
  });

  it('preserves case in legacy and internal session IDs', () => {
    const { res } = mockRes();
    const getSessionSummary = vi.fn();
    const sessionIds = [
      'Legacy-Session',
      '550e8400-e29b-41d4-a716-446655440000-agent-MyAgent',
    ];

    expect(
      parseRefreshSessionIds({ sessionIds }, res, { getSessionSummary }),
    ).toEqual({ sessionIds });
    expect(getSessionSummary.mock.calls).toEqual(sessionIds.map((id) => [id]));
  });
});
