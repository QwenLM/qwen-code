#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Scripted ACP agent child for adaptor lifecycle tests — the same shape
// as integration-tests/fixtures/mock-acp-child/agent.mjs but free of any
// @qwen-code dependency (qwen-live must not depend on acp-bridge). Uses
// the real AgentSideConnection so the NDJSON framing, handshake, and
// error shapes match production.
//
// Modes (env FAKE_ACP_MODE, default "echo"):
//   echo              chunked reply then end_turn; prompts containing
//                     "permission:" raise session/request_permission first
//   crash-after-init  process.exit(42) inside initialize

import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { Writable, Readable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

// Protect the stdout NDJSON pipe.
/* eslint-disable no-undef */
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.dir = console.error;
/* eslint-enable no-undef */

const mode = process.env['FAKE_ACP_MODE'] ?? 'echo';
let sessionCounter = 0;

new AgentSideConnection(
  (connection) => ({
    async initialize() {
      if (mode === 'crash-after-init') {
        process.exit(42);
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
      };
    },

    async authenticate() {
      return {};
    },

    async newSession() {
      return { sessionId: `fake-${++sessionCounter}` };
    },

    async prompt(params) {
      const { sessionId } = params;
      const text = params.prompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ');

      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo: ${text}` },
        },
      });

      if (text.includes('permission:')) {
        const response = await connection.requestPermission({
          sessionId,
          toolCall: {
            name: 'write_file',
            title: text.slice(0, 80),
          },
          options: [
            { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
          ],
        });
        const outcome = response.outcome?.outcome;
        return outcome === 'selected'
          ? { stopReason: 'end_turn' }
          : { stopReason: 'cancelled' };
      }

      await setTimeout(50);
      return { stopReason: 'end_turn' };
    },

    async cancel() {},

    async extMethod(method) {
      if (method === 'craft/drainMidTurnQueue') {
        return { messages: [], hasQueuedPrompt: false };
      }
      throw RequestError.methodNotFound(method);
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

process.stdin.on('end', () => process.exit(0));
