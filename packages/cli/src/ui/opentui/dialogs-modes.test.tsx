/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_OUTPUT_STYLES,
  type Config,
  type OutputStyleDefinition,
} from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

const mocks = vi.hoisted(() => {
  const loadSessionOutputStyles = vi.fn();
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
        // Keep the layout primitives as an attribute so the geometry tests
        // below can read what the real renderer would receive.
        const captured = JSON.stringify(
          Object.fromEntries(
            Object.entries(config ?? {}).filter(
              ([k, v]) =>
                k !== 'children' &&
                (typeof v === 'string' ||
                  typeof v === 'number' ||
                  typeof v === 'boolean'),
            ),
          ),
        );
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          { ...(key === undefined ? {} : { key }), 'data-p': captured },
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
  return { state, buildJsxRuntime, loadSessionOutputStyles };
});

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    // opentui registers one stable listener per hook instance (useEffectEvent)
    // on an emitter that fires for every listener, so each mounted list sees
    // each key and its own `focused` flag decides whether it acts.
    useKeyboard: (handler: (key: unknown) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      const stable = React.useRef<((key: unknown) => void) | undefined>(
        undefined,
      );
      if (!stable.current) {
        stable.current = (key: unknown) => latest.current(key);
        mocks.state.keyboardHandlers.push(stable.current);
      }
    },
    useTerminalDimensions: () => ({ width: mocks.state.width }),
  };
});
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string; shift?: boolean }) => ({
    name: key.name ?? '',
    shift: key.shift ?? false,
  }),
}));
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
// The dialog loads the style catalog from disk; stub just that so the test
// never depends on the developer's own ~/.qwen/output-styles.
vi.mock('../commands/output-style-utils.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../commands/output-style-utils.js')
  >()),
  loadSessionOutputStyles: mocks.loadSessionOutputStyles,
}));

import {
  OpenTuiApprovalModeDialog,
  OpenTuiEffortDialog,
  OpenTuiOutputStyleDialog,
  wrappedRows,
} from './dialogs-modes.js';

const CONCISE = BUILT_IN_OUTPUT_STYLES.find(
  (style) => style.name === 'Concise',
);
if (!CONCISE) throw new Error('missing Concise output style');

function press(name: string, shift = false) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler({ name, shift });
    }
  });
}

/** The row's text: marker, then the number column, then the label. */
function rowText(labelPrefix: string): string {
  const label = screen.getByText((content) =>
    content.startsWith(labelPrefix),
  ) as HTMLElement;
  return (label.parentElement?.parentElement?.textContent ?? '').trim();
}

function isSelected(labelPrefix: string): boolean {
  return rowText(labelPrefix).startsWith('›');
}

/** Just the label run of a row, without the marker and number columns. */
function labelText(labelPrefix: string): string {
  return (
    screen.getByText((content) => content.startsWith(labelPrefix))
      .textContent ?? ''
  );
}

function queryRow(labelPrefix: string): string | null {
  return screen.queryByText((content) => content.startsWith(labelPrefix))
    ? rowText(labelPrefix)
    : null;
}

/** The layout primitives the jsx mock captured on the element. */
function layoutOf(node: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<
    string,
    unknown
  >;
}

/** What the mode step's budget bought, read off the rendered dialog. */
function expectBudget(expected: {
  spacer: number;
  footerHint: boolean;
  arrows: boolean;
  rowCount: number;
}) {
  const title = screen.getByText(/^> Approval Mode/);
  expect(layoutOf(title.parentElement)).toMatchObject({
    marginBottom: expected.spacer,
  });
  expect(screen.queryByText(/^\(Use Enter to select/) !== null).toBe(
    expected.footerHint,
  );
  expect(screen.queryByText('▲') !== null).toBe(expected.arrows);
  expect(screen.queryByText('▼') !== null).toBe(expected.arrows);
  // One number column per rendered row, so this counts the window itself.
  expect(screen.queryAllByText(/^\d+\.$/)).toHaveLength(expected.rowCount);
}

function createHarness(
  options: {
    current?: OutputStyleDefinition;
    systemPrompt?: string;
    setValue?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let current = options.current;
  const setOutputStyle = vi.fn((style: OutputStyleDefinition | undefined) => {
    current = style;
  });
  const refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
  const setValue = options.setValue ?? vi.fn();
  const config = {
    getOutputStyle: () => current,
    getSystemPrompt: () => options.systemPrompt,
    getExperimentalZedIntegration: () => false,
    getInputFormat: () => undefined,
    isInteractive: () => true,
    getBareMode: () => false,
    isSafeMode: () => false,
    setOutputStyle,
    getLlmClient: () => ({ refreshSystemInstruction }),
  } as unknown as Config;
  const settings = {
    isTrusted: true,
    workspace: { settings: { general: {} } },
    setValue,
  } as unknown as LoadedSettings;
  return {
    config,
    settings,
    setOutputStyle,
    refreshSystemInstruction,
    setValue,
  };
}

describe('OpenTuiApprovalModeDialog', () => {
  function renderModeDialog(
    options: {
      current?: ApprovalMode;
      availableTerminalHeight?: number;
      /** A workspace-scope `tools.approvalMode`, which raises ink's warning. */
      workspaceModified?: boolean;
    } = {},
  ) {
    const setValue = vi.fn();
    const onClose = vi.fn();
    const onApprovalModeChanged = vi.fn();
    let approvalMode = options.current ?? ApprovalMode.DEFAULT;
    const config = {
      getApprovalMode: () => approvalMode,
      isTrustedFolder: () => true,
      setApprovalMode: (mode: ApprovalMode) => {
        approvalMode = mode;
      },
    } as unknown as Config;
    const settings = {
      isTrusted: true,
      merged: { tools: {} },
      forScope: (scope: SettingScope) => ({
        settings:
          options.workspaceModified && scope === SettingScope.Workspace
            ? { tools: { approvalMode: ApprovalMode.YOLO } }
            : {},
      }),
      setValue,
    } as unknown as LoadedSettings;
    const { container, unmount } = render(
      <OpenTuiApprovalModeDialog
        config={config}
        settings={settings}
        onClose={onClose}
        onApprovalModeChanged={onApprovalModeChanged}
        availableTerminalHeight={options.availableTerminalHeight}
      />,
    );
    return { setValue, onClose, onApprovalModeChanged, container, unmount };
  }

  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.width = 100;
  });

  it("labels every mode with ink's display name, description and row number", () => {
    renderModeDialog({ current: ApprovalMode.YOLO });

    // ink builds `${formatApprovalModeName} - ${formatApprovalModeDescription}`
    // and numbers the rows; a hand-written label set drifts from both.
    expect(rowText('plan mode - ')).toBe(
      '1.plan mode - Analyze only, do not modify files or execute commands',
    );
    expect(rowText('YOLO mode - ')).toBe(
      '›5.YOLO mode - Automatically approve all tools',
    );
    expect(isSelected('YOLO mode - ')).toBe(true);
  });

  it('wraps from the last row to the first, like ink useSelectionList', () => {
    renderModeDialog({ current: ApprovalMode.YOLO });

    press('down');

    expect(isSelected('plan mode - ')).toBe(true);
  });

  it('persists to the scope picked in the Tab step', () => {
    const harness = renderModeDialog({ current: ApprovalMode.DEFAULT });

    press('tab');
    expect(queryRow('Workspace Settings')).not.toBeNull();
    press('down');
    press('return');

    // ink's handleScopeSelect only records the scope and steps back; the mode
    // row's Enter is what writes.
    expect(harness.setValue).not.toHaveBeenCalled();
    expect(queryRow('Ask permissions - ')).not.toBeNull();

    press('down');
    press('return');

    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'tools.approvalMode',
      ApprovalMode.AUTO_EDIT,
    );
    expect(harness.onApprovalModeChanged).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(harness.onClose).toHaveBeenCalled();
  });

  it('restores the highlighted row after the scope trip, like ink', () => {
    renderModeDialog({ current: ApprovalMode.DEFAULT });

    press('down'); // Ask permissions → auto-accept edits
    expect(isSelected('auto-accept edits - ')).toBe(true);

    press('tab'); // → scope step
    press('down'); // User Settings → Workspace, so the trip actually changes the scope
    press('return'); // → mode step, which re-syncs the list cursor

    // ink seeds the remounted list from the mode its arrows last highlighted,
    // not from the mode the config still holds.
    expect(isSelected('auto-accept edits - ')).toBe(true);
    expect(isSelected('Ask permissions - ')).toBe(false);
  });

  it('closes on Esc without writing', () => {
    const harness = renderModeDialog();

    press('escape');

    expect(harness.onClose).toHaveBeenCalledTimes(1);
    expect(harness.setValue).not.toHaveBeenCalled();
  });

  it('stretches to the popup region with the hint pushed to its bottom, like ink', () => {
    // ink sizes this one dialog with clampDialogHeight(availableTerminalHeight),
    // so its frame fills the region and the footer hint sits on the region's
    // last content row. Without both flexGrow values the real renderer draws a
    // content-height box, or a full-height box with the hint stranded mid-way.
    const { container } = renderModeDialog();
    const frame = container.firstElementChild;
    expect(layoutOf(frame)).toMatchObject({
      borderStyle: 'rounded',
      flexGrow: 1,
    });
    expect(layoutOf(frame?.firstElementChild)).toMatchObject({
      flexDirection: 'column',
      flexGrow: 1,
    });
  });

  it('windows the list to the region budget a short terminal hands it, like ink', () => {
    // ink's dialog manager hands this dialog the region height, and it sheds
    // chrome as the budget shrinks: at ten rows the list keeps two rows behind
    // scroll arrows and drops the footer hint. Without the explicit
    // maxItemsToShow the five rows never window, and the renderer shrinks the
    // unsized boxes to zero — overpainting neighbours while the keys still
    // commit a highlighted row the user cannot read.
    renderModeDialog({ availableTerminalHeight: 10 });

    expect(queryRow('plan mode - ')).not.toBeNull();
    expect(queryRow('Ask permissions - ')).not.toBeNull();
    expect(queryRow('auto-accept edits - ')).toBeNull();
    expect(screen.getByText('▼')).not.toBeNull();
    expect(
      screen.queryByText('(Use Enter to select, Tab to configure scope)'),
    ).toBeNull();

    // The window follows the highlight, so every row stays reachable.
    press('down');
    press('down');
    expect(queryRow('auto-accept edits - ')).not.toBeNull();
  });

  it('clips every mode label to the columns its row leaves, like ink', () => {
    // ink gives the labels `wrap="truncate"`; at 60 columns the content width
    // is 52 and the row's own indicator and number boxes take 5, so a label
    // gets 47 columns. Left to @opentui's default word wrap, four of the five
    // labels become two physical rows each and the list overruns the frame the
    // budget sized it for.
    mocks.state.width = 60;
    renderModeDialog();

    const labels = [
      labelText('plan mode - '),
      labelText('Ask permissions - '),
      labelText('auto-accept edits - '),
      labelText('Auto mode - '),
      labelText('YOLO mode - '),
    ];
    for (const label of labels) {
      expect(getCachedStringWidth(label)).toBeLessThanOrEqual(47);
    }
    // Four of the five are over budget and carry the ellipsis; the fifth
    // ('YOLO mode - Automatically approve all tools') still fits whole.
    expect(labels.filter((label) => label.endsWith('…'))).toHaveLength(4);
  });

  it('clips the title run and the footer hint to the single row each budgets', () => {
    mocks.state.width = 40;
    renderModeDialog({ workspaceModified: true });

    const contentWidth = 32; // dialogContentWidth(40)
    const subtitle = screen.getByText(/^\(Modified in/);
    expect(
      getCachedStringWidth(subtitle.textContent ?? ''),
    ).toBeLessThanOrEqual(
      contentWidth - getCachedStringWidth('> Approval Mode '),
    );
    expect(subtitle.textContent?.endsWith('…')).toBe(true);

    const hint = screen.getByText(/^\(Use Enter to select/);
    expect(getCachedStringWidth(hint.textContent ?? '')).toBeLessThanOrEqual(
      contentWidth,
    );
    expect(hint.textContent?.endsWith('…')).toBe(true);
  });

  it('pays for the warning rows a narrow terminal wraps it into', () => {
    // ink wraps the warning and reserves a flat three rows for it. At 40
    // columns the same text needs more, and the extra rows have to come out of
    // the list rather than out of the frame: without that, the region's last
    // rows are overpainted.
    mocks.state.width = 40;
    const narrow = renderModeDialog({
      availableTerminalHeight: 16,
      workspaceModified: true,
    });

    expect(queryRow('Ask permissions - ')).not.toBeNull();
    expect(queryRow('YOLO mode - ')).toBeNull();
    expect(screen.getByText('▼')).not.toBeNull();
    narrow.unmount();

    // The same region at a width where the warning fits its ink row count
    // keeps the whole list, so the narrowing above is the wrap being paid for.
    mocks.state.width = 100;
    renderModeDialog({ availableTerminalHeight: 16, workspaceModified: true });
    expect(queryRow('YOLO mode - ')).not.toBeNull();
  });

  it('never budgets the warning below the three rows ink reserves for it', () => {
    // At a hundred columns the warning text fits one wrapped row, so the width
    // derivation alone would hand the budget two rows — margin plus text — and
    // show a fifth mode ink does not. ink's flat three is the floor; the
    // derivation only adds to it.
    renderModeDialog({ availableTerminalHeight: 15, workspaceModified: true });

    expect(queryRow('Ask permissions - ')).not.toBeNull();
    expect(queryRow('YOLO mode - ')).toBeNull();
    expect(screen.getByText('▼')).not.toBeNull();
  });

  it.each([
    // region rows, spacer rows, footer hint, scroll arrows, mode rows
    [6, 0, false, false, 1],
    [8, 0, false, true, 1],
    [9, 1, false, true, 1],
    [10, 1, false, true, 2],
    [12, 1, true, true, 2],
    [14, 1, true, false, 5],
  ])(
    'windows the mode list from the region budget it is handed (h=%i)',
    (height, spacer, footerHint, arrows, rowCount) => {
      renderModeDialog({ availableTerminalHeight: height });
      expectBudget({ spacer, footerHint, arrows, rowCount });
    },
  );

  it.each([
    // The warning's three rows come out of the same budget, so every threshold
    // below moves with them — including the footer hint's, which ink raises
    // from 10 to 12 while the warning is up, and the guard that keeps the
    // hint on screen when dropping it would only buy room for arrows.
    [11, 1, false, false, 2],
    [12, 1, true, false, 1],
    [13, 1, true, false, 2],
    [14, 1, true, true, 1],
  ])(
    'windows the mode list around the workspace warning (h=%i)',
    (height, spacer, footerHint, arrows, rowCount) => {
      renderModeDialog({
        availableTerminalHeight: height,
        workspaceModified: true,
      });
      expectBudget({ spacer, footerHint, arrows, rowCount });
    },
  );

  it('sheds the spacer and windows the Tab step on a short terminal', () => {
    // Deliberate divergence from ink's ScopeSelector, which keeps an
    // unconditional spacer row and an unwindowed list inside a frame that
    // clips. This frame does not clip, so at region 6 the two scope rows and
    // the spacer overpaint each other and Enter commits a scope the user
    // cannot read.
    renderModeDialog({ availableTerminalHeight: 6 });
    press('tab');

    const title = screen.getByText(/^> Apply To/);
    expect(layoutOf(title.parentElement)).toMatchObject({ marginBottom: 0 });
    expect(queryRow('User Settings')).not.toBeNull();
    expect(queryRow('Workspace Settings')).toBeNull();
  });

  it('reads the footer hint from the step on screen, not the step it left', () => {
    // At region 11 with the warning up, the mode step's budget hides the hint
    // (the warning's rows raise its threshold to 12) while the scope step's
    // own budget shows it. Reading the mode step's budget for the scope step
    // would hide a hint the rows on screen paid for.
    renderModeDialog({ availableTerminalHeight: 11, workspaceModified: true });
    expect(
      screen.queryByText('(Use Enter to select, Tab to configure scope)'),
    ).toBeNull();

    press('tab');

    expect(
      screen.getByText('(Use Enter to apply scope, Tab to go back)'),
    ).not.toBeNull();
  });
});

describe('OpenTuiApprovalModeDialog trust gate', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.width = 100;
  });

  function renderUntrusted(availableTerminalHeight?: number) {
    const setApprovalMode = vi.fn();
    const setValue = vi.fn();
    const config = {
      getApprovalMode: () => ApprovalMode.YOLO,
      isTrustedFolder: () => false,
      setApprovalMode,
    } as unknown as Config;
    const settings = {
      merged: { tools: {} },
      forScope: () => ({ settings: {} }),
      setValue,
    } as unknown as LoadedSettings;
    render(
      <OpenTuiApprovalModeDialog
        config={config}
        settings={settings}
        onClose={vi.fn()}
        onApprovalModeChanged={vi.fn()}
        availableTerminalHeight={availableTerminalHeight}
      />,
    );
    return { setApprovalMode, setValue };
  }

  it('applies the effective mode after saving a shadowed user choice', () => {
    const setApprovalMode = vi.fn();
    const config = {
      getApprovalMode: () => ApprovalMode.YOLO,
      isTrustedFolder: () => true,
      setApprovalMode,
    } as unknown as Config;
    const settings = {
      merged: { tools: { approvalMode: ApprovalMode.DEFAULT } },
      forScope: () => ({ settings: {} }),
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    const onApprovalModeChanged = vi.fn();

    render(
      <OpenTuiApprovalModeDialog
        config={config}
        settings={settings}
        onClose={vi.fn()}
        onApprovalModeChanged={onApprovalModeChanged}
      />,
    );
    press('return');

    expect(setApprovalMode.mock.calls).toEqual([[ApprovalMode.DEFAULT]]);
    expect(onApprovalModeChanged).toHaveBeenCalledWith(ApprovalMode.DEFAULT);
  });

  it('does not persist a privileged mode in an untrusted folder', () => {
    const { setValue, setApprovalMode } = renderUntrusted();
    press('return');

    expect(setValue).not.toHaveBeenCalled();
    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(
      screen.queryByText(
        'Cannot enable privileged approval modes in an untrusted folder.',
      ),
    ).not.toBeNull();
  });

  it('windows the list to pay for the refusal it keeps on screen', () => {
    // The refusal is a margin row plus a text row inside the same frame. The
    // budget that ignores it hands those two rows to the list, so at region 13
    // the refusal lands on rows the list also paints.
    renderUntrusted(13);
    press('return');

    expect(
      screen.getByText(
        'Cannot enable privileged approval modes in an untrusted folder.',
      ),
    ).not.toBeNull();
    // One list row between the two scroll arrows is what 13 rows leave once
    // the refusal is paid for; five unarrowed rows is what it leaves if not.
    expect(screen.getByText('▲')).not.toBeNull();
    expect(screen.getByText('▼')).not.toBeNull();
    expect(queryRow('plan mode - ')).toBeNull();
    expect(queryRow('YOLO mode - ')).not.toBeNull();
  });

  it('clears the refusal when the scope moves, and the list window grows back', () => {
    // The refusal's rows are charged to the list window, so a refusal that
    // stayed after the scope it refused against moved would keep the list
    // windowed behind a message that no longer describes anything.
    renderUntrusted(13);
    press('return');
    expect(
      screen.getByText(
        'Cannot enable privileged approval modes in an untrusted folder.',
      ),
    ).not.toBeNull();
    expect(queryRow('plan mode - ')).toBeNull();

    press('tab');
    press('down');
    press('return');

    expect(
      screen.queryByText(
        'Cannot enable privileged approval modes in an untrusted folder.',
      ),
    ).toBeNull();
    expect(queryRow('plan mode - ')).not.toBeNull();
    expect(queryRow('YOLO mode - ')).not.toBeNull();
  });
});

describe('OpenTuiOutputStyleDialog', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.width = 100;
    mocks.loadSessionOutputStyles.mockReset();
    mocks.loadSessionOutputStyles.mockResolvedValue(BUILT_IN_OUTPUT_STYLES);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('clips ten-row catalog labels to the columns a two-digit number column leaves', async () => {
    // DialogSelect sizes the number box from the full list's length, so a
    // ten-row catalog spends six columns on row chrome, not five. Clipped one
    // column wider, @opentui's word wrap puts the tail on a second physical
    // row the budget never paid for — measured on the real renderer at
    // 100x24: rows overpainted while digit key 5 still committed one.
    const customs: OutputStyleDefinition[] = [
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
    ].map((name) => ({
      name,
      description: `A ${name} style with a description long enough to need truncation at sixty columns`,
      source: 'user',
      prompt: 'Behave accordingly.',
      keepCodingInstructions: false,
    }));
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      ...customs,
    ]);
    mocks.state.width = 60;
    const harness = createHarness();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(queryRow('Alpha — ')).not.toBeNull());
    // Ten rows at width 60: content width 52 minus indicator (2) and the
    // two-digit number box (4) leaves each label 46 columns.
    for (const name of [
      'default',
      'Concise',
      'Proactive',
      'Explanatory',
      'Learning',
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
    ]) {
      expect(getCachedStringWidth(labelText(`${name} — `))).toBeLessThanOrEqual(
        46,
      );
    }
  });

  it('lists a custom style and pre-selects the active one', async () => {
    // Startup style resolution is renderer-independent, so a custom style can
    // be live here. A list of built-ins alone leaves it unfound, and the
    // `-1 -> 0` clamp then highlights `default` -- one Enter persists that
    // over the user's own setting.
    const custom: OutputStyleDefinition = {
      name: 'Reviewer',
      description: 'Reviews without editing',
      source: 'user',
      prompt: 'Review only.',
      keepCodingInstructions: false,
    };
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      custom,
    ]);
    const harness = createHarness({ current: custom });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(isSelected('Reviewer — ')).toBe(true));
    // Labelled with its source, as the ink picker does.
    expect(rowText('Reviewer — ')).toContain('(user)');
    expect(isSelected('default — ')).toBe(false);
  });

  it('labels a project style with its own source and leaves built-ins unlabelled', async () => {
    // The row's source is the picker's only trust-relevant provenance: a
    // prompt read from the workspace must not read as the user's own.
    const project: OutputStyleDefinition = {
      name: 'TeamVoice',
      description: 'Team style from the workspace',
      source: 'project',
      prompt: 'Speak for the team.',
      keepCodingInstructions: true,
    };
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      project,
    ]);
    const harness = createHarness();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(queryRow('TeamVoice — ')).not.toBeNull());
    expect(rowText('TeamVoice — ')).toContain('(project)');
    expect(rowText('Concise — ')).not.toContain('(');
  });

  it('keeps the configured style selected while a system prompt override is active', async () => {
    const harness = createHarness({
      current: CONCISE,
      systemPrompt: 'Replace the base prompt.',
    });
    const onClose = vi.fn();
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={onClose}
        notify={notify}
      />,
    );

    await waitFor(() => expect(isSelected('Concise — ')).toBe(true));
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
    expect(harness.refreshSystemInstruction).toHaveBeenCalledTimes(1);
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Concise',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Output style set to Concise'),
    );
  });

  it('moves from default to Concise and applies it on Enter', async () => {
    const harness = createHarness();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(queryRow('Concise — ')).not.toBeNull());
    press('down');
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
  });

  it('keeps and applies the configured style while QWEN_SYSTEM_MD is active', async () => {
    vi.stubEnv('QWEN_SYSTEM_MD', '/tmp/replacement-system.md');
    const harness = createHarness({ current: CONCISE });
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={notify}
      />,
    );

    await waitFor(() => expect(isSelected('Concise — ')).toBe(true));
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Concise',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('saved but has no effect in this session'),
    );
  });

  it('clears the configured style only after default is selected', async () => {
    const harness = createHarness({ current: CONCISE });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    // Wait for the selection marker, not just the row: the catalog text
    // renders with the mount-time selection (index 0) and the pre-selection
    // of the active style lands in a later commit. Pressing keys on text
    // presence alone can interleave as up-then-derive-then-return, which
    // picks Concise instead of default.
    await waitFor(() => expect(isSelected('Concise — ')).toBe(true));
    press('up');
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(undefined),
    );
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'default',
      undefined,
      { throwOnWriteFailure: true },
    );
  });

  it('closes on Esc without changing or persisting the style', async () => {
    const harness = createHarness({ current: CONCISE });
    const onClose = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={onClose}
        notify={vi.fn()}
      />,
    );

    press('escape');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.setValue).not.toHaveBeenCalled();
  });

  it('does not offer selectable rows before the catalog is ready', async () => {
    const custom: OutputStyleDefinition = {
      name: 'Reviewer',
      description: 'Reviews without editing',
      source: 'user',
      prompt: 'Review only.',
      keepCodingInstructions: false,
    };
    let releaseLoad: (() => void) | undefined;
    mocks.loadSessionOutputStyles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLoad = () => resolve([...BUILT_IN_OUTPUT_STYLES, custom]);
        }),
    );
    const harness = createHarness({ current: custom });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    expect(screen.queryByText('Loading output styles…')).not.toBeNull();
    expect(screen.queryByText(/default — /)).toBeNull();
    // The list is mounted but empty, so Enter has no row to commit.
    press('return');
    expect(harness.setOutputStyle).not.toHaveBeenCalled();

    await act(async () => {
      releaseLoad?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(isSelected('Reviewer — ')).toBe(true));
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.setValue).not.toHaveBeenCalled();
  });

  it('closes and notifies when the catalog cannot be read', async () => {
    mocks.loadSessionOutputStyles.mockRejectedValue(new Error('EACCES'));
    const harness = createHarness();
    const onClose = vi.fn();
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={onClose}
        notify={notify}
      />,
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('EACCES'),
      'error',
    );
    expect(screen.queryByText(/default — /)).toBeNull();
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.setValue).not.toHaveBeenCalled();
  });

  it('notifies when persistence fails', async () => {
    const setValue = vi.fn(() => {
      throw new Error('disk full');
    });
    const harness = createHarness({ current: CONCISE, setValue });
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={notify}
      />,
    );

    await waitFor(() => expect(queryRow('Concise — ')).not.toBeNull());
    press('return');

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('disk full'),
        'error',
      ),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('general.outputStyle'),
      'error',
    );
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.refreshSystemInstruction).not.toHaveBeenCalled();
  });

  it('keeps the navigated row when the shell re-renders with new callbacks', async () => {
    // The mount site passes `onClose`/`notify` as fresh inline closures on
    // every shell render. If the catalog effect depended on them, the reload
    // would land a new style array and re-derive the selection -- Enter would
    // then apply the previously active style instead of the navigated row.
    mocks.loadSessionOutputStyles.mockImplementation(async () => [
      ...BUILT_IN_OUTPUT_STYLES,
    ]);
    const harness = createHarness();
    const view = render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(queryRow('Concise — ')).not.toBeNull());
    press('down');
    expect(isSelected('Concise — ')).toBe(true);

    await act(async () => {
      view.rerender(
        <OpenTuiOutputStyleDialog
          config={harness.config}
          settings={harness.settings}
          onClose={vi.fn()}
          notify={vi.fn()}
        />,
      );
      // Let a reload, were one started, resolve and re-derive the selection.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.loadSessionOutputStyles).toHaveBeenCalledTimes(1);
    expect(isSelected('Concise — ')).toBe(true);
    press('return');
    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
  });

  it('lists the active style the reloaded catalog no longer carries', async () => {
    // The catalog is re-read on every open and skips a file it cannot parse,
    // so the live style can be missing from it. Snapping to index 0 would mark
    // `default` as active and one Enter would persist that over the setting.
    const custom: OutputStyleDefinition = {
      name: 'Reviewer',
      description: 'Reviews without editing',
      source: 'user',
      prompt: 'Review only.',
      keepCodingInstructions: false,
    };
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
    ]);
    const harness = createHarness({ current: custom });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(isSelected('Reviewer — ')).toBe(true));
    expect(isSelected('default — ')).toBe(false);

    press('return');
    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(custom),
    );
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Reviewer',
      undefined,
      { throwOnWriteFailure: true },
    );
  });

  it('does not duplicate a catalog entry that differs only in case', async () => {
    // The catalog dedupes and looks styles up case-insensitively, so an
    // exact-equality membership test would append a second row here.
    const listed: OutputStyleDefinition = {
      name: 'reviewer',
      description: 'Reviews without editing',
      source: 'user',
      prompt: 'Review only.',
      keepCodingInstructions: false,
    };
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      listed,
    ]);
    const harness = createHarness({ current: { ...listed, name: 'Reviewer' } });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(isSelected('reviewer — ')).toBe(true));
    expect(
      screen.getAllByText((content) => content.startsWith('reviewer — ')),
    ).toHaveLength(1);
    expect(queryRow('Reviewer — ')).toBeNull();
  });
});

describe('OpenTuiEffortDialog', () => {
  const capability = {
    thinking: true,
    efforts: ['high', 'max'],
    defaultEffort: 'high',
    disableField: 'thinking',
  } as const;

  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.width = 100;
  });

  function renderEffortDialog(reasoningEffort: string | undefined) {
    const setValue = vi.fn();
    const notify = vi.fn();
    let applied = reasoningEffort;
    const setReasoningEffort = vi.fn((tier: string) => {
      applied = tier;
    });
    const config = {
      getModel: () => 'deepseek-v4-pro',
      getAuthType: () => 'openai',
      getReasoningEffort: () => applied,
      setReasoningEffort,
      getResolvedModelConfig: () => ({
        capabilities: { reasoning: capability },
      }),
    } as unknown as Config;
    const settings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: { general: {} } },
      merged: {},
      setValue,
    } as unknown as LoadedSettings;
    render(
      <OpenTuiEffortDialog
        config={config}
        settings={settings}
        onClose={vi.fn()}
        notify={notify}
      />,
    );
    return { setValue, setReasoningEffort, notify };
  }

  it('lists only the tiers the resolved model exposes, with ink labels', () => {
    renderEffortDialog(undefined);

    expect(queryRow('low — ')).toBeNull();
    expect(queryRow('medium — ')).toBeNull();
    expect(queryRow('xhigh — ')).toBeNull();
    expect(rowText('high — ')).toBe(
      '›1.high — Default — strong reasoning for hard tasks.',
    );
    // No tier is configured, so the picker says so rather than implying that
    // the highlighted row is live.
    expect(
      screen.getByText(
        'No effort configured — using the model/provider default.',
      ),
    ).not.toBeNull();
  });

  it('reports a configured tier the resolved model does not expose', () => {
    // A global `model.reasoningEffort` carried over from another model reaches
    // the picker; the `-1 -> 0` clamp must not pass it off as the selection.
    renderEffortDialog('xhigh');

    expect(
      screen.getByText(/xhigh is not available for this model/),
    ).not.toBeNull();
    // ink clamps to the first row and lets that dim line carry the truth.
    expect(isSelected('high — ')).toBe(true);
  });

  it('wraps from the last tier to the first and persists the reached row', () => {
    const harness = renderEffortDialog('max');

    expect(isSelected('max — ')).toBe(true);
    press('down');
    expect(isSelected('high — ')).toBe(true);
    press('return');

    expect(harness.setReasoningEffort).toHaveBeenCalledWith('high');
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.reasoningEffort',
      'high',
    );
  });

  it('reports the applied tier with ink effort-hook message', () => {
    const harness = renderEffortDialog('max');
    press('down');
    press('return');

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledWith(
      'Reasoning effort: high (requested; the effective tier depends on the active provider/model).',
    );
  });

  it('shows the whole subtitle over as many rows as it needs, like ink', () => {
    // ink's EffortDialog renders the title run as a plain bold Text with no
    // wrap="truncate" — only ApprovalModeDialog truncates — so the
    // clamped-per-model caveat reaches a narrow terminal whole instead of
    // clipping to '(applied acr…' or dropping out entirely below it.
    mocks.state.width = 40;
    renderEffortDialog(undefined);

    expect(
      screen.getByText('(applied across all providers; clamped per model)'),
    ).not.toBeNull();
  });
});

describe('DialogFrame fill flag (Decision 66)', () => {
  // ink stretches only the approval-mode dialog to the region it is given;
  // the effort and output-style dialogs stay content-height, so their frames
  // must not carry the grow flag. The approval half is pinned by the stretch
  // case above; reverting either dialog to `fill` fails the matching half.

  it('leaves the effort frame content-height', () => {
    const config = {
      getModel: () => 'deepseek-v4-pro',
      getAuthType: () => 'openai',
      getReasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      getResolvedModelConfig: () => ({
        capabilities: {
          reasoning: {
            thinking: true,
            efforts: ['high'],
            defaultEffort: 'high',
            disableField: 'thinking',
          },
        },
      }),
    } as unknown as Config;
    const { container } = render(
      <OpenTuiEffortDialog
        config={config}
        settings={{ merged: {} } as unknown as LoadedSettings}
        onClose={() => {}}
      />,
    );

    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexGrow: 0,
    });
  });

  it('leaves the output-style frame content-height', () => {
    mocks.loadSessionOutputStyles.mockResolvedValue(BUILT_IN_OUTPUT_STYLES);
    const harness = createHarness();
    const { container } = render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexGrow: 0,
    });
  });
});

describe('wrappedRows (the row count a wrapped notice pays for)', () => {
  it('packs a spaceless CJK run by cell width, never splitting a glyph', () => {
    // The shipped zh workspace warning is 28 full-width characters with no
    // spaces, and the renderer cannot split a two-cell glyph across the
    // boundary, so a 19-column row holds nine of them — not the ten a
    // whole-width division predicts. The space-split model budgets four rows
    // where the renderer paints five, and the warning's last row is lost.
    expect(
      wrappedRows(
        '⚠ 工作区审批模式已存在并具有优先级。用户级别的更改将无效。',
        19,
      ),
    ).toBe(5);
  });

  it('counts a newline as a row break', () => {
    expect(wrappedRows('a\nb', 40)).toBe(2);
  });
});
