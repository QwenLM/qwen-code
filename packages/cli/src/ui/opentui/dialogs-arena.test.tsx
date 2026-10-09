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
    width: 100,
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
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import { AgentStatus, type Config } from '@qwen-code/qwen-code-core';
import { clipToRows } from './dialogs-core.js';
import { OpenTuiArenaDialog } from './dialogs-arena.js';
import {
  sanitizeTerminalLine,
  getCachedStringWidth,
} from '../utils/textUtils.js';

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

// One settled agent whose model id pushes the detailed-diff title past the
// thirty columns a width-40 frame leaves, so the pane costs three rows
// (margin + a two-row title) instead of its two-row minimum.
const wrappedTitleManager = {
  getAgentStates: () => [
    {
      agentId: 'a1',
      model: { modelId: 'qwen3-coder-plus' },
      status: AgentStatus.COMPLETED,
      stats: { durationMs: 1000, outputTokens: 42 },
    },
  ],
  getResult: () => ({
    task: 'task',
    agents: [
      {
        agentId: 'a1',
        model: { modelId: 'qwen3-coder-plus' },
        approachSummary: 'did the thing',
        stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
        diffSummary: { additions: 40, deletions: 0, files: [] },
        diff: Array.from({ length: 40 }, (_, l) => `+line ${l}`).join('\n'),
      },
    ],
  }),
};

const wrappedTitleConfig = {
  getArenaManager: () => wrappedTitleManager,
} as unknown as Config;

const twoModelStartConfig = {
  getArenaManager: () => ({
    getAgents: () => [],
  }),
  getContentGeneratorConfig: () => ({
    model: 'test-model',
    authType: 'openai',
  }),
  getAllConfiguredModels: () => [
    { authType: 'openai', id: 'm1', label: 'model-1' },
    { authType: 'openai', id: 'm2', label: 'model-2' },
  ],
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
    mocks.state.width = 100;
  });

  it('clips the agent stats run to the one row its two-row charge pays', async () => {
    // The select row is charged two physical rows (label + stats); the stats
    // run was the one run in the row not width-bounded, so a narrow terminal
    // wrapped it and the frame grew past the region. At width 40 the frame's
    // content is 30 columns: the status and duration segments paint and the
    // diff-stat tail drops.
    mocks.state.width = 40;
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={fourConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text.includes('Done')).toBe(true);
    expect(text.includes('+40')).toBe(false);
  });

  it('clips each detailed-diff line to the one row its charge pays', async () => {
    // The pane is charged one row per painted line; an unclipped line wraps
    // and the frame grows past the region for every extra row. At width 40
    // the pane's lines own 28 columns (frame content 30, less the pane's
    // two-column margin), so a hundred-column line paints its first 28.
    mocks.state.width = 40;
    const longLineManager = {
      getAgentStates: () => [
        {
          agentId: 'a1',
          model: { modelId: 'model-a1' },
          status: AgentStatus.COMPLETED,
          stats: { durationMs: 1000, outputTokens: 42 },
        },
      ],
      getResult: () => ({
        task: 'task',
        agents: [
          {
            agentId: 'a1',
            model: { modelId: 'model-a1' },
            approachSummary: 'did the thing',
            stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
            diffSummary: { additions: 1, deletions: 0, files: [] },
            diff: `+${'x'.repeat(99)}
-second line`,
          },
        ],
      }),
    };
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={{ getArenaManager: () => longLineManager } as unknown as Config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );

    await press('d');
    const text = document.body.textContent ?? '';
    expect(text.includes(`+${'x'.repeat(27)}`)).toBe(true);
    expect(text.includes('x'.repeat(28))).toBe(false);
    expect(text.includes('second line')).toBe(true);
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

  it('clips the preview pane to the rows the region leaves', async () => {
    // The pane's rows were charged against the list window but the pane
    // itself painted unbounded: a long approachSummary grew the
    // unshrinkable frame past a sixteen-row region (12 chrome + 9 preview
    // rows into 16). The pane clips its runs to the region's leftover —
    // margin, title and two approach rows — and drops the runs that no
    // longer fit.
    const longApproachManager = {
      getAgentStates: () =>
        [0, 1].map((i) => ({
          agentId: `a${i}`,
          model: { modelId: `model-a${i}` },
          status: AgentStatus.COMPLETED,
          stats: { durationMs: 1000, outputTokens: 42 },
        })),
      getResult: () => ({
        task: 'task',
        agents: [0, 1].map((i) => ({
          agentId: `a${i}`,
          model: { modelId: `model-a${i}` },
          approachSummary: 'w'.repeat(320),
          stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
          diffSummary: { additions: 1, deletions: 0, files: [] },
        })),
      }),
    };
    const longApproachConfig = {
      getArenaManager: () => longApproachManager,
    } as unknown as Config;
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={longApproachConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={16}
      />,
    );

    await press('p');
    expect(screen.getByText(/Quick Preview · model-a0/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    // Two approach rows at the run's seventy-eight columns, not the five
    // rows the 320-column run wraps into unclipped.
    expect(text.includes('w'.repeat(156))).toBe(true);
    expect(text.includes('w'.repeat(157))).toBe(false);
    // The leftover rows are spent on the approach; the files and metrics
    // runs stay unpainted rather than growing the frame past the region.
    expect(screen.queryByText('Major files:')).toBeNull();
    expect(screen.queryByText('Metrics:')).toBeNull();
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

  it('refuses Space when the start window pays zero rows', async () => {
    // Region 8 pays the start chrome exactly, so the model window is zero
    // rows: no model paints, and Space must not check a row nothing painted
    // (Enter stays live — it only reads the checks already made, and reports
    // the too-few-models error).
    const twoModelConfig = {
      getArenaManager: () => ({ getAgents: () => [] }),
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'openai',
      }),
      getAllConfiguredModels: () => [
        { authType: 'openai', id: 'm1', label: 'model-1' },
        { authType: 'openai', id: 'm2', label: 'model-2' },
      ],
    } as unknown as Config;
    const { rerender } = render(
      <OpenTuiArenaDialog
        mode="start"
        config={twoModelConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={8}
      />,
    );

    expect(screen.queryByText(/model-1/)).toBeNull();
    await press('space');
    // The check state is invisible at a zero-row window, so the observable
    // is what a taller region paints after: a refused Space leaves the row
    // unchecked.
    rerender(
      <OpenTuiArenaDialog
        mode="start"
        config={twoModelConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text.includes('[ ] [openai] model-1')).toBe(true);
    expect(text.includes('[x]')).toBe(false);
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

  it('clears the start error on the next key, so a premature Enter cannot wedge the list', async () => {
    // Two models at a twelve-row region leave the model window one row.
    // Enter with fewer than two checks arms the error, whose two rows then
    // zero the window — and the zero-row refusal keeps Space off the only
    // rows that could satisfy the message, while nothing cleared the flag:
    // the dialog showed the error with no key able to resolve it. The next
    // key clears the error, the window comes back, and the list reaches the
    // two checks Enter asks for.
    const onFillInput = vi.fn();
    render(
      <OpenTuiArenaDialog
        mode="start"
        config={twoModelStartConfig}
        onClose={() => {}}
        notify={() => {}}
        onFillInput={onFillInput}
        availableTerminalHeight={12}
      />,
    );

    await press('return'); // arms the error; the window drops to zero rows
    expect(screen.getByText(/Please select at least 2 models/)).toBeTruthy();
    await press('down'); // clears the error; this stale closure refuses the move
    await press('space'); // checks the painted first row
    await press('down');
    await press('space'); // checks the second row
    await press('return');
    expect(onFillInput).toHaveBeenCalledWith(
      '/arena start --models openai:m1,openai:m2 ',
    );
  });

  it('charges the start hint runs the rows they wrap into at the frame width', () => {
    // At width 80 the frame's content is seventy columns, so the 88-column
    // modelProviders URL wraps into two rows. Charged a flat row each, the
    // hint block under-paid one row and the unshrinkable frame grew past a
    // twelve-row region, pushing its bottom border out; measured at the
    // paint width the block pays four rows and the model window drops to
    // zero — no model row the region cannot pay for paints.
    mocks.state.width = 80;
    render(
      <OpenTuiArenaDialog
        mode="start"
        config={twoModelStartConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={12}
      />,
    );
    expect(
      screen.getByText(
        'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#modelproviders',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/model-1/)).toBeNull();
  });

  it('sanitizes the preview and detailed-diff runs before they are measured and painted', async () => {
    // clipAgentPreview built, measured and painted its runs without
    // sanitizeTerminalLine while the sibling external runs in this file all
    // carry it: an approachSummary with a tab (measured zero columns, so the
    // clip kept a prefix that paints past its row budget) and a git-derived
    // path with a bidi override reached the terminal raw, and the diff
    // pane's title — the same externally-derived shape — painted raw too.
    const dirtyApproach = 'a\tb'.repeat(60);
    const dirtyPath = 'src/\u202Etnp.ts';
    const dirtyModel = 'model-\x07a1';
    const dirtyManager = {
      getAgentStates: () => [
        {
          agentId: 'a1',
          model: { modelId: dirtyModel },
          status: AgentStatus.COMPLETED,
          stats: { durationMs: 1000, outputTokens: 42 },
        },
      ],
      getResult: () => ({
        task: 'task',
        agents: [
          {
            agentId: 'a1',
            model: { modelId: dirtyModel },
            approachSummary: dirtyApproach,
            stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
            diffSummary: {
              additions: 1,
              deletions: 0,
              files: [{ path: dirtyPath, additions: 1, deletions: 0 }],
            },
            diff: '+x',
          },
        ],
      }),
    };
    const dirtyConfig = {
      getArenaManager: () => dirtyManager,
    } as unknown as Config;
    const view = (availableTerminalHeight: number) => (
      <OpenTuiArenaDialog
        mode="select"
        config={dirtyConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={availableTerminalHeight}
      />
    );
    const { rerender } = render(view(16));

    await press('p');
    // The title and the approach run are sanitized before they are measured:
    // the clip pays at most the two rows the region left the run, and no
    // control or bidi byte reaches the screen. (Read the frame text, not
    // getByText: a string matcher is compared un-normalized, so a clip that
    // ends on a space could never match.)
    expect(screen.getByText('Quick Preview · model-a1')).toBeTruthy();
    const sanitizedApproach = sanitizeTerminalLine(dirtyApproach);
    const clippedApproach = clipToRows(sanitizedApproach, 78, 2);
    const painted = () => document.body.textContent ?? '';
    expect(painted()).toContain(clippedApproach);
    expect(painted()).not.toContain(sanitizedApproach);
    expect(painted()).not.toContain('\t');
    expect(painted()).not.toContain('\x07');
    expect(painted()).not.toContain('\u202E');

    // A taller region leaves the files run a row: the git-derived path is
    // stripped the same way.
    rerender(view(24));
    expect(screen.getByText('src/tnp.ts')).toBeTruthy();
    expect(painted()).not.toContain('\t');
    expect(painted()).not.toContain('\x07');
    expect(painted()).not.toContain('\u202E');

    // The detailed-diff pane's title is the same externally-derived shape.
    await press('p'); // close the preview so the diff pane may open
    await press('d');
    expect(screen.getByText('Detailed Diff · model-a1')).toBeTruthy();
    expect(painted()).not.toContain('\t');
    expect(painted()).not.toContain('\x07');
    expect(painted()).not.toContain('\u202E');
  });

  it('charges the detailed-diff title the rows it wraps into, like the preview title', async () => {
    // The diff pane paid its margin and title a flat two rows while the
    // sibling preview title measures its own wrap: at width 40 the pane's
    // content is thirty columns, so a thirty-column model id wraps the title
    // into two rows, and the flat charge grants one diff line the region
    // cannot pay.
    mocks.state.width = 40;
    const longIdManager = {
      getAgentStates: () => [
        {
          agentId: 'a1',
          model: { modelId: 'm'.repeat(30) },
          status: AgentStatus.COMPLETED,
          stats: { durationMs: 1000, outputTokens: 42 },
        },
      ],
      getResult: () => ({
        task: 'task',
        agents: [
          {
            agentId: 'a1',
            model: { modelId: 'm'.repeat(30) },
            approachSummary: 'did the thing',
            stats: { outputTokens: 42, durationMs: 1000, toolCalls: 1 },
            diffSummary: { additions: 40, deletions: 0, files: [] },
            diff: Array.from({ length: 40 }, (_, l) => `+line ${l}`).join('\n'),
          },
        ],
      }),
    };
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={{ getArenaManager: () => longIdManager } as unknown as Config}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={20}
      />,
    );

    await press('d');
    expect(screen.getByText('+line 3')).toBeTruthy();
    expect(screen.queryByText('+line 4')).toBeNull();
    // The marker is a diff line, clipped to the pane's 28 columns here.
    expect(screen.getByText(/more rows than/)).toBeTruthy();
  });

  it('does not paint a detailed-diff pane the region cannot pay', async () => {
    // At width 40 the pane's content is thirty columns, so a sixteen-column
    // model id wraps the title into two rows and the pane costs three. A
    // fourteen-row region leaves two: the pane used to paint its margin and
    // title unconditionally while lineBudget and agentWindowRows clamped the
    // deficit away with Math.max(0, …), so the unshrinkable frame painted
    // fifteen rows into fourteen — the highlighted agent row vanished under a
    // title over zero diff lines. Affordability is now decided before the
    // pane paints, matching the sibling preview pane's rule that a budget
    // which cannot pay the chrome paints nothing.
    mocks.state.width = 40;
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={wrappedTitleConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={14}
      />,
    );

    await press('d');
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
    expect(screen.getByText('qwen3-coder-plus')).toBeTruthy();
  });

  it('drops a detailed-diff pane the shrunken region can no longer pay', async () => {
    // showDetailedDiff is component state and survives a resize, and nothing
    // re-checked affordability, so a pane opened at a tall region kept
    // painting its margin and title after the terminal shrank below what it
    // costs — the same overflow, reached without a narrow terminal.
    mocks.state.width = 40;
    const { rerender } = render(
      <OpenTuiArenaDialog
        mode="select"
        config={wrappedTitleConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={24}
      />,
    );

    await press('d');
    expect(screen.getByText(/Detailed Diff · qwen3-coder-plus/)).toBeTruthy();

    rerender(
      <OpenTuiArenaDialog
        mode="select"
        config={wrappedTitleConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={14}
      />,
    );
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
    expect(screen.getByText('qwen3-coder-plus')).toBeTruthy();

    // The stranded-open flag still clears, so the pane is not wedged.
    await press('d');
    await press('d');
    expect(screen.queryByText(/Detailed Diff/)).toBeNull();
  });

  it('keeps the select prompt inside the row the chrome count pays for', () => {
    // The prompt is thirty-three columns and the frame's content is thirty at
    // width 40, so an unclipped prompt wrapped onto a second row the flat
    // twelve-row charge never paid for: the real chrome is thirteen, the
    // budget still leaves the one agent row it charged for, and the
    // unshrinkable frame paints fifteen rows into a fourteen-row region —
    // losing its bottom border and pushing the hint row past the region. The
    // task line above it and the frame's own hint already clip for exactly
    // this reason.
    mocks.state.width = 40;
    render(
      <OpenTuiArenaDialog
        mode="select"
        config={wrappedTitleConfig}
        onClose={() => {}}
        notify={() => {}}
        availableTerminalHeight={14}
      />,
    );

    const prompt = screen.getByText(/^Select a winner/);
    expect(prompt.textContent).not.toBe('Select a winner to apply changes:');
    expect(getCachedStringWidth(prompt.textContent ?? '')).toBeLessThanOrEqual(
      30,
    );
    expect(screen.getByText('qwen3-coder-plus')).toBeTruthy();
  });
});
