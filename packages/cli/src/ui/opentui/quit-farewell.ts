/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/quit` farewell for the OpenTUI backend (ink parity).
 *
 * The ink tree renders a `QuittingDisplay` panel on quit — "Agent powering
 * down. Goodbye!" plus the session wall-clock duration and a `qwen --resume
 * <id>` hint — before draining the exit-cleanup chain. The original OpenTUI
 * backend destroyed the renderer and exited immediately, so the farewell was
 * never shown and the resume hint was lost.
 *
 * This module builds the farewell text from the REAL session start time
 * (`uiTelemetryService.getSessionStartTime()`, which `/clear` keeps correct)
 * and echoes it to stdout during exit cleanup so it survives the renderer
 * teardown.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { formatDuration } from '../utils/displayUtils.js';
import { t } from '../../i18n/index.js';

export interface QuitFarewellInput {
  /** Session id for the `qwen --resume` hint. */
  sessionId: string;
  /** Real session start (uiTelemetryService.getSessionStartTime()). */
  sessionStartTime: Date;
  /** Whether the transcript can be resumed (chat recording enabled). */
  canResume: boolean;
  /** Whether at least one user prompt was submitted this session. */
  hasMessages: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Builds the farewell lines shown on `/quit`. Mirrors ink's
 * `SessionSummaryDisplay`: goodbye + wall-clock duration, then the resume
 * hint only when there is something to resume.
 */
export function buildQuitFarewellLines(input: QuitFarewellInput): string[] {
  const now = input.now ?? Date.now();
  const wallMs = Math.max(0, now - input.sessionStartTime.getTime());
  const lines = [
    t('Agent powering down. Goodbye!'),
    `${t('Wall Time:')}: ${formatDuration(wallMs)}`,
  ];
  if (input.hasMessages && input.canResume) {
    lines.push('', t('To continue this session, run'));
    lines.push(`qwen --resume ${input.sessionId}`);
  }
  return lines;
}

/**
 * Derives the farewell for the live `config`, reading the real session start
 * time from the injected telemetry source (never the placeholder object the
 * command host carries). Returns null when no session id is available.
 */
export function buildQuitFarewellForConfig(
  config: Config,
  hasMessages: boolean,
  sessionStartTime: Date,
): string[] | null {
  const sessionId = config.getSessionId();
  if (!sessionId) return null;
  const canResume = Boolean(config.getChatRecordingService());
  return buildQuitFarewellLines({
    sessionId,
    sessionStartTime,
    canResume,
    hasMessages,
  });
}
