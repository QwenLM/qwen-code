/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * ink `QueuedMessageDisplay` parity: the queued prompts, their three-row cap,
 * the overflow row, the hint that fades after three reveals, and the
 * single-line truncation ink gets from `wrap="truncate"`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => {
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
    buildJsxRuntime,
    state: { dimensions: { width: 100, height: 40 } },
  };
});

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

vi.mock('@opentui/react', () => ({
  useTerminalDimensions: () => mocks.state.dimensions,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import { OpenTuiQueuedMessageDisplay } from './queued-message.js';

const queueRows = (messageQueue: readonly string[]): ReactElement => (
  <OpenTuiQueuedMessageDisplay messageQueue={messageQueue} />
);

describe('OpenTuiQueuedMessageDisplay', () => {
  it('renders nothing while the queue is empty', () => {
    const { container } = render(queueRows([]));
    expect(container.textContent).toBe('');
  });

  it('shows each queued prompt on one flattened line', () => {
    const { container } = render(
      queueRows(['first\n  line\ttabbed', 'second']),
    );
    const rows = [...container.querySelectorAll('div > span')];
    expect(rows.map((row) => row.textContent)).toEqual([
      'first line tabbed',
      'second',
      'Ctrl+Q to queue · ↑ to edit queued messages',
    ]);
  });

  it('caps the list at three rows and counts what it folds away', () => {
    const { container } = render(queueRows(['one', 'two', 'three', 'four']));
    const text = container.textContent ?? '';
    expect(text).toContain('three');
    expect(text).not.toContain('four');
    expect(text).toContain('... (+1 more)');
  });

  it('drops the hint once it has been shown three times', () => {
    // ink counts reveals, not renders: the hint fades once the user has seen
    // the queue appear three times.
    const { container, rerender } = render(queueRows([]));
    const oneReveal = () => {
      rerender(queueRows(['queued']));
      const shown = (container.textContent ?? '').includes('Ctrl+Q');
      rerender(queueRows([]));
      return shown;
    };
    expect([1, 2, 3, 4].map(oneReveal)).toEqual([true, true, true, false]);
  });

  it("truncates a prompt to the row's own width, like ink's wrap=truncate", () => {
    mocks.state.dimensions = { width: 22, height: 40 };
    try {
      const { container } = render(queueRows(['q'.repeat(80)]));
      const row = container.querySelector('div > span');
      expect(row?.textContent).toBe(`${'q'.repeat(19)}…`);
    } finally {
      mocks.state.dimensions = { width: 100, height: 40 };
    }
  });

  it('strips terminal escapes from a queued prompt before it reaches the screen', () => {
    // UserRow prints this same string through sanitizeTerminalText once the
    // queue is consumed; the waiting row must not write escapes raw first.
    const { container } = render(queueRows(['\u001b[31mred\u001b[0m']));
    const row = container.querySelector('div > span');
    expect(row?.textContent ?? '').not.toContain('\u001b');
  });
});
