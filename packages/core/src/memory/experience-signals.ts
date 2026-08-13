/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { ToolNames } from '../tools/tool-names.js';

/**
 * Deterministic proxies for the skill-review prompt's own admission criteria
 * ("trial and error, or changing course, or the user expected a different
 * method or outcome"). Used to gate `scheduleSkillReview` so a tool-call
 * count alone neither fires on read-only sessions nor misses short
 * debugging arcs.
 */
export interface ExperienceSignals {
  /** A failed tool result followed by success from the same tool. */
  retryArc: boolean;
  /** The user steered the agent mid-turn. Not derivable from history; the
   * caller (GeminiClient) sets it from its own steer tracking. */
  userSteer: boolean;
  /** At least one write/execute tool call — gates the count backstop so
   * read-only sessions never trigger a review. */
  hasSubstantiveWork: boolean;
}

export interface ExperienceSignalAccumulator
  extends Omit<ExperienceSignals, 'userSteer'> {
  /** Tools with a failure not yet followed by a confirmed success. */
  failedToolNames: ReadonlySet<string>;
}

export function hasExperienceSignal(signals: ExperienceSignals): boolean {
  return signals.retryArc || signals.userSteer;
}

const SUBSTANTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
]);

export function isSubstantiveToolCall(name: string): boolean {
  return SUBSTANTIVE_TOOL_NAMES.has(name);
}

// The real status block emitted by shell.ts ends with `Exit Code: N` followed
// by a `Signal:` line; command output is embedded before it, so a forged
// `Exit Code:` line inside the output cannot satisfy this anchor.
const EXIT_CODE_PATTERN = /\nExit Code: (\d+)\nSignal: /;

function isFailedResponse(part: {
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}): boolean | null {
  const fr = part.functionResponse;
  if (!fr?.name || !fr.response) return null;
  const error = fr.response['error'];
  if (typeof error === 'string' && error.trim()) return true;
  if (fr.name === ToolNames.SHELL) {
    const output = fr.response['output'];
    const exit =
      typeof output === 'string' ? EXIT_CODE_PATTERN.exec(output) : null;
    return exit ? exit[1] !== '0' : null;
  }
  return false;
}

/** Adds a history fragment to an accumulator that survives history compaction. */
export function accumulateExperienceSignals(
  history: Content[],
  initial: ExperienceSignalAccumulator = {
    retryArc: false,
    hasSubstantiveWork: false,
    failedToolNames: new Set(),
  },
): ExperienceSignalAccumulator {
  let { retryArc, hasSubstantiveWork } = initial;
  const failedToolNames = new Set(initial.failedToolNames);

  for (const content of history) {
    for (const part of content.parts ?? []) {
      if (part.functionCall) {
        if (isSubstantiveToolCall(part.functionCall.name ?? '')) {
          hasSubstantiveWork = true;
        }
        continue;
      }
      const failed = isFailedResponse(part);
      if (failed === null) continue;
      const toolName = part.functionResponse?.name;
      if (!toolName) continue;
      if (failed) {
        failedToolNames.add(toolName);
      } else if (failedToolNames.delete(toolName)) {
        retryArc = true;
      }
    }
  }

  return { retryArc, hasSubstantiveWork, failedToolNames };
}

/** Scans one complete history window. `userSteer` is supplied by the caller. */
export function detectExperienceSignals(
  history: Content[],
): Omit<ExperienceSignals, 'userSteer'> {
  const { failedToolNames: _failedToolNames, ...signals } =
    accumulateExperienceSignals(history);
  return signals;
}
