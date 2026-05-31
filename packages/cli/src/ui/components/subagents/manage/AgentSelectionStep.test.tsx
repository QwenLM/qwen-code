/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentConfig } from '@qwen-code/qwen-code-core';
import type {
  KeypressHandler,
  Key,
} from '../../../contexts/KeypressContext.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { AgentSelectionStep } from './AgentSelectionStep.js';

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

const agent = (
  name: string,
  level: SubagentConfig['level'] = 'project',
): SubagentConfig =>
  ({
    name,
    level,
    description: '',
    systemPrompt: '',
  }) as unknown as SubagentConfig;

describe('AgentSelectionStep', () => {
  beforeEach(() => {
    activeKeypressHandler = null;
    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        activeKeypressHandler = handler;
      }
    });
  });

  it('navigates with Ctrl+N/P readline aliases', () => {
    const { lastFrame } = render(
      <AgentSelectionStep
        availableAgents={[agent('first'), agent('second')]}
        onAgentSelect={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('● first');

    pressKey({ name: 'n', sequence: '\u000E', ctrl: true });
    expect(lastFrame()).toContain('● second');

    pressKey({ name: 'p', sequence: '\u0010', ctrl: true });
    expect(lastFrame()).toContain('● first');
  });
});
