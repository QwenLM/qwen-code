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
import { SourcesTab } from './tabs/SourcesTab.js';
import { ConsentPrompt } from '../ConsentPrompt.js';
import { SettingInputPrompt } from '../SettingInputPrompt.js';
import { PluginChoicePrompt } from '../PluginChoicePrompt.js';

export interface StatusMessage {
  type: 'info' | 'success' | 'error';
  text: string;
}

const TABS: ExtensionsTabDef[] = [
  { id: EXTENSIONS_TABS.INSTALLED, label: 'Installed' },
  { id: EXTENSIONS_TABS.DISCOVER, label: 'Discover' },
  { id: EXTENSIONS_TABS.SOURCES, label: 'Sources' },
];

// Literal t() calls keep the footer hints extractable for translation.
function footerHint(tab: ExtensionsTab): string {
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

export function ExtensionsManagerDialog({
  onClose,
  config,
  initialTab,
}: ExtensionsManagerDialogProps) {
  const {
    extensionsUpdateState,
    confirmUpdateExtensionRequests,
    settingInputRequests,
    pluginChoiceRequests,
  } = useUIState();
  const { columns } = useTerminalSize();
  const boxWidth = columns - 4;

  // Install flows raise interactive requests (consent, setting input, plugin
  // choice). They are rendered here, inside the dialog, so the dialog stays
  // mounted and keeps its tab/list state; DialogManager skips them while this
  // dialog is open. (Unmounting would reset the active tab and drop the
  // reload signal that refreshes the Installed tab after an install.)
  const consentRequest = confirmUpdateExtensionRequests?.[0];
  const settingRequest = settingInputRequests?.[0];
  const pluginChoiceRequest = pluginChoiceRequests?.[0];
  const hasPendingRequest =
    !!consentRequest || !!settingRequest || !!pluginChoiceRequest;

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
  // Optional context-aware footer hint provided by the active tab.
  const [tabFooter, setTabFooter] = useState<string | null>(null);

  const cycleTab = useCallback((direction: 1 | -1) => {
    setStatus(null);
    setDiscoverFilter(null);
    setTabFooter(null);
    setActiveTab((current) => {
      const index = TABS.findIndex((tab) => tab.id === current);
      const next = (index + direction + TABS.length) % TABS.length;
      return TABS[next].id;
    });
  }, []);

  const handleBrowseSource = useCallback((marketplaceName: string) => {
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
    { isActive: !tabLocked && !hasPendingRequest },
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
      {consentRequest ? (
        <ConsentPrompt
          prompt={consentRequest.prompt}
          onConfirm={consentRequest.onConfirm}
          terminalWidth={boxWidth}
        />
      ) : settingRequest ? (
        <SettingInputPrompt
          key={settingRequest.settingName}
          settingName={settingRequest.settingName}
          settingDescription={settingRequest.settingDescription}
          sensitive={settingRequest.sensitive}
          onSubmit={settingRequest.onSubmit}
          onCancel={settingRequest.onCancel}
          terminalWidth={boxWidth}
        />
      ) : pluginChoiceRequest ? (
        <PluginChoicePrompt
          key={pluginChoiceRequest.marketplaceName}
          marketplaceName={pluginChoiceRequest.marketplaceName}
          plugins={pluginChoiceRequest.plugins}
          onSelect={pluginChoiceRequest.onSelect}
          onCancel={pluginChoiceRequest.onCancel}
          terminalWidth={boxWidth}
        />
      ) : null}
      <Box
        display={hasPendingRequest ? 'none' : 'flex'}
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
              isActive={
                activeTab === EXTENSIONS_TABS.DISCOVER && !hasPendingRequest
              }
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
              isActive={
                activeTab === EXTENSIONS_TABS.INSTALLED && !hasPendingRequest
              }
              onLockChange={handleLockChange}
              onStatus={setStatus}
              extensionsUpdateState={extensionsUpdateState}
              reloadSignal={reloadSignal}
            />
          )}
          {activeTab === EXTENSIONS_TABS.SOURCES && (
            <SourcesTab
              config={config}
              isActive={
                activeTab === EXTENSIONS_TABS.SOURCES && !hasPendingRequest
              }
              onLockChange={handleLockChange}
              onStatus={setStatus}
              onChanged={bumpReload}
              onBrowse={handleBrowseSource}
              onFooter={setTabFooter}
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
          {/* A tab-provided hint wins even while a sub-view is locked, so a
              locked view (e.g. a failed marketplace load offering R to retry)
              can surface its own footer instead of the generic locked text. */}
          {tabFooter ??
            (tabLocked
              ? t('Enter to select · Esc to go back')
              : footerHint(activeTab))}
        </Text>
      </Box>
    </Box>
  );
}
