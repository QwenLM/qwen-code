/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeRestoreSessionRequest } from '@qwen-code/acp-bridge/bridgeTypes';

export function restoreSessionTitleFields(
  displayName: string | undefined,
  titleSource: BridgeRestoreSessionRequest['titleSource'],
): Pick<BridgeRestoreSessionRequest, 'displayName' | 'titleSource'> {
  return displayName
    ? {
        displayName,
        ...(titleSource !== undefined ? { titleSource } : {}),
      }
    : {};
}
