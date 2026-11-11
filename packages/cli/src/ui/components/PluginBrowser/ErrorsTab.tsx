/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ErrorsTab — Errors Tab content for the PluginBrowser.
 *
 * Displays plugin loading errors grouped by category (transient,
 * marketplace, plugin, config), with actionable guidance for each.
 *
 * Errors are read from Config by the parent and passed through this component.
 * When no errors are available the tab shows an informational empty state.
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { PluginError } from '@qwen-code/core';
import {
  formatErrorMessage,
  getErrorGuidance,
  categorizeError,
  CATEGORY_LABELS,
  type ErrorCategory,
} from './PluginErrors.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ErrorsTabProps {
  /** Plugin errors to display. Pass an empty array for the clean state. */
  errors?: PluginError[];
  /** Optional callback to navigate to another tab (e.g. 'installed'). */
  onNavigate?: (tab: string) => void;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ErrorsTab({
  errors = [],
  onNavigate,
}: ErrorsTabProps): React.JSX.Element {
  const entries = useMemo(() => errors.map(buildPluginErrorDisplay), [errors]);
  return <PluginErrorList errors={entries} onNavigate={onNavigate} />;
}

export interface PluginErrorDisplay {
  category: ErrorCategory;
  message: string;
  guidance: string | null;
}

export function buildPluginErrorDisplay(
  error: PluginError,
): PluginErrorDisplay {
  return {
    category: categorizeError(error),
    message: formatErrorMessage(error),
    guidance: getErrorGuidance(error),
  };
}

export function PluginErrorList({
  errors,
  onNavigate,
}: {
  errors: readonly PluginErrorDisplay[];
  onNavigate?: (tab: string) => void;
}): React.JSX.Element {
  const grouped = useMemo(() => {
    const groups: Record<ErrorCategory, PluginErrorDisplay[]> = {
      transient: [],
      marketplace: [],
      plugin: [],
      config: [],
    };
    errors.forEach((error) => groups[error.category].push(error));
    return groups;
  }, [errors]);

  const categoryOrder: ErrorCategory[] = [
    'transient',
    'marketplace',
    'plugin',
    'config',
  ];

  if (errors.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="green">✓ No plugin errors detected.</Text>
        <Box marginTop={1}>
          <Text dimColor>
            Errors from plugin loading, marketplace access, and MCP server
            configuration will appear here.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.status.error} bold>
        {errors.length} error{errors.length !== 1 ? 's' : ''} detected
      </Text>

      {categoryOrder.map((cat) => {
        const catErrors = grouped[cat];
        if (catErrors.length === 0) return null;

        return (
          <Box key={cat} flexDirection="column" marginTop={1}>
            <Text color={theme.text.primary} bold>
              {CATEGORY_LABELS[cat]} ({catErrors.length})
            </Text>

            {catErrors.map((error, idx) => {
              const message = error.message;
              const guidance = error.guidance;

              return (
                <Box
                  key={`${cat}-${idx}`}
                  flexDirection="column"
                  marginLeft={2}
                  marginTop={idx > 0 ? 1 : 0}
                >
                  <Text color={theme.status.error}>✗ {message}</Text>
                  {guidance && <Text dimColor> → {guidance}</Text>}
                </Box>
              );
            })}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          Transient errors may resolve after restart.
          {onNavigate
            ? ' Use the Installed tab to manage or uninstall problematic plugins.'
            : ' Switch to the Installed tab to manage or uninstall problematic plugins.'}
        </Text>
      </Box>
    </Box>
  );
}
