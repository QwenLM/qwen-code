/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import { theme } from '../semantic-colors.js';
import stripAnsi from 'strip-ansi';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { Scrollable } from './shared/Scrollable.js';
import { gracefulExit } from '../../utils/cleanup.js';
import {
  ExitCodes,
  BRAND_CLI_NAME,
  type FolderDiscoveryResults,
  sessionLogger,
} from '@qwen-code/core';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { useI18nService } from '../i18n/index.js';

export enum FolderTrustChoice {
  TRUST_FOLDER = 'trust_folder',
  DO_NOT_TRUST = 'do_not_trust',
}

interface FolderTrustDialogProps {
  onSelect: (choice: FolderTrustChoice) => void;
  discoveryResults?: FolderDiscoveryResults | null;
}

export const FolderTrustDialog: React.FC<FolderTrustDialogProps> = ({
  onSelect,
  discoveryResults,
}) => {
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const config = useConfig();
  const [exiting, setExiting] = useState(false);
  const exitStartedRef = useRef(false);
  const { terminalHeight } = useUIState();
  const isAlternateBuffer = useAlternateBuffer();

  const handleExit = useCallback(() => {
    if (exitStartedRef.current) return;
    exitStartedRef.current = true;
    setExiting(true);
    // Give time for the UI to render the exiting message
    setTimeout(async () => {
      sessionLogger.setExitContext({
        reason: 'cancelled',
        exit_code: ExitCodes.FATAL_CANCELLATION_ERROR,
        message: 'User declined to trust the current folder',
        source: 'ui.folderTrust',
      });
      await gracefulExit(ExitCodes.FATAL_CANCELLATION_ERROR, {
        exitReason: 'user_quit',
      });
    }, 100);
  }, []);

  const projectRoot = config.storage.getProjectRoot();

  const handleSelect = useCallback(
    (choice: FolderTrustChoice) => {
      if (choice === FolderTrustChoice.DO_NOT_TRUST) {
        handleExit();
        return;
      }
      onSelect(choice);
    },
    [onSelect, handleExit],
  );

  const options: Array<RadioSelectItem<FolderTrustChoice>> = [
    {
      label: i18n.get('trust.action.trust'),
      value: FolderTrustChoice.TRUST_FOLDER,
      key: 'Trust folder',
    },
    {
      label: i18n.get('trust.action.exit'),
      value: FolderTrustChoice.DO_NOT_TRUST,
      key: "Don't trust and exit",
    },
  ];

  const hasDiscovery =
    discoveryResults &&
    (discoveryResults.commands.length > 0 ||
      discoveryResults.mcps.length > 0 ||
      discoveryResults.hooks.length > 0 ||
      discoveryResults.skills.length > 0 ||
      discoveryResults.settings.length > 0);

  const hasWarnings =
    discoveryResults && discoveryResults.securityWarnings.length > 0;

  const hasErrors =
    discoveryResults &&
    discoveryResults.discoveryErrors &&
    discoveryResults.discoveryErrors.length > 0;

  // Header: 3 lines (title + separator + margin)
  // Options: options.length + 2 lines for margins
  // Footer: 1 line
  // Border: 2 lines (top + bottom when borderColor is set)
  // Safety margin: 2 lines
  const overhead = 3 + options.length + 2 + 1 + 2 + 2;
  const scrollableHeight = Math.max(4, terminalHeight - overhead);

  const groups = [
    {
      label: i18n.get('trust.group.commands'),
      items: discoveryResults?.commands ?? [],
    },
    { label: i18n.get('trust.group.mcp'), items: discoveryResults?.mcps ?? [] },
    {
      label: i18n.get('trust.group.hooks'),
      items: discoveryResults?.hooks ?? [],
    },
    {
      label: i18n.get('trust.group.skills'),
      items: discoveryResults?.skills ?? [],
    },
    {
      label: i18n.get('trust.group.agents'),
      items: discoveryResults?.agents ?? [],
    },
    {
      label: i18n.get('trust.group.settings'),
      items: discoveryResults?.settings ?? [],
    },
  ].filter((g) => g.items.length > 0);

  const discoveryContent = (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.text.primary}>
          {i18n.get('trust.description', { cli: BRAND_CLI_NAME })}
        </Text>
      </Box>

      {hasErrors && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.status.error} bold>
            {i18n.get('trust.discoveryErrors')}
          </Text>
          {discoveryResults.discoveryErrors.map((error, i) => (
            <Box key={i} marginLeft={2}>
              <Text color={theme.status.error}>• {stripAnsi(error)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {hasWarnings && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.status.warning} bold>
            {i18n.get('trust.securityWarnings')}
          </Text>
          {discoveryResults.securityWarnings.map((warning, i) => (
            <Box key={i} marginLeft={2}>
              <Text color={theme.status.warning}>• {stripAnsi(warning)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {hasDiscovery && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.text.primary} bold>
            {i18n.get('trust.contains')}
          </Text>
          {groups.map((group) => (
            <Box key={group.label} flexDirection="column" marginLeft={2}>
              <Text color={theme.text.primary} bold>
                • {group.label} ({group.items.length}):
              </Text>
              {group.items.map((item, idx) => (
                <Box key={idx} marginLeft={2}>
                  <Text color={theme.text.primary}>- {stripAnsi(item)}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );

  const selectOptions = (
    <RadioButtonSelect
      items={options}
      onSelect={handleSelect}
      isFocused={true}
    />
  );

  const extraHints = useMemo(
    () => [
      { label: getUiText('auth.hint.navigate'), order: 20 },
      { label: getUiText('auth.hint.select'), order: 30 },
    ],
    [getUiText],
  );

  const renderContentBody = () => {
    if (isAlternateBuffer) {
      return (
        <Box flexDirection="column">
          <Scrollable hasFocus={true} height={scrollableHeight}>
            {discoveryContent}
          </Scrollable>
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={theme.text.primary} bold>
                {projectRoot}
              </Text>
            </Box>
            {selectOptions}
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {discoveryContent}
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={theme.text.primary} bold>
              {projectRoot}
            </Text>
          </Box>
          {selectOptions}
        </Box>
      </Box>
    );
  };

  const content = (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <BaseTabDialog
        title={i18n.get('trust.title')}
        onClose={handleExit}
        extraHints={extraHints}
        defaultHintLabels={{ goBack: i18n.get('trust.hint.back') }}
      >
        {renderContentBody()}
      </BaseTabDialog>

      {exiting && (
        <Box marginLeft={1} marginTop={1}>
          <Text color={theme.status.warning}>{i18n.get('trust.exiting')}</Text>
        </Box>
      )}
    </Box>
  );

  return content;
};
