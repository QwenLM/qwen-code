/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { usageCommand } from './usageCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('usageCommand', () => {
  // Like /status, the panel is a dialog: non-interactive runners reject it.
  it('opens the session panel on the usage tab', () => {
    const context = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getActiveModel: vi.fn().mockReturnValue('auto'),
            getSessionId: vi.fn().mockReturnValue('session-1'),
          },
        },
      },
    });

    const result = usageCommand.action?.(context, '');

    expect(result).toMatchObject({ type: 'custom_dialog' });
    const element =
      result && 'component' in result
        ? (result.component as { props: { initialTab: string } })
        : undefined;
    expect(element?.props.initialTab).toBe('usage');
  });
});
