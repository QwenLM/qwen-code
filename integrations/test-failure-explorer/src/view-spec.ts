/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import { REPORT_ID_PATTERN } from './contracts.js';

export const MAX_VIEW_CHARS = 8_000;
export const MAX_VIEW_SECTIONS = 5;
export const MAX_HYPOTHESIS_GROUPS = 8;
export const MAX_VIEW_REFERENCES = 128;
export const MAX_GROUP_LABEL_CHARS = 120;
export const MAX_HYPOTHESIS_CHARS = 400;
export const MAX_INITIAL_FILTER_CHARS = 512;
export const VIEW_FALLBACK_REASONS = [
  'unsupported-version',
  'invalid-schema',
  'invalid-reference',
  'spec-too-large',
  'result-too-large',
] as const;
export type ViewFallbackReason = (typeof VIEW_FALLBACK_REASONS)[number];

const failureIdSchema = z
  .string()
  .regex(/^f(?:0|[1-9]\d{0,3}):(?:a(?:0|[1-9]\d{0,4})|error)$/);
export const failureIdsSchema = z
  .array(failureIdSchema)
  .min(1)
  .max(MAX_VIEW_REFERENCES)
  .refine((ids) => new Set(ids).size === ids.length);
const nonemptyText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);

const viewSectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summary') }).strict(),
  z.object({ kind: z.literal('status-counts') }).strict(),
  z
    .object({
      kind: z.literal('failure-list'),
      groupBy: z.enum(['none', 'file']),
      columns: z
        .array(z.enum(['path', 'title', 'status', 'duration']))
        .min(1)
        .max(4)
        .refine((columns) => new Set(columns).size === columns.length),
      initialTextFilter: z.string().max(MAX_INITIAL_FILTER_CHARS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      initialFailureId: failureIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('hypothesis-groups'),
      groups: z
        .array(
          z
            .object({
              label: nonemptyText(MAX_GROUP_LABEL_CHARS),
              hypothesis: nonemptyText(MAX_HYPOTHESIS_CHARS),
              failureIds: failureIdsSchema,
            })
            .strict(),
        )
        .min(1)
        .max(MAX_HYPOTHESIS_GROUPS),
    })
    .strict(),
]);

export const viewSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: z.string().regex(REPORT_ID_PATTERN),
    sections: z.array(viewSectionSchema).min(1).max(MAX_VIEW_SECTIONS),
  })
  .strict()
  .refine(({ sections }) => {
    const kinds = new Set(sections.map(({ kind }) => kind));
    return (
      kinds.has('failure-list') &&
      kinds.size === sections.length &&
      sections.reduce(
        (count, section) =>
          count +
          (section.kind === 'hypothesis-groups'
            ? section.groups.reduce(
                (references, group) => references + group.failureIds.length,
                0,
              )
            : 0),
        0,
      ) <= MAX_VIEW_REFERENCES
    );
  })
  .refine((view) => JSON.stringify(view).length <= MAX_VIEW_CHARS);

export type ViewSpecV1 = z.infer<typeof viewSpecSchema>;
export type ViewSection = z.infer<typeof viewSectionSchema>;
