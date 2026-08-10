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

export type ChannelSenderPolicy = 'pairing' | 'open' | '';

export interface ChannelSecretDraft {
  operation: DaemonChannelSecretUpdate['operation'];
  value?: string;
}

export interface ChannelEditorDraft {
  name: string;
  values: Record<string, string | boolean>;
  secrets: Record<string, ChannelSecretDraft>;
  senderPolicy: ChannelSenderPolicy;
}

export type ChannelEditorValidationCode =
  | 'required'
  | 'credential'
  | 'duplicate'
  | 'invalid'
  | 'invalidOption'
  | 'number'
  | 'outOfRange'
  | 'policy';

export type ChannelEditorValidationErrors = Record<
  string,
  ChannelEditorValidationCode
>;

const UNSAFE_OBJECT_KEYS = ['__proto__', 'constructor', 'prototype'];

export function hasDescriptorSenderPolicy(
  descriptor: DaemonChannelTypeDescriptor,
): boolean {
  return descriptor.fields.some((f) => f.key === 'senderPolicy');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    return instance ? '' : (field.default ?? field.options?.[0]?.value ?? '');
  }
  return typeof value === 'string' ? value : '';
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
  const hasDescriptorPolicy = hasDescriptorSenderPolicy(descriptor);
  const configuredPolicy = instance?.config['senderPolicy'];
  return {
    name: instance?.name ?? '',
    values,
    secrets,
    senderPolicy: hasDescriptorPolicy
      ? ''
      : configuredPolicy === 'pairing' || configuredPolicy === 'open'
        ? configuredPolicy
        : instance
          ? ''
          : 'pairing',
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
  if (!draft.senderPolicy && !hasDescriptorSenderPolicy(descriptor)) {
    errors['senderPolicy'] = 'policy';
  }
  return errors;
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
  const secrets: Record<string, DaemonChannelSecretUpdate> = {};
  for (const field of descriptor.fields) {
    if (field.kind === 'object') continue;
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
  if (!hasDescriptorSenderPolicy(descriptor)) {
    config['senderPolicy'] = draft.senderPolicy;
  }
  return { expectedRevision, config, secrets };
}
