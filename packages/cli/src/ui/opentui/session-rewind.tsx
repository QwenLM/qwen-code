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
import { getCachedStringWidth, truncateToWidth } from '../utils/textUtils.js';
import { truncateText } from '../utils/sessionPickerUtils.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import { DialogFrame, dialogContentWidth } from './dialogs-shared.js';
import { chromeRows, scrollDialogLayout, wrappedRows } from './dialogs-core.js';
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
  stepRestoreOption,
} from './session-rewind-model.js';

export interface OpentuiRewindSelectorProps {
  turns: readonly RewindTurn[];
  availableTerminalHeight?: number;
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
  const contentWidth = dialogContentWidth(width);
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);

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
  const picking = state.phase === 'pick';
  const legacyConfirm =
    state.phase === 'confirm' ||
    (state.phase === 'restoring' && !fileCheckpointingEnabled);
  const title = t('Rewind Conversation');
  const footer = picking
    ? t('↑↓ to navigate · Enter to select · Esc to cancel')
    : legacyConfirm
      ? t('Enter/Y to confirm · Esc/N to go back')
      : t('↑↓ to navigate · Enter to select · Esc to go back');
  const preview = `${t('Rewind to: ')}${truncateText(selectedTurn?.text || '(empty)', contentWidth)}`;
  const warning = legacyConfirm
    ? t(
        'This will remove all conversation after this turn. The prompt will be pre-populated in the input for editing.',
      )
    : restoreOptions.some(
          (option) => option.key === 'code' || option.key === 'both',
        )
      ? t(
          'Rewinding does not affect files edited manually or via shell commands.',
        )
      : t(
          'File restore is unavailable for this turn (no captured file changes, or this turn predates the current session).',
        );
  const optionPhase = !picking && !legacyConfirm;
  const layout = scrollDialogLayout(
    regionHeight,
    chromeRows({
      fixed: picking ? 6 : 8,
      runs: [
        { text: truncateToWidth(title, contentWidth), width: contentWidth },
        { text: truncateToWidth(footer, contentWidth), width: contentWidth },
        ...(!picking
          ? [
              {
                text: truncateToWidth(preview, contentWidth),
                width: contentWidth,
              },
            ]
          : []),
        ...(optionPhase ? [{ text: warning, width: contentWidth }] : []),
      ],
    }),
    picking
      ? Math.max(
          0,
          Math.min(REWIND_MAX_VISIBLE_ITEMS, userTurns.length) * 2 - 1,
        )
      : legacyConfirm
        ? wrappedRows(warning, contentWidth)
        : loadingDiff || isRestoring
          ? 1
          : restoreOptions.length,
  );
  const bodyRows =
    (props.availableTerminalHeight ?? 1) <= 0 || contentWidth <= 0
      ? 0
      : Math.max(0, Math.floor(layout.bodyRows));
  const previewLabel =
    legacyConfirm && layout.compact ? `${title}: ` : t('Rewind to: ');
  const promptPreview = truncateText(
    selectedTurn?.text || '(empty)',
    Math.max(0, contentWidth - getCachedStringWidth(previewLabel)),
  );
  const previewPaint = (
    <>
      <text fg={C.text}>{truncateToWidth(previewLabel, contentWidth)}</text>
      <text fg={C.accent} attributes={1}>
        {promptPreview}
      </text>
    </>
  );
  const hasPaintedLabel = (label: string, source: string) =>
    label.trim().length > 0 &&
    (label === source.split(/\r?\n/, 1)[0] ||
      !/^(?:…|\.{3})+$/.test(label.trim()));
  const canConfirm =
    bodyRows > 0 &&
    hasPaintedLabel(promptPreview, selectedTurn?.text || '(empty)') &&
    getCachedStringWidth(previewLabel) < contentWidth;
  const pickWindow = rewindScrollWindow(
    userTurns.length,
    Math.min(
      REWIND_MAX_VISIBLE_ITEMS,
      layout.compact ? bodyRows : Math.floor((bodyRows + 1) / 2),
    ),
    state.selectedIndex,
  );
  const optionWindow = rewindScrollWindow(
    restoreOptions.length,
    bodyRows,
    state.restoreOptionIndex,
  );
  const pickLabel = (index: number) =>
    truncateText(
      userTurns[index]?.text || '(empty prompt)',
      Math.max(0, contentWidth - 2 - getCachedStringWidth(`#${index + 1} `)),
    );
  const optionLabel = (index: number) =>
    truncateToWidth(
      restoreOptions[index]?.label ?? '',
      Math.max(0, contentWidth - 2),
    );
  // The renderer gives every key of one burst to the handler the last render
  // registered, so Enter must not read the reducer's pre-burst index: an
  // arrow auto-repeat followed by Enter would restore the wrong thing. The
  // handler advances this itself and the render below keeps it in step with
  // the resets the reducer performs.
  const pickIndexRef = useRef(state.selectedIndex);
  pickIndexRef.current = state.selectedIndex;
  const restoreOptionRef = useRef(state.restoreOptionIndex);
  restoreOptionRef.current = state.restoreOptionIndex;

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
        if (
          pickIndexRef.current < pickWindow.offset ||
          pickIndexRef.current >= pickWindow.offset + pickWindow.visibleCount ||
          !hasPaintedLabel(
            pickLabel(pickIndexRef.current),
            userTurns[pickIndexRef.current]?.text || '(empty prompt)',
          )
        )
          return;
        dispatch({
          type: 'enter-pick',
          fileCheckpointingEnabled,
        });
        return;
      }
      if (keyMatchers[Command.SELECTION_UP](original)) {
        pickIndexRef.current = Math.max(0, pickIndexRef.current - 1);
        dispatch({ type: 'select-up' });
        return;
      }
      if (keyMatchers[Command.SELECTION_DOWN](original)) {
        pickIndexRef.current = Math.min(
          userTurns.length - 1,
          pickIndexRef.current + 1,
        );
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
        if (
          restoreOptionRef.current < optionWindow.offset ||
          restoreOptionRef.current >=
            optionWindow.offset + optionWindow.visibleCount ||
          !hasPaintedLabel(
            optionLabel(restoreOptionRef.current),
            restoreOptions[restoreOptionRef.current]?.label ?? '',
          )
        )
          return;
        const option = restoreOptions[restoreOptionRef.current];
        if (!option || !selectedTurn) return;
        if (option.key === 'cancel') {
          setDiffStats(undefined);
          dispatch({ type: 'back' });
        } else {
          startRestore(selectedTurn, option.key);
        }
        return;
      }
      const stepOption = (delta: -1 | 1) => {
        restoreOptionRef.current = stepRestoreOption(
          restoreOptionRef.current,
          delta,
          restoreOptions.length,
        );
        dispatch({
          type: delta === -1 ? 'option-up' : 'option-down',
          optionCount: restoreOptions.length,
        });
      };
      if (original.name === 'up' || original.name === 'k') {
        stepOption(-1);
        return;
      }
      if (original.name === 'down' || original.name === 'j') {
        stepOption(1);
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
        if (selectedTurn && canConfirm)
          startRestore(selectedTurn, 'conversation');
        return;
      }
      if (original.sequence === 'n' || original.sequence === 'N') {
        dispatch({ type: 'back' });
      }
    }
  });

  const separator = '─'.repeat(contentWidth);
  if (userTurns.length === 0) {
    return (
      <DialogFrame bodyLayout={scrollDialogLayout(regionHeight, 4, 1)}>
        <text fg={C.dim}>
          {truncateToWidth(t('No user turns to rewind to.'), contentWidth)}
        </text>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame bodyLayout={layout}>
      {!layout.compact && (
        <>
          <box flexDirection="row">
            <text fg={C.text} attributes={1}>
              {truncateToWidth(title, contentWidth)}
            </text>
            {picking && (
              <text fg={C.dim}>
                {truncateToWidth(
                  ` ${t('({{count}} turns)', { count: String(userTurns.length) })}`,
                  Math.max(0, contentWidth - getCachedStringWidth(title)),
                )}
              </text>
            )}
          </box>
          <text fg={C.borderDefault}>{separator}</text>
          {!picking && (
            <box marginBottom={1} flexDirection="row">
              {previewPaint}
            </box>
          )}
        </>
      )}
      <box
        height={bodyRows}
        flexShrink={0}
        overflow="hidden"
        flexDirection="column"
      >
        {picking ? (
          userTurns
            .slice(
              pickWindow.offset,
              pickWindow.offset + pickWindow.visibleCount,
            )
            .map((turn, index, visible) => {
              const actualIndex = pickWindow.offset + index;
              const selected = actualIndex === state.selectedIndex;
              const last = index === visible.length - 1;
              const prefix = selected
                ? '› '
                : index === 0 && pickWindow.showScrollUp
                  ? '↑ '
                  : last && pickWindow.showScrollDown
                    ? '↓ '
                    : '  ';
              const number = `#${actualIndex + 1} `;
              return (
                <box
                  key={turn.id}
                  flexDirection="row"
                  marginBottom={last || layout.compact ? 0 : 1}
                >
                  <text
                    fg={selected ? C.accent : C.dim}
                    attributes={selected ? 1 : undefined}
                  >
                    {prefix}
                  </text>
                  <text fg={C.dim}>{number}</text>
                  <text
                    fg={selected ? C.accent : C.text}
                    attributes={selected ? 1 : undefined}
                  >
                    {pickLabel(actualIndex)}
                  </text>
                </box>
              );
            })
        ) : legacyConfirm ? (
          layout.compact ? (
            <box flexDirection="row">{previewPaint}</box>
          ) : (
            <scrollbox height={bodyRows} flexShrink={1} stickyScroll={false}>
              <text fg={C.yellow}>{warning}</text>
            </scrollbox>
          )
        ) : loadingDiff || isRestoring ? (
          <text fg={C.dim}>
            {truncateToWidth(
              loadingDiff ? t('Computing file changes...') : t('Restoring...'),
              contentWidth,
            )}
          </text>
        ) : (
          restoreOptions
            .slice(
              optionWindow.offset,
              optionWindow.offset + optionWindow.visibleCount,
            )
            .map((option, index, visible) => {
              const actualIndex = optionWindow.offset + index;
              const selected = actualIndex === state.restoreOptionIndex;
              const prefix = selected
                ? '› '
                : index === 0 && optionWindow.showScrollUp
                  ? '↑ '
                  : index === visible.length - 1 && optionWindow.showScrollDown
                    ? '↓ '
                    : '  ';
              const label = optionLabel(actualIndex);
              return (
                <box key={option.key} flexDirection="row">
                  <text
                    fg={selected ? C.accent : C.text}
                    attributes={selected ? 1 : undefined}
                  >
                    {prefix}
                    {label}
                  </text>
                  {option.detail && (
                    <text fg={C.dim}>
                      {truncateToWidth(
                        ` ${option.detail}`,
                        Math.max(
                          0,
                          contentWidth - 2 - getCachedStringWidth(label),
                        ),
                      )}
                    </text>
                  )}
                </box>
              );
            })
        )}
      </box>
      {!layout.compact && (
        <>
          {optionPhase && (
            <box marginTop={1}>
              <text fg={C.dim}>{warning}</text>
            </box>
          )}
          <text fg={C.borderDefault}>{separator}</text>
          <text fg={C.dim}>{truncateToWidth(footer, contentWidth)}</text>
        </>
      )}
    </DialogFrame>
  );
}
