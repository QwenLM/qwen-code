/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { fireEvent } from '@testing-library/dom';
import { PermissionDrawer } from './PermissionDrawer.js';
import type {
  PermissionOption,
  PermissionToolCall,
} from './PermissionDrawer.js';

const render = (ui: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const baseOptions: PermissionOption[] = [
  { name: 'Allow once', kind: 'allow_once', optionId: 'allow_once' },
  { name: 'Reject', kind: 'reject', optionId: 'reject' },
];

const baseToolCall: PermissionToolCall = {
  kind: 'edit',
  title: 'Edit file',
  locations: [{ path: '/repo/src/file.ts' }],
};

describe('PermissionDrawer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render when closed', () => {
    const { container, unmount } = render(
      <PermissionDrawer
        isOpen={false}
        options={baseOptions}
        toolCall={baseToolCall}
        onResponse={vi.fn()}
      />,
    );

    expect(container.textContent).toBe('');
    unmount();
  });

  it('renders the affected file name for edits', () => {
    const { container, unmount } = render(
      <PermissionDrawer
        isOpen
        options={baseOptions}
        toolCall={baseToolCall}
        onResponse={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('file.ts');
    unmount();
  });

  it('selects the first option on number key press', () => {
    const onResponse = vi.fn();
    const { unmount } = render(
      <PermissionDrawer
        isOpen
        options={baseOptions}
        toolCall={baseToolCall}
        onResponse={onResponse}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });

    expect(onResponse).toHaveBeenCalledWith('allow_once');
    unmount();
  });

  it('rejects and closes on Escape', () => {
    const onResponse = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <PermissionDrawer
        isOpen
        options={baseOptions}
        toolCall={baseToolCall}
        onResponse={onResponse}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onResponse).toHaveBeenCalledWith('reject');
    expect(onClose).toHaveBeenCalled();
    unmount();
  });
});
