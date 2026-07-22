/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getTipHistory } from '../../services/tips/index.js';
import { t } from '../../i18n/index.js';
import { theme } from '../semantic-colors.js';
import { whatsNewByVersion } from './whats-new-content.js';

interface WhatsNewProps {
  version: string;
}

export const WhatsNew: React.FC<WhatsNewProps> = ({ version }) => {
  const highlights = whatsNewByVersion[version];
  const [shouldShow] = useState(
    () => highlights !== undefined && !getTipHistory().hasSeenVersion(version),
  );

  useEffect(() => {
    if (shouldShow && highlights) {
      getTipHistory().markVersionSeen(version);
    }
  }, [highlights, shouldShow, version]);

  if (!shouldShow || !highlights) {
    return null;
  }

  return (
    <Box
      borderColor={theme.border.default}
      borderStyle="round"
      flexDirection="column"
      marginLeft={2}
      marginRight={2}
      marginTop={1}
      paddingX={1}
    >
      <Text bold color={theme.text.accent}>
        {t("What's new in v{{version}}", { version })}
      </Text>
      {highlights.map((highlight) => (
        <Text color={theme.text.primary} key={highlight}>
          - {t(highlight)}
        </Text>
      ))}
    </Box>
  );
};
