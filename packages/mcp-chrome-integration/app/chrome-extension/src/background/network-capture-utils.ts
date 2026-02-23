/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const STATIC_TYPES = new Set([
  'image',
  'stylesheet',
  'script',
  'font',
  'media',
  'object',
]);

export const DEFAULT_BODY_CHAR_LIMIT = 10000;

export type RequestBody = {
  formData?: Record<string, string[]>;
  raw?: string;
  rawEncoding?: 'utf-8' | 'base64';
};

export type RawNetworkRequest = {
  requestId?: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  requestBody?: RequestBody;
  timestamp?: number;
  type?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  responseBody?: string;
  responseBodyEncoding?: 'utf-8' | 'base64';
  responseBodySource?: 'debugger' | 'content-script';
  bodyTruncated?: boolean;
  error?: string;
  source?: {
    request?: 'webRequest' | 'debugger';
    response?: 'webRequest' | 'debugger';
    body?: 'debugger' | 'content-script';
  };
};

export type WebSocketFrame = {
  direction: 'sent' | 'received';
  opcode?: number;
  payload?: string;
  payloadEncoding?: 'text' | 'base64';
  truncated?: boolean;
  timestamp?: number;
};

export type WebSocketSession = {
  requestId: string;
  url: string;
  createdAt?: number;
  closedAt?: number;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  frames: WebSocketFrame[];
  error?: string;
};

export type StandardizedNetworkRequest = {
  id?: string;
  url: string;
  method: string;
  type?: string;
  timestamp?: number;
  request?: {
    headers?: Record<string, string>;
    body?: RequestBody;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    mimeType?: string;
    body?: {
      text?: string;
      encoding?: 'utf-8' | 'base64';
      truncated?: boolean;
      source?: 'debugger' | 'content-script';
    };
  };
  error?: string;
  source?: RawNetworkRequest['source'];
};

export type StandardizedWebSocketSession = {
  requestId: string;
  url: string;
  createdAt?: number;
  closedAt?: number;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  frames: WebSocketFrame[];
  error?: string;
};

export type StandardizedNetworkCapture = {
  version: '1.0';
  tabId?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  durationMs?: number | null;
  includeStatic?: boolean;
  needResponseBody?: boolean;
  requests: StandardizedNetworkRequest[];
  websockets: StandardizedWebSocketSession[];
  stats: {
    requestCount: number;
    websocketCount: number;
    responseBodyCount: number;
    responseBodyTruncatedCount: number;
    errorCount: number;
  };
};

function shouldInclude(
  details: { type?: string } | null | undefined,
  includeStatic: boolean,
) {
  if (includeStatic) return true;
  const type = String(details?.type || '').toLowerCase();
  if (!type) return true;
  return !STATIC_TYPES.has(type);
}

function normalizeHeaders(
  headers:
    | Array<{ name?: string; value?: string; key?: string }>
    | Record<string, string>
    | null
    | undefined,
) {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (!header) continue;
      if (Array.isArray(header)) {
        const [name, value] = header;
        if (!name) continue;
        result[String(name).toLowerCase()] = String(value ?? '');
        continue;
      }
      const name =
        (header as { name?: string; key?: string }).name ??
        (header as { key?: string }).key;
      const value = (header as { value?: string }).value;
      if (!name) continue;
      result[String(name).toLowerCase()] = String(value ?? '');
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      result[String(name).toLowerCase()] = String(value ?? '');
    }
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeRequestBody(requestBody: any): RequestBody | undefined {
  if (!requestBody) return undefined;

  if (requestBody.formData) {
    const formData = {};
    for (const [key, values] of Object.entries(requestBody.formData)) {
      if (Array.isArray(values)) {
        formData[key] = values.map((value) => String(value));
      } else if (values !== undefined) {
        formData[key] = [String(values)];
      }
    }
    return { formData };
  }

  if (Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
    const raw = requestBody.raw[0]?.bytes;
    if (raw) {
      try {
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(raw);
        return { raw: text, rawEncoding: 'utf-8' };
      } catch {
        try {
          const bytes = new Uint8Array(raw);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i += 1) {
            binary += String.fromCharCode(bytes[i]);
          }
          return { raw: btoa(binary), rawEncoding: 'base64' };
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

export function createWebRequestRecorder({ includeStatic = false } = {}) {
  const requests = new Map<string, RawNetworkRequest>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ensureEntry(details: any): RawNetworkRequest | null {
    if (!details || !details.requestId) return null;
    if (!shouldInclude(details, includeStatic)) return null;

    if (!requests.has(details.requestId)) {
      requests.set(details.requestId, {
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        timestamp: details.timeStamp,
        type: details.type,
      });
    }

    return requests.get(details.requestId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recordBeforeRequest(details: any) {
    const entry = ensureEntry(details);
    if (!entry) return;
    const requestBody = normalizeRequestBody(details.requestBody);
    if (requestBody) {
      entry.requestBody = requestBody;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recordBeforeSendHeaders(details: any) {
    const entry = ensureEntry(details);
    if (!entry) return;
    entry.headers = normalizeHeaders(details.requestHeaders);
    entry.source = {
      ...(entry.source || {}),
      request: 'webRequest',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recordCompleted(details: any) {
    const entry = ensureEntry(details);
    if (!entry) return;
    entry.status = details.statusCode;
    entry.statusText = details.statusLine;
    entry.responseHeaders = normalizeHeaders(details.responseHeaders);
    entry.mimeType = entry.responseHeaders?.['content-type'];
    entry.source = {
      ...(entry.source || {}),
      response: 'webRequest',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recordError(details: any) {
    const entry = ensureEntry(details);
    if (!entry) return;
    entry.error = details.error || 'unknown error';
  }

  function getRequests(): RawNetworkRequest[] {
    return Array.from(requests.values());
  }

  return {
    recordBeforeRequest,
    recordBeforeSendHeaders,
    recordCompleted,
    recordError,
    getRequests,
  };
}

export function mergeCapturedResponses(
  requests: RawNetworkRequest[],
  capturedResponses: Array<{
    url?: string;
    method?: string;
    body?: string;
    status?: number;
    headers?: Record<string, string>;
  }>,
) {
  if (!Array.isArray(requests) || !Array.isArray(capturedResponses))
    return requests;

  const index = new Map();
  for (const req of requests) {
    const key = `${String(req.method || 'GET').toUpperCase()} ${req.url}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(req);
  }

  for (const captured of capturedResponses) {
    const key = `${String(captured.method || 'GET').toUpperCase()} ${captured.url}`;
    const matches = index.get(key);
    if (!matches || matches.length === 0) continue;
    const target = matches[matches.length - 1];
    if (!target.responseBody && captured.body) {
      target.responseBody = captured.body;
      target.responseBodySource = 'content-script';
      target.source = { ...(target.source || {}), body: 'content-script' };
    }
    if (!target.status && captured.status) {
      target.status = captured.status;
    }
    if (!target.responseHeaders && captured.headers) {
      target.responseHeaders = captured.headers;
    }
  }

  return requests;
}

export function mergeDebuggerRequests(
  requests: RawNetworkRequest[],
  debuggerEntries: RawNetworkRequest[],
) {
  if (!Array.isArray(requests) || !Array.isArray(debuggerEntries))
    return requests;

  const index = new Map<string, RawNetworkRequest[]>();
  for (const req of requests) {
    const key = `${String(req.method || 'GET').toUpperCase()} ${req.url}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(req);
  }

  for (const dbg of debuggerEntries) {
    const key = `${String(dbg.method || 'GET').toUpperCase()} ${dbg.url}`;
    const matches = index.get(key);
    if (!matches || matches.length === 0) {
      requests.push({
        ...dbg,
        source: {
          ...(dbg.source || {}),
          request: 'debugger',
          response: dbg.responseBody ? 'debugger' : dbg.source?.response,
        },
      });
      continue;
    }
    const target = matches[matches.length - 1];
    if (!target.requestBody && dbg.requestBody) {
      target.requestBody = dbg.requestBody;
    }
    if (!target.status && dbg.status) {
      target.status = dbg.status;
      target.statusText = dbg.statusText;
      target.source = { ...(target.source || {}), response: 'debugger' };
    }
    if (!target.responseHeaders && dbg.responseHeaders) {
      target.responseHeaders = dbg.responseHeaders;
    }
    if (!target.mimeType && dbg.mimeType) {
      target.mimeType = dbg.mimeType;
    }
    if (!target.responseBody && dbg.responseBody) {
      target.responseBody = dbg.responseBody;
      target.responseBodyEncoding = dbg.responseBodyEncoding;
      target.bodyTruncated = dbg.bodyTruncated;
      target.responseBodySource = 'debugger';
      target.source = { ...(target.source || {}), body: 'debugger' };
    }
  }

  return requests;
}

export function truncateBody(
  value: string | undefined,
  limit = DEFAULT_BODY_CHAR_LIMIT,
) {
  if (!value) return { text: value, truncated: false };
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

export function standardizeNetworkCapture({
  tabId,
  startedAt,
  endedAt,
  includeStatic,
  needResponseBody,
  requests,
  websockets,
  bodyCharLimit = DEFAULT_BODY_CHAR_LIMIT,
}: {
  tabId?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  includeStatic?: boolean;
  needResponseBody?: boolean;
  requests: RawNetworkRequest[];
  websockets?: WebSocketSession[];
  bodyCharLimit?: number;
}): StandardizedNetworkCapture {
  const normalizedRequests = (requests || []).map((entry) => {
    const hasResponseBody = entry.responseBody !== undefined;
    const responseBody = hasResponseBody
      ? truncateBody(entry.responseBody, bodyCharLimit)
      : { text: undefined, truncated: false };

    const body = hasResponseBody
      ? {
          text: responseBody.text,
          encoding: entry.responseBodyEncoding,
          truncated: entry.bodyTruncated || responseBody.truncated,
          source: entry.responseBodySource,
        }
      : undefined;

    return {
      id: entry.requestId,
      url: entry.url,
      method: entry.method,
      type: entry.type,
      timestamp: entry.timestamp,
      request: {
        headers: entry.headers,
        body: entry.requestBody,
      },
      response: {
        status: entry.status,
        statusText: entry.statusText,
        headers: entry.responseHeaders,
        mimeType: entry.mimeType,
        body,
      },
      error: entry.error,
      source: entry.source,
    } satisfies StandardizedNetworkRequest;
  });

  const normalizedWebSockets = (websockets || []).map((session) => {
    const frames = (session.frames || []).map((frame) => {
      if (frame.payload === undefined) return frame;
      const truncated = truncateBody(frame.payload, bodyCharLimit);
      return {
        ...frame,
        payload: truncated.text,
        truncated: frame.truncated || truncated.truncated,
      };
    });
    return {
      requestId: session.requestId,
      url: session.url,
      createdAt: session.createdAt,
      closedAt: session.closedAt,
      status: session.status,
      statusText: session.statusText,
      requestHeaders: session.requestHeaders,
      responseHeaders: session.responseHeaders,
      frames,
      error: session.error,
    } satisfies StandardizedWebSocketSession;
  });

  const responseBodyCount = normalizedRequests.filter(
    (entry) => entry.response?.body?.text !== undefined,
  ).length;
  const responseBodyTruncatedCount = normalizedRequests.filter(
    (entry) => entry.response?.body?.truncated,
  ).length;
  const errorCount = normalizedRequests.filter((entry) => entry.error).length;

  return {
    version: '1.0',
    tabId,
    startedAt,
    endedAt,
    durationMs:
      startedAt !== null &&
      startedAt !== undefined &&
      endedAt !== null &&
      endedAt !== undefined
        ? Math.max(0, endedAt - startedAt)
        : null,
    includeStatic,
    needResponseBody,
    requests: normalizedRequests,
    websockets: normalizedWebSockets,
    stats: {
      requestCount: normalizedRequests.length,
      websocketCount: normalizedWebSockets.length,
      responseBodyCount,
      responseBodyTruncatedCount,
      errorCount,
    },
  };
}
