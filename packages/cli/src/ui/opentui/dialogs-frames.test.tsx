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

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('@opentui/react', () => ({
  useRenderer: () => ({
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
  }),
  useKeyboard: vi.fn(),
  useTerminalDimensions: () => ({ width: 100, height: 40 }),
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

const SETTINGS = { merged: {} } as unknown as LoadedSettings;

/** The layout primitives the jsx mock captured on the element. */
function layoutOf(node: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('sibling dialog frames (region clips, frame does not shrink)', () => {
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
