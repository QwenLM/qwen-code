/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { convertSchema } from './schemaConverter.js';

describe('OpenAPI schema conversion regressions', () => {
  it.each([
    [{ const: 5 }, { enum: ['5'] }],
    [{ const: true }, { enum: ['true'] }],
    [
      { type: 'integer', const: 0 },
      { type: 'integer', enum: ['0'] },
    ],
  ])('stringifies non-string const in %j', (input, expected) => {
    expect(convertSchema(input, 'openapi_30')).toEqual(expected);
  });

  it.each(['properties', '$defs', 'definitions'])(
    'treats %s keys as names while removing schema-level metadata',
    (map) => {
      expect(
        convertSchema(
          {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $id: '#foo',
            type: 'object',
            [map]: {
              type: { type: ['string', 'null'], description: 'named type' },
              const: { type: 'string', enum: [1, 2] },
              default: { type: 'boolean' },
              enum: { type: ['integer', 'null'] },
              items: { type: 'string' },
              $schema: { type: 'string' },
              dependencies: { type: 'string' },
              patternProperties: { type: 'string' },
            },
          },
          'openapi_30',
        ),
      ).toEqual({
        type: 'object',
        [map]: {
          type: { type: 'string', nullable: true, description: 'named type' },
          const: { type: 'string', enum: ['1', '2'] },
          default: { type: 'boolean' },
          enum: { type: 'integer', nullable: true },
          items: { type: 'string' },
          $schema: { type: 'string' },
          dependencies: { type: 'string' },
          patternProperties: { type: 'string' },
        },
      });
    },
  );

  it.each([
    { bound: 'minimum', exclusive: 'exclusiveMinimum' },
    { bound: 'maximum', exclusive: 'exclusiveMaximum' },
  ])(
    'preserves Draft 4 $exclusive at the root and in properties',
    ({ bound, exclusive }) => {
      const expectedLimit = { type: 'number', [bound]: 10, [exclusive]: true };
      const expectedNested = {
        type: 'object',
        properties: { value: expectedLimit },
      };
      expect(
        convertSchema(structuredClone(expectedLimit), 'openapi_30'),
      ).toEqual(expectedLimit);
      expect(
        convertSchema(structuredClone(expectedNested), 'openapi_30'),
      ).toEqual(expectedNested);
    },
  );

  it.each([
    { bound: 'minimum', exclusive: 'exclusiveMinimum' },
    { bound: 'maximum', exclusive: 'exclusiveMaximum' },
  ])(
    'converts numeric $exclusive once and preserves the second conversion',
    ({ bound, exclusive }) => {
      const expected = { type: 'number', [bound]: 10, [exclusive]: true };
      const once = convertSchema(
        { type: 'number', [exclusive]: 10 },
        'openapi_30',
      );
      expect(once).toEqual(expected);
      expect(convertSchema(once, 'openapi_30')).toEqual(expected);
    },
  );
});
