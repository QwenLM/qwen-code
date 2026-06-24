/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerStatus } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { ServerDetailStep } from './ServerDetailStep.js';
import type { MCPServerDisplayInfo } from '../types.js';

vi.mock('../../../hooks/useKeypress.js');

const server = (
  overrides: Partial<MCPServerDisplayInfo> = {},
): MCPServerDisplayInfo => ({
  name: 'demo',
  status: MCPServerStatus.CONNECTED,
  source: 'user',
  config: {},
  toolCount: 0,
  promptCount: 0,
  resourceCount: 0,
  isDisabled: false,
  ...overrides,
});

describe('ServerDetailStep — View resources action gating', () => {
  beforeEach(() => {
    vi.mocked(useKeypress).mockImplementation(() => {});
  });

  it('shows "View resources" when a handler is wired and the server has resources', () => {
    const { lastFrame } = render(
      <ServerDetailStep
        server={server({ resourceCount: 2 })}
        onViewTools={vi.fn()}
        onViewResources={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('View resources');
  });

  // Regression: ServerDetailStep is shared with the extensions manager
  // (McpServerActionsView). A caller that doesn't pass onViewResources must NOT
  // get a dead action that does nothing when selected.
  it('hides "View resources" when no handler is wired, even with resources', () => {
    const { lastFrame } = render(
      <ServerDetailStep
        server={server({ resourceCount: 2 })}
        onViewTools={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(lastFrame()).not.toContain('View resources');
  });

  it('hides "View resources" when the server has no resources', () => {
    const { lastFrame } = render(
      <ServerDetailStep
        server={server({ resourceCount: 0 })}
        onViewTools={vi.fn()}
        onViewResources={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(lastFrame()).not.toContain('View resources');
  });

  it('hides "View resources" when the server is disabled', () => {
    const { lastFrame } = render(
      <ServerDetailStep
        server={server({ resourceCount: 2, isDisabled: true })}
        onViewTools={vi.fn()}
        onViewResources={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(lastFrame()).not.toContain('View resources');
  });
});
