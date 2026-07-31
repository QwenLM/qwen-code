/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ExtendedSystemInfo } from '../../utils/systemInfo.js';
import { getSystemInfoFields } from '../../utils/systemInfoFields.js';
import { t } from '../../i18n/index.js';

type AboutBoxProps = ExtendedSystemInfo & {
  width?: number;
};

export const AboutBox: React.FC<AboutBoxProps> = ({ width, ...props }) => {
  const fields = getSystemInfoFields(props);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width={width}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.text.accent}>
          {t('Status')}
        </Text>
      </Box>
      {fields.map((field) => (
        <Box
          key={field.label}
          flexDirection="row"
          marginTop={field.label === t('Auth') ? 1 : 0}
        >
          <Box width="35%">
            <Text bold color={theme.text.link}>
              {field.label}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>{field.value}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};
