/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useEffect } from 'react';
import { Box, Text } from 'ink';
import tinygradient from 'tinygradient';
import { getDisplayString, tildeifyPath } from '@qwen-code/core';
import { QWEN_CODE_LOGO } from '../../brand.js';
import type { CliWelcomeHeaderProps } from './WelcomeHeaderProps.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useI18nService } from '../i18n/index.js';
import { theme } from '../semantic-colors.js';

const LOGO_WIDTH = 37;
const LOGO_ROWS = QWEN_CODE_LOGO.split('\n').map((line) => Array.from(line));

// ink-gradient relies on Transform, which the cell-based Ink engine ignores.
// Use native Text colors, sampled across this fixed ASCII asset, instead.
function QwenCodeLogoComponent({
  gradient,
  fallbackColor,
}: {
  gradient: string[] | undefined;
  fallbackColor: string;
}) {
  const scale =
    gradient && gradient.length >= 2 ? tinygradient(gradient) : undefined;
  const colors = scale
    ? Array.from({ length: LOGO_WIDTH }, (_, col) =>
        scale.rgbAt(col / (LOGO_WIDTH - 1)).toHexString(),
      )
    : undefined;

  return (
    <Box
      width={LOGO_WIDTH}
      flexShrink={0}
      marginRight={2}
      flexDirection="column"
    >
      {LOGO_ROWS.map((characters, row) => (
        <Text key={row} color={gradient?.[0] ?? fallbackColor}>
          {colors
            ? characters.map((character, col) => (
                <Text key={col} color={colors[col]}>
                  {character}
                </Text>
              ))
            : characters.join('')}
        </Text>
      ))}
    </Box>
  );
}

const QwenCodeLogo = memo(QwenCodeLogoComponent);

export function QwenCodeWelcomeHeader({
  cliDisplayName,
  terminalWidth,
  versionLabel,
  tips,
}: CliWelcomeHeaderProps) {
  const config = useConfig();
  const { currentModel } = useUIState();
  const listed = useModel(config, currentModel);
  const i18n = useI18nService();
  const model = currentModel ? getDisplayString(listed, currentModel) : '—';
  // The startup header spans the terminal. Choose its layout on the first
  // render so transcript remounts cannot print an unmeasured header to scrollback.
  const showLogo = terminalWidth >= 85;
  const showBorder = terminalWidth >= 24;
  const showTips = tips !== undefined && terminalWidth >= 40;
  const markTipsShown = tips?.markShown;
  useEffect(() => {
    if (showTips) markTipsShown?.();
  }, [showTips, markTipsShown]);

  return (
    <Box
      width={terminalWidth}
      maxWidth="100%"
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
    >
      <Box alignItems="center">
        {showLogo && (
          <QwenCodeLogo
            gradient={theme.ui.gradient}
            fallbackColor={theme.text.accent}
          />
        )}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          maxWidth={60}
          borderStyle={showBorder ? 'round' : undefined}
          borderColor={theme.border.default}
          paddingX={showBorder ? 1 : 0}
        >
          <Text wrap="truncate-end">
            <Text bold color={theme.text.accent}>
              {'>_ '}
              {cliDisplayName}
            </Text>
            <Text color={theme.text.secondary}> ({versionLabel})</Text>
          </Text>
          <Text> </Text>
          <Text color={theme.text.secondary} wrap="truncate-end">
            {i18n.get('home.model', { model })}
          </Text>
          <Text color={theme.text.secondary} wrap="truncate-end">
            {tildeifyPath(config.getTargetDir())}
          </Text>
        </Box>
      </Box>
      {showTips && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary} wrap="truncate-end">
            {tips.title}
          </Text>
          {tips.lines.map((line, index) => (
            <Text key={index} color={theme.text.secondary} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
