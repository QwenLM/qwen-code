/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import {
  EXTENSIONS_TABS,
  type ExtensionsTab,
  type ExtensionsTabDef,
} from './types.js';

interface TabBarProps {
  tabs: ExtensionsTabDef[];
  activeTab: ExtensionsTab;
  /** When false, the "tab to cycle" hint is dimmed to signal it is locked. */
  canSwitch: boolean;
}

// Literal t() calls keep the labels extractable for translation.
function tabLabel(id: ExtensionsTab): string {
  switch (id) {
    case EXTENSIONS_TABS.DISCOVER:
      return t('Discover');
    case EXTENSIONS_TABS.INSTALLED:
      return t('Installed');
    case EXTENSIONS_TABS.MARKETPLACES:
      return t('Sources');
    default:
      return id;
  }
}

export const TabBar = ({ tabs, activeTab, canSwitch }: TabBarProps) => (
  <Box>
    {tabs.map((tab) => {
      const isActive = tab.id === activeTab;
      return (
        <Box key={tab.id} marginRight={2}>
          {isActive ? (
            <Text
              bold
              backgroundColor={theme.text.accent}
              color={theme.background.primary}
            >
              {` ${tabLabel(tab.id)} `}
            </Text>
          ) : (
            <Text color={theme.text.secondary}>{` ${tabLabel(tab.id)} `}</Text>
          )}
        </Box>
      );
    })}
    <Text color={theme.text.secondary} dimColor={!canSwitch}>
      {t('(Tab / ←→ to switch)')}
    </Text>
  </Box>
);
