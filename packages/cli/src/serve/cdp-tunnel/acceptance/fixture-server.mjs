/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';

const port = Number(process.env.FIXTURE_PORT || 4180);
const page = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Qwen CDP Fixture</title></head>
  <body>
    <h1>Qwen CDP Fixture</h1>
    <button id="action">Run fixture action</button>
    <a id="target-link" href="/target">Open fixture target</a>
    <p id="status">idle</p>
    <script>
      console.log('qwen-fixture-ready');
      fetch('/api/ready');
      document.querySelector('#action').addEventListener('click', async () => {
        console.log('qwen-fixture-clicked');
        const response = await fetch('/api/click');
        document.querySelector('#status').textContent = await response.text();
      });
    </script>
  </body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === '/api/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ready":true}');
    return;
  }
  if (request.url === '/api/click') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('clicked');
    return;
  }
  if (request.url === '/target') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>Qwen CDP Target</title><h1>Target reached</h1>',
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture listening on http://127.0.0.1:${port}`);
});
