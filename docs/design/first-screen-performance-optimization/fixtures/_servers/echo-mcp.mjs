#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal stdio MCP server used by benchmark fixtures.
 *
 * Args (env vars):
 *   ECHO_MCP_NAME       — server display name, default 'echo'
 *   ECHO_MCP_DELAY_MS   — sleep this many ms before responding to *every*
 *                         message; used by `three-mixed-mcp/slow.mjs` to
 *                         simulate a slow server.
 *   ECHO_MCP_NEVER      — if '1', never respond to anything; used by
 *                         `flaky-mcp/timeout.mjs` to simulate a server that
 *                         hangs and gets timed out.
 *
 * Implements just enough of the MCP protocol to satisfy
 * `McpClient.connect()` + `McpClient.discover()`:
 *   - initialize
 *   - notifications/initialized (no-op)
 *   - tools/list (returns one sample tool)
 *   - prompts/list (returns empty list)
 *   - resources/list (returns empty list)
 *
 * We use raw JSON-RPC over stdio rather than the SDK to keep the script
 * dependency-free and easy to spawn from a fixture directory.
 */
import { createInterface } from 'node:readline';

const NAME = process.env['ECHO_MCP_NAME'] || 'echo';
const DELAY_MS = parseInt(process.env['ECHO_MCP_DELAY_MS'] || '0', 10);
const NEVER = process.env['ECHO_MCP_NEVER'] === '1';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(req) {
  if (NEVER) return; // simulate a server that never responds
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const id = req.id;
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: { name: NAME, version: '0.0.1' },
        },
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: `${NAME}_echo`,
              description: 'Echo a string back. Benchmark fixture only.',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
            },
          ],
        },
      });
      break;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      break;
    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      break;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: req.params?.arguments?.message ?? '' },
          ],
        },
      });
      break;
    case 'notifications/initialized':
      // no-op
      break;
    default:
      // Loud-fail on unknown methods so MCP SDK upgrades that add new probes
      // (e.g. logging/setLevel, sampling/createMessage) surface via the cli's
      // MCP STDERR debug logger instead of silently degrading the fixture.
      process.stderr.write(
        `echo-mcp[${NAME}]: unhandled method "${req.method}"\n`,
      );
      if (id !== undefined) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Fire-and-forget; failures crash the process which terminates the test.
  void handle(msg).catch((err) => {
    process.stderr.write(`echo-mcp error: ${err?.stack || err}\n`);
  });
});

rl.on('close', () => process.exit(0));
