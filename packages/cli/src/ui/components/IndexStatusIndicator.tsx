/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Index status indicator component for displaying codebase indexing progress.
 * Shows a compact status in the footer bar during indexing operations.
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useConfig } from '../contexts/ConfigContext.js';
import type { IndexingProgress } from '@qwen-code/qwen-code-core';

/**
 * Props for IndexStatusIndicator component.
 */
export interface IndexStatusIndicatorProps {
  /** Whether to show detailed progress. Default: false. */
  detailed?: boolean;
}

/**
 * Formats status for display.
 */
function formatStatus(status: string, progress: number): string {
  switch (status) {
    case 'idle':
      return '';
    case 'scanning':
      return `Scanning ${Math.round(progress)}%`;
    case 'chunking':
      return `Chunking ${Math.round(progress)}%`;
    case 'embedding':
      return `Indexing ${Math.round(progress)}%`;
    case 'storing':
      return `Storing ${Math.round(progress)}%`;
    case 'done':
      return 'Indexed';
    case 'error':
      return 'Index Error';
    case 'paused':
      return 'Index Paused';
    default:
      return status;
  }
}

/**
 * Gets the color for a given status.
 */
function getStatusColor(status: string): string {
  switch (status) {
    case 'done':
      return theme.status.success;
    case 'error':
      return theme.status.error;
    case 'paused':
      return theme.status.warning;
    default:
      return theme.text.accent;
  }
}

/**
 * A compact indicator showing codebase indexing status.
 * Designed to be displayed in the footer status bar.
 */
export const IndexStatusIndicator: React.FC<IndexStatusIndicatorProps> = ({
  detailed = false,
}) => {
  const config = useConfig();
  const [progress, setProgress] = useState<IndexingProgress | null>(null);
  const service = config?.getIndexService();

  useEffect(() => {
    if (!service) {
      return;
    }

    // Get initial progress
    setProgress(service.getStatus());

    // Subscribe to progress updates
    const handler = (p: IndexingProgress) => {
      setProgress(p);
    };
    service.on('progress', handler);

    return () => {
      service.off('progress', handler);
    };
  }, [service]);

  // Don't render if no progress or idle
  if (!progress || progress.status === 'idle') {
    return null;
  }

  const statusText = formatStatus(progress.status, progress.overallProgress);
  if (!statusText) {
    return null;
  }

  const color = getStatusColor(progress.status);

  if (detailed) {
    return (
      <Text color={color}>
        {statusText}
        {progress.totalFiles > 0 &&
          ` (${progress.scannedFiles}/${progress.totalFiles} files)`}
      </Text>
    );
  }

  return <Text color={color}>{statusText}</Text>;
};

/**
 * Hook for accessing index progress in components.
 * Returns current progress and a boolean indicating if indexing is active.
 */
export function useIndexProgress(): {
  progress: IndexingProgress | null;
  isIndexing: boolean;
} {
  const config = useConfig();
  const [progress, setProgress] = useState<IndexingProgress | null>(null);

  useEffect(() => {
    const service = config?.getIndexService();
    if (!service) {
      return;
    }

    setProgress(service.getStatus());

    const handler = (p: IndexingProgress) => {
      setProgress(p);
    };
    service.on('progress', handler);

    return () => {
      service.off('progress', handler);
    };
  }, [config]);

  const isIndexing =
    progress !== null &&
    progress.status !== 'idle' &&
    progress.status !== 'done' &&
    progress.status !== 'error';

  return { progress, isIndexing };
}
