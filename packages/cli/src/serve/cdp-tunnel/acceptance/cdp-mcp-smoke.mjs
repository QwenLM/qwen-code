/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C layer-C verification (issue #5626): drive the PATCHED chrome-devtools-mcp
 * over the daemon `/cdp` tunnel. Spawns cdp-mcp pointed at the tunnel, runs MCP
 * initialize + tools/list + tools/call list_pages — proving the ready-made
 * DevTools toolset operates the real browser through the tunnel.
 *
 * Prereqs: same as real-tab.mjs (daemon with the tunnel on + extension loaded +
 * its service worker awake). Run:
 *   node packages/cli/src/serve/cdp-tunnel/acceptance/cdp-mcp-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ENDPOINT = process.env.WS || `ws://127.0.0.1:${process.env.PORT || 4170}/cdp`;
const pkgPath = require.resolve('chrome-devtools-mcp/package.json');
const pkg = require('chrome-devtools-mcp/package.json');
const dir = pkgPath.slice(0, -'package.json'.length);
const binRel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
const binPath = dir + binRel.replace(/^\.\//, '');

const mcp = spawn('node', [binPath, '--wsEndpoint', ENDPOINT], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
mcp.stderr.on('data', (d) => (stderr += d));

let buf = '';
const got = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) try { const m = JSON.parse(line); if (m.id != null) got.set(m.id, m); } catch { /* non-json log */ }
  }
});
const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
const wait = async (id, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (got.has(id)) return got.get(id);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting id=${id}; stderr tail: ${stderr.slice(-300)}`);
};

const out = { tools: 0, listPages: null, error: null };
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cdp-mcp-smoke', version: '1' } } });
  await wait(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tl = await wait(2);
  out.tools = (tl.result?.tools || []).length;

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } });
  const lp = await wait(3);
  out.listPages = JSON.stringify(lp.result ?? lp.error).slice(0, 240);
} catch (e) {
  out.error = e.message;
}
mcp.kill('SIGTERM');

console.log('\n=== LAYER C: chrome-devtools-mcp over /cdp ===');
console.log(JSON.stringify(out, null, 2));
console.log('\nC-LAYER:', out.tools >= 20 && out.listPages && !out.error ? 'PASS — cdp-mcp full toolset drives the real browser via the tunnel' : `FAIL${out.error ? ' — ' + out.error : ''}`);
process.exit(0);
