/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared state and utilities for content script modules
 */

// Capture recent fetch/XHR responses for targeted debugging
const capturedResponses: Array<{
  source: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
}> = [];
const MAX_CAPTURED = 100;
const MAX_BODY_CHARS = 200000; // 200 KB text cap

/**
 * Record a captured response
 */
function recordCapturedResponse(entry: {
  source: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
}): void {
  capturedResponses.push(entry);
  if (capturedResponses.length > MAX_CAPTURED) {
    capturedResponses.splice(0, capturedResponses.length - MAX_CAPTURED);
  }
}

/**
 * Sanitize headers from various formats to plain object
 */
function sanitizeHeaders(
  headersLike:
    | Headers
    | Array<[string, string]>
    | Record<string, string>
    | null
    | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    // headersLike can be Headers, array of [k,v], or plain object
    if (headersLike && typeof headersLike.forEach === 'function') {
      headersLike.forEach((v, k) => {
        result[String(k)] = String(v);
      });
    } else if (Array.isArray(headersLike)) {
      headersLike.forEach(([k, v]) => {
        if (k) result[String(k)] = String(v);
      });
    } else if (headersLike && typeof headersLike === 'object') {
      Object.entries(headersLike).forEach(([k, v]) => {
        result[String(k)] = String(v);
      });
    }
  } catch {
    // best-effort
  }
  return result;
}

/**
 * Get captured responses
 */
function getCapturedResponses(options?: {
  urlSubstring?: string;
  limit?: number;
}): typeof capturedResponses {
  const { urlSubstring, limit } = options || {};
  const max = typeof limit === 'number' && limit > 0 ? limit : 50;
  const filtered = capturedResponses.filter((r) => {
    if (!urlSubstring) return true;
    return String(r.url || '').includes(urlSubstring);
  });
  return filtered.slice(-max);
}

export {
  capturedResponses,
  recordCapturedResponse,
  sanitizeHeaders,
  getCapturedResponses,
  MAX_CAPTURED,
  MAX_BODY_CHARS,
};
