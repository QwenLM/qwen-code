/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
} from '@agentclientprotocol/sdk';
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core';
import {
  assertExternalAgentSpawnPlatformSupported,
  selectPeerModeId,
  selectRejectOption,
} from '../../external-agents/acp-subagent-executor.js';
import type { AgentRunStep } from './agent-events.js';
import { recordToolStep, type AgentTurnUpdate } from './stream-agent-turn.js';

/** The adapter the built-in `claude-code` agent also uses. */
export const CLAUDE_ACP_COMMAND = 'claude-agent-acp';

/**
 * Runs one assignment with Claude Code through its ACP adapter and returns the
 * reply. Read-only, like Codex: the session is put in plan mode and every
 * permission request is answered with the adapter's own reject option, so an
 * edit or a command is refused rather than approved. It has no thread tools;
 * the reply becomes the run's plain answer.
 *
 * ponytail: a fresh session per run. Keep one per (agent, thread), as Codex
 * does, when follow-ups need the earlier turns.
 */
export async function runClaudeHostTurn(input: {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onUpdate: (update: AgentTurnUpdate) => void;
  /** Overrides the adapter command; tests run a scripted ACP agent. */
  command?: readonly [string, ...string[]];
}): Promise<string> {
  assertExternalAgentSpawnPlatformSupported();
  const [command, ...args] = input.command ?? [CLAUDE_ACP_COMMAND];
  const child = spawn(command, args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: sanitizeChildEnv(process.env),
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  input.signal.addEventListener('abort', stop, { once: true });
  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`${CLAUDE_ACP_COMMAND} exited (${code ?? signal})`)),
    );
  });
  // Exits after a finished turn are expected; only a race loser listens.
  exited.catch(() => {});
  child.stderr!.resume();

  let text = '';
  let thought = '';
  const steps = new Map<string, AgentRunStep>();
  const client: Client = {
    sessionUpdate: async ({ update }) => {
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text'
      ) {
        text += update.content.text;
        input.onUpdate({ stage: 'responding', outputText: text });
      } else if (
        update.sessionUpdate === 'agent_thought_chunk' &&
        update.content.type === 'text'
      ) {
        thought += update.content.text;
        input.onUpdate({ stage: 'thinking', thoughtText: thought });
      } else if (
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        input.onUpdate({
          stage: 'tool',
          detail: update.title ?? '',
          steps: recordToolStep(steps, update),
        });
      }
    },
    requestPermission: async ({ options }) => {
      const optionId = selectRejectOption(options);
      return optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } };
    },
    readTextFile: async () => {
      throw RequestError.methodNotFound('fs/read_text_file');
    },
    writeTextFile: async () => {
      throw RequestError.methodNotFound('fs/write_text_file');
    },
    extMethod: async (method) => {
      throw RequestError.methodNotFound(method);
    },
    extNotification: async () => {},
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ),
  );

  const turn = async () => {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`${CLAUDE_ACP_COMMAND} speaks another ACP version.`);
    }
    const session = await connection.newSession({
      cwd: input.cwd,
      mcpServers: [],
    });
    const plan = selectPeerModeId(
      'plan',
      session.modes?.availableModes.map((mode: { id: string }) => mode.id) ??
        [],
    );
    if (!plan) {
      throw new Error(
        `${CLAUDE_ACP_COMMAND} offers no plan mode; refusing to run it outside the read-only boundary.`,
      );
    }
    await connection.setSessionMode({
      sessionId: session.sessionId,
      modeId: plan,
    });
    input.onUpdate({ stage: 'thinking' });
    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    return text;
  };

  try {
    return await Promise.race([turn(), exited]);
  } finally {
    input.signal.removeEventListener('abort', stop);
    stop();
  }
}
