/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireSessionId } from './request-helpers.js';

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
