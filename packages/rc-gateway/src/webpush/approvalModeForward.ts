/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OwnerEventBus } from '../ownerEvents.js';

export interface ApprovalNotifySink {
  notify(
    e: { type: string; data: unknown },
    ctx: { sessionId: string },
  ): Promise<void>;
}

/** Forward a daemon approval_mode_changed frame to the owner stream + notifier. */
export function forwardApprovalModeChange(
  sid: string,
  data: unknown,
  ownerEvents: OwnerEventBus,
  notifier?: ApprovalNotifySink,
): void {
  const d = (data ?? {}) as {
    previous?: unknown;
    next?: unknown;
    persisted?: unknown;
  };
  ownerEvents.publish({
    type: 'approval_mode_changed',
    mode: {
      sessionId: sid,
      previous: typeof d.previous === 'string' ? d.previous : '',
      next: typeof d.next === 'string' ? d.next : '',
      persisted: d.persisted === true,
    },
  });
  void notifier
    ?.notify({ type: 'approval_mode_changed', data }, { sessionId: sid })
    .catch(() => {});
}
