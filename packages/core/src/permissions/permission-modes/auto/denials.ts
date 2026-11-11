/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks commands that were denied by the auto-mode classifier during
 * a session. These denials are surfaced in the /permissions dialog's
 * "Recently denied" tab so users can approve or retry them.
 *
 * The log is a factory rather than a module-level array: it is session state,
 * and a process running several sessions needs one per session. `AutoClassifier`
 * owns the instance, so the refusals one session accumulates are exactly the
 * ones its own permissions dialog lists.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A single auto-mode denial record.
 */
export type AutoModeDenial = {
  /** The tool name that was denied (e.g., 'Bash') */
  toolName: string;
  /** Human-readable display string (e.g., the shell command) */
  display: string;
  /** Reason for the denial */
  reason: string;
  /** Timestamp of when the denial occurred */
  timestamp: number;
};

export interface AutoModeDenialLog {
  record(denial: AutoModeDenial): void;
  /** A copy — safe to iterate without mutation concerns. */
  getAll(): readonly AutoModeDenial[];
  clear(): void;
}

// ============================================================================
// Factory
// ============================================================================

/** Maximum number of denials to keep in memory. */
const MAX_DENIALS = 20;

/** Maximum length for the display field to prevent memory bloat. */
const MAX_DISPLAY_LENGTH = 200;

/**
 * Creates an in-memory denial log. Oldest entries are evicted past the cap and
 * each display field is truncated, so a long session cannot grow the list
 * without bound.
 */
export function createAutoModeDenialLog(): AutoModeDenialLog {
  const denials: AutoModeDenial[] = [];

  return {
    record(denial: AutoModeDenial): void {
      denials.push({
        ...denial,
        display: denial.display.slice(0, MAX_DISPLAY_LENGTH),
      });
      if (denials.length > MAX_DENIALS) {
        denials.shift();
      }
    },

    getAll(): readonly AutoModeDenial[] {
      return [...denials];
    },

    clear(): void {
      denials.length = 0;
    },
  };
}
