#!/usr/bin/env node
// Minimal stdio MCP server for daemon-baseline tests. Responds to the
// MCP `initialize` + `tools/list` handshake with one no-op tool (just
// enough for the daemon to consider the server "connected"), then idles
// forever.
//
// We need a real long-running child process so the baseline harness can
// count it via `pgrep -P` and surface the P1 N×M amplification before
// the M2 shared-pool fix tightens it. A real npm MCP package (e.g.
// `@modelcontextprotocol/server-everything`) would also work but pulls
// network + version-lock churn into CI; this fixture is deterministic
// and ~30 lines.

import { exit, stdin, stdout } from 'node:process';

const PROTOCOL_VERSION = '2024-11-05';
const TOOLS = [
  {
    name: 'idle_ping',
    description: 'No-op tool for daemon baseline process-count tests.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      respond(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'idle-mcp', version: '0.0.1' },
      });
    } else if (msg.method === 'tools/list') {
      respond(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      respond(msg.id, { content: [{ type: 'text', text: 'ok' }] });
    } else if (msg.method === 'notifications/initialized') {
      // No response needed for notifications.
    } else if (msg.id !== undefined) {
      // Unknown request — return a method-not-found error so the daemon
      // doesn't hang waiting on us.
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'method not found' },
      });
    }
  }
});

stdin.on('end', () => exit(0));
