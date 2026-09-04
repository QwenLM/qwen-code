/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, DebugLogger } from '@qwen-code/qwen-code-core';

export function fireSessionDeleteHook(
  config: Config,
  sessionId: string,
  logger: DebugLogger = config.getDebugLogger(),
): void {
  void config
    .getHookSystem()
    ?.fireSessionDeleteEvent(sessionId)
    .catch((error) => {
      logger.warn(
        `SessionDelete hook failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}
