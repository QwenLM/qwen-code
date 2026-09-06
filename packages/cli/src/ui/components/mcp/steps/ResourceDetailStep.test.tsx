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
import { ResourceDetailStep } from './ResourceDetailStep.js';

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

describe('ResourceDetailStep', () => {
  beforeEach(() => {
    activeKeypressHandler = null;
    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        activeKeypressHandler = handler;
      }
    });
  });

  it('renders metadata and the @server:uri reference hint', () => {
    const { lastFrame } = render(
      <ResourceDetailStep
        resource={{
          uri: 'file:///docs/spec.md',
          name: 'Spec',
          description: 'The project spec',
          mimeType: 'text/markdown',
          size: 1234,
          serverName: 'myserver',
        }}
        onBack={vi.fn()}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('file:///docs/spec.md');
    expect(frame).toContain('The project spec');
    expect(frame).toContain('text/markdown');
    // The exact, copy-pasteable reference the user types in chat.
    expect(frame).toContain('@myserver:file:///docs/spec.md');
  });

  it('shows a placeholder when no resource is selected', () => {
    const { lastFrame } = render(
      <ResourceDetailStep resource={null} onBack={vi.fn()} />,
    );
    expect(lastFrame()).toContain('No resource selected');
  });

  it('calls onBack when Escape is pressed', () => {
    const onBack = vi.fn();
    render(
      <ResourceDetailStep
        resource={{ uri: 'file:///a.md', serverName: 'server' }}
        onBack={onBack}
      />,
    );

    pressKey({ name: 'escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders size 0 as "0 bytes" (typeof guard, not a falsy check)', () => {
    const { lastFrame } = render(
      <ResourceDetailStep
        resource={{ uri: 'file:///empty', serverName: 'srv', size: 0 }}
        onBack={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('0 bytes');
  });

  it('omits the Name line when the friendly name equals the URI', () => {
    const { lastFrame } = render(
      <ResourceDetailStep
        resource={{
          uri: 'file:///a.md',
          name: 'file:///a.md', // identical to the URI → redundant, suppressed
          serverName: 'srv',
        }}
        onBack={vi.fn()}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('file:///a.md');
    expect(frame).not.toContain('Name:');
  });

  it('shows the title under Name when it differs from the URI', () => {
    const { lastFrame } = render(
      <ResourceDetailStep
        resource={{
          uri: 'file:///a.md',
          name: 'a',
          title: 'Friendly Title',
          serverName: 'srv',
        }}
        onBack={vi.fn()}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Name:');
    // title is preferred over name for the display label
    expect(frame).toContain('Friendly Title');
  });
});
