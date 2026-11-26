/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ValidatePlugin — Validates a local plugin directory or manifest file.
 *
 * Renders the same structured report used by the CLI and SDK entry points.
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  validatePlugin,
  type PluginValidationReport,
} from '@qwen-code/core';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ValidatePluginProps {
  /** Path to a plugin directory or plugin.json manifest file. */
  path?: string;
  /** Called when the user dismisses the view. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type ValidateState =
  | { status: 'loading' }
  | { status: 'no-path' }
  | { status: 'done'; report: PluginValidationReport }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ValidatePlugin({
  path: inputPath,
  onClose: _onClose,
}: ValidatePluginProps): React.JSX.Element {
  const [state, setState] = useState<ValidateState>(
    inputPath ? { status: 'loading' } : { status: 'no-path' },
  );

  useEffect(() => {
    if (!inputPath) return;

    let cancelled = false;

    async function run(): Promise<void> {
      try {
        const report = await validatePlugin(inputPath!);
        if (!cancelled) {
          setState({ status: 'done', report });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Unknown validation error',
          });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [inputPath]);

  // -- No path --
  if (state.status === 'no-path') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.warning} bold>
          Plugin Validation
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Usage: /plugins validate {'<path>'}</Text>
          <Text dimColor>
            Provide a path to a plugin directory or plugin.json file.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc to go back.</Text>
        </Box>
      </Box>
    );
  }

  if (state.status === 'loading') {
    return (
      <Box paddingX={1}>
        <Text color="cyan">Validating plugin…</Text>
      </Box>
    );
  }

  // -- Error --
  if (state.status === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error} bold>
          Validation Error
        </Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>✗ {state.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc to go back.</Text>
        </Box>
      </Box>
    );
  }

  // -- Results --
  const { report } = state;
  const { errorCount, warningCount, componentCount } = report.summary;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text
        color={report.valid ? theme.status.success : theme.status.error}
        bold
      >
        Validation {report.valid ? 'Passed' : 'Failed'}
      </Text>

      <Box marginTop={1}>
        <Text>
          {errorCount} error{errorCount !== 1 ? 's' : ''}, {warningCount}{' '}
          warning{warningCount !== 1 ? 's' : ''}, {componentCount} component
          {componentCount !== 1 ? 's' : ''}
        </Text>
      </Box>

      {report.plugin && (
        <Box marginTop={1}>
          <Text>Plugin: {report.plugin.displayName ?? report.plugin.name}</Text>
        </Box>
      )}

      {report.diagnostics.map((diagnostic, index) => {
        const isError = diagnostic.severity === 'error';
        const location = diagnostic.location?.path;
        return (
          <Box key={`${diagnostic.code}-${index}`} marginTop={1} marginLeft={1}>
            <Text color={isError ? theme.status.error : theme.status.warning}>
              {isError ? '✗' : '⚠'} [{diagnostic.code}]{' '}
              {location && location !== '.' ? `${location}: ` : ''}
              {diagnostic.message}
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    </Box>
  );
}
