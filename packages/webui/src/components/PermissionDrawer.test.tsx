/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PermissionDrawer,
  type PermissionOption,
  type PermissionToolCall,
} from './PermissionDrawer.js';

const options: PermissionOption[] = [
  { name: 'Allow', kind: 'allow_once', optionId: 'proceed_once' },
  { name: 'Reject', kind: 'reject_once', optionId: 'cancel' },
];

describe('PermissionDrawer', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  function render(toolCall: PermissionToolCall) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <PermissionDrawer
          isOpen={true}
          options={options}
          toolCall={toolCall}
          onResponse={() => {}}
        />,
      );
    });
  }

  it('renders the dedicated Agent prompt when toolName is "agent"', () => {
    render({ toolName: 'agent', kind: 'other', title: 'Run the linter agent' });
    expect(container?.textContent).toContain('Launch this agent?');
  });

  it('falls back to the generic title for non-agent tools', () => {
    render({ kind: 'other', title: 'Some tool' });
    expect(container?.textContent).not.toContain('Launch this agent?');
    expect(container?.textContent).toContain('Some tool');
  });

  it('does not render a review-text block for normal diff-based edits', () => {
    render({
      kind: 'edit',
      title: 'Edit example.ts',
      locations: [{ path: '/repo/example.ts', line: 1 }],
      content: [
        {
          type: 'diff',
          path: '/repo/example.ts',
          originalContent: 'unsafe',
          newContent: 'safe',
        },
      ],
    });

    expect(container?.querySelector('pre')).toBeNull();
    expect(container?.textContent).toContain('Make this edit to');
  });

  it('renders a restricted workflow edit diff carried as review text', () => {
    render({
      kind: 'edit',
      title: 'Edit example.ts',
      locations: [{ path: '/repo/example.ts', line: 1 }],
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: '@@ -1 +1 @@\n-unsafe\n+safe',
          },
        },
      ],
    });

    expect(container?.textContent).toContain('@@ -1 +1 @@');
    expect(container?.textContent).toContain('-unsafe');
    expect(container?.textContent).toContain('+safe');
  });
});
