/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI footer + responding indicator — visual-parity restore of the ink
 * `Footer` status line and `LoadingIndicator`, ported back from the pre-batch
 * `feat/opentui-migrate` implementation the batched merge dropped.
 *
 * The mode segment is labelled by `formatApprovalModeName`, the mapping the rest
 * of the UI already uses, and stays dim: the composer carries the mode's colour
 * on its prefix glyph and border.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import nodePath from 'node:path';
import wrapAnsi from 'wrap-ansi';
import { useTerminalDimensions } from '@opentui/react';
import {
  ApprovalMode,
  uiTelemetryService,
  type Config,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../constants.js';
import { usePhraseCycler } from '../hooks/usePhraseCycler.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { useTimer } from '../hooks/useTimer.js';
import { useAnimationFrame } from '../hooks/useAnimationFrame.js';
import { fmtTokens } from '../components/stats-helpers.js';
import { formatApprovalModeName } from '../utils/approvalModeDisplay.js';
import {
  contextUsageLabel,
  formatDuration,
  formatPercentageUsed,
  formatTokenCount,
} from '../utils/formatters.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import { getCachedStringWidth, truncateToWidth } from '../utils/textUtils.js';
import { C } from './theme.js';

/**
 * Owns its frame timer so the high-frequency tick re-renders ONLY this 1-cell
 * component, not the whole transcript tree.
 */
function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(spin);
  }, []);
  return (
    <box width={2}>
      <text fg={C.dim}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</text>
    </box>
  );
}

export interface OpenTuiLoadingIndicatorProps {
  streaming: boolean;
  /**
   * Live streaming-character count. Animated locally (ink `LoadingIndicator`
   * parity) so the 100ms tick re-renders only this row, never the transcript.
   */
  streamingCharsRef?: RefObject<number>;
  /** False while waiting on the API (↑), true once content arrives (↓). */
  isReceivingContent?: boolean;
}

/** Spinner + witty phrase + elapsed time + token estimate, above the composer. */
export function OpenTuiLoadingIndicator({
  streaming,
  streamingCharsRef,
  isReceivingContent = false,
}: OpenTuiLoadingIndicatorProps) {
  const { width } = useTerminalDimensions();
  // The shared cycler resolves the phrase list for all nine locales and owns
  // the 15s rotation, so this renderer cannot drift from ink's.
  const phrase = usePhraseCycler(streaming, false);
  const elapsedTime = useTimer(streaming, 0);
  const fallbackRef = useRef(0);
  const animatedChars = useAnimationFrame(
    streamingCharsRef ?? fallbackRef,
    streamingCharsRef && streaming ? 100 : null,
  );
  if (!streaming) return null;

  const isNarrow = isNarrowWidth(width);
  const outputTokens = Math.round(animatedChars / 4);
  const showTokens = !isNarrow && outputTokens > 0;
  // Keep the timer's sub-second precision for the animation, but display only
  // completed whole seconds until the minute format takes over.
  const timeStr =
    elapsedTime < 60
      ? `${Math.floor(Math.max(0, elapsedTime))}s`
      : formatDuration(elapsedTime * 1000);
  const suffix = t('({{time}}{{tokens}} · esc to cancel)', {
    time: timeStr,
    tokens: showTokens
      ? ` · ${isReceivingContent ? '↓' : '↑'} ${formatTokenCount(
          outputTokens,
        )} tokens`
      : '',
  });
  // ink truncates the phrase (`wrap="truncate-end"`) rather than letting it wrap,
  // so the cancel hint survives a narrow terminal. Budget = width − 2 padding −
  // 2 spinner cells − 1 separating space − the suffix (which moves to its own
  // row when narrow, so it costs nothing there).
  const phraseBudget = Math.max(
    0,
    width - 5 - (isNarrow ? 0 : getCachedStringWidth(suffix)),
  );
  const phraseText = truncateToWidth(phrase, phraseBudget);
  return (
    <box paddingLeft={2} flexDirection={isNarrow ? 'column' : 'row'}>
      <box flexDirection="row">
        <Spinner />
        <text fg={C.dim}>
          {isNarrow ? phraseText : `${phraseText} ${suffix}`}
        </text>
      </box>
      {isNarrow && <text fg={C.dim}>{suffix}</text>}
    </box>
  );
}

export interface OpenTuiFooterProps {
  config: Config;
  streaming: boolean;
  queueLength?: number;
  sessionName?: string | null;
  approvalMode?: ApprovalMode;
  /** `!` shell mode: takes the hint slot over the steer/approval segments. */
  shellModeActive?: boolean;
  /** Armed two-press quit warning: takes the bottom hint slot and gates the
   * status line off, as it does in ink. */
  exitHint?: string | null;
}

/** The status line (ink `Footer` parity). */
export function OpenTuiFooter({
  config,
  streaming,
  queueLength = 0,
  sessionName = null,
  approvalMode,
  shellModeActive = false,
  exitHint = null,
}: OpenTuiFooterProps) {
  const { width } = useTerminalDimensions();
  const targetDir = config.getTargetDir();
  const gitBranch = useGitBranchName(targetDir) ?? '';
  const footerModel = config.getModel();
  const promptTokenCount = uiTelemetryService.getLastPromptTokenCount();
  const contextWindowSize =
    config.getContentGeneratorConfig()?.contextWindowSize;
  // Original status-line parity: the context indicator only appears once tokens
  // have been used, never bare.
  const contextLabel =
    contextWindowSize && promptTokenCount > 0
      ? ` · ${fmtTokens(contextWindowSize)} ${formatPercentageUsed(
          promptTokenCount / contextWindowSize,
        )}${contextUsageLabel(width)}`
      : '';
  const footerLine1 =
    `➜ ${nodePath.basename(targetDir)}` +
    (sessionName ? ` · ${sessionName}` : '') +
    (gitBranch ? ` · git:(${gitBranch})` : '') +
    (footerModel ? ` · ${footerModel}` : '') +
    contextLabel;
  // ink's AutoAcceptIndicator prefixes the default mode with a pause glyph and
  // suffixes the cycle shortcut; formatApprovalModeName is shared with the
  // dialogs and carries neither. Windows gets the bare-Tab wording because
  // some terminals there cannot tell Shift+Tab from Tab.
  const cycleText =
    process.platform === 'win32'
      ? t('(tab to cycle)')
      : t('(shift + tab to cycle)');
  const pausePrefix = approvalMode === ApprovalMode.DEFAULT ? '⏸ ' : '';
  const modeLabel = approvalMode
    ? `${pausePrefix}${formatApprovalModeName(approvalMode)} ${cycleText}`
    : null;
  const modeHint = shellModeActive
    ? 'shell mode enabled (esc to disable)'
    : [streaming ? t('Enter to steer · Ctrl+Q to queue') : null, modeLabel]
        .filter((segment): segment is string => segment !== null)
        .join(' · ');
  const queuedHint =
    queueLength > 0
      ? `⏳ ${t('{{count}} queued', { count: String(queueLength) })}`
      : null;
  const hintSegments = [modeHint || null, queuedHint].filter(
    (segment): segment is string => segment !== null,
  );
  // ink renders the badge as a sibling text node beginning with a literal
  // space, so it joins the hint with one space — unlike the ' · ' that ink's
  // leftBottomContent puts between its own segments.
  const footerLine2 = hintSegments.join(' ');

  // ink renders these two rows under different wrap policies: the status line
  // is `wrap="wrap"` inside a two-line `overflow="hidden"` box, so a narrow
  // terminal pushes the model segment onto a second row instead of dropping
  // it; the hint row is `wrap="truncate"`, so it cannot grow the footer
  // mid-turn (#8667/#8666).
  const rowBudget = Math.max(0, width - 4);
  const statusLines = wrapAnsi(footerLine1, Math.max(1, rowBudget), {
    trim: false,
    hard: true,
  }).split('\n');

  // ink gives the armed quit warning the footer's bottom hint slot and gates
  // its status line off while the warning is up, so the warning reads directly
  // under the composer with nothing above it. The queued-message segment sits
  // beside the warning rather than inside the hint it replaces, so it stays.
  if (exitHint) {
    const warningLine = [exitHint, queuedHint]
      .filter((segment): segment is string => segment !== null)
      .join(' ');
    return (
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        flexShrink={0}
      >
        <text fg={C.yellow}>{truncateToWidth(warningLine, rowBudget)}</text>
      </box>
    );
  }

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} flexShrink={0}>
      <text fg={C.dim}>{statusLines[0]}</text>
      {statusLines[1] && <text fg={C.dim}>{statusLines[1]}</text>}
      {footerLine2 && (
        <text fg={C.dim}>{truncateToWidth(footerLine2, rowBudget)}</text>
      )}
    </box>
  );
}
