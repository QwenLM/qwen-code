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
import {
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
} from '@qwen-code/acp-bridge/externalToolGuard';
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

// Mirror the real child (acpAgent.ts): `qwen serve` requires the guard ack
// in the initialize response, and the markers are consumed + deleted before
// anything else can inherit them.
const externalToolGuardMarker = process.env[PRIVATE_EXTERNAL_TOOL_GUARD_ENV];
delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_ENV];
delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV];
const externalToolGuardRequired =
  externalToolGuardMarker === EXTERNAL_TOOL_GUARD_REQUIRED_VALUE;

// SERVE_CONTROL_EXT_METHODS.sessionClose from @qwen-code/acp-bridge/status,
// hardcoded because that module runtime-imports @qwen-code/qwen-code-core
// and would pull core's whole barrel into this lightweight fixture. Drift
// fails loudly: the daemon's session close errors when this stops matching.
const SESSION_CLOSE_EXT_METHOD = 'qwen/control/session/close';

new AgentSideConnection(
  (connection) => ({
    async initialize() {
      // Build ONE meta record and attach `_meta` once, exactly like the
      // real child (acpAgent.ts), so a future conditional meta source
      // merges instead of clobbering the guard ack via duplicate keys.
      const responseMeta = {
        ...(externalToolGuardRequired
          ? {
              [EXTERNAL_TOOL_GUARD_READY_META_KEY]:
                EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
            }
          : {}),
      };
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'mock-acp', version: '0.0.1' },
        authMethods: [],
        agentCapabilities: {},
        ...(Object.keys(responseMeta).length > 0
          ? { _meta: responseMeta }
          : {}),
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

    async extMethod(method, params) {
      if (method === SESSION_CLOSE_EXT_METHOD) {
        // The daemon's DELETE /session/:id forwards this ext method down the
        // ACP channel; ack with the production success shape so teardown
        // completes. The mock keeps no per-session state to drain.
        const { sessionId } = params;
        return { sessionId, closed: true };
      }
      throw RequestError.methodNotFound(method);
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

process.stdin.on('end', () => process.exit(0));
