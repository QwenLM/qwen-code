/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `/arena select` winner picker's zero-row guards. The native renderer is
 * faked the same way as dialogs-hooks.test.tsx: box/text render as div/span
 * and every useKeyboard consumer receives each key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
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
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useKeyboard: (handler: (key: unknown) => void) => {
      const ref = React.useRef(handler);
      ref.current = handler;
      React.useEffect(() => {
        const fn = (key: unknown) => ref.current(key);
        mocks.state.keyboardHandlers.push(fn);
        return () => {
          const index = mocks.state.keyboardHandlers.indexOf(fn);
          if (index >= 0) mocks.state.keyboardHandlers.splice(index, 1);
        };
      }, []);
    },
    useRenderer: () => ({
      addInputHandler: () => {},
      removeInputHandler: () => {},
    }),
    useTerminalDimensions: () => ({ width: 100, height: 40 }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import { AgentStatus, type Config } from '@qwen-code/qwen-code-core';
import { OpenTuiArenaDialog } from './dialogs-arena.js';

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

async function press(name: string): Promise<void> {
  await act(async () => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler(baseKeyEvent({ name, sequence: name }));
    }
  });
}

const manager = {
  getAgentStates: () => [
    {
      agentId: 'a1',
      model: { modelId: 'model-a' },
      status: AgentStatus.COMPLETED,
      stats: { durationMs: 1000, outputTokens: 42 },
    },
  ],
  getResult: () => ({
    task: 'task',
    agents: [
      {
        agentId: 'a1',
        model: { modelId: 'model-a' },
        approachSummary: 'did the thing',
        stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
        diffSummary: { additions: 1, deletions: 0, files: [] },
      },
    ],
  }),
};

const config = {
  getArenaManager: () => manager,
} as unknown as Config;

describe('OpenTuiArenaDialog select panes at a zero-row window', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
  });

  it('refuses to open a pane at a zero-row window but never refuses to close one', async () => {
    // Region 24 leaves the agent list six rows, so the preview opens; at
    // region 12 the window has zero rows, and the pane eating the list's rows
    // must still close — a guard that refuses both directions strands it open.
    const { rerender } = render(
      <OpenTuiArenaDialog
        mode="select"
        config={config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );

    await press('p');
    expect(screen.getByText(/Quick Preview/)).toBeTruthy();

    rerender(
      <OpenTuiArenaDialog
        mode="select"
        config={config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={12}
      />,
    );
    await press('p');
    expect(screen.queryByText(/Quick Preview/)).toBeNull();

    // Still closed: opening is the direction the zero-row window refuses.
    await press('p');
    expect(screen.queryByText(/Quick Preview/)).toBeNull();
  });
});
