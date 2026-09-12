/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* global self, URL, fetch, Response */

const offlinePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connection unavailable · Qwen Code</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.5rem; }
    p { line-height: 1.6; }
    button { margin-top: 1rem; padding: 0.75rem 1.25rem; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Connection unavailable</h1>
    <p>Qwen Code needs a connection to your running server. Check your network and that the server is running, then try again.</p>
    <p lang="zh-CN">连接不可用。请检查网络并确认服务器正在运行，然后重试。</p>
    <button id="retry" type="button">Try again / 重试</button>
  </main>
  <script>document.getElementById('retry').addEventListener('click', () => location.reload());</script>
</body>
</html>`;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.mode !== 'navigate' ||
    request.destination !== 'document' ||
    url.origin !== self.location.origin ||
    !(url.pathname === '/' || /^\/session\/[^/]+\/?$/i.test(url.pathname))
  ) {
    return;
  }

  // Do not cache operator data or mask HTTP authentication/server errors.
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(offlinePage, {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'sha256-iLjpQ0/ib5tGKuH9P3muAayt4wAsXMZs1k99Rm4TBrs='; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        }),
    ),
  );
});
