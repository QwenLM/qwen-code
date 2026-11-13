/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';

it('keeps the JSON parser alive after trailing compressed data', async () => {
  const parserUrl = new URL('./error-handlers.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import express from 'express';
       import { installJsonBodyParser } from ${JSON.stringify(parserUrl)};
       const app = express();
       installJsonBodyParser(app);
       app.get('/health', (_req, res) => res.sendStatus(200));
       app.post('/echo', (req, res) => res.json(req.body));
       const server = app.listen(0, '127.0.0.1', () => {
         console.log(server.address().port);
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (data) => (stderr += data));
  const exited = once(child, 'exit');
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data).trim()),
      exited.then(() => {
        throw new Error(`Parser process exited before listening: ${stderr}`);
      }),
      setTimeout(10_000, undefined, { ref: false }).then(() => {
        throw new Error(`Parser startup timed out: ${stderr}`);
      }),
    ]);
    const origin = `http://127.0.0.1:${Number(ready)}`;
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    const body = Buffer.concat([
      gzipSync(Buffer.from('{"safe":true}')),
      Buffer.from([0]),
      Buffer.alloc(100 * 1024, 0x58),
    ]);
    await new Promise<void>((resolve) => {
      const req = http.request(
        `${origin}/echo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': body.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', () => resolve());
        },
      );
      req.setTimeout(3_000, () => req.destroy());
      req.on('error', () => resolve());
      req.end(body);
    });
    await setTimeout(200);
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    const healthy = await fetch(`${origin}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"safe":true}',
    });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ safe: true });
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, setTimeout(3_000, undefined, { ref: false })]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}, 15_000);
