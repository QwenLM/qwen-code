/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ajv, type ValidateFunction } from 'ajv';
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import dialectSchema from '../schemas/dialect.schema.json' with { type: 'json' };
// eslint-disable-next-line import/no-internal-modules -- bundle the canonical package schema
import instanceConfigSchema from '../schemas/instance-config.schema.json' with { type: 'json' };
import type { DialectV1, InstanceConfigV1 } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validateInstance = ajv.compile(instanceConfigSchema);
const validateDialect = ajv.compile(dialectSchema);

export class ConfigurationError extends Error {}

export function parseInstanceConfig(value: unknown): InstanceConfigV1 {
  requireValid(validateInstance, value);
  const parsed = value as Omit<InstanceConfigV1, 'endpoint'> & {
    endpoint: Omit<
      InstanceConfigV1['endpoint'],
      'basePath' | 'allowInsecureHttp'
    > &
      Partial<
        Pick<InstanceConfigV1['endpoint'], 'basePath' | 'allowInsecureHttp'>
      >;
  };
  return {
    ...parsed,
    endpoint: {
      ...parsed.endpoint,
      basePath: parsed.endpoint.basePath ?? '',
      allowInsecureHttp: parsed.endpoint.allowInsecureHttp ?? false,
    },
  };
}

export function parseDialect(value: unknown): DialectV1 {
  requireValid(validateDialect, value);
  return value as DialectV1;
}

function requireValid(
  validate: ValidateFunction,
  value: unknown,
): asserts value is object {
  if (!validate(value)) {
    throw new ConfigurationError('Mem0 extension configuration is invalid.');
  }
}
