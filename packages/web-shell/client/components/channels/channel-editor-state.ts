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

export type ChannelEditorMode = 'create' | 'edit';
export type ChannelEditorAuthMethod = 'credentials' | 'qr';

export interface SecretEditorState {
  operation: 'preserve' | 'replace' | 'clear';
  value: string;
  present: boolean;
  source?: 'literal' | 'environment';
  clearConfirmed?: boolean;
}

export interface ChannelEditorState {
  mode: ChannelEditorMode;
  name: string;
  type: string;
  expectedRevision: string;
  catalog: readonly DaemonChannelTypeDescriptor[];
  values: Record<string, unknown>;
  secrets: Record<string, SecretEditorState>;
  preservedConfig: Record<string, unknown>;
  authMethod: ChannelEditorAuthMethod;
  dirtyFields: readonly string[];
}

export interface ChannelEditorValidationError {
  field: string;
  message: string;
}

export interface CreateChannelEditorStateOptions {
  catalog: readonly DaemonChannelTypeDescriptor[];
  expectedRevision?: string;
  instance?: DaemonChannelInstanceSnapshot;
  name?: string;
}

export const SHARED_CHANNEL_FIELDS: readonly DaemonChannelConfigFieldDescriptor[] =
  [
    { key: 'identity.id', label: 'Identity ID', kind: 'string' },
    { key: 'identity.displayName', label: 'Display name', kind: 'string' },
    { key: 'identity.description', label: 'Description', kind: 'string' },
    { key: 'model', label: 'Model', kind: 'string' },
    { key: 'cwd', label: 'Workspace', kind: 'string' },
    {
      key: 'senderPolicy',
      label: 'Sender policy',
      kind: 'enum',
      options: [
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'open', label: 'Open' },
      ],
    },
    { key: 'allowedUsers', label: 'Allowed users', kind: 'string' },
    {
      key: 'dmPolicy',
      label: 'Direct messages',
      kind: 'enum',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
    {
      key: 'groupPolicy',
      label: 'Groups',
      kind: 'enum',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
    },
    {
      key: 'sessionScope',
      label: 'Session scope',
      kind: 'enum',
      options: [
        { value: 'user', label: 'Per user' },
        { value: 'thread', label: 'Per thread' },
        { value: 'single', label: 'Single session' },
      ],
    },
    {
      key: 'dispatchMode',
      label: 'Concurrent messages',
      kind: 'enum',
      options: [
        { value: 'steer', label: 'Steer current turn' },
        { value: 'followup', label: 'Queue follow-up' },
        { value: 'collect', label: 'Collect messages' },
      ],
    },
    { key: 'groupHistoryLimit', label: 'Group history limit', kind: 'number' },
    { key: 'blockStreaming', label: 'Block streaming', kind: 'boolean' },
    {
      key: 'blockStreamingChunk.minChars',
      label: 'Minimum block characters',
      kind: 'number',
    },
    {
      key: 'blockStreamingChunk.maxChars',
      label: 'Maximum block characters',
      kind: 'number',
    },
    {
      key: 'blockStreamingCoalesce.idleMs',
      label: 'Streaming idle delay (ms)',
      kind: 'number',
    },
    {
      key: 'memoryScope.namespace',
      label: 'Memory namespace',
      kind: 'string',
    },
    { key: 'webhooks', label: 'Webhooks', kind: 'string' },
    { key: 'approvalMode', label: 'Approval mode', kind: 'string' },
    { key: 'instructions', label: 'Instructions', kind: 'string' },
  ];

function selectedDescriptor(
  state: Pick<ChannelEditorState, 'catalog' | 'type'>,
): DaemonChannelTypeDescriptor | undefined {
  return state.catalog.find(
    (descriptor) => descriptor.type === state.type && descriptor.manageable,
  );
}

function valueAt(config: Record<string, unknown>, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function setValueAt(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = key.split('.');
  const unset = value === undefined || value === '';
  if (unset && valueAt(target, key) === undefined) return;
  let current = target;
  const parents: Array<{ record: Record<string, unknown>; key: string }> = [];
  for (const part of parts.slice(0, -1)) {
    const nested = current[part];
    if (
      nested === null ||
      typeof nested !== 'object' ||
      Array.isArray(nested)
    ) {
      current[part] = {};
    } else {
      current[part] = { ...(nested as Record<string, unknown>) };
    }
    parents.push({ record: current, key: part });
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts.at(-1)!;
  if (unset) {
    delete current[leaf];
    for (const parent of parents.reverse()) {
      const child = parent.record[parent.key];
      if (
        child !== null &&
        typeof child === 'object' &&
        !Array.isArray(child) &&
        Object.keys(child).length === 0
      ) {
        delete parent.record[parent.key];
      }
    }
  } else current[leaf] = value;
}

function editorValue(
  field: DaemonChannelConfigFieldDescriptor,
  raw: unknown,
): unknown {
  if (field.key === 'allowedUsers') {
    return Array.isArray(raw) ? raw.join('\n') : '';
  }
  if (field.key === 'webhooks') {
    return raw === undefined ? '' : JSON.stringify(raw, null, 2);
  }
  if (field.key === 'blockStreaming') return raw === 'on';
  if (field.kind === 'number') return raw === undefined ? '' : String(raw);
  if (field.kind === 'boolean') return raw === true;
  return typeof raw === 'string' ? raw : '';
}

function requestValue(
  field: DaemonChannelConfigFieldDescriptor,
  raw: unknown,
): unknown {
  if (field.key === 'allowedUsers') {
    return String(raw ?? '')
      .split(/[\n,]/u)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (field.key === 'webhooks') {
    const value = String(raw ?? '').trim();
    return value ? (JSON.parse(value) as unknown) : undefined;
  }
  if (field.key === 'blockStreaming') return raw === true ? 'on' : 'off';
  if (field.kind === 'number') {
    return raw === '' || raw === undefined ? undefined : Number(raw);
  }
  return raw === '' ? undefined : raw;
}

function validPortableName(name: string): boolean {
  const trimmed = name.trim();
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  let wellFormed = true;
  for (let index = 0; index < name.length; index++) {
    const codeUnit = name.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = name.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        wellFormed = false;
        break;
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed = false;
      break;
    }
  }
  if (
    !wellFormed ||
    trimmed.length === 0 ||
    trimmed.toLowerCase() === 'all' ||
    name === '.' ||
    name === '..' ||
    /[\\/:*?"<>|]/u.test(name) ||
    hasControlCharacter ||
    name.endsWith('.') ||
    name.endsWith(' ')
  ) {
    return false;
  }
  const base = name.split('.', 1)[0]!.trimEnd();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base)) return false;
  try {
    return new TextEncoder().encode(name).byteLength <= 255;
  } catch {
    return false;
  }
}

export function createChannelEditorState({
  catalog,
  expectedRevision = '',
  instance,
  name = '',
}: CreateChannelEditorStateOptions): ChannelEditorState {
  const manageable = catalog.filter((descriptor) => descriptor.manageable);
  const configuredType =
    typeof instance?.config.type === 'string' ? instance.config.type : '';
  const descriptor =
    manageable.find((item) => item.type === configuredType) ?? manageable[0];
  const type = descriptor?.type ?? manageable[0]?.type ?? '';
  const secretKeys = new Set(
    descriptor?.fields
      .filter((field) => field.kind === 'secret')
      .map((field) => field.key) ?? [],
  );
  const preservedConfig = { ...(instance?.config ?? {}) };
  for (const key of secretKeys) delete preservedConfig[key];
  const values: Record<string, unknown> = {};
  for (const field of [
    ...SHARED_CHANNEL_FIELDS,
    ...(descriptor?.fields ?? []),
  ]) {
    if (field.kind === 'secret') continue;
    values[field.key] = editorValue(field, valueAt(preservedConfig, field.key));
  }
  if (!instance) {
    values.senderPolicy = 'allowlist';
    values.sessionScope = 'user';
    values.groupPolicy = 'disabled';
    values.dmPolicy = 'open';
    values.dispatchMode = 'steer';
  }
  const secrets: Record<string, SecretEditorState> = {};
  for (const field of descriptor?.fields ?? []) {
    if (field.kind !== 'secret') continue;
    const secret = instance?.secrets[field.key];
    secrets[field.key] = {
      operation: 'preserve',
      value: '',
      present: secret?.present === true,
      source: secret?.source,
    };
  }
  const authMethod: ChannelEditorAuthMethod =
    descriptor?.auth.includes('credentials') === false &&
    descriptor.auth.includes('qr')
      ? 'qr'
      : 'credentials';
  return {
    mode: instance ? 'edit' : 'create',
    name: instance?.name ?? name,
    type,
    expectedRevision,
    catalog,
    values,
    secrets,
    preservedConfig,
    authMethod,
    dirtyFields: [],
  };
}

export function updateChannelEditorField(
  state: ChannelEditorState,
  key: string,
  value: unknown,
): ChannelEditorState {
  return {
    ...state,
    values: { ...state.values, [key]: value },
    dirtyFields: state.dirtyFields.includes(key)
      ? state.dirtyFields
      : [...state.dirtyFields, key],
  };
}

export function selectChannelEditorType(
  state: ChannelEditorState,
  type: string,
): ChannelEditorState {
  if (state.mode === 'edit' || type === state.type) return state;
  const next = createChannelEditorState({
    catalog: state.catalog,
    expectedRevision: state.expectedRevision,
    name: state.name,
  });
  const descriptor = state.catalog.find(
    (item) => item.type === type && item.manageable,
  );
  if (!descriptor) return { ...next, type: '' };
  const values = { ...next.values };
  for (const field of SHARED_CHANNEL_FIELDS) {
    values[field.key] = state.values[field.key];
  }
  const secrets: Record<string, SecretEditorState> = {};
  for (const field of descriptor.fields) {
    if (field.kind === 'secret') {
      secrets[field.key] = {
        operation: 'preserve',
        value: '',
        present: false,
      };
    } else {
      values[field.key] = editorValue(field, undefined);
    }
  }
  return {
    ...next,
    type,
    values,
    secrets,
    authMethod:
      descriptor.auth.includes('credentials') || !descriptor.auth.includes('qr')
        ? 'credentials'
        : 'qr',
    dirtyFields: state.dirtyFields.filter((key) =>
      SHARED_CHANNEL_FIELDS.some((field) => field.key === key),
    ),
  };
}

export function updateSecretEditor(
  state: ChannelEditorState,
  key: string,
  update: Pick<SecretEditorState, 'operation' | 'value'> &
    Partial<Pick<SecretEditorState, 'clearConfirmed'>>,
): ChannelEditorState {
  const current = state.secrets[key];
  if (!current) return state;
  return {
    ...state,
    secrets: { ...state.secrets, [key]: { ...current, ...update } },
  };
}

export function toSecretUpdate(
  state: SecretEditorState,
): DaemonChannelSecretUpdate {
  if (state.operation === 'replace') {
    if (!state.value) throw new Error('Replacement secret is required');
    return { operation: 'replace', value: state.value };
  }
  if (state.operation === 'clear' && state.clearConfirmed !== true) {
    throw new Error('Clearing the stored secret must be confirmed');
  }
  return { operation: state.operation };
}

export function validateChannelEditor(
  state: ChannelEditorState,
): ChannelEditorValidationError[] {
  const errors: ChannelEditorValidationError[] = [];
  if (state.mode === 'create' && !validPortableName(state.name)) {
    errors.push({
      field: 'name',
      message: 'Use a portable name other than “all” (up to 255 bytes).',
    });
  }
  const descriptor = selectedDescriptor(state);
  if (!descriptor) {
    errors.push({
      field: 'type',
      message: 'Select a manageable channel type.',
    });
    return errors;
  }
  for (const field of descriptor.fields) {
    if (field.kind === 'secret') {
      const secret = state.secrets[field.key];
      const qrSatisfies =
        state.authMethod === 'qr' && descriptor.auth.includes('qr');
      if (
        field.required &&
        !qrSatisfies &&
        (!secret ||
          (secret.operation === 'preserve' && !secret.present) ||
          (secret.operation === 'replace' && !secret.value) ||
          secret.operation === 'clear')
      ) {
        errors.push({
          field: field.key,
          message: `${field.label} is required. Enter a replacement credential.`,
        });
      } else if (secret?.operation === 'replace' && !secret.value) {
        errors.push({
          field: field.key,
          message: 'Replacement credentials cannot be empty.',
        });
      } else if (
        secret?.operation === 'clear' &&
        secret.clearConfirmed !== true
      ) {
        errors.push({
          field: field.key,
          message: 'Confirm that the stored credential should be cleared.',
        });
      }
      continue;
    }
    const value = state.values[field.key];
    if (
      field.required &&
      (value === '' || value === undefined || value === null)
    ) {
      errors.push({ field: field.key, message: `${field.label} is required.` });
      continue;
    }
    if (
      field.kind === 'number' &&
      value !== '' &&
      value !== undefined &&
      !Number.isFinite(Number(value))
    ) {
      errors.push({
        field: field.key,
        message: `${field.label} must be a number.`,
      });
    }
    if (
      field.kind === 'enum' &&
      value !== '' &&
      !field.options?.some((option) => option.value === value)
    ) {
      errors.push({
        field: field.key,
        message: `Select a valid ${field.label}.`,
      });
    }
  }
  const webhooks = state.values.webhooks;
  if (typeof webhooks === 'string' && webhooks.trim()) {
    try {
      const parsed = JSON.parse(webhooks) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new Error('not an object');
      }
    } catch {
      errors.push({
        field: 'webhooks',
        message: 'Webhooks must be a JSON object.',
      });
    }
  }
  return errors;
}

export function buildChannelUpsertRequest(
  state: ChannelEditorState,
): DaemonChannelUpsertRequest {
  const errors = validateChannelEditor(state);
  if (errors.length > 0) {
    const secretError = errors.find(
      (error) => state.secrets[error.field]?.operation === 'replace',
    );
    if (secretError) throw new Error('Replacement secret is required');
    throw new Error(errors[0]!.message);
  }
  const descriptor = selectedDescriptor(state)!;
  const config: Record<string, unknown> & { type: string } = {
    ...state.preservedConfig,
    type: descriptor.type,
  };
  const editableFields = [
    ...SHARED_CHANNEL_FIELDS,
    ...descriptor.fields.filter((field) => field.kind !== 'secret'),
  ];
  const sharedKeys = new Set(SHARED_CHANNEL_FIELDS.map((field) => field.key));
  for (const field of editableFields) {
    if (
      state.mode === 'create' &&
      sharedKeys.has(field.key) &&
      !state.dirtyFields.includes(field.key)
    ) {
      continue;
    }
    if (
      state.mode === 'edit' &&
      !state.dirtyFields.includes(field.key) &&
      valueAt(state.preservedConfig, field.key) === undefined
    ) {
      continue;
    }
    setValueAt(config, field.key, requestValue(field, state.values[field.key]));
  }
  const secrets: Record<string, DaemonChannelSecretUpdate> = {};
  for (const field of descriptor.fields) {
    if (field.kind !== 'secret') continue;
    secrets[field.key] = toSecretUpdate(state.secrets[field.key]!);
  }
  return {
    expectedRevision: state.expectedRevision,
    config,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
}

export function channelEditorNeedsQrHandoff(
  state: ChannelEditorState,
): boolean {
  return (
    state.authMethod === 'qr' &&
    selectedDescriptor(state)?.auth.includes('qr') === true
  );
}
