/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure half of the OpenTUI rewind parity (ink RewindSelector): turn
 * filtering, the pick-list scroll window, the restore-option list, and the
 * pick → restore-options/confirm → restoring state machine. Kept free of
 * JSX so the interaction parity is unit-testable without a renderer.
 */

import { t } from '../../i18n/index.js';
import { isSlashCommand } from '../utils/commandUtils.js';
import { isUserTextContent } from '../utils/historyMapping.js';
import { getStartupContextLength } from '@qwen-code/qwen-code-core';
import type { Content } from '@google/genai';

export const REWIND_MAX_VISIBLE_ITEMS = 7;

export interface RewindTurn {
  id: string;
  text: string;
  promptId?: string;
  sentToModel?: boolean;
}

/** Parity of historyMapping.isRealUserTurn for neutral history items. */
export function isRewindableTurn(turn: RewindTurn): boolean {
  if (!turn.text) return false;
  if (typeof turn.sentToModel === 'boolean') return turn.sentToModel;
  return !isSlashCommand(turn.text) && !turn.text.startsWith('?');
}

export function rewindableTurns(turns: readonly RewindTurn[]): RewindTurn[] {
  return turns.filter(isRewindableTurn);
}

/**
 * Locates the API-history cut point for conversation rewind positionally
 * (ink `computeApiTruncationIndex` parity): the index of the
 * `occurrence`-th real user prompt, skipping startup-context and
 * tool-result entries. Never matches on text, so projected-transcript
 * decorations (attachment suffixes, compression) cannot break the match.
 * Returns -1 when the history holds fewer real user prompts than
 * requested (e.g. the turn was absorbed by chat compression).
 */
export function rewindApiCutPoint(
  apiHistory: Content[],
  occurrence: number,
): number {
  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });
  let seen = 0;
  for (let idx = startIndex; idx < apiHistory.length; idx++) {
    if (!isUserTextContent(apiHistory[idx]!)) continue;
    seen += 1;
    if (seen === occurrence) return idx;
  }
  return -1;
}

export interface RewindScrollWindow {
  offset: number;
  visibleCount: number;
  showScrollUp: boolean;
  showScrollDown: boolean;
}

/** Parity of the RewindSelector pick-list scroll offset computation. */
export function rewindScrollWindow(
  total: number,
  maxVisibleCap: number,
  selectedIndex: number,
): RewindScrollWindow {
  const visibleCount = Math.min(Math.max(0, maxVisibleCap), Math.max(0, total));
  if (total <= visibleCount) {
    return {
      offset: 0,
      visibleCount,
      showScrollUp: false,
      showScrollDown: false,
    };
  }
  const halfVisible = Math.floor(visibleCount / 2);
  let offset = selectedIndex - halfVisible;
  offset = Math.max(0, offset);
  offset = Math.min(total - visibleCount, offset);
  return {
    offset,
    visibleCount,
    showScrollUp: offset > 0,
    showScrollDown: offset + visibleCount < total,
  };
}

/** Structural parity of core DiffStats (the fields RewindSelector reads). */
export interface RewindDiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface RestoreOptionItem {
  key: 'both' | 'conversation' | 'code' | 'cancel';
  label: string;
  detail?: string;
}

/** Parity of RewindSelector.getRestoreOptions. */
export function buildRestoreOptions(
  diffStats: RewindDiffStats | undefined,
): RestoreOptionItem[] {
  const hasChanges = !!diffStats && diffStats.filesChanged.length > 0;
  const options: RestoreOptionItem[] = [];

  if (hasChanges) {
    const fileCount = diffStats!.filesChanged.length;
    const detail = t(
      fileCount === 1
        ? '(+{{insertions}} -{{deletions}} in {{count}} file)'
        : '(+{{insertions}} -{{deletions}} in {{count}} files)',
      {
        insertions: String(diffStats!.insertions),
        deletions: String(diffStats!.deletions),
        count: String(fileCount),
      },
    );
    options.push({
      key: 'both',
      label: t('Restore code and conversation'),
      detail,
    });
  }

  options.push({
    key: 'conversation',
    label: t('Restore conversation only'),
  });

  if (hasChanges) {
    options.push({
      key: 'code',
      label: t('Restore code only'),
    });
  }

  options.push({
    key: 'cancel',
    label: t('Never mind'),
  });

  return options;
}

export type RewindPhase = 'pick' | 'restore-options' | 'confirm' | 'restoring';

export interface RewindState {
  phase: RewindPhase;
  turnCount: number;
  selectedIndex: number;
  selectedTurnIndex: number | null;
  restoreOptionIndex: number;
}

export type RewindAction =
  | { type: 'select-up' }
  | { type: 'select-down' }
  | { type: 'enter-pick'; fileCheckpointingEnabled: boolean }
  | { type: 'option-up' }
  | { type: 'option-down'; optionCount: number }
  | { type: 'back' }
  | { type: 'begin-restore' }
  | { type: 'restore-error' };

/** Ink starts the pick list on the most recent turn. */
export function createRewindState(turnCount: number): RewindState {
  return {
    phase: 'pick',
    turnCount,
    selectedIndex: Math.max(0, Math.floor(turnCount) - 1),
    selectedTurnIndex: null,
    restoreOptionIndex: 0,
  };
}

export function rewindReducer(
  state: RewindState,
  action: RewindAction,
): RewindState {
  switch (action.type) {
    case 'select-up': {
      if (state.phase !== 'pick') return state;
      return { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) };
    }
    case 'select-down': {
      if (state.phase !== 'pick') return state;
      return {
        ...state,
        selectedIndex: Math.min(state.turnCount - 1, state.selectedIndex + 1),
      };
    }
    case 'enter-pick': {
      if (state.phase !== 'pick' || state.turnCount === 0) return state;
      return {
        ...state,
        phase: action.fileCheckpointingEnabled ? 'restore-options' : 'confirm',
        selectedTurnIndex: state.selectedIndex,
        restoreOptionIndex: 0,
      };
    }
    case 'option-up': {
      if (state.phase !== 'restore-options') return state;
      return {
        ...state,
        restoreOptionIndex: Math.max(0, state.restoreOptionIndex - 1),
      };
    }
    case 'option-down': {
      if (state.phase !== 'restore-options') return state;
      return {
        ...state,
        restoreOptionIndex: Math.min(
          Math.max(0, action.optionCount - 1),
          state.restoreOptionIndex + 1,
        ),
      };
    }
    case 'back': {
      if (state.phase === 'pick' || state.phase === 'restoring') return state;
      return {
        ...state,
        phase: 'pick',
        selectedTurnIndex: null,
        restoreOptionIndex: 0,
      };
    }
    case 'begin-restore': {
      if (state.phase === 'pick' || state.phase === 'restoring') return state;
      return { ...state, phase: 'restoring' };
    }
    case 'restore-error': {
      if (state.phase !== 'restoring') return state;
      return {
        ...state,
        phase: 'pick',
        selectedTurnIndex: null,
        restoreOptionIndex: 0,
      };
    }
    default:
      return state;
  }
}
