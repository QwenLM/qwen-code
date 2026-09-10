/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/extensions` dialog (audit 01 G-4 / 05 G-12):
 * the Installed / Discover / Sources tab shell with its cycling rules
 * (Tab/Shift+Tab/←/→, Discover's marketplace filter clears in place on Tab,
 * Esc to close, status message coloring) plus the Installed-tab management
 * keys the footer promises — ↑↓ navigate (wrap-around), Space enable/disable,
 * f favorite, Enter details. The detail view reproduces the ink
 * ExtensionActionsView stack: info panel + actions list, scope select, and a
 * y/n uninstall confirm. Discover/Sources degrade honestly (they say so —
 * no fake loading state, no fake footer hints). Rows and mutations are
 * backend work (dialog-data.ts); MCP servers are managed in the /mcp dialog.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { toOriginalKey } from './key-map.js';
import { useKeyboard } from '@opentui/react';
import { cycleTab } from './dialogs-core.js';
import {
  DialogSelect,
  useDialogSelect,
  type DialogListItem,
} from './dialogs-shared.js';
import type { ExtensionUpdateCheckState } from './dialog-data.js';

export const EXTENSIONS_TABS = {
  INSTALLED: 'installed',
  DISCOVER: 'discover',
  SOURCES: 'sources',
} as const;

export type ExtensionsTab =
  (typeof EXTENSIONS_TABS)[keyof typeof EXTENSIONS_TABS];

export const EXTENSIONS_TAB_ORDER: readonly ExtensionsTab[] = [
  EXTENSIONS_TABS.INSTALLED,
  EXTENSIONS_TABS.DISCOVER,
  EXTENSIONS_TABS.SOURCES,
];

/** Parity of tabLabel in extensions/TabBar.tsx. */
export function extensionsTabLabel(tab: ExtensionsTab): string {
  switch (tab) {
    case EXTENSIONS_TABS.DISCOVER:
      return t('Discover');
    case EXTENSIONS_TABS.INSTALLED:
      return t('Installed');
    case EXTENSIONS_TABS.SOURCES:
      return t('Sources');
    default:
      return tab;
  }
}

/**
 * Footer hint for the Installed tab (the original text). Discover/Sources
 * get an honest hint instead: their ink footers promise keys this renderer
 * does not implement, so repeating them would be a lie.
 */
export function extensionsFooterHint(tab: ExtensionsTab): string {
  switch (tab) {
    case EXTENSIONS_TABS.INSTALLED:
      return t(
        '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
      );
    case EXTENSIONS_TABS.DISCOVER:
    case EXTENSIONS_TABS.SOURCES:
      return t('Tab / ←→ to switch · Esc to close');
    default:
      return '';
  }
}

export interface ExtensionsStatusMessage {
  type: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

/** Parity of the status Text coloring in ExtensionsManagerDialog. */
export function extensionsStatusColor(status: ExtensionsStatusMessage): string {
  switch (status.type) {
    case 'error':
      return C.red;
    case 'warning':
      return C.yellow;
    case 'success':
      return C.green;
    default:
      return C.dim;
  }
}

export interface ExtensionRow {
  key: string;
  label: string;
  meta?: string;
  enabled?: boolean;
  favorite?: boolean;
  scope?: 'user' | 'project';
  version?: string;
  source?: string;
  origin?: string;
  components?: string;
}

/** Detail-view actions (parity of PluginDetailAction). */
export type ExtensionDetailAction =
  | 'toggle'
  | 'favorite'
  | 'change-scope'
  | 'mark-update'
  | 'update'
  | 'uninstall';

type InstalledView = 'list' | 'detail' | 'scope-select' | 'uninstall-confirm';

export interface OpenTuiExtensionsDialogProps {
  onClose: () => void;
  initialTab?: ExtensionsTab;
  status?: ExtensionsStatusMessage | null;
  /** True while a tab owns a sub-view (locks tab cycling). */
  tabLocked?: boolean;
  /** Optional tab-provided footer hint wins over the generic hint. */
  tabFooter?: string | null;
  /** Marketplace filter for the Discover tab (set via Sources "Browse"). */
  discoverFilter?: string | null;
  onDiscoverFilterChange?: (filter: string | null) => void;
  rowsByTab?: Partial<Record<ExtensionsTab, readonly ExtensionRow[]>>;
  /** Space / f on the highlighted Installed row. */
  onRowAction?: (row: ExtensionRow, action: 'toggle' | 'favorite') => void;
  /**
   * Detail-view actions. `mark-update` resolves to the check state so the
   * detail view can offer "Update Now" right away (ink checkedUpdateState).
   */
  onDetailAction?: (
    row: ExtensionRow,
    action: ExtensionDetailAction,
    arg?: 'user' | 'project',
  ) =>
    | Promise<ExtensionUpdateCheckState | void>
    | ExtensionUpdateCheckState
    | void;
  /** True while a mutation is in flight (mashing Space is ignored). */
  busy?: boolean;
}

export function OpenTuiExtensionsDialog(props: OpenTuiExtensionsDialogProps) {
  const {
    onClose,
    initialTab,
    status,
    tabLocked = false,
    tabFooter,
    discoverFilter: discoverFilterProp,
    onDiscoverFilterChange,
    rowsByTab,
    onRowAction,
    onDetailAction,
    busy = false,
  } = props;

  const [activeTab, setActiveTab] = useState<ExtensionsTab>(
    initialTab ?? EXTENSIONS_TABS.INSTALLED,
  );
  const [discoverFilter, setDiscoverFilter] = useState<string | null>(
    discoverFilterProp ?? null,
  );
  const [view, setView] = useState<InstalledView>('list');
  // Selected row tracked by key: rows are re-read after every mutation, so
  // keying keeps the cursor (and any open detail view) on the SAME item even
  // when it moves or changes state.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checkedUpdateState, setCheckedUpdateState] = useState<
    ExtensionUpdateCheckState | undefined
  >(undefined);

  const clearDiscoverFilter = useCallback(() => {
    setDiscoverFilter(null);
    onDiscoverFilterChange?.(null);
  }, [onDiscoverFilterChange]);

  const cycle = useCallback((direction: 1 | -1) => {
    setDiscoverFilter(null);
    setActiveTab((current) =>
      cycleTab(EXTENSIONS_TAB_ORDER, current, direction),
    );
  }, []);

  const rows: readonly ExtensionRow[] = useMemo(
    () => rowsByTab?.[EXTENSIONS_TABS.INSTALLED] ?? [],
    [rowsByTab],
  );
  const currentRow = useMemo(
    () =>
      selectedKey
        ? (rows.find((row) => row.key === selectedKey) ?? null)
        : null,
    [rows, selectedKey],
  );

  // A reload that removed the item whose detail is open falls back to the
  // list (ink parity) — otherwise the view stays locked with no target.
  useEffect(() => {
    if (view !== 'list' && !currentRow) {
      setView('list');
      setSelectedKey(null);
    }
  }, [view, currentRow]);

  const listItems: Array<DialogListItem<string> & { row: ExtensionRow }> =
    useMemo(
      () =>
        rows.map((row) => ({
          key: row.key,
          value: row.key,
          row,
        })),
      [rows],
    );

  const listSelect = useDialogSelect({
    items: listItems,
    numbers: false,
    focused: activeTab === EXTENSIONS_TABS.INSTALLED && view === 'list',
    onSelect: (key) => {
      setSelectedKey(key);
      setCheckedUpdateState(undefined);
      setView('detail');
    },
  });

  const detailActions = useMemo(() => {
    if (!currentRow) return [];
    const enabled = currentRow.enabled !== false;
    const items: Array<
      DialogListItem<ExtensionDetailAction> & { label: string }
    > = [
      {
        key: 'toggle',
        value: 'toggle',
        label: enabled ? t('Disable') : t('Enable'),
      },
      {
        key: 'favorite',
        value: 'favorite',
        label: currentRow.favorite
          ? t('Remove from Favorites')
          : t('Add to Favorites'),
      },
      {
        key: 'change-scope',
        value: 'change-scope',
        label: t('Change scope'),
      },
      {
        key: 'mark-update',
        value: 'mark-update',
        label: t('Mark for Update'),
      },
    ];
    if (checkedUpdateState === 'update-available') {
      items.push({
        key: 'update',
        value: 'update',
        label: t('Update Now'),
      });
    }
    items.push({
      key: 'uninstall',
      value: 'uninstall',
      label: t('Uninstall'),
    });
    return items;
  }, [currentRow, checkedUpdateState]);

  const detailSelect = useDialogSelect({
    items: detailActions,
    // Re-sync the cursor when re-entering detail: the action list shrinks
    // (checked-update state resets) so the stale activeIndex can be out of
    // range — Enter would read items[5] = undefined.
    resyncKey: view,
    numbers: false,
    focused: view === 'detail',
    onSelect: (action) => {
      if (!currentRow) return;
      if (action === 'change-scope') {
        setView('scope-select');
        return;
      }
      if (action === 'uninstall') {
        setView('uninstall-confirm');
        return;
      }
      if (action === 'mark-update') {
        void Promise.resolve(onDetailAction?.(currentRow, 'mark-update'))
          .then((state) => {
            if (state) setCheckedUpdateState(state);
          })
          .catch(() => {});
        return;
      }
      void Promise.resolve(onDetailAction?.(currentRow, action)).catch(
        () => {},
      );
    },
  });

  const scopeItems = useMemo<
    Array<DialogListItem<'user' | 'project'> & { label: string }>
  >(
    () => [
      {
        key: 'user',
        value: 'user' as const,
        label: t('Global (User Scope)'),
      },
      {
        key: 'project',
        value: 'project' as const,
        label: t('Project (Workspace)'),
      },
    ],
    [],
  );

  const scopeSelect = useDialogSelect({
    items: scopeItems,
    numbers: false,
    // Default the cursor to the current scope so the user sees what is in
    // effect (ink scopeItems initialIndex parity).
    initialIndex: currentRow?.scope === 'project' ? 1 : 0,
    // ink remounts the radio select on every scope-view entry; resync on
    // entry re-applies the live-scope initialIndex (the mount-time lazy
    // initializer runs before any row is selected).
    resyncKey: view,
    focused: view === 'scope-select',
    onSelect: (scope) => {
      if (currentRow)
        void Promise.resolve(
          onDetailAction?.(currentRow, 'change-scope', scope),
        ).catch(() => {});
      setView('detail');
    },
  });

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    const name = original.name;

    if (view !== 'list') {
      // Locked sub-view: Esc walks back one level; Tab/←→ stay inert.
      if (name === 'escape') {
        setView((current) => (current === 'detail' ? 'list' : 'detail'));
        return;
      }
      if (view === 'uninstall-confirm') {
        // y/Enter confirms (ink UninstallConfirmStep), n backs out.
        if (original.sequence === 'y' || name === 'return') {
          if (currentRow)
            void Promise.resolve(
              onDetailAction?.(currentRow, 'uninstall'),
            ).catch(() => {});
          setView('list');
        } else if (original.sequence === 'n') {
          setView('detail');
        }
      }
      return;
    }

    if (tabLocked) return;
    if (name === 'tab') {
      // On Discover with an active marketplace filter, Tab clears the
      // filter in place instead of leaving the tab — the "(Tab to clear)"
      // promise from the original.
      if (activeTab === EXTENSIONS_TABS.DISCOVER && discoverFilter) {
        clearDiscoverFilter();
      } else {
        cycle(original.shift ? -1 : 1);
      }
    } else if (name === 'right') {
      cycle(1);
    } else if (name === 'left') {
      cycle(-1);
    } else if (name === 'escape') {
      onClose();
    } else if (activeTab === EXTENSIONS_TABS.INSTALLED && !busy) {
      const row = listItems[listSelect.activeIndex]?.row;
      if (!row) return;
      if (name === 'space' || original.sequence === ' ') {
        onRowAction?.(row, 'toggle');
      } else if (
        original.sequence === 'f' &&
        !original.ctrl &&
        !original.meta
      ) {
        onRowAction?.(row, 'favorite');
      }
    }
  });

  const hint =
    tabFooter ??
    (tabLocked || view !== 'list'
      ? t('Enter to select · Esc to go back')
      : extensionsFooterHint(activeTab));

  const renderInstalledContent = () => {
    if (view === 'detail' && currentRow) {
      const enabled = currentRow.enabled !== false;
      return (
        <box flexDirection="column">
          <box flexDirection="column">
            <box flexDirection="row">
              <box width={10} flexShrink={0}>
                <text fg={C.text}>{t('Name:')}</text>
              </box>
              <text fg={C.text}>{currentRow.label}</text>
            </box>
            {currentRow.version !== undefined && (
              <box flexDirection="row">
                <box width={10} flexShrink={0}>
                  <text fg={C.text}>{t('Version:')}</text>
                </box>
                <text fg={C.text}>{currentRow.version}</text>
              </box>
            )}
            <box flexDirection="row">
              <box width={10} flexShrink={0}>
                <text fg={C.text}>{t('Scope:')}</text>
              </box>
              <text fg={C.text}>
                {currentRow.scope === 'project' ? t('Project') : t('User')}
              </text>
            </box>
            <box flexDirection="row">
              <box width={10} flexShrink={0}>
                <text fg={C.text}>{t('Status:')}</text>
              </box>
              <text fg={enabled ? C.green : C.dim}>
                {enabled ? t('active') : t('disabled')}
              </text>
              {currentRow.favorite ? <text fg={C.yellow}> ★</text> : null}
            </box>
            {currentRow.source && (
              <box flexDirection="row">
                <box width={10} flexShrink={0}>
                  <text fg={C.text}>{t('Source:')}</text>
                </box>
                <text fg={C.text}>{currentRow.source}</text>
              </box>
            )}
            {currentRow.origin && (
              <box flexDirection="row">
                <box width={10} flexShrink={0}>
                  <text fg={C.text}>{t('Origin:')}</text>
                </box>
                <text fg={C.text}>{currentRow.origin}</text>
              </box>
            )}
            <box flexDirection="row">
              <box width={10} flexShrink={0}>
                <text fg={C.text}>{t('Components:')}</text>
              </box>
              <text fg={C.text}>{currentRow.components ?? t('None')}</text>
            </box>
          </box>
          <box marginTop={1} flexDirection="column">
            <text fg={C.dim}>{t('Actions')}</text>
            <DialogSelect
              items={detailActions}
              activeIndex={detailSelect.activeIndex}
              scrollOffset={detailSelect.scrollOffset}
              showNumbers={false}
              showScrollArrows
              focused={view === 'detail'}
              onHover={detailSelect.highlightIndex}
              onWheel={(direction) =>
                detailSelect.highlightIndex(
                  Math.max(
                    0,
                    Math.min(
                      detailActions.length - 1,
                      detailSelect.activeIndex +
                        (direction === 'down' ? 1 : -1),
                    ),
                  ),
                )
              }
              onSelectIndex={detailSelect.selectIndex}
              renderLabel={(item, context) => (
                <text fg={context.titleColor}>{item.label}</text>
              )}
            />
          </box>
        </box>
      );
    }

    if (view === 'scope-select' && currentRow) {
      return (
        <box flexDirection="column">
          <text fg={C.text}>
            {t('Change scope for "{{name}}":', { name: currentRow.label })}
          </text>
          <DialogSelect
            items={scopeItems}
            activeIndex={scopeSelect.activeIndex}
            scrollOffset={scopeSelect.scrollOffset}
            showNumbers={false}
            focused={view === 'scope-select'}
            onHover={scopeSelect.highlightIndex}
            onWheel={(direction) =>
              scopeSelect.highlightIndex(
                Math.max(
                  0,
                  Math.min(
                    scopeItems.length - 1,
                    scopeSelect.activeIndex + (direction === 'down' ? 1 : -1),
                  ),
                ),
              )
            }
            onSelectIndex={scopeSelect.selectIndex}
            renderLabel={(item, context) => (
              <text fg={context.titleColor}>{item.label}</text>
            )}
          />
        </box>
      );
    }

    if (view === 'uninstall-confirm' && currentRow) {
      return (
        <box flexDirection="column">
          <text fg={C.red}>
            {t('Are you sure you want to uninstall extension "{{name}}"?', {
              name: currentRow.label,
            })}
          </text>
          <text fg={C.red}>
            {t('Note: Uninstall permanently removes this extension.')}
          </text>
          <text fg={C.dim}>{t('y to confirm · n/Esc to go back')}</text>
        </box>
      );
    }

    if (rows.length === 0) {
      return <text fg={C.dim}>{t('No extensions installed.')}</text>;
    }

    return (
      <DialogSelect
        items={listItems}
        activeIndex={listSelect.activeIndex}
        scrollOffset={listSelect.scrollOffset}
        showNumbers={false}
        showScrollArrows
        focused={activeTab === EXTENSIONS_TABS.INSTALLED && view === 'list'}
        onHover={listSelect.highlightIndex}
        onWheel={(direction) =>
          listSelect.highlightIndex(
            Math.max(
              0,
              Math.min(
                listItems.length - 1,
                listSelect.activeIndex + (direction === 'down' ? 1 : -1),
              ),
            ),
          )
        }
        onSelectIndex={listSelect.selectIndex}
        renderLabel={(item, context) => {
          const row = item.row;
          const enabled = row.enabled !== false;
          const color = context.isSelected ? C.green : enabled ? C.text : C.dim;
          return (
            <box flexDirection="row">
              <box flexGrow={1}>
                <text fg={color}>{row.label}</text>
                {row.favorite ? <text fg={C.yellow}> ★</text> : null}
              </box>
              <text fg={context.isSelected ? C.green : C.dim}>
                {row.scope === 'project' ? ` (${t('project')})` : ''}
                {enabled ? ` (${t('active')})` : ` (${t('disabled')})`}
              </text>
            </box>
          );
        }}
      />
    );
  };

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={C.dim}
      paddingX={1}
    >
      <box flexDirection="row">
        {EXTENSIONS_TAB_ORDER.map((tab) => {
          const isActive = tab === activeTab;
          return (
            <box key={tab} marginRight={2}>
              <text
                fg={isActive ? '#000000' : C.dim}
                bg={isActive ? C.accent : undefined}
                attributes={isActive ? 1 : undefined}
              >
                {` ${extensionsTabLabel(tab)} `}
              </text>
            </box>
          );
        })}
        <text fg={tabLocked || view !== 'list' ? '#555555' : C.dim}>
          {t('(Tab / ←→ to switch)')}
        </text>
      </box>

      <box marginTop={1} flexDirection="column">
        {activeTab === EXTENSIONS_TABS.DISCOVER && discoverFilter ? (
          <text fg={C.dim}>
            {t('Marketplace: {{name}}', { name: discoverFilter })}{' '}
            {t('(Tab to clear)')}
          </text>
        ) : null}
        {activeTab === EXTENSIONS_TABS.DISCOVER ? (
          <box flexDirection="column">
            <text fg={C.dim}>
              {t('Discover is not yet available in the OpenTUI renderer.')}
            </text>
            <text fg={C.dim}>
              {t('Manage installed extensions on the Installed tab.')}
            </text>
          </box>
        ) : activeTab === EXTENSIONS_TABS.SOURCES ? (
          <text fg={C.dim}>
            {t(
              'Marketplace sources are not yet available in the OpenTUI renderer.',
            )}
          </text>
        ) : (
          renderInstalledContent()
        )}
      </box>

      {status && (
        <box marginTop={1}>
          <text fg={extensionsStatusColor(status)}>{status.text}</text>
        </box>
      )}

      <box marginTop={1}>
        <text fg={C.dim}>{hint}</text>
      </box>
    </box>
  );
}
