/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { Command } from '../key/keyBindings.js';
import { getNewlineShortcut } from '../constants/shortcuts.js';
import { formatLocalizedShortcutHint, useI18nService } from '../i18n/index.js';

interface HelpProps {
  onClose?: () => void;
}

/** A single row: left = key (secondary bold), right = description (primary) */
const Row: React.FC<{ label: string; desc: string }> = ({ label, desc }) => (
  <Box flexDirection="row">
    <Box width="30%">
      <Text bold color={theme.text.secondary}>
        {label}
      </Text>
    </Box>
    <Text color={theme.text.primary}>{desc}</Text>
  </Box>
);

/** Section heading */
const SectionHeading: React.FC<{ children: string }> = ({ children }) => (
  <Text bold color={theme.text.primary}>
    {children}
  </Text>
);

export const Help: React.FC<HelpProps> = ({ onClose }) => {
  const i18n = useI18nService();

  return (
    <BaseTabDialog
      title={i18n.get('help.title')}
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      footer={formatLocalizedShortcutHint(i18n.get, 'GO_BACK')}
    >
      {/* ── Basics ── */}
      <SectionHeading>{i18n.get('help.section.basics')}</SectionHeading>
      <Row label="@src/myFile.ts" desc={i18n.get('help.basics.context')} />
      <Row label="!npm run start" desc={i18n.get('help.basics.shell')} />
      <Row label="/commands" desc={i18n.get('help.basics.commands')} />

      <Box height={1} />

      {/* ── Keyboard Shortcuts ── */}
      <SectionHeading>
        {i18n.get('help.section.keyboardShortcuts')}
      </SectionHeading>
      <Row
        label={i18n.get('help.shortcut.newline.label', {
          shortcut: getNewlineShortcut(),
        })}
        desc={i18n.get('help.shortcut.newline.description')}
      />
      <Row
        label={formatCommand(Command.SUBMIT)}
        desc={i18n.get('help.shortcut.submit')}
      />
      <Row
        label={formatCommand(Command.ESCAPE)}
        desc={i18n.get('help.shortcut.escape')}
      />
      <Row
        label={`${formatCommand(Command.PAGE_UP)}/${formatCommand(Command.PAGE_DOWN)}`}
        desc={i18n.get('help.shortcut.page')}
      />
      <Row
        label={`${formatCommand(Command.HISTORY_UP)}/${formatCommand(Command.HISTORY_DOWN)}`}
        desc={i18n.get('help.shortcut.history')}
      />
      <Row
        label={formatCommand(Command.OPEN_EXTERNAL_EDITOR)}
        desc={i18n.get('help.shortcut.editor')}
      />
      <Row
        label={formatCommand(Command.CYCLE_PERMISSION_MODE)}
        desc={i18n.get('help.shortcut.permissionMode')}
      />
      <Row
        label={formatCommand(Command.TOGGLE_YOLO)}
        desc={i18n.get('help.shortcut.yolo')}
      />
      <Row
        label={formatCommand(Command.CLEAR_SCREEN)}
        desc={i18n.get('help.shortcut.clear')}
      />
      <Row
        label={formatCommand(Command.QUIT)}
        desc={i18n.get('help.shortcut.quit')}
      />
    </BaseTabDialog>
  );
};
