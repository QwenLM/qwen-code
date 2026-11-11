/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PluginTrustWarning — Banner shown before installing a third-party plugin.
 *
 * Warns the user that installing a plugin grants it access to their system,
 * and that they should only install plugins they trust.
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';

export interface PluginTrustWarningProps {
  /** Plugin name displayed in the warning. */
  pluginName: string;
  /** Optional marketplace source. */
  marketplace?: string;
}

export const PluginTrustWarning: React.FC<PluginTrustWarningProps> = ({
  pluginName,
  marketplace,
}) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={theme.status.warning}
    paddingX={1}
  >
    <Text color={theme.status.warning} bold>
      ⚠ Trust Warning
    </Text>
    <Box marginTop={1} flexDirection="column">
      <Text>
        Installing <Text bold>{pluginName}</Text>
        {marketplace ? <Text dimColor> from {marketplace}</Text> : null} will
        grant it access to your system.
      </Text>
      <Text dimColor>
        Plugins can execute code, read files, and make network requests.
      </Text>
      <Text dimColor>Only install plugins from sources you trust.</Text>
    </Box>
  </Box>
);
