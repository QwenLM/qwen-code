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
 * (no marginTop) and keep their natural height (flexShrink 0), so a short
 * region's overflow="hidden" clips them the way ink clips /stats. A
 * shrinkable frame instead lets the renderer squeeze its text rows to zero
 * height and paint them over each other — measured on /stats and /statusline
 * at 80x24 and on /skills at 100x20.
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
});
