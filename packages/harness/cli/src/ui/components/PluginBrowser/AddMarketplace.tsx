/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AddMarketplace — Text input form for adding a new marketplace source.
 *
 * Accepts owner/repo, SSH URL, HTTPS URL, or local path.
 * On submit, parses the input, adds the marketplace source, and reports
 * success or error back to the parent.
 */

import type React from 'react';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { InputFrame } from '../shared/InputFrame.js';
import type { Key } from '../../contexts/KeypressContext.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import {
  addMarketplaceForCommand,
  formatMarketplaceOperationStatus,
  getMarketplaceOperationTimeoutMs,
  getRemainingOperationSeconds,
} from '@qwen-code/core/plugin-management';
import type { LoadedSettings } from '../../../config/settings.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AddMarketplaceProps {
  settings: LoadedSettings;
  /** Pre-filled source string (e.g. from CLI arg). */
  initialSource?: string;
  /** Called on success with the status message. */
  onAdded: (message: string) => void;
  /** Called when the user cancels (Esc). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function AddMarketplace({
  settings,
  initialSource,
  onAdded,
  onCancel,
}: AddMarketplaceProps): React.JSX.Element {
  const [input, setInput] = useState(initialSource ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Auto-add if initialSource was provided
  const autoAddedRef = useRef(false);

  const handleAdd = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setError('Please enter a marketplace source.');
        return;
      }

      setLoading(true);
      setError(null);
      const timeoutMs = getMarketplaceOperationTimeoutMs();
      let startedAt = Date.now();
      let detail = 'Parsing input...';
      const updateProgress = () => {
        if (!mountedRef.current) return;
        setProgress(
          formatMarketplaceOperationStatus('Adding', {
            target: trimmed,
            detail,
            remainingSeconds: getRemainingOperationSeconds(
              startedAt,
              timeoutMs,
            ),
          }),
        );
      };
      updateProgress();
      const countdownTimer = setInterval(updateProgress, 1000);
      countdownTimer.unref?.();

      void (async () => {
        try {
          const message = await addMarketplaceForCommand({
            settings,
            sourceInput: trimmed,
            scope: 'user',
            onProgress: (msg: string) => {
              if (mountedRef.current) {
                startedAt = Date.now();
                detail = msg;
                updateProgress();
              }
            },
          });

          if (!mountedRef.current) return;

          onAdded(message);
        } catch (err) {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
            setProgress(null);
          }
        } finally {
          clearInterval(countdownTimer);
        }
      })();
    },
    [onAdded, settings],
  );

  // Auto-add on mount if initialSource provided
  useEffect(() => {
    if (initialSource && !autoAddedRef.current) {
      autoAddedRef.current = true;
      handleAdd(initialSource);
    }
  }, [initialSource, handleAdd]);

  // Action handlers for Dialog context
  const actionHandlers = useMemo(
    () => ({
      'dialog:escape': () => {
        if (loading) return false;
        onCancel();
        return true;
      },
      'dialog:confirm': () => {
        if (loading) return false;
        handleAdd(input);
        return true;
      },
      'edit:deleteLeft': () => {
        if (loading) return false;
        setInput((prev) => prev.slice(0, -1));
        setError(null);
        return true;
      },
    }),
    [loading, input, onCancel, handleAdd],
  );

  // Fallback handler for character input
  const fallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (loading) return false;
      if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
        setInput((prev) => prev + key.sequence);
        setError(null);
        return true;
      }
      return false;
    },
    [loading],
  );

  useRegisterActionHandlers('Dialog', actionHandlers, true);
  useRegisterFallbackHandler('Dialog', fallbackHandler, true);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        Add Marketplace
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Enter a marketplace source:</Text>
        <Text dimColor> owner/repo GitHub shorthand</Text>
        <Text dimColor> git@host:repo.git SSH URL</Text>
        <Text dimColor> https://... HTTPS URL</Text>
        <Text dimColor> /path/to/dir Local directory</Text>
      </Box>

      {/* Input line */}
      <InputFrame active>
        <Text>{'❯ '}</Text>
        <Text>{input}</Text>
        <Text>{loading ? '' : '█'}</Text>
      </InputFrame>

      {/* Loading state */}
      {loading && progress && (
        <Box marginTop={1}>
          <Text color="cyan">⏳ {progress}</Text>
        </Box>
      )}

      {/* Error */}
      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>✗ {error}</Text>
        </Box>
      )}

      {/* Hints */}
      {!loading && (
        <Box marginTop={1}>
          <Text dimColor>Enter: Add · Esc: Cancel</Text>
        </Box>
      )}
    </Box>
  );
}
