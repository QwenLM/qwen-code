/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for constructing ToolUseContext instances from pipeline values.
 *
 * Centralises context construction so callers (ToolExecutor,
 * executeToolWithHooks, tests) don't need to remember which fields
 * to thread through.
 */

import type { ToolUseContext } from './tool-types.js';
import { createChildAbortController } from './abort-utils.js';

/**
 * Builds a frozen ToolUseContext. Callers that need child-controller
 * support should include `abortController` in the input.
 */
export function createToolUseContext(opts: ToolUseContext): ToolUseContext {
  return Object.freeze({ ...opts });
}

/**
 * Creates a child ToolUseContext with its own AbortController linked to
 * the parent's signal. Aborting the child does not affect siblings or parent.
 *
 * @returns `{ ctx, cleanup }` — call `cleanup()` when the tool finishes
 *   to remove the parent→child abort listener.
 */
export function createChildToolUseContext(parent: ToolUseContext): {
  ctx: ToolUseContext;
  cleanup: () => void;
} {
  const { controller, cleanup } = createChildAbortController(parent.signal);

  const childCtx: ToolUseContext = Object.freeze({
    ...parent,
    signal: controller.signal,
    abortController: controller,
  });

  return { ctx: childCtx, cleanup };
}
