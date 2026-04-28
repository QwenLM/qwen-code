import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk';

import type { ModelDefinition } from '../../../../config/models.ts';
import { getProxyEnvVars } from '../../../../config/proxy-env.ts';
import type { ModelFetchResult } from '../../../../config/model-fetcher.ts';
import type { ProviderDriver } from '../driver-types.ts';
import type { ResolvedBackendRuntimePaths } from '../runtime-resolver.ts';

type JsonRecord = Record<string, unknown>;

const QWEN_CONTEXT_WINDOW = 1_000_000;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toQwenModelDefinition(value: unknown): ModelDefinition | null {
  const model = toRecord(value);
  const id = asString(model.modelId);
  if (!id) return null;

  const name = asString(model.name) || id;
  return {
    id,
    name,
    shortName: name,
    description: asString(model.description) || '',
    provider: 'qwen',
    contextWindow: QWEN_CONTEXT_WINDOW,
  };
}

function buildSpawnCommand(qwenCliPath: string, nodePath: string): { command: string; args: string[] } {
  const args = ['--acp'];
  if (qwenCliPath.endsWith('.js')) {
    return { command: nodePath, args: [qwenCliPath, ...args] };
  }
  return { command: qwenCliPath, args };
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Qwen ACP model discovery timed out: ${label}`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function createModelDiscoveryClient(): Client {
  return {
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async () => {},
  };
}

async function fetchQwenModelsFromAcp(args: {
  resolvedPaths: ResolvedBackendRuntimePaths;
  cwd: string;
  timeoutMs: number;
}): Promise<ModelFetchResult> {
  const qwenCliPath = args.resolvedPaths.qwenCliPath;
  if (!qwenCliPath) {
    throw new Error('Qwen Code CLI not found. Set QWEN_CODE_CLI to the qwen dist/cli.js path or install qwen on PATH.');
  }

  const nodePath = args.resolvedPaths.nodeRuntimePath || process.execPath;
  const { command, args: spawnArgs } = buildSpawnCommand(qwenCliPath, nodePath);
  const child = spawn(command, spawnArgs, {
    cwd: args.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...getProxyEnvVars(),
    },
    shell: false,
  });

  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8 * 1024);
  });

  const connection = new ClientSideConnection(
    () => createModelDiscoveryClient(),
    ndJsonStream(
      Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    ),
  );

  try {
    await withTimeout(connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }), 'initialize', args.timeoutMs);

    const result = toRecord(await withTimeout(connection.newSession({
      cwd: args.cwd,
      mcpServers: [],
    }), 'session/new', args.timeoutMs));
    const modelState = toRecord(result.models);
    const models = Array.isArray(modelState.availableModels)
      ? modelState.availableModels.map(toQwenModelDefinition).filter((model): model is ModelDefinition => !!model)
      : [];
    const serverDefault = asString(modelState.currentModelId);

    if (models.length === 0) {
      throw new Error('Qwen ACP session/new did not return models.availableModels');
    }

    return { models, serverDefault };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrSuffix = stderr.trim() ? ` Recent stderr: ${stderr.trim().slice(-1000)}` : '';
    throw new Error(`${message}${stderrSuffix}`);
  } finally {
    if (!child.killed) {
      child.kill();
    }
  }
}

export const qwenDriver: ProviderDriver = {
  provider: 'qwen',
  buildRuntime: ({ resolvedPaths }) => ({
    paths: {
      qwenCli: resolvedPaths.qwenCliPath,
      node: resolvedPaths.nodeRuntimePath,
    },
  }),
  fetchModels: ({ hostRuntime, resolvedPaths, timeoutMs }) => fetchQwenModelsFromAcp({
    resolvedPaths,
    cwd: hostRuntime.appRootPath || process.cwd(),
    timeoutMs,
  }),
  validateStoredConnection: async () => ({ success: true, shouldRefreshModels: true }),
  testConnection: async () => null,
};
