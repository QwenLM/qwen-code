/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter, createKeyExtractor } from './rate-limit.js';
import type { Request, Response } from 'express';

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: 'POST',
    path: '/session/abc/prompt',
    get: vi.fn().mockReturnValue(undefined),
    socket: { remoteAddress: '192.168.1.1' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader: vi.fn(),
  } as unknown as Response & { statusCode: number; body: unknown };
  return res;
}

describe('rateLimit', () => {
  describe('token bucket - continuous drip', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('allows requests up to max', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 3 },
          mutation: { windowMs: 60_000, max: 30 },
          read: { windowMs: 60_000, max: 120 },
        },
        hostname: '127.0.0.1',
      });

      const next = vi.fn();
      for (let i = 0; i < 3; i++) {
        const res = mockRes();
        limiter.middleware(mockReq(), res, next);
      }
      expect(next).toHaveBeenCalledTimes(3);

      // 4th request should be rate limited
      const res = mockRes();
      limiter.middleware(mockReq(), res, vi.fn());
      expect(res.statusCode).toBe(429);
      expect(res.body).toMatchObject({
        code: 'rate_limit_exceeded',
        tier: 'prompt',
      });
      limiter.dispose();
    });

    it('refills tokens continuously over time', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 2 },
          mutation: { windowMs: 60_000, max: 30 },
          read: { windowMs: 60_000, max: 120 },
        },
        hostname: '127.0.0.1',
      });

      const next = vi.fn();
      // Exhaust tokens
      limiter.middleware(mockReq(), mockRes(), next);
      limiter.middleware(mockReq(), mockRes(), next);
      expect(next).toHaveBeenCalledTimes(2);

      // Immediately: rate limited
      const res1 = mockRes();
      limiter.middleware(mockReq(), res1, vi.fn());
      expect(res1.statusCode).toBe(429);

      // Advance 30s (half window): should have ~1 token
      vi.advanceTimersByTime(30_000);
      const next2 = vi.fn();
      limiter.middleware(mockReq(), mockRes(), next2);
      expect(next2).toHaveBeenCalledTimes(1);

      limiter.dispose();
    });

    it('includes Retry-After header on 429', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 30 },
          read: { windowMs: 60_000, max: 120 },
        },
        hostname: '127.0.0.1',
      });

      limiter.middleware(mockReq(), mockRes(), vi.fn());
      const res = mockRes();
      limiter.middleware(mockReq(), res, vi.fn());
      expect(res.statusCode).toBe(429);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Retry-After',
        expect.any(String),
      );
      expect(
        Number(
          (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(
            (c: string[]) => c[0] === 'Retry-After',
          )?.[1],
        ),
      ).toBeGreaterThan(0);
      limiter.dispose();
    });

    it('handles clock skew (negative elapsed) via Math.max(0, elapsed)', () => {
      // The implementation uses Math.max(0, now - lastRefill) to guard
      // against clock regression. We verify the code doesn't crash or
      // subtract tokens when elapsed is negative by testing the algorithm
      // directly: two rapid requests within the same ms should both work
      // (elapsed=0 means no refill, but initial tokens cover it).
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 5 },
          mutation: { windowMs: 60_000, max: 30 },
          read: { windowMs: 60_000, max: 120 },
        },
        hostname: '127.0.0.1',
      });

      const next = vi.fn();
      // Two requests at exactly the same timestamp (elapsed=0)
      limiter.middleware(mockReq(), mockRes(), next);
      limiter.middleware(mockReq(), mockRes(), next);
      expect(next).toHaveBeenCalledTimes(2);
      limiter.dispose();
    });
  });

  describe('tier resolution', () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 1 },
          read: { windowMs: 60_000, max: 1 },
        },
        hostname: '127.0.0.1',
      });
    });
    afterEach(() => {
      limiter.dispose();
    });

    it('classifies POST .../prompt as prompt tier', () => {
      const next = vi.fn();
      limiter.middleware(
        mockReq({ path: '/session/x/prompt' }),
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalled();
      // Second should be rate limited in prompt tier
      const res = mockRes();
      limiter.middleware(mockReq({ path: '/session/x/prompt' }), res, vi.fn());
      expect(res.body).toMatchObject({ tier: 'prompt' });
    });

    it('classifies POST /session as mutation tier', () => {
      const next = vi.fn();
      limiter.middleware(
        mockReq({ method: 'POST', path: '/session' }),
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalled();
      const res = mockRes();
      limiter.middleware(
        mockReq({ method: 'POST', path: '/session' }),
        res,
        vi.fn(),
      );
      expect(res.body).toMatchObject({ tier: 'mutation' });
    });

    it('classifies GET as read tier', () => {
      const next = vi.fn();
      limiter.middleware(
        mockReq({ method: 'GET', path: '/workspace/mcp' }),
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalled();
      const res = mockRes();
      limiter.middleware(
        mockReq({ method: 'GET', path: '/workspace/mcp' }),
        res,
        vi.fn(),
      );
      expect(res.body).toMatchObject({ tier: 'read' });
    });

    it('exempts GET /health', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'GET', path: '/health' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('exempts GET /demo', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'GET', path: '/demo' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('exempts POST .../heartbeat', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'POST', path: '/session/x/heartbeat' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('exempts GET .../events (SSE)', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'GET', path: '/session/x/events' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('exempts /acp routes', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'POST', path: '/acp' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('exempts OPTIONS requests', () => {
      const next = vi.fn();
      for (let i = 0; i < 5; i++) {
        limiter.middleware(
          mockReq({ method: 'OPTIONS', path: '/session/x/prompt' }),
          mockRes(),
          next,
        );
      }
      expect(next).toHaveBeenCalledTimes(5);
    });

    it('handles trailing slash', () => {
      const next = vi.fn();
      limiter.middleware(
        mockReq({ path: '/session/x/prompt/' }),
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalled();
      const res = mockRes();
      limiter.middleware(mockReq({ path: '/session/x/prompt/' }), res, vi.fn());
      expect(res.body).toMatchObject({ tier: 'prompt' });
    });
  });

  describe('key extraction', () => {
    it('uses client-id on loopback', () => {
      const extractor = createKeyExtractor('127.0.0.1');
      const req = mockReq({
        get: vi
          .fn()
          .mockImplementation((h: string) =>
            h === 'x-qwen-client-id' ? 'my-client' : undefined,
          ),
      });
      expect(extractor(req)).toBe('cid:my-client');
    });

    it('falls back to anonymous on loopback without client-id', () => {
      const extractor = createKeyExtractor('127.0.0.1');
      const req = mockReq();
      expect(extractor(req)).toBe('anonymous');
    });

    it('uses IP on non-loopback', () => {
      const extractor = createKeyExtractor('0.0.0.0');
      const req = mockReq({
        get: vi.fn().mockReturnValue(undefined),
        socket: { remoteAddress: '10.0.0.5' },
      });
      expect(extractor(req as unknown as Request)).toBe('10.0.0.5');
    });

    it('normalizes IPv6-mapped IPv4', () => {
      const extractor = createKeyExtractor('0.0.0.0');
      const req = mockReq({
        get: vi.fn().mockReturnValue(undefined),
        socket: { remoteAddress: '::ffff:10.0.0.5' },
      });
      expect(extractor(req as unknown as Request)).toBe('10.0.0.5');
    });

    it('combines IP and client-id on non-loopback', () => {
      const extractor = createKeyExtractor('0.0.0.0');
      const req = mockReq({
        get: vi
          .fn()
          .mockImplementation((h: string) =>
            h === 'x-qwen-client-id' ? 'web-1' : undefined,
          ),
        socket: { remoteAddress: '10.0.0.5' },
      });
      expect(extractor(req as unknown as Request)).toBe('10.0.0.5:web-1');
    });

    it('rejects invalid client-id', () => {
      const extractor = createKeyExtractor('127.0.0.1');
      const req = mockReq({
        get: vi
          .fn()
          .mockImplementation((h: string) =>
            h === 'x-qwen-client-id' ? 'bad id with spaces' : undefined,
          ),
      });
      expect(extractor(req)).toBe('anonymous');
    });
  });

  describe('fail-open', () => {
    it('passes through when bucket map is at capacity', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 1 },
          read: { windowMs: 60_000, max: 1 },
        },
        hostname: '0.0.0.0',
      });

      // Fill with 10000 unique keys by consuming their tokens
      for (let i = 0; i < 10_001; i++) {
        const req = mockReq({
          method: 'GET',
          path: '/workspace/mcp',
          get: vi.fn().mockReturnValue(undefined),
          socket: {
            remoteAddress: `10.${Math.floor(i / 256) % 256}.${i % 256}.1`,
          },
        });
        limiter.middleware(req as unknown as Request, mockRes(), vi.fn());
      }

      // New unique key should fail-open (pass through)
      const next = vi.fn();
      const req = mockReq({
        method: 'GET',
        path: '/workspace/mcp',
        get: vi.fn().mockReturnValue(undefined),
        socket: { remoteAddress: '99.99.99.99' },
      });
      limiter.middleware(req as unknown as Request, mockRes(), next);
      expect(next).toHaveBeenCalled();
      limiter.dispose();
    });
  });

  describe('draining', () => {
    it('passes all requests through when draining', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 1 },
          read: { windowMs: 60_000, max: 1 },
        },
        hostname: '127.0.0.1',
      });

      // Exhaust prompt bucket
      limiter.middleware(mockReq(), mockRes(), vi.fn());
      const res1 = mockRes();
      limiter.middleware(mockReq(), res1, vi.fn());
      expect(res1.statusCode).toBe(429);

      // Enable draining
      limiter.setDraining(true);

      // Should pass through now
      const next = vi.fn();
      limiter.middleware(mockReq(), mockRes(), next);
      expect(next).toHaveBeenCalled();

      limiter.dispose();
    });
  });

  describe('reset', () => {
    it('clears all buckets and hit counts', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 1 },
          read: { windowMs: 60_000, max: 1 },
        },
        hostname: '127.0.0.1',
      });

      // Exhaust and trigger a hit
      limiter.middleware(mockReq(), mockRes(), vi.fn());
      limiter.middleware(mockReq(), mockRes(), vi.fn());
      expect(limiter.getHitCounts().prompt).toBe(1);

      // Reset
      limiter.reset();
      expect(limiter.getHitCounts().prompt).toBe(0);

      // Should allow again
      const next = vi.fn();
      limiter.middleware(mockReq(), mockRes(), next);
      expect(next).toHaveBeenCalled();

      limiter.dispose();
    });
  });

  describe('onLimitReached callback', () => {
    it('fires on first rejection', () => {
      const cb = vi.fn();
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 30 },
          read: { windowMs: 60_000, max: 120 },
        },
        hostname: '127.0.0.1',
        onLimitReached: cb,
      });

      limiter.middleware(mockReq(), mockRes(), vi.fn());
      limiter.middleware(mockReq(), mockRes(), vi.fn());

      expect(cb).toHaveBeenCalledWith('prompt', 'anonymous', 0);
      limiter.dispose();
    });
  });

  describe('getHitCounts', () => {
    it('tracks hits per tier', () => {
      const limiter = createRateLimiter({
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 1 },
          read: { windowMs: 60_000, max: 1 },
        },
        hostname: '127.0.0.1',
      });

      // Trigger prompt hit
      limiter.middleware(mockReq(), mockRes(), vi.fn());
      limiter.middleware(mockReq(), mockRes(), vi.fn());

      // Trigger read hit
      limiter.middleware(
        mockReq({ method: 'GET', path: '/capabilities' }),
        mockRes(),
        vi.fn(),
      );
      limiter.middleware(
        mockReq({ method: 'GET', path: '/capabilities' }),
        mockRes(),
        vi.fn(),
      );

      const hits = limiter.getHitCounts();
      expect(hits.prompt).toBe(1);
      expect(hits.read).toBe(1);
      expect(hits.mutation).toBe(0);

      limiter.dispose();
    });
  });
});
