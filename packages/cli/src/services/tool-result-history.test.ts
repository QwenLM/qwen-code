/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { hasToolResultPromptHook } from './tool-result-history.js';

describe('tool-result prompt hook applicability', () => {
  it.each(
    [false, true].flatMap((disabled) =>
      [false, true].flatMap((bus) =>
        [false, true].map((promptHook) => ({ disabled, bus, promptHook })),
      ),
    ),
  )(
    'checks disabled=$disabled bus=$bus UserPromptSubmit=$promptHook',
    ({ disabled, bus, promptHook }) => {
      const hasHooksForEvent = vi.fn(
        (event: string) =>
          event === 'PreToolUse' ||
          (event === 'UserPromptSubmit' && promptHook),
      );
      const config = {
        getDisableAllHooks: () => disabled,
        getMessageBus: () => (bus ? { request: vi.fn() } : undefined),
        hasHooksForEvent,
      } as unknown as Config;
      expect(hasToolResultPromptHook(config)).toBe(
        !disabled && bus && promptHook,
      );
    },
  );
});
