/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Qwen Code Web Shell — Service Worker
 *
 * Strategy:
 *   - Shell assets (JS/CSS/fonts built by Vite under /assets/): cache-first,
 *     versioned by the cache name which includes the build hash.
 *   - Manifest and icons: stale-while-revalidate.
 *   - ALL daemon API routes (everything else): network-only, never cached.
 *     The daemon owns session state, SSE streams, and bearer-token auth;
 *     intercepting those requests would break the connection model.
 *
 * The service worker deliberately does NOT:
 *   - Intercept /session, /events, /permission, /health, /capabilities, etc.
 *   - Cache any response that carries an Authorization header in the request.
 *   - Pre-cache anything at install time (avoids stale-cache on first load).
 *
 * Cache naming: CACHE_NAME includes a build-time version injected by Vite at
 * build time via __WEB_SHELL_VERSION__. In dev mode this constant may be
 * undefined; fall back to 'dev'.
 */

/* global __WEB_SHELL_VERSION__ */
/* global self, caches, URL, fetch */

'use strict';

// Injected at build time by Vite (define: { __WEB_SHELL_VERSION__ }).
// In dev, the SW is typically not registered, but guard anyway.
var VERSION =
  typeof __WEB_SHELL_VERSION__ !== 'undefined' ? __WEB_SHELL_VERSION__ : 'dev';
var SHELL_CACHE = 'qwen-code-shell-v1-' + VERSION;

/**
 * Returns true if this fetch should bypass the service worker entirely and
 * go straight to the network. We bypass:
 *   1. Non-GET requests (POST/PUT/DELETE — daemon mutations).
 *   2. Requests with an Authorization header (authenticated daemon API calls).
 *   3. Any URL path that matches a known daemon route prefix.
 *   4. SSE event streams (accept: text/event-stream).
 *   5. WebSocket upgrades (handled natively by the browser, not via fetch).
 *
 * Only Vite-built shell assets under /assets/ and the manifest are cached.
 */
function shouldBypassCache(request) {
  if (request.method !== 'GET') return true;
  if (request.headers.get('Authorization')) return true;

  // Daemon API route prefixes — from packages/web-shell/vite.config.ts proxy list.
  var DAEMON_PREFIXES = [
    '/health',
    '/capabilities',
    '/brand',
    '/session',
    '/permission',
    '/workspace',
    '/file',
    '/stat',
    '/list',
    '/glob',
    '/standalone',
    '/scheduled-tasks',
    '/goals',
    '/usage',
    '/live',
    '/voice',
    '/terminal',
    '/acp',
    '/daemon',
    '/mcp-app-sandbox',
    '/extensions',
  ];

  var url = new URL(request.url);
  // Only apply to same-origin requests (daemon served from same host).
  if (url.origin !== self.location.origin) return true;

  var path = url.pathname;
  for (var i = 0; i < DAEMON_PREFIXES.length; i++) {
    if (
      path === DAEMON_PREFIXES[i] ||
      path.startsWith(DAEMON_PREFIXES[i] + '/')
    ) {
      return true;
    }
  }

  // SSE streams.
  if (request.headers.get('Accept') === 'text/event-stream') return true;

  return false;
}

/**
 * Returns true if this is a Vite-built shell asset that should be cached.
 * Vite outputs all built files under /assets/ with content-hash filenames,
 * so these are safe to cache indefinitely (version bump = new cache name).
 */
function isShellAsset(url) {
  var path = new URL(url).pathname;
  return path.startsWith('/assets/') || path === '/manifest.webmanifest';
}

// ---------------------------------------------------------------------------
// Install: skip waiting so the new SW takes over immediately.
// We do NOT pre-cache anything — the shell assets are large and the cache
// is populated on first use (fetch below).
// ---------------------------------------------------------------------------
self.addEventListener('install', function () {
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate: claim all clients so the SW starts handling fetches right away,
// then evict caches from previous versions.
// ---------------------------------------------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    self.clients.claim().then(function () {
      return caches.keys().then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              // Delete caches for older versions of this shell.
              return key.startsWith('qwen-code-shell-') && key !== SHELL_CACHE;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// Fetch: cache-first for shell assets; network-only for everything else.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Always pass daemon API routes and non-GET requests straight through.
  if (shouldBypassCache(request)) return;

  // For shell assets: cache-first, populate on miss.
  if (isShellAsset(request.url)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            // Only cache successful, opaque-safe responses.
            if (
              response &&
              response.status === 200 &&
              response.type === 'basic'
            ) {
              cache.put(request, response.clone());
            }
            return response;
          });
        });
      }),
    );
    return;
  }

  // Navigation requests (HTML document): network-first, fall back to cache.
  // This ensures the latest index.html is always served when online.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(request);
      }),
    );
    return;
  }

  // Everything else: network-only (no interception).
});

// ---------------------------------------------------------------------------
// Push notifications (Phase 2 prerequisite — registered but not yet wired).
// The native Android shell will trigger notifications via its ForegroundService
// rather than Web Push for now, but registering the handler here means a
// future daemon-side push implementation requires no SW update.
// ---------------------------------------------------------------------------
self.addEventListener('push', function (event) {
  if (!event.data) return;
  var data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Qwen Code', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Qwen Code', {
      body: data.body || '',
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: data,
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Focus an existing window if one is open.
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) return client.focus();
        }
        // Otherwise open a new window at the app root.
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
      }),
  );
});
