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

// Four settled agents with a forty-line diff on the first, so the select
// list exactly fills a twenty-row region (12 chrome + 4 agents × 2 rows) and
// the panes have nowhere uncharged to grow into.
const fourAgentManager = {
  getAgentStates: () =>
    [0, 1, 2, 3].map((i) => ({
      agentId: `a${i}`,
      model: { modelId: `model-a${i}` },
      status: AgentStatus.COMPLETED,
      stats: { durationMs: 1000, outputTokens: 42 },
    })),
  getResult: () => ({
    task: 'task',
    agents: [0, 1, 2, 3].map((i) => ({
      agentId: `a${i}`,
      model: { modelId: `model-a${i}` },
      approachSummary: 'did the thing',
      stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
      diffSummary: { additions: 40, deletions: 0, files: [] },
      diff: Array.from({ length: 40 }, (_, l) => `+line ${l}`).join('\n'),
    })),
  }),
};

const fourConfig = {
  getArenaManager: () => fourAgentManager,
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

  it('walks the detailed-diff pane the same way: open, shrink, close, refuse', async () => {
    // The d guard is a copy of the p guard with a different state variable;
    // reading !showPreview there instead keeps every p-shaped assertion green
    // while the pane strands open, so the walk is repeated for d.
    const { rerender } = render(
      <OpenTuiArenaDialog
        mode="select"
        config={config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );

    await press('d');
    expect(screen.getByText(/Detailed Diff/)).toBeTruthy();

    rerender(
      <OpenTuiArenaDialog
        mode="select"
        config={config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={12}
      />,
    );
    await press('d');
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();

    await press('d');
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
  });

  it('decides the pane direction from the burst-live flag, not the render closure', async () => {
    // Two p presses delivered in one stdin read run against the same render
    // closure: the first closes the open pane, and the second must see that
    // close — reading the closure's stale `true` toggles twice and strands
    // the pane open at a zero-row window, the state the guard exists to
    // prevent.
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

    await act(async () => {
      for (const handler of [...mocks.state.keyboardHandlers]) {
        handler(baseKeyEvent({ name: 'p', sequence: 'p' }));
        handler(baseKeyEvent({ name: 'p', sequence: 'p' }));
      }
    });
    expect(screen.queryByText(/Quick Preview/)).toBeNull();

    // One more press stays refused: the pane never reopens at a zero-row
    // window.
    await press('p');
    expect(screen.queryByText(/Quick Preview/)).toBeNull();
  });
});

describe('OpenTuiArenaDialog select pane charging', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
  });

  it('charges the preview pane to the agent window', async () => {
    // Four agents exactly fill the twenty-row region (12 chrome + 4 × 2).
    // The preview pays five rows (margin, title, three runs), so the window
    // drops to floor((20 - 12 - 5) / 2) = 1 agent.
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={fourConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={20}
      />,
    );
    expect(screen.getByText('model-a0')).toBeTruthy();
    expect(screen.getByText('model-a3')).toBeTruthy();

    await press('p');
    expect(screen.getByText(/Quick Preview · model-a0/)).toBeTruthy();
    expect(screen.getByText('model-a0')).toBeTruthy();
    expect(screen.queryByText('model-a1')).toBeNull();
    expect(screen.queryByText('model-a3')).toBeNull();
  });

  it('caps the detailed diff at the rows the region leaves and pays its chrome', async () => {
    // The diff pane pays its margin and title (2) plus as many lines as fit:
    // the list yields its zero-row floor, so six of forty lines paint with a
    // truncation marker, and no agent row does.
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={fourConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={20}
      />,
    );

    await press('d');
    expect(screen.getByText(/Detailed Diff · model-a0/)).toBeTruthy();
    expect(screen.getByText('+line 4')).toBeTruthy();
    expect(screen.queryByText('+line 5')).toBeNull();
    expect(screen.getByText(/more rows than the region leaves/)).toBeTruthy();
    expect(screen.queryByText('model-a0')).toBeNull();
  });

  it('clips a config-supplied model label to the one row the start window charges', () => {
    // The start rows are charged one physical row each, but the renderer
    // word-wraps: an unclipped label paints a second row the window never
    // paid for. The label column is the frame's content (96 - 2 border - 4
    // padding) minus the checkbox's four, so a 120-column label keeps 85.
    const longLabelConfig = {
      getArenaManager: () => ({
        getAgents: () => [],
      }),
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'openai',
      }),
      getAllConfiguredModels: () => [
        { authType: 'openai', id: 'm1', label: 'L'.repeat(120) },
      ],
    } as unknown as Config;
    render(
      <OpenTuiArenaDialog
        mode="start"
        config={longLabelConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );
    expect(screen.queryByText(/L{120}/)).toBeNull();
    expect(screen.getByText(/\[openai\] L{76}…/)).toBeTruthy();
  });

  it('windows the start list, so Space only toggles a painted row', async () => {
    // Six models at a twelve-row region: the window pays four rows, and the
    // window follows the cursor down.
    const sixModelConfig = {
      getArenaManager: () => ({
        getAgents: () => [],
      }),
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'openai',
      }),
      getAllConfiguredModels: () =>
        [0, 1, 2, 3, 4, 5].map((i) => ({
          authType: 'openai',
          id: `m${i}`,
          label: `model-${i}`,
        })),
    } as unknown as Config;
    render(
      <OpenTuiArenaDialog
        mode="start"
        config={sixModelConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={12}
      />,
    );
    expect(screen.queryByText(/model-5/)).toBeNull();
    for (let i = 0; i < 5; i++) await press('down');
    expect(screen.getByText(/\[openai\] model-5/)).toBeTruthy();
  });
});
