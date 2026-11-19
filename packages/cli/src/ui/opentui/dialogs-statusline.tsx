/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type { StatusLineState } from '../hooks/useStatusLine.js';
import {
  buildInitialSelectedKeys,
  buildConfigFromKeys,
  getEffectiveStatusLineScope,
  getPreviewData,
  STATUS_LINE_OPTIONS,
  STATUS_LINE_DIALOG_FIXED_ROWS,
} from '../status-line-model.js';
import { buildStatusLinePresetLines } from '../statusLinePresets.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { truncateToWidth } from '../utils/textUtils.js';
import {
  DialogFrame,
  DialogSelect,
  dialogAreaWidth,
  dialogContentWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { toOriginalKey } from './key-map.js';
import { C } from './theme.js';

export function OpenTuiStatusLineDialog({
  config,
  settings,
  state,
  addItem,
  onClose,
  availableTerminalHeight = 18,
}: {
  config: Config;
  settings: LoadedSettings;
  state?: StatusLineState;
  addItem: UseHistoryManagerReturn['addItem'];
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const { width } = useTerminalDimensions();
  const full = availableTerminalHeight >= STATUS_LINE_DIALOG_FIXED_ROWS + 1;
  const budget = Math.max(
    0,
    full ? dialogContentWidth(width) : dialogAreaWidth(width) - 2,
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() =>
    buildInitialSelectedKeys(settings),
  );
  const selectedRef = useRef(selected);
  const items = useMemo(() => {
    const search = query.trim().toLowerCase();
    return !full || !search
      ? STATUS_LINE_OPTIONS
      : STATUS_LINE_OPTIONS.filter(
          (item) =>
            !item.separator &&
            `${item.label} ${item.key}`.toLowerCase().includes(search),
        );
  }, [query, full]);
  const preset = useMemo(() => buildConfigFromKeys(selected), [selected]);
  const preview = state
    ? buildStatusLinePresetLines(preset, getPreviewData(config, state))
    : [];
  const maxItemsToShow = Math.max(
    1,
    Math.min(
      10,
      full
        ? availableTerminalHeight - STATUS_LINE_DIALOG_FIXED_ROWS
        : availableTerminalHeight,
    ),
  );
  const save = () => {
    const scope = getEffectiveStatusLineScope(settings);
    const old = settings.forScope(scope).settings.ui?.statusLine;
    const saved = {
      ...buildConfigFromKeys(selectedRef.current),
      ...(typeof old?.hideContextIndicator === 'boolean'
        ? { hideContextIndicator: old.hideContextIndicator }
        : {}),
    };
    settings.setValue(scope, 'ui.statusLine', saved);
    const feedback: HistoryItemWithoutId & Record<string, unknown> = {
      type: MessageType.INFO,
      text: `Status line preset saved to ${scope.toLowerCase()} settings.`,
    };
    addItem(feedback, Date.now());
    config.getChatRecordingService?.()?.recordSlashCommand({
      phase: 'result',
      rawCommand: '/statusline',
      outputHistoryItems: [feedback],
    });
    onClose();
  };
  const list = useDialogSelect({
    items,
    numbers: false,
    maxItemsToShow,
    onSelect: save,
  });
  const toggle = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    const old = selectedRef.current;
    const next = old.includes(item.key)
      ? old.filter((key) => key !== item.key)
      : [...old, item.key];
    selectedRef.current = next;
    setSelected(next);
  };
  useKeyboard((event) => {
    const key = toOriginalKey(event);
    if (key.name === 'escape') {
      if (full && query) setQuery('');
      else onClose();
    } else if (key.name === 'space' || key.sequence === ' ') {
      toggle(list.activeIndexRef.current);
    } else if (full && (key.name === 'backspace' || key.name === 'delete')) {
      setQuery((value) => value.slice(0, -1));
    } else if (
      full &&
      !['j', 'k', 'up', 'down', 'return'].includes(key.name) &&
      !key.ctrl &&
      !key.meta &&
      key.sequence.length === 1 &&
      key.sequence >= '!' &&
      key.sequence <= '~'
    ) {
      setQuery((value) => value + key.sequence);
    }
  });
  const body = (
    <>
      {full && (
        <>
          <text fg={C.text} attributes={1}>
            {truncateToWidth('Configure Status Line', budget)}
          </text>
          <text fg={C.dim}>
            {truncateToWidth(
              'Select which items to display in the status line.',
              budget,
            )}
          </text>
          <box marginTop={1} flexDirection="column">
            <text fg={C.dim}>{truncateToWidth('Type to search', budget)}</text>
            <text>{truncateToWidth(query ? `> ${query}` : '>', budget)}</text>
          </box>
        </>
      )}
      <box marginTop={full ? 1 : 0} flexDirection="column">
        {items.length ? (
          <DialogSelect
            items={items}
            activeIndex={list.activeIndex}
            scrollOffset={list.scrollOffset}
            maxItemsToShow={maxItemsToShow}
            showNumbers={false}
            onHover={list.highlightIndex}
            onSelectIndex={(index) => {
              list.highlightIndex(index);
              toggle(index);
            }}
            onWheel={(direction) =>
              list.setActiveIndex(
                Math.max(
                  0,
                  Math.min(
                    items.length - 1,
                    list.activeIndexRef.current + (direction === 'up' ? -1 : 1),
                  ),
                ),
              )
            }
            renderLabel={(item, { isSelected, titleColor }) => (
              <text
                fg={
                  !isSelected && !item.disabled && selected.includes(item.key)
                    ? C.accent
                    : titleColor
                }
              >
                {truncateToWidth(
                  item.separator
                    ? `    ${item.label}`
                    : `${selected.includes(item.key) ? '[x]' : '[ ]'} ${item.label}`,
                  Math.max(0, budget - 2),
                )}
              </text>
            )}
          />
        ) : (
          <text fg={C.dim}>
            {truncateToWidth('No preset items match.', budget)}
          </text>
        )}
      </box>
      {full && (
        <>
          <box marginTop={1} flexDirection="column">
            <text fg={C.dim}>{truncateToWidth('Preview', budget)}</text>
            {preview.length ? (
              preview.map((line, index) => (
                <text
                  key={index}
                  fg={preset.useThemeColors ? C.accent : undefined}
                  attributes={preset.useThemeColors ? 0 : 2}
                >
                  {truncateToWidth(line, budget)}
                </text>
              ))
            ) : (
              <text fg={C.dim}>
                {truncateToWidth(
                  'Select at least one item to show a status line.',
                  budget,
                )}
              </text>
            )}
          </box>
          <box marginTop={1}>
            <text fg={C.dim}>
              {truncateToWidth(
                'Use up/down to navigate, space to select, enter to confirm, esc to cancel.',
                budget,
              )}
            </text>
          </box>
        </>
      )}
    </>
  );
  return full ? (
    <DialogFrame>{body}</DialogFrame>
  ) : (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {body}
    </box>
  );
}
