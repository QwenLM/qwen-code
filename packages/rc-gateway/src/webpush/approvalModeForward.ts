/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OwnerEventBus } from '../ownerEvents.js';

/**
 * Forward a daemon approval_mode_changed frame to the owner stream ONLY.
 *
 * The push notification for this event is delivered by the pump's standard
 * notify path (`SessionEventPump.runLoop`'s unconditional
 * `await this.notifier?.notify(...)` for every event, pump.ts) plus the
 * `approval_mode_changed` branch in `webpush/payload.ts` /
 * `KIND_SCOPE['session.approval_mode_changed']` in `webpush/notifier.ts` —
 * exactly how every other event type (agent/review/rewind) already works;
 * none of them notify from within `onEvent`. This function must NOT also
 * call `notifier.notify(...)`: doing so double-pushes (verified bug —
 * see the fix commit that removed the `notifier` param from here).
 */
export function forwardApprovalModeChange(
  sid: string,
  data: unknown,
  ownerEvents: OwnerEventBus,
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
}
