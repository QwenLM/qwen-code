/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

/**
 * Operator config for idle suggestions (`~/.qwen/rc/idle.yaml`).
 *
 * SPEC DEVIATIONS (deliberate, traceable — `add-idle-suggestions`):
 *  - `enabled` DEFAULTS TO `false`, NOT the spec's `true`. The spec's "default
 *    shipped config is valid → enabled is true" assumes the in-process DAEMON
 *    design where a synthetic prompt never leaves the workstation. This fork uses
 *    OPTION B — the gateway makes its OWN call to an external model, shipping
 *    recent transcript content off-box — so default-OFF is required: a
 *    workstation that merely has model creds in its env must never start egressing
 *    transcripts without the operator opting in.
 *  - The spec's `idleAfterSec` (debounce timer) and `syntheticPrompt`
 *    (operator-injected prompt) DO NOT APPLY to option B: idle is detected via the
 *    pump's `hasActivePrompt` true→false poll-tick edge (no timer), and the
 *    gateway builds its own prompt. Those keys are accepted-but-ignored (lenient
 *    parse) so a spec-shaped file still loads — we never ship dead knobs that
 *    silently do nothing AND we never reject a file for carrying them.
 */
export interface IdleConfig {
  /** Master switch — fire-time gate; OFF by default (see deviation note). */
  enabled: boolean;
  /** Per-session rolling-hour cap on suggestion generations (token-bucket ≈). */
  maxSuggestionsPerHour: number;
  /** Max suggestions requested/emitted per firing. */
  maxSuggestions: number;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  enabled: false,
  maxSuggestionsPerHour: 5,
  maxSuggestions: 3,
};

/** Thrown by {@link parseIdleConfig} on a malformed/ill-typed document. */
export class IdleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdleConfigError';
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/**
 * Parse + validate an idle.yaml document into an {@link IdleConfig}. PURE; throws
 * {@link IdleConfigError} on a wrong-TYPE known field (so an operator typo like
 * `enabled: "yes"` surfaces — the reload path audits it). Unknown fields are
 * IGNORED (lenient — a spec-shaped file with `idleAfterSec`/`syntheticPrompt`
 * still loads). Out-of-range numbers are CLAMPED, not rejected. An empty/`null`
 * document yields the defaults.
 */
export function parseIdleConfig(text: string): IdleConfig {
  let doc: unknown;
  try {
    doc = parse(text) ?? {};
  } catch (err) {
    throw new IdleConfigError(`idle.yaml is not valid YAML: ${String(err)}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new IdleConfigError('idle.yaml must be a mapping');
  }
  const d = doc as Record<string, unknown>;

  let enabled = DEFAULT_IDLE_CONFIG.enabled;
  if (d['enabled'] !== undefined) {
    if (typeof d['enabled'] !== 'boolean') {
      throw new IdleConfigError('idle.yaml: `enabled` must be a boolean');
    }
    enabled = d['enabled'];
  }

  let maxSuggestionsPerHour = DEFAULT_IDLE_CONFIG.maxSuggestionsPerHour;
  if (d['maxSuggestionsPerHour'] !== undefined) {
    const v = d['maxSuggestionsPerHour'];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new IdleConfigError(
        'idle.yaml: `maxSuggestionsPerHour` must be a number',
      );
    }
    maxSuggestionsPerHour = clampInt(v, 1, 60);
  }

  let maxSuggestions = DEFAULT_IDLE_CONFIG.maxSuggestions;
  if (d['maxSuggestions'] !== undefined) {
    const v = d['maxSuggestions'];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new IdleConfigError('idle.yaml: `maxSuggestions` must be a number');
    }
    maxSuggestions = clampInt(v, 1, 10);
  }

  return { enabled, maxSuggestionsPerHour, maxSuggestions };
}

/**
 * Apply a hot-reload of idle.yaml text: parse it (may THROW {@link IdleConfigError}
 * for the caller to audit + retain the previous config) and then re-apply the
 * boot precedence — the `QWEN_RC_IDLE_SUGGESTIONS` env override forces
 * `enabled: true` regardless of the file, so a reload can never silently disable
 * a feature the operator turned on via the env. Pure.
 */
export function applyIdleReload(
  text: string,
  opts: { forceEnabled: boolean },
): IdleConfig {
  const cfg = parseIdleConfig(text);
  if (opts.forceEnabled) cfg.enabled = true;
  return cfg;
}

/**
 * Boot loader: read `path` and parse it, FAIL-OPEN to {@link DEFAULT_IDLE_CONFIG}
 * on a missing file (ENOENT) OR a malformed one (logged via `warn`) — idle
 * suggestions are enrichment, so a bad config must never crash boot. (The
 * hot-reload path, added in a later slice, calls {@link parseIdleConfig} directly
 * so it can audit a parse failure while RETAINING the previously good config.)
 */
export async function loadIdleConfig(
  path: string,
  warn: (msg: string) => void = () => {},
): Promise<IdleConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_IDLE_CONFIG };
    }
    warn(`idle.yaml unreadable, using defaults: ${String(err)}`);
    return { ...DEFAULT_IDLE_CONFIG };
  }
  try {
    return parseIdleConfig(text);
  } catch (err) {
    warn(`idle.yaml malformed, using defaults: ${(err as Error).message}`);
    return { ...DEFAULT_IDLE_CONFIG };
  }
}
