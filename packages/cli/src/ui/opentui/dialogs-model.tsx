/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/model` dialog
 * (ui/components/ModelDialog.tsx): model list with `[authType]` tags, the
 * highlighted-entry detail panel (Modality / Context Window / Base URL /
 * API Key), runtime/discontinued markers, the empty state, error box, and
 * the original footer hint. Esc closes; in auxiliary modes (fast/voice/
 * vision/compaction/image) ← closes too — both straight from the original.
 * Model switching/persisting is the backend's job: `onSelect` receives the
 * row's selection key unchanged.
 */

import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { toOriginalKey } from './key-map.js';
import type {
  InputModalities,
  AuthType,
  AvailableModel,
} from '@qwen-code/qwen-code-core';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  useDialogSelect,
  type DialogListItem,
} from './dialogs-shared.js';
import { useDialogFrameKeys } from './dialogs-shared.js';

export const MAX_MODEL_ITEMS_TO_SHOW = 10;

/**
 * Height-cap parity of the ink ModelDialog: non-list chrome to reserve when
 * capping the visible model rows — outer border (2) + title/gap (2) + the
 * highlighted-entry detail panel (divider + up to 4 rows + margin, ~7) +
 * footer hint (2) + error-box rows when present. Mirrors
 * `MODEL_DIALOG_FIXED_ROWS` in ui/components/ModelDialog.tsx.
 */
export const MODEL_DIALOG_FIXED_ROWS = 14;
export const MODEL_OPTION_ROW_HEIGHT = 1;
export const MODEL_OPTION_ROW_HEIGHT_WITH_DESCRIPTION = 2;

/** Parity of the ink dialog's `maxModelItemsToShow` computation. */
export function computeModelDialogMaxItems(
  availableTerminalHeight: number | undefined,
  hasDescriptions: boolean,
  errorMessageRows: number,
): number {
  if (availableTerminalHeight === undefined) {
    return MAX_MODEL_ITEMS_TO_SHOW;
  }
  const rowHeight = hasDescriptions
    ? MODEL_OPTION_ROW_HEIGHT_WITH_DESCRIPTION
    : MODEL_OPTION_ROW_HEIGHT;
  return Math.max(
    1,
    Math.min(
      MAX_MODEL_ITEMS_TO_SHOW,
      Math.floor(
        (availableTerminalHeight - MODEL_DIALOG_FIXED_ROWS - errorMessageRows) /
          rowHeight,
      ),
    ),
  );
}

export type ModelDialogMode =
  | 'primary'
  | 'fast'
  | 'voice'
  | 'vision'
  | 'compaction'
  | 'image';

/** Parity of `formatModalities` in ModelDialog.tsx. */
export function formatModalities(modalities?: InputModalities): string {
  if (!modalities) return t('text-only');
  const parts: string[] = [];
  if (modalities.image) parts.push(t('image'));
  if (modalities.pdf) parts.push(t('pdf'));
  if (modalities.audio) parts.push(t('audio'));
  if (modalities.video) parts.push(t('video'));
  if (parts.length === 0) return t('text-only');
  return `${t('text')} · ${parts.join(' · ')}`;
}

/** Parity of `maskApiKey` in ModelDialog.tsx. */
export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return `(${t('not set')})`;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return `(${t('not set')})`;
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

/** Parity of `formatContextWindow` in ModelDialog.tsx. */
export function formatContextWindow(size?: number): string {
  if (!size) return `(${t('unknown')})`;
  return `${size.toLocaleString('en-US')} tokens`;
}

/**
 * Parity of `buildModelSelectionKey` / `parseModelSelectionKey`: the \0
 * separator keeps same-id models on different baseUrls distinct.
 */
export function buildModelSelectionKey(
  authType: string,
  modelId: string,
  baseUrl?: string,
): string {
  const base = `${authType}::${modelId}`;
  return baseUrl ? `${base}\0${baseUrl}` : base;
}

export function parseModelSelectionKey(key: string): {
  authType: string;
  modelId: string;
  baseUrl?: string;
} {
  const sep = '::';
  const idx = key.indexOf(sep);
  if (idx < 0) return { authType: '', modelId: key };

  const authType = key.slice(0, idx);
  const rest = key.slice(idx + sep.length);
  const nullIdx = rest.indexOf('\0');
  if (nullIdx >= 0) {
    return {
      authType,
      modelId: rest.slice(0, nullIdx),
      baseUrl: rest.slice(nullIdx + 1),
    };
  }
  return { authType, modelId: rest };
}

/**
 * Parity of `encodeAuxModelSelector` in ModelDialog.tsx: encode a selection
 * key into the `authType:modelId` form persisted for the fast/vision auxiliary
 * models (baseUrl discarded). Handles the three selection-key shapes.
 */
export function encodeAuxModelSelector(selected: string): string {
  if (selected.includes('::')) {
    const parsed = parseModelSelectionKey(selected);
    return `${parsed.authType}:${parsed.modelId}`;
  }
  if (selected.startsWith('$runtime|')) {
    const parts = selected.split('|');
    return parts[1] && parts[2] ? `${parts[1]}:${parts[2]}` : selected;
  }
  return selected;
}

/**
 * Parity of `encodeVisionModelSelector` in ModelDialog.tsx: keep the selected
 * row's baseUrl when present (so same-provider same-id endpoints stay
 * distinct), otherwise fall back to the aux encoding.
 */
export function encodeVisionModelSelector(selected: string): string {
  if (!selected.includes('::')) {
    return encodeAuxModelSelector(selected);
  }
  const parsed = parseModelSelectionKey(selected);
  const selector = `${parsed.authType}:${parsed.modelId}`;
  return parsed.baseUrl ? `${selector}\0${parsed.baseUrl}` : selector;
}

/** Parity of the ModelDialog title line. */
export function modelDialogTitle(
  mode: ModelDialogMode,
  persistScope?: 'workspace' | 'user',
): string {
  const base =
    mode === 'voice'
      ? t('Select Voice Model')
      : mode === 'vision'
        ? t('Select Vision Model')
        : mode === 'compaction'
          ? t('Select Compaction Model')
          : mode === 'image'
            ? t('Select Image Model')
            : mode === 'fast'
              ? t('Select Fast Model')
              : t('Select Model');
  const suffix =
    persistScope === 'workspace'
      ? t(' (this project)')
      : persistScope === 'user'
        ? t(' (global)')
        : '';
  return base + suffix;
}

export interface OpenTuiModelEntry extends DialogListItem<string> {
  authType: string;
  /** model.label — the human display name. */
  label: string;
  modelId: string;
  description?: string;
  isRuntime?: boolean;
  isQwenOAuth?: boolean;
  modalities?: InputModalities;
  contextWindowSize?: number;
  baseUrl?: string;
  envKey?: string;
  /** The registry entry behind this row (selection-time validation parity). */
  model?: AvailableModel;
}

/** Plain-text row title (colors are applied at render time). */
export function formatModelOptionLabel(entry: OpenTuiModelEntry): string {
  let label = `[${entry.authType}] ${entry.label}`;
  if (entry.modelId !== entry.label) label += ` (${entry.modelId})`;
  if (entry.isRuntime) label += ' (Runtime)';
  if (entry.isQwenOAuth && !entry.isRuntime) label += ` (${t('Discontinued')})`;
  return label;
}

export interface OpenTuiModelDialogProps {
  entries: readonly OpenTuiModelEntry[];
  mode: ModelDialogMode;
  authType?: AuthType;
  persistScope?: 'workspace' | 'user';
  initialKey?: string;
  errorMessage?: string | null;
  onSelect: (selectionKey: string) => void;
  onClose: () => void;
  availableTerminalHeight?: number;
}

export function OpenTuiModelDialog(props: OpenTuiModelDialogProps) {
  const {
    entries,
    mode,
    authType,
    persistScope,
    initialKey,
    errorMessage,
    onSelect,
    onClose,
    availableTerminalHeight,
  } = props;

  const isAuxMode = mode !== 'primary';
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  const initialIndex = initialKey
    ? Math.max(
        0,
        entries.findIndex((entry) => entry.key === initialKey),
      )
    : 0;

  // Height-capped list window (ink parity): on short terminals the detail
  // panel and footer stay visible instead of being pushed off-screen.
  const errorMessageRows = errorMessage
    ? 2 + errorMessage.split('\n').length
    : 0;
  const maxItemsToShow = computeModelDialogMaxItems(
    availableTerminalHeight,
    entries.some(
      (entry) =>
        typeof entry.description === 'string' &&
        entry.description.trim().length > 0,
    ),
    errorMessageRows,
  );

  const list = useDialogSelect({
    items: entries,
    initialIndex,
    focused: true,
    numbers: true,
    // The original intentionally omits the ▲/▼ arrows; window only.
    maxItemsToShow,
    onSelect: (key) => onSelect(key),
    onHighlight: (key) => setHighlightedKey(key),
  });

  useDialogFrameKeys({
    onEscape: onClose,
  });
  useLeftCloses({ enabled: isAuxMode, onClose });

  const highlightedEntry =
    entries.find((entry) => entry.key === (highlightedKey ?? initialKey)) ??
    undefined;
  const hasModels = entries.length > 0;

  return (
    <DialogFrame>
      <text fg={C.text} attributes={1}>
        {modelDialogTitle(mode, persistScope)}
      </text>

      {!hasModels ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.yellow}>
            {t(
              'No models available for the current authentication type ({{authType}}).',
              { authType: authType ? String(authType) : t('(none)') },
            )}
          </text>
          <box marginTop={1}>
            <text fg={C.dim}>
              {t(
                'Please configure models in settings.modelProviders or use environment variables.',
              )}
            </text>
          </box>
        </box>
      ) : (
        <box marginTop={1}>
          <DialogSelect
            items={entries}
            activeIndex={list.activeIndex}
            scrollOffset={list.scrollOffset}
            maxItemsToShow={maxItemsToShow}
            showNumbers={true}
            focused={true}
            onHover={list.setActiveIndex}
            onSelectIndex={list.selectIndex}
            onWheel={(direction) =>
              list.setActiveIndex(
                list.activeIndex + (direction === 'down' ? 1 : -1),
              )
            }
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>{formatModelOptionLabel(item)}</text>
            )}
          />
        </box>
      )}

      {highlightedEntry && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.dim}>{'─'.repeat(20)}</text>
          {highlightedEntry.isQwenOAuth && !highlightedEntry.isRuntime && (
            <box marginTop={1}>
              <text fg={C.yellow}>
                ⚠ {t('Discontinued — switch to Coding Plan or API Key')}
              </text>
            </box>
          )}
          <DetailRow
            label={t('Modality')}
            value={formatModalities(highlightedEntry.modalities)}
          />
          <DetailRow
            label={t('Context Window')}
            value={formatContextWindow(highlightedEntry.contextWindowSize)}
          />
          {!highlightedEntry.isQwenOAuth && (
            <box flexDirection="column">
              <DetailRow
                label="Base URL"
                value={highlightedEntry.baseUrl ?? t('(default)')}
              />
              <DetailRow
                label="API Key"
                value={highlightedEntry.envKey ?? t('(not set)')}
              />
            </box>
          )}
        </box>
      )}

      {errorMessage && (
        <box marginTop={1} paddingX={1}>
          <text fg={C.red}>✕ {errorMessage}</text>
        </box>
      )}

      <FooterHint text={t('Enter to select, ↑↓ to navigate, Esc to close')} />
    </DialogFrame>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <box flexDirection="row">
      <box width={16} flexShrink={0}>
        <text fg={C.dim}>{props.label}:</text>
      </box>
      <text fg={C.text}>{props.value}</text>
    </box>
  );
}

/** In auxiliary model modes the original binds ← to close as well. */
function useLeftCloses(options: { enabled: boolean; onClose: () => void }) {
  useKeyboard((key) => {
    if (!options.enabled) return;
    const original = toOriginalKey(key);
    if (original.name === 'left') options.onClose();
  });
}
