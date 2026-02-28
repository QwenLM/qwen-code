/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt Enhancement Middleware Placeholder
 *
 * The actual implementation is in @qwen-code/prompt-enhancer package.
 * This file exists for API compatibility.
 *
 * For usage, import directly from @qwen-code/prompt-enhancer:
 *
 * ```typescript
 * import { PromptEnhancer } from '@qwen-code/prompt-enhancer';
 *
 * const enhancer = new PromptEnhancer({ level: 'standard' });
 * const result = await enhancer.enhance('Fix the bug');
 * ```
 */

export type PromptMiddlewareContext = {
  projectRoot: string;
  mode?: string;
  enabled?: boolean;
  level?: 'minimal' | 'standard' | 'maximal';
};

export function createPromptEnhancementMiddleware(): {
  process: (prompt: string) => Promise<string>;
  isEnabled: () => boolean;
  enable: () => void;
  disable: () => void;
} {
  return {
    process: async (prompt: string) => prompt,
    isEnabled: () => false,
    enable: () => {},
    disable: () => {},
  };
}
