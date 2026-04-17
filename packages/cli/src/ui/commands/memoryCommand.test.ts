/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('memoryCommand', () => {
  it('opens the memory dialog in interactive mode', async () => {
    const context = createMockCommandContext({
      executionMode: 'interactive',
    });

    const result = await memoryCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'memory',
    });
  });

  it('returns a non-interactive fallback message outside the interactive UI', async () => {
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
    });

    const result = await memoryCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'The memory manager is only available in the interactive UI. In non-interactive mode, open the user or project memory files directly.',
    });
  });
});
