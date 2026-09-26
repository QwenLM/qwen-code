/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The managed-tool-result/1 contract (O1a of #12723). The shared fixtures in
// contracts/managed-tool-result-v1.fixtures.json pin it, and a conformance
// test in packages/sdk-java/runtime-broker pins the same constants. Nothing
// uses it until the local segment store (O1b) and the worker (O1c).

export const MANAGED_TOOL_RESULT_PROTOCOL = 'managed-tool-result/1';

export const MANAGED_TOOL_RESULT_KINDS = Object.freeze({
  manifest: 'managed-tool-result-manifest',
  page: 'managed-tool-result-page',
  content: 'managed-tool-result-content',
} as const);

export const MANAGED_TOOL_RESULT_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxPageBytes: 256 * 1024,
  maxContents: 32,
  maxPagesPerStream: 64,
  maxSegmentsPerPage: 1024,
  maxSegmentBytes: 16 * 1024 * 1024,
  maxOrdinal: 64 * 1024 - 1,
  maxMimeTypeLength: 255,
  /** The Managed Session stable ID rule, which every id field follows. */
  maxIdBytes: MANAGED_SESSION_LIMITS.maxIdBytes,
  maxTokenLength: 128,
} as const);

export const MANAGED_TOOL_RESULT_ROUTES = Object.freeze(
  (['execute', 'status', 'cancel', 'acknowledge'] as const).map((key) =>
    Object.freeze({
      key,
      method: 'POST',
      path: `/internal/managed-runtime/v3/${key}`,
      protocolVersion: 3,
      requestBodyLimitBytes: key === 'execute' ? 256 * 1024 : 16 * 1024,
      responseBodyLimitBytes: 1024 * 1024,
      cacheControl: 'no-store',
    } as const),
  ),
);

const LIMITS = MANAGED_TOOL_RESULT_LIMITS;
const TOKEN_PATTERN = new RegExp(`^[a-z0-9_-]{1,${LIMITS.maxTokenLength}}$`);
const GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/;
const MAX_GENERATION = 2n ** 63n - 1n;
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,16}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;[\x20-\x7e]*)?$/;
const MIN_EXIT_CODE = -(2 ** 31);
const MAX_EXIT_CODE = 2 ** 32 - 1;

const EXECUTION_STATUSES = [
  'success',
  'error',
  'cancelled',
  'unknown',
] as const;
const CAPTURE_SCOPES = ['process_pty', 'process_pipes', 'tool_native'] as const;
const CAPTURE_POLICIES = ['complete_required', 'best_effort'] as const;
const CAPTURE_STATUSES = [
  'pending',
  'complete',
  'partial',
  'unavailable',
] as const;
const CAPTURE_REASONS = [
  'quota_exhausted',
  'size_limit',
  'producer_lost',
  'storage_failed',
  'cancelled',
] as const;
const ROLES = ['stdout', 'stderr', 'pty', 'result', 'attachment'] as const;
const STREAM_STATES = ['open', 'sealed', 'incomplete'] as const;
const RESULT_EXECUTION_STATUSES = [
  'not_started',
  'success',
  'error',
  'cancelled',
] as const;
const DELIVERY_STATUSES = ['pending', 'committed', 'blocked'] as const;

const MANIFEST_KEYS = [
  'bindingGeneration',
  'callId',
  'captureId',
  'capturePolicy',
  'captureReason',
  'captureScope',
  'captureStatus',
  'contents',
  'executionCallId',
  'executionStatus',
  'exitCode',
  'invocationDigest',
  'revision',
  'sessionId',
  'signal',
  'tenantId',
  'toolResult',
  'turnId',
  'type',
  'upstreamTruncated',
] as const;
const DESCRIPTOR_KEYS = [
  'body',
  'byteLength',
  'digest',
  'missingRanges',
  'mimeType',
  'role',
  'state',
  'streamId',
] as const;
const PAGE_REFERENCE_KEYS = ['byteLength', 'ref', 'segmentCount'] as const;
const PAGE_KEYS = [
  'captureId',
  'firstOrdinal',
  'offset',
  'segments',
  'streamId',
  'toolResult',
  'type',
] as const;
const SEGMENT_KEYS = ['byteLength', 'digest'] as const;
const RANGE_KEYS = ['end', 'start'] as const;
const CAPTURE_KEYS = [
  'captureReason',
  'captureStatus',
  'deliveryStatus',
  'manifest',
  'previewTruncated',
] as const;
/** The fields that no revision of a capture may change. */
const FIXED_KEYS = [
  'tenantId',
  'sessionId',
  'turnId',
  'executionCallId',
  'callId',
  'invocationDigest',
  'bindingGeneration',
  'captureId',
  'captureScope',
  'capturePolicy',
] as const;

export type ToolResultExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type ToolResultCaptureScope = (typeof CAPTURE_SCOPES)[number];
export type ToolResultCapturePolicy = (typeof CAPTURE_POLICIES)[number];
export type ToolResultCaptureStatus = (typeof CAPTURE_STATUSES)[number];
export type ToolResultCaptureReason = (typeof CAPTURE_REASONS)[number];
export type ToolResultRole = (typeof ROLES)[number];
export type ToolResultStreamState = (typeof STREAM_STATES)[number];
export type ToolResultDeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface ToolResultPageReference {
  readonly ref: ManagedSessionDurableRef;
  readonly segmentCount: number;
  readonly byteLength: number;
}

export interface ToolResultMissingRange {
  readonly start: number;
  readonly end: number | null;
}

export interface ToolResultContentDescriptor {
  readonly streamId: string;
  readonly role: ToolResultRole;
  readonly mimeType: string;
  readonly state: ToolResultStreamState;
  readonly byteLength: number;
  readonly digest: string;
  readonly missingRanges: readonly ToolResultMissingRange[];
  readonly body:
    | { readonly ref: ManagedSessionDurableRef }
    | { readonly pages: readonly ToolResultPageReference[] };
}

export interface ToolResultManifest {
  readonly toolResult: typeof MANAGED_TOOL_RESULT_PROTOCOL;
  readonly type: 'manifest';
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionCallId: string;
  readonly callId: string;
  readonly invocationDigest: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly bindingGeneration: string;
  readonly captureId: string;
  readonly revision: number;
  readonly executionStatus: ToolResultExecutionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly captureScope: ToolResultCaptureScope;
  readonly capturePolicy: ToolResultCapturePolicy;
  readonly captureStatus: ToolResultCaptureStatus;
  readonly captureReason: ToolResultCaptureReason | null;
  readonly upstreamTruncated: boolean;
  readonly contents: readonly ToolResultContentDescriptor[];
}

export interface ToolResultSegment {
  readonly byteLength: number;
  readonly digest: string;
}

export interface ToolResultPage {
  readonly toolResult: typeof MANAGED_TOOL_RESULT_PROTOCOL;
  readonly type: 'page';
  readonly captureId: string;
  readonly streamId: string;
  readonly firstOrdinal: number;
  readonly offset: number;
  readonly segments: readonly ToolResultSegment[];
}

export interface ToolResultCapture {
  readonly captureStatus: Exclude<ToolResultCaptureStatus, 'pending'>;
  readonly captureReason: ToolResultCaptureReason | null;
  readonly manifest: ManagedSessionDurableRef | null;
  readonly previewTruncated: boolean;
  readonly deliveryStatus: ToolResultDeliveryStatus;
}

/** The settled result of a Tool v3 call: Tool v2's result plus `capture`. */
export interface ToolResultEnvelope {
  readonly executionStatus: (typeof RESULT_EXECUTION_STATUSES)[number];
  readonly responseParts: readonly unknown[];
  readonly error?: { readonly message: string; readonly type?: string };
  /** Null exactly when the call did not start. */
  readonly capture: ToolResultCapture | null;
}

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

/**
 * Copies an object's fields when its own keys are `keys`, plus any of
 * `optional`, so every later check and use reads one snapshot.
 */
function closed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
  optional: readonly Key[] = [],
): Record<Key, unknown> {
  if (typeof value !== 'object' || value === null) {
    fail(`${label} must be a JSON object.`);
  }
  // An array fails here too, since its prototype is Array.prototype.
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain JSON object.`);
  }
  const present = Object.keys(value);
  if (
    present.some((key) => !keys.includes(key as Key)) ||
    keys.some((key) => !optional.includes(key) && !present.includes(key))
  ) {
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  }
  const snapshot = {} as Record<Key, unknown>;
  for (const key of present as Key[]) {
    snapshot[key] = (value as Record<Key, unknown>)[key];
  }
  return snapshot;
}

function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > max) fail(`${label} has more than ${max} entries.`);
  return [...value];
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function exactly<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) fail(`${label} must be ${String(expected)}.`);
  return expected;
}

function id(value: unknown, label: string): string {
  return assertManagedSessionStableId(value as ManagedSessionJsonValue, label);
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    fail(`${label} must match ${TOKEN_PATTERN.source}.`);
  }
  return value;
}

function count(value: unknown, label: string, min = 0, max?: number): number {
  const number = assertManagedSessionSequence(
    value as ManagedSessionJsonValue,
    label,
  );
  if (number < min || (max !== undefined && number > max)) {
    fail(`${label} is out of range.`);
  }
  return number;
}

function digest(value: unknown, label: string): string {
  return assertManagedSessionDigest(value as ManagedSessionJsonValue, label);
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean.`);
  return value;
}

function generation(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !GENERATION_PATTERN.test(value) ||
    BigInt(value) > MAX_GENERATION
  ) {
    fail(`${label} must be canonical decimal text from 1 to 2^63-1.`);
  }
  return value;
}

function reference(
  value: unknown,
  label: string,
  kind: string,
  maxBytes?: number,
): ManagedSessionDurableRef {
  const ref = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    label,
  );
  if (ref.kind !== kind || ref.schemaVersion !== 1) {
    fail(`${label} must reference ${kind} version 1.`);
  }
  if (
    maxBytes !== undefined &&
    (ref.byteLength < 1 || ref.byteLength > maxBytes)
  ) {
    fail(`${label} must be 1 to ${maxBytes} bytes.`);
  }
  return Object.freeze(ref);
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function parseExitCode(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_EXIT_CODE ||
    (value as number) > MAX_EXIT_CODE
  ) {
    fail('manifest.exitCode must be an integer from -2^31 to 2^32-1.');
  }
  return value as number;
}

function parseSignal(value: unknown): string {
  if (typeof value !== 'string' || !SIGNAL_PATTERN.test(value)) {
    fail('manifest.signal must be SIG followed by 1 to 16 of [A-Z0-9].');
  }
  return value;
}

function parseMimeType(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > LIMITS.maxMimeTypeLength ||
    !MIME_TYPE_PATTERN.test(value)
  ) {
    fail(`${label} must be a lowercase MIME type of at most 255 characters.`);
  }
  return value;
}

function parseMissingRanges(
  value: unknown,
  state: ToolResultStreamState,
  byteLength: number,
  label: string,
): readonly ToolResultMissingRange[] {
  const ranges = list(value, label, state === 'incomplete' ? 1 : 0);
  return Object.freeze(
    ranges.map((item) => {
      const range = closed(item, RANGE_KEYS, `${label}[0]`);
      const start = count(range.start, `${label}[0].start`);
      const end = nullable(range.end, (end) =>
        count(end, `${label}[0].end`, start + 1),
      );
      // A v1 stream stores a prefix, so only its tail can be missing.
      if (start !== byteLength) {
        fail(`${label}[0].start must be the stored byte length.`);
      }
      return Object.freeze({ start, end });
    }),
  );
}

function parsePageReference(
  value: unknown,
  label: string,
): ToolResultPageReference {
  const page = closed(value, PAGE_REFERENCE_KEYS, label);
  const segmentCount = count(
    page.segmentCount,
    `${label}.segmentCount`,
    1,
    LIMITS.maxSegmentsPerPage,
  );
  return Object.freeze({
    ref: reference(
      page.ref,
      `${label}.ref`,
      MANAGED_TOOL_RESULT_KINDS.page,
      LIMITS.maxPageBytes,
    ),
    segmentCount,
    byteLength: count(
      page.byteLength,
      `${label}.byteLength`,
      segmentCount,
      segmentCount * LIMITS.maxSegmentBytes,
    ),
  });
}

function parseDescriptor(
  value: unknown,
  label: string,
): ToolResultContentDescriptor {
  const entry = closed(value, DESCRIPTOR_KEYS, label);
  const state = oneOf(entry.state, STREAM_STATES, `${label}.state`);
  const byteLength = count(entry.byteLength, `${label}.byteLength`);
  const streamDigest = digest(entry.digest, `${label}.digest`);
  const body = closed(entry.body, ['pages', 'ref'], `${label}.body`, [
    'pages',
    'ref',
  ]);
  const forms = Object.keys(body);
  if (forms.length !== 1) {
    fail(`${label}.body must have exactly one of pages and ref.`);
  }
  let parsedBody: ToolResultContentDescriptor['body'];
  if (forms[0] === 'ref') {
    if (state === 'open') fail(`${label}.body.ref cannot grow while open.`);
    const ref = reference(
      body.ref,
      `${label}.body.ref`,
      MANAGED_TOOL_RESULT_KINDS.content,
    );
    if (ref.byteLength !== byteLength || ref.digest !== streamDigest) {
      fail(`${label}.body.ref must hold exactly the stored bytes.`);
    }
    parsedBody = Object.freeze({ ref });
  } else {
    const pages = list(
      body.pages,
      `${label}.body.pages`,
      LIMITS.maxPagesPerStream,
    ).map((page, index) =>
      parsePageReference(page, `${label}.body.pages[${index}]`),
    );
    if (pages.reduce((sum, page) => sum + page.byteLength, 0) !== byteLength) {
      fail(`${label}.body.pages must add up to the stored byte length.`);
    }
    parsedBody = Object.freeze({ pages: Object.freeze(pages) });
  }
  return Object.freeze({
    streamId: token(entry.streamId, `${label}.streamId`),
    role: oneOf(entry.role, ROLES, `${label}.role`),
    mimeType: parseMimeType(entry.mimeType, `${label}.mimeType`),
    state,
    byteLength,
    digest: streamDigest,
    missingRanges: parseMissingRanges(
      entry.missingRanges,
      state,
      byteLength,
      `${label}.missingRanges`,
    ),
    body: parsedBody,
  });
}

/** The capture status that a manifest's descriptors imply. */
function impliedStatus(
  contents: readonly ToolResultContentDescriptor[],
): ToolResultCaptureStatus {
  if (contents.some((entry) => entry.state === 'open')) return 'pending';
  if (contents.length > 0 && contents.every((e) => e.state === 'sealed')) {
    return 'complete';
  }
  if (
    contents.every(
      (entry) => entry.state === 'incomplete' && entry.byteLength === 0,
    )
  ) {
    return 'unavailable';
  }
  return 'partial';
}

function assertRoles(
  scope: ToolResultCaptureScope,
  contents: readonly ToolResultContentDescriptor[],
): void {
  const streams = new Set(contents.map((entry) => entry.streamId));
  if (streams.size !== contents.length) {
    fail('manifest.contents must not repeat a streamId.');
  }
  const roles = contents.map((entry) => entry.role);
  for (const role of ['stdout', 'stderr', 'pty', 'result'] as const) {
    if (roles.filter((each) => each === role).length > 1) {
      fail(`manifest.contents has more than one ${role} stream.`);
    }
  }
  const excluded: readonly ToolResultRole[] =
    scope === 'process_pty'
      ? ['stdout', 'stderr']
      : scope === 'process_pipes'
        ? ['pty']
        : ['stdout', 'stderr', 'pty'];
  if (roles.some((role) => excluded.includes(role))) {
    fail(`manifest.contents has a stream role outside ${scope}.`);
  }
}

/** Validates a manifest object and returns a frozen copy of it. */
export function parseToolResultManifest(value: unknown): ToolResultManifest {
  const manifest = closed(value, MANIFEST_KEYS, 'manifest');
  exactly(manifest.toolResult, MANAGED_TOOL_RESULT_PROTOCOL, 'toolResult');
  exactly(manifest.type, 'manifest', 'manifest.type');
  const captureScope = oneOf(
    manifest.captureScope,
    CAPTURE_SCOPES,
    'manifest.captureScope',
  );
  const exitCode = nullable(manifest.exitCode, parseExitCode);
  const signal = nullable(manifest.signal, parseSignal);
  if (
    captureScope === 'tool_native'
      ? exitCode !== null || signal !== null
      : exitCode !== null && signal !== null
  ) {
    fail('manifest.exitCode and manifest.signal do not fit the scope.');
  }
  const contents = Object.freeze(
    list(manifest.contents, 'manifest.contents', LIMITS.maxContents).map(
      (entry, index) => parseDescriptor(entry, `manifest.contents[${index}]`),
    ),
  );
  assertRoles(captureScope, contents);
  const captureStatus = oneOf(
    manifest.captureStatus,
    CAPTURE_STATUSES,
    'manifest.captureStatus',
  );
  if (captureStatus !== impliedStatus(contents)) {
    fail('manifest.captureStatus does not match its streams.');
  }
  const captureReason = nullable(manifest.captureReason, (reason) =>
    oneOf(reason, CAPTURE_REASONS, 'manifest.captureReason'),
  );
  if (
    (captureReason === null) !==
    (captureStatus === 'pending' || captureStatus === 'complete')
  ) {
    fail('manifest.captureReason must be set exactly when bytes are missing.');
  }
  return Object.freeze({
    toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
    type: 'manifest',
    tenantId: id(manifest.tenantId, 'manifest.tenantId'),
    sessionId: id(manifest.sessionId, 'manifest.sessionId'),
    turnId: id(manifest.turnId, 'manifest.turnId'),
    executionCallId: id(manifest.executionCallId, 'manifest.executionCallId'),
    callId: id(manifest.callId, 'manifest.callId'),
    invocationDigest: id(
      manifest.invocationDigest,
      'manifest.invocationDigest',
    ),
    bindingGeneration: generation(
      manifest.bindingGeneration,
      'manifest.bindingGeneration',
    ),
    captureId: token(manifest.captureId, 'manifest.captureId'),
    revision: count(manifest.revision, 'manifest.revision', 1),
    executionStatus: oneOf(
      manifest.executionStatus,
      EXECUTION_STATUSES,
      'manifest.executionStatus',
    ),
    exitCode,
    signal,
    captureScope,
    capturePolicy: oneOf(
      manifest.capturePolicy,
      CAPTURE_POLICIES,
      'manifest.capturePolicy',
    ),
    captureStatus,
    captureReason,
    upstreamTruncated: flag(
      manifest.upstreamTruncated,
      'manifest.upstreamTruncated',
    ),
    contents,
  });
}

function parseBoundedJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength > maxBytes) {
    fail(`record exceeds ${maxBytes} bytes.`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail('record is not UTF-8.');
  }
  return parseManagedSessionRecordJson(text, maxBytes);
}

/** Parses a manifest resource body of at most 64 KiB. */
export function parseToolResultManifestBytes(
  bytes: Uint8Array,
): ToolResultManifest {
  return parseToolResultManifest(
    parseBoundedJson(bytes, LIMITS.maxManifestBytes),
  );
}

/** Validates a page object and returns a frozen copy of it. */
export function parseToolResultPage(value: unknown): ToolResultPage {
  const page = closed(value, PAGE_KEYS, 'page');
  exactly(page.toolResult, MANAGED_TOOL_RESULT_PROTOCOL, 'page.toolResult');
  exactly(page.type, 'page', 'page.type');
  const segments = list(
    page.segments,
    'page.segments',
    LIMITS.maxSegmentsPerPage,
  ).map((item, index) => {
    const segment = closed(item, SEGMENT_KEYS, `page.segments[${index}]`);
    return Object.freeze({
      byteLength: count(
        segment.byteLength,
        `page.segments[${index}].byteLength`,
        1,
        LIMITS.maxSegmentBytes,
      ),
      digest: digest(segment.digest, `page.segments[${index}].digest`),
    });
  });
  if (segments.length === 0) fail('page.segments must not be empty.');
  const firstOrdinal = count(
    page.firstOrdinal,
    'page.firstOrdinal',
    0,
    LIMITS.maxOrdinal + 1 - segments.length,
  );
  const offset = count(page.offset, 'page.offset');
  count(
    offset + segments.reduce((sum, segment) => sum + segment.byteLength, 0),
    'page end',
  );
  return Object.freeze({
    toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
    type: 'page',
    captureId: token(page.captureId, 'page.captureId'),
    streamId: token(page.streamId, 'page.streamId'),
    firstOrdinal,
    offset,
    segments: Object.freeze(segments),
  });
}

/** Parses a page resource body of at most 256 KiB. */
export function parseToolResultPageBytes(bytes: Uint8Array): ToolResultPage {
  return parseToolResultPage(parseBoundedJson(bytes, LIMITS.maxPageBytes));
}

function attempt<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return undefined;
    throw error;
  }
}

function pagesOf(
  entry: ToolResultContentDescriptor,
): readonly ToolResultPageReference[] | undefined {
  return 'pages' in entry.body ? entry.body.pages : undefined;
}

/**
 * Whether `page` is page `pageIndex` of stream `streamIndex` in `manifest`:
 * the same capture and stream, the position that the earlier pages imply,
 * and the segment count and byte total that its reference records.
 */
export function isToolResultPageAt(
  manifest: unknown,
  streamIndex: number,
  pageIndex: number,
  page: unknown,
): boolean {
  const parsedManifest = attempt(() => parseToolResultManifest(manifest));
  const parsedPage = attempt(() => parseToolResultPage(page));
  const entry = parsedManifest?.contents[streamIndex];
  const pages = entry && pagesOf(entry);
  const slot = pages?.[pageIndex];
  if (!parsedManifest || !parsedPage || !entry || !pages || !slot) {
    return false;
  }
  const earlier = pages.slice(0, pageIndex);
  return (
    parsedPage.captureId === parsedManifest.captureId &&
    parsedPage.streamId === entry.streamId &&
    parsedPage.firstOrdinal ===
      earlier.reduce((sum, each) => sum + each.segmentCount, 0) &&
    parsedPage.offset ===
      earlier.reduce((sum, each) => sum + each.byteLength, 0) &&
    parsedPage.segments.length === slot.segmentCount &&
    parsedPage.segments.reduce((sum, each) => sum + each.byteLength, 0) ===
      slot.byteLength
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDescriptorSuccessor(
  previous: ToolResultContentDescriptor,
  next: ToolResultContentDescriptor,
): boolean {
  if (
    previous.streamId !== next.streamId ||
    previous.role !== next.role ||
    previous.mimeType !== next.mimeType
  ) {
    return false;
  }
  if (previous.state !== 'open') return sameJson(previous, next);
  const before = pagesOf(previous) ?? [];
  const after = pagesOf(next);
  // The page rules below also keep byteLength from shrinking.
  if (
    !after ||
    (next.byteLength === previous.byteLength &&
      next.digest !== previous.digest) ||
    after.length < before.length
  ) {
    return false;
  }
  const last = before.length - 1;
  return before.every((page, index) =>
    index < last
      ? sameJson(page, after[index])
      : after[index].segmentCount >= page.segmentCount &&
        after[index].byteLength >= page.byteLength,
  );
}

/**
 * Whether `next` may follow `previous` as the next revision of one capture:
 * only a pending revision has a successor, and a successor may only extend
 * what the earlier revision recorded.
 */
export function isToolResultManifestSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  const before = attempt(() => parseToolResultManifest(previous));
  const after = attempt(() => parseToolResultManifest(next));
  if (
    !before ||
    !after ||
    before.captureStatus !== 'pending' ||
    after.revision !== before.revision + 1 ||
    FIXED_KEYS.some((key) => before[key] !== after[key]) ||
    (before.upstreamTruncated && !after.upstreamTruncated) ||
    after.contents.length < before.contents.length
  ) {
    return false;
  }
  if (
    before.executionStatus !== 'unknown' &&
    (before.executionStatus !== after.executionStatus ||
      before.exitCode !== after.exitCode ||
      before.signal !== after.signal)
  ) {
    return false;
  }
  return before.contents.every((entry, index) =>
    isDescriptorSuccessor(entry, after.contents[index]),
  );
}

/**
 * Whether `next` may replace `previous` as the last page of an open stream:
 * the same position, and every earlier segment unchanged.
 */
export function isToolResultPageSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  const before = attempt(() => parseToolResultPage(previous));
  const after = attempt(() => parseToolResultPage(next));
  return (
    !!before &&
    !!after &&
    before.captureId === after.captureId &&
    before.streamId === after.streamId &&
    before.firstOrdinal === after.firstOrdinal &&
    before.offset === after.offset &&
    before.segments.every(
      (segment, index) =>
        after.segments[index]?.byteLength === segment.byteLength &&
        after.segments[index]?.digest === segment.digest,
    )
  );
}

function parseCapture(value: unknown): ToolResultCapture {
  const capture = closed(value, CAPTURE_KEYS, 'result.capture');
  const captureStatus = oneOf(
    capture.captureStatus,
    ['complete', 'partial', 'unavailable'] as const,
    'result.capture.captureStatus',
  );
  const captureReason = nullable(capture.captureReason, (reason) =>
    oneOf(reason, CAPTURE_REASONS, 'result.capture.captureReason'),
  );
  if ((captureReason === null) !== (captureStatus === 'complete')) {
    fail('result.capture.captureReason must be set unless it is complete.');
  }
  const manifest = nullable(capture.manifest, (ref) =>
    reference(
      ref,
      'result.capture.manifest',
      MANAGED_TOOL_RESULT_KINDS.manifest,
      LIMITS.maxManifestBytes,
    ),
  );
  if (manifest === null && captureStatus !== 'unavailable') {
    fail('result.capture.manifest is required unless it is unavailable.');
  }
  return Object.freeze({
    captureStatus,
    captureReason,
    manifest,
    previewTruncated: flag(
      capture.previewTruncated,
      'result.capture.previewTruncated',
    ),
    deliveryStatus: oneOf(
      capture.deliveryStatus,
      DELIVERY_STATUSES,
      'result.capture.deliveryStatus',
    ),
  });
}

/** Validates a settled Tool v3 result and returns a frozen copy of it. */
export function parseToolResultEnvelope(value: unknown): ToolResultEnvelope {
  const result = closed(
    value,
    ['capture', 'error', 'executionStatus', 'responseParts'],
    'result',
    ['error'],
  );
  const executionStatus = oneOf(
    result.executionStatus,
    RESULT_EXECUTION_STATUSES,
    'result.executionStatus',
  );
  if (!Array.isArray(result.responseParts)) {
    fail('result.responseParts must be an array.');
  }
  const capture =
    executionStatus === 'not_started'
      ? exactly(result.capture, null, 'result.capture')
      : parseCapture(result.capture);
  let error: ToolResultEnvelope['error'];
  if ('error' in result) {
    const fields = closed(result.error, ['message', 'type'], 'result.error', [
      'type',
    ]);
    const text = (value: unknown, label: string) => {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`${label} must be a non-empty string.`);
      }
      return value;
    };
    error = Object.freeze({
      message: text(fields.message, 'result.error.message'),
      ...('type' in fields
        ? { type: text(fields.type, 'result.error.type') }
        : {}),
    });
  }
  return Object.freeze({
    executionStatus,
    responseParts: Object.freeze([...result.responseParts]),
    ...(error ? { error } : {}),
    capture,
  });
}

/**
 * Whether a settled result agrees with the final manifest revision it
 * references: the same outcome and the same concluded capture.
 */
export function isToolResultEnvelopeOf(
  result: unknown,
  manifest: unknown,
): boolean {
  const envelope = attempt(() => parseToolResultEnvelope(result));
  const parsed = attempt(() => parseToolResultManifest(manifest));
  return (
    !!envelope?.capture?.manifest &&
    !!parsed &&
    parsed.executionStatus === envelope.executionStatus &&
    parsed.captureStatus === envelope.capture.captureStatus &&
    parsed.captureReason === envelope.capture.captureReason
  );
}

export type ToolResultStoreCode =
  | 'managed_tool_result_invalid'
  | 'managed_tool_result_conflict'
  | 'managed_tool_result_digest_mismatch';

export type ToolResultStoreOutcome<Result> =
  | { readonly status: 'ok'; readonly result: Result }
  | { readonly status: 'refused'; readonly code: ToolResultStoreCode };

export interface ToolResultSegmentReceipt {
  readonly ordinal: number;
  readonly byteLength: number;
  readonly digest: string;
}

export interface ToolResultSealReceipt {
  readonly segmentCount: number;
  readonly byteLength: number;
  readonly digest: string;
}

export interface ToolResultPrefix extends ToolResultSealReceipt {
  readonly sealed: boolean;
}

function refused(code: ToolResultStoreCode): ToolResultStoreOutcome<never> {
  return Object.freeze({ status: 'refused', code });
}

function ok<Result>(result: Result): ToolResultStoreOutcome<Result> {
  return Object.freeze({ status: 'ok', result: Object.freeze(result) });
}

function sha256(chunks: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

interface Stream {
  readonly segments: Map<number, Uint8Array>;
  seal?: ToolResultSealReceipt;
}

/**
 * The segment store semantics in memory: the reference that every segment
 * store must answer alike. Lengths and digests come from the received bytes;
 * a caller's digest is only compared. A refused operation records nothing.
 */
export class ToolResultSegmentLedger {
  readonly #streams = new Map<string, Stream>();

  publish(request: unknown): ToolResultStoreOutcome<ToolResultSegmentReceipt> {
    const fields = attempt(() => {
      const value = closed(
        request,
        ['bytes', 'captureId', 'digest', 'ordinal', 'streamId'],
        'publish',
        ['digest'],
      );
      const bytes = value.bytes;
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > LIMITS.maxSegmentBytes
      ) {
        fail('publish.bytes must be 1 to 16 MiB.');
      }
      return {
        key: streamKey(value),
        ordinal: count(value.ordinal, 'publish.ordinal', 0, LIMITS.maxOrdinal),
        bytes: Uint8Array.from(bytes),
        expected:
          'digest' in value ? digest(value.digest, 'publish.digest') : null,
      };
    });
    if (!fields) return refused('managed_tool_result_invalid');
    const received = sha256([fields.bytes]);
    if (fields.expected !== null && fields.expected !== received) {
      return refused('managed_tool_result_digest_mismatch');
    }
    const stream = this.#streams.get(fields.key);
    const stored = stream?.segments.get(fields.ordinal);
    if (stored) {
      return sha256([stored]) === received &&
        stored.byteLength === fields.bytes.byteLength
        ? ok(segmentReceipt(fields.ordinal, stored))
        : refused('managed_tool_result_conflict');
    }
    if (stream?.seal && fields.ordinal >= stream.seal.segmentCount) {
      return refused('managed_tool_result_conflict');
    }
    const target: Stream = stream ?? { segments: new Map() };
    target.segments.set(fields.ordinal, fields.bytes);
    this.#streams.set(fields.key, target);
    return ok(segmentReceipt(fields.ordinal, fields.bytes));
  }

  seal(request: unknown): ToolResultStoreOutcome<ToolResultSealReceipt> {
    const fields = attempt(() => {
      const value = closed(
        request,
        ['byteLength', 'captureId', 'digest', 'segmentCount', 'streamId'],
        'seal',
      );
      return {
        key: streamKey(value),
        segmentCount: count(
          value.segmentCount,
          'seal.segmentCount',
          0,
          LIMITS.maxOrdinal + 1,
        ),
        byteLength: count(value.byteLength, 'seal.byteLength'),
        digest: digest(value.digest, 'seal.digest'),
      };
    });
    if (!fields) return refused('managed_tool_result_invalid');
    const wanted = {
      segmentCount: fields.segmentCount,
      byteLength: fields.byteLength,
      digest: fields.digest,
    };
    const stream: Stream = this.#streams.get(fields.key) ?? {
      segments: new Map(),
    };
    if (stream.seal) {
      return sameJson(stream.seal, wanted)
        ? ok({ ...stream.seal })
        : refused('managed_tool_result_conflict');
    }
    const ordinals = [...stream.segments.keys()];
    if (
      ordinals.length !== fields.segmentCount ||
      ordinals.some((ordinal) => ordinal >= fields.segmentCount)
    ) {
      return refused('managed_tool_result_conflict');
    }
    const chunks = ordinals
      .sort((left, right) => left - right)
      .map((ordinal) => stream.segments.get(ordinal)!);
    if (
      chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) !==
        fields.byteLength ||
      sha256(chunks) !== fields.digest
    ) {
      return refused('managed_tool_result_digest_mismatch');
    }
    stream.seal = Object.freeze(wanted);
    this.#streams.set(fields.key, stream);
    return ok({ ...wanted });
  }

  /** The verified prefix: the stored segments from ordinal 0 without a gap. */
  prefix(request: unknown): ToolResultStoreOutcome<ToolResultPrefix> {
    const key = attempt(() =>
      streamKey(closed(request, ['captureId', 'streamId'], 'prefix')),
    );
    if (key === undefined) return refused('managed_tool_result_invalid');
    const stream = this.#streams.get(key);
    const chunks: Uint8Array[] = [];
    for (
      let chunk = stream?.segments.get(0);
      chunk;
      chunk = stream?.segments.get(chunks.length)
    ) {
      chunks.push(chunk);
    }
    return ok({
      segmentCount: chunks.length,
      byteLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      digest: sha256(chunks),
      sealed: stream?.seal !== undefined,
    });
  }
}

function streamKey(fields: {
  readonly captureId?: unknown;
  readonly streamId?: unknown;
}): string {
  // Tokens never contain a slash, so the key cannot be ambiguous.
  return `${token(fields.captureId, 'captureId')}/${token(
    fields.streamId,
    'streamId',
  )}`;
}

function segmentReceipt(
  ordinal: number,
  bytes: Uint8Array,
): ToolResultSegmentReceipt {
  return { ordinal, byteLength: bytes.byteLength, digest: sha256([bytes]) };
}
