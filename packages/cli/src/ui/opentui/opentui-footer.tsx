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
 * of the UI already uses, and stays dim: the row is truncated as one unit, and
 * the composer keeps the coloured label for the modes where colour carries
 * weight. ink's `(shift + tab to cycle)` suffix is omitted because shift+tab is
 * not bound in this renderer.
 */

import { useEffect, useState } from 'react';
import nodePath from 'node:path';
import { useTerminalDimensions } from '@opentui/react';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../constants.js';
import { usePhraseCycler } from '../hooks/usePhraseCycler.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { fmtTokens } from '../components/stats-helpers.js';
import { formatApprovalModeName } from '../utils/approvalModeDisplay.js';
import {
  contextUsageLabel,
  formatPercentageUsed,
} from '../utils/formatters.js';
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
}

/** Spinner + witty phrase + elapsed seconds, shown above the composer. */
export function OpenTuiLoadingIndicator({
  streaming,
}: OpenTuiLoadingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);
  const { width } = useTerminalDimensions();
  // The shared cycler resolves the phrase list for all nine locales and owns
  // the 15s rotation, so this renderer cannot drift from ink's.
  const phrase = usePhraseCycler(streaming, false);
  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, [streaming]);
  if (!streaming) return null;
  const suffix = t('({{time}}{{tokens}} · esc to cancel)', {
    time: `${elapsed}s`,
    tokens: '',
  });
  // ink truncates the phrase (`wrap="truncate-end"`) rather than letting it wrap,
  // so the cancel hint survives a narrow terminal. Budget = width − 2 padding −
  // 2 spinner cells − 1 separating space − the suffix.
  const phraseBudget = Math.max(0, width - 5 - getCachedStringWidth(suffix));
  const line = [truncateToWidth(phrase, phraseBudget), suffix]
    .filter(Boolean)
    .join(' ');
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="row">
      <Spinner />
      <text fg={C.dim}>{line}</text>
    </box>
  );
}

export interface OpenTuiFooterProps {
  config: Config;
  streaming: boolean;
  queueLength?: number;
  sessionName?: string | null;
  approvalMode?: ApprovalMode;
}

/** The status line (ink `Footer` parity). */
export function OpenTuiFooter({
  config,
  streaming,
  queueLength = 0,
  sessionName = null,
  approvalMode,
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
  const hintSegments = [
    streaming ? t('Enter to steer · Ctrl+Q to queue') : null,
    approvalMode ? formatApprovalModeName(approvalMode) : null,
    queueLength > 0
      ? `⏳ ${t('{{count}} queued', { count: String(queueLength) })}`
      : null,
  ].filter((segment): segment is string => segment !== null);
  const footerLine2 = hintSegments.join(' · ');

  // ink Footer parity: the status rows are truncated, never wrapped, so a long
  // branch or path cannot grow the footer mid-turn (#8667/#8666).
  const rowBudget = Math.max(0, width - 2);

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text fg={C.dim}>{truncateToWidth(footerLine1, rowBudget)}</text>
      {footerLine2 && (
        <text fg={C.dim}>{truncateToWidth(footerLine2, rowBudget)}</text>
      )}
    </box>
  );
}
