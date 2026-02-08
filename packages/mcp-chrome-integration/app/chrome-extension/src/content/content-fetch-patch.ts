/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fetch/XHR interception module for Qwen CLI Chrome Extension
 * Captures network responses for targeted debugging
 */

import {
  recordCapturedResponse,
  sanitizeHeaders,
  MAX_BODY_CHARS,
} from './content-shared.js';

// Patch fetch
if (typeof window.fetch === 'function') {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const started = Date.now();
    try {
      const res = await originalFetch(...args);
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req?.url;
        const init = args[1] || {};
        const method = (init.method || 'GET').toUpperCase();
        const status = res.status;
        const headers = sanitizeHeaders(res.headers);
        let body = null;
        try {
          const clone = res.clone();
          body = await clone.text();
          if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
            body = body.slice(0, MAX_BODY_CHARS) + '...';
          }
        } catch (e) {
          body = `error: ${e?.message || e}`;
        }
        recordCapturedResponse({
          source: 'fetch',
          url,
          method,
          status,
          headers,
          body,
          timestamp: started,
        });
      } catch {
        // best-effort capture; ignore capture errors
      }
      return res;
    } catch (err) {
      // Capture error case too
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req?.url;
        const init = args[1] || {};
        const method = (init.method || 'GET').toUpperCase();
        recordCapturedResponse({
          source: 'fetch',
          url,
          method,
          status: 0,
          headers: {},
          body: `error: ${err?.message || err}`,
          timestamp: started,
        });
      } catch {
        /* ignore */
      }
      throw err;
    }
  };
}

// Patch XHR
if (typeof window.XMLHttpRequest === 'function') {
  const OriginalXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    const xhr = new OriginalXHR();
    let url = '';
    let method = 'GET';
    xhr.addEventListener('loadend', () => {
      try {
        const status = xhr.status;
        const headers: Record<string, string> = {};
        const raw = xhr.getAllResponseHeaders();
        if (raw) {
          raw
            .trim()
            .split(/\r?\n/)
            .forEach((line) => {
              const idx = line.indexOf(':');
              if (idx > 0) {
                const k = line.slice(0, idx).trim();
                const v = line.slice(idx + 1).trim();
                if (k) headers[k] = v;
              }
            });
        }
        let body = xhr.responseText;
        if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
          body = body.slice(0, MAX_BODY_CHARS) + '...';
        }
        recordCapturedResponse({
          source: 'xhr',
          url,
          method,
          status,
          headers,
          body,
          timestamp: Date.now(),
        });
      } catch {
        // ignore capture errors
      }
    });
    const origOpen = xhr.open;
    xhr.open = function patchedOpen(
      m: string,
      u: string | URL | null,
      ...rest: unknown[]
    ) {
      method = (m || 'GET').toUpperCase();
      url = typeof u === 'string' ? u : u?.toString() || '';
      return origOpen.call(this, m, u, ...rest);
    };
    const origSend = xhr.send;
    xhr.send = function patchedSend(body: unknown) {
      return origSend.call(this, body);
    };
    return xhr;
  }
  window.XMLHttpRequest = WrappedXHR;
}
