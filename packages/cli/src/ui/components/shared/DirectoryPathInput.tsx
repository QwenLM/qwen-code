/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { InputField } from './InputField.js';
import { useSearchBuffer } from '../../hooks/useSearchBuffer.js';
import { useCompletion } from '../../hooks/useCompletion.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { theme } from '../../semantic-colors.js';
import { resolvePath } from '../../../utils/resolvePath.js';
import { getDirectoryCompletions } from '../../../utils/directoryCompletions.js';
import { formatScopeTag } from '../../utils/scopeTag.js';
import { SuggestionsDisplay, type Suggestion } from '../SuggestionsDisplay.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';

const NOOP = () => {};

const MAX_DIRECTORY_SUGGESTIONS = 50;

// ── Types ────────────────────────────────────────────────────────────────────

interface DirectoryPathInputProps {
  /** Resolved real path is reported on success. */
  onSubmit: (resolvedPath: string) => void;
  /** Esc / Ctrl+C closes the input. */
  onCancel: () => void;
  /** Optional bold title rendered above the input. */
  title?: string;
  /** Optional descriptive subtitle. */
  description?: React.ReactNode;
  /** Optional input placeholder. */
  placeholder?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Generic directory path input with directory completion.
 *
 * Driven by the same useCompletion state machine that the main prompt uses,
 * so navigation, scrolling and "highlight commits on Enter" behaviours stay
 * in lock-step with the rest of the CLI:
 *
 *   - Empty buffer  → no candidate list (avoids accidental selection).
 *   - Each keystroke recomputes candidates via getDirectoryCompletions.
 *   - ↓/↑           → navigate the highlight.
 *   - Tab           → apply the highlighted candidate, append a trailing
 *                     path separator so the user can drill further.
 *   - Enter         → if a candidate is highlighted, submit that candidate;
 *                     otherwise validate the literal buffer text. Either
 *                     way the resolved real path is reported via onSubmit.
 *   - Esc / Ctrl+C  → onCancel.
 */
export function DirectoryPathInput({
  onSubmit,
  onCancel,
  title,
  description,
  placeholder = 'Enter directory path…',
}: DirectoryPathInputProps): React.JSX.Element {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Drive the input from the underlying TextBuffer directly. useTextBuffer
  // owns its own reducer, so the parent re-renders on every edit; reading
  // buffer.text inline keeps suggestions in lock-step with each keystroke.
  const buffer = useSearchBuffer({ initialText: '', onChange: NOOP });
  const text = buffer.text;

  // Snapshot of the workspace context's additional working directories.
  // Used so we can render the same coloured scope tag the Trust tab shows
  // (e.g. [session] yellow, [project (local)] blue) next to candidates that
  // are already trusted.
  const config = useConfig();
  // The module keeps a flat list with no source attribution, so a suggestion can
  // be marked as already trusted but not as to *where* the trust came from. See #67.
  const trustedDirs = useMemo(
    () => new Set(config.permission?.getAdditionalDirectories() ?? []),
    [config],
  );
  const cwd = useMemo(() => process.cwd(), []);

  const {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    setSuggestions,
    setActiveSuggestionIndex,
    setVisibleStartIndex,
    navigateUp,
    navigateDown,
  } = useCompletion();

  // Recompute candidates per keystroke. Empty input clears the list so an
  // accidental Enter never picks the cwd's first sub-directory by surprise.
  useEffect(() => {
    if (text.trim().length === 0) {
      setSuggestions([]);
      return;
    }
    const candidates = getDirectoryCompletions(text).slice(
      0,
      MAX_DIRECTORY_SUGGESTIONS,
    );
    const next: Suggestion[] = candidates.map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      const trusted = trustedDirs.has(abs) || trustedDirs.has(p);
      const tag = trusted ? formatScopeTag(undefined) : null;
      return {
        label: p,
        value: p,
        // SuggestionsDisplay renders `description` as a right-aligned hint;
        // mark already-trusted entries with the same coloured scope tag
        // used in the Trust tab listing so both surfaces speak the same
        // visual language.
        description: tag ? `[${tag.label}]` : undefined,
        descriptionColor: tag?.color,
      };
    });
    setSuggestions(next);
  }, [text, setSuggestions, trustedDirs, cwd]);

  // When the candidate list shape changes, snap the highlight to the first
  // entry (or -1 when empty) and rewind the visible window to the top.
  useEffect(() => {
    setActiveSuggestionIndex(suggestions.length > 0 ? 0 : -1);
    setVisibleStartIndex(0);
  }, [suggestions, setActiveSuggestionIndex, setVisibleStartIndex]);

  const validateAndSubmit = useCallback(
    (rawCandidate: string) => {
      const candidate = rawCandidate.trim();
      if (!candidate) return;
      try {
        const absolutePath = path.resolve(resolvePath(candidate));
        if (!fs.existsSync(absolutePath)) {
          setErrorMsg(`Directory does not exist: ${absolutePath}`);
          return;
        }
        const stats = fs.statSync(absolutePath);
        if (!stats.isDirectory()) {
          setErrorMsg(`Path is not a directory: ${absolutePath}`);
          return;
        }
        setErrorMsg(null);
        onSubmit(fs.realpathSync(absolutePath));
      } catch (err) {
        setErrorMsg((err as Error).message);
      }
    },
    [onSubmit],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      // Pressing Enter on a highlighted suggestion always selects that
      // candidate, regardless of the buffer text. The visible highlight
      // is the user's current intent.
      if (activeSuggestionIndex >= 0) {
        const active = suggestions[activeSuggestionIndex];
        if (active) {
          validateAndSubmit(active.value);
          return;
        }
      }
      validateAndSubmit(value);
    },
    [activeSuggestionIndex, suggestions, validateAndSubmit],
  );

  const handleKey = useCallback(
    (key: Key) => {
      if (suggestions.length === 0) return false;
      if (key.name === 'down') {
        navigateDown();
        return true;
      }
      if (key.name === 'up') {
        navigateUp();
        return true;
      }
      if (key.name === 'tab' && activeSuggestionIndex >= 0) {
        const picked = suggestions[activeSuggestionIndex];
        if (picked) {
          // Append the path separator so subsequent keystrokes drill
          // further into the chosen directory without a manual `/`.
          buffer.setText(picked.value + path.sep, 'end');
        }
        return true;
      }
      return false;
    },
    [suggestions, activeSuggestionIndex, navigateUp, navigateDown, buffer],
  );

  useKeypress(handleKey, { isActive: true });

  const { mainAreaWidth } = useUIState();
  const suggestionsWidth = Math.max(20, (mainAreaWidth ?? 80) - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingLeft={1}
      paddingRight={1}
    >
      {title && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.ui.active}>
            {title}
          </Text>
        </Box>
      )}

      {description && <Box flexDirection="column">{description}</Box>}

      <Box flexDirection="column" marginTop={1}>
        <InputField
          buffer={buffer}
          placeholder={placeholder}
          onSubmit={handleSubmit}
          onCancel={onCancel}
        />
      </Box>

      {suggestions.length > 0 && (
        <Box marginTop={1}>
          <SuggestionsDisplay
            suggestions={suggestions}
            activeIndex={activeSuggestionIndex}
            isLoading={false}
            width={suggestionsWidth}
            scrollOffset={visibleStartIndex}
            userInput={text}
            mode="reverse"
            showSeparator={false}
          />
        </Box>
      )}

      {errorMsg && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{errorMsg}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↓↑ browse · Tab apply · Enter submit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
