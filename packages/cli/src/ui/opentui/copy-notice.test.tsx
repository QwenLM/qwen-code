/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CopyNoticeToast } from './copy-notice.js';

const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) => {
    const config = key === undefined ? props : { ...props, key };
    const children = config?.['children'] as React.ReactNode;
    const { children: _children, ...rest } = config ?? {};
    if (type === 'box' || type === 'text') {
      return React.createElement(
        type === 'box' ? 'div' : 'span',
        rest,
        children,
      );
    }
    return React.createElement(
      type as React.ElementType,
      { ...rest, ...(key === undefined ? {} : { key }) },
      children,
    );
  };
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
});

vi.mock('@opentui/react/jsx-runtime', () => buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildJsxRuntime());
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyNoticeToast', () => {
  it('shows the copied character count', () => {
    render(
      <CopyNoticeToast
        notice={{ id: 1, text: 'abcde' }}
        bottom={3}
        onExpire={vi.fn()}
      />,
    );
    expect(screen.getByText(/Copied 5 chars/)).toBeTruthy();
  });

  it('expires after two seconds', () => {
    const onExpire = vi.fn();
    render(
      <CopyNoticeToast
        notice={{ id: 7, text: 'abc' }}
        bottom={3}
        onExpire={onExpire}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onExpire).toHaveBeenCalledWith(7);
  });

  it('renders nothing without a notice', () => {
    const { container } = render(
      <CopyNoticeToast notice={null} bottom={3} onExpire={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
