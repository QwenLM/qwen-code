/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import {
  getTipHistory,
  selectTip,
  tipRegistry,
  type TipContext,
} from '../../services/tips/index.js';
import { useSessionStats } from '../contexts/SessionContext.js';

/**
 * Select a startup tip. Extracted as a standalone function for clarity.
 *
 * Cached at module scope **keyed by current session id**: `<Tips>` can be
 * remounted by `refreshStatic()` (fires on SIGWINCH-driven `terminalWidth`
 * changes, `/compact`, auth dialogs, etc.), and a remount mounts a new
 * `<Tips>` instance whose `useMemo` would otherwise re-run `pickStartupTip`.
 * Because `selectTip` is LRU + `recordShown` advances the LRU on every pick,
 * re-runs produce a *different* tip each time, which would surface as the
 * banner `Example:` line flickering between choices during a single session
 * (and, via host terminals that don't fully honor `\x1b[3J`, stacking
 * duplicates in scrollback).
 *
 * The cache key is the current session id rather than process-global, because
 * `/clear` and `/resume` call `config.startNewSession(...)` without restarting
 * the TUI process. A process-global cache would pin the first tip forever and
 * break the documented LRU rotation (covered by `Tips.test.ts`:
 * "rotates startup tips across sessions via LRU"). Keyed by session id, each
 * new session misses the cache, picks the next LRU tip, and re-fills the
 * single-slot cache — remounts within the same session still hit the cache.
 */
let cached: { sessionId: string; tip: string } | undefined;

function pickStartupTip(sessionId: string): string {
  if (cached && cached.sessionId === sessionId) return cached.tip;

  const history = getTipHistory();
  const context: TipContext = {
    lastPromptTokenCount: 0,
    contextWindowSize: 0,
    sessionPromptCount: 0,
    sessionCount: history.sessionCount,
    platform: process.platform,
  };

  const tip = selectTip('startup', context, tipRegistry, history);
  if (tip) {
    history.recordShown(tip.id, 0);
    cached = { sessionId, tip: tip.content };
    return cached.tip;
  }

  // Fallback — should not happen with the current registry
  cached = { sessionId, tip: 'Type / to see all available commands.' };
  return cached.tip;
}

export const Tips: React.FC = () => {
  const { stats } = useSessionStats();
  const selectedTip = useMemo(
    () => pickStartupTip(stats.sessionId),
    [stats.sessionId],
  );

  return (
    <Box flexDirection="column" marginLeft={2} marginRight={2}>
      <Text color={theme.text.secondary}>
        {t('Example: ')}
        {t(selectedTip)}
      </Text>
      <Text> </Text>
      <Text color={theme.text.secondary}>
        {t(
          'This is a Beta version. Chat history will be lost after the personal development environment instance is deleted.',
        )}
      </Text>
    </Box>
  );
};
