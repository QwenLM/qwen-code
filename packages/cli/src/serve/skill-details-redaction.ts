/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  omitAvailableSkillDetails as omitSkillDetailsForSdkSurface,
  type BridgeEvent,
} from '@qwen-code/acp-bridge/eventBus';

export { omitSkillDetailsForSdkSurface };

/**
 * `POST /session/:id/load` embeds the replay snapshot (compacted turns plus
 * the in-flight journal) directly in the response body; apply the same
 * redaction to those frames as the SSE egress does.
 */
export function omitSkillDetailsFromReplayArrays<
  T extends {
    compactedReplay?: BridgeEvent[];
    liveJournal?: BridgeEvent[];
    lifecycleReplay?: BridgeEvent[];
  },
>(session: T): T {
  if (
    !session.compactedReplay &&
    !session.liveJournal &&
    !session.lifecycleReplay
  )
    return session;
  return {
    ...session,
    ...(session.compactedReplay
      ? {
          compactedReplay: session.compactedReplay.map(
            omitSkillDetailsForSdkSurface,
          ),
        }
      : {}),
    ...(session.lifecycleReplay
      ? {
          lifecycleReplay: session.lifecycleReplay.map(
            omitSkillDetailsForSdkSurface,
          ),
        }
      : {}),
    ...(session.liveJournal
      ? {
          liveJournal: session.liveJournal.map(omitSkillDetailsForSdkSurface),
        }
      : {}),
  };
}
