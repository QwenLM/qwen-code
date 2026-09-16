/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import type { HookConfig, HookEventName } from './types.js';
import { HookType, HooksConfigSource } from './types.js';

/**
 * Where a listed hook lives. `registry` rows come from settings files and
 * extensions, plus the hooks a subagent attaches while it runs; `session`
 * rows are hooks registered for the current session by skills or
 * the SDK. `source` alone cannot tell the two apart, because a subagent's
 * hooks sit in the registry with the source `session`.
 */
export type HooksListingOrigin = 'registry' | 'session';

/** One configured hook, flattened for display. */
export interface HooksListingRow {
  eventName: HookEventName;
  /** The matcher as configured; omitted when the entry has none. */
  matcher?: string;
  sequential?: boolean;
  source: HooksConfigSource;
  origin: HooksListingOrigin;
  enabled: boolean;
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
  extensionName?: string;
  extensionPath?: string;
  /**
   * The hook configuration itself, for in-process consumers that need a
   * field this row does not flatten. It can carry `env` and HTTP `headers`,
   * which may hold secrets, so serialize it field by field, never whole.
   */
  config: HookConfig;
}

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
  | 'getExtensions'
>;

const PROMPT_DISPLAY_LIMIT = 50;

/** One-line identity shared by hook listing consumers. */
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
  enabled: boolean;
  hookId?: string;
  skillRoot?: string;
}

function toRow(config: HookConfig, placement: RowPlacement): HooksListingRow {
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
    enabled: placement.enabled,
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

function hookIdentity(config: HookConfig): string {
  if (config.name) return config.name;
  switch (config.type) {
    case HookType.Command:
      return config.command || 'unknown-command';
    case HookType.Http:
      return config.url || 'unknown-url';
    case HookType.Function:
      return config.id || 'unknown-function';
    case HookType.Prompt:
      return config.prompt || 'prompt-hook';
    default: {
      const exhaustive: never = config;
      void exhaustive;
      return 'unknown-hook';
    }
  }
}

/**
 * Lists every hook the session can run: the registry's entries with their
 * real enabled state, followed by the hooks registered for the current
 * session. Rows are not dropped when hooks are disabled, so a caller can show
 * what is configured but switched off; without a hook system there are none.
 */
export function buildHooksListing(config: HooksListingConfig): HooksListing {
  const listing: HooksListing = {
    rows: [],
    allDisabled: config.getDisableAllHooks(),
    safeMode: config.isSafeMode(),
    bareMode: config.getBareMode(),
  };
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    return listing;
  }

  for (const entry of hookSystem.getAllHooks()) {
    const row = toRow(entry.config, {
      eventName: entry.eventName,
      matcher: entry.matcher,
      sequential: entry.sequential,
      source: entry.source,
      origin: 'registry',
      enabled: entry.enabled,
    });
    if (entry.source === HooksConfigSource.Extensions) {
      const identity = hookIdentity(entry.config);
      const extensions = config
        .getExtensions()
        .filter(
          (extension) =>
            extension.isActive &&
            extension.hooks?.[entry.eventName]?.some((definition) =>
              definition.hooks.some((hook) => hookIdentity(hook) === identity),
            ),
        );
      const extension = extensions[0];
      if (extension) {
        row.extensionName = extension.displayName ?? extension.name;
        row.extensionPath = extension.path;
      }
      if (extensions.length > 1) {
        createDebugLogger('HOOKS_LISTING').debug(
          'Multiple extensions match a registered hook; using the first extension.',
        );
      }
    }
    listing.rows.push(row);
  }

  const sessionId = config.getSessionId();
  if (sessionId) {
    const sessionHooks = hookSystem
      .getSessionHooksManager()
      .getAllSessionHooks(sessionId);
    for (const entry of sessionHooks) {
      listing.rows.push(
        toRow(entry.config, {
          eventName: entry.eventName,
          matcher: entry.matcher,
          sequential: entry.sequential,
          source: HooksConfigSource.Session,
          origin: 'session',
          enabled: true,
          hookId: entry.hookId,
          skillRoot: entry.skillRoot,
        }),
      );
    }
  }

  return listing;
}
