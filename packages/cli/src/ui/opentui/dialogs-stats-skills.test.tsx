/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component tests for the OpenTUI Stats and Skills dialogs (#10728
 * test-hardening slice). The Stats dialog is driven by the real
 * computeSessionStats/formatters over uiTelemetryService metrics, so the
 * service singleton is swapped for a stub with a fixed clock; the assertions
 * pin the session tab's computed numbers, tab cycling, and the Esc paths
 * (raw + parsed) including the embedded isFocused=false mode. The Skills
 * dialog tests pin the loading → rows/empty lifecycle from the skill
 * manager promise.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';

const mocks = vi.hoisted(() => {
  const state = {
    inputHandlers: [] as Array<(sequence: string) => boolean>,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    metrics: null as Record<string, unknown> | null,
    startTime: new Date('2026-01-01T00:00:00.000Z'),
  };
  const renderer = {
    addInputHandler(handler: (sequence: string) => boolean) {
      state.inputHandlers.push(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      const index = state.inputHandlers.indexOf(handler);
      if (index >= 0) state.inputHandlers.splice(index, 1);
    },
  };
  const listeners = new Set<() => void>();
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return {
    state,
    renderer,
    telemetryService: {
      on: (_event: string, handler: () => void) => listeners.add(handler),
      off: (_event: string, handler: () => void) => listeners.delete(handler),
      getMetrics: () => state.metrics,
      getMetricsForSession: (_sessionId: string) => state.metrics,
      getSessionStartTime: () => state.startTime,
    },
    buildJsxRuntime,
  };
});

// The useKeyboard mock mirrors the real hook's lifetime: handlers are
// registered on mount and removed on unmount, so a later press() cannot
// reach an already-unmounted dialog's onClose.
vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useKeyboard: (handler: (key: unknown) => void) => {
      React.useEffect(() => {
        mocks.state.keyboardHandlers.push(handler);
        return () => {
          const index = mocks.state.keyboardHandlers.indexOf(handler);
          if (index >= 0) mocks.state.keyboardHandlers.splice(index, 1);
        };
      }, [handler]);
    },
    useRenderer: () => mocks.renderer,
  };
});
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string; shift?: boolean }) => ({
    name: key.name ?? '',
    shift: key.shift,
  }),
}));
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
// The Stats dialog re-renders on uiTelemetryService 'update' events and
// reads metrics for the (optional) session id; swap the singleton for a
// deterministic stub while keeping every other core export real.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  uiTelemetryService: mocks.telemetryService,
}));

import {
  OpenTuiSkillsDialog,
  OpenTuiStatsDialog,
} from './dialogs-stats-skills.js';

function makeMetrics() {
  return {
    models: {
      'qwen3-coder': {
        api: { totalRequests: 3, totalErrors: 0, totalLatencyMs: 1500 },
        tokens: {
          prompt: 1200,
          candidates: 800,
          total: 2000,
          cached: 600,
          thoughts: 0,
        },
        bySource: {},
      },
    },
    tools: {
      totalCalls: 5,
      totalSuccess: 4,
      totalFail: 1,
      totalDurationMs: 3000,
      totalDecisions: { accept: 4, reject: 1, modify: 0, auto_accept: 0 },
      byName: {},
    },
    files: { totalLinesAdded: 42, totalLinesRemoved: 7 },
  };
}

function press(name: string, shift = false) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  // The real renderer delivers a parsed key to every useKeyboard subscriber
  // (the Stats dialog registers two: the shared Esc fallback + tab cycling).
  for (const handler of [...mocks.state.keyboardHandlers]) {
    act(() => handler({ name, shift }));
  }
}

async function pressEsc(): Promise<boolean> {
  const handler = mocks.state.inputHandlers.at(-1);
  if (!handler) throw new Error('no raw input handler registered');
  let consumed = false;
  await act(async () => {
    consumed = handler('\x1b');
  });
  return consumed;
}

describe('OpenTuiStatsDialog', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.metrics = makeMetrics();
  });

  it('renders the session tab numbers from telemetry + computeSessionStats', () => {
    const config = { getSessionId: () => 'sess-1' } as unknown as Config;
    render(<OpenTuiStatsDialog config={config} onClose={vi.fn()} />);

    // Tool calls split into success/fail, success rate computed (4/5).
    expect(screen.getByText('Tool Calls:')).toBeTruthy();
    expect(screen.getByText('5 (')).toBeTruthy();
    expect(screen.getByText('✓ 4')).toBeTruthy();
    expect(screen.getByText('✗ 1')).toBeTruthy();
    expect(screen.getByText('80.0%')).toBeTruthy();
    // Code changes keep their +/- split instead of a total.
    expect(screen.getByText('+42')).toBeTruthy();
    expect(screen.getByText('-7')).toBeTruthy();
    // Model row with per-model request count and token totals.
    expect(screen.getByText('qwen3-coder')).toBeTruthy();
    expect(screen.getByText('3 reqs · in=1.2k · out=800')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('800')).toBeTruthy();
    expect(screen.getByText('600 (50.0%)')).toBeTruthy();
  });

  it('falls back to aggregate metrics without a session id', () => {
    mocks.state.metrics = makeMetrics();
    render(<OpenTuiStatsDialog config={undefined} onClose={vi.fn()} />);
    expect(screen.getByText('n/a')).toBeTruthy();
    expect(screen.getByText('✓ 4')).toBeTruthy();
  });

  it('cycles session → activity → efficiency and back on Tab/Shift+Tab', () => {
    render(<OpenTuiStatsDialog config={undefined} onClose={vi.fn()} />);
    press('tab');
    expect(screen.getByText('Activity (this session)')).toBeTruthy();
    expect(screen.getByText('Requests:')).toBeTruthy();
    press('tab');
    expect(screen.getByText('Efficiency (this session)')).toBeTruthy();
    // Shift+Tab cycles backwards: efficiency → activity → session.
    press('tab', true);
    expect(screen.getByText('Activity (this session)')).toBeTruthy();
    press('tab', true);
    expect(screen.getByText('Session ID:')).toBeTruthy();
  });

  it('closes on raw Esc and on the parsed-key fallback', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <OpenTuiStatsDialog config={undefined} onClose={onClose} />,
    );
    expect(await pressEsc()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onCloseParsed = vi.fn();
    render(<OpenTuiStatsDialog config={undefined} onClose={onCloseParsed} />);
    press('escape');
    expect(onCloseParsed).toHaveBeenCalledTimes(1);
  });

  it('unregisters its key handlers on unmount, so later keys miss it', () => {
    const firstOnClose = vi.fn();
    const { unmount } = render(
      <OpenTuiStatsDialog config={undefined} onClose={firstOnClose} />,
    );
    // The Stats dialog registers two parsed-key handlers (the shared Esc
    // fallback + tab cycling) plus one raw input handler.
    expect(mocks.state.keyboardHandlers.length).toBeGreaterThan(0);
    expect(mocks.state.inputHandlers.length).toBeGreaterThan(0);
    unmount();
    expect(mocks.state.keyboardHandlers).toHaveLength(0);
    expect(mocks.state.inputHandlers).toHaveLength(0);

    // After a second dialog mounts, a key press must only reach that one.
    const secondOnClose = vi.fn();
    render(<OpenTuiStatsDialog config={undefined} onClose={secondOnClose} />);
    press('escape');
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Tab and Esc while embedded (isFocused=false)', async () => {
    const onClose = vi.fn();
    render(
      <OpenTuiStatsDialog
        config={undefined}
        onClose={onClose}
        isFocused={false}
      />,
    );
    press('tab');
    expect(screen.getByText('Session ID:')).toBeTruthy();
    const handler = mocks.state.inputHandlers.at(-1);
    expect(handler).toBeUndefined();
    press('escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('OpenTuiSkillsDialog', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
  });

  it('shows the loading state, then the manager rows once resolved', async () => {
    const config = {
      getSkillManager: () => ({
        listSkills: () =>
          Promise.resolve([
            { name: 'pdf', description: 'Work with PDF documents' },
            { name: 'docx' },
          ]),
      }),
    } as unknown as Config;
    render(<OpenTuiSkillsDialog config={config} onClose={vi.fn()} />);

    expect(screen.getByText('loading skills…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('pdf')).toBeTruthy());
    expect(screen.getByText('Work with PDF documents')).toBeTruthy();
    expect(screen.getByText('docx')).toBeTruthy();
    expect(screen.queryByText('loading skills…')).toBeNull();
  });

  it('reports no skills when the manager is missing or fails', async () => {
    const { unmount } = render(
      <OpenTuiSkillsDialog config={undefined} onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByText('no skills available')).toBeTruthy(),
    );
    unmount();

    const failing = {
      getSkillManager: () => ({
        listSkills: () => Promise.reject(new Error('io')),
      }),
    } as unknown as Config;
    render(<OpenTuiSkillsDialog config={failing} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('no skills available')).toBeTruthy(),
    );
  });

  it('closes on raw Esc', async () => {
    const onClose = vi.fn();
    render(<OpenTuiSkillsDialog config={undefined} onClose={onClose} />);
    expect(await pressEsc()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the parsed-key Esc fallback', () => {
    const onClose = vi.fn();
    render(<OpenTuiSkillsDialog config={undefined} onClose={onClose} />);
    press('escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
