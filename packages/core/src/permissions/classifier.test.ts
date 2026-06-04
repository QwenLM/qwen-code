/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runSideQueryMock = vi.fn();

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: (...args: unknown[]) => runSideQueryMock(...args),
}));

import {
  classifyAction,
  sanitizeClassifierReason,
  type ClassifierInput,
} from './classifier.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

function makeConfig(
  autoModeSettings: ReturnType<Config['getAutoModeSettings']> = {},
): Config {
  return {
    getFastModel: () => 'qwen-turbo-test',
    getModel: () => 'qwen-max-test',
    getAutoModeSettings: () => autoModeSettings,
    getToolRegistry: () =>
      ({ getTool: () => undefined }) as unknown as ToolRegistry,
  } as unknown as Config;
}

function makeInput(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    toolName: 'run_shell_command',
    toolParams: { command: 'ls' },
    messages: [],
    config: makeConfig(),
    signal: new AbortController().signal,
    ...over,
  };
}

beforeEach(() => {
  runSideQueryMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyAction — stage 1 happy path', () => {
  it('returns allow without calling stage 2 when stage 1 says shouldBlock=false', async () => {
    runSideQueryMock.mockResolvedValueOnce({ shouldBlock: false });

    const result = await classifyAction(makeInput());

    expect(result.shouldBlock).toBe(false);
    expect(result.reason).toBe('');
    expect(result.unavailable).toBeUndefined();
    expect(result.stage).toBe('fast');
    expect(runSideQueryMock).toHaveBeenCalledTimes(1);
  });

  it('passes the fast-stage purpose to sideQuery', async () => {
    runSideQueryMock.mockResolvedValueOnce({ shouldBlock: false });
    await classifyAction(makeInput());
    const call = runSideQueryMock.mock.calls[0]?.[1] as { purpose?: string };
    expect(call?.purpose).toBe('permission_classifier_stage1');
  });
});

describe('classifyAction — stage 1 escalates to stage 2', () => {
  it('returns stage 2 verdict (block + reason) when stage 2 confirms block', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({
        thinking: 'rm -rf / destroys the root filesystem',
        shouldBlock: true,
        reason: 'Irreversible filesystem destruction',
      });

    const result = await classifyAction(makeInput());

    expect(result.shouldBlock).toBe(true);
    expect(result.reason).toBe('Irreversible filesystem destruction');
    expect(result.thinking).toContain('rm -rf');
    expect(result.unavailable).toBeUndefined();
    expect(result.stage).toBe('thinking');
    expect(runSideQueryMock).toHaveBeenCalledTimes(2);
  });

  it('downgrades stage 1 block to allow when stage 2 says shouldBlock=false', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({
        thinking: 'cleanup of node_modules is consistent with user intent',
        shouldBlock: false,
        reason: 'safe cleanup',
      });

    const result = await classifyAction(makeInput());

    expect(result.shouldBlock).toBe(false);
    // Allow path discards the reason field.
    expect(result.reason).toBe('');
    expect(result.stage).toBe('thinking');
  });

  it('passes the thinking-stage purpose for the second call', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({ thinking: 't', shouldBlock: false, reason: '' });
    await classifyAction(makeInput());
    const call = runSideQueryMock.mock.calls[1]?.[1] as { purpose?: string };
    expect(call?.purpose).toBe('permission_classifier_stage2');
  });
});

describe('classifyAction — fail-closed on stage 1 failure', () => {
  it('returns unavailable=true when stage 1 throws an API error', async () => {
    runSideQueryMock.mockRejectedValueOnce(new Error('API 500'));
    const result = await classifyAction(makeInput());
    expect(result.shouldBlock).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.stage).toBe('fast');
    expect(result.reason).toMatch(/blocked for safety/);
  });

  it('surfaces a context-overflow reason when stage 1 fails with that error', async () => {
    runSideQueryMock.mockRejectedValueOnce(
      new Error('Prompt is too long: 200000 tokens > 128000 maximum'),
    );
    const result = await classifyAction(makeInput());
    expect(result.shouldBlock).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/context window/i);
  });

  it('re-throws when the user signal is aborted (not converted to block)', async () => {
    const controller = new AbortController();
    runSideQueryMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(
      classifyAction(makeInput({ signal: controller.signal })),
    ).rejects.toThrow();
  });
});

describe('classifyAction — fail-closed on stage 2 failure', () => {
  it('honors stage 1 block when stage 2 fails (unavailable=true)', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockRejectedValueOnce(new Error('API 500'));

    const result = await classifyAction(makeInput());

    expect(result.shouldBlock).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.stage).toBe('thinking');
    expect(result.reason).toMatch(/Stage 1 flagged/i);
  });

  it('re-throws when the user signal aborts during stage 2', async () => {
    const controller = new AbortController();
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('aborted');
      });
    await expect(
      classifyAction(makeInput({ signal: controller.signal })),
    ).rejects.toThrow();
  });
});

describe('classifier configuration', () => {
  it('uses configured stage timeouts when provided', async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({ thinking: 't', shouldBlock: false, reason: '' });

    await classifyAction(
      makeInput({
        config: makeConfig({
          classifier: {
            timeouts: {
              stage1Ms: 12_345,
              stage2Ms: 67_890,
            },
          },
        }),
      }),
    );

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 12_345);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 67_890);
  });

  it('uses temperature 0 and max_output_tokens=32 with thinking disabled for stage 1', async () => {
    runSideQueryMock.mockResolvedValueOnce({ shouldBlock: false });
    await classifyAction(makeInput());
    const opts = runSideQueryMock.mock.calls[0]?.[1] as {
      config?: {
        temperature?: number;
        maxOutputTokens?: number;
        thinkingConfig?: { includeThoughts?: boolean };
      };
    };
    expect(opts.config?.temperature).toBe(0);
    expect(opts.config?.maxOutputTokens).toBe(32);
    expect(opts.config?.thinkingConfig?.includeThoughts).toBe(false);
  });

  it('uses max_output_tokens=4096 with thinking disabled for stage 2', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({ thinking: 't', shouldBlock: false, reason: '' });
    await classifyAction(makeInput());
    const opts = runSideQueryMock.mock.calls[1]?.[1] as {
      config?: {
        maxOutputTokens?: number;
        thinkingConfig?: { includeThoughts?: boolean };
      };
    };
    expect(opts.config?.maxOutputTokens).toBe(4096);
    // Thinking is disabled in every stage (latency-sensitive permission gate).
    expect(opts.config?.thinkingConfig?.includeThoughts).toBe(false);
  });

  it('enables API thinking only for stage 2 when configured', async () => {
    runSideQueryMock
      .mockResolvedValueOnce({ shouldBlock: true })
      .mockResolvedValueOnce({ thinking: 't', shouldBlock: false, reason: '' });

    await classifyAction(
      makeInput({
        config: makeConfig({
          classifier: {
            thinking: {
              stage2Enabled: true,
            },
          },
        }),
      }),
    );

    const stage1 = runSideQueryMock.mock.calls[0]?.[1] as {
      config?: { thinkingConfig?: { includeThoughts?: boolean } };
    };
    const stage2 = runSideQueryMock.mock.calls[1]?.[1] as {
      config?: { thinkingConfig?: { includeThoughts?: boolean } };
    };

    expect(stage1.config?.thinkingConfig?.includeThoughts).toBe(false);
    expect(stage2.config?.thinkingConfig?.includeThoughts).toBe(true);
  });

  it('does not pin a model — defaults to the fast model via sideQuery', async () => {
    runSideQueryMock.mockResolvedValueOnce({ shouldBlock: false });
    await classifyAction(makeInput());
    const opts = runSideQueryMock.mock.calls[0]?.[1] as { model?: string };
    expect(opts.model).toBeUndefined();
  });
});

// Context-overflow detection now delegated to the shared
// `isContextLengthExceededError` utility; tests covering its behavior live
// alongside that module (utils/contextLengthError.test.ts).

describe('sanitizeClassifierReason', () => {
  // Security-critical: the classifier reason is LLM-generated and gets
  // interpolated into the main model's tool-error message. A hostile
  // reason can stage a prompt injection if not sanitized.

  it('passes empty / falsy through unchanged', () => {
    expect(sanitizeClassifierReason('')).toBe('');
  });

  it('strips simple pseudo-tags like <system>...</system>', () => {
    expect(sanitizeClassifierReason('safe <system>danger</system> tail')).toBe(
      'safe danger tail',
    );
  });

  it('iterates strip until stable — no complete <...> tag can survive', () => {
    // The threat is a pseudo-tag like `<system>...` confusing the
    // downstream model. A single /<[^>]*>/g pass on a nested input
    // like `<scr<script>extra>` leaves `>` orphaned tokens which is
    // fine — what must NOT survive is any complete `<...>` pair.
    const result = sanitizeClassifierReason('<scr<script>extra>payload');
    expect(result).not.toMatch(/<[^>]*>/);
  });

  it('bounds iteration so adversarial inputs cannot create unbounded work', () => {
    // 8-iteration cap means the function is O(n) regardless of how the
    // attacker structures the input. Even a degenerate string with many
    // overlapping tags terminates promptly.
    const adversarial = '<a'.repeat(2000) + '>'.repeat(2000);
    const t0 = Date.now();
    sanitizeClassifierReason(adversarial);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('collapses whitespace and newlines to single spaces', () => {
    expect(sanitizeClassifierReason('line1\nline2\n\n\nline3')).toBe(
      'line1 line2 line3',
    );
  });

  it('hard-caps length at 200 characters', () => {
    expect(sanitizeClassifierReason('a'.repeat(500)).length).toBe(200);
  });

  it('trims surrounding whitespace after collapse', () => {
    expect(sanitizeClassifierReason('   leading  trailing   ')).toBe(
      'leading trailing',
    );
  });
});
