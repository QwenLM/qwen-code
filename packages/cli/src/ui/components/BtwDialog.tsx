/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BtwDialog — view over one /btw side question.
 *
 * The request itself lives in `btwHistoryStore`; this panel only renders it.
 * Unmounting the panel (another dialog replaced it) leaves the request
 * running. Esc is the only path that cancels a running request.
 *
 * Earlier exchanges are captured when the panel mounts and can be browsed
 * with Shift+←/→ or [ ] (stopping at either end) and with Tab / Shift+Tab
 * (wrapping back to the current answer). `x` removes exactly that captured
 * set, so an answer that lands while the panel is open is kept.
 */

import type React from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text } from 'ink';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { Scrollable, type ScrollableHandle } from './shared/Scrollable.js';
import { CliSpinner } from './CliSpinner.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTimer } from '../hooks/useTimer.js';
import { useSettings } from '../contexts/SettingsContext.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { theme } from '../semantic-colors.js';
import { useI18nService } from '../i18n/index.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import {
  btwHistoryStore,
  type BtwExchange,
  type BtwHistoryStore,
  type BtwRequest,
  type BtwRetryState,
} from '../state/btwHistoryStore.js';

/** Earlier exchanges listed above the current question. */
const HISTORY_WINDOW = 5;
const SCROLL_STEP_ROWS = 3;
/**
 * Rows used by everything except the answer body: dialog title and separator,
 * question line, spacing, and the hint footer. Matches the reference layout.
 */
const DIALOG_CHROME_ROWS = 11;
const MIN_BODY_ROWS = 5;
const COPY_FEEDBACK_MS = 2000;
const MARKDOWN_HORIZONTAL_INSET = 6;
const MIN_MARKDOWN_WIDTH = 20;

interface BtwDialogProps {
  /** Request id; for an answered exchange this is also the exchange id. */
  requestId: string;
  onClose: () => void;
  /** Injected in tests; defaults to the session store. */
  store?: BtwHistoryStore;
}

type CopyFeedback = { kind: 'copied' | 'failed' } | null;

export const BtwDialog: React.FC<BtwDialogProps> = ({
  requestId,
  onClose,
  store = btwHistoryStore,
}) => {
  const i18n = useI18nService();
  const settings = useSettings();
  const { columns, rows } = useTerminalSize();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const request = snapshot.requests.find((entry) => entry.id === requestId);
  const exchange = snapshot.exchanges.find((entry) => entry.id === requestId);
  const question = request?.question ?? exchange?.question;

  const [historyIds] = useState(
    () =>
      new Set(
        store
          .getSnapshot()
          .exchanges.filter((entry) => entry.id !== requestId)
          .map((entry) => entry.id),
      ),
  );
  const history = useMemo(
    () => snapshot.exchanges.filter((entry) => historyIds.has(entry.id)),
    [historyIds, snapshot.exchanges],
  );

  const [selectedIndex, setSelectedIndexState] = useState<number | null>(null);
  // Mirrors selectedIndex so keys delivered in the same tick build on each
  // other instead of all starting from the last render.
  const selectedIndexRef = useRef<number | null>(null);
  const setSelectedIndex = useCallback((index: number | null) => {
    selectedIndexRef.current = index;
    setSelectedIndexState(index);
  }, []);
  const selected =
    selectedIndex !== null && selectedIndex < history.length
      ? history[selectedIndex]
      : undefined;

  const scrollRef = useRef<ScrollableHandle>(null);
  const [canScroll, setCanScroll] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);

  // A reset (new session) removes the request; there is nothing left to show.
  const isMissing = question === undefined;
  useEffect(() => {
    if (isMissing) onClose();
  }, [isMissing, onClose]);

  useEffect(() => {
    if (!copyFeedback) return;
    const timer = setTimeout(() => setCopyFeedback(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyFeedback]);

  const displayedAnswer = selected
    ? selected.response
    : answerOf(request, exchange);

  const handleClose = useCallback(() => {
    store.abort(requestId);
    onClose();
  }, [store, requestId, onClose]);

  const browse = useCallback(
    (direction: 'older' | 'newer', wrap = false) => {
      const count = history.length;
      if (count === 0) return;
      const stored = selectedIndexRef.current;
      const current = stored !== null && stored < count ? stored : null;
      const next = nextHistoryIndex(current, count, direction, wrap);
      if (next === current) return;
      setSelectedIndex(next);
      scrollRef.current?.scrollBy(-Number.MAX_SAFE_INTEGER);
    },
    [history.length, setSelectedIndex],
  );

  const actionHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      // Bare ←/→ do nothing here; consume them so no other layer sees them.
      'dialog:navigate:left': () => true,
      'dialog:navigate:right': () => true,
      // Consumed even without history: an unhandled Shift+Tab falls through
      // to the global permission-mode cycle behind the panel.
      'dialog:tab:next': () => {
        browse('older', true);
        return true;
      },
      'dialog:tab:previous': () => {
        browse('newer', true);
        return true;
      },
      'dialog:navigate:up': () => {
        scrollRef.current?.scrollBy(-SCROLL_STEP_ROWS);
        return true;
      },
      'dialog:navigate:down': () => {
        scrollRef.current?.scrollBy(SCROLL_STEP_ROWS);
        return true;
      },
    }),
    [browse],
  );
  useRegisterActionHandlers('Dialog', actionHandlers);

  const fallbackHandler = useCallback<ActionHandler>(
    (key) => {
      if (key.ctrl || key.alt || key.cmd) return false;
      if (key.shift && (key.name === 'left' || key.name === 'right')) {
        browse(key.name === 'left' ? 'older' : 'newer');
        return true;
      }
      // Match the name: under the kitty protocol the sequence is the raw
      // escape, and a pasted "[" arrives named 'paste'.
      if (!key.shift && (key.name === '[' || key.name === ']')) {
        browse(key.name === '[' ? 'older' : 'newer');
        return true;
      }
      if (key.sequence === 'c' && displayedAnswer) {
        copyToClipboard(displayedAnswer, settings.merged).then(
          () => setCopyFeedback({ kind: 'copied' }),
          () => setCopyFeedback({ kind: 'failed' }),
        );
        return true;
      }
      if (key.sequence === 'x' && history.length > 0) {
        store.removeExchanges(history.map((entry) => entry.id));
        setSelectedIndex(null);
        return true;
      }
      return false;
    },
    [
      browse,
      displayedAnswer,
      history,
      setSelectedIndex,
      settings.merged,
      store,
    ],
  );
  useRegisterFallbackHandler('Dialog', fallbackHandler);

  if (question === undefined) return null;

  const window = historyWindow(history.length, selected ? selectedIndex : null);
  const historyRows =
    window.end -
    window.start +
    (window.start > 0 ? 1 : 0) +
    (window.end < history.length ? 1 : 0);
  // Short terminals give the answer body priority over the history list.
  const showHistory =
    history.length > 0 &&
    rows - DIALOG_CHROME_ROWS - historyRows >= MIN_BODY_ROWS;
  const bodyRows = Math.max(
    MIN_BODY_ROWS,
    rows - DIALOG_CHROME_ROWS - (showHistory ? historyRows : 0),
  );
  const markdownWidth = Math.max(
    MIN_MARKDOWN_WIDTH,
    columns - MARKDOWN_HORIZONTAL_INSET,
  );

  const extraHints: ShortcutHint[] = [];
  if (history.length > 0) {
    extraHints.push({ label: i18n.get('commands.btw.hint.browse'), order: 10 });
  }
  if (canScroll) {
    extraHints.push({ label: i18n.get('commands.btw.hint.scroll'), order: 20 });
  }
  if (displayedAnswer) {
    extraHints.push({
      label:
        copyFeedback?.kind === 'copied'
          ? i18n.get('commands.btw.hint.copied')
          : copyFeedback?.kind === 'failed'
            ? i18n.get('commands.btw.hint.copyFailed')
            : i18n.get('commands.btw.hint.copy'),
      order: 30,
    });
  }
  if (history.length > 0) {
    extraHints.push({
      label: i18n.get('commands.btw.hint.clearHistory'),
      order: 40,
    });
  }

  const renderMarkdown = (text: string, isPending: boolean) => (
    <MarkdownDisplay
      text={text}
      isPending={isPending}
      terminalWidth={markdownWidth}
    />
  );

  const renderBody = (): React.ReactNode => {
    if (displayedAnswer !== undefined) {
      return renderMarkdown(displayedAnswer, false);
    }
    if (!request) return null;
    const { outcome } = request;
    if (outcome === null) {
      return request.streamingText ? (
        renderMarkdown(request.streamingText, true)
      ) : (
        <BtwWaiting retry={request.retry} />
      );
    }
    switch (outcome.kind) {
      case 'empty':
        return <Text dimColor>{i18n.get('commands.btw.noResponse')}</Text>;
      case 'failed':
        return (
          <Text color={theme.status.error}>
            {i18n.get('commands.btw.error', { message: outcome.error })}
          </Text>
        );
      case 'cancelled':
        return <Text dimColor>{i18n.get('commands.btw.cancelled')}</Text>;
      default:
        return null;
    }
  };

  const questionLineText =
    selected && !showHistory ? selected.question : question;

  return (
    <BaseTabDialog
      title={i18n.get('commands.btw.title')}
      onClose={handleClose}
      extraHints={extraHints}
      defaultHintLabels={{ goBack: i18n.get('shortcut.close') }}
    >
      <Box flexDirection="column" paddingX={1}>
        {showHistory && window.start > 0 && (
          <Text dimColor>
            {i18n.get('commands.btw.earlier', { count: window.start })}
          </Text>
        )}
        {showHistory &&
          history
            .slice(window.start, window.end)
            .map((entry, offset) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                isSelected={window.start + offset === selectedIndex}
              />
            ))}
        {showHistory && window.end < history.length && (
          <Text dimColor>
            {i18n.get('commands.btw.later', {
              count: history.length - window.end,
            })}
          </Text>
        )}
        <Text wrap="truncate-end">
          <Text
            color={selected ? undefined : theme.status.warning}
            bold={!selected}
            dimColor={Boolean(selected)}
          >
            {'/btw '}
          </Text>
          <Text dimColor>{questionLineText}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Scrollable
            hasFocus
            maxHeight={bodyRows}
            scrollRef={scrollRef}
            onOverflowChange={setCanScroll}
          >
            {renderBody()}
          </Scrollable>
        </Box>
      </Box>
    </BaseTabDialog>
  );
};

const HistoryRow: React.FC<{ entry: BtwExchange; isSelected: boolean }> = ({
  entry,
  isSelected,
}) => (
  <Text bold={isSelected} dimColor={!isSelected} wrap="truncate-end">
    {'/btw '}
    {entry.question}
  </Text>
);

const BtwWaiting: React.FC<{ retry: BtwRetryState | null }> = ({ retry }) => {
  const i18n = useI18nService();
  useTimer(retry !== null, retry);

  if (!retry) {
    return (
      <Box>
        <CliSpinner type="dots" />
        <Text color={theme.status.warning}>
          {' '}
          {i18n.get('commands.btw.answering')}
        </Text>
      </Box>
    );
  }

  const seconds = Math.max(0, Math.ceil((retry.retryAt - Date.now()) / 1000));
  return (
    <Box>
      <CliSpinner type="dots" />
      <Text color={theme.status.warning}>
        {' '}
        {i18n.get(retryStatusKey(retry.status))}
      </Text>
      <Text dimColor>
        {i18n.get('commands.btw.retry.detail', {
          seconds,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
        })}
      </Text>
    </Box>
  );
};

function answerOf(
  request: BtwRequest | undefined,
  exchange: BtwExchange | undefined,
): string | undefined {
  const outcome = request?.outcome;
  if (
    outcome &&
    (outcome.kind === 'answered' || outcome.kind === 'synthetic')
  ) {
    return outcome.response;
  }
  return request ? undefined : exchange?.response;
}

function retryStatusKey(status: number | null) {
  switch (status) {
    case 429:
      return 'commands.btw.retry.rateLimited' as const;
    case 529:
      return 'commands.btw.retry.overloaded' as const;
    case 401:
    case 403:
      return 'commands.btw.retry.authentication' as const;
    default:
      return 'commands.btw.retry.generic' as const;
  }
}

/**
 * The selection after one browse step. History runs oldest (0) to newest
 * (count - 1) and `null` is the current answer. Without `wrap` both ends are
 * sticky; with it, stepping past either end lands on the current answer.
 */
function nextHistoryIndex(
  current: number | null,
  count: number,
  direction: 'older' | 'newer',
  wrap: boolean,
): number | null {
  if (direction === 'older') {
    if (current === null) return count - 1;
    if (current > 0) return current - 1;
    return wrap ? null : 0;
  }
  if (current === null) return wrap ? 0 : null;
  return current + 1 < count ? current + 1 : null;
}

/** The slice of history rows to show; it follows the selection. */
function historyWindow(
  count: number,
  selectedIndex: number | null,
): { start: number; end: number } {
  const end =
    selectedIndex === null
      ? count
      : Math.min(count, Math.max(selectedIndex + 1, HISTORY_WINDOW));
  return { start: Math.max(0, end - HISTORY_WINDOW), end };
}
