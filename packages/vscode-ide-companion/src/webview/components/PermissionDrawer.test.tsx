/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '../test-utils/render.js';
import { PermissionDrawer } from '@qwen-code/webui';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';

const options: PermissionOption[] = [
  { name: 'Allow once', kind: 'allow_once', optionId: 'allow_once' },
  { name: 'Reject', kind: 'reject', optionId: 'reject' },
];

const toolCall: PermissionToolCall = {
  kind: 'edit',
  title: 'Edit file',
  locations: [{ path: '/repo/src/file.ts' }],
};

describe('PermissionDrawer (webview)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders affected file name for edit tool calls', () => {
    const { container } = render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('file.ts');
  });

  it('selects option on number key press', () => {
    const onResponse = vi.fn();
    render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={onResponse}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });

    expect(onResponse).toHaveBeenCalledWith('allow_once');
  });

  it('rejects and closes on Escape', () => {
    const onResponse = vi.fn();
    const onClose = vi.fn();
    render(
      <PermissionDrawer
        isOpen
        options={options}
        toolCall={toolCall}
        onResponse={onResponse}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onResponse).toHaveBeenCalledWith('reject');
    expect(onClose).toHaveBeenCalled();
  });
});
