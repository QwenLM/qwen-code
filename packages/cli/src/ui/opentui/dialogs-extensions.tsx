/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink `/extensions` dialog shell
 * (ui/components/extensions/ExtensionsManagerDialog.tsx): the Installed /
 * Discover / Sources tab bar with its cycling rules (Tab/Shift+Tab/←/→,
 * Discover's marketplace filter clears in place on Tab instead of leaving
 * the tab), Esc to close, the exact per-tab footer hints, status message
 * coloring, and the locked-sub-view footer. Tab content rows are supplied
 * by the backend; the install/enable flows themselves are backend work.
 */

import { useCallback, useState } from 'react';
import { C } from './theme.js';
import { t } from '../../i18n/index.js';
import { toOriginalKey } from './key-map.js';
import { useKeyboard } from '@opentui/react';
import { cycleTab } from './dialogs-core.js';

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

/** Parity of footerHint in ExtensionsManagerDialog.tsx. */
export function extensionsFooterHint(tab: ExtensionsTab): string {
  switch (tab) {
    case EXTENSIONS_TABS.DISCOVER:
      return t(
        'Type to search · Space to toggle · Enter to view · Ctrl+R refresh · Esc to go back',
      );
    case EXTENSIONS_TABS.INSTALLED:
      return t(
        '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
      );
    case EXTENSIONS_TABS.SOURCES:
      return t('↑↓ navigate · Enter select · d remove marketplace · Esc close');
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
}

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
  } = props;

  const [activeTab, setActiveTab] = useState<ExtensionsTab>(
    initialTab ?? EXTENSIONS_TABS.INSTALLED,
  );
  const [discoverFilter, setDiscoverFilter] = useState<string | null>(
    discoverFilterProp ?? null,
  );

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

  useKeyboard((key) => {
    if (tabLocked) return;
    const original = toOriginalKey(key);
    if (original.name === 'tab') {
      // On Discover with an active marketplace filter, Tab clears the
      // filter in place instead of leaving the tab — the "(Tab to clear)"
      // promise from the original.
      if (activeTab === EXTENSIONS_TABS.DISCOVER && discoverFilter) {
        clearDiscoverFilter();
      } else {
        cycle(original.shift ? -1 : 1);
      }
    } else if (original.name === 'right') {
      cycle(1);
    } else if (original.name === 'left') {
      cycle(-1);
    } else if (original.name === 'escape') {
      onClose();
    }
  });

  const rows: readonly ExtensionRow[] = rowsByTab?.[activeTab] ?? [];
  const hint =
    tabFooter ??
    (tabLocked
      ? t('Enter to select · Esc to go back')
      : extensionsFooterHint(activeTab));

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
        <text fg={tabLocked ? '#555555' : C.dim}>
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
        {rows.length === 0 ? (
          <text fg={C.dim}>
            {activeTab === EXTENSIONS_TABS.INSTALLED
              ? t('No extensions installed.')
              : t('Loading…')}
          </text>
        ) : (
          rows.map((row) => (
            <box key={row.key} flexDirection="row">
              <text fg={row.enabled === false ? C.dim : C.text}>
                {row.label}
              </text>
              {row.meta ? <text fg={C.dim}> {row.meta}</text> : null}
              {row.favorite ? <text fg={C.yellow}> ★</text> : null}
            </box>
          ))
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
