/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KeypressHandler,
  Key,
} from '../../../contexts/KeypressContext.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { ResourceListStep } from './ResourceListStep.js';
import type { MCPResourceDisplayInfo } from '../types.js';

vi.mock('../../../hooks/useKeypress.js');

let activeKeypressHandler: KeypressHandler | null = null;

const createKey = (overrides: Partial<Key>): Key => ({
  name: '',
  sequence: '',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  ...overrides,
});

const pressKey = (overrides: Partial<Key>) => {
  if (!activeKeypressHandler) {
    throw new Error('No active keypress handler');
  }
  const handler = activeKeypressHandler;
  act(() => {
    handler(createKey(overrides));
  });
};

const resource = (
  uri: string,
  extra: Partial<MCPResourceDisplayInfo> = {},
): MCPResourceDisplayInfo => ({
  uri,
  serverName: 'server',
  ...extra,
});

describe('ResourceListStep', () => {
  beforeEach(() => {
    activeKeypressHandler = null;
    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        activeKeypressHandler = handler;
      }
    });
  });

  it('lists resource URIs and a friendly name when it differs from the URI', () => {
    const { lastFrame } = render(
      <ResourceListStep
        resources={[
          resource('file:///a.md', { title: 'Spec A' }),
          resource('file:///b.md'),
        ]}
        serverName="server"
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('file:///a.md');
    expect(frame).toContain('Spec A');
    expect(frame).toContain('file:///b.md');
  });

  it('navigates with Ctrl+N/P and selects the highlighted resource', () => {
    const onSelect = vi.fn();
    const { lastFrame } = render(
      <ResourceListStep
        resources={[
          resource('file:///first.md'),
          resource('file:///second.md'),
        ]}
        serverName="server"
        onSelect={onSelect}
        onBack={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('❯ file:///first.md');

    pressKey({ name: 'n', sequence: '', ctrl: true });
    expect(lastFrame()).toContain('❯ file:///second.md');

    pressKey({ name: 'return' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'file:///second.md' }),
    );
  });

  it('calls onBack when Escape is pressed', () => {
    const onBack = vi.fn();
    render(
      <ResourceListStep
        resources={[resource('file:///a.md')]}
        serverName="server"
        onSelect={vi.fn()}
        onBack={onBack}
      />,
    );

    pressKey({ name: 'escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-state message when there are no resources', () => {
    const { lastFrame } = render(
      <ResourceListStep
        resources={[]}
        serverName="server"
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('No resources available for this server.');
  });

  // Exercises the scroll-window path that only runs for >VISIBLE_RESOURCES_COUNT
  // (10) items — the most non-trivial logic in the component, otherwise untested.
  it('windows a long list with correct count + arrow indicators', () => {
    const resources = Array.from({ length: 15 }, (_, i) =>
      resource(`file:///r${String(i).padStart(2, '0')}.md`),
    );
    const { lastFrame } = render(
      <ResourceListStep
        resources={resources}
        serverName="server"
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    // Top of the list: first 10 rows visible (r00–r09), the rest hidden;
    // indicator "1/15" with a trailing ↓ and no leading ↑.
    let frame = lastFrame()!;
    expect(frame).toContain('file:///r00.md');
    expect(frame).toContain('file:///r09.md');
    expect(frame).not.toContain('file:///r10.md');
    expect(frame).not.toContain('file:///r14.md');
    expect(frame).toContain('1/15');
    expect(frame).toContain('↓');
    expect(frame).not.toContain('↑');

    // Page to the bottom (14 downs → last item selected): window shifts so the
    // tail is visible, the head scrolls off, indicator reads "15/15" with a
    // leading ↑ and no trailing ↓.
    for (let i = 0; i < 14; i++) {
      pressKey({ name: 'down', shift: false });
    }
    frame = lastFrame()!;
    expect(frame).toContain('file:///r14.md');
    expect(frame).not.toContain('file:///r00.md');
    expect(frame).toContain('15/15');
    expect(frame).toContain('↑');
    expect(frame).not.toContain('↓');
  });
});
