/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end MCP-wire smoke: spawn the built stdio server and drive it with a
// real MCP client. Run after `npm run build`:  node scripts/mcp-smoke.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: path.join(here, '..'),
});
const client = new Client({ name: 'node-repl-smoke', version: '0.0.0' });

let failures = 0;
const check = (label, cond, detail) => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`,
  );
  if (!cond) failures++;
};
const textOf = (res) =>
  (res.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    'lists the two JavaScript tools',
    names.join(',') === 'js,js_reset',
    names.join(','),
  );

  await client.callTool({
    name: 'js',
    arguments: { code: 'const x = 40;' },
  });
  const r = await client.callTool({
    name: 'js',
    arguments: { code: 'nodeRepl.write(String(x + 2));' },
  });
  check(
    'binding persists across MCP calls',
    textOf(r).includes('42'),
    textOf(r).trim(),
  );

  await client.callTool({ name: 'js_reset', arguments: {} });
  const r2 = await client.callTool({
    name: 'js',
    arguments: { code: 'nodeRepl.write(typeof x);' },
  });
  check(
    'reset clears bindings over the wire',
    textOf(r2).includes('undefined'),
    textOf(r2).trim(),
  );
} finally {
  await client.close();
}

console.log(
  failures === 0 ? '\nMCP WIRE SMOKE PASSED' : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
