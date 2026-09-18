/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookConfig } from './types.js';
import { hookRegistryIdentity } from './hookRegistry.js';
import { HookEventName, HookType, HooksConfigSource } from './types.js';

/**
 * Where a listed hook lives. `registry` rows come from settings files and
 * extensions, plus the hooks a subagent attaches while it runs; `session`
 * rows are hooks registered for the current session by skills, `/goal` or
 * the SDK. `source` alone cannot tell the two apart, because a subagent's
 * hooks sit in the registry with the source `session`.
 */
export type HooksListingOrigin = 'registry' | 'session';

/**
 * Why a listed hook will not run. Checked outermost-first: the inner toggles
 * are unobservable once an outer gate is closed, so a row reports the gate the
 * user has to open first.
 */
export type HooksListingDisabledReason =
  | 'bareMode'
  | 'safeMode'
  | 'allHooksDisabled'
  | 'untrusted'
  | 'registryDisabled';

/** One configured hook, flattened for display. */
export interface HooksListingRow {
  eventName: HookEventName;
  /** The matcher as configured; omitted when the entry has none. */
  matcher?: string;
  sequential?: boolean;
  source: HooksConfigSource;
  origin: HooksListingOrigin;
  /** Whether this hook would run now, with every gate below applied. */
  enabled: boolean;
  /** Set exactly when `enabled` is false. */
  disabledReason?: HooksListingDisabledReason;
  /**
   * Registered from repository-controlled configuration (a project skill's
   * frontmatter) and therefore run only while the folder is trusted.
   */
  trustGated?: boolean;
  /**
   * The subagent that attached this entry while it runs. Present only on
   * ephemeral per-agent registry entries; a consumer must not present these as
   * the user's own session hooks.
   */
  agentScope?: string;
  hookType: HookType;
  /** One-line identity, the text the ink /hooks handler list shows. */
  displayText: string;
  /** The literal command, URL or prompt, when the hook type has one. */
  commandText?: string;
  name?: string;
  description?: string;
  timeout?: number;
  statusMessage?: string;
  /** HTTP hooks: `once`. */
  runsOnce?: boolean;
  /** Command hooks: `async`. */
  runsInBackground?: boolean;
  /** HTTP hooks: `if`. */
  condition?: string;
  /** Session rows: the id the session hooks manager assigned. */
  hookId?: string;
  /** Session rows registered by a skill: the skill's root directory. */
  skillRoot?: string;
  /**
   * The hook configuration itself, for in-process consumers that need a
   * field this row does not flatten. It can carry `env` and HTTP `headers`,
   * which may hold secrets, so serialize it field by field, never whole.
   */
  config: HookConfig;
}

/**
 * Under `disableAllHooks` there is no hook system, so rows come from the
 * settings the session was built with and all of them are disabled. Safe and
 * bare mode load no hook settings at all, so their listing has no rows: a
 * consumer must use `safeMode` / `bareMode` to say that no hooks are loaded in
 * that mode, never that zero hooks are configured.
 */
export interface HooksListing {
  rows: HooksListingRow[];
  /**
   * `config.getDisableAllHooks()`: true under `disableAllHooks`, safe mode
   * and bare mode alike.
   */
  allDisabled: boolean;
  safeMode: boolean;
  bareMode: boolean;
}

export type HooksListingConfig = Pick<
  Config,
  | 'getHookSystem'
  | 'getDisableAllHooks'
  | 'isSafeMode'
  | 'getBareMode'
  | 'getSessionId'
  | 'isTrustedFolder'
  | 'getSystemHooks'
  | 'getUserHooks'
  | 'getProjectHooks'
  | 'getExtensions'
>;

const PROMPT_DISPLAY_LIMIT = 50;

/**
 * One-line identity for a hook. A port of `describeHook` in
 * packages/cli/src/ui/components/hooks/HandlerListBody.tsx: keep the two in
 * step until the ink dialog reads this listing too.
 */
export function describeHookConfig(config: HookConfig): string {
  switch (config.type) {
    case HookType.Command:
      return config.command || '';
    case HookType.Http:
      return config.name || config.url || '';
    case HookType.Function:
      return config.name || config.id || 'function-hook';
    case HookType.Prompt: {
      if (config.name) return config.name;
      const prompt = config.prompt || '';
      return prompt.length > PROMPT_DISPLAY_LIMIT
        ? `${prompt.slice(0, PROMPT_DISPLAY_LIMIT)}...`
        : prompt;
    }
    default: {
      const exhaustive: never = config;
      void exhaustive;
      return '';
    }
  }
}

function commandTextFor(config: HookConfig): string | undefined {
  switch (config.type) {
    case HookType.Command:
      return config.command;
    case HookType.Http:
      return config.url;
    case HookType.Prompt:
      return config.prompt;
    default:
      return undefined;
  }
}

interface RowPlacement {
  eventName: HookEventName;
  matcher?: string;
  sequential?: boolean;
  source: HooksConfigSource;
  origin: HooksListingOrigin;
  /** The entry's own switch; `true` for entries that have none. */
  entryEnabled: boolean;
  trustGated?: boolean;
  agentScope?: string;
  hookId?: string;
  skillRoot?: string;
}

/** The session-wide switches a row's enabled state depends on. */
export interface HooksListingGates {
  bareMode: boolean;
  safeMode: boolean;
  allDisabled: boolean;
  trustedFolder: boolean;
}

/**
 * Whether a hook with this placement would run, and if not, the outermost
 * reason: bare mode, then safe mode, then `disableAllHooks`, then folder trust
 * for trust-gated entries, then the entry's own switch.
 */
export function resolveRowEnabled(
  placement: { entryEnabled: boolean; trustGated?: boolean },
  gates: HooksListingGates,
): { enabled: true } | { enabled: false; reason: HooksListingDisabledReason } {
  if (gates.bareMode) return { enabled: false, reason: 'bareMode' };
  if (gates.safeMode) return { enabled: false, reason: 'safeMode' };
  if (gates.allDisabled) return { enabled: false, reason: 'allHooksDisabled' };
  if (placement.trustGated === true && !gates.trustedFolder) {
    return { enabled: false, reason: 'untrusted' };
  }
  if (!placement.entryEnabled) {
    return { enabled: false, reason: 'registryDisabled' };
  }
  return { enabled: true };
}

function toRow(
  config: HookConfig,
  placement: RowPlacement,
  gates: HooksListingGates,
): HooksListingRow {
  const state = resolveRowEnabled(placement, gates);
  const commandText = commandTextFor(config);
  const runsInBackground =
    config.type === HookType.Command && config.async === true;
  const runsOnce = config.type === HookType.Http && config.once === true;
  const condition = config.type === HookType.Http ? config.if : undefined;
  return {
    eventName: placement.eventName,
    ...(placement.matcher ? { matcher: placement.matcher } : {}),
    ...(placement.sequential !== undefined
      ? { sequential: placement.sequential }
      : {}),
    source: placement.source,
    origin: placement.origin,
    enabled: state.enabled,
    ...(state.enabled ? {} : { disabledReason: state.reason }),
    ...(placement.trustGated === true ? { trustGated: true } : {}),
    ...(placement.agentScope !== undefined
      ? { agentScope: placement.agentScope }
      : {}),
    hookType: config.type,
    displayText: describeHookConfig(config),
    ...(commandText !== undefined ? { commandText } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(config.description !== undefined
      ? { description: config.description }
      : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.statusMessage !== undefined
      ? { statusMessage: config.statusMessage }
      : {}),
    ...(runsOnce ? { runsOnce } : {}),
    ...(runsInBackground ? { runsInBackground } : {}),
    ...(condition !== undefined ? { condition } : {}),
    ...(placement.hookId !== undefined ? { hookId: placement.hookId } : {}),
    ...(placement.skillRoot !== undefined
      ? { skillRoot: placement.skillRoot }
      : {}),
    config,
  };
}

const HOOK_EVENT_NAMES: readonly string[] = Object.values(HookEventName);

/** The field each settings hook type must carry, as the registry requires. */
const LITERAL_FIELD: Readonly<Record<string, string>> = {
  [HookType.Command]: 'command',
  [HookType.Http]: 'url',
  [HookType.Prompt]: 'prompt',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A display-safe copy of one hook read straight from settings, or undefined
 * when the registry would not have accepted it. Function hooks cannot come
 * from settings JSON. Nothing validated these values, so every one that
 * reaches display text is coerced to a string.
 */
function displayableSettingsHook(raw: unknown): HookConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const literalField = LITERAL_FIELD[String(raw['type'])];
  const literal = literalField === undefined ? undefined : raw[literalField];
  if (typeof literal !== 'string' || literal === '') return undefined;
  const copy: Record<string, unknown> = { ...raw };
  for (const field of ['name', 'description', 'statusMessage', 'if']) {
    if (copy[field] === undefined || copy[field] === null) delete copy[field];
    else copy[field] = String(copy[field]);
  }
  if (typeof raw['timeout'] !== 'number') delete copy['timeout'];
  if (typeof raw['async'] !== 'boolean') delete copy['async'];
  if (typeof raw['once'] !== 'boolean') delete copy['once'];
  return copy as unknown as HookConfig;
}

/**
 * Rows for hooks configured in settings and extensions, read without a hook
 * system. Nothing here registers or runs anything: a malformed definition is
 * skipped for display only.
 */
function rowsFromSettings(
  config: HooksListingConfig,
  gates: HooksListingGates,
): HooksListingRow[] {
  const rows: HooksListingRow[] = [];
  // The registry drops a hook whose source, event, identity, matcher and
  // `sequential` all equal an earlier entry's, comparing the raw values with
  // `===`. Mirror that so this listing shows the rows the registry would keep.
  // A value `===` cannot match (an object or array) never collapses.
  const seen = new Set<string>();
  const keyPart = (value: unknown): string | undefined =>
    value === null || typeof value !== 'object'
      ? `${typeof value}:${String(value)}`
      : undefined;
  const isDuplicate = (
    eventName: string,
    source: HooksConfigSource,
    raw: unknown,
    definition: Record<string, unknown>,
  ): boolean => {
    const parts = [
      keyPart(hookRegistryIdentity(raw as HookConfig)),
      keyPart(definition['matcher']),
      keyPart(definition['sequential']),
    ];
    if (parts.some((part) => part === undefined)) return false;
    const key = JSON.stringify([eventName, source, ...parts]);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
  const addScope = (hooks: unknown, source: HooksConfigSource) => {
    if (!isRecord(hooks)) return;
    for (const [eventName, definitions] of Object.entries(hooks)) {
      // Also skips the non-event keys `enabled`, `disabled`, `notifications`.
      if (!HOOK_EVENT_NAMES.includes(eventName)) continue;
      if (!Array.isArray(definitions)) continue;
      for (const definition of definitions as unknown[]) {
        if (!isRecord(definition) || !Array.isArray(definition['hooks'])) {
          continue;
        }
        const matcher =
          typeof definition['matcher'] === 'string'
            ? definition['matcher']
            : undefined;
        const sequential =
          typeof definition['sequential'] === 'boolean'
            ? definition['sequential']
            : undefined;
        for (const raw of definition['hooks'] as unknown[]) {
          const hookConfig = displayableSettingsHook(raw);
          if (!hookConfig) continue;
          if (isDuplicate(eventName, source, raw, definition)) continue;
          rows.push(
            toRow(
              hookConfig,
              {
                eventName: eventName as HookEventName,
                matcher,
                sequential,
                source,
                origin: 'registry',
                entryEnabled: true,
              },
              gates,
            ),
          );
        }
      }
    }
  };

  addScope(config.getSystemHooks(), HooksConfigSource.System);
  addScope(config.getUserHooks(), HooksConfigSource.User);
  addScope(config.getProjectHooks(), HooksConfigSource.Project);
  for (const extension of config.getExtensions()) {
    if (extension.isActive && extension.hooks) {
      addScope(extension.hooks, HooksConfigSource.Extensions);
    }
  }
  return rows;
}

/**
 * Lists every hook the session can run: the registry's entries, followed by
 * the hooks registered for the current session. Each row says whether the hook
 * would run now and, when it would not, why. Rows are not dropped when hooks
 * are disabled, so a caller can show what is configured but switched off.
 */
export function buildHooksListing(config: HooksListingConfig): HooksListing {
  const listing: HooksListing = {
    rows: [],
    allDisabled: config.getDisableAllHooks(),
    safeMode: config.isSafeMode(),
    bareMode: config.getBareMode(),
  };
  const gates: HooksListingGates = {
    bareMode: listing.bareMode,
    safeMode: listing.safeMode,
    allDisabled: listing.allDisabled,
    trustedFolder: config.isTrustedFolder(),
  };
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    // Hooks are off, so there is no registry to read. Under disableAllHooks
    // rows still come from the settings the session was built with, so a user
    // can see WHAT is switched off and why. Nothing here registers or runs
    // anything. Safe and bare mode load no hook settings, so they list
    // nothing, and a Config without a hook system for another reason (not
    // initialized yet, or a helper that skips hooks) lists nothing rather
    // than rows that claim to be enabled.
    if (listing.allDisabled && !listing.safeMode && !listing.bareMode) {
      listing.rows.push(...rowsFromSettings(config, gates));
    }
    return listing;
  }

  for (const entry of hookSystem.getAllHooks()) {
    listing.rows.push(
      toRow(
        entry.config,
        {
          eventName: entry.eventName,
          matcher: entry.matcher,
          sequential: entry.sequential,
          source: entry.source,
          origin: 'registry',
          entryEnabled: entry.enabled,
          agentScope: entry.agentScope,
        },
        gates,
      ),
    );
  }

  const sessionId = config.getSessionId();
  if (sessionId) {
    const sessionHooks = hookSystem
      .getSessionHooksManager()
      .getAllSessionHooks(sessionId);
    for (const entry of sessionHooks) {
      listing.rows.push(
        toRow(
          entry.config,
          {
            eventName: entry.eventName,
            matcher: entry.matcher,
            sequential: entry.sequential,
            source: HooksConfigSource.Session,
            origin: 'session',
            // Session hooks have no switch of their own.
            entryEnabled: true,
            trustGated: entry.trustGated,
            hookId: entry.hookId,
            skillRoot: entry.skillRoot,
          },
          gates,
        ),
      );
    }
  }

  return listing;
}
