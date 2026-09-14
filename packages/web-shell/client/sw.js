/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cache-first for same-origin build assets. Manifest, daemon API requests,
 * authenticated requests and event streams remain network-only. HTML is
 * never cached: an unavailable daemon gets a retry page, not a stale session.
 */

/* global __WEB_SHELL_VERSION__, self, caches, URL, fetch, Response */

var VERSION =
  typeof __WEB_SHELL_VERSION__ !== 'undefined' ? __WEB_SHELL_VERSION__ : 'dev';
var SHELL_CACHE = 'qwen-code-shell-v1-' + VERSION;

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key.startsWith('qwen-code-shell-') && key !== SHELL_CACHE;
          })
          .map(function (key) {
            return caches.delete(key);
          }),
      ).then(function () {
        return self.clients.claim();
      });
    }),
  );
});

async function readAsset(request, event) {
  var cache;
  try {
    cache = await caches.open(SHELL_CACHE);
    var cached = await cache.match(request);
    if (cached) return cached;
  } catch {
    // A disabled or full browser cache must not prevent loading the UI.
  }
  var response = await fetch(request);
  if (cache && response.status === 200 && response.type === 'basic') {
    event.waitUntil(cache.put(request, response.clone()).catch(function () {}));
  }
  return response;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.headers.has('Authorization') ||
    (request.headers.get('Accept') || '').includes('text/event-stream') ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Only content-addressed build chunks can safely outlive a deployment.
  // Any future unhashed file under /assets stays on the network by default.
  if (
    url.pathname.startsWith('/assets/') &&
    /-[a-zA-Z0-9_-]{8,}\.[^/]+$/.test(url.pathname)
  ) {
    event.respondWith(readAsset(request, event));
    return;
  }

  if (
    request.mode === 'navigate' &&
    (request.destination === 'document' || !request.destination)
  ) {
    event.respondWith(
      fetch(request).catch(function () {
        return new Response(
          '<!doctype html><html lang="en"><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Qwen Code unavailable</title><body>' +
            '<h1>Cannot reach Qwen Code / <span lang="zh-CN">无法连接 Qwen Code</span></h1>' +
            '<p>Reconnect to the daemon, then reload this page. / ' +
            '<span lang="zh-CN">请重新连接守护进程，然后重新加载此页面。</span></p>' +
            '<a href="">Try again / <span lang="zh-CN">重试</span></a></body></html>',
          {
            status: 503,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          },
        );
      }),
    );
  }
});
