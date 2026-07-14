/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ?? path.join(REPO_ROOT, 'dist', 'cli.js');
const ECHO_SERVER = path.join(
  REPO_ROOT,
  'integration-tests',
  'fixtures',
  'invocation-context-echo.mjs',
);
const SERVE_BRIDGE_BIN = path.join(
  REPO_ROOT,
  'packages',
  'sdk-typescript',
  'dist',
  'daemon-mcp',
  'serve-bridge',
  'bin.js',
);
const ECHO_TOOL = 'mcp__invocation-echo__capture_invocation_context';
const INVOCATION_META_KEY = 'qwen-code/invocation';
const DIRECT_CLI_SENTINEL = 'CAPTURE_DIRECT_CLI_INVOCATION_CONTEXT';
const DAEMON_A_SENTINEL = 'CAPTURE_DAEMON_INVOCATION_CONTEXT_A';
const DAEMON_B_SENTINEL = 'CAPTURE_DAEMON_INVOCATION_CONTEXT_B';
const DAEMON_B_AFTER_CLOSE_SENTINEL =
  'CAPTURE_DAEMON_INVOCATION_CONTEXT_B_AFTER_A_CLOSE';
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

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let timedOut = false;
    let forceKillDeadline: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillDeadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKillDeadline.unref();
    }, 45_000);
    deadline.unref();
    child.once('error', (error) => {
      clearTimeout(deadline);
      if (forceKillDeadline) clearTimeout(forceKillDeadline);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      if (forceKillDeadline) clearTimeout(forceKillDeadline);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${timedOut ? 'timed out' : 'exited'} with code=${String(code)} signal=${String(signal)}\n` +
            `stdout=${stdout}\nstderr=${stderr}`,
        ),
      );
    });
  });
}

function readCaptures(file: string): CaptureRecord[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureRecord);
}

function cleanupCaptureRoot(root: string, captureFile: string): void {
  if (process.env['KEEP_INVOCATION_CONTEXT_CAPTURE'] === '1') {
    process.stderr.write(`Invocation context capture: ${captureFile}\n`);
    return;
  }
  rmSync(root, { recursive: true, force: true });
}

function invocationFrom(record: CaptureRecord): Record<string, unknown> {
  const invocation = record.metadata?.[INVOCATION_META_KEY];
  expect(invocation).toBeTypeOf('object');
  return invocation as Record<string, unknown>;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function pendingSentinel(
  body: Record<string, unknown>,
  sentinels: string[],
): string | undefined {
  const messages = body['messages'];
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const userIndex = messages.findLastIndex(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as Record<string, unknown>)['role'] === 'user',
  );
  if (userIndex === -1) {
    return undefined;
  }

  const userMessage = JSON.stringify(messages[userIndex]);
  const sentinel = sentinels.find((candidate) =>
    userMessage.includes(candidate),
  );
  if (!sentinel) {
    return undefined;
  }

  const hasToolResult = messages
    .slice(userIndex + 1)
    .some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>)['role'] === 'tool',
    );
  return hasToolResult ? undefined : sentinel;
}

async function callBridgeTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type?: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error(`${name} returned no text: ${JSON.stringify(result)}`);
  }
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text) as T;
}

describe('Invocation Context v1 runtime propagation', () => {
  it('marks a bundled direct CLI turn as cli', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-invocation-cli-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const captureFile = path.join(root, 'capture.jsonl');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });

    const fakeModel = await startFakeOpenAIServer(({ body }) => {
      const sentinel = pendingSentinel(body, [DIRECT_CLI_SENTINEL]);
      if (sentinel) {
        return {
          toolCalls: [fakeToolCall(ECHO_TOOL, { probe: sentinel })],
        };
      }
      return { content: FINAL_ASSISTANT_TEXT };
    });

    try {
      const sessionId = randomUUID();
      const mcpConfig = JSON.stringify({
        mcpServers: {
          'invocation-echo': {
            command: process.execPath,
            args: [ECHO_SERVER],
            env: { INVOCATION_CONTEXT_ECHO_FILE: captureFile },
          },
        },
      });
      const result = await runProcess(
        process.execPath,
        [
          CLI_BIN,
          '--prompt',
          DIRECT_CLI_SENTINEL,
          '--session-id',
          sessionId,
          '--mcp-config',
          mcpConfig,
          '--allowed-mcp-server-names',
          'invocation-echo',
          '--allowed-tools',
          ECHO_TOOL,
          '--approval-mode',
          'yolo',
          '--auth-type',
          'openai',
          '--model',
          'fake-model',
          '--output-format',
          'json',
          '--no-chat-recording',
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: home,
            QWEN_HOME: path.join(home, '.qwen'),
            QWEN_SANDBOX: 'false',
            QWEN_CODE_NO_RELAUNCH: 'true',
            QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
            OPENAI_API_KEY: 'fake-key',
            OPENAI_BASE_URL: fakeModel.baseUrl,
            OPENAI_MODEL: 'fake-model',
            QWEN_MODEL: 'fake-model',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          },
        },
      );

      expect(result.stdout).toContain(FINAL_ASSISTANT_TEXT);
      const captures = readCaptures(captureFile);
      expect(captures).toHaveLength(1);
      expect(captures[0]?.privateCapabilityInEnv).toBe(false);
      const invocation = invocationFrom(captures[0]!);
      expect(invocation).toEqual({
        version: 1,
        ingress: 'cli',
        sessionId,
        promptId: expect.any(String),
      });
      expect(String(invocation['promptId']).trim()).not.toBe('');
    } finally {
      await fakeModel.close();
      cleanupCaptureRoot(root, captureFile);
    }
  }, 60_000);

  it('keeps external_mcp session markings isolated through the daemon', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-invocation-daemon-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const captureFile = path.join(root, 'capture.jsonl');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });

    const sentinels = [
      DAEMON_A_SENTINEL,
      DAEMON_B_AFTER_CLOSE_SENTINEL,
      DAEMON_B_SENTINEL,
    ];
    const fakeModel = await startFakeOpenAIServer(({ body }) => {
      const sentinel = pendingSentinel(body, sentinels);
      if (sentinel) {
        return {
          toolCalls: [fakeToolCall(ECHO_TOOL, { probe: sentinel })],
        };
      }
      return { content: FINAL_ASSISTANT_TEXT };
    });

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
      const approvalEnv = approveWorkspaceMcpServers(workspace, mcpServers);
      const runtimeEnv = {
        ...process.env,
        ...approvalEnv,
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
        name: 'invocation-context-runtime-test',
        version: '1.0.0',
      });
      const bridgeTransport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVE_BRIDGE_BIN],
        env: stringEnv({
          ...runtimeEnv,
          QWEN_DAEMON_URL: daemon.base,
          QWEN_DAEMON_TOKEN: daemon.token,
          QWEN_WORKSPACE_CWD: workspace,
        }),
      });
      await bridgeClient.connect(bridgeTransport);

      const [sessionA, sessionB] = await Promise.all([
        callBridgeTool<BridgeSession>(bridgeClient, 'session_create', {
          workspace_cwd: workspace,
          session_scope: 'thread',
        }),
        callBridgeTool<BridgeSession>(bridgeClient, 'session_create', {
          workspace_cwd: workspace,
          session_scope: 'thread',
        }),
      ]);
      expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
      expect(sessionA.clientId).toBeTypeOf('string');
      expect(sessionB.clientId).toBeTypeOf('string');

      await Promise.all([
        callBridgeTool(bridgeClient, 'prompt', {
          session_id: sessionA.sessionId,
          prompt: DAEMON_A_SENTINEL,
        }),
        callBridgeTool(bridgeClient, 'prompt', {
          session_id: sessionB.sessionId,
          prompt: DAEMON_B_SENTINEL,
        }),
      ]);

      const firstCaptures = readCaptures(captureFile);
      expect(firstCaptures).toHaveLength(2);
      const captureA = firstCaptures.find(
        (record) => record.arguments['probe'] === DAEMON_A_SENTINEL,
      );
      const captureB = firstCaptures.find(
        (record) => record.arguments['probe'] === DAEMON_B_SENTINEL,
      );
      expect(captureA).toBeDefined();
      expect(captureB).toBeDefined();
      expect(captureA?.privateCapabilityInEnv).toBe(false);
      expect(captureB?.privateCapabilityInEnv).toBe(false);

      const invocationA = invocationFrom(captureA!);
      const invocationB = invocationFrom(captureB!);
      expect(invocationA).toEqual({
        version: 1,
        ingress: 'external_mcp',
        sessionId: sessionA.sessionId,
        promptId: expect.stringMatching(UUID_PATTERN),
        originatorClientId: sessionA.clientId,
      });
      expect(invocationB).toEqual({
        version: 1,
        ingress: 'external_mcp',
        sessionId: sessionB.sessionId,
        promptId: expect.stringMatching(UUID_PATTERN),
        originatorClientId: sessionB.clientId,
      });
      expect(invocationA['promptId']).not.toBe(invocationB['promptId']);

      await callBridgeTool(bridgeClient, 'session_close', {
        session_id: sessionA.sessionId,
      });
      await callBridgeTool(bridgeClient, 'session_context', {
        session_id: sessionB.sessionId,
      });
      await callBridgeTool(bridgeClient, 'prompt', {
        session_id: sessionB.sessionId,
        prompt: DAEMON_B_AFTER_CLOSE_SENTINEL,
      });

      const allCaptures = readCaptures(captureFile);
      expect(allCaptures).toHaveLength(3);
      const captureBAfterClose = allCaptures.find(
        (record) => record.arguments['probe'] === DAEMON_B_AFTER_CLOSE_SENTINEL,
      );
      expect(captureBAfterClose).toBeDefined();
      const invocationBAfterClose = invocationFrom(captureBAfterClose!);
      expect(invocationBAfterClose).toEqual({
        version: 1,
        ingress: 'external_mcp',
        sessionId: sessionB.sessionId,
        promptId: expect.stringMatching(UUID_PATTERN),
        originatorClientId: sessionB.clientId,
      });
      expect(invocationBAfterClose['promptId']).not.toBe(
        invocationB['promptId'],
      );

      await callBridgeTool(bridgeClient, 'session_close', {
        session_id: sessionB.sessionId,
      });
    } finally {
      await bridgeClient?.close().catch(() => undefined);
      await daemon?.dispose();
      await fakeModel.close();
      cleanupCaptureRoot(root, captureFile);
    }
  }, 120_000);
});
