/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from 'react';
import { RGBA, TextAttributes } from '@opentui/core';
import { OpenTuiVoiceIndicator } from './OpenTuiVoiceIndicator.js';

const viewport = vi.hoisted(() => ({ width: 80, height: 24 }));
vi.mock('@opentui/react', () => ({ useTerminalDimensions: () => viewport }));
beforeEach(() => {
  viewport.width = 80;
});

const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) =>
    React.createElement(
      type as React.ElementType,
      key === undefined ? props : { ...props, key },
    );
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
});
vi.mock('@opentui/react/jsx-runtime', buildJsxRuntime);
vi.mock('@opentui/react/jsx-dev-runtime', buildJsxRuntime);

type NativeElement = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): NativeElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props['children'] as ReactNode)];
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement<Record<string, unknown>>(node)
    ? text(node.props['children'] as ReactNode)
    : '';
}

function project(
  props: Parameters<typeof OpenTuiVoiceIndicator>[0],
): ReactNode {
  return OpenTuiVoiceIndicator(props) as unknown as ReactNode;
}

function indexedColor(node: NativeElement | undefined, slot: number) {
  expect(node).toBeDefined();
  const color = node!.props['fg'];
  expect(color).toBeInstanceOf(RGBA);
  expect((color as RGBA).intent).toBe('indexed');
  expect((color as RGBA).slot).toBe(slot);
}

describe('OpenTUI voice indicator declaration parity', () => {
  it('renders nothing when idle', () => {
    expect(project({ status: 'idle' })).toBeNull();
  });

  it.each([
    { name: 'absent', level: undefined, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'zero', level: 0, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'negative', level: -1, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'NaN', level: Number.NaN, expected: '░░░░░░░░░░░░░░░░' },
    {
      name: 'positive infinity',
      level: Infinity,
      expected: '░░░░░░░░░░░░░░░░',
    },
    {
      name: 'negative infinity',
      level: -Infinity,
      expected: '░░░░░░░░░░░░░░░░',
    },
    { name: 'half', level: 0.041666666666666664, expected: '████████░░░░░░░░' },
    { name: 'full', level: 1, expected: '████████████████' },
    { name: 'above full', level: 2, expected: '████████████████' },
  ])('shows the independent $name meter expectation', ({ level, expected }) => {
    const output = text(project({ status: 'recording', audioLevel: level }));
    expect(output).toContain(expected);
    expect(output).toContain('listening…');
  });

  it.each([
    { status: 'transcribing', expected: '◆ transcribing…' },
    { status: 'refining', expected: '◆ refining…' },
  ] as const)(
    'distinguishes $status from recording',
    ({ status, expected }) => {
      const output = text(project({ status }));
      expect(output).toBe(expected);
      expect(output).not.toContain('listening…');
    },
  );

  it.each([
    { status: 'transcribing', expected: '◆ transcrib\ning…' },
    { status: 'refining', expected: '◆ refining…' },
  ] as const)(
    'keeps Ink line boundaries for $status at 12 columns',
    ({ status, expected }) => {
      viewport.width = 12;
      expect(text(project({ status }))).toBe(expected);
    },
  );

  it('escapes interim terminal controls before projection', () => {
    const output = text(
      project({
        status: 'recording',
        interimText: 'partial\x1b[8m hidden\x1b[0m',
      }),
    );
    expect(output).toContain('partial\\u001b[8m hidden\\u001b[0m');
    expect(output).not.toContain('\x1b');
  });

  it('keeps Ink ANSI palette intent rather than only approximating its RGB values', () => {
    const nodes = elements(
      project({ status: 'recording', interimText: 'OWNED_PARTIAL' }),
    );
    indexedColor(
      nodes.find((node) => node.type === 'span' && text(node) === '● '),
      9,
    );
    indexedColor(
      nodes.find(
        (node) => node.type === 'span' && text(node) === '░░░░░░░░░░░░░░░░',
      ),
      6,
    );
    indexedColor(
      nodes.find(
        (node) => node.type === 'span' && text(node) === '  listening…',
      ),
      8,
    );
    for (const status of ['transcribing', 'refining'] as const) {
      indexedColor(
        elements(project({ status })).find((node) => node.type === 'span'),
        3,
      );
    }
  });

  it('dims the interim text without forcing a foreground color, like Ink', () => {
    const row = elements(
      project({ status: 'recording', interimText: 'OWNED_PARTIAL' }),
    ).find((node) => node.type === 'text' && text(node) === 'OWNED_PARTIAL');
    expect(row).toBeDefined();
    expect(row!.props['fg']).toBeUndefined();
    expect((Number(row!.props['attributes']) || 0) & TextAttributes.DIM).toBe(
      TextAttributes.DIM,
    );
  });

  it('declares an ellipsized single-line interim row under the same narrow parent', () => {
    viewport.width = 12;
    const long = 'ABCDEFGHIJKLMNOPQRST';
    const parent = createElement(
      'box',
      { width: 12 },
      project({ status: 'transcribing', interimText: long }),
    );
    expect(parent.props.width).toBe(12);
    const row = elements(parent).find(
      (node) => node.type === 'text' && text(node) === 'ABCDEFGHIJ…',
    );
    expect(row).toBeDefined();
    expect(row!.props['wrapMode']).toBe('none');
    // Actual native paint is verified separately; this asserts the row's text.
    expect(text(row)).toBe('ABCDEFGHIJ…');
  });
});
