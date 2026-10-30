/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resume wiring for the OpenTUI backend (PR1 slice 2): feeds the already-loaded
 * resumed session (`config.getResumedSessionData()`, populated from
 * `--resume <id>` / `--continue`) through the transcript adapter so the neutral
 * model replays the real history (user / assistant / tool / thought) exactly
 * like the original ink resume path feeds `buildResumedHistoryItems`.
 */

import type { Config, ResumedSessionData } from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import { projectHistoryToStreamEvents } from './item-projection.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

export type ResumableSession = Pick<
  ResumedSessionData,
  'conversation' | 'historyGaps'
>;

/** Replays one loaded session as neutral events (ends with `done`). */
export function resumeEventsFromSession(
  sessionData: ResumableSession,
  config?: Config,
): OpenTuiStreamEvent[] {
  return projectHistoryToStreamEvents(
    buildResumedHistoryItems(sessionData, config ?? null),
    { config },
  );
}

/** History-eligible user prompts of one loaded session, replay order. */
export function resumeUserPromptsFromSession(
  sessionData: ResumableSession,
  config?: Config,
): string[] {
  return buildResumedHistoryItems(sessionData, config ?? null).flatMap(
    (item) => (item.type === 'user' ? [item.text] : []),
  );
}

/** Neutral resume events for the config's resumed session, if any. */
export function resumeEventsFromConfig(
  config: Config,
): OpenTuiStreamEvent[] | undefined {
  const sessionData = config.getResumedSessionData();
  if (!sessionData) return undefined;
  return resumeEventsFromSession(sessionData, config);
}

/** History-eligible prompts of the config's resumed session, if any. */
export function resumeUserPromptsFromConfig(
  config: Config,
): string[] | undefined {
  const sessionData = config.getResumedSessionData();
  if (!sessionData) return undefined;
  return resumeUserPromptsFromSession(sessionData, config);
}
