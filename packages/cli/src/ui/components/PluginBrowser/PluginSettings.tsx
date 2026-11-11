/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PluginBrowser — Root component for the interactive plugin management TUI.
 *
 * Renders a 4-tab dialog (Discover / Installed / Marketplaces / Errors)
 * using the same BaseTabDialog pattern as AgentBrowser, McpBrowser,
 * SkillBrowser, etc.
 */

import type React from 'react';
import { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Config, PluginError } from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { BaseTabDialog, type TabItem } from '../shared/BaseTabDialog.js';
import { parsePluginArgs, type ParsedCommand } from './parseArgs.js';
import { ManagePlugins } from './ManagePlugins.js';
import { DiscoverPlugins } from './DiscoverPlugins.js';
import { ManageMarketplaces } from './ManageMarketplaces.js';
import { ErrorsTab } from './ErrorsTab.js';
import { ValidatePlugin } from './ValidatePlugin.js';
import { BrowseMarketplace } from './BrowseMarketplace.js';
import { SHIFT_TAB_DISPLAY } from '../../constants/shortcuts.js';

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

export type TabId = 'discover' | 'installed' | 'marketplaces' | 'errors';

const TABS: TabItem[] = [
  { key: 'discover', label: 'Discover' },
  { key: 'installed', label: 'Installed' },
  { key: 'marketplaces', label: 'Marketplaces' },
  { key: 'errors', label: 'Errors' },
];

export function getPluginBrowserTabs(errorCount: number): TabItem[] {
  if (errorCount === 0) return TABS;

  const errorTab: TabItem = {
    key: 'errors',
    label: `Errors (${errorCount})`,
  };
  return TABS.map((tab) => (tab.key === 'errors' ? errorTab : tab));
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type ViewState =
  | { view: 'discover' }
  | { view: 'browse-marketplace'; marketplace: string }
  | { view: 'installed' }
  | { view: 'marketplaces' }
  | { view: 'add-marketplace'; source?: string }
  | { view: 'errors' }
  | { view: 'help' }
  | { view: 'validate'; path?: string };

function getInitialViewState(parsed: ParsedCommand): ViewState {
  switch (parsed.type) {
    case 'menu':
      return { view: 'discover' };
    case 'help':
      return { view: 'help' };
    case 'install':
      return { view: 'discover' };
    case 'manage':
      return { view: 'installed' };
    case 'uninstall':
      return { view: 'installed' };
    case 'enable':
      return { view: 'installed' };
    case 'disable':
      return { view: 'installed' };
    case 'validate':
      return { view: 'validate', path: parsed.path };
    case 'marketplace':
      if (parsed.action === 'add') {
        return { view: 'add-marketplace', source: parsed.target };
      }
      return { view: 'marketplaces' };
    default:
      return { view: 'discover' };
  }
}

function getInitialTab(viewState: ViewState): TabId {
  switch (viewState.view) {
    case 'discover':
    case 'browse-marketplace':
      return 'discover';
    case 'installed':
      return 'installed';
    case 'marketplaces':
    case 'add-marketplace':
      return 'marketplaces';
    case 'errors':
      return 'errors';
    case 'help':
    case 'validate':
      return 'discover';
    default:
      return 'discover';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PluginBrowserProps {
  config: Config | null;
  settings: LoadedSettings;
  args?: string;
  /** Plugin errors to display in the Errors tab + badge. */
  errors?: PluginError[];
  onExit: () => void;
}

// ---------------------------------------------------------------------------
// Placeholder tab content components
// ---------------------------------------------------------------------------

// DiscoverTab placeholder removed — uses DiscoverPlugins component directly.
// MarketplacesTab placeholder removed — uses ManageMarketplaces component directly.
// ErrorsTab placeholder removed — uses ErrorsTab component directly.

export function PluginBrowserHelp({
  onBack: _onBack,
}: {
  onBack: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        Plugin Commands
      </Text>
      <Text>{''}</Text>
      <Text> /plugins Open plugin browser</Text>
      <Text> /plugins manage Show installed plugins</Text>
      <Text> /plugins install Browse and install plugins</Text>
      <Text> /plugins uninstall Uninstall a plugin</Text>
      <Text> /plugins enable Enable a plugin</Text>
      <Text> /plugins disable Disable a plugin</Text>
      <Text> /plugins validate Validate a local plugin</Text>
      <Text> /plugins marketplace Manage marketplace sources</Text>
      <Text>{''}</Text>
      <Text dimColor>Press Esc to go back.</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function usePluginBrowserState({
  args,
  errors: _errors = [],
}: Pick<PluginBrowserProps, 'args' | 'errors'>) {
  const parsed = useMemo(() => parsePluginArgs(args), [args]);
  const initialViewState = useMemo(() => getInitialViewState(parsed), [parsed]);
  const [activeTab, setActiveTab] = useState<TabId>(() =>
    getInitialTab(initialViewState),
  );
  const [viewState, setViewState] = useState<ViewState>(initialViewState);

  // Track whether any plugin operation (install/uninstall/toggle) has been
  // performed in this session.  Used to show a persistent reload reminder.
  const [pluginsChanged, setPluginsChanged] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handlePluginsChanged = useCallback(() => {
    setPluginsChanged(true);
    setRefreshKey((k) => k + 1);
  }, []);

  // Dynamic tabs with error count badge
  const dynamicTabs = useMemo<TabItem[]>(
    () => getPluginBrowserTabs(_errors.length),
    [_errors.length],
  );

  const handleTabChange = useCallback((key: string) => {
    const tabId = key as TabId;
    setActiveTab(tabId);
    // Reset view state to match the tab
    switch (tabId) {
      case 'discover':
        setViewState({ view: 'discover' });
        break;
      case 'installed':
        setViewState({ view: 'installed' });
        break;
      case 'marketplaces':
        setViewState({ view: 'marketplaces' });
        break;
      case 'errors':
        setViewState({ view: 'errors' });
        break;
      default:
        break;
    }
  }, []);

  return {
    parsed,
    activeTab,
    viewState,
    dynamicTabs,
    handleTabChange,
    handlePluginsChanged,
    refreshKey,
    pluginsChanged,
    setViewState,
    setActiveTab,
  };
}

export function PluginBrowser({
  config,
  settings,
  args,
  errors: _errors = [],
  onExit,
}: PluginBrowserProps): React.ReactElement {
  const {
    parsed,
    activeTab,
    viewState,
    dynamicTabs,
    handleTabChange,
    handlePluginsChanged,
    refreshKey,
    pluginsChanged,
    setViewState,
    setActiveTab,
  } = usePluginBrowserState({ args, errors: _errors });
  // Render content based on view state
  let content: React.ReactElement;
  switch (viewState.view) {
    case 'help':
      content = (
        <PluginBrowserHelp
          onBack={() => {
            setViewState({ view: 'discover' });
            setActiveTab('discover');
          }}
        />
      );
      break;
    case 'discover':
      content = (
        <DiscoverPlugins
          config={config}
          settings={settings}
          onClose={onExit}
          onPluginsChanged={handlePluginsChanged}
          targetPlugin={parsed.type === 'install' ? parsed.plugin : undefined}
        />
      );
      break;
    case 'browse-marketplace':
      content = (
        <BrowseMarketplace
          marketplace={viewState.marketplace}
          config={config}
          settings={settings}
          onClose={() => {
            setViewState({ view: 'discover' });
            setActiveTab('discover');
          }}
          onPluginsChanged={handlePluginsChanged}
        />
      );
      break;
    case 'installed':
      content = (
        <ManagePlugins
          config={config}
          settings={settings}
          onClose={onExit}
          onPluginsChanged={handlePluginsChanged}
          refreshKey={refreshKey}
          targetPlugin={
            parsed.type === 'enable' ||
            parsed.type === 'disable' ||
            parsed.type === 'uninstall'
              ? parsed.plugin
              : undefined
          }
          targetAction={
            parsed.type === 'enable'
              ? 'enable'
              : parsed.type === 'disable'
                ? 'disable'
                : parsed.type === 'uninstall'
                  ? 'uninstall'
                  : undefined
          }
        />
      );
      break;
    case 'marketplaces':
    case 'add-marketplace':
      content = (
        <ManageMarketplaces
          config={config}
          settings={settings}
          onClose={onExit}
          addSource={
            viewState.view === 'add-marketplace' ? viewState.source : undefined
          }
        />
      );
      break;
    case 'errors':
      content = (
        <ErrorsTab
          errors={_errors}
          onNavigate={(tab) => handleTabChange(tab)}
        />
      );
      break;
    case 'validate':
      content = (
        <ValidatePlugin
          path={viewState.path}
          onClose={() => {
            setViewState({ view: 'discover' });
            setActiveTab('discover');
          }}
        />
      );
      break;
    default:
      content = (
        <DiscoverPlugins
          config={config}
          settings={settings}
          onClose={onExit}
          onPluginsChanged={handlePluginsChanged}
        />
      );
  }

  // Dynamic footer — append reload reminder when plugins have been changed
  const footer = pluginsChanged
    ? `Tab/${SHIFT_TAB_DISPLAY}: switch tabs · Esc: close · ⚠ Run /plugins reload to apply changes`
    : `Tab/${SHIFT_TAB_DISPLAY}: switch tabs · Esc: close`;

  return (
    <BaseTabDialog
      title="/plugins"
      tabs={dynamicTabs}
      activeKey={activeTab}
      onTabChange={handleTabChange}
      onClose={onExit}
      isActive={true}
      footer={footer}
    >
      {content}
    </BaseTabDialog>
  );
}
