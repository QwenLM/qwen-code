/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ajv, type ValidateFunction } from 'ajv';
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import autoRecallInstanceConfigSchema from '../schemas/auto-recall-instance-config.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import dialectSchema from '../schemas/dialect.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import instanceConfigSchema from '../schemas/instance-config.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import writeInstanceConfigSchema from '../schemas/write-instance-config.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import writeDialectSchema from '../schemas/write-dialect.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import deleteInstanceConfigSchema from '../schemas/delete-instance-config.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import deleteDialectSchema from '../schemas/delete-dialect.schema.json' with { type: 'json' };
import type {
  DialectV1,
  InstanceConfigV2,
  InstanceConfigV3,
  WriteInstanceConfigV4,
  WriteDialectV1,
  DeleteInstanceConfigV5,
  DeleteDialectV1,
} from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validateInstance = ajv.compile(instanceConfigSchema);
const validateAutoRecallInstance = ajv.compile(autoRecallInstanceConfigSchema);
const validateDialect = ajv.compile(dialectSchema);
const validateWriteInstance = ajv.compile(writeInstanceConfigSchema);
const validateWriteDialect = ajv.compile(writeDialectSchema);
const validateDeleteInstance = ajv.compile(deleteInstanceConfigSchema);
const validateDeleteDialect = ajv.compile(deleteDialectSchema);

export class ConfigurationError extends Error {}

export function parseInstanceConfig(value: unknown): InstanceConfigV2 {
  return parseInstance(
    validateInstance,
    value,
    'Mem0 extension instance configuration is invalid.',
  );
}

export function parseAutoRecallInstanceConfig(
  value: unknown,
): InstanceConfigV3 {
  return parseInstance(
    validateAutoRecallInstance,
    value,
    'Mem0 extension auto-recall configuration is invalid.',
  );
}

export function parseDialect(value: unknown): DialectV1 {
  requireValid(
    validateDialect,
    value,
    'Mem0 extension dialect configuration is invalid.',
  );
  return value as DialectV1;
}

export function parseWriteInstanceConfig(
  value: unknown,
): WriteInstanceConfigV4 {
  return parseInstance(
    validateWriteInstance,
    value,
    'Mem0 extension write configuration is invalid.',
  );
}

export function parseWriteDialect(value: unknown): WriteDialectV1 {
  requireValid(
    validateWriteDialect,
    value,
    'Mem0 extension write dialect is invalid.',
  );
  return value as WriteDialectV1;
}

export function parseDeleteInstanceConfig(
  value: unknown,
): DeleteInstanceConfigV5 {
  return parseInstance(
    validateDeleteInstance,
    value,
    'Mem0 extension delete configuration is invalid.',
  );
}

export function parseDeleteDialect(value: unknown): DeleteDialectV1 {
  requireValid(
    validateDeleteDialect,
    value,
    'Mem0 extension delete dialect is invalid.',
  );
  return value as DeleteDialectV1;
}

function requireValid(
  validate: ValidateFunction,
  value: unknown,
  message: string,
): asserts value is object {
  if (!validate(value)) {
    throw new ConfigurationError(message);
  }
}

function parseInstance<
  T extends
    | InstanceConfigV2
    | InstanceConfigV3
    | WriteInstanceConfigV4
    | DeleteInstanceConfigV5,
>(validate: ValidateFunction, value: unknown, message: string): T {
  requireValid(validate, value, message);
  const parsed = value as T;
  return {
    ...parsed,
    endpoint: {
      ...parsed.endpoint,
      basePath: parsed.endpoint.basePath ?? '',
      allowInsecureHttp: parsed.endpoint.allowInsecureHttp ?? false,
    },
  };
}
