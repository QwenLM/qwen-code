/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import type { DiffFile } from '../utils/gitDiff.js';
import { fetchGitDiffString, MAX_LINES_PER_FILE } from '../utils/gitDiff.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { DiffRenderer } from './messages/DiffRenderer.js';

interface DiffFileViewProps {
  file: DiffFile;
  onClose: () => void;
}

/**
 * DiffFileView - Flat diff viewer with syntax highlighting via DiffRenderer.
 *
 * Fetches the raw unified diff string for a file and delegates rendering to
 * DiffRenderer (ColorDiff / ColorFile), providing syntax highlighting,
 * word-level diff, and line numbers. Content is capped at MAX_LINES_PER_FILE
 * (data level). The content flows into native terminal scrollback.
 *
 * Uses BaseTabDialog for consistent title/separator/footer/keyboard chrome.
 * ESC returns to the file list (handled by BaseTabDialog's onClose).
 */
export const DiffFileView: React.FC<DiffFileViewProps> = ({
  file,
  onClose,
}) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  const { diffString, truncated } = useMemo(
    () => fetchGitDiffString(file.path),
    [file.path],
  );

  const breadcrumbTitle = `Git Diff > ${file.path}`;

  return (
    <BaseTabDialog title={breadcrumbTitle} onClose={onClose}>
      {/* File header */}
      <Box flexDirection="column">
        <Text bold color={theme.text.primary}>
          {file.path}
        </Text>
        <Box flexDirection="row">
          {file.isBinary ? (
            <Text color={theme.text.secondary}>Binary file</Text>
          ) : (
            <>
              {file.linesAdded > 0 && (
                <Text color={theme.status.success}>+{file.linesAdded} </Text>
              )}
              {file.linesRemoved > 0 && (
                <Text color={theme.status.error}>-{file.linesRemoved} </Text>
              )}
              <Text color={theme.text.secondary}>
                {file.isUntracked
                  ? '(untracked)'
                  : file.isNewFile
                    ? '(new file)'
                    : '(modified)'}
              </Text>
            </>
          )}
        </Box>
      </Box>

      {/* Diff content */}
      {!diffString ? (
        <Text color={theme.text.secondary}>
          {file.isUntracked
            ? 'New untracked file (content not shown)'
            : file.isNewFile
              ? 'New file (no diff available)'
              : 'No diff available'}
        </Text>
      ) : (
        <DiffRenderer
          diffContent={diffString}
          filePath={file.path}
          terminalWidth={terminalWidth}
        />
      )}

      {/* Truncation indicator */}
      {truncated && (
        <Box>
          <Text color={theme.text.secondary} dimColor italic>
            ... diff truncated (exceeded {MAX_LINES_PER_FILE} line limit)
          </Text>
        </Box>
      )}
    </BaseTabDialog>
  );
};
