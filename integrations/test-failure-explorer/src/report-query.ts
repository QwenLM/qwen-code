/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ExplorerError,
  MAX_DETAIL_CHARS,
  MAX_RESULT_CHARS,
  testStatusSchema,
  type ReportItem,
  type ReportSnapshot,
} from './contracts.js';
import {
  failureIdsSchema,
  MAX_VIEW_CHARS,
  viewSpecSchema,
  type ViewFallbackReason,
  type ViewSpecV1,
} from './view-spec.js';

const offsetSchema = z.number().int().safe().nonnegative();
export const querySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summary') }).strict(),
  z
    .object({
      kind: z.literal('list'),
      collection: z.enum(['failures', 'assertions', 'file-errors']),
      text: z.string().max(512).optional(),
      status: testStatusSchema.optional(),
      failureIds: failureIdsSchema.optional(),
      offset: offsetSchema.default(0),
      limit: z.number().int().min(1).max(50).default(25),
    })
    .strict(),
  z
    .object({
      kind: z.literal('detail'),
      itemId: z.string().regex(/^f\d+:(?:a\d+|error)$/),
      field: z.enum(['path', 'title', 'diagnostics']).default('diagnostics'),
      offset: offsetSchema.default(0),
    })
    .strict(),
]);

// eslint-disable-next-line no-control-regex -- Report text must not control the terminal.
const controls = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]', 'g');
function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(controls, '');
}

function safeEnd(value: string, end: number): number {
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    return end - 1;
  }
  return end;
}

function preview(value: string, maximum = 320) {
  const clean = terminalText(value);
  const end = safeEnd(clean, Math.min(clean.length, maximum));
  return { text: clean.slice(0, end), truncated: end < clean.length };
}

function result(
  snapshot: ReportSnapshot,
  payload: Record<string, unknown>,
  text: string,
): CallToolResult {
  const structuredContent = {
    protocolVersion: 1,
    reportId: snapshot.reportId,
    ...payload,
  };
  return {
    content: [
      {
        type: 'text',
        text: terminalText(`${text}\n${JSON.stringify(structuredContent)}`),
      },
    ],
    structuredContent,
  };
}

function fits(value: CallToolResult): boolean {
  return JSON.stringify(value).length <= MAX_RESULT_CHARS;
}

function itemHeader(item: ReportItem) {
  return {
    itemId: item.itemId,
    kind: item.kind,
    status: item.status,
    path: preview(item.path),
    title: preview(item.fullName),
    duration: item.duration,
    location: item.location,
    diagnosticsAvailable: item.diagnostics.length > 0,
  };
}

function summary(snapshot: ReportSnapshot) {
  return {
    adapter: snapshot.adapter,
    source: {
      relativePath: preview(snapshot.source.relativePath),
      sha256: snapshot.source.sha256,
      bytes: snapshot.source.bytes,
    },
    importedAt: snapshot.importedAt,
    provenance: snapshot.provenance,
    reported: snapshot.reported,
    computed: snapshot.computed,
    consistencyWarnings: snapshot.consistencyWarnings
      .slice(0, 8)
      .map((warning) => preview(warning)),
    consistencyWarningCount: snapshot.consistencyWarnings.length,
    limits: {
      resultChars: MAX_RESULT_CHARS,
      pageItems: 50,
      detailChars: MAX_DETAIL_CHARS,
    },
  };
}

export function importResult(snapshot: ReportSnapshot): CallToolResult {
  return initialResult(snapshot, 'import');
}

type ResolvedView =
  | {
      viewResolution: { mode: 'fixed'; reason?: ViewFallbackReason };
      view?: undefined;
    }
  | {
      viewResolution: { mode: 'generated'; digest: string };
      view: ViewSpecV1;
    };

function resolveView(
  snapshot: ReportSnapshot,
  candidate: unknown,
): ResolvedView {
  const fixed = (reason?: ViewFallbackReason): ResolvedView => ({
    viewResolution: { mode: 'fixed', ...(reason ? { reason } : {}) },
  });
  if (candidate === undefined) return fixed();
  try {
    if (JSON.stringify(candidate).length > MAX_VIEW_CHARS)
      return fixed('spec-too-large');
  } catch {
    return fixed('invalid-schema');
  }
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'schemaVersion' in candidate &&
    candidate.schemaVersion !== 1
  )
    return fixed('unsupported-version');
  const parsed = viewSpecSchema.safeParse(candidate);
  if (!parsed.success) return fixed('invalid-schema');
  const view = parsed.data;
  const failures = new Set(
    snapshot.files.flatMap((file) =>
      file.items
        .filter((item) => item.status === 'failed')
        .map((item) => item.itemId),
    ),
  );
  if (
    view.reportId !== snapshot.reportId ||
    view.sections.some((section) =>
      section.kind === 'evidence'
        ? section.initialFailureId !== undefined &&
          !failures.has(section.initialFailureId)
        : section.kind === 'hypothesis-groups' &&
          section.groups.some((group) =>
            group.failureIds.some((id) => !failures.has(id)),
          ),
    )
  )
    return fixed('invalid-reference');
  return {
    view,
    viewResolution: {
      mode: 'generated',
      digest: createHash('sha256').update(JSON.stringify(view)).digest('hex'),
    },
  };
}

export function showResult(
  snapshot: ReportSnapshot,
  candidate?: unknown,
): CallToolResult {
  return initialResult(snapshot, 'show', resolveView(snapshot, candidate));
}

function initialResult(
  snapshot: ReportSnapshot,
  kind: 'import' | 'show',
  resolved: ResolvedView = { viewResolution: { mode: 'fixed' } },
): CallToolResult {
  const list = resolved.view?.sections.find(
    (section) => section.kind === 'failure-list',
  );
  const evidence = resolved.view?.sections.find(
    (section) => section.kind === 'evidence',
  );
  const page = queryReport(snapshot, {
    kind: 'list',
    collection: 'failures',
    ...(list?.initialTextFilter !== undefined
      ? { text: list.initialTextFilter }
      : {}),
    limit: 5,
  }).structuredContent;
  const detail = evidence?.initialFailureId
    ? queryReport(snapshot, {
        kind: 'detail',
        itemId: evidence.initialFailureId,
      }).structuredContent
    : undefined;
  const envelope = {
    kind,
    summary: summary(snapshot),
    ...(kind === 'show' ? resolved : {}),
  };
  const verb = kind === 'import' ? 'Imported' : 'Explore';
  const description = `${verb} ${snapshot.reportId}: ${snapshot.computed.fileEntries} file entries, ${snapshot.computed.assertions} assertions, ${snapshot.computed.failures} failure entries. Report success: ${snapshot.reported.success}. Process exit and run completeness are unknown. ${snapshot.consistencyWarnings.length} consistency warnings. Query this reportId for evidence.`;
  if (detail) {
    const withDetail = result(
      snapshot,
      { ...envelope, firstPage: page, initialDetail: detail },
      description,
    );
    if (fits(withDetail)) return withDetail;
  }
  const value = result(snapshot, { ...envelope, firstPage: page }, description);
  if (fits(value)) return value;
  const compact = result(
    snapshot,
    envelope,
    `${verb} ${snapshot.reportId}. Query failures for evidence. Process exit is unknown.`,
  );
  if (!fits(compact)) {
    if (resolved.view)
      return initialResult(snapshot, 'show', {
        viewResolution: { mode: 'fixed', reason: 'result-too-large' },
      });
    throw new ExplorerError(
      'REPORT_TOO_LARGE',
      'Report summary exceeds the tool result budget.',
    );
  }
  return compact;
}

export function queryReport(
  snapshot: ReportSnapshot,
  query: unknown,
): CallToolResult {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    throw new ExplorerError(
      'INVALID_QUERY',
      'Use summary, a bounded list query, or a valid item detail query.',
    );
  }
  const input = parsed.data;
  if (input.kind === 'summary') {
    const value = result(
      snapshot,
      { kind: 'summary', summary: summary(snapshot) },
      `${snapshot.reportId}: ${snapshot.computed.fileEntries} file entries, ${snapshot.computed.assertions} assertions, ${snapshot.computed.failures} failure entries. Report success: ${snapshot.reported.success}; process exit is unknown. ${snapshot.consistencyWarnings.length} consistency warnings.`,
    );
    if (!fits(value))
      throw new ExplorerError(
        'REPORT_TOO_LARGE',
        'Report summary exceeds the tool result budget.',
      );
    return value;
  }
  const items = snapshot.files.flatMap((file) => file.items);
  if (input.kind === 'list') {
    const failureIds = input.failureIds ? new Set(input.failureIds) : undefined;
    if (failureIds) {
      const available = new Set(
        items
          .filter((item) => item.status === 'failed')
          .map((item) => item.itemId),
      );
      if (input.failureIds?.some((id) => !available.has(id)))
        throw new ExplorerError(
          'INVALID_QUERY',
          'Every failureId must identify a failed entry in this report.',
        );
    }
    if (
      (input.collection === 'failures' &&
        input.status &&
        input.status !== 'failed') ||
      (input.collection === 'file-errors' &&
        input.status &&
        input.status !== 'failed' &&
        input.status !== 'passed')
    ) {
      throw new ExplorerError(
        'INVALID_QUERY',
        'The status filter is incompatible with this collection.',
      );
    }
    const needle =
      input.text === undefined ? undefined : terminalText(input.text);
    const matched = items.filter((item) => {
      if (failureIds && !failureIds.has(item.itemId)) return false;
      if (input.collection === 'assertions' && item.kind !== 'assertion')
        return false;
      if (input.collection === 'file-errors' && item.kind !== 'file-error')
        return false;
      if (input.collection === 'failures' && item.status !== 'failed')
        return false;
      if (input.status && item.status !== input.status) return false;
      return (
        needle === undefined ||
        [item.path, item.fullName, item.title, item.diagnostics].some((field) =>
          terminalText(field).includes(needle),
        )
      );
    });
    const page: Array<ReturnType<typeof itemHeader>> = [];
    const build = () =>
      result(
        snapshot,
        {
          kind: 'list',
          collection: input.collection,
          searchScope:
            'whole-snapshot/path/title/diagnostics; terminal-safe, case-sensitive literal text',
          matchedCount: matched.length,
          returnedCount: page.length,
          offset: input.offset,
          nextOffset:
            input.offset + page.length < matched.length
              ? input.offset + page.length
              : null,
          items: page,
        },
        `${input.collection}: ${matched.length} matching entries; returned ${page.length} at offset ${input.offset}.`,
      );
    for (const item of matched.slice(
      input.offset,
      input.offset + input.limit,
    )) {
      page.push(itemHeader(item));
      if (!fits(build())) {
        page.pop();
        break;
      }
    }
    const value = build();
    if (!fits(value) || (input.offset < matched.length && page.length === 0)) {
      throw new ExplorerError(
        'REPORT_TOO_LARGE',
        'A list entry cannot fit the result budget.',
      );
    }
    return value;
  }
  const item = items.find((candidate) => candidate.itemId === input.itemId);
  if (!item)
    throw new ExplorerError(
      'INVALID_QUERY',
      'The itemId does not exist in this report.',
    );
  const field = terminalText(
    input.field === 'title' ? item.fullName : item[input.field],
  );
  if (
    input.offset > field.length ||
    safeEnd(field, input.offset) !== input.offset
  ) {
    throw new ExplorerError(
      'INVALID_QUERY',
      'Detail offset is outside the field or splits a Unicode surrogate pair.',
    );
  }
  const build = (end: number) =>
    result(
      snapshot,
      {
        kind: 'detail',
        item: itemHeader(item),
        field: input.field,
        textRepresentation: 'terminal-safe',
        text: field.slice(input.offset, end),
        offset: input.offset,
        nextOffset: end < field.length ? end : null,
        totalLength: field.length,
      },
      `Detail ${item.itemId}, ${input.field}; characters ${input.offset}–${end} of ${field.length}.`,
    );
  let end = safeEnd(
    field,
    Math.min(field.length, input.offset + MAX_DETAIL_CHARS),
  );
  while (!fits(build(end)) && end > input.offset) {
    end = safeEnd(field, input.offset + Math.floor((end - input.offset) / 2));
  }
  const value = build(end);
  if (!fits(value) || (end === input.offset && end < field.length)) {
    throw new ExplorerError(
      'REPORT_TOO_LARGE',
      'A detail fragment cannot fit the result budget.',
    );
  }
  return value;
}
