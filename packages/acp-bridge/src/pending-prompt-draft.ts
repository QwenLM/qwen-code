/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BridgePromptRequest } from './bridgeTypes.js';

export type PendingPromptDraft = Pick<BridgePromptRequest, 'prompt' | '_meta'>;

export function pendingPromptDraft(
  request: BridgePromptRequest,
): PendingPromptDraft | undefined {
  // Context is caller-owned business data. Other metadata can carry routing,
  // identity, private capabilities or hidden semantics and is never echoed.
  if (Object.keys(request._meta ?? {}).some((key) => key !== 'context')) {
    return undefined;
  }
  return structuredClone({
    prompt: request.prompt,
    ...(request._meta ? { _meta: request._meta } : {}),
  });
}
