/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { t } from '../../../i18n/index.js';
import {
  EXTENSIONS_TABS,
  type ExtensionsTab,
  type ExtensionsTabDef,
  type ExtensionsManagerDialogProps,
} from './types.js';
import { TabBar } from './TabBar.js';
import { DiscoverTab } from './tabs/DiscoverTab.js';
import { InstalledTab } from './tabs/InstalledTab.js';
import { MarketplacesTab } from './tabs/MarketplacesTab.js';

export interface StatusMessage {
  type: 'info' | 'success' | 'error';
  text: string;
}

const TABS: ExtensionsTabDef[] = [
  { id: EXTENSIONS_TABS.INSTALLED, label: 'Installed' },
  { id: EXTENSIONS_TABS.DISCOVER, label: 'Discover' },
  { id: EXTENSIONS_TABS.MARKETPLACES, label: 'Marketplaces' },
];

// Literal t() calls keep the footer hints extractable for translation.
function footerHint(tab: ExtensionsTab): string {
  switch (tab) {
    case EXTENSIONS_TABS.DISCOVER:
      return t(
        'Type to search · Space to toggle · Enter to view · Esc to go back',
      );
    case EXTENSIONS_TABS.INSTALLED:
      return t(
        '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
      );
    case EXTENSIONS_TABS.MARKETPLACES:
      return t('↑↓ navigate · Enter open · d remove · Esc close');
    default:
      return '';
  }
}

export function ExtensionsManagerDialog({
  onClose,
  config,
  initialTab,
}: ExtensionsManagerDialogProps) {
  const { extensionsUpdateState } = useUIState();
  const { columns } = useTerminalSize();
  const boxWidth = columns - 4;

  const [activeTab, setActiveTab] = useState<ExtensionsTab>(
    initialTab ?? EXTENSIONS_TABS.INSTALLED,
  );
  const [tabLocked, setTabLocked] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  // Bumped to force tabs to re-load when a cross-tab change happens
  // (e.g. installing from Discover should refresh Installed).
  const [reloadSignal, setReloadSignal] = useState(0);
  // When set, the Discover tab is restricted to this marketplace (set by the
  // Marketplaces tab's "Browse plugins" action; cleared on manual tab switch).
  const [discoverFilter, setDiscoverFilter] = useState<string | null>(null);

  const cycleTab = useCallback((direction: 1 | -1) => {
    setStatus(null);
    setDiscoverFilter(null);
    setActiveTab((current) => {
      const index = TABS.findIndex((tab) => tab.id === current);
      const next = (index + direction + TABS.length) % TABS.length;
      return TABS[next].id;
    });
  }, []);

  const handleBrowseMarketplace = useCallback((marketplaceName: string) => {
    setStatus(null);
    setTabLocked(false);
    setDiscoverFilter(marketplaceName);
    setActiveTab(EXTENSIONS_TABS.DISCOVER);
  }, []);

  const bumpReload = useCallback(() => {
    setReloadSignal((value) => value + 1);
  }, []);

  const handleLockChange = useCallback((locked: boolean) => {
    setTabLocked(locked);
  }, []);

  // Tab switching + close. Inactive while a tab owns a sub-view (locked).
  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        cycleTab(key.shift ? -1 : 1);
      } else if (key.name === 'right') {
        cycleTab(1);
      } else if (key.name === 'left') {
        cycleTab(-1);
      } else if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: !tabLocked },
  );

  if (!config) {
    return (
      <Box flexDirection="column" width={boxWidth}>
        <Box
          borderStyle="single"
          borderColor={theme.border.default}
          padding={1}
          width={boxWidth}
        >
          <Text color={theme.status.error}>
            {t('Extensions are not available in this environment.')}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={boxWidth}>
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        width={boxWidth}
        gap={1}
      >
        <TabBar tabs={TABS} activeTab={activeTab} canSwitch={!tabLocked} />

        <Box flexDirection="column">
          {activeTab === EXTENSIONS_TABS.DISCOVER && (
            <DiscoverTab
              config={config}
              isActive={activeTab === EXTENSIONS_TABS.DISCOVER}
              onLockChange={handleLockChange}
              onStatus={setStatus}
              onInstalled={bumpReload}
              marketplaceFilter={discoverFilter ?? undefined}
              reloadSignal={reloadSignal}
            />
          )}
          {activeTab === EXTENSIONS_TABS.INSTALLED && (
            <InstalledTab
              config={config}
              isActive={activeTab === EXTENSIONS_TABS.INSTALLED}
              onLockChange={handleLockChange}
              onStatus={setStatus}
              extensionsUpdateState={extensionsUpdateState}
              reloadSignal={reloadSignal}
            />
          )}
          {activeTab === EXTENSIONS_TABS.MARKETPLACES && (
            <MarketplacesTab
              config={config}
              isActive={activeTab === EXTENSIONS_TABS.MARKETPLACES}
              onLockChange={handleLockChange}
              onStatus={setStatus}
              onChanged={bumpReload}
              onBrowse={handleBrowseMarketplace}
              reloadSignal={reloadSignal}
            />
          )}
        </Box>

        {status && (
          <Text
            color={
              status.type === 'error'
                ? theme.status.error
                : status.type === 'success'
                  ? theme.status.success
                  : theme.text.secondary
            }
          >
            {status.text}
          </Text>
        )}

        <Text color={theme.text.secondary}>
          {tabLocked
            ? t('Enter to select · Esc to go back')
            : footerHint(activeTab)}
        </Text>
      </Box>
    </Box>
  );
}
