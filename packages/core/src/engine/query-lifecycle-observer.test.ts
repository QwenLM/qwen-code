/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  QueryLifecycleRunner,
  type QueryLifecycleContext,
  type QueryLifecycleObserver,
} from './query-lifecycle-observer.js';
import type { QueryBusinessContext } from '../core/query-business-context.js';
import type { Terminal } from '../core/query-event.js';

function createCtx(
  overrides?: Partial<QueryLifecycleContext>,
): QueryLifecycleContext {
  return {
    sessionId: 'session-1',
    promptId: 'prompt-1',
    requestSetId: 'request-set-1',
    model: 'test-model',
    workspacePath: '/workspace',
    isInteractive: false,
    ...overrides,
  };
}

function createBusinessCtx(
  overrides?: Partial<QueryBusinessContext>,
): QueryBusinessContext {
  return {
    sessionId: 'session-1',
    requestSetId: 'request-set-1',
    businessId: 'business-1',
    ...overrides,
  };
}

function createTerminal(overrides?: Partial<Terminal>): Terminal {
  return {
    reason: 'end_turn',
    numTurns: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as Terminal['usage'],
    durationMs: 1000,
    ...overrides,
  };
}

describe('QueryLifecycleRunner', () => {
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
  });

  describe('notifyQueryEnd', () => {
    it('calls onQueryEnd on all observers', async () => {
      const obs1: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
      const obs2: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
      const runner = new QueryLifecycleRunner([obs1, obs2], { logger });
      const terminal = createTerminal();
      const ctx = createCtx();

      await runner.notifyQueryEnd(terminal, ctx);

      expect(obs1.onQueryEnd).toHaveBeenCalledWith(terminal, ctx);
      expect(obs2.onQueryEnd).toHaveBeenCalledWith(terminal, ctx);
    });

    it('calls observers for all terminal reasons', async () => {
      for (const reason of [
        'end_turn',
        'max_turns',
        'abort',
        'error',
      ] as const) {
        const obs: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
        const runner = new QueryLifecycleRunner([obs], { logger });
        const terminal = createTerminal({ reason });

        await runner.notifyQueryEnd(terminal, createCtx());

        expect(obs.onQueryEnd).toHaveBeenCalledWith(
          expect.objectContaining({ reason }),
          expect.anything(),
        );
      }
    });

    it('gracefully handles observer with undefined onQueryEnd', async () => {
      const obs: QueryLifecycleObserver = {}; // no methods defined
      const runner = new QueryLifecycleRunner([obs], { logger });

      await expect(
        runner.notifyQueryEnd(createTerminal(), createCtx()),
      ).resolves.not.toThrow();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('notifyQueryStart', () => {
    it('calls onQueryStart on all observers', async () => {
      const obs1: QueryLifecycleObserver = { onQueryStart: vi.fn() };
      const obs2: QueryLifecycleObserver = { onQueryStart: vi.fn() };
      const runner = new QueryLifecycleRunner([obs1, obs2], { logger });
      const ctx = createCtx();

      await runner.notifyQueryStart(ctx);

      expect(obs1.onQueryStart).toHaveBeenCalledWith(ctx);
      expect(obs2.onQueryStart).toHaveBeenCalledWith(ctx);
    });
  });

  describe('notifyBusinessContextReady', () => {
    it('dispatches synchronously without adding an await boundary', () => {
      const obs1: QueryLifecycleObserver = {
        onBusinessContextReady: vi.fn(),
      };
      const obs2: QueryLifecycleObserver = {
        onBusinessContextReady: vi.fn(),
      };
      const runner = new QueryLifecycleRunner([obs1, obs2], { logger });
      const ctx = createBusinessCtx();

      expect(runner.notifyBusinessContextReady(ctx)).toBeUndefined();
      expect(obs1.onBusinessContextReady).toHaveBeenCalledWith(ctx);
      expect(obs2.onBusinessContextReady).toHaveBeenCalledWith(ctx);
    });

    it('isolates failures and continues dispatching', () => {
      const success = vi.fn();
      const runner = new QueryLifecycleRunner(
        [
          {
            onBusinessContextReady: () => {
              throw new Error('sync failure');
            },
          },
          { onBusinessContextReady: success },
        ],
        { logger },
      );

      expect(() =>
        runner.notifyBusinessContextReady(createBusinessCtx()),
      ).not.toThrow();
      expect(success).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('onBusinessContextReady failed'),
        expect.any(Error),
      );
    });
  });

  describe('notifyQueryError', () => {
    it('calls onQueryError on all observers', async () => {
      const obs: QueryLifecycleObserver = { onQueryError: vi.fn() };
      const runner = new QueryLifecycleRunner([obs], { logger });
      const error = new Error('test error');
      const ctx = createCtx();

      await runner.notifyQueryError(error, ctx);

      expect(obs.onQueryError).toHaveBeenCalledWith(error, ctx);
    });
  });

  describe('error isolation', () => {
    it('does not propagate synchronous observer errors', async () => {
      const failingObs: QueryLifecycleObserver = {
        onQueryEnd: () => {
          throw new Error('sync failure');
        },
      };
      const successObs: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
      const runner = new QueryLifecycleRunner([failingObs, successObs], {
        logger,
      });

      await expect(
        runner.notifyQueryEnd(createTerminal(), createCtx()),
      ).resolves.not.toThrow();
      expect(successObs.onQueryEnd).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.any(Error),
      );
    });

    it('does not propagate asynchronous observer errors', async () => {
      const failingObs: QueryLifecycleObserver = {
        onQueryEnd: async () => {
          throw new Error('async failure');
        },
      };
      const successObs: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
      const runner = new QueryLifecycleRunner([failingObs, successObs], {
        logger,
      });

      await expect(
        runner.notifyQueryEnd(createTerminal(), createCtx()),
      ).resolves.not.toThrow();
      expect(successObs.onQueryEnd).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.any(Error),
      );
    });

    it('continues calling remaining observers after one fails', async () => {
      const calls: string[] = [];
      const obs1: QueryLifecycleObserver = {
        onQueryEnd: () => {
          calls.push('obs1');
          throw new Error('obs1 failed');
        },
      };
      const obs2: QueryLifecycleObserver = {
        onQueryEnd: () => {
          calls.push('obs2');
        },
      };
      const obs3: QueryLifecycleObserver = {
        onQueryEnd: () => {
          calls.push('obs3');
        },
      };
      const runner = new QueryLifecycleRunner([obs1, obs2, obs3], { logger });

      await runner.notifyQueryEnd(createTerminal(), createCtx());

      expect(calls).toEqual(['obs1', 'obs2', 'obs3']);
    });
  });

  describe('timeout', () => {
    it('rejects observer that exceeds timeout', async () => {
      const slowObs: QueryLifecycleObserver = {
        onQueryEnd: () => new Promise((resolve) => setTimeout(resolve, 5000)),
      };
      const fastObs: QueryLifecycleObserver = { onQueryEnd: vi.fn() };
      const runner = new QueryLifecycleRunner([slowObs, fastObs], {
        timeoutMs: 50,
        logger,
      });

      await runner.notifyQueryEnd(createTerminal(), createCtx());

      expect(fastObs.onQueryEnd).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
        expect.objectContaining({
          message: expect.stringContaining('timed out'),
        }),
      );
    });

    it('does not timeout when timeoutMs is undefined', async () => {
      const obs: QueryLifecycleObserver = {
        onQueryEnd: vi.fn().mockResolvedValue(undefined),
      };
      const runner = new QueryLifecycleRunner([obs]); // no options

      await runner.notifyQueryEnd(createTerminal(), createCtx());

      expect(obs.onQueryEnd).toHaveBeenCalled();
    });
  });

  describe('no observers', () => {
    it('handles empty observer list gracefully', async () => {
      const runner = new QueryLifecycleRunner([], { logger });

      await expect(
        runner.notifyQueryEnd(createTerminal(), createCtx()),
      ).resolves.not.toThrow();
      await expect(runner.notifyQueryStart(createCtx())).resolves.not.toThrow();
      await expect(
        runner.notifyQueryError(new Error(), createCtx()),
      ).resolves.not.toThrow();
    });
  });
});
