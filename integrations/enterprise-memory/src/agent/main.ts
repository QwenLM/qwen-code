/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GatewayClient } from './gateway-client.js';
import { HookHandler } from './hook-handler.js';
import { runMcpServer } from './mcp-server.js';
import { AgentStateStore } from './state-store.js';

const gateway = new GatewayClient({
  brokerUrl: required('MEMORY_BROKER_URL'),
  gatewayUrl: required('MEMORY_GATEWAY_URL'),
  certificatePath: required('MEMORY_AGENT_TLS_CERT'),
  privateKeyPath: required('MEMORY_AGENT_TLS_KEY'),
  caPath: required('MEMORY_AGENT_TLS_CA'),
});
const states = new AgentStateStore(required('MEMORY_AGENT_STATE_DIR'));

try {
  if (process.argv[2] === 'mcp') {
    await runMcpServer(gateway, states);
  } else if (process.argv[2] === 'hook') {
    const input = JSON.parse(await readStdin(256 * 1024)) as unknown;
    const output = await new HookHandler(gateway, states).handle(input);
    if (output) {
      process.stdout.write(JSON.stringify(output));
    }
  } else {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error('Hook payload is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
