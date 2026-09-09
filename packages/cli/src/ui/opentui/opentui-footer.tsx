/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI footer + loading indicator — visual-parity restore of the ink
 * `Footer` status line and the responding spinner, ported back from the
 * pre-batch `feat/opentui-migrate` implementation the batched merge dropped.
 *
 * Footer mirrors the original: `➜ project · session · git:(branch) · model ·
 * context% used` plus an approval-mode row. The loading indicator
 * (self-contained 120ms spinner + rotating witty phrase + elapsed seconds)
 * sits above the composer while a turn is in flight.
 */

import { useEffect, useState } from 'react';
import nodePath from 'node:path';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { fmtTokens } from '../components/stats-helpers.js';
import { C } from './theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Original witty loading phrases (i18n WITTY_LOADING_PHRASES, en subset). */
const WITTY_LOADING_PHRASES = [
  "I'm Feeling Lucky",
  'Shipping awesomeness... ',
  'Reticulating splines...',
  'Consulting the digital spirits...',
  'Warming up the AI hamsters...',
  'Generating witty retort...',
  'Polishing the algorithms...',
  'Brewing fresh bytes...',
  'Engaging cognitive processors...',
  'Untangling neural nets...',
  'Compiling brilliance...',
  'Crafting a response worthy of your patience...',
];

const randomPhrase = () =>
  WITTY_LOADING_PHRASES[
    Math.floor(Math.random() * WITTY_LOADING_PHRASES.length)
  ];

/**
 * Self-contained spinner: owns its 120ms frame timer so the high-frequency tick
 * re-renders ONLY this 1-cell component, not the whole transcript tree.
 */
function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(spin);
  }, []);
  return (
    <box width={2}>
      <text fg={C.dim}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</text>
    </box>
  );
}

export function approvalModeLabel(mode: string): string {
  switch (mode) {
    case 'yolo':
      return 'YOLO';
    case 'auto-edit':
    case 'accepting-edits':
      return 'Auto-edit';
    case 'auto':
      return 'Auto';
    case 'plan':
      return 'Plan';
    default:
      return 'Default';
  }
}

/** `5%` not `5.0%` (original status-line parity). */
const formatPercentUsed = (pct: number): string => {
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded);
};

export interface OpenTuiLoadingIndicatorProps {
  streaming: boolean;
}

/** Spinner + witty phrase + elapsed seconds, shown above the composer. */
export function OpenTuiLoadingIndicator({
  streaming,
}: OpenTuiLoadingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);
  const [phrase, setPhrase] = useState(WITTY_LOADING_PHRASES[0]);
  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    setPhrase(randomPhrase());
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000);
    const rotate = setInterval(() => setPhrase(randomPhrase()), 15000);
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [streaming]);
  if (!streaming) return null;
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="row">
      <Spinner />
      <text fg={C.dim}>{`${phrase} (${elapsed}s · Esc to cancel)`}</text>
    </box>
  );
}

export interface OpenTuiFooterProps {
  config: Config;
  streaming: boolean;
  approvalMode?: ApprovalMode;
  queueLength?: number;
  sessionName?: string | null;
}

/** The status line + approval-mode row (ink `Footer` parity). */
export function OpenTuiFooter({
  config,
  streaming,
  approvalMode,
  queueLength = 0,
  sessionName = null,
}: OpenTuiFooterProps) {
  const cfg = config as unknown as
    | {
        getTargetDir?: () => string;
        getModel?: () => unknown;
        getContentGeneratorConfig?: () =>
          | { contextWindowSize?: number }
          | undefined;
      }
    | undefined;
  const targetDir = cfg?.getTargetDir?.() ?? process.cwd();
  const gitBranch = useGitBranchName(targetDir) ?? '';

  const footerProject = nodePath.basename(targetDir);
  const fm = cfg?.getModel?.();
  const footerModel =
    typeof fm === 'string'
      ? fm
      : ((fm as { id?: string } | undefined)?.id ?? '');
  const promptTokenCount = uiTelemetryService.getLastPromptTokenCount();
  const contextWindowSize =
    cfg?.getContentGeneratorConfig?.()?.contextWindowSize;
  // Original status-line parity: the context indicator only appears once tokens
  // have been used, never bare.
  const contextPct =
    contextWindowSize && promptTokenCount > 0
      ? Math.min(
          100,
          Math.round((promptTokenCount / contextWindowSize) * 1000) / 10,
        )
      : null;
  const contextLabel =
    contextWindowSize && contextPct != null
      ? ` · ${fmtTokens(contextWindowSize)} Context ${formatPercentUsed(
          contextPct,
        )}% used`
      : '';
  const footerLine1 =
    `➜ ${footerProject}` +
    (sessionName ? ` · ${sessionName}` : '') +
    (gitBranch ? ` · git:(${gitBranch})` : '') +
    (footerModel ? ` · ${footerModel}` : '') +
    contextLabel;

  const modeName = approvalModeLabel(String(approvalMode ?? ''));
  const modeUpper = modeName.toUpperCase();
  const modeColor =
    modeUpper === 'YOLO'
      ? C.red
      : modeUpper === 'AUTO' || modeUpper === 'AUTO-EDIT'
        ? C.green
        : modeUpper === 'PLAN'
          ? C.accent
          : C.dim;

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text fg={C.dim}>{footerLine1}</text>
      <box flexDirection="row">
        {streaming && (
          <text fg={C.dim}>{'Enter to steer · Ctrl+Q to queue · '}</text>
        )}
        <text fg={modeColor}>{`${modeName} mode`}</text>
        <text fg={C.dim}>{' (shift + tab to cycle)'}</text>
        {queueLength > 0 && (
          <text fg={C.dim}>{` · ⏳ ${queueLength} queued`}</text>
        )}
      </box>
    </box>
  );
}
