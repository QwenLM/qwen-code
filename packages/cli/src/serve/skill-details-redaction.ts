/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';

/**
 * `available_commands_update` snapshots embed every installed skill's full
 * SKILL.md body under `update._meta.availableSkillDetails` for ACP clients
 * that display or edit skill files (e.g. desktop). The SDK/browser surface
 * (SSE streams and REST responses) only reads the command entries and the
 * `availableSkills` name list, so with many skills installed the bodies are
 * hundreds of kilobytes of dead weight that every browser tab parses and
 * discards on each snapshot (#9234). The `/acp` surface keeps delivering the
 * full snapshot; apply this at every SDK/browser egress point. Frames are
 * shared with other bus subscribers, so reshape immutably instead of
 * mutating.
 */
export function omitSkillDetailsForSdkSurface<
  T extends { type: string; data: unknown },
>(event: T): T {
  if (event.type !== 'session_update') return event;
  const data = asRecord(event.data);
  if (!data) return event;
  // Two documented frame shapes: eventBus-wrapped (`data.update.*`) and
  // persisted-transcript flat (`data.*`); the bridge's
  // `transcriptEventRecordId` accepts both, so the redactor must too.
  const wrapped = asRecord(data['update']);
  const flat = !wrapped && data['sessionUpdate'] !== undefined;
  const candidate = flat ? data : wrapped;
  if (
    !candidate ||
    candidate['sessionUpdate'] !== 'available_commands_update'
  ) {
    return event;
  }
  const meta = asRecord(candidate['_meta']);
  if (!meta || !('availableSkillDetails' in meta)) return event;
  const trimmedMeta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key !== 'availableSkillDetails') trimmedMeta[key] = value;
  }
  const nextCandidate: Record<string, unknown> = { ...candidate };
  if (Object.keys(trimmedMeta).length > 0) {
    nextCandidate['_meta'] = trimmedMeta;
  } else {
    delete nextCandidate['_meta'];
  }
  if (flat) return { ...event, data: nextCandidate };
  return { ...event, data: { ...data, update: nextCandidate } };
}

/**
 * `POST /session/:id/load` embeds the replay snapshot (compacted turns plus
 * the in-flight journal) directly in the response body; apply the same
 * redaction to those frames as the SSE egress does.
 */
export function omitSkillDetailsFromReplayArrays<
  T extends {
    compactedReplay?: BridgeEvent[];
    liveJournal?: BridgeEvent[];
  },
>(session: T): T {
  if (!session.compactedReplay && !session.liveJournal) return session;
  return {
    ...session,
    ...(session.compactedReplay
      ? {
          compactedReplay: session.compactedReplay.map(
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
