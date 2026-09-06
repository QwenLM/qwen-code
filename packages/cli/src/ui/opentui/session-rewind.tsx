/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink RewindSelector
 * (ui/components/RewindSelector.tsx): the multi-phase rewind flow —
 * pick-list → restore options (file checkpointing on) or legacy Y/N
 * confirm (off) → restoring — with the same scroll window, turn rows,
 * option details, '─' separators, and footer hints. The pure helpers and
 * the state machine are exported for unit testing.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { toOriginalKey } from './key-map.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { truncateText } from '../utils/sessionPickerUtils.js';
import { DialogFrame } from './dialogs-shared.js';
import { REWIND_MAX_VISIBLE_ITEMS } from './session-rewind-model.js';

export type RestoreOption = 'both' | 'conversation' | 'code' | 'cancel';

export { REWIND_MAX_VISIBLE_ITEMS };
export {
  type RewindTurn,
  type RewindDiffStats,
  type RestoreOptionItem,
  isRewindableTurn,
  rewindableTurns,
  rewindScrollWindow,
  type RewindScrollWindow,
  buildRestoreOptions,
  rewindReducer,
  createRewindState,
  type RewindState,
  type RewindPhase,
  type RewindAction,
} from './session-rewind-model.js';

import {
  type RewindTurn,
  type RewindDiffStats,
  rewindableTurns,
  rewindScrollWindow,
  buildRestoreOptions,
  rewindReducer,
  createRewindState,
} from './session-rewind-model.js';

export interface OpentuiRewindSelectorProps {
  turns: readonly RewindTurn[];
  fileCheckpointingEnabled: boolean;
  getDiffStats?: (promptId: string) => Promise<RewindDiffStats | undefined>;
  onRewind: (turn: RewindTurn, option: RestoreOption) => void | Promise<void>;
  onCancel: () => void;
}

export function OpentuiRewindSelector(props: OpentuiRewindSelectorProps) {
  const { turns, fileCheckpointingEnabled, getDiffStats, onRewind, onCancel } =
    props;
  const { width } = useTerminalDimensions();
  const userTurns = rewindableTurns(turns);

  const [state, dispatch] = useReducer(
    rewindReducer,
    userTurns.length,
    createRewindState,
  );
  const [diffStats, setDiffStats] = useState<RewindDiffStats | undefined>(
    undefined,
  );
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const selectedTurn =
    state.selectedTurnIndex === null
      ? null
      : (userTurns[state.selectedTurnIndex] ?? null);
  const restoreOptions = buildRestoreOptions(diffStats);

  useEffect(() => {
    if (state.phase !== 'restore-options' || !selectedTurn) return;
    if (!fileCheckpointingEnabled) return;
    const promptId = selectedTurn.promptId ?? selectedTurn.id;
    if (!getDiffStats) {
      setDiffStats(undefined);
      setLoadingDiff(false);
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    getDiffStats(promptId)
      .then((stats) => {
        if (!cancelled) {
          setDiffStats(stats);
          setLoadingDiff(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffStats(undefined);
          setLoadingDiff(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase, selectedTurn, fileCheckpointingEnabled, getDiffStats]);

  const restoringRef = useRef(false);
  const startRestore = (turn: RewindTurn, option: RestoreOption) => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setIsRestoring(true);
    dispatch({ type: 'begin-restore' });
    Promise.resolve(onRewind(turn, option))
      .catch(() => {
        dispatch({ type: 'restore-error' });
      })
      .finally(() => {
        restoringRef.current = false;
        setIsRestoring(false);
      });
  };

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const isCancelKey =
      original.name === 'escape' || (original.ctrl && original.name === 'c');

    if (state.phase === 'pick') {
      if (isCancelKey) {
        onCancel();
        return;
      }
      if (original.name === 'return') {
        dispatch({
          type: 'enter-pick',
          fileCheckpointingEnabled,
        });
        return;
      }
      if (keyMatchers[Command.SELECTION_UP](original)) {
        dispatch({ type: 'select-up' });
        return;
      }
      if (keyMatchers[Command.SELECTION_DOWN](original)) {
        dispatch({ type: 'select-down' });
      }
      return;
    }

    if (state.phase === 'restore-options') {
      if (isRestoring) return;
      if (isCancelKey) {
        setDiffStats(undefined);
        dispatch({ type: 'back' });
        return;
      }
      if (loadingDiff) return;
      if (original.name === 'return') {
        const option = restoreOptions[state.restoreOptionIndex];
        if (!option || !selectedTurn) return;
        if (option.key === 'cancel') {
          setDiffStats(undefined);
          dispatch({ type: 'back' });
        } else {
          startRestore(selectedTurn, option.key);
        }
        return;
      }
      if (original.name === 'up' || original.name === 'k') {
        dispatch({ type: 'option-up' });
        return;
      }
      if (original.name === 'down' || original.name === 'j') {
        dispatch({
          type: 'option-down',
          optionCount: restoreOptions.length,
        });
      }
      return;
    }

    if (state.phase === 'confirm') {
      if (isRestoring) return;
      if (isCancelKey) {
        dispatch({ type: 'back' });
        return;
      }
      if (
        original.name === 'return' ||
        original.sequence === 'y' ||
        original.sequence === 'Y'
      ) {
        if (selectedTurn) startRestore(selectedTurn, 'conversation');
        return;
      }
      if (original.sequence === 'n' || original.sequence === 'N') {
        dispatch({ type: 'back' });
      }
    }
  });

  const boxWidth = Math.max(20, width - 4);
  // Ink draws a full-width '─' divider below the title and above the
  // footer ('─'.repeat(boxWidth - 2) inside a paddingX=1 border box).
  const separator = '─'.repeat(boxWidth - 4);

  if (userTurns.length === 0) {
    return (
      <DialogFrame>
        <text fg={C.dim}>{t('No user turns to rewind to.')}</text>
      </DialogFrame>
    );
  }

  if (state.phase !== 'pick' && selectedTurn) {
    const promptPreview = truncateText(
      selectedTurn.text || '(empty)',
      boxWidth - 10,
    );

    // Ink keeps showing the legacy confirm while the rewind runs; the
    // reducer collapses both sub-phases into 'restoring', so recover the
    // origin from the checkpointing flag.
    if (
      state.phase === 'confirm' ||
      (state.phase === 'restoring' && !fileCheckpointingEnabled)
    ) {
      return (
        <DialogFrame>
          <text fg={C.text} attributes={1}>
            {t('Rewind Conversation')}
          </text>
          <text fg={C.dim}>{separator}</text>
          <box flexDirection="column">
            <box marginBottom={1} flexDirection="row">
              <text fg={C.text}>{t('Rewind to: ')}</text>
              <text fg={C.accent} attributes={1}>
                {promptPreview}
              </text>
            </box>
            <text fg={C.yellow}>
              {t(
                'This will remove all conversation after this turn. The prompt will be pre-populated in the input for editing.',
              )}
            </text>
          </box>
          <text fg={C.dim}>{separator}</text>
          <text fg={C.dim}>{t('Enter/Y to confirm · Esc/N to go back')}</text>
        </DialogFrame>
      );
    }

    const hasFileOptions = restoreOptions.some(
      (o) => o.key === 'code' || o.key === 'both',
    );
    return (
      <DialogFrame>
        <text fg={C.text} attributes={1}>
          {t('Rewind Conversation')}
        </text>
        <text fg={C.dim}>{separator}</text>
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text fg={C.text}>{t('Rewind to: ')}</text>
            <text fg={C.accent} attributes={1}>
              {promptPreview}
            </text>
          </box>
          {loadingDiff ? (
            <text fg={C.dim}>{t('Computing file changes...')}</text>
          ) : isRestoring ? (
            <text fg={C.dim}>{t('Restoring...')}</text>
          ) : (
            <box flexDirection="column">
              {restoreOptions.map((option, index) => {
                const isSelected = index === state.restoreOptionIndex;
                return (
                  <box key={option.key} flexDirection="row">
                    <text
                      fg={isSelected ? C.accent : C.text}
                      attributes={isSelected ? 1 : undefined}
                    >
                      {isSelected ? '› ' : '  '}
                      {option.label}
                    </text>
                    {option.detail ? (
                      <text fg={C.dim}> {option.detail}</text>
                    ) : null}
                  </box>
                );
              })}
              <box marginTop={1}>
                <text fg={C.dim}>
                  {hasFileOptions
                    ? t(
                        'Rewinding does not affect files edited manually or via shell commands.',
                      )
                    : t(
                        'File restore is unavailable for this turn (no captured file changes, or this turn predates the current session).',
                      )}
                </text>
              </box>
            </box>
          )}
        </box>
        <text fg={C.dim}>{separator}</text>
        <text fg={C.dim}>
          {t('↑↓ to navigate · Enter to select · Esc to go back')}
        </text>
      </DialogFrame>
    );
  }

  const window_ = rewindScrollWindow(
    userTurns.length,
    REWIND_MAX_VISIBLE_ITEMS,
    state.selectedIndex,
  );
  const visibleTurns = userTurns.slice(
    window_.offset,
    window_.offset + window_.visibleCount,
  );

  return (
    <DialogFrame>
      <box flexDirection="row">
        <text fg={C.text} attributes={1}>
          {t('Rewind Conversation')}
        </text>
        <text fg={C.dim}>
          {' '}
          {t('({{count}} turns)', { count: String(userTurns.length) })}
        </text>
      </box>
      <text fg={C.dim}>{separator}</text>
      <box flexDirection="column">
        {visibleTurns.map((turn, visibleIndex) => {
          const actualIndex = window_.offset + visibleIndex;
          const isSelected = actualIndex === state.selectedIndex;
          const isLast = visibleIndex === visibleTurns.length - 1;
          const showUpIndicator = visibleIndex === 0 && window_.showScrollUp;
          const showDownIndicator = isLast && window_.showScrollDown;
          const prefix = isSelected
            ? '› '
            : showUpIndicator
              ? '↑ '
              : showDownIndicator
                ? '↓ '
                : '  ';
          const prefixColor = isSelected
            ? C.accent
            : showUpIndicator || showDownIndicator
              ? C.dim
              : C.text;
          return (
            <box
              key={turn.id}
              flexDirection="row"
              marginBottom={isLast ? 0 : 1}
            >
              <text fg={prefixColor} attributes={isSelected ? 1 : undefined}>
                {prefix}
              </text>
              <text fg={C.dim}>{`#${actualIndex + 1} `}</text>
              <text
                fg={isSelected ? C.accent : C.text}
                attributes={isSelected ? 1 : undefined}
              >
                {truncateText(turn.text || '(empty prompt)', boxWidth - 10)}
              </text>
            </box>
          );
        })}
      </box>
      <text fg={C.dim}>{separator}</text>
      <text fg={C.dim}>
        {t('↑↓ to navigate · Enter to select · Esc to cancel')}
      </text>
    </DialogFrame>
  );
}
