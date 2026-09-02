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
  | 'duplicate'
  | 'invalid'
  | 'number'
  | 'policy';

export type ChannelEditorValidationErrors = Record<
  string,
  ChannelEditorValidationCode
>;

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
  return typeof value === 'string' ? value : '';
}

export function createChannelEditorDraft(
  descriptor: DaemonChannelTypeDescriptor,
  instance?: DaemonChannelInstanceSnapshot,
): ChannelEditorDraft {
  const values: Record<string, string | boolean> = {};
  const secrets: Record<string, ChannelSecretDraft> = {};
  for (const field of descriptor.fields) {
    if (field.kind === 'secret') {
      secrets[field.key] = instance?.secrets[field.key]?.present
        ? { operation: 'preserve' }
        : { operation: 'replace', value: '' };
      continue;
    }
    values[field.key] = initialFieldValue(field, instance);
  }
  const configuredPolicy = instance?.config['senderPolicy'];
  return {
    name: instance?.name ?? '',
    values,
    secrets,
    senderPolicy:
      configuredPolicy === 'pairing' || configuredPolicy === 'open'
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
  } else if (
    name === 'all' ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    errors['name'] = 'invalid';
  } else if (existingNames.includes(name)) {
    errors['name'] = 'duplicate';
  }
  for (const field of descriptor.fields) {
    if (field.required && isMissingField(field, draft)) {
      errors[field.key] = 'required';
    } else if (
      field.kind === 'number' &&
      typeof draft.values[field.key] === 'string' &&
      draft.values[field.key] !== '' &&
      !Number.isFinite(Number(draft.values[field.key]))
    ) {
      errors[field.key] = 'number';
    }
  }
  if (!draft.senderPolicy) {
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
  config[field.key] = field.kind === 'number' ? Number(value) : value;
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
    if (field.kind === 'secret') {
      const secret = draft.secrets[field.key] ?? { operation: 'preserve' };
      secrets[field.key] =
        secret.operation === 'replace'
          ? { operation: 'replace', value: secret.value ?? '' }
          : { operation: secret.operation };
      continue;
    }
    assignField(config, field, draft.values[field.key]);
  }
  config['senderPolicy'] = draft.senderPolicy;
  return { expectedRevision, config, secrets };
}
