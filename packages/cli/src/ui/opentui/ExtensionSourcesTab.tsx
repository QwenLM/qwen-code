/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodePasteBytes, type ScrollBoxRenderable } from '@opentui/core';
import { usePaste, useTerminalDimensions } from '@opentui/react';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { redactUrlCredentials } from '@qwen-code/qwen-code-core/extension/redaction.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { t } from '../../i18n/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import { stripUnsafeCharacters, truncateToWidth } from '../utils/textUtils.js';
import type { ExtensionsStatusMessage } from './dialogs-extensions.js';
import {
  findNextEnabledIndex,
  regionListWindow,
  wrappedRows,
} from './dialogs-core.js';
import {
  DialogSelect,
  dialogContentWidth,
  useDialogSelect,
  useFocusedKeyboard,
  type DialogListItem,
  type UseDialogSelectResult,
} from './dialogs-shared.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { toOriginalKey } from './key-map.js';
import { windowLineAtCaret, useLineEdit } from './line-edit.js';
import { C } from './theme.js';

const debugLogger = createDebugLogger('OPENTUI_SOURCES_TAB');
const clean = (text: string) =>
  stripUnsafeCharacters(redactUrlCredentials(text)).replace(/[\r\n]/g, ' ');
type Source = ReturnType<ExtensionManager['getSources']>[number];
type Marketplace = Awaited<ReturnType<ExtensionManager['loadSource']>>;
type View = 'list' | 'add' | 'install-extension' | 'detail' | 'remove-confirm';
type Action = 'browse' | 'update' | 'remove';
interface Row extends DialogListItem<string> {
  label: string;
  kind: 'heading' | 'install' | 'add' | 'source';
  source?: Source;
  right?: string;
}
export interface OpenTuiExtensionSourcesTabProps {
  manager: ExtensionManager;
  cwd: string;
  isActive: boolean;
  isCurrent: () => boolean;
  reloadSignal: number;
  availableTerminalHeight: number | undefined;
  onLockChange: (locked: boolean) => void;
  onStatus: (status: ExtensionsStatusMessage | null) => void;
  onChanged: () => void;
  onBrowse: (name: string) => void;
  onFooter: (hint: string | null) => void;
  install: (
    source: string,
    scope: 'user' | 'project',
  ) => Promise<ExtensionsStatusMessage>;
}

export function OpenTuiExtensionSourcesTab({
  manager,
  cwd,
  isActive,
  isCurrent,
  reloadSignal,
  availableTerminalHeight,
  onLockChange,
  onStatus,
  onChanged,
  onBrowse,
  onFooter,
  install,
}: OpenTuiExtensionSourcesTabProps) {
  const [sources, setSources] = useState<Source[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<View>('list');
  const viewRef = useRef<View>('list');
  const [input, setInput] = useState('');
  const [inputEpoch, setInputEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [detailSource, setDetailSource] = useState<Source | null>(null);
  const sourceScroll = useRef<ScrollBoxRenderable>(null);
  const [detailConfig, setDetailConfig] = useState<Marketplace>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailLoadingRef = useRef(false);
  const mounted = useRef(true);
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);
  const mutationSeq = useRef(0);
  const contextRef = useRef({ manager, cwd, isCurrent });
  if (
    contextRef.current.manager !== manager ||
    contextRef.current.cwd !== cwd ||
    contextRef.current.isCurrent !== isCurrent
  ) {
    contextRef.current = { manager, cwd, isCurrent };
    loadSeq.current++;
    detailSeq.current++;
    mutationSeq.current++;
    busyRef.current = false;
  }
  const context = contextRef.current;
  const current = useCallback(
    () => mounted.current && contextRef.current === context && isCurrent(),
    [context, isCurrent],
  );
  const { width, height } = useTerminalDimensions();
  const contentWidth = Math.max(1, dialogContentWidth(width));
  const rightWidth = Math.max(0, Math.floor((contentWidth - 3) / 2));
  // Parent frame, tabs, margins, footer and a single bounded status row.
  const bodyRows = Math.max(
    0,
    (clampDialogHeight(availableTerminalHeight ?? height) ?? height) - 8,
  );
  const drawn = (text: string, columns = contentWidth) =>
    truncateToWidth(clean(text), columns);
  const report = useCallback(
    (status: ExtensionsStatusMessage) => {
      if (current()) onStatus({ ...status, text: clean(status.text) });
    },
    [current, onStatus],
  );
  const setView = useCallback(
    (next: View) => {
      viewRef.current = next;
      setViewState(next);
      onLockChange(next !== 'list');
    },
    [onLockChange],
  );
  const goToList = useCallback(() => {
    detailSeq.current++;
    detailLoadingRef.current = false;
    setDetailLoading(false);
    setDetailConfig(null);
    setDetailSource(null);
    setInput('');
    setInputEpoch((n) => n + 1);
    setView('list');
  }, [setView]);
  const reload = useCallback(async () => {
    if (!current()) return;
    const seq = ++loadSeq.current;
    try {
      await manager.refreshCache();
    } catch (error) {
      if (!current() || seq !== loadSeq.current) return;
      debugLogger.error(
        'Failed to refresh extensions:',
        redactUrlCredentials(getErrorMessage(error)),
      );
    }
    if (!current() || seq !== loadSeq.current) return;
    setSources(manager.getSources());
    setInstalledNames(
      new Set(manager.getLoadedExtensions().map((extension) => extension.name)),
    );
  }, [manager, current]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // These counters invalidate pending work across effect remounts; none is a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadSeq.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      detailSeq.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      mutationSeq.current++;
    };
  }, []);
  useEffect(() => {
    if (!current()) return;
    setBusy(false);
    goToList();
  }, [context, goToList, current]);
  useEffect(() => {
    void reload().catch((error: unknown) => {
      if (current()) report({ type: 'error', text: getErrorMessage(error) });
    });
  }, [reload, reloadSignal, current, report]);

  const readDetail = async (source: Source, update = false) => {
    if (!current()) return;
    const seq = ++detailSeq.current;
    detailLoadingRef.current = true;
    setDetailLoading(true);
    setDetailConfig(null);
    try {
      const config = await manager.loadSource(source.source, { cwd });
      if (!current() || seq !== detailSeq.current) return;
      setDetailConfig(config);
      if (update) {
        if (config === null) {
          report({
            type: 'error',
            text: t('Could not update marketplace "{{name}}".', {
              name: source.name,
            }),
          });
          await reload();
          if (!current() || seq !== detailSeq.current) return;
        } else {
          const live = manager
            .getSources()
            .find((entry) => entry.name === source.name);
          if (live?.source !== source.source) return;
          const updated = manager.markSourceUpdated(source.name);
          if (!updated) return;
          setDetailSource(updated);
          await reload();
          if (!current() || seq !== detailSeq.current) return;
          onChanged();
          report({
            type: 'success',
            text: t('Updated marketplace "{{name}}".', { name: source.name }),
          });
        }
      }
    } catch (error) {
      if (!current() || seq !== detailSeq.current) return;
      report({ type: 'error', text: getErrorMessage(error) });
    } finally {
      if (
        mounted.current &&
        contextRef.current === context &&
        seq === detailSeq.current
      ) {
        detailLoadingRef.current = false;
        setDetailLoading(false);
      }
    }
  };
  const openDetail = (source: Source) => {
    if (!current() || busyRef.current) return;
    onStatus(null);
    setDetailSource(source);
    setView('detail');
    void readDetail(source);
  };
  const submitInput = async (
    kind: 'add' | 'install-extension',
    value: string,
  ) => {
    if (!current() || busyRef.current || !value.trim()) return;
    const seq = ++mutationSeq.current;
    busyRef.current = true;
    setBusy(true);
    try {
      let status: ExtensionsStatusMessage;
      if (kind === 'add') {
        const source = await manager.addSource(value.trim(), { cwd });
        if (!current() || seq !== mutationSeq.current) return;
        status = {
          type: 'success',
          text: t('Added marketplace "{{name}}".', { name: source.name }),
        };
      } else {
        status = await install(value.trim(), 'user');
        if (!current() || seq !== mutationSeq.current) return;
      }
      if (status.type !== 'success' && status.type !== 'warning') {
        report(status);
        return;
      }
      try {
        await reload();
      } catch (error) {
        if (!current() || seq !== mutationSeq.current) return;
        status = {
          type: 'warning',
          text: `${status.text} ${getErrorMessage(error)}`,
        };
      }
      if (!current() || seq !== mutationSeq.current) return;
      report(status);
      onChanged();
      goToList();
    } catch (error) {
      if (current() && seq === mutationSeq.current)
        report({ type: 'error', text: getErrorMessage(error) });
    } finally {
      if (
        mounted.current &&
        contextRef.current === context &&
        seq === mutationSeq.current
      ) {
        busyRef.current = false;
        setBusy(false);
        setInputEpoch((n) => n + 1);
      }
    }
  };
  const remove = () => {
    if (!current() || busyRef.current || !detailSource) return;
    try {
      const live = manager
        .getSources()
        .find((source) => source.name === detailSource.name);
      if (live && live.source !== detailSource.source) {
        goToList();
        return;
      }
      if (manager.removeSource(detailSource.name)) {
        report({
          type: 'success',
          text: t('Removed marketplace "{{name}}".', {
            name: detailSource.name,
          }),
        });
        onChanged();
      }
      goToList();
      void reload().catch((error: unknown) => {
        if (current()) report({ type: 'error', text: getErrorMessage(error) });
      });
    } catch (error) {
      report({ type: 'error', text: getErrorMessage(error) });
      goToList();
    }
  };

  const rows = useMemo(() => {
    const row = (
      key: string,
      label: string,
      kind: Row['kind'],
      extra: Partial<Row> = {},
    ): Row => ({ key, value: key, label, kind, ...extra });
    const heading = (key: string, label: string) =>
      row(key, label, 'heading', { value: '', disabled: true });
    return [
      heading('heading:add', t('Add new')),
      row('install', t('+ Install a new extension'), 'install'),
      row('add', t('+ Add new marketplace'), 'add', {
        right: t('Claude plugin marketplace'),
      }),
      ...(sources.length
        ? [
            heading(
              'heading:sources',
              t('Marketplaces') + ` (${sources.length})`,
            ),
            ...sources.map((source) =>
              row('source:' + source.name, source.name, 'source', {
                right: `${truncateToWidth(clean(source.source), Math.max(0, rightWidth - String(source.type).length - 3))} (${source.type})`,
                source,
              }),
            ),
          ]
        : [heading('heading:empty', t('No marketplaces added yet.'))]),
    ];
  }, [sources, rightWidth]);
  const listWindow = regionListWindow(
    bodyRows,
    { fixed: 0 },
    rows.length,
    rows.length,
  );
  const selectEntry = (value: string) => {
    if (
      !isActive ||
      !current() ||
      busyRef.current ||
      viewRef.current !== 'list' ||
      listWindow.maxItemsToShow < 1
    )
      return;
    const row = rows.find((entry) => entry.value === value && !entry.disabled);
    if (row?.source) openDetail(row.source);
    else if (row?.kind === 'add' || row?.kind === 'install') {
      onStatus(null);
      setInput('');
      setInputEpoch((n) => n + 1);
      setView(row.kind === 'add' ? 'add' : 'install-extension');
    }
  };
  const list = useDialogSelect({
    items: rows,
    numbers: false,
    focused:
      isActive &&
      current() &&
      view === 'list' &&
      !busy &&
      listWindow.maxItemsToShow > 0,
    maxItemsToShow: listWindow.maxItemsToShow,
    onSelect: selectEntry,
  });
  const selected = rows[list.activeIndex];
  const plugins = detailConfig?.plugins ?? [];
  const installed = plugins.filter((plugin) => installedNames.has(plugin.name));
  const preview = installed.slice(0, Math.min(5, Math.max(0, bodyRows - 8)));
  const hiddenInstalled = installed.length - preview.length;
  const date = detailSource?.lastUpdatedAt ?? detailSource?.addedAt;
  const lastUpdated =
    date && Number.isFinite(Date.parse(date))
      ? new Date(date).toLocaleDateString()
      : null;
  const actions = useMemo<
    Array<DialogListItem<Action> & { label: string }>
  >(() => {
    const action = (value: Action, label: string) => ({
      key: value,
      value,
      label,
    });
    return detailLoading
      ? []
      : [
          ...(detailConfig
            ? [
                action(
                  'browse',
                  t('Browse extensions ({{count}})', {
                    count: String(plugins.length),
                  }),
                ),
                action(
                  'update',
                  lastUpdated
                    ? t('Update marketplace (last updated {{date}})', {
                        date: lastUpdated,
                      })
                    : t('Update marketplace'),
                ),
              ]
            : []),
          action('remove', t('Remove marketplace')),
        ];
  }, [detailLoading, detailConfig, plugins.length, lastUpdated]);
  const detailChrome = detailConfig
    ? 3 +
      (installed.length ? 1 + preview.length + (hiddenInstalled ? 1 : 0) : 0)
    : 4;
  const sourceText = clean(detailSource?.source ?? '');
  const sourceRows = Math.min(
    wrappedRows(sourceText, contentWidth),
    Math.max(0, bodyRows - detailChrome + 1 - Math.min(1, actions.length)),
  );
  const actionWindow = regionListWindow(
    bodyRows,
    { fixed: detailChrome - 1 + sourceRows },
    actions.length,
    3,
  );
  const chooseAction = (action: Action) => {
    if (
      !isActive ||
      !current() ||
      busyRef.current ||
      detailLoadingRef.current ||
      viewRef.current !== 'detail' ||
      !detailSource ||
      sourceRows < 1 ||
      actionWindow.maxItemsToShow < 1
    )
      return;
    if (action === 'browse') {
      goToList();
      onBrowse(detailSource.name);
    } else if (action === 'update') void readDetail(detailSource, true);
    else setView('remove-confirm');
  };
  const detailSelect = useDialogSelect({
    items: actions,
    resyncKey: `${view}:${detailSource?.name ?? ''}`,
    numbers: false,
    focused:
      isActive &&
      current() &&
      view === 'detail' &&
      !detailLoading &&
      !busy &&
      sourceRows > 0 &&
      actionWindow.maxItemsToShow > 0,
    maxItemsToShow: actionWindow.maxItemsToShow,
    onSelect: chooseAction,
  });
  const line = useLineEdit(input, setInput, `${view}:${inputEpoch}`);
  const inputVisible = bodyRows >= 3;
  const inputActive =
    isActive &&
    current() &&
    !busyRef.current &&
    inputVisible &&
    (view === 'add' || view === 'install-extension');
  useFocusedKeyboard(isActive, (event) => {
    if (!isActive || !current() || event.eventType === 'release') return;
    const key = toOriginalKey(event);
    const activeView = viewRef.current;
    if (
      (activeView === 'add' || activeView === 'install-extension') &&
      !busyRef.current
    ) {
      if (key.name === 'escape') {
        goToList();
        return;
      }
      if (!inputVisible || line.settled) return;
      if (key.name === 'return' || key.name === 'enter') {
        if (line.text.trim()) {
          const value = line.text;
          line.settle();
          void submitInput(activeView, value);
        }
      } else if (!line.handleKey(key) && isPrintableKeyInput(event))
        line.insert(event.sequence);
    } else if (activeView === 'detail') {
      if (key.name === 'pageup') sourceScroll.current?.scrollBy(-sourceRows);
      else if (key.name === 'pagedown')
        sourceScroll.current?.scrollBy(sourceRows);
      else if (key.name === 'escape' && !busyRef.current) goToList();
      else if (
        (key.name === 'r' || key.sequence === 'r') &&
        !key.ctrl &&
        !key.meta &&
        !detailLoadingRef.current &&
        detailSource
      )
        void readDetail(detailSource);
    } else if (activeView === 'remove-confirm') {
      if (key.name === 'escape' || key.sequence === 'n') goToList();
      else if (bodyRows >= 2 && (key.name === 'return' || key.sequence === 'y'))
        remove();
    } else if (
      activeView === 'list' &&
      !busyRef.current &&
      listWindow.maxItemsToShow > 0 &&
      !key.ctrl &&
      !key.meta &&
      (key.sequence === 'd' || key.sequence === 'x')
    ) {
      const row = rows[list.activeIndexRef.current];
      if (row?.source) {
        setDetailSource(row.source);
        setView('remove-confirm');
      }
    }
  });
  usePaste((event) => {
    if (
      !inputActive ||
      busyRef.current ||
      line.settled ||
      (viewRef.current !== 'add' && viewRef.current !== 'install-extension')
    )
      return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (text) {
      event.preventDefault();
      line.insert(text);
    }
  });
  useEffect(() => {
    if (!current()) return;
    onFooter(
      !isActive
        ? null
        : view === 'list'
          ? selected?.source
            ? t('↑↓ navigate · Enter open · d remove marketplace · Esc close')
            : t('↑↓ navigate · Enter select · Esc close')
          : view === 'detail' && !detailLoading
            ? detailConfig
              ? t('Enter to select · R refresh · Esc to go back')
              : t('Press R to retry · Esc to go back')
            : null,
    );
    return () => {
      if (current()) onFooter(null);
    };
  }, [
    isActive,
    view,
    selected?.source,
    detailLoading,
    detailConfig,
    current,
    onFooter,
  ]);

  const mouseProps = <T extends DialogListItem<unknown>>(
    select: UseDialogSelectResult<T>,
  ) => ({
    onHover: (index: number) => {
      if (isActive && current()) select.highlightIndex(index);
    },
    onSelectIndex: (index: number) => {
      if (isActive && current()) select.selectIndex(index);
    },
    onWheel: (direction: 'up' | 'down') => {
      if (isActive && current())
        select.highlightIndex(
          findNextEnabledIndex(
            select.items,
            select.activeIndexRef.current,
            direction,
          ),
        );
    },
  });

  if (view === 'add' || view === 'install-extension') {
    const examples = [
      ' · owner/repo (GitHub)',
      ' · git@github.com:owner/repo.git (SSH)',
      view === 'add'
        ? ' · https://example.com/marketplace.json'
        : ' · @scope/name (npm)',
      ` · ./path/to/${view === 'add' ? 'marketplace' : 'extension'}`,
    ];
    const shownExamples = examples.slice(
      0,
      Math.max(0, Math.min(4, bodyRows - 4)),
    );
    const spans = windowLineAtCaret(
      { text: input, cursor: line.caret },
      Math.max(0, contentWidth - 3),
    );
    return (
      <box flexDirection="column" maxHeight={bodyRows} overflow="hidden">
        <text fg={C.accent} attributes={1}>
          {drawn(
            view === 'add' ? t('Add Marketplace') : t('Install Extension'),
          )}
        </text>
        <text fg={C.text}>
          {drawn(
            view === 'add'
              ? t('Enter marketplace source (Claude format):')
              : t('Enter extension source:'),
          )}
        </text>
        {shownExamples.length > 0 ? (
          <text fg={C.dim}>{t('Examples:')}</text>
        ) : null}
        {shownExamples.map((example) => (
          <text key={example} fg={C.dim}>
            {drawn(example)}
          </text>
        ))}
        {busy ? (
          <text fg={C.dim}>
            {view === 'add' ? t('Adding...') : t('Installing...')}
          </text>
        ) : !inputVisible ? (
          <text fg={C.dim}>
            {drawn(t('Resize terminal to enter a source.'))}
          </text>
        ) : (
          <box flexDirection="row">
            <text fg={C.accent}>{'> '}</text>
            <text fg={C.text}>{stripUnsafeCharacters(spans.before)}</text>
            {isActive ? (
              <text bg={C.accent}>
                {stripUnsafeCharacters(spans.at) || ' '}
              </text>
            ) : (
              <text fg={C.text}>{stripUnsafeCharacters(spans.at)}</text>
            )}
            <text fg={C.text}>{stripUnsafeCharacters(spans.after)}</text>
          </box>
        )}
      </box>
    );
  }
  if (view === 'remove-confirm' && detailSource)
    return (
      <box flexDirection="column" maxHeight={bodyRows} overflow="hidden">
        <text fg={C.yellow}>
          {drawn(
            t('Remove marketplace "{{name}}"?', { name: detailSource.name }),
          )}
        </text>
        <text fg={C.dim}>
          {drawn(t('Y/Enter to confirm · N/Esc to cancel'))}
        </text>
      </box>
    );
  if (view === 'detail' && detailSource)
    return (
      <box flexDirection="column" maxHeight={bodyRows} overflow="hidden">
        <text fg={C.text} attributes={1}>
          {drawn(detailSource.name)}
        </text>
        <scrollbox
          ref={sourceScroll}
          key={detailSource.source}
          height={sourceRows}
          flexShrink={0}
          stickyScroll={false}
        >
          <text fg={C.dim}>{sourceText}</text>
        </scrollbox>
        {detailLoading ? (
          <text fg={C.dim}>{t('Loading...')}</text>
        ) : (
          <>
            {detailConfig ? (
              <>
                <text fg={C.text}>
                  {drawn(
                    t('{{count}} available extensions', {
                      count: String(plugins.length),
                    }),
                  )}
                </text>
                {installed.length > 0 ? (
                  <text fg={C.text}>
                    {drawn(
                      t('Installed extensions ({{count}}):', {
                        count: String(installed.length),
                      }),
                    )}
                  </text>
                ) : null}
                {preview.map((plugin) => (
                  <text key={plugin.name} fg={C.green}>
                    {drawn('● ' + plugin.name)}
                  </text>
                ))}
                {hiddenInstalled ? (
                  <text fg={C.dim}>
                    {drawn(
                      t('... and {{count}} more', {
                        count: String(hiddenInstalled),
                      }),
                    )}
                  </text>
                ) : null}
              </>
            ) : (
              <>
                <text fg={C.red}>
                  {drawn(t('Could not load this marketplace.'))}
                </text>
                <text fg={C.dim}>
                  {drawn(t('Press R to retry · Esc to go back'))}
                </text>
              </>
            )}
            <DialogSelect
              items={actions}
              activeIndex={detailSelect.activeIndex}
              scrollOffset={detailSelect.scrollOffset}
              maxItemsToShow={actionWindow.maxItemsToShow}
              showNumbers={false}
              showScrollArrows={actionWindow.showScrollArrows}
              focused={isActive && !busy && sourceRows > 0}
              {...mouseProps(detailSelect)}
              renderLabel={(item, context) => (
                <text fg={context.titleColor}>
                  {drawn(item.label, contentWidth - 2)}
                </text>
              )}
            />
          </>
        )}
      </box>
    );
  return (
    <box flexDirection="column" maxHeight={bodyRows} overflow="hidden">
      <DialogSelect
        items={rows}
        activeIndex={list.activeIndex}
        scrollOffset={list.scrollOffset}
        maxItemsToShow={listWindow.maxItemsToShow}
        showNumbers={false}
        showScrollArrows={listWindow.showScrollArrows}
        focused={isActive && !busy}
        {...mouseProps(list)}
        renderLabel={(item, context) => (
          <box flexDirection="row">
            <text
              fg={item.kind === 'heading' ? C.accent : context.titleColor}
              attributes={item.kind === 'heading' ? 1 : undefined}
            >
              {drawn(
                item.label,
                item.right ? Math.max(1, rightWidth) : contentWidth - 2,
              )}
            </text>
            {item.right ? (
              <text fg={context.titleColor}>
                {' ' + drawn(item.right, rightWidth)}
              </text>
            ) : null}
          </box>
        )}
      />
    </box>
  );
}
