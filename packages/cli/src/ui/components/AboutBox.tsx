/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { ExtendedSystemInfo } from '../../utils/systemInfo.js';
import {
  getSystemInfoFields,
  getFieldValue,
  type SystemInfoField,
} from '../../utils/systemInfoFields.js';
import { t } from '../../i18n/index.js';

type AboutBoxProps = ExtendedSystemInfo;

export const AboutBox: React.FC<AboutBoxProps> = (props) => {
  const fields = getSystemInfoFields(props);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      marginY={1}
      width="100%"
    >
      <Box marginBottom={1}>
        <Text bold color={theme.text.accent}>
          {t('About Qwen Code')}
        </Text>
      </Box>
      {fields.map((field: SystemInfoField) => (
        <Box key={field.key} flexDirection="row">
          <Box width="35%">
            <Text bold color={theme.text.link}>
              {field.label}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>
              {getFieldValue(field, props)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};
