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
 * of the UI already uses, and carries the mode's indicator colour on the label
 * while its cycle shortcut stays secondary — the split ink's
 * `AutoAcceptIndicator` renders.
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
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  WAITING_SPINNER_FRAME,
} from '../constants.js';
import { usePhraseCycler } from '../hooks/usePhraseCycler.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { useTimer } from '../hooks/useTimer.js';
import { useAnimationFrame } from '../hooks/useAnimationFrame.js';
import { fmtTokens } from '../components/stats-helpers.js';
import { formatApprovalModeName } from '../utils/approvalModeDisplay.js';
import { formatModelWithReasoning } from '../statusLinePresets.js';
import { getReasoningForDisplay } from '../../acp-integration/model-configuration.js';
import {
  contextUsageLabel,
  formatDuration,
  formatPercentageUsed,
  formatTokenCount,
} from '../utils/formatters.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import { getCachedStringWidth, truncateToWidth } from '../utils/textUtils.js';
import { formatExecutionSandbox } from '../utils/execution-sandbox-display.js';
import { C } from './theme.js';

/** One coloured run of the footer's bottom hint row. */
interface HintPart {
  text: string;
  color: string;
}

/**
 * ink's `getApprovalModeIndicatorColor` (components/approvalModeVisuals.ts),
 * read off the mapped palette instead of the ink theme: ink returns raw theme
 * strings, and a CSS colour name opentui cannot parse degrades to magenta.
 */
function approvalModeColor(mode: ApprovalMode): string {
  switch (mode) {
    case ApprovalMode.PLAN:
      return C.green;
    case ApprovalMode.AUTO_EDIT:
      return C.yellow;
    case ApprovalMode.AUTO:
      return C.purple;
    case ApprovalMode.YOLO:
      return C.red;
    default:
      return C.dim;
  }
}

/**
 * Owns its frame timer so the high-frequency tick re-renders ONLY this 1-cell
 * component, not the whole transcript tree. ink's `RespondingSpinner` animates
 * while responding and draws one static frame while a call is parked on a
 * confirmation, so that row emits no bytes at all until the user answers.
 */
function Spinner({ waiting }: { waiting: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (waiting) return;
    const spin = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(spin);
  }, [waiting]);
  return (
    <box width={2}>
      <text fg={C.dim}>
        {waiting
          ? WAITING_SPINNER_FRAME
          : SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}
      </text>
    </box>
  );
}

export interface OpenTuiLoadingIndicatorProps {
  streaming: boolean;
  /**
   * A tool call is parked on a confirmation. ink swaps the phrase for its
   * waiting text and drops the timer/token/cancel suffix in this state — there
   * is no in-flight request to cancel and no tokens to count.
   */
  waiting?: boolean;
  /**
   * Live streaming-character count. Animated locally (ink `LoadingIndicator`
   * parity) so the 100ms tick re-renders only this row, never the transcript.
   */
  streamingCharsRef?: RefObject<number>;
  /** False while waiting on the API (↑), true once content arrives (↓). */
  isReceivingContent?: boolean;
  /**
   * False when `ui.accessibility.enableLoadingPhrases` is off. ink's `Composer`
   * passes no phrase in that case and the row still renders, so the row is not
   * what the setting removes — only its text.
   */
  showPhrase?: boolean;
}

/** Spinner + witty phrase + elapsed time + token estimate, above the composer. */
export function OpenTuiLoadingIndicator({
  streaming,
  waiting = false,
  streamingCharsRef,
  isReceivingContent = false,
  showPhrase = true,
}: OpenTuiLoadingIndicatorProps) {
  const { width } = useTerminalDimensions();
  // The shared cycler resolves the phrase list for all nine locales and owns
  // the 15s rotation, so this renderer cannot drift from ink's.
  const phrase = usePhraseCycler(streaming, waiting);
  // Paused rather than deactivated while a call is parked: useTimer zeroes its
  // accumulated elapsed on a false-to-true edge, so dropping `waiting` out of
  // `isActive` would restart the counter when the parked call resumes.
  const elapsedTime = useTimer(streaming, 0, waiting);
  const fallbackRef = useRef(0);
  const animatedChars = useAnimationFrame(
    streamingCharsRef ?? fallbackRef,
    streamingCharsRef && streaming ? 100 : null,
  );
  if (!streaming && !waiting) return null;

  const isNarrow = isNarrowWidth(width);
  const outputTokens = Math.round(animatedChars / 4);
  const showTokens = !isNarrow && outputTokens > 0;
  // Keep the timer's sub-second precision for the animation, but display only
  // completed whole seconds until the minute format takes over.
  const timeStr =
    elapsedTime < 60
      ? `${Math.floor(Math.max(0, elapsedTime))}s`
      : formatDuration(elapsedTime * 1000);
  const suffix = waiting
    ? ''
    : t('({{time}}{{tokens}} · esc to cancel)', {
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
  const phraseText = showPhrase ? truncateToWidth(phrase, phraseBudget) : '';
  return (
    <box paddingLeft={2} flexDirection={isNarrow ? 'column' : 'row'}>
      <box flexDirection="row">
        <Spinner waiting={waiting} />
        <text fg={C.dim}>
          {isNarrow || !suffix ? phraseText : `${phraseText} ${suffix}`}
        </text>
      </box>
      {isNarrow && suffix ? <text fg={C.dim}>{suffix}</text> : null}
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
  const generationConfig = config.getContentGeneratorConfig();
  // ink's status line renders the `model-with-reasoning` preset item, so the
  // segment carries the effort (or `reasoning off`), not the bare model id.
  const footerModel = formatModelWithReasoning(
    config.getModelDisplayName(),
    generationConfig && getReasoningForDisplay(config, generationConfig),
  );
  const promptTokenCount = uiTelemetryService.getLastPromptTokenCount();
  const contextWindowSize = generationConfig?.contextWindowSize;
  // Original status-line parity: the context indicator only appears once tokens
  // have been used, never bare.
  const contextLabel =
    contextWindowSize && promptTokenCount > 0
      ? ` · ${fmtTokens(contextWindowSize)} ${formatPercentageUsed(
          promptTokenCount / contextWindowSize,
        )}${contextUsageLabel(width)}`
      : '';
  const sandboxLabel = formatExecutionSandbox(config);
  const footerLine1 =
    `➜ ${nodePath.basename(targetDir)}` +
    (sessionName ? ` · ${sessionName}` : '') +
    (gitBranch ? ` · git:(${gitBranch})` : '') +
    (footerModel ? ` · ${footerModel}` : '') +
    contextLabel;
  // ink's AutoAcceptIndicator prefixes the default mode with a pause glyph,
  // colours the label with the mode's indicator colour and keeps the cycle
  // shortcut in text.secondary; formatApprovalModeName is shared with the
  // dialogs and carries none of the three. Windows gets the bare-Tab wording
  // because some terminals there cannot tell Shift+Tab from Tab.
  const cycleText =
    process.platform === 'win32'
      ? t('(tab to cycle)')
      : t('(shift + tab to cycle)');
  const pausePrefix = approvalMode === ApprovalMode.DEFAULT ? '⏸ ' : '';
  const modeHint: HintPart[] = shellModeActive
    ? [{ text: 'shell mode enabled (esc to disable)', color: C.dim }]
    : [
        ...(streaming
          ? [
              { text: t('Enter to steer · Ctrl+Q to queue'), color: C.dim },
              // ink's leftBottomContent puts ' · ' between its own segments,
              // but only where two of them are actually present.
              ...(approvalMode ? [{ text: ' · ', color: C.dim }] : []),
            ]
          : []),
        ...(approvalMode
          ? [
              {
                text: `${pausePrefix}${formatApprovalModeName(approvalMode)}`,
                color: approvalModeColor(approvalMode),
              },
              { text: ` ${cycleText}`, color: C.dim },
            ]
          : []),
      ];
  const queuedHint =
    queueLength > 0
      ? `⏳ ${t('{{count}} queued', { count: String(queueLength) })}`
      : null;
  // ink renders the badge as a sibling text node beginning with a literal
  // space, so it joins the hint with one space.
  const hintParts: HintPart[] = [
    ...modeHint,
    ...(queuedHint
      ? [
          ...(modeHint.length > 0 ? [{ text: ' ', color: C.dim }] : []),
          { text: queuedHint, color: C.dim },
        ]
      : []),
  ];

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
  // One truncated line in ink; cut part by part against the remaining budget so
  // the coloured mode label survives narrowing instead of being dropped whole.
  const hintRow: HintPart[] = [];
  let hintBudget = rowBudget;
  for (const part of hintParts) {
    if (hintBudget <= 0) break;
    const text = truncateToWidth(part.text, hintBudget);
    if (text) hintRow.push({ text, color: part.color });
    hintBudget -= getCachedStringWidth(text);
    if (text.length !== part.text.length) break;
  }

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
      {sandboxLabel && <text fg={C.dim}>{sandboxLabel}</text>}
      {/* ink colours the built-in status line with text.accent (Footer.tsx);
       * a user-supplied statusline keeps its own colours, which this port does
       * not render at all. */}
      <text fg={C.accent}>{statusLines[0]}</text>
      {statusLines[1] && <text fg={C.accent}>{statusLines[1]}</text>}
      {hintRow.length > 0 && (
        <box flexDirection="row">
          {hintRow.map((part, i) => (
            <text key={`${i}`} fg={part.color}>
              {part.text}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}
