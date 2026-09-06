/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import {
  approveWorkspaceMcpServers,
  spawnDaemon,
  type SpawnedDaemon,
  writeWorkspaceSettings,
} from './_daemon-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ECHO_SERVER = path.join(
  REPO_ROOT,
  'integration-tests',
  'fixtures',
  'invocation-context-echo.mjs',
);
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVE_BRIDGE_SOURCE = path.join(
  REPO_ROOT,
  'packages',
  'sdk-typescript',
  'src',
  'daemon-mcp',
  'serve-bridge',
  'bin.ts',
);
const ECHO_TOOL = 'mcp__invocation-echo__capture_invocation_context';
const INVOCATION_META_KEY = 'qwen-code/invocation';
const PROMPT_SENTINEL = 'CAPTURE_DAEMON_INVOCATION_CONTEXT';
const FINAL_ASSISTANT_TEXT = 'INVOCATION_CONTEXT_CAPTURED';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CaptureRecord = {
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  privateCapabilityInEnv: boolean;
};

type BridgeSession = {
  sessionId: string;
  clientId?: string;
};

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function pendingSentinel(body: Record<string, unknown>): boolean {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return false;
  const userIndex = messages.findLastIndex(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as Record<string, unknown>)['role'] === 'user',
  );
  if (userIndex === -1) return false;
  if (!JSON.stringify(messages[userIndex]).includes(PROMPT_SENTINEL)) {
    return false;
  }
  return !messages
    .slice(userIndex + 1)
    .some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>)['role'] === 'tool',
    );
}

async function callBridgeTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type?: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text || result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as T;
}

describe('trusted daemon invocation context', () => {
  it('reaches a Qwen-launched local stdio MCP tool without leaking the private capability', async ({
    skip,
  }) => {
    skip(process.platform === 'win32', 'requires the POSIX daemon harness');
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-daemon-invocation-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const captureFile = path.join(root, 'capture.jsonl');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });

    const fakeModel = await startFakeOpenAIServer(({ body }) =>
      pendingSentinel(body)
        ? { toolCalls: [fakeToolCall(ECHO_TOOL, { probe: PROMPT_SENTINEL })] }
        : { content: FINAL_ASSISTANT_TEXT },
    );

    let daemon: SpawnedDaemon | undefined;
    let bridgeClient: Client | undefined;
    try {
      const mcpServers = {
        'invocation-echo': {
          command: process.execPath,
          args: [ECHO_SERVER],
          env: { INVOCATION_CONTEXT_ECHO_FILE: captureFile },
          trust: true,
          alwaysLoadTools: true,
        },
      };
      writeWorkspaceSettings(workspace, {
        tools: { approvalMode: 'yolo' },
        mcpServers,
      });
      const runtimeEnv = {
        ...process.env,
        ...approveWorkspaceMcpServers(workspace, mcpServers),
        HOME: home,
        QWEN_HOME: path.join(home, '.qwen'),
        QWEN_SANDBOX: 'false',
        QWEN_CODE_NO_RELAUNCH: 'true',
        QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeModel.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      };
      daemon = await spawnDaemon({
        workspaceCwd: workspace,
        bootTimeoutMs: 20_000,
        env: runtimeEnv,
      });
      bridgeClient = new Client({
        name: 'daemon-invocation-context-test',
        version: '1.0.0',
      });
      await bridgeClient.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [TSX_BIN, SERVE_BRIDGE_SOURCE],
          env: stringEnv({
            ...runtimeEnv,
            QWEN_DAEMON_URL: daemon.base,
            QWEN_DAEMON_TOKEN: daemon.token,
            QWEN_WORKSPACE_CWD: workspace,
          }),
        }),
      );

      const session = await callBridgeTool<BridgeSession>(
        bridgeClient,
        'session_create',
        { workspace_cwd: workspace, session_scope: 'thread' },
      );
      await callBridgeTool(bridgeClient, 'prompt', {
        session_id: session.sessionId,
        prompt: PROMPT_SENTINEL,
      });

      const records = readFileSync(captureFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CaptureRecord);
      expect(records).toHaveLength(1);
      expect(records[0]?.arguments['probe']).toBe(PROMPT_SENTINEL);
      expect(records[0]?.privateCapabilityInEnv).toBe(false);
      expect(records[0]?.metadata?.[INVOCATION_META_KEY]).toEqual({
        version: 1,
        sessionId: session.sessionId,
        promptId: expect.stringMatching(UUID_PATTERN),
      });
      expect(
        (
          records[0]?.metadata?.[INVOCATION_META_KEY] as
            | Record<string, unknown>
            | undefined
        )?.['originatorClientId'],
      ).toBeUndefined();

      await callBridgeTool(bridgeClient, 'session_close', {
        session_id: session.sessionId,
      });
    } finally {
      await bridgeClient?.close().catch(() => undefined);
      await daemon?.dispose();
      await fakeModel.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
