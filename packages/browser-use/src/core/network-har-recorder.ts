/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { finished } from 'node:stream/promises';
import { dirname } from 'node:path';

import type { BridgeEvent } from '../bridge/index.js';

const NETWORK_EVENT_METHODS = new Set([
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'qwenBrowser.responseBody',
]);
const SENSITIVE_HEADER_PATTERN =
  /^(authorization|cookie|proxy-authorization|set-cookie)$/i;
const JSON_MIME_TYPE_PATTERN = /json/iu;
const RESPONSE_BODY_RESOURCE_TYPES = new Set(['Fetch', 'XHR']);
export const MAX_CAPTURED_JSON_RESPONSE_BYTES = 1 * 1_024 * 1_024;

interface JournalEvent {
  recordedAt: string;
  event: BridgeEvent;
}

interface JournalMetadata {
  type: 'metadata';
  truncatedEvents: number;
}

export interface NetworkHarRecorderOptions {
  maxJournalBytes?: number;
  maxBufferedBytes?: number;
}

export interface NetworkResponseBodyRequest {
  requestId: string;
  tabId: number;
  sessionId?: string;
}

const DEFAULT_MAX_JOURNAL_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MAX_BUFFERED_BYTES = 1 * 1_024 * 1_024;

interface PendingEntry {
  key: string;
  requestId: string;
  tabId: number;
  sessionId?: string;
  startedOrdinal: number;
  startedDateTime: string;
  startedMonotonic?: number;
  responseMonotonic?: number;
  finishedMonotonic?: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  failed?: string;
}

/**
 * Trusted, host-side CDP network recorder for benchmark artifacts.
 *
 * Relevant events are streamed to a bounded journal before they are folded
 * into a HAR. The journal lets the runner recover a trace after a model timeout
 * or forceful agent shutdown. Files are mode 0600 because request bodies can
 * contain benchmark credentials or other task inputs.
 */
export class NetworkHarRecorder {
  readonly outputPath: string;
  readonly journalPath: string;

  private readonly stream: WriteStream;
  private readonly maxJournalBytes: number;
  private readonly maxBufferedBytes: number;
  private journalBytes = 0;
  private truncatedEvents = 0;
  private streamError: Error | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly jsonResponseRequests = new Set<string>();

  constructor(outputPath: string, options: NetworkHarRecorderOptions = {}) {
    this.outputPath = outputPath;
    this.journalPath = journalPathForHar(outputPath);
    this.maxJournalBytes = positiveLimit(
      options.maxJournalBytes,
      DEFAULT_MAX_JOURNAL_BYTES,
    );
    this.maxBufferedBytes = positiveLimit(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
    );
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.journalPath, '', { encoding: 'utf8', mode: 0o600 });
    this.stream = createWriteStream(this.journalPath, {
      encoding: 'utf8',
      flags: 'a',
      mode: 0o600,
    });
    // Keep a permanent listener attached: WriteStream errors are otherwise
    // process-fatal when they happen between record() calls. flush()/close()
    // surface the stored failure to the runner at a controlled boundary.
    this.stream.on('error', (error) => {
      this.streamError ??= error;
    });
  }

  record(event: BridgeEvent): NetworkResponseBodyRequest | undefined {
    if (this.closed || !NETWORK_EVENT_METHODS.has(event.method))
      return undefined;
    const responseBodyRequest = this.trackResponseBodyCandidate(event);
    this.appendEvent(event);
    return responseBodyRequest;
  }

  recordResponseBody(
    request: NetworkResponseBodyRequest,
    value: unknown,
  ): boolean {
    if (this.closed || !isRecord(value) || typeof value.body !== 'string')
      return false;
    const text =
      value.base64Encoded === true
        ? Buffer.from(value.body, 'base64').toString('utf8')
        : value.body;
    if (Buffer.byteLength(text) > MAX_CAPTURED_JSON_RESPONSE_BYTES)
      return false;
    this.appendEvent({
      type: 'event',
      tabId: request.tabId,
      method: 'qwenBrowser.responseBody',
      params: { requestId: request.requestId, text },
      ...(request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId }),
    });
    return true;
  }

  private trackResponseBodyCandidate(
    event: BridgeEvent,
  ): NetworkResponseBodyRequest | undefined {
    const params = recordValue(event.params);
    const requestId =
      typeof params.requestId === 'string' ? params.requestId : '';
    if (requestId === '') return undefined;
    const key = eventKey(event, requestId);
    if (event.method === 'Network.responseReceived') {
      const response = recordValue(params.response);
      if (
        RESPONSE_BODY_RESOURCE_TYPES.has(String(params.type ?? '')) &&
        JSON_MIME_TYPE_PATTERN.test(String(response.mimeType ?? ''))
      ) {
        this.jsonResponseRequests.add(key);
      }
      return undefined;
    }
    if (event.method === 'Network.loadingFailed') {
      this.jsonResponseRequests.delete(key);
      return undefined;
    }
    if (
      event.method !== 'Network.loadingFinished' ||
      !this.jsonResponseRequests.delete(key)
    )
      return undefined;
    const encodedLength = numberValue(params.encodedDataLength);
    if (
      encodedLength !== undefined &&
      encodedLength > MAX_CAPTURED_JSON_RESPONSE_BYTES
    )
      return undefined;
    return {
      requestId,
      tabId: event.tabId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    };
  }

  private appendEvent(event: BridgeEvent): void {
    const journalEvent: JournalEvent = {
      recordedAt: new Date().toISOString(),
      event,
    };
    const line = `${JSON.stringify(journalEvent)}\n`;
    const bytes = Buffer.byteLength(line);
    if (
      this.journalBytes + bytes > this.maxJournalBytes ||
      this.stream.writableLength + bytes > this.maxBufferedBytes
    ) {
      this.truncatedEvents += 1;
      return;
    }
    this.journalBytes += bytes;
    this.stream.write(line);
  }

  async flush(): Promise<void> {
    this.throwIfStreamFailed();
    if (this.stream.closed) return;
    if (this.stream.destroyed)
      throw new Error(
        'Network journal stream closed before it could be flushed',
      );
    await new Promise<void>((resolve, reject) => {
      this.stream.write('', (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
    this.throwIfStreamFailed();
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return await this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      this.throwIfStreamFailed();
      if (this.stream.closed || this.stream.destroyed) {
        throw new Error(
          'Network journal stream closed before HAR finalization',
        );
      }
      const metadata: JournalMetadata | undefined =
        this.truncatedEvents === 0
          ? undefined
          : { type: 'metadata', truncatedEvents: this.truncatedEvents };
      this.stream.end(
        metadata === undefined ? undefined : `${JSON.stringify(metadata)}\n`,
      );
      try {
        await finished(this.stream);
      } catch (error) {
        if (error instanceof Error) this.streamError ??= error;
        throw error;
      }
      this.throwIfStreamFailed();
      finalizeHarFromJournal(this.outputPath);
    })();
    return await this.closePromise;
  }

  private throwIfStreamFailed(): void {
    if (this.streamError !== undefined) throw this.streamError;
  }
}

export function journalPathForHar(harPath: string): string {
  return `${harPath}.events.jsonl`;
}

/** Rebuild network.har from the crash-safe JSONL journal. */
export interface NetworkHarTraceSummary {
  entries: number;
  journalEvents: number;
  truncatedEvents: number;
}

export function finalizeHarFromJournal(
  harPath: string,
): NetworkHarTraceSummary {
  const journalPath = journalPathForHar(harPath);
  const text = readFileSync(journalPath, 'utf8');
  const events: JournalEvent[] = [];
  let truncatedEvents = 0;
  const lines = text.split(/\r?\n/);
  let finalContentLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() !== '') {
      finalContentLine = index;
      break;
    }
  }
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      // A forcefully terminated process may leave only its final write torn.
      if (index === finalContentLine) break;
      throw error;
    }
    if (isJournalMetadata(value)) {
      truncatedEvents += value.truncatedEvents;
      continue;
    }
    if (
      !isRecord(value) ||
      typeof value.recordedAt !== 'string' ||
      !isBridgeEvent(value.event)
    ) {
      throw new Error(`Invalid network journal entry at line ${index + 1}`);
    }
    events.push({ recordedAt: value.recordedAt, event: value.event });
  }
  const har = buildHar(events);
  writeHarAtomically(harPath, har);
  return {
    entries: har.log.entries.length,
    journalEvents: events.length,
    truncatedEvents,
  };
}

function isJournalMetadata(value: unknown): value is JournalMetadata {
  return (
    isRecord(value) &&
    value.type === 'metadata' &&
    typeof value.truncatedEvents === 'number' &&
    Number.isInteger(value.truncatedEvents) &&
    value.truncatedEvents >= 0
  );
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function buildHar(events: readonly JournalEvent[]): {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: Array<Record<string, unknown>>;
  };
} {
  const active = new Map<string, PendingEntry>();
  const completed: PendingEntry[] = [];
  const requestExtraHeaders = collectRequestExtraHeaders(events);
  const responseBodies = collectResponseBodies(events);
  const requestSequences = new Map<string, number>();
  let startedOrdinal = 0;
  let redirectSequence = 0;

  for (const item of events) {
    const event = item.event;
    const params = recordValue(event.params);
    const requestId =
      typeof params.requestId === 'string'
        ? params.requestId
        : String(params.requestId ?? '');
    if (requestId === '') continue;
    const baseKey = eventKey(event, requestId);

    if (event.method === 'Network.requestWillBeSent') {
      const requestSequence = requestSequences.get(baseKey) ?? 0;
      requestSequences.set(baseKey, requestSequence + 1);
      const prior = active.get(baseKey);
      const redirectResponse = recordValue(params.redirectResponse);
      if (prior !== undefined) {
        if (typeof redirectResponse.status === 'number') {
          prior.response = harResponse(redirectResponse);
          const finishedMonotonic = numberValue(params.timestamp);
          if (finishedMonotonic !== undefined)
            prior.finishedMonotonic = finishedMonotonic;
        }
        prior.key = `${prior.key}:redirect:${redirectSequence++}`;
        completed.push(prior);
      }
      const request = recordValue(params.request);
      const startedMonotonic = numberValue(params.timestamp);
      const extraHeaders = requestExtraHeaders.get(baseKey)?.[requestSequence];
      active.set(baseKey, {
        key: baseKey,
        requestId,
        tabId: event.tabId,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: event.sessionId }),
        startedOrdinal: startedOrdinal++,
        startedDateTime: wallTime(params.wallTime, item.recordedAt),
        ...(startedMonotonic === undefined ? {} : { startedMonotonic }),
        request: harRequest(request, extraHeaders),
        response: emptyHarResponse(),
      });
      continue;
    }

    const entry = active.get(baseKey);
    if (entry === undefined) continue;
    if (event.method === 'Network.responseReceived') {
      entry.response = harResponse(recordValue(params.response));
      const responseMonotonic = numberValue(params.timestamp);
      if (responseMonotonic !== undefined)
        entry.responseMonotonic = responseMonotonic;
    } else if (event.method === 'Network.loadingFinished') {
      const finishedMonotonic = numberValue(params.timestamp);
      if (finishedMonotonic !== undefined)
        entry.finishedMonotonic = finishedMonotonic;
      const response = entry.response as {
        content?: Record<string, unknown>;
        bodySize?: number;
      };
      const length = numberValue(params.encodedDataLength);
      if (length !== undefined) {
        response.bodySize = length;
        if (response.content !== undefined) response.content.size = length;
      }
      const body = responseBodies.get(baseKey);
      if (body !== undefined && response.content !== undefined) {
        response.content.text = body;
        response.content.size = Buffer.byteLength(body);
      }
      active.delete(baseKey);
      completed.push(entry);
    } else if (event.method === 'Network.loadingFailed') {
      const finishedMonotonic = numberValue(params.timestamp);
      if (finishedMonotonic !== undefined)
        entry.finishedMonotonic = finishedMonotonic;
      entry.failed =
        typeof params.errorText === 'string' ? params.errorText : 'failed';
      active.delete(baseKey);
      completed.push(entry);
    }
  }

  // A request that is still pending when capture stops is not a complete HAR
  // transaction. Keep its raw CDP events in the journal, but do not emit a
  // synthetic status-0 response that can be mistaken for a later navigation
  // by WebArena's evaluator. Requests with a received response remain useful
  // even if loadingFinished did not arrive before shutdown.
  completed.push(
    ...[...active.values()].filter(
      (entry) => entry.responseMonotonic !== undefined,
    ),
  );
  const entries = completed
    .filter(
      (entry) =>
        typeof entry.request.url === 'string' && entry.request.url !== '',
    )
    // loadingFinished/loadingFailed events can arrive in a different order
    // from requestWillBeSent. HAR entry order must remain chronological by
    // request start because consumers such as WebArena's last_event_only use
    // the final matching entry as the latest request.
    .sort((left, right) => left.startedOrdinal - right.startedOrdinal)
    .map((entry) => toHarEntry(entry));
  return {
    log: {
      version: '1.2',
      creator: { name: 'qwen-browser-use', version: '0.1.0' },
      entries,
    },
  };
}

function toHarEntry(entry: PendingEntry): Record<string, unknown> {
  // A received response remains useful when capture stops before
  // loadingFinished. In that case the known response time is the best lower
  // bound for the total; reporting total=0 and wait>0 produces invalid HAR.
  const totalMs = durationMs(
    entry.startedMonotonic,
    entry.finishedMonotonic ?? entry.responseMonotonic,
  );
  const waitMs = durationMs(entry.startedMonotonic, entry.responseMonotonic);
  const receiveMs = durationMs(
    entry.responseMonotonic,
    entry.finishedMonotonic,
  );
  return {
    startedDateTime: entry.startedDateTime,
    time: totalMs,
    request: entry.request,
    response: entry.response,
    cache: {},
    timings: { send: 0, wait: waitMs, receive: receiveMs },
    _qwenBrowser: {
      requestId: entry.requestId,
      tabId: entry.tabId,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.failed === undefined ? {} : { failure: entry.failed }),
    },
  };
}

function harRequest(
  request: Record<string, unknown>,
  extraHeaders?: Record<string, unknown>,
): Record<string, unknown> {
  const url = typeof request.url === 'string' ? request.url : '';
  const headers = headersArray(
    recordValue(request.headers),
    extraHeaders ?? {},
  );
  const postDataText =
    typeof request.postData === 'string' ? request.postData : undefined;
  const mimeType =
    headerValue(headers, 'content-type') ?? 'application/octet-stream';
  return {
    method: typeof request.method === 'string' ? request.method : 'GET',
    url,
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers,
    queryString: queryString(url),
    headersSize: -1,
    bodySize: postDataText === undefined ? -1 : Buffer.byteLength(postDataText),
    ...(postDataText === undefined
      ? {}
      : { postData: { mimeType, text: postDataText } }),
  };
}

function harResponse(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const headers = headersArray(recordValue(response.headers));
  const encodedLength = numberValue(response.encodedDataLength) ?? -1;
  return {
    status: numberValue(response.status) ?? 0,
    statusText:
      typeof response.statusText === 'string' ? response.statusText : '',
    httpVersion: protocolToHttpVersion(response.protocol),
    cookies: [],
    headers,
    content: {
      size: encodedLength,
      mimeType:
        typeof response.mimeType === 'string'
          ? response.mimeType
          : (headerValue(headers, 'content-type') ??
            'application/octet-stream'),
    },
    redirectURL: headerValue(headers, 'location') ?? '',
    headersSize: -1,
    bodySize: encodedLength,
  };
}

function emptyHarResponse(): Record<string, unknown> {
  return {
    status: 0,
    statusText: '',
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: [],
    content: { size: -1, mimeType: 'application/octet-stream' },
    redirectURL: '',
    headersSize: -1,
    bodySize: -1,
  };
}

function headersArray(
  ...sources: Array<Record<string, unknown>>
): Array<{ name: string; value: string }> {
  const headers = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      headers.set(name.toLowerCase(), {
        name,
        value: SENSITIVE_HEADER_PATTERN.test(name)
          ? '[REDACTED]'
          : headerText(value),
      });
    }
  }
  return [...headers.values()];
}

/**
 * ExtraInfo and requestWillBeSent are not ordered relative to each other.
 * Redirects also reuse a request id, so associate both event streams by
 * occurrence number within the same tab/session/request tuple.
 */
function collectRequestExtraHeaders(
  events: readonly JournalEvent[],
): Map<string, Array<Record<string, unknown>>> {
  const result = new Map<string, Array<Record<string, unknown>>>();
  for (const item of events) {
    const event = item.event;
    if (event.method !== 'Network.requestWillBeSentExtraInfo') continue;
    const params = recordValue(event.params);
    const requestId =
      typeof params.requestId === 'string'
        ? params.requestId
        : String(params.requestId ?? '');
    if (requestId === '') continue;
    const key = eventKey(event, requestId);
    const headers = result.get(key) ?? [];
    headers.push(recordValue(params.headers));
    result.set(key, headers);
  }
  return result;
}

function collectResponseBodies(
  events: readonly JournalEvent[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of events) {
    const event = item.event;
    if (event.method !== 'qwenBrowser.responseBody') continue;
    const params = recordValue(event.params);
    const requestId =
      typeof params.requestId === 'string' ? params.requestId : '';
    if (requestId === '' || typeof params.text !== 'string') continue;
    result.set(eventKey(event, requestId), params.text);
  }
  return result;
}

function headerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function headerValue(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function queryString(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

function protocolToHttpVersion(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'HTTP/1.1';
  if (value === 'h2') return 'HTTP/2.0';
  if (value === 'h3') return 'HTTP/3.0';
  return value.toUpperCase().startsWith('HTTP/') ? value.toUpperCase() : value;
}

function eventKey(event: BridgeEvent, requestId: string): string {
  return `${event.tabId}:${event.sessionId ?? 'root'}:${requestId}`;
}

function wallTime(value: unknown, fallback: string): string {
  const seconds = numberValue(value);
  if (seconds === undefined) return fallback;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function durationMs(
  start: number | undefined,
  end: number | undefined,
): number {
  if (start === undefined || end === undefined || end < start) return 0;
  return Math.round((end - start) * 1_000 * 1_000) / 1_000;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
  return (
    isRecord(value) &&
    value.type === 'event' &&
    typeof value.tabId === 'number' &&
    typeof value.method === 'string' &&
    'params' in value
  );
}

function writeHarAtomically(
  path: string,
  value: ReturnType<typeof buildHar>,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}
