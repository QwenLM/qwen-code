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
});
