/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionListItem } from '@qwen-code/qwen-code-core';

export type FleetSessionStatus = 'active' | 'idle' | 'backgrounded';

export interface FleetSessionEntry extends SessionListItem {
  status: FleetSessionStatus;
  displayName: string;
}

export function toFleetEntry(
  item: SessionListItem,
  currentSessionId: string | null,
): FleetSessionEntry {
  let status: FleetSessionStatus = 'idle';
  if (item.sessionId === currentSessionId) {
    status = 'active';
  }

  const displayName =
    item.customTitle ||
    (item.prompt
      ? item.prompt.length > 60
        ? item.prompt.slice(0, 57) + '...'
        : item.prompt
      : item.sessionId.slice(0, 8));

  return { ...item, status, displayName };
}
