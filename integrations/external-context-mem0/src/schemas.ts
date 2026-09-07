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
import type { DialectV1, InstanceConfigV2 } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validateInstance = ajv.compile(instanceConfigSchema);
const validateDialect = ajv.compile(dialectSchema);

export class ConfigurationError extends Error {}

export function parseInstanceConfig(value: unknown): InstanceConfigV2 {
  requireValid(
    validateInstance,
    value,
    'Mem0 extension instance configuration is invalid.',
  );
  const parsed = value as Omit<InstanceConfigV2, 'endpoint'> & {
    endpoint: Omit<
      InstanceConfigV2['endpoint'],
      'basePath' | 'allowInsecureHttp'
    > &
      Partial<
        Pick<InstanceConfigV2['endpoint'], 'basePath' | 'allowInsecureHttp'>
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
  requireValid(
    validateDialect,
    value,
    'Mem0 extension dialect configuration is invalid.',
  );
  return value as DialectV1;
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
