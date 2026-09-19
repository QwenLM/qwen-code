/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';

const [port, pidFile, trafficFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.end('ready');
    return;
  }
  appendFileSync(trafficFile, `${req.url}\n`);
  const upstream = http.request(
    req.url,
    { method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
server.on('connect', (req, socket, head) => {
  appendFileSync(trafficFile, `CONNECT ${req.url}\n`);
  const target = new URL(`http://${req.url}`);
  const upstream = net.connect(
    Number(target.port || 80),
    target.hostname,
    () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    },
  );
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(Number(port), '127.0.0.1', () => {
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid }));
});
