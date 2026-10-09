/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structural pins for the four sibling dialog frames (arena, memory +
 * statusline shell, stats, skills): they open flush with the popup region
 * (no marginTop) and keep their natural height (flexShrink 0). A shrinkable
 * frame lets the renderer squeeze its text rows to zero height and paint
 * them over each other — measured on /stats and /statusline at 80x24 and on
 * /skills at 100x20 — while an unshrinkable one keeps its rows contiguous
 * for the region's clip to cut at the tail, the way ink clips /stats. The
 * clip cuts child text but not the frame's own border strokes, so a frame
 * taller than the region still paints its border past it, and a body with an
 * explicit height (the /diff and /subagents scrollboxes) windows that height
 * from the region budget instead of relying on the clip.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import type { LoadedSettings } from '../../config/settings.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

const frameState = vi.hoisted(() => ({ width: 100 }));
vi.mock('@opentui/react', () => ({
  useRenderer: () => ({
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
  }),
  useKeyboard: vi.fn(),
  useTerminalDimensions: () => ({ width: frameState.width, height: 40 }),
}));

const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const jsx = (
    type: unknown,
    props: { children?: unknown; key?: React.Key } | null,
    key?: React.Key,
  ) => {
    const config = key === undefined ? props : { ...props, key };
    const children = (config?.children ?? null) as React.ReactNode;
    if (type === 'scrollbox') {
      // Same attribute capture as box/text, tagged so tests can find the
      // scrollbox among the frame's boxes.
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
        'div',
        {
          ...(key === undefined ? {} : { key }),
          'data-p': captured,
          'data-kind': 'scrollbox',
        },
        children,
      );
    }
    if (type === 'box' || type === 'text') {
      // Keep the layout primitives as an attribute so the frame's declared
      // geometry is readable without booting the native renderer.
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
});
vi.mock('@opentui/react/jsx-runtime', () => buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildJsxRuntime());

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { OpenTuiArenaDialog } from './dialogs-arena.js';
import { DialogFrame } from './dialogs-shared.js';
import {
  OpenTuiMemoryDialog,
  OpenTuiStatusLineDialog,
} from './dialogs-memory-status.js';
import {
  OpenTuiSkillsDialog,
  OpenTuiStatsDialog,
} from './dialogs-stats-skills.js';
import { OpenTuiThemeDialog } from './dialogs-theme.js';

const SETTINGS = { merged: {} } as unknown as LoadedSettings;

/** The layout primitives the jsx mock captured on the element. */
function layoutOf(node: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('sibling dialog frames (region clips, frame does not shrink)', () => {
  beforeEach(() => {
    frameState.width = 100;
  });

  it('the shared dialog frame keeps its natural height for the clip too', () => {
    // Measured on /mcp's tool list: a shrinkable frame let a short region
    // squeeze the unsized tool rows to zero and paint them over each other
    // mid-list while the cursor kept walking and Enter kept opening them.
    const { container } = render(
      <DialogFrame>
        <span />
      </DialogFrame>,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
  });

  it('arena frame opens flush and unshrinkable', () => {
    const { container } = render(
      <OpenTuiArenaDialog mode="status" onClose={() => {}} notify={() => {}} />,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
    expect(layoutOf(container.firstElementChild)['marginTop']).toBeUndefined();
  });

  it('memory frame opens flush and unshrinkable', () => {
    const { container } = render(
      <OpenTuiMemoryDialog settings={SETTINGS} onClose={() => {}} />,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
    expect(layoutOf(container.firstElementChild)['marginTop']).toBeUndefined();
  });

  it('statusline frame opens flush and unshrinkable', () => {
    const { container } = render(
      <OpenTuiStatusLineDialog settings={SETTINGS} onClose={() => {}} />,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
    expect(layoutOf(container.firstElementChild)['marginTop']).toBeUndefined();
  });

  it('stats frame opens flush and unshrinkable', () => {
    const { container } = render(
      <OpenTuiStatsDialog config={null} onClose={() => {}} />,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
    expect(layoutOf(container.firstElementChild)['marginTop']).toBeUndefined();
  });

  it('skills frame opens flush and unshrinkable', () => {
    const { container } = render(
      <OpenTuiSkillsDialog config={null} onClose={() => {}} />,
    );
    expect(layoutOf(container.firstElementChild)).toMatchObject({
      flexShrink: 0,
    });
    expect(layoutOf(container.firstElementChild)['marginTop']).toBeUndefined();
  });

  it('windows the skills scrollbox from the region budget', () => {
    // The frame's border, padding, title and the body's margin row take six
    // rows, so a fifteen-row region leaves the twelve-row body nine. Without
    // the window the unshrinkable frame paints its border past the region's
    // bottom edge and the list's tail has no reveal path.
    const { container } = render(
      <OpenTuiSkillsDialog
        config={null}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(
      layoutOf(container.querySelector('[data-kind="scrollbox"]')),
    ).toMatchObject({ height: 9 });
  });

  it('keeps the twelve-row skills body when no region budget is known', () => {
    const { container } = render(
      <OpenTuiSkillsDialog config={null} onClose={() => {}} />,
    );
    expect(
      layoutOf(container.querySelector('[data-kind="scrollbox"]')),
    ).toMatchObject({ height: 12 });
  });

  it("clips the theme title's scope message to the one row the chrome charges", () => {
    // Both columns' chrome charge the title as one row plus its margin, but
    // the scope message shares the title row: at width 100 the left column
    // owns 45% of the frame's content less its padding — 39 columns — so an
    // unclipped '(Also modified in Workspace)' wraps the row the window
    // charge paid for into two.
    const themeSettings = {
      merged: { ui: { theme: 'Dark' } },
      user: { settings: { ui: { theme: 'Dark' } } },
      workspace: { settings: { ui: { theme: 'Dark' } } },
      forScope: () => ({ settings: { ui: { theme: 'Dark' } } }),
    } as unknown as LoadedSettings;
    const { container } = render(
      <OpenTuiThemeDialog
        onSelect={() => {}}
        onHighlight={() => {}}
        settings={themeSettings}
        availableTerminalHeight={24}
      />,
    );
    const message = within(container).getByText(/Also modified in/);
    // The row leaves the message 39 - 15 ('> Select Theme ') = 24 columns.
    expect(getCachedStringWidth(message.textContent ?? '')).toBeLessThanOrEqual(
      24,
    );
    expect(message.textContent).toMatch(/…$/);
  });

  it('theme list column reclaims the full width when the preview pane cannot paint', () => {
    // Region 12 leaves the columns six rows — below the pane's two-row
    // minimum — so the 55% preview column is skipped; the list column takes
    // the whole frame instead of leaving the pane's share blank.
    const themeSettings = {
      merged: {},
      user: { settings: {} },
      workspace: { settings: {} },
      forScope: () => ({ settings: {} }),
    } as unknown as LoadedSettings;
    const narrow = render(
      <OpenTuiThemeDialog
        onSelect={() => {}}
        onHighlight={() => {}}
        settings={themeSettings}
        availableTerminalHeight={12}
      />,
    );
    const listColumn =
      narrow.container.firstElementChild?.firstElementChild?.firstElementChild;
    expect(layoutOf(listColumn)).toMatchObject({ width: '100%' });
    narrow.unmount();

    // With the pane painted, the 45/55 split stays.
    const tall = render(
      <OpenTuiThemeDialog
        onSelect={() => {}}
        onHighlight={() => {}}
        settings={themeSettings}
        availableTerminalHeight={24}
      />,
    );
    const splitColumn =
      tall.container.firstElementChild?.firstElementChild?.firstElementChild;
    expect(layoutOf(splitColumn)).toMatchObject({ width: '45%' });
  });

  it('charges the theme footer hint the rows it wraps into at a narrow width', () => {
    // At a forty-column terminal the 44-column footer hint wraps to two
    // rows, so the measured chrome is nine, not the flat eight: a
    // twelve-row region pays the scroll arrows and one theme row, where the
    // flat count paid two rows — and the unshrinkable frame grew a row past
    // the region.
    frameState.width = 40;
    const themeSettings = {
      merged: {},
      user: { settings: {} },
      workspace: { settings: {} },
      forScope: () => ({ settings: {} }),
    } as unknown as LoadedSettings;
    const { container } = render(
      <OpenTuiThemeDialog
        onSelect={() => {}}
        onHighlight={() => {}}
        settings={themeSettings}
        availableTerminalHeight={12}
      />,
    );
    // One numbered theme row paints; the second is beyond the window.
    expect(within(container).getByText(/^\s*1\.$/)).toBeTruthy();
    expect(within(container).queryByText(/^\s*2\.$/)).toBeNull();
    expect(within(container).getByText(/Tab to configure scope/)).toBeTruthy();
    frameState.width = 100;
  });

  it('clips a theme label to the one row its item charge pays', () => {
    // Each theme row is charged one physical row, so the label clips to the
    // columns the row owns: at a forty-column terminal with the preview pane
    // painted, the column is 32 * 0.45 - 2 = 12 and the label owns
    // 12 - 3 - 2 = 7 of them, so a longer name clips instead of wrapping
    // onto a second row. The custom theme is the highlighted (last) row, so
    // the window follows the cursor down to it.
    frameState.width = 40;
    const themeSettings = {
      merged: { ui: { theme: 'a-very-long-custom-theme-name' } },
      user: {
        settings: {
          ui: { customThemes: { 'a-very-long-custom-theme-name': {} } },
        },
      },
      workspace: { settings: {} },
      forScope: () => ({ settings: {} }),
    } as unknown as LoadedSettings;
    const { container } = render(
      <OpenTuiThemeDialog
        onSelect={() => {}}
        onHighlight={() => {}}
        settings={themeSettings}
        availableTerminalHeight={24}
      />,
    );
    expect(within(container).getByText('a-very-')).toBeTruthy();
    expect(within(container).queryByText(/a-very-long/)).toBeNull();
    frameState.width = 100;
  });

  it('windows the skills scrollbox to zero rows when the region cannot pay the chrome', () => {
    const { container } = render(
      <OpenTuiSkillsDialog
        config={null}
        onClose={() => {}}
        availableTerminalHeight={5}
      />,
    );
    expect(
      layoutOf(container.querySelector('[data-kind="scrollbox"]')),
    ).toMatchObject({ height: 0 });
  });
});
