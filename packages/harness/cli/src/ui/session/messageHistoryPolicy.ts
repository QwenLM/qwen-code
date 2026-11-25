/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionMessageSource } from '../../session/sessionPort.js';

/** CLI history selection, derived from message-source facts. */
export interface MessageHistoryPolicy {
  preferDisplayEvents: boolean;
  allowDurableDisplayFallback: boolean;
}

export function getMessageHistoryPolicy(
  source: SessionMessageSource,
): MessageHistoryPolicy {
  return {
    preferDisplayEvents: source.hasDisplayHistory,
    allowDurableDisplayFallback:
      source.delivery === 'recovery' && !source.hasDisplayHistory,
  };
}
