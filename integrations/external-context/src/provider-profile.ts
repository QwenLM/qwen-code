/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  EXTERNAL_CONTEXT_NOTICE,
  MAX_EXTERNAL_CONTEXT_ITEM_CONTENT_CHARACTERS,
  MAX_EXTERNAL_CONTEXT_ITEMS,
  MAX_SEARCH_QUERY_CHARACTERS,
} from './context.js';

export const contextSearchInputSchema = z
  .object({
    query: z
      .string()
      .regex(/\S/u, 'Search query must not be empty.')
      .regex(
        unicodeBoundPattern(MAX_SEARCH_QUERY_CHARACTERS),
        `Search query must contain at most ${MAX_SEARCH_QUERY_CHARACTERS} Unicode characters.`,
      ),
  })
  .strict();

const externalContextItemSchema = z
  .object({
    id: boundedString(128),
    content: boundedString(MAX_EXTERNAL_CONTEXT_ITEM_CONTENT_CHARACTERS),
    title: boundedString(200).optional(),
    uri: boundedString(500).optional(),
    score: z.number().finite().optional(),
    updatedAt: boundedString(64).optional(),
  })
  .strict();

function boundedString(maximumCharacters: number) {
  return z
    .string()
    .regex(
      unicodeBoundPattern(maximumCharacters),
      `Value must contain at most ${maximumCharacters} Unicode characters.`,
    );
}

function unicodeBoundPattern(maximumCharacters: number): RegExp {
  return new RegExp(
    `^(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|[^\\uD800-\\uDBFF]){1,${maximumCharacters}}$`,
    'u',
  );
}

export const contextSearchOutputSchema = z
  .object({
    untrusted_external_context: z
      .object({
        notice: z.literal(EXTERNAL_CONTEXT_NOTICE),
        items: z
          .array(externalContextItemSchema)
          .max(MAX_EXTERNAL_CONTEXT_ITEMS),
      })
      .strict(),
  })
  .strict();
