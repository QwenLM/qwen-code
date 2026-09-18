/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommandRecordPayload } from '../services/chatRecordingService.js';
import type { GoalRecoveryRecord } from './goal-persistence.js';

/**
 * A running `goal_status` card a build before 2026-07-29 (#7895) journaled
 * inside a `slash_command` record. The runtime does not restore such a Goal;
 * this is what the card still says about it.
 */
export interface LegacyRunningGoalCard {
  condition: string;
  iterations: number;
  /** Absent when no card of this run carried one. */
  setAt?: number;
}

/**
 * The newest running (`set` / `checking`) legacy Goal card, when nothing on
 * the transcript has decided the Goal since.
 *
 * A `goal_state` record newer than any card means a build that journals Goal
 * state owns the Goal from there on, whatever it holds: the runtime restores
 * (or does not) from that record, and the older card is history. A newest
 * card that is terminal (`achieved`, `cleared`, ...) means the legacy run
 * ended. Only when the newest Goal record of either kind is a running card
 * is there a Goal the card claims to be running and nothing driving it.
 *
 * `setAt` is carried from the `set` card that opened the run, since only
 * `set` cards were written with one. The walk back stops at a card of
 * another kind or another condition: two runs can sit back to back with no
 * terminal card between them, and the condition is what identifies the run.
 *
 * Read for presentation only: the session list's label and the trailing
 * card an ACP replay emits so the running card is not the last word.
 */
export function findRunningLegacyGoalCard(
  records: readonly GoalRecoveryRecord[],
): LegacyRunningGoalCard | undefined {
  let running: LegacyRunningGoalCard | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) continue;
    if (running === undefined && record.subtype === 'goal_state') {
      return undefined;
    }
    const cards = legacyGoalCards(record);
    for (let cardIndex = cards.length - 1; cardIndex >= 0; cardIndex -= 1) {
      const card = cards[cardIndex]!;
      if (running === undefined) {
        if (!isRunningKind(card.kind)) return undefined;
        running = {
          condition: card.condition,
          iterations: card.iterations ?? 0,
          ...(card.setAt !== undefined ? { setAt: card.setAt } : {}),
        };
      } else if (
        !isRunningKind(card.kind) ||
        card.condition !== running.condition
      ) {
        return running;
      } else if (card.setAt !== undefined) {
        return { ...running, setAt: card.setAt };
      }
      if (running.setAt !== undefined) return running;
    }
  }
  return running;
}

interface LegacyGoalCard {
  kind: string;
  condition: string;
  iterations?: number;
  setAt?: number;
}

function isRunningKind(kind: string): boolean {
  return kind === 'set' || kind === 'checking';
}

/**
 * The goal cards one record persisted, oldest first. A transcript is a file:
 * the payload and every entry are checked before a field is read.
 */
function legacyGoalCards(record: GoalRecoveryRecord): LegacyGoalCard[] {
  if (record.type !== 'system' || record.subtype !== 'slash_command') {
    return [];
  }
  const payload = record.systemPayload as SlashCommandRecordPayload | undefined;
  if (
    payload?.phase !== 'result' ||
    !Array.isArray(payload.outputHistoryItems)
  ) {
    return [];
  }
  const cards: LegacyGoalCard[] = [];
  for (const item of payload.outputHistoryItems as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (raw['type'] !== 'goal_status') continue;
    const kind = raw['kind'];
    const condition = raw['condition'];
    if (typeof kind !== 'string' || typeof condition !== 'string') continue;
    const iterations = finiteNumber(raw['iterations']);
    const setAt = finiteNumber(raw['setAt']);
    cards.push({
      kind,
      condition,
      ...(iterations !== undefined ? { iterations } : {}),
      ...(setAt !== undefined ? { setAt } : {}),
    });
  }
  return cards;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
