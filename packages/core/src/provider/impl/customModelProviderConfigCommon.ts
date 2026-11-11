/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom Provider 配置操作共用的 wire 常量、错误码、入参校验器和日志工具。
 */

import { resolveEnvVarsInObject } from '@qwen-code/resource';
import { CustomModelProviderConfigLog } from './customModelProviderConfigLog.js';

/** 对外协议字符串：SDK 已依赖这些值，只能新增不能改值。 */
export const CUSTOM_MODEL_PROVIDER_CONFIG_WIRE = {
  subtype: {
    list: 'list_byok_configs',
    create: 'create_byok_config',
    update: 'update_byok_config',
    delete: 'delete_byok_config',
    check: 'check_byok_config',
  },
  capability: {
    management: 'byok_config_management_v1',
    read: 'byok_config_read_v1',
  },
  checkError: {
    failed: 'BYOK_CHECK_FAILED',
    cancelled: 'BYOK_CHECK_CANCELLED',
  },
} as const;

export const CUSTOM_MODEL_PROVIDER_CONFIG_ERROR = {
  notFound: 'BYOK_CONFIG_NOT_FOUND',
  alreadyExists: 'BYOK_CONFIG_ALREADY_EXISTS',
  invalid: 'BYOK_CONFIG_INVALID',
  authRequired: 'BYOK_CONFIG_AUTH_REQUIRED',
  accessDenied: 'BYOK_CONFIG_ACCESS_DENIED',
  persistFailed: 'BYOK_CONFIG_PERSIST_FAILED',
} as const;

export class CustomModelProviderConfigError extends Error {
  constructor(
    readonly code: (typeof CUSTOM_MODEL_PROVIDER_CONFIG_ERROR)[keyof typeof CUSTOM_MODEL_PROVIDER_CONFIG_ERROR],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CustomModelProviderConfigError';
  }
}

export type CustomModelProviderConfigReference =
  | { key: string }
  | { providerId: string };

export function customModelProviderConfigError(
  key: keyof typeof CUSTOM_MODEL_PROVIDER_CONFIG_ERROR,
  message: string,
  cause?: unknown,
  field?: string,
): CustomModelProviderConfigError {
  return Object.assign(
    new CustomModelProviderConfigError(
      CUSTOM_MODEL_PROVIDER_CONFIG_ERROR[key],
      message,
      {
        ...(cause !== undefined ? { cause } : {}),
      },
    ),
    field ? { field } : {},
  );
}

export function rethrowConfigPersistFailure(error: unknown): never {
  if (error instanceof CustomModelProviderConfigError) throw error;
  throw customModelProviderConfigError(
    'persistFailed',
    'Failed to persist model provider configuration',
    error,
  );
}

export function addCredentialSecrets(
  log: CustomModelProviderConfigLog,
  input: unknown,
): void {
  if (!isRecord(input)) return;
  const values = [
    input['apiKey'],
    ...(isRecord(input['parameters'])
      ? Object.values(input['parameters'])
      : []),
  ];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    log.addSecrets(value, value.trim(), resolveEnvVarsInObject(value).trim());
  }
}

export function createConfigOperationLog(
  operation: string,
  input: unknown,
  requestId?: string,
): CustomModelProviderConfigLog {
  const log = new CustomModelProviderConfigLog(operation, requestId);
  if (!isRecord(input)) return log;
  addCredentialSecrets(log, input);
  const fields = {
    providerId: 'provider_id',
    key: 'config_key',
    provider: 'provider',
    model: 'model',
    protocol: 'protocol',
    baseUrl: 'base_url',
  };
  for (const [key, field] of Object.entries(fields)) {
    if (typeof input[key] === 'string') log.context({ [field]: input[key] });
  }
  if (operation === 'update') {
    const mutableFields = [
      'baseUrl',
      'apiKey',
      'parameters',
      'type',
      'protocol',
      'authType',
      'displayName',
      'model',
      'models',
      'style',
      'reasoningEffort',
      'contextWindow',
    ];
    log.context({
      changed_fields: mutableFields
        .filter((field) => input[field] !== undefined)
        .join(','),
    });
  }
  return log;
}

/** Custom Provider 入参以 providerId 判别；其余形状由宿主扩展实现处理。 */
export function isCustomProviderConfigInput(
  input: unknown,
): input is Record<string, unknown> & { providerId: string } {
  return isRecord(input) && hasStringProperty(input, 'providerId');
}

export function validateOptionalPositiveInteger(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined) requirePositiveInteger(value, field);
}

export function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value))
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be an object`,
      undefined,
      field,
    );
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be a non-empty string`,
      undefined,
      field,
    );
  }
  return value.trim();
}

export function requireStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  const record = requireRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') {
      throw customModelProviderConfigError(
        'invalid',
        `${field}.${key} must be a string`,
        undefined,
        `${field}.${key}`,
      );
    }
    result[key] = item;
  }
  return result;
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be a positive integer`,
      undefined,
      field,
    );
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be a boolean`,
      undefined,
      field,
    );
  }
  return value;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be an array`,
      undefined,
      field,
    );
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

export function requireEnumArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): Array<T[number]> {
  if (!Array.isArray(value)) {
    throw customModelProviderConfigError(
      'invalid',
      `${field} must be an array`,
      undefined,
      field,
    );
  }
  return value.map((item, index) =>
    requireEnum(item, allowed, `${field}[${index}]`),
  );
}

export function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw customModelProviderConfigError(
      'invalid',
      `${field} has an unsupported value`,
      undefined,
      field,
    );
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringProperty<Key extends string>(
  record: Record<string, unknown>,
  key: Key,
): record is Record<string, unknown> & Record<Key, string> {
  return typeof record[key] === 'string';
}
