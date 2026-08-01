/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C layer-C verification (issue #5626): drive an external CDP MCP adapter
 * over the daemon `/cdp` tunnel. Spawns the adapter pointed at the tunnel, runs MCP
 * initialize + tools/list + tools/call list_pages — proving the ready-made
 * DevTools toolset operates the real browser through the tunnel.
 *
 * Prereqs: same as real-tab.mjs (daemon with the tunnel on + extension loaded +
 * its service worker awake), plus QWEN_CDP_MCP_COMMAND set to an adapter binary.
 * Run:
 *   QWEN_CDP_MCP_COMMAND=/path/to/adapter \
 *     node packages/cli/src/serve/cdp-tunnel/acceptance/cdp-mcp-smoke.mjs
 */
import { spawn } from 'node:child_process';

const ENDPOINT =
  process.env.WS || `ws://127.0.0.1:${process.env.PORT || 4170}/cdp`;
const command = process.env.QWEN_CDP_MCP_COMMAND;
if (!command) {
  console.error(
    'Set QWEN_CDP_MCP_COMMAND to an external CDP MCP adapter binary.',
  );
  process.exit(2);
}

const mcp = spawn(command, ['--wsEndpoint', ENDPOINT], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
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
    if (line)
      try {
        const m = JSON.parse(line);
        if (m.id != null) got.set(m.id, m);
      } catch {
        /* non-json log */
      }
  }
});
const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
const wait = async (id, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (got.has(id)) return got.get(id);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `timeout waiting id=${id}; stderr tail: ${stderr.slice(-300)}`,
  );
};

const out = { tools: 0, listPages: null, error: null };
try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cdp-mcp-smoke', version: '1' },
    },
  });
  await wait(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tl = await wait(2);
  if (tl.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(tl.error)}`);
  }
  out.tools = (tl.result?.tools || []).length;

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_pages', arguments: {} },
  });
  const lp = await wait(3);
  if (lp.error) {
    throw new Error(`list_pages failed: ${JSON.stringify(lp.error)}`);
  }
  if (lp.result?.isError === true) {
    const text = (lp.result.content || [])
      .map((part) => part?.text)
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `list_pages returned an MCP error: ${text || 'unknown error'}`,
    );
  }
  out.listPages = JSON.stringify(lp.result ?? lp.error).slice(0, 240);
} catch (e) {
  out.error = e.message;
}
mcp.kill('SIGTERM');

console.log('\n=== LAYER C: external CDP MCP over /cdp ===');
console.log(JSON.stringify(out, null, 2));
console.log(
  '\nC-LAYER:',
  out.tools >= 20 && out.listPages && !out.error
    ? 'PASS — external CDP MCP toolset drives the real browser via the tunnel'
    : `FAIL${out.error ? ' — ' + out.error : ''}`,
);
process.exit(0);
