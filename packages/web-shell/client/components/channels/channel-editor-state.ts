/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelInstanceSnapshot,
  DaemonChannelSecretUpdate,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
} from '@qwen-code/sdk/daemon';
import { isRepositoryOnlyChannelType } from './channel-platform';

export type ChannelPrivatePolicy =
  | 'disabled'
  | 'allowlist'
  | 'pairing'
  | 'open'
  | '';
/** `groups["*"].senders`; `''` means the config leaves it unset. */
export type ChannelGroupSenders = 'open' | 'allowlist' | '';

export interface ChannelSecretDraft {
  operation: DaemonChannelSecretUpdate['operation'];
  value?: string;
}

export interface ChannelEditorDraft {
  name: string;
  values: Record<string, string | boolean>;
  secrets: Record<string, ChannelSecretDraft>;
  privatePolicy: ChannelPrivatePolicy;
  allowedGroupIds: string;
  groupSenders: ChannelGroupSenders;
  groupAllowedUsers: string;
  groupOverrides: Record<string, ChannelGroupOverrideDraft>;
}

/**
 * Per-repository settings. `''` means the key is absent, so the repository
 * inherits from `groups["*"]` and then from the built-in default.
 */
export interface ChannelGroupOverrideDraft {
  requireMention: '' | 'true' | 'false';
  senders: '' | 'open' | 'allowlist';
  allowedUsers: string;
}

export type ChannelEditorValidationCode =
  | 'required'
  | 'credential'
  | 'duplicate'
  | 'invalid'
  | 'invalidGroupId'
  | 'invalidOption'
  | 'invalidRepoId'
  | 'repoFilterRequired'
  | 'conflictingRepoAliases'
  | 'invalidGroupEntry'
  | 'number'
  | 'outOfRange'
  | 'policy'
  | 'requiresBoundDelivery';

export type ChannelEditorValidationErrors = Record<
  string,
  ChannelEditorValidationCode
>;

const UNSAFE_OBJECT_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Access fields that only gate direct messages, which repository-only channels never receive. */
export const PRIVATE_ONLY_FIELD_KEYS = new Set([
  'privatePolicy',
  'allowedUsers',
]);

const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Canonical repository IDs the allowlist currently names, in typing order.
 * Entries that are not `owner/repo` are left out: the save path rejects them,
 * and a row for a half-typed repository would only flicker.
 */
export function repositoryAllowlistIds(value: string): string[] {
  return [...new Set(toList(value.toLowerCase()))].filter((id) =>
    REPOSITORY_FULL_NAME_RE.test(id),
  );
}

/** Whether the repository event filter processes a list at all. */
export function isRepoFilterActive(mode: unknown): boolean {
  return mode === 'allowlist' || mode === 'blocklist';
}

const GITHUB_REPOSITORY_URL_RE =
  /^https?:\/\/[^/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/;

/**
 * GitHub areas whose two-segment URLs look like `owner/repo` but are not
 * repositories. Shortening one would silently filter a nonexistent
 * repository — fatal under an allowlist — so these URLs pass through
 * unchanged and validation rejects them by name instead.
 *
 * Best-effort by construction: a denylist of GitHub's top-level paths cannot
 * be complete, and a future GitHub area can reintroduce the hazard until it
 * is added here. The enumerated test over this set keeps every listed root
 * rejected; the residual risk is documented in the design doc.
 *
 * Exported so the test can enumerate every member instead of sampling a few.
 */
export const GITHUB_RESERVED_URL_PATHS = new Set([
  'about',
  'account',
  'accounts',
  'advisories',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'copilot',
  'customer-stories',
  'discussions',
  'enterprise',
  'enterprises',
  'events',
  'explore',
  'features',
  'followers',
  'following',
  'issues',
  'join',
  'login',
  'logout',
  'marketplace',
  'mobile',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'password_reset',
  'premium-support',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'sponsors',
  'stars',
  'team',
  'topics',
  'trending',
  'users',
  'watching',
]);

/**
 * The hosts whose two-segment paths may be repository URLs: github.com, plus
 * the channel's own GitHub Enterprise WEB host derived from baseUrl. Only the
 * web host qualifies: an `api.`-prefixed baseUrl host denotes the deployment's
 * API, so the stripped form is added and the raw API host is NOT (pasting a
 * REST URL like https://api.github.com/repos/octo/repo must not shorten to
 * `repos/octo`). The baseUrl's own API path prefix (e.g. /api/v3) is returned
 * alongside so REST-shaped paths on a shared web+API host are excluded too.
 * Any other host — gist.github.com, gitlab.com, an arbitrary site — passes
 * through unchanged for validation to reject.
 */
function repositoryUrlContext(baseUrl: string): {
  hosts: Set<string>;
  apiPath: string;
} {
  const hosts = new Set(['github.com', 'www.github.com']);
  let apiPath = '';
  const trimmed = baseUrl.trim();
  if (trimmed) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      hosts.add(host.startsWith('api.') ? host.slice(4) : host);
      const path = url.pathname.replace(/\/+$/, '').toLowerCase();
      if (path) apiPath = path;
    } catch {
      // A malformed baseUrl is its own field's validation error; only
      // github.com remains shortenable here.
    }
  }
  return { hosts, apiPath };
}

/**
 * Canonicalize the repository filter input: lowercase, deduplicate, strip
 * trailing sentence punctuation a paste can carry (`.`, `)`, …), and shorten
 * GitHub web URLs (repository, PR, or issue pages, with an optional `.git`,
 * trailing path, query, or fragment) to `owner/repo` — only when the URL's
 * host is the channel's own GitHub web host and its path is not the baseUrl's
 * API prefix. Entries that are not repository URLs on that host pass through
 * unchanged so validation can name them. Shared by the validator and the save
 * path so the two cannot disagree.
 */
export function normalizeRepositoryFilterInput(
  value: string,
  baseUrl = '',
): string {
  const { hosts, apiPath } = repositoryUrlContext(baseUrl);
  const entries = toList(value)
    .map((raw) => raw.replace(/[.,;:!?)\]]+$/, ''))
    .filter(Boolean)
    .map((entry) => {
      const match = GITHUB_REPOSITORY_URL_RE.exec(entry);
      let url: URL | undefined;
      if (match) {
        try {
          url = new URL(entry);
        } catch {
          url = undefined;
        }
      }
      const onApiPath =
        url !== undefined &&
        apiPath !== '' &&
        url.pathname.toLowerCase().startsWith(`${apiPath}/`);
      const shortened =
        match &&
        url !== undefined &&
        hosts.has(url.hostname.toLowerCase()) &&
        !onApiPath &&
        !GITHUB_RESERVED_URL_PATHS.has(match[1].toLowerCase())
          ? `${match[1]}/${match[2]}`
          : entry;
      return shortened.toLowerCase();
    });
  return [...new Set(entries)].join(', ');
}

export function toList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The one record rule, shared by validation, the save path, and the editor's
 * visibility/auto-open predicates: a JSON record holding at least one
 * non-empty string value. Returns the filtered record so the save path and
 * the boolean readers cannot drift apart.
 */
export function parseRouteRecord(
  value: string,
): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(
        ([, entry]) => typeof entry === 'string' && entry.trim(),
      ),
    );
    return Object.keys(filtered).length > 0
      ? (filtered as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function recordHasRoute(value: string): boolean {
  return parseRouteRecord(value) !== undefined;
}

export function hasDescriptorPrivatePolicy(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.fields.some((f) => f.key === 'privatePolicy');
}

export function hasDescriptorGroupPolicy(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.fields.some((f) => f.key === 'groupPolicy');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configuredGroupIds(instance?: DaemonChannelInstanceSnapshot): string {
  const groups = instance?.config['groups'];
  if (!isRecord(groups)) return '';
  return Object.keys(groups)
    .filter((groupId) => groupId !== '*')
    .join(', ');
}

function wildcardGroup(
  instance?: DaemonChannelInstanceSnapshot,
): Record<string, unknown> {
  const groups = instance?.config['groups'];
  return isRecord(groups) && isRecord(groups['*']) ? groups['*'] : {};
}

function configuredGroupSenders(
  instance?: DaemonChannelInstanceSnapshot,
): ChannelGroupSenders {
  const senders = wildcardGroup(instance)['senders'];
  return senders === 'open' || senders === 'allowlist' ? senders : '';
}

function configuredGroupAllowedUsers(
  instance?: DaemonChannelInstanceSnapshot,
): string {
  const users = wildcardGroup(instance)['allowedUsers'];
  return Array.isArray(users)
    ? users.filter((user) => typeof user === 'string').join(', ')
    : '';
}

export function defaultGroupSenders(): Exclude<ChannelGroupSenders, ''> {
  return 'open';
}

export function configuredPrivatePolicy(
  instance?: DaemonChannelInstanceSnapshot,
): string {
  return String(
    instance?.config['privatePolicy'] ??
      (instance?.config['dmPolicy'] === 'disabled'
        ? 'disabled'
        : (instance?.config['senderPolicy'] ?? 'allowlist')),
  );
}

function initialFieldValue(
  field: DaemonChannelConfigFieldDescriptor,
  instance?: DaemonChannelInstanceSnapshot,
): string | boolean {
  const value = instance?.config[field.key];
  if (field.kind === 'boolean') {
    // Honour the declared default when the key is absent so a default-on field
    // (prCommentWatch) is not silently saved as false by every UI edit. An
    // explicit stored boolean — including false — is preserved verbatim.
    return typeof value === 'boolean' ? value : field.default === 'true';
  }
  if (field.kind === 'number') {
    return typeof value === 'number' ? String(value) : '';
  }
  if (field.kind === 'string-list') {
    return Array.isArray(value) ? value.join(', ') : '';
  }
  if (field.kind === 'record') {
    if (isRecord(value)) {
      return JSON.stringify(value);
    }
    return '';
  }
  if (field.kind === 'enum') {
    if (typeof value === 'string' && value) return value;
    // A multiSession channel only supports scope 'user' (the store resolves it
    // the same way when the field is absent). Pre-filling the plugin's
    // non-user default here would submit that default verbatim and the store
    // would reject every save of an existing multiSession instance.
    if (
      field.key === 'sessionScope' &&
      instance?.config['multiSession'] === true
    ) {
      return 'user';
    }
    if (instance) {
      if (field.key === 'privatePolicy')
        return configuredPrivatePolicy(instance);
      if (field.key === 'groupPolicy') return 'disabled';
      if (field.key === 'repoFilterMode') return 'off';
      if (field.key === 'outputMode') return field.default ?? '';
      if (field.key === 'dmPolicy') return 'open';
      if (field.key !== 'sessionScope') return '';
    }
    if (field.key === 'sessionScope' && field.default === 'thread') {
      if (instance) return 'thread';
      return (
        field.options?.find((option) => option.value === 'chat_thread')
          ?.value ??
        field.options?.find((option) => option.value !== 'thread')?.value ??
        field.default
      );
    }
    return field.default ?? field.options?.[0]?.value ?? '';
  }
  return typeof value === 'string' ? value : '';
}

/**
 * Read one repository's overrides. Shared by the draft seed and the save path:
 * the save compares against this same reading, so a field the operator never
 * touched keeps its stored key verbatim — including shapes the form cannot
 * express, such as an empty allowlist or a list with no policy beside it.
 */
function readGroupOverride(
  group: Record<string, unknown>,
): ChannelGroupOverrideDraft {
  const requireMention = group['requireMention'];
  const senders = group['senders'];
  const users = group['allowedUsers'];
  return {
    requireMention:
      typeof requireMention === 'boolean'
        ? requireMention
          ? 'true'
          : 'false'
        : '',
    senders: senders === 'open' || senders === 'allowlist' ? senders : '',
    allowedUsers: Array.isArray(users)
      ? users
          .filter((user): user is string => typeof user === 'string')
          .join(', ')
      : '',
  };
}

function configuredGroupOverrides(
  instance?: DaemonChannelInstanceSnapshot,
): Record<string, ChannelGroupOverrideDraft> {
  const groups = instance?.config['groups'];
  if (!isRecord(groups)) return {};
  // fromEntries defines own properties, so a hand-written `__proto__` group key
  // in settings.json becomes an ordinary entry instead of reassigning the
  // prototype of the map every row is looked up in.
  return Object.fromEntries(
    Object.entries(groups)
      .filter(
        (entry): entry is [string, Record<string, unknown>] =>
          entry[0] !== '*' && isRecord(entry[1]),
      )
      .map(([groupId, group]) => [
        groupId.toLowerCase(),
        readGroupOverride(group),
      ]),
  );
}

export function createChannelEditorDraft(
  descriptor: DaemonChannelTypeDescriptor,
  instance?: DaemonChannelInstanceSnapshot,
): ChannelEditorDraft {
  const values: Record<string, string | boolean> = {};
  const secrets: Record<string, ChannelSecretDraft> = {};
  for (const field of descriptor.fields) {
    if (field.kind === 'object') continue;
    if (field.kind === 'secret') {
      secrets[field.key] = instance?.secrets[field.key]?.present
        ? { operation: 'preserve' }
        : { operation: 'replace', value: '' };
      continue;
    }
    values[field.key] = initialFieldValue(field, instance);
  }
  const hasDescriptorPolicy = hasDescriptorPrivatePolicy(descriptor);
  const configuredPolicy = instance
    ? configuredPrivatePolicy(instance)
    : 'pairing';
  const repositoryOnly = isRepositoryOnlyChannelType(descriptor.type);
  if (
    repositoryOnly &&
    values['useLocalGh'] === true &&
    instance?.secrets['token']?.present
  ) {
    // A stored token outranks local gh auth, so keeping it would silently
    // defeat the authentication method this channel has selected.
    secrets['token'] = { operation: 'clear' };
  }
  const configuredGroups = configuredGroupIds(instance);
  return {
    name: instance?.name ?? '',
    values,
    secrets,
    privatePolicy: hasDescriptorPolicy
      ? ''
      : ['disabled', 'allowlist', 'pairing', 'open'].includes(configuredPolicy)
        ? (configuredPolicy as ChannelPrivatePolicy)
        : '',
    // Show repository IDs in the canonical lower-case form the editor writes,
    // so re-saving an older mixed-case allowlist migrates it instead of
    // rewriting the same spelling back.
    allowedGroupIds: repositoryOnly
      ? [...new Set(toList(configuredGroups.toLowerCase()))].join(', ')
      : configuredGroups,
    groupSenders: configuredGroupSenders(instance),
    groupAllowedUsers: configuredGroupAllowedUsers(instance),
    groupOverrides: repositoryOnly ? configuredGroupOverrides(instance) : {},
  };
}

function isMissingField(
  field: DaemonChannelConfigFieldDescriptor,
  draft: ChannelEditorDraft,
): boolean {
  if (field.kind === 'secret') {
    const secret = draft.secrets[field.key];
    if (secret?.operation === 'preserve') return false;
    if (secret?.operation === 'clear') return true;
    return !secret?.value?.trim();
  }
  const value = draft.values[field.key];
  if (field.kind === 'record') {
    return typeof value !== 'string' || !recordHasRoute(value);
  }
  return typeof value === 'string' ? value.trim().length === 0 : false;
}

export function validateChannelEditorDraft(
  descriptor: DaemonChannelTypeDescriptor,
  draft: ChannelEditorDraft,
  existingNames: readonly string[],
  instance?: DaemonChannelInstanceSnapshot,
): ChannelEditorValidationErrors {
  const errors: ChannelEditorValidationErrors = {};
  const name = draft.name.trim();
  if (!name) {
    errors['name'] = 'required';
  } else if (name === 'all' || UNSAFE_OBJECT_KEYS.includes(name)) {
    errors['name'] = 'invalid';
  } else if (existingNames.includes(name)) {
    errors['name'] = 'duplicate';
  }
  for (const field of descriptor.fields) {
    if (field.kind === 'object') continue;
    const draftValue = draft.values[field.key];
    if (field.required && isMissingField(field, draft)) {
      errors[field.key] = 'required';
    } else if (
      field.kind === 'number' &&
      typeof draftValue === 'string' &&
      draftValue.trim() !== ''
    ) {
      const parsed = Number(draftValue);
      // A stored value the runtime already tolerates must not block an
      // unrelated edit. The editor re-sends it verbatim and the store applies
      // the same unchanged-value tolerance, so rejecting it here would strand
      // the operator on a field they never touched.
      const unchanged =
        instance !== undefined &&
        typeof instance.config[field.key] === 'number' &&
        instance.config[field.key] === parsed;
      if (!Number.isFinite(parsed)) {
        errors[field.key] = 'number';
      } else if (
        !unchanged &&
        ((field.exclusiveMinimum !== undefined &&
          parsed <= field.exclusiveMinimum) ||
          (field.minimum !== undefined && parsed < field.minimum) ||
          (field.maximum !== undefined && parsed > field.maximum))
      ) {
        errors[field.key] = 'outOfRange';
      }
    } else if (field.kind === 'string-list' && field.options) {
      if (typeof draftValue === 'string') {
        const allowed = new Set(field.options.map((option) => option.value));
        const invalid = draftValue
          .split(',')
          .map((token) => token.trim().toLowerCase())
          .filter((token) => token.length > 0)
          .some((token) => !allowed.has(token));
        if (invalid) {
          errors[field.key] = 'invalidOption';
        }
      }
    }
  }
  if (descriptor.type === 'github') {
    const tokenField = descriptor.fields.find((f) => f.key === 'token');
    const hasToken = tokenField ? !isMissingField(tokenField, draft) : false;
    if (!hasToken && draft.values['useLocalGh'] !== true) {
      errors['token'] = 'credential';
    }
    // Mirror validateBoundSessionConfig so the dependency is named at the
    // field instead of surfacing as a raw daemon rejection after submit.
    // invalidOption wins, the same order the runtime validates in.
    if (
      !errors['prWatchEvents'] &&
      toList(String(draft.values['prWatchEvents'] ?? '')).length > 0 &&
      draft.values['deliverToBoundSessions'] !== true
    ) {
      errors['prWatchEvents'] = 'requiresBoundDelivery';
    }
    // Mirror validateRepoFilterConfig: an active mode needs a non-empty list
    // of owner/repo entries. While the mode is off the list is ignored (and
    // hidden), matching the runtime's ignore-while-off rule, so a parked list
    // never strands a save on a field the operator cannot see.
    if (isRepoFilterActive(draft.values['repoFilterMode'])) {
      const normalized = normalizeRepositoryFilterInput(
        String(draft.values['repoFilter'] ?? ''),
        String(draft.values['baseUrl'] ?? ''),
      );
      if (!normalized) {
        errors['repoFilter'] = 'repoFilterRequired';
      } else if (
        toList(normalized).some((id) => !REPOSITORY_FULL_NAME_RE.test(id))
      ) {
        errors['repoFilter'] = 'invalidRepoId';
      }
    }
  }
  if (
    !isRepositoryOnlyChannelType(descriptor.type) &&
    !draft.privatePolicy &&
    !hasDescriptorPrivatePolicy(descriptor)
  ) {
    errors['privatePolicy'] = 'policy';
  }
  if (
    String(draft.values['groupPolicy'] ?? '') === 'allowlist' &&
    splitList(draft.allowedGroupIds).some((groupId) =>
      UNSAFE_OBJECT_KEYS.includes(groupId),
    )
  ) {
    errors['allowedGroupIds'] = 'invalidGroupId';
  }
  if (
    isRepositoryOnlyChannelType(descriptor.type) &&
    String(draft.values['groupPolicy'] ?? '') === 'allowlist'
  ) {
    if (
      splitList(draft.allowedGroupIds).some(
        (groupId) => !REPOSITORY_FULL_NAME_RE.test(groupId),
      )
    ) {
      errors['allowedGroupIds'] = 'invalidRepoId';
    }
    if (hasConflictingRepositoryAliases(instance)) {
      // Collapsing these keys would keep only one of two different sender
      // policies, and the runtime prefers an exact key — so a no-op save could
      // widen access. Make the operator resolve it instead of choosing for them.
      errors['allowedGroupIds'] = 'conflictingRepoAliases';
    }
  }
  if (
    isRepositoryOnlyChannelType(descriptor.type) &&
    String(draft.values['groupPolicy'] ?? '') !== 'allowlist'
  ) {
    // Away from Allowlist the rows are hidden and the save path leaves an
    // ambiguous alias exactly as stored, so an edit made before switching would
    // be discarded while the dialog reports success and closes. Refuse it on the
    // policy field, which stays visible under every policy. An untouched switch
    // still saves: preserving both spellings is what the runtime resolved before.
    const groups = instance?.config['groups'];
    if (isRecord(groups)) {
      const initial = configuredGroupOverrides(instance);
      for (const id of conflictingRepositoryAliases(groups)) {
        const before = initial[id];
        const after = draft.groupOverrides[id];
        if (!before || !after) continue;
        if (
          before.requireMention !== after.requireMention ||
          before.senders !== after.senders ||
          before.allowedUsers !== after.allowedUsers
        ) {
          errors['groupPolicy'] = 'conflictingRepoAliases';
          break;
        }
      }
    }
  }
  if (isRepositoryOnlyChannelType(descriptor.type)) {
    if (invalidRepositoryGroupEntries(instance).length > 0) {
      // The store refuses a non-record group entry on every save, unchanged or
      // not, and no row in the form can represent it. Deleting it on the way
      // past would remove the exact key the runtime matches first and hand the
      // repository to a case-insensitive fallback, so refuse here with the
      // entry named instead of letting the daemon answer with a generic error.
      errors['groupPolicy'] = 'invalidGroupEntry';
    }
  }
  return errors;
}

/**
 * Stored repository entries whose value is not an object. The form has no row
 * for them and the store rejects them on every save, so they have to be named
 * rather than silently dropped or passed through to a generic refusal.
 */
export function invalidRepositoryGroupEntries(
  instance?: DaemonChannelInstanceSnapshot,
): string[] {
  const groups = instance?.config['groups'];
  if (!isRecord(groups)) return [];
  return Object.entries(groups)
    .filter(([groupId, group]) => groupId !== '*' && !isRecord(group))
    .map(([groupId]) => groupId);
}

/**
 * Whether the stored allowlist holds two spellings of one repository that
 * carry different settings. GitHub treats them as the same repository, but
 * the runtime resolves an exact key first, so they are not interchangeable.
 */
function hasConflictingRepositoryAliases(
  instance?: DaemonChannelInstanceSnapshot,
): boolean {
  const groups = instance?.config['groups'];
  if (!isRecord(groups)) return false;
  return conflictingRepositoryAliases(groups).size > 0;
}

/**
 * The lower-cased ids whose stored spellings disagree about settings. The draft
 * holds one entry per id, so it cannot say which spelling an edit was meant
 * for. Validation and the non-Allowlist save path consult this same set: the
 * first refuses the save, the second leaves both spellings alone.
 */
function conflictingRepositoryAliases(
  groups: Record<string, unknown>,
): Set<string> {
  const shapes = new Map<string, Set<string>>();
  for (const [groupId, group] of Object.entries(groups)) {
    if (groupId === '*') continue;
    const key = groupId.toLowerCase();
    const shape = canonicalGroupShape(group);
    shapes.set(key, (shapes.get(key) ?? new Set<string>()).add(shape));
  }
  return new Set(
    [...shapes].filter(([, variants]) => variants.size > 1).map(([key]) => key),
  );
}

/**
 * Compare group settings by meaning, not by JSON text: key order carries no
 * meaning, and the only list a group holds is an allowlist, whose order does
 * not matter either. Comparing the raw text would report two identical
 * entries written in a different order as a conflict and block an unrelated
 * save.
 */
function canonicalGroupShape(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(canonicalGroupShape).sort());
  }
  if (isRecord(value)) {
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalGroupShape(value[key])]),
    );
  }
  return JSON.stringify(value ?? null);
}

function assignField(
  config: Record<string, unknown>,
  field: DaemonChannelConfigFieldDescriptor,
  rawValue: string | boolean | undefined,
): void {
  if (field.kind === 'boolean') {
    config[field.key] = rawValue === true;
    return;
  }
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    // An explicitly empty list can mean "nobody" (`operators: []`), which an
    // empty input cannot express; keep it rather than widen to "unset".
    const previous = config[field.key];
    if (
      field.kind === 'string-list' &&
      Array.isArray(previous) &&
      previous.length === 0
    ) {
      return;
    }
    delete config[field.key];
    return;
  }
  if (field.kind === 'number') {
    config[field.key] = Number(value);
  } else if (field.kind === 'string-list') {
    config[field.key] = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (field.kind === 'record') {
    const filtered = parseRouteRecord(value);
    if (filtered) {
      config[field.key] = filtered;
    } else {
      delete config[field.key];
    }
  } else {
    config[field.key] = value;
  }
}

function splitList(value: string): string[] {
  return [...new Set(toList(value))];
}

/**
 * Apply one repository's draft over its stored settings. Only a field that
 * differs from the stored reading is written, so an untouched repository keeps
 * every key it had — including ones this form does not model.
 *
 * Exported because the row's helper text must describe what this projection
 * writes, not what the draft happens to hold: deriving the copy from the draft
 * policy alone tells two deliberately-preserved stored shapes the opposite of
 * what the runtime does.
 */
export function projectRepositoryGroup(
  stored: Record<string, unknown>,
  override: ChannelGroupOverrideDraft,
): Record<string, unknown> {
  const initial = readGroupOverride(stored);
  const group = { ...stored };
  if (override.requireMention !== initial.requireMention) {
    if (override.requireMention === '') delete group['requireMention'];
    else group['requireMention'] = override.requireMention === 'true';
  }
  const policyChanged = override.senders !== initial.senders;
  if (policyChanged) {
    if (override.senders === '') delete group['senders'];
    else group['senders'] = override.senders;
  }
  const users = splitList(override.allowedUsers);
  if (override.allowedUsers !== initial.allowedUsers) {
    // An explicit allowlist owns its list: empty means nobody, not "inherit".
    if (users.length > 0 || group['senders'] === 'allowlist') {
      group['allowedUsers'] = users;
    } else {
      delete group['allowedUsers'];
    }
  } else if (policyChanged) {
    // The policy moved while the text did not — the default state both of a
    // freshly added row and of a row being returned to inheritance. Both
    // directions have to write, or the row's copy describes something the save
    // did not do. Scoped to a changed policy: a row that already stored the
    // policy keeps its members, so an untouched save stays a no-op.
    if (group['senders'] === 'allowlist') {
      // Without the key the runtime's `??` hands the channel-wide list back,
      // so "empty means nobody" would silently keep the wider audience.
      if (!Array.isArray(group['allowedUsers'])) group['allowedUsers'] = [];
    } else if (users.length === 0) {
      // `[]` is not nullish, so a list left behind keeps denying everyone
      // while the row reads "Inherit" and promises the channel-wide list.
      delete group['allowedUsers'];
    }
  }
  return group;
}

function assignGroups(
  config: Record<string, unknown>,
  allowedGroupIds: string,
  instance?: DaemonChannelInstanceSnapshot,
  normalizeKeys = false,
  overrides?: Record<string, ChannelGroupOverrideDraft>,
): void {
  const previous = instance?.config['groups'];
  const storedGroups = isRecord(previous) ? previous : {};
  // Repository IDs are case-insensitive. Store the canonical lower-case key
  // and look the previous per-repository settings up under it, so retyping the
  // case does not silently drop that repository's sender policy.
  const previousGroups = normalizeKeys
    ? Object.fromEntries(
        Object.entries(storedGroups).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      )
    : storedGroups;
  const groups: Record<string, unknown> = {};
  if (isRecord(previousGroups['*'])) {
    groups['*'] = previousGroups['*'];
  }
  for (const groupId of splitList(allowedGroupIds)) {
    const key = normalizeKeys ? groupId.toLowerCase() : groupId;
    if (key === '*') continue;
    const stored = isRecord(previousGroups[key]) ? previousGroups[key] : {};
    const override = overrides?.[key];
    groups[key] = override ? projectRepositoryGroup(stored, override) : stored;
  }
  if (Object.keys(groups).length > 0) {
    config['groups'] = groups;
  } else {
    delete config['groups'];
  }
}

/** Write the group speaker default once the editor has chosen one. */
function assignGroupSenders(
  config: Record<string, unknown>,
  draft: ChannelEditorDraft,
): void {
  if (!draft.groupSenders) return;
  const groups = isRecord(config['groups']) ? { ...config['groups'] } : {};
  const wildcard = isRecord(groups['*']) ? { ...groups['*'] } : {};
  wildcard['senders'] = draft.groupSenders;
  if (draft.groupSenders === 'allowlist') {
    wildcard['allowedUsers'] = splitList(draft.groupAllowedUsers);
  }
  groups['*'] = wildcard;
  config['groups'] = groups;
}

function removeGroupAllowlistMembership(
  config: Record<string, unknown>,
  instance: DaemonChannelInstanceSnapshot | undefined,
  overrides?: Record<string, ChannelGroupOverrideDraft>,
  allowedGroupIds = '',
): void {
  const previous = instance?.config['groups'];
  const previousGroups = isRecord(previous) ? previous : {};
  // The rows are hidden once the policy leaves Allowlist, but the draft still
  // holds whatever the operator edited before switching, and the runtime keeps
  // resolving these entries under open/pairing. Project the edits here too, or
  // the save reports success while silently restoring the stored value.
  const entries = new Map<string, unknown>(Object.entries(previousGroups));
  if (overrides) {
    // A repository typed while the policy was Allowlist has a draft but no
    // stored entry. Iterating storage alone drops it, and the repository falls
    // back to the channel-wide policy it was just narrowed against. Match on
    // the canonical id so a mixed-case stored spelling is not duplicated.
    const storedIds = new Set(
      [...entries.keys()].map((id) => id.toLowerCase()),
    );
    for (const groupId of repositoryAllowlistIds(allowedGroupIds)) {
      if (!storedIds.has(groupId)) entries.set(groupId, {});
    }
  }
  // One lower-cased draft cannot speak for two spellings that disagree:
  // projecting it onto both hands the last alias's settings to the first and
  // widens a repository nobody edited. Leave those entries as stored — the
  // Allowlist path already refuses the save until the operator resolves them.
  const ambiguous = conflictingRepositoryAliases(previousGroups);
  // A channel that never had an allowlist is not leaving one, so its stored
  // entries are not membership markers this save is entitled to clean up.
  const leavingAllowlist = instance?.config['groupPolicy'] === 'allowlist';
  const groups = Object.fromEntries(
    [...entries]
      .map(([groupId, stored]) => {
        const ambiguousAlias =
          groupId !== '*' && ambiguous.has(groupId.toLowerCase());
        const override =
          groupId === '*' || ambiguousAlias
            ? undefined
            : overrides?.[groupId.toLowerCase()];
        const projected =
          override && isRecord(stored)
            ? projectRepositoryGroup(stored, override)
            : stored;
        return { groupId, projected, ambiguousAlias };
      })
      .filter(({ groupId, projected, ambiguousAlias }) => {
        // An ambiguous alias is kept verbatim: one lower-cased draft cannot say
        // which spelling an edit was meant for, and an empty entry is what makes
        // the runtime's exact match inherit "*" instead of falling through to a
        // wider alias.
        if (ambiguousAlias) return true;
        // "Stored" has to mean present in the file, not present in the merged
        // map: a repository typed during this visit is seeded with a `{}`
        // placeholder that must not be mistaken for a stored empty entry.
        const wasStored = Object.hasOwn(previousGroups, groupId);
        const stored = wasStored ? previousGroups[groupId] : undefined;
        // An entry the form cannot represent is never deleted here. A non-record
        // value is refused by validation with a message that names it, because
        // the store rejects it on every save; deleting it would remove the exact
        // key the runtime matches first, a rewrite nobody asked for whether or
        // not another spelling exists to fall through to.
        if (groupId !== '*' && wasStored && !isRecord(stored)) return true;
        if (!isRecord(projected)) return false;
        if (groupId === '*' || Object.keys(projected).length > 0) return true;
        // Drop an empty entry when it is the stub a row leaves behind on being
        // returned to inherit, or when the channel is leaving the allowlist
        // whose membership the entry expressed. Keep one that was already
        // empty in a channel that never had an allowlist: an unrelated edit
        // must not silently rewrite the stored file.
        const wasStoredEmpty =
          isRecord(stored) && Object.keys(stored).length === 0;
        return wasStoredEmpty && !leavingAllowlist;
      })
      .map(({ groupId, projected }) => [groupId, projected]),
  );
  if (Object.keys(groups).length > 0) {
    config['groups'] = groups;
  } else {
    delete config['groups'];
  }
}

export function buildChannelUpsertRequest(
  descriptor: DaemonChannelTypeDescriptor,
  draft: ChannelEditorDraft,
  expectedRevision: string,
  instance?: DaemonChannelInstanceSnapshot,
): DaemonChannelUpsertRequest {
  const config: Record<string, unknown> & { type: string } = {
    ...(instance?.config ?? {}),
    type: descriptor.type,
  };
  const repositoryOnly = isRepositoryOnlyChannelType(descriptor.type);
  const secrets: Record<string, DaemonChannelSecretUpdate> = {};
  for (const field of descriptor.fields) {
    if (field.kind === 'object') continue;
    if (repositoryOnly && PRIVATE_ONLY_FIELD_KEYS.has(field.key)) continue;
    if (field.kind === 'secret') {
      const secret = draft.secrets[field.key] ?? { operation: 'preserve' };
      secrets[field.key] =
        secret.operation === 'replace'
          ? !field.required && !secret.value?.trim()
            ? { operation: 'clear' }
            : { operation: 'replace', value: secret.value ?? '' }
          : { operation: secret.operation };
      continue;
    }
    assignField(config, field, draft.values[field.key]);
  }
  if (
    repositoryOnly &&
    isRepoFilterActive(config['repoFilterMode']) &&
    Array.isArray(config['repoFilter'])
  ) {
    // Same canonicalization the validator applied, so pasted URLs reach the
    // daemon as owner/repo. Gated on the active mode: a parked list stays
    // exactly as stored on an unrelated save.
    const normalized = normalizeRepositoryFilterInput(
      config['repoFilter']
        .filter((entry): entry is string => typeof entry === 'string')
        .join(', '),
      typeof config['baseUrl'] === 'string' ? config['baseUrl'] : '',
    );
    config['repoFilter'] = normalized ? normalized.split(', ') : [];
  }
  if (repositoryOnly) {
    // The editor used to persist the injected private-access defaults here
    // even though these channels never read them, and the pairing panel would
    // then present the stale user list as an authoritative allowlist. Drop the
    // whole set on the next save; the effective list lives under `groups`.
    for (const key of PRIVATE_ONLY_FIELD_KEYS) delete config[key];
  } else if (!hasDescriptorPrivatePolicy(descriptor)) {
    config['privatePolicy'] = draft.privatePolicy;
  }
  if (hasDescriptorGroupPolicy(descriptor)) {
    if (config['groupPolicy'] === 'allowlist') {
      assignGroups(
        config,
        draft.allowedGroupIds,
        instance,
        repositoryOnly,
        repositoryOnly ? draft.groupOverrides : undefined,
      );
    } else if (
      repositoryOnly ||
      instance?.config['groupPolicy'] === 'allowlist'
    ) {
      // Repository rows are reachable from any policy: the operator can switch
      // to Allowlist, narrow a repository, and switch back before saving. Gating
      // this on the STORED policy would drop those edits on a channel that was
      // already Open, while the alert promises they are kept.
      removeGroupAllowlistMembership(
        config,
        instance,
        repositoryOnly ? draft.groupOverrides : undefined,
        draft.allowedGroupIds,
      );
    }
    assignGroupSenders(config, draft);
  }
  return { expectedRevision, config, secrets };
}

export interface RetainedRepositorySetting {
  repositoryId: string;
  /** Whether the entry can still change who is admitted or what is processed. */
  applies: boolean;
}

/**
 * The repositories whose settings this save keeps, read back from the request
 * the save actually builds rather than from storage: a repository the operator
 * typed during this visit exists only in the draft, and enumerating stored
 * groups would let the dialog report success without naming it.
 *
 * `applies` follows the runtime, not the shape of the entry. `senderGateFor`
 * builds an allowlist only when the resolved senders policy is `allowlist`, so
 * an `allowedUsers` array beside an inherited `open` policy restricts nobody;
 * and a `requireMention` equal to the inherited value changes nothing either.
 */
export function retainedRepositorySettings(
  descriptor: DaemonChannelTypeDescriptor,
  draft: ChannelEditorDraft,
  instance?: DaemonChannelInstanceSnapshot,
): RetainedRepositorySetting[] {
  const { config } = buildChannelUpsertRequest(descriptor, draft, '', instance);
  const groups = isRecord(config['groups']) ? config['groups'] : {};
  const wildcard = isRecord(groups['*']) ? groups['*'] : {};
  const inheritedSenders =
    wildcard['senders'] === 'allowlist' ? 'allowlist' : 'open';
  const inheritedMention =
    typeof wildcard['requireMention'] === 'boolean'
      ? wildcard['requireMention']
      : true;
  return Object.entries(groups)
    .filter(
      ([groupId, group]) =>
        groupId !== '*' && isRecord(group) && Object.keys(group).length > 0,
    )
    .map(([groupId, group]) => {
      const entry = group as Record<string, unknown>;
      const senders = entry['senders'] ?? inheritedSenders;
      const mention = entry['requireMention'];
      return {
        repositoryId: groupId,
        applies:
          senders === 'allowlist' ||
          (typeof mention === 'boolean' && mention !== inheritedMention),
      };
    });
}
