/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelMessage } from '../../provider/event/modelCompleteEvent.js';

/**
 * A provider signalled that the model chose to call a tool, but the response
 * contains no structured tool-use block.
 *
 * Keep this predicate provider-agnostic: native and custom-provider
 * transports both converge on ModelMessage before the agent loop.
 */
export function isMalformedToolUseCompletion(
  message: Pick<ModelMessage, 'stopReason' | 'blocks'>,
): boolean {
  return (
    message.stopReason === 'tool_use' &&
    !message.blocks.some((block) => block.type === 'tool_use')
  );
}
