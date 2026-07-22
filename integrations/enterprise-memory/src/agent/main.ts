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
const states = new AgentStateStore(
  required('MEMORY_AGENT_STATE_DIR'),
  250,
  operationSecret('MEMORY_AGENT_OPERATION_HMAC_SECRET'),
);

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

function operationSecret(name: string): Uint8Array {
  const encoded = required(name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  const value = Buffer.from(encoded, 'base64url');
  if (value.byteLength !== 32 || value.toString('base64url') !== encoded) {
    throw new Error(`${name} must contain exactly 32 bytes`);
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
