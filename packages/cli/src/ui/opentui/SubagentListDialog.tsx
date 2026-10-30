/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { SubagentConfig } from '@qwen-code/qwen-code-core/subagents/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  getColorForDisplay,
  shouldShowColor,
} from '../components/subagents/utils.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  truncateToWidth,
} from '../utils/textUtils.js';
import { useBatchSafeState } from './batch-cursor.js';
import { scrollDialogLayout, wrappedRows } from './dialogs-core.js';
import {
  DialogFrame,
  DialogSelect,
  dialogContentWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { toOriginalKey } from './key-map.js';
import { C } from './theme.js';

type Page = 'list' | 'actions' | 'detail';

export function OpenTuiSubagentListDialog({
  config,
  onClose,
  availableTerminalHeight,
}: {
  config?: Config;
  settings?: LoadedSettings;
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const page = useBatchSafeState<Page>('list');
  const setPage = page.setValue;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [data, setData] = useState<{
    owner: Config | undefined;
    agents: SubagentConfig[];
    loading: boolean;
    error: string;
  }>({ owner: config, agents: [], loading: true, error: '' });
  const alive = useRef(true);
  const owner = useRef(config);
  owner.current = config;
  const scroll = useRef<ScrollBoxRenderable>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setPage('list');
    setSelectedIndex(0);
    setData({ owner: config, agents: [], loading: true, error: '' });
    const load = async () => {
      try {
        if (!config) throw new Error(t('Configuration not available'));
        const agents = await config
          .getSubagentManager()
          .listSubagents({ force: true });
        if (current && alive.current)
          setData({ owner: config, agents, loading: false, error: '' });
      } catch (error) {
        if (current && alive.current)
          setData({
            owner: config,
            agents: [],
            loading: false,
            error:
              (error instanceof Error ? error.message : String(error)) ||
              t('Error'),
          });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [config, setPage]);

  const ready = data.owner === config && !data.loading && !data.error;
  const selected = ready ? data.agents[selectedIndex] : undefined;
  const title =
    page.value === 'list'
      ? t('Agents')
      : page.value === 'actions'
        ? t('Choose Action')
        : sanitizeTerminalLine(selected?.name ?? '');
  const { width } = useTerminalDimensions();
  const items = useMemo(() => {
    if (page.value === 'list')
      return data.agents.map((agent, index) => ({
        key: String(index),
        value: String(index),
        label: agent.name,
      }));
    if (page.value === 'actions')
      return [
        { key: 'view', value: 'view', label: t('View Agent') },
        { key: 'back', value: 'back', label: t('Back') },
      ];
    return [];
  }, [page.value, data.agents]);
  const footer =
    page.value === 'detail'
      ? t('Esc to go back')
      : items.length > 0 && ready
        ? page.value === 'list'
          ? t('Enter to select, ↑↓ to navigate, Esc to close')
          : t('Enter to select, ↑↓ to navigate, Esc to go back')
        : t('Esc to close');
  const contentWidth = dialogContentWidth(width);
  const layout = scrollDialogLayout(
    clampDialogHeight(availableTerminalHeight),
    5 + wrappedRows(title, contentWidth) + wrappedRows(footer, contentWidth),
    12,
  );
  const select = useDialogSelect({
    items,
    initialIndex: page.value === 'list' ? selectedIndex : 0,
    resyncKey: page.value,
    numbers: false,
    focused: ready && page.value !== 'detail',
    maxItemsToShow: layout.bodyRows,
    onSelect: (value) => {
      if (
        !alive.current ||
        owner.current !== config ||
        !ready ||
        page.ref.current !== page.value
      )
        return;
      if (page.value === 'list') {
        setSelectedIndex(Number(value));
        setPage('actions');
      } else if (page.value === 'actions') {
        setPage(value === 'view' ? 'detail' : 'list');
      }
    },
  });
  useKeyboard((key) => {
    if (
      !alive.current ||
      owner.current !== config ||
      key.eventType === 'release' ||
      page.ref.current !== page.value
    )
      return;
    const { name } = toOriginalKey(key);
    if (name === 'escape') {
      if (page.value === 'detail') setPage('actions');
      else if (page.value === 'actions') setPage('list');
      else {
        alive.current = false;
        onClose();
      }
      return;
    }
    if (page.value !== 'detail' || !scroll.current) return;
    if (name === 'up') scroll.current.scrollBy(-1);
    if (name === 'down') scroll.current.scrollBy(1);
    if (name === 'pageup') scroll.current.scrollBy(-layout.bodyRows);
    if (name === 'pagedown') scroll.current.scrollBy(layout.bodyRows);
    if (name === 'home') scroll.current.scrollTo(0);
    if (name === 'end') scroll.current.scrollTo(scroll.current.scrollHeight);
  });

  return (
    <DialogFrame bodyLayout={layout}>
      {!layout.compact && (
        <text fg={C.text} attributes={1}>
          {title}
        </text>
      )}
      <scrollbox
        key={`${page.value}-${width}-${layout.bodyRows}-${layout.compact}`}
        ref={scroll}
        height={layout.bodyRows}
        marginTop={layout.compact ? 0 : 1}
        flexShrink={1}
        stickyScroll={false}
      >
        {data.owner !== config || data.loading ? (
          <text fg={C.dim}>{t('Loading...')}</text>
        ) : data.error ? (
          <text fg={C.red}>{sanitizeTerminalText(data.error)}</text>
        ) : page.value === 'detail' && selected ? (
          <box flexDirection="column">
            <text fg={C.text}>
              {t('File Path: ')}
              {sanitizeTerminalText(selected.filePath ?? '')}
            </text>
            <text fg={C.text}>
              {t('Tools: ')}
              {sanitizeTerminalText(
                selected.tools ? selected.tools.join(', ') : '*',
              )}
            </text>
            {selected.model && (
              <text fg={C.text}>
                {t('Model: ')}
                {sanitizeTerminalText(selected.model)}
              </text>
            )}
            {shouldShowColor(selected.color) && (
              <text fg={getColorForDisplay(selected.color) ?? C.text}>
                {t('Color: ')}
                {sanitizeTerminalText(selected.color ?? '')}
              </text>
            )}
            <text fg={C.text} marginTop={1}>
              {t('Description:')}
            </text>
            <text fg={C.text}>
              {sanitizeTerminalText(selected.description)}
            </text>
            <text fg={C.text} marginTop={1}>
              {t('System Prompt:')}
            </text>
            <text fg={C.text}>
              {sanitizeTerminalText(selected.systemPrompt)}
            </text>
          </box>
        ) : items.length === 0 ? (
          <text fg={C.dim}>{t('No subagents found.')}</text>
        ) : (
          <DialogSelect
            {...select}
            maxItemsToShow={layout.bodyRows}
            showNumbers={false}
            showScrollArrows={false}
            onSelectIndex={select.selectIndex}
            onHover={select.highlightIndex}
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>
                {truncateToWidth(
                  sanitizeTerminalLine(item.label),
                  Math.max(0, dialogContentWidth(width) - 2),
                )}
              </text>
            )}
          />
        )}
      </scrollbox>
      {!layout.compact && <text fg={C.dim}>{footer}</text>}
    </DialogFrame>
  );
}
