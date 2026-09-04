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

import type { Config } from '@qwen-code/qwen-code-core';
import {
  transcribeSession,
  type TranscriptResult,
} from './transcript-adapter.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

export interface ResumableSession {
  conversation: { messages: readonly unknown[] };
}

function sessionToJsonl(sessionData: ResumableSession): string {
  return sessionData.conversation.messages
    .map((record) => JSON.stringify(record))
    .join('\n');
}

/** Original resume renders tool registry display names ("Read File"), not raw
 * API names ("read_file"), whenever a registry is available. */
function transcribe(
  sessionData: ResumableSession,
  config?: Config,
): TranscriptResult {
  const registry =
    typeof config?.getToolRegistry === 'function'
      ? config.getToolRegistry()
      : undefined;
  return transcribeSession(sessionToJsonl(sessionData), {
    toolTitle: registry
      ? (name) => registry.getTool(name)?.displayName
      : undefined,
  });
}

/** Replays one loaded session as neutral events (ends with `done`). */
export function resumeEventsFromSession(
  sessionData: ResumableSession,
  config?: Config,
): OpenTuiStreamEvent[] {
  return transcribe(sessionData, config).events;
}

/** History-eligible user prompts of one loaded session, replay order. */
export function resumeUserPromptsFromSession(
  sessionData: ResumableSession,
  config?: Config,
): string[] {
  return transcribe(sessionData, config).prompts;
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
