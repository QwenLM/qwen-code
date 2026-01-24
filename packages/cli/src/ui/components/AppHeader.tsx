/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { Header } from './Header.js';
import { Tips } from './Tips.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';

interface AppHeaderProps {
  version: string;
}

export const AppHeader = ({ version }: AppHeaderProps) => {
  const settings = useSettings();
  const config = useConfig();

  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  const model = config.getModel();
  const targetDir = config.getTargetDir();
  const showBanner = !config.getScreenReader();
  const showTips = !(settings.merged.ui?.hideTips || config.getScreenReader());

  return (
    <Box flexDirection="column">
      {showBanner && (
        <Header
          version={version}
          authType={authType}
          model={model}
          workingDirectory={targetDir}
        />
      )}
      {showTips && <Tips />}
    </Box>
  );
};
