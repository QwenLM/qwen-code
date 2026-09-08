// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook-level tests for useFollowupSuggestionGeneration (U-7): the
 * streaming→idle edge trigger, ink's gate set, clear-on-turn-boundary, and
 * the suppressed-analytics / abort paths.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  log: vi.fn(),
  getHistoryTail: vi.fn((): unknown[] => []),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    generatePromptSuggestion: mocks.generate,
    logPromptSuggestion: mocks.log,
  };
});

import type { LoadedSettings } from '../../config/settings.js';
import type { LiveHistoryItem } from './live-session-model.js';
import {
  useFollowupSuggestionGeneration,
  type FollowupGenerationParams,
} from './followup-generation.js';
import type { WaitingCallInfo } from './live-session.js';

function buildConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    isInteractive: () => true,
    getSdkMode: () => false,
    getApprovalMode: () => ApprovalMode.DEFAULT,
    getLlmClient: () => ({ getHistoryTail: mocks.getHistoryTail }),
    ...overrides,
  } as unknown as Config;
}

const SETTINGS = { merged: {} } as unknown as LoadedSettings;
const DISABLED = {
  merged: { ui: { enableFollowupSuggestions: false } },
} as unknown as LoadedSettings;
const NO_CACHE_SHARING = {
  merged: { ui: { enableCacheSharing: false } },
} as unknown as LoadedSettings;

const ERROR_ITEMS = [
  { kind: 'error', id: '1', text: 'boom' },
] as unknown as readonly LiveHistoryItem[];

const PARKED_CALL = {
  callId: 'c1',
  name: 'test_tool',
  confirmationDetails: {},
} as unknown as WaitingCallInfo;

function props(overrides: Partial<FollowupGenerationParams> = {}) {
  return {
    config: buildConfig(),
    settings: SETTINGS,
    streaming: true,
    items: [],
    waitingCalls: [],
    ...overrides,
  } as FollowupGenerationParams;
}

function renderGeneration(initial: FollowupGenerationParams) {
  return renderHook(
    (next: FollowupGenerationParams) => useFollowupSuggestionGeneration(next),
    { initialProps: initial },
  );
}

describe('useFollowupSuggestionGeneration', () => {
  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.log.mockReset();
    mocks.getHistoryTail.mockClear();
  });

  it('generates on the streaming→idle edge and publishes the suggestion', async () => {
    mocks.generate.mockResolvedValue({ suggestion: 'Run the tests' });
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));

    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][3]).toEqual({
      enableCacheSharing: true,
    });
    expect(mocks.getHistoryTail).toHaveBeenCalledWith(40, true);
    expect(result.current.promptSuggestion).toBe('Run the tests');
  });

  it('passes an explicit enableCacheSharing=false through', async () => {
    mocks.generate.mockResolvedValue({ suggestion: null });
    const config = buildConfig();
    const { rerender } = renderGeneration(
      props({ config, settings: NO_CACHE_SHARING }),
    );
    await act(async () => {
      rerender(props({ config, settings: NO_CACHE_SHARING, streaming: false }));
    });
    expect(mocks.generate.mock.calls[0][3]).toEqual({
      enableCacheSharing: false,
    });
  });

  it('does not generate on mount without an edge', async () => {
    renderGeneration(props({ streaming: false }));
    await act(async () => {});
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['an error as the last item', { items: ERROR_ITEMS }],
    ['parked confirmations', { waitingCalls: [PARKED_CALL] }],
    [
      'plan mode',
      { config: buildConfig({ getApprovalMode: () => ApprovalMode.PLAN }) },
    ],
    [
      'non-interactive mode',
      { config: buildConfig({ isInteractive: () => false }) },
    ],
    ['sdk mode', { config: buildConfig({ getSdkMode: () => 'sdk' }) }],
  ] as ReadonlyArray<[string, Partial<FollowupGenerationParams>]>)(
    'skips generation with %s',
    async (_label, overrides) => {
      const { rerender } = renderGeneration(props(overrides));
      await act(async () => {
        rerender(props({ ...overrides, streaming: false }));
      });
      expect(mocks.generate).not.toHaveBeenCalled();
    },
  );

  it('disabled by settings never generates and clears on edges', async () => {
    const config = buildConfig();
    const { result, rerender } = renderGeneration(
      props({ config, settings: DISABLED }),
    );
    await act(async () => {
      rerender(props({ config, settings: DISABLED, streaming: false }));
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(result.current.promptSuggestion).toBeNull();
  });

  it('clears the suggestion when the setting is flipped off in place (R1-15)', async () => {
    mocks.generate.mockResolvedValue({ suggestion: 'Run the tests' });
    const config = buildConfig();
    // LoadedSettings.setValue mutates `merged` in place — the same object
    // identity, so the effect must be keyed on the flattened value, not the
    // settings object. Keep every other dep identity-stable across the
    // rerender or the test passes for the wrong reason.
    const settings = { merged: {} } as unknown as LoadedSettings;
    const items: readonly LiveHistoryItem[] = [];
    const waitingCalls: readonly WaitingCallInfo[] = [];
    const { result, rerender } = renderGeneration(
      props({ config, settings, items, waitingCalls }),
    );
    await act(async () => {
      rerender(
        props({ config, settings, streaming: false, items, waitingCalls }),
      );
    });
    expect(result.current.promptSuggestion).toBe('Run the tests');

    (settings as { merged: { ui?: object } }).merged.ui = {
      enableFollowupSuggestions: false,
    };
    await act(async () => {
      rerender(
        props({ config, settings, streaming: false, items, waitingCalls }),
      );
    });
    expect(result.current.promptSuggestion).toBeNull();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('clears the suggestion when a new turn starts', async () => {
    mocks.generate.mockResolvedValue({ suggestion: 'Run the tests' });
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));

    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    expect(result.current.promptSuggestion).toBe('Run the tests');

    await act(async () => {
      rerender(props({ config, streaming: true }));
    });
    expect(result.current.promptSuggestion).toBeNull();
  });

  it('logs suppressed analytics with the filter reason', async () => {
    mocks.generate.mockResolvedValue({
      suggestion: null,
      filterReason: 'early_conversation',
    });
    const config = buildConfig();
    const { rerender } = renderGeneration(props({ config }));
    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    await act(async () => {});
    expect(mocks.log).toHaveBeenCalledTimes(1);
    const event = mocks.log.mock.calls[0][1];
    expect(event.outcome).toBe('suppressed');
    expect(event.reason).toBe('early_conversation');
  });

  it('aborts in-flight generation on unmount', async () => {
    let captured: AbortSignal | undefined;
    mocks.generate.mockImplementation(
      (_config: unknown, _history: unknown, signal: AbortSignal) => {
        captured = signal;
        return new Promise(() => {});
      },
    );
    const config = buildConfig();
    const view = renderGeneration(props({ config }));
    await act(async () => {
      view.rerender(props({ config, streaming: false }));
    });
    view.unmount();
    expect(captured?.aborted).toBe(true);
  });

  // R2-2: typing over the ghost must abort (ink AppContainer parity), not
  // clear — abort leaves the suggestion restorable after type-then-delete.
  it('abortPromptSuggestion leaves the published suggestion set', async () => {
    mocks.generate.mockResolvedValue({ suggestion: 'Run the tests' });
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));
    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    expect(result.current.promptSuggestion).toBe('Run the tests');
    act(() => result.current.abortPromptSuggestion());
    expect(result.current.promptSuggestion).toBe('Run the tests');
  });

  it('abortPromptSuggestion aborts the in-flight generation', async () => {
    let captured: AbortSignal | undefined;
    mocks.generate.mockImplementation(
      (_config: unknown, _history: unknown, signal: AbortSignal) => {
        captured = signal;
        return new Promise(() => {});
      },
    );
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));
    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    act(() => result.current.abortPromptSuggestion());
    expect(captured?.aborted).toBe(true);
  });

  it('dismissPromptSuggestion clears the published suggestion', async () => {
    mocks.generate.mockResolvedValue({ suggestion: 'Run the tests' });
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));
    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    expect(result.current.promptSuggestion).toBe('Run the tests');
    act(() => result.current.dismissPromptSuggestion());
    expect(result.current.promptSuggestion).toBeNull();
  });

  it('dismissPromptSuggestion aborts the in-flight generation', async () => {
    let captured: AbortSignal | undefined;
    mocks.generate.mockImplementation(
      (_config: unknown, _history: unknown, signal: AbortSignal) => {
        captured = signal;
        return new Promise(() => {});
      },
    );
    const config = buildConfig();
    const { result, rerender } = renderGeneration(props({ config }));
    await act(async () => {
      rerender(props({ config, streaming: false }));
    });
    act(() => result.current.dismissPromptSuggestion());
    expect(captured?.aborted).toBe(true);
  });
});
