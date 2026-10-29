/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
import {
  MAX_DETAIL_CHARS,
  MAX_RESULT_CHARS,
  REPORT_ID_PATTERN,
  normalizedReportSchema,
  reportItemSchema,
} from './contracts.js';
import type { querySchema } from './report-query.js';
import { viewSpecSchema, type ViewSpecV1 } from './view-spec.js';

export const APP_URI = 'ui://test-failure-explorer/v1/index.html';
const count = z.number().int().safe().nonnegative();
const previewSchema = z.object({
  text: z.string().max(320),
  truncated: z.boolean(),
});
const identity = {
  protocolVersion: z.literal(1),
  reportId: z.string().regex(REPORT_ID_PATTERN),
};
const itemHeaderSchema = reportItemSchema
  .pick({
    itemId: true,
    kind: true,
    status: true,
    duration: true,
    location: true,
  })
  .extend({
    path: previewSchema,
    title: previewSchema,
    diagnosticsAvailable: z.boolean(),
  });
const summarySchema = normalizedReportSchema
  .pick({ adapter: true, provenance: true, reported: true, computed: true })
  .extend({
    source: z.object({
      relativePath: previewSchema,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: count,
    }),
    importedAt: z.string().datetime(),
    consistencyWarnings: z.array(previewSchema).max(8),
    consistencyWarningCount: count,
    limits: z.object({
      resultChars: z.literal(MAX_RESULT_CHARS),
      pageItems: z.literal(50),
      detailChars: z.literal(MAX_DETAIL_CHARS),
    }),
  });
const listSchema = z.object({
  ...identity,
  kind: z.literal('list'),
  collection: z.enum(['failures', 'assertions', 'file-errors']),
  searchScope: z.string(),
  matchedCount: count,
  returnedCount: count.max(50),
  offset: count,
  nextOffset: count.nullable(),
  items: z.array(itemHeaderSchema).max(50),
});
const detailSchema = z.object({
  ...identity,
  kind: z.literal('detail'),
  item: itemHeaderSchema,
  field: z.enum(['path', 'title', 'diagnostics']),
  textRepresentation: z.literal('terminal-safe'),
  text: z.string().max(MAX_DETAIL_CHARS),
  offset: count,
  nextOffset: count.nullable(),
  totalLength: count,
});
const summaryDataSchema = z.object({
  ...identity,
  kind: z.literal('summary'),
  summary: summarySchema,
});
const showEnvelopeSchema = z
  .object({
    ...identity,
    kind: z.literal('show'),
    summary: summarySchema,
    firstPage: listSchema.optional(),
    initialDetail: detailSchema.optional(),
    view: z.unknown().optional(),
    viewResolution: z.object({
      mode: z.string().max(32),
      reason: z.string().max(100).optional(),
      digest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  })
  .refine(
    ({ reportId, firstPage, initialDetail }) =>
      (!firstPage ||
        (firstPage.reportId === reportId &&
          firstPage.collection === 'failures' &&
          firstPage.offset === 0)) &&
      (!initialDetail ||
        (initialDetail.reportId === reportId &&
          initialDetail.item.status === 'failed' &&
          initialDetail.field === 'diagnostics' &&
          initialDetail.offset === 0)),
  );

export type ShowData = Omit<
  z.infer<typeof showEnvelopeSchema>,
  'view' | 'viewResolution'
> & {
  view?: ViewSpecV1;
  viewResolution:
    | { mode: 'fixed'; reason?: string }
    | { mode: 'generated'; digest: string };
};

export const showSchema = showEnvelopeSchema.transform((data): ShowData => {
  const { view, viewResolution, initialDetail, ...report } = data;
  if (viewResolution.mode === 'fixed') {
    return {
      ...report,
      viewResolution: {
        mode: 'fixed',
        ...(viewResolution.reason ? { reason: viewResolution.reason } : {}),
      },
    };
  }
  const parsed = viewSpecSchema.safeParse(view);
  if (
    viewResolution.mode === 'generated' &&
    viewResolution.digest &&
    parsed.success &&
    parsed.data.reportId === report.reportId
  ) {
    const evidence = parsed.data.sections.find(
      (section) => section.kind === 'evidence',
    );
    return {
      ...report,
      view: parsed.data,
      viewResolution: { mode: 'generated', digest: viewResolution.digest },
      ...(initialDetail &&
      initialDetail.item.itemId === evidence?.initialFailureId
        ? { initialDetail }
        : {}),
    };
  }
  // A saved generated page may be filtered; its unknown layout cannot label it.
  return {
    ...report,
    firstPage: undefined,
    viewResolution: { mode: 'fixed', reason: 'unsupported-view' },
  };
});
const queryDataSchema = z.discriminatedUnion('kind', [
  listSchema,
  detailSchema,
  summaryDataSchema,
]);

export type ListData = z.infer<typeof listSchema>;
export type DetailData = z.infer<typeof detailSchema>;
export type SummaryData = z.infer<typeof summaryDataSchema>;
export type QueryData = z.infer<typeof queryDataSchema>;
export type ItemHeader = z.infer<typeof itemHeaderSchema>;
export type ReportQuery = z.input<typeof querySchema>;

export function readToolData(result: {
  isError?: boolean;
  structuredContent?: unknown;
}): unknown {
  if (result.isError) {
    const error = z
      .object({ code: z.string().max(64), message: z.string().max(512) })
      .safeParse(result.structuredContent);
    throw new Error(
      error.success
        ? `${error.data.code}: ${error.data.message}`
        : 'Report query failed. The snapshot or connection may be unavailable.',
    );
  }
  return result.structuredContent;
}

export function readQueryData(
  value: unknown,
  reportId: string,
  query: ReportQuery,
): QueryData {
  const parsed = queryDataSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Unsupported or invalid report response.');
  const data = parsed.data;
  if (
    data.reportId !== reportId ||
    data.kind !== query.kind ||
    (data.kind === 'list' &&
      query.kind === 'list' &&
      (data.collection !== query.collection ||
        data.offset !== (query.offset ?? 0))) ||
    (data.kind === 'detail' &&
      query.kind === 'detail' &&
      (data.item.itemId !== query.itemId ||
        data.field !== (query.field ?? 'diagnostics') ||
        data.offset !== (query.offset ?? 0)))
  )
    throw new Error('The response does not match this report query.');
  return data;
}
