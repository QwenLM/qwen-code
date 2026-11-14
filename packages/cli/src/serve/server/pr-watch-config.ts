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
  resolveBoundActionTemplate,
  validateBoundActionEntries,
  PR_BINDING_ROLES,
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
  /**
   * True when the operator configured the subscription themselves: the
   * setting key is present, or the events environment override is non-blank.
   * The deprecated channel alias applies only when this is false, so an
   * explicit setting always wins, including one that subscribes nothing.
   */
  explicit: boolean;
  wakeDormant: boolean;
  /** Absent keeps delivery on the legacy single winner with the generic prompt. */
  actions: ReadonlyMap<string, string> | undefined;
}

/** One GitHub channel this daemon hosts, as the deprecated alias reads it. */
export interface HostedGithubChannel {
  name: string;
  /** Normalised watch host (bare hostname, no port) of the channel's PRs. */
  host: string;
  prWatchEvents?: unknown;
  boundSessionActions?: unknown;
  deliverToBoundSessions?: unknown;
}

/**
 * The effective subscription after the explicit setting and, when the
 * operator set none, the deprecated per-host channel alias.
 */
export interface PrWatchSubscription {
  /** The effective event set for a normalised watch host. */
  eventsForHost(host: string): ReadonlySet<PrTransitionType>;
  /**
   * The templates for one transition type on one host. `undefined` keeps the
   * legacy single winner; a map — possibly empty — selects role-aware
   * delivery. An empty map means no role subscribed that type, which is how a
   * role-aware channel with no matching key receives nothing.
   */
  actionsForEvent(
    type: PrTransitionType,
    host: string,
  ): ReadonlyMap<string, string> | undefined;
  /** Whether any host subscribes any event. */
  anyEvents: boolean;
}

const NO_EVENTS: ReadonlySet<PrTransitionType> = new Set();

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

  return {
    events,
    explicit:
      rawSetting !== undefined ||
      (envEvents !== undefined && envEvents.trim() !== ''),
    wakeDormant,
    actions,
  };
}

interface ParsedAliasChannel {
  name: string;
  host: string;
  events: ReadonlySet<PrTransitionType>;
  /** Undefined keeps the legacy single winner for this channel. */
  templates: ReadonlyMap<string, string> | undefined;
  /** The keys that can resolve each type, following the template chain. */
  actionsByType: ReadonlyMap<PrTransitionType, ReadonlyMap<string, string>>;
}

function parseAliasEvents(
  raw: unknown,
  channelName: string,
  log: (message: string) => void,
): ReadonlySet<PrTransitionType> {
  if (raw === undefined) return NO_EVENTS;
  if (!Array.isArray(raw)) {
    log(
      `PR watch: ignoring prWatchEvents for channel ${channelName} (expected a list)`,
    );
    return NO_EVENTS;
  }
  const events = new Set<PrTransitionType>();
  for (const value of raw) {
    if (typeof value !== 'string') {
      log(
        `PR watch: ignoring prWatchEvents for channel ${channelName} (every entry must be a transition type)`,
      );
      return NO_EVENTS;
    }
    const name = value.trim().toLowerCase();
    if (name === '') continue;
    if (!PR_TRANSITION_TYPES.has(name as PrTransitionType)) {
      log(
        `PR watch: ignoring prWatchEvents for channel ${channelName} (unrecognized transition type ${name})`,
      );
      return NO_EVENTS;
    }
    events.add(name as PrTransitionType);
  }
  return events;
}

/**
 * The channel's templates as strings. Keys this alias does not recognise —
 * notification reasons, for example — are kept in the map and simply never
 * match a transition type; the channel itself is the validator for them.
 */
function parseAliasTemplates(
  raw: unknown,
  channelName: string,
  log: (message: string) => void,
): ReadonlyMap<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log(
      `PR watch: ignoring boundSessionActions for channel ${channelName} (expected an object)`,
    );
    return undefined;
  }
  const templates = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.trim() === '') {
      log(
        `PR watch: ignoring boundSessionActions["${key}"] for channel ${channelName} (expected a non-empty template)`,
      );
      continue;
    }
    templates.set(key, value.trim());
  }
  return templates.size > 0 ? templates : undefined;
}

/**
 * The subset of a role-aware channel's templates that resolves one type,
 * after stripping the channel's `watch:` prefix. `default` and `<role>:default`
 * are kept: the resolution chain falls back to them.
 */
function aliasActionsForType(
  templates: ReadonlyMap<string, string>,
  type: PrTransitionType,
): ReadonlyMap<string, string> {
  const actions = new Map<string, string>();
  for (const [key, value] of templates) {
    if (key === 'default') {
      actions.set('default', value);
      continue;
    }
    if (key === `watch:${type}`) {
      actions.set(type, value);
      continue;
    }
    const colon = key.indexOf(':');
    if (colon === -1) continue;
    const role = key.slice(0, colon);
    if (!(PR_BINDING_ROLES as readonly string[]).includes(role)) continue;
    const event = key.slice(colon + 1);
    if (event === 'default') actions.set(`${role}:default`, value);
    else if (event === `watch:${type}`) actions.set(`${role}:${type}`, value);
  }
  return actions;
}

function aliasCanDeliver(
  actions: ReadonlyMap<string, string>,
  type: PrTransitionType,
): boolean {
  if (actions.size === 0) return false;
  if (resolveBoundActionTemplate(actions, undefined, type) !== undefined) {
    return true;
  }
  return PR_BINDING_ROLES.some(
    (role) => resolveBoundActionTemplate(actions, role, type) !== undefined,
  );
}

/**
 * The deprecated per-host alias: each hosted GitHub channel contributes its
 * `prWatchEvents` and its `watch:*` actions for PRs on its web host. An
 * explicit setting never reaches here, so it wins by construction.
 */
function resolveAlias(
  channels: readonly HostedGithubChannel[],
  log: (message: string) => void,
): PrWatchSubscription {
  const parsed: ParsedAliasChannel[] = [];
  for (const channel of channels) {
    // The channel requires this for prWatchEvents; a stale configuration that
    // violates it must contribute neither events nor actions.
    if (channel.deliverToBoundSessions !== true) continue;
    const events = parseAliasEvents(channel.prWatchEvents, channel.name, log);
    if (events.size === 0) continue;
    const templates = parseAliasTemplates(
      channel.boundSessionActions,
      channel.name,
      log,
    );
    const actionsByType = new Map<
      PrTransitionType,
      ReadonlyMap<string, string>
    >();
    if (templates !== undefined) {
      for (const type of events) {
        actionsByType.set(type, aliasActionsForType(templates, type));
      }
    }
    parsed.push({
      name: channel.name,
      host: channel.host,
      events,
      templates,
      actionsByType,
    });
  }

  const byHost = new Map<string, ParsedAliasChannel[]>();
  for (const channel of parsed) {
    const list = byHost.get(channel.host) ?? [];
    // Two workspaces may carry the same channel name; the first by name is
    // the one the conflict rule selects, so one entry per name is enough.
    if (!list.some((existing) => existing.name === channel.name)) {
      list.push(channel);
    }
    byHost.set(channel.host, list);
  }

  const eventsByHost = new Map<string, ReadonlySet<PrTransitionType>>();
  const actionsByHost = new Map<
    string,
    Map<PrTransitionType, ReadonlyMap<string, string> | undefined>
  >();
  const activeHosts: string[] = [];
  for (const [host, hostChannels] of byHost) {
    const events = new Set<PrTransitionType>();
    for (const channel of hostChannels) {
      for (const type of channel.events) events.add(type);
    }
    if (events.size === 0) continue;
    activeHosts.push(host);
    eventsByHost.set(host, events);
    const sorted = [...hostChannels].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const selections = new Map<
      PrTransitionType,
      ReadonlyMap<string, string> | undefined
    >();
    for (const type of events) {
      const candidates = sorted.filter((channel) => channel.events.has(type));
      const deliverable = candidates.filter(
        (channel) =>
          channel.templates === undefined ||
          aliasCanDeliver(channel.actionsByType.get(type)!, type),
      );
      // A role-aware channel with no key for this type is still selected when
      // no channel can deliver: it stays role-aware, and the drain drops the
      // entry because no role subscribed it. Falling back to the single
      // winner would deliver to everyone instead.
      const chosen = deliverable.length > 0 ? deliverable[0]! : candidates[0]!;
      selections.set(
        type,
        chosen.templates === undefined
          ? undefined
          : chosen.actionsByType.get(type)!,
      );
      if (deliverable.length > 1) {
        log(
          `PR watch: channels ${deliverable.map((c) => c.name).join(', ')} on ${host} all deliver ${type}; using ${chosen.name}`,
        );
      }
    }
    actionsByHost.set(host, selections);
  }

  if (activeHosts.length > 0) {
    log(
      `PR watch: reading the deprecated channel alias for ${activeHosts.join(', ')}`,
    );
  }

  return {
    eventsForHost: (host) => eventsByHost.get(host) ?? NO_EVENTS,
    actionsForEvent: (type, host) => actionsByHost.get(host)?.get(type),
    anyEvents: activeHosts.length > 0,
  };
}

/** The effective subscription: explicit setting first, deprecated alias else. */
export function resolvePrWatchSubscription(
  config: SessionPrWatchConfig,
  channels: readonly HostedGithubChannel[],
  log: (message: string) => void = () => {},
): PrWatchSubscription {
  if (config.explicit) {
    return {
      eventsForHost: () => config.events,
      actionsForEvent: () =>
        config.actions !== undefined && config.actions.size > 0
          ? config.actions
          : undefined,
      anyEvents: config.events.size > 0,
    };
  }
  return resolveAlias(channels, log);
}

/** A stable identity for the alias inputs, so an edit rebuilds the deps. */
export function prWatchChannelsSignature(
  channels: readonly HostedGithubChannel[],
): string {
  return [...channels]
    .map(
      (channel) =>
        `${channel.host}\u0000${channel.name}\u0000${JSON.stringify(channel.prWatchEvents ?? null)}\u0000${JSON.stringify(channel.boundSessionActions ?? null)}\u0000${String(channel.deliverToBoundSessions ?? null)}`,
    )
    .sort()
    .join('\u0001');
}
