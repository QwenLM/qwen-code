/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import { SectionHeader } from './shared/SectionHeader.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { Command } from '../key/keyBindings.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { useI18nService } from '../i18n/index.js';

type ShortcutItem = {
  key: string;
  description: string;
};

const buildShortcutItems = (t: I18nService['get']): ShortcutItem[] => [
  { key: '!', description: t('shortcuts.shellMode') },
  { key: '@', description: t('shortcuts.selectPath') },
  { key: 'Double Esc', description: t('shortcuts.clearRewind') },
  {
    key: formatCommand(Command.TOGGLE_YOLO),
    description: t('shortcuts.yoloMode'),
  },
  {
    key: formatCommand(Command.CYCLE_PERMISSION_MODE),
    description: t('shortcuts.cycleMode'),
  },
  {
    key: formatCommand(Command.PASTE_CLIPBOARD_IMAGE),
    description: t('shortcuts.pasteImages'),
  },
  {
    key: formatCommand(Command.TOGGLE_MARKDOWN),
    description: t('shortcuts.rawMarkdown'),
  },
  {
    key: formatCommand(Command.REVERSE_SEARCH),
    description: t('shortcuts.reverseSearch'),
  },
  {
    key: formatCommand(Command.OPEN_EXTERNAL_EDITOR),
    description: t('shortcuts.externalEditor'),
  },
  { key: '/btw', description: t('shortcuts.sideQuestion') },
];

const Shortcut: React.FC<{ item: ShortcutItem }> = ({ item }) => (
  <Box flexDirection="row">
    <Box flexShrink={0} marginRight={1}>
      <Text color={theme.text.accent}>{item.key}</Text>
    </Box>
    <Box flexGrow={1}>
      <Text color={theme.text.primary}>{item.description}</Text>
    </Box>
  </Box>
);

export const ShortcutsHelp: React.FC = () => {
  const { terminalWidth } = useUIState();
  const i18n = useI18nService();
  const isNarrow = isNarrowWidth(terminalWidth);
  const items = buildShortcutItems(i18n.get);
  const itemsForDisplay = isNarrow
    ? items
    : [
        // Keep first column stable: !, @, Esc Esc, Tab Tab, /btw.
        // 3 columns, filled row by row:
        items[0],
        items[5],
        items[6],
        items[1],
        items[4],
        items[7],
        items[2],
        items[8],
        items[3],
        items[9],
      ];

  return (
    <Box flexDirection="column" width="100%">
      <SectionHeader
        title={i18n.get('shortcuts.title')}
        subtitle={i18n.get('shortcuts.subtitle')}
      />
      <Box flexDirection="row" flexWrap="wrap" paddingLeft={1} paddingRight={2}>
        {itemsForDisplay.map((item, index) => (
          <Box
            key={`${item.key}-${index}`}
            width={isNarrow ? '100%' : '33%'}
            paddingRight={isNarrow ? 0 : 2}
          >
            <Shortcut item={item} />
          </Box>
        ))}
      </Box>
    </Box>
  );
};
