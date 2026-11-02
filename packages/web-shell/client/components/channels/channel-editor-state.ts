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
  | 'conflictingRepoAliases'
  | 'number'
  | 'outOfRange'
  | 'policy';

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

export function toList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
    return typeof value === 'boolean' ? value : false;
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
    if (typeof value !== 'string' || !value.trim()) return true;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) return true;
      return Object.values(parsed).every(
        (v) => typeof v !== 'string' || !v.trim(),
      );
    } catch {
      return true;
    }
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
      if (!Number.isFinite(parsed)) {
        errors[field.key] = 'number';
      } else if (
        field.exclusiveMinimum !== undefined &&
        parsed <= field.exclusiveMinimum
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
  return errors;
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
  const shapes = new Map<string, Set<string>>();
  for (const [groupId, group] of Object.entries(groups)) {
    if (groupId === '*') continue;
    const key = groupId.toLowerCase();
    const shape = canonicalGroupShape(group);
    shapes.set(key, (shapes.get(key) ?? new Set<string>()).add(shape));
  }
  for (const variants of shapes.values()) {
    if (variants.size > 1) return true;
  }
  return false;
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
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) {
        delete config[field.key];
        return;
      }
      const filtered = Object.fromEntries(
        Object.entries(parsed).filter(
          ([, v]) => typeof v === 'string' && v.trim(),
        ),
      );
      if (Object.keys(filtered).length > 0) {
        config[field.key] = filtered;
      } else {
        delete config[field.key];
      }
    } catch {
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
 */
function mergeGroupOverride(
  stored: Record<string, unknown>,
  override: ChannelGroupOverrideDraft,
): Record<string, unknown> {
  const initial = readGroupOverride(stored);
  const group = { ...stored };
  if (override.requireMention !== initial.requireMention) {
    if (override.requireMention === '') delete group['requireMention'];
    else group['requireMention'] = override.requireMention === 'true';
  }
  if (override.senders !== initial.senders) {
    if (override.senders === '') delete group['senders'];
    else group['senders'] = override.senders;
  }
  if (override.allowedUsers !== initial.allowedUsers) {
    const users = splitList(override.allowedUsers);
    // An explicit allowlist owns its list: empty means nobody, not "inherit".
    if (users.length > 0 || group['senders'] === 'allowlist') {
      group['allowedUsers'] = users;
    } else {
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
    groups[key] = override ? mergeGroupOverride(stored, override) : stored;
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
  instance: DaemonChannelInstanceSnapshot,
): void {
  const previous = instance.config['groups'];
  const previousGroups = isRecord(previous) ? previous : {};
  const groups = Object.fromEntries(
    Object.entries(previousGroups).filter(
      ([groupId, groupConfig]) =>
        isRecord(groupConfig) &&
        (groupId === '*' || Object.keys(groupConfig).length > 0),
    ),
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
    } else if (instance?.config['groupPolicy'] === 'allowlist') {
      removeGroupAllowlistMembership(config, instance);
    }
    assignGroupSenders(config, draft);
  }
  return { expectedRevision, config, secrets };
}
