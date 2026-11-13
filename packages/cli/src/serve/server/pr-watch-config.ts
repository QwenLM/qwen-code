/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution of the operator's `serve.sessionPrWatch` setting and its two
 * environment overrides (master design §6). Pure: no I/O, no clock.
 *
 * Loaded through the same dynamic import as the watch deps so it stays out of
 * the serve fast path's pre-listen closure.
 */

import {
  boundActionTemplateEntries,
  validateBoundActionEntries,
  type BoundActionKeyVocabulary,
} from '@qwen-code/channel-base';
import {
  PR_TRANSITION_TYPES,
  type PrTransitionType,
} from './pr-watch-store.js';

export const SESSION_PR_WATCH_EVENTS_ENV = 'QWEN_SESSION_PR_WATCH_EVENTS';
export const SESSION_PR_WATCH_WAKE_DORMANT_ENV =
  'QWEN_SESSION_PR_WATCH_WAKE_DORMANT';

/** The four transition types as the template-key vocabulary. */
const ACTION_VOCABULARY: BoundActionKeyVocabulary = {
  isEventClass: (event) => PR_TRANSITION_TYPES.has(event as PrTransitionType),
  eventClassDescription: `a transition type (${[...PR_TRANSITION_TYPES].join(', ')})`,
};

/**
 * A template map the operator must fix before the daemon starts. The boot
 * discriminates by class, as it does for `InvalidPolicyConfigError`, so a
 * typo refuses startup instead of silently disabling delivery.
 */
export class InvalidSessionPrWatchConfigError extends Error {
  override readonly name = 'InvalidSessionPrWatchConfigError';
}

export interface SessionPrWatchConfig {
  /** Empty means the watch is off: no view, no delivery, no ownership claim. */
  events: ReadonlySet<PrTransitionType>;
  wakeDormant: boolean;
  /** Absent keeps delivery on the legacy single winner with the generic prompt. */
  actions: ReadonlyMap<string, string> | undefined;
}

/** The shape `serve.sessionPrWatch` takes in settings, before validation. */
export interface SessionPrWatchSetting {
  events?: unknown;
  wakeDormant?: unknown;
  actions?: unknown;
}

function parseEvents(
  raw: unknown,
  source: string,
  onWarning: (message: string) => void,
): ReadonlySet<PrTransitionType> {
  if (raw === undefined) return new Set();
  // Only a list is accepted here. The environment's comma-separated form is
  // split by the caller, so a settings value written as a string stays the
  // type error the schema declares it to be.
  if (!Array.isArray(raw)) {
    onWarning(
      `qwen serve: ignoring invalid ${source} (expected a list of transition types)`,
    );
    return new Set();
  }
  const events = new Set<PrTransitionType>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      onWarning(
        `qwen serve: ignoring invalid ${source} (every entry must be a transition type)`,
      );
      return new Set();
    }
    const name = entry.trim();
    // A blank member comes from a trailing comma in the env form; it names no
    // event, so it is ignored rather than invalidating the whole list.
    if (name === '') continue;
    if (!PR_TRANSITION_TYPES.has(name as PrTransitionType)) {
      onWarning(
        `qwen serve: ignoring invalid ${source} (unrecognized transition type ${name})`,
      );
      return new Set();
    }
    events.add(name as PrTransitionType);
  }
  return events;
}

function parseWakeDormant(
  raw: unknown,
  source: string,
  onWarning: (message: string) => void,
): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
  }
  onWarning(
    `qwen serve: ignoring invalid ${source} (expected a boolean); keeping the default`,
  );
  return true;
}

/**
 * Resolve the effective configuration. `actions` validation throws, so a
 * template typo refuses the boot rather than silently disabling delivery;
 * `events` and `wakeDormant` warn and fall back, since a bad value there only
 * narrows the watch.
 */
export function resolveSessionPrWatchConfig(
  rawSetting: unknown,
  env: Readonly<Record<string, string | undefined>>,
  onWarning: (message: string) => void = () => {},
): SessionPrWatchConfig {
  // The fast-path summary carries serve sub-keys untyped, so this consumer
  // narrows and validates rather than trusting a cast at the call site — the
  // same shape `maxSessionsFromSettings` uses.
  const setting: SessionPrWatchSetting | undefined =
    rawSetting !== null &&
    typeof rawSetting === 'object' &&
    !Array.isArray(rawSetting)
      ? (rawSetting as SessionPrWatchSetting)
      : undefined;
  if (rawSetting !== undefined && setting === undefined) {
    onWarning(
      'qwen serve: ignoring invalid serve.sessionPrWatch (expected an object)',
    );
  }
  const envEvents = env[SESSION_PR_WATCH_EVENTS_ENV];
  const events =
    envEvents === undefined || envEvents.trim() === ''
      ? parseEvents(setting?.events, 'serve.sessionPrWatch.events', onWarning)
      : parseEvents(
          envEvents.split(','),
          SESSION_PR_WATCH_EVENTS_ENV,
          onWarning,
        );

  const envWake = env[SESSION_PR_WATCH_WAKE_DORMANT_ENV];
  const wakeDormant =
    envWake === undefined || envWake.trim() === ''
      ? parseWakeDormant(
          setting?.wakeDormant,
          'serve.sessionPrWatch.wakeDormant',
          onWarning,
        )
      : parseWakeDormant(envWake, SESSION_PR_WATCH_WAKE_DORMANT_ENV, onWarning);

  const source = {
    settingName: 'serve.sessionPrWatch.actions',
    ownerLabel: 'for the daemon',
  };
  let actions: ReadonlyMap<string, string> | undefined;
  try {
    const entries = boundActionTemplateEntries(setting?.actions, source);
    actions =
      entries === undefined
        ? undefined
        : validateBoundActionEntries(entries, source, ACTION_VOCABULARY);
  } catch (error) {
    throw new InvalidSessionPrWatchConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }

  return { events, wakeDormant, actions };
}
