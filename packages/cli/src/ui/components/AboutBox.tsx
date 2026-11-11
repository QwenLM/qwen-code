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
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import {
  getDisplayString,
  BRAND_CLI_NAME,
} from '@qwen-code/core';

export interface AboutBoxProps {
  cliVersion: string;
  osVersion: string;
  modelVersion: string;
  tagline?: string;
  children?: React.ReactNode;
  onClose?: () => void;
}

export function AboutRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Box width="20%">
        <Text bold color={theme.text.secondary}>
          {label}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.primary}>{value}</Text>
      </Box>
    </Box>
  );
}

export const AboutBox: React.FC<AboutBoxProps> = ({
  cliVersion,
  osVersion,
  modelVersion,
  tagline,
  children,
  onClose,
}) => {
  const config = useConfig();
  const listed = useModel(config, modelVersion);

  return (
    <BaseTabDialog
      title={`About - ${BRAND_CLI_NAME}`}
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
    >
      {tagline && (
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>{tagline}</Text>
        </Box>
      )}
      <AboutRow label="CLI Version" value={cliVersion} />
      {GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO) && (
        <AboutRow label="Git Commit" value={GIT_COMMIT_INFO} />
      )}
      <AboutRow label="Model" value={getDisplayString(listed, modelVersion)} />
      <AboutRow label="OS" value={osVersion} />
      {children}
    </BaseTabDialog>
  );
};
