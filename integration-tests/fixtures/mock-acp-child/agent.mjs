#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock ACP agent for daemon connection stress tests. Uses the real
// AgentSideConnection from @agentclientprotocol/sdk so the NDJSON
// handshake, session lifecycle, and error shapes match production.
//
// Controlled via environment variables (spawnChannel's QWEN_CLI_ENTRY
// only accepts a path — cannot attach argv):
//
//   MOCK_ACP_MODE            echo | reject | crash-on-prompt | hang
//   MOCK_ACP_PROMPT_DELAY_MS per-prompt delay (default 100)
//   MOCK_ACP_EMIT_CHUNKS     text chunks per prompt (default 3)

import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import { Writable, Readable } from 'node:stream';

// Protect the stdout NDJSON pipe — any console method that writes to
// stdout would corrupt the framing.
/* eslint-disable no-undef */
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.dir = console.error;
/* eslint-enable no-undef */

const mode = process.env.MOCK_ACP_MODE ?? 'echo';
const delayMs = parseInt(process.env.MOCK_ACP_PROMPT_DELAY_MS || '100', 10);
const emitChunks = parseInt(process.env.MOCK_ACP_EMIT_CHUNKS || '3', 10);
let sessionCounter = 0;

new AgentSideConnection(
  (connection) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'mock-acp', version: '0.0.1' },
        authMethods: [],
        agentCapabilities: {},
      };
    },

    async authenticate() {
      return {};
    },

    async newSession() {
      return { sessionId: `mock-${++sessionCounter}` };
    },

    async prompt(params) {
      const { sessionId } = params;

      for (let i = 0; i < emitChunks; i++) {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `chunk-${i}` },
          },
        });
      }

      if (delayMs > 0) {
        await setTimeout(delayMs);
      }

      if (mode === 'reject') {
        throw new RequestError(-32603, 'injected error');
      }
      if (mode === 'crash-on-prompt') {
        process.exit(1);
      }
      if (mode === 'hang') {
        return new Promise(() => {});
      }

      return { stopReason: 'end_turn' };
    },

    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

process.stdin.on('end', () => process.exit(0));
