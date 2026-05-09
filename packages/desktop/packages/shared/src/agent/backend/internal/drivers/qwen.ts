/* eslint-disable import/no-internal-modules */
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
import { withElectronRunAsNodeEnv } from '../electron-run-as-node.ts';
import type { ResolvedBackendRuntimePaths } from '../runtime-resolver.ts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const bool = asBoolean(value);
    if (bool !== undefined) return bool;
  }
  return undefined;
}

function toQwenModelDefinition(value: unknown): ModelDefinition | null {
  const model = toRecord(value);
  const id = asString(model.modelId);
  if (!id) return null;

  const name = asString(model.name) || id;
  const meta = toRecord(model._meta);
  const generationConfig = toRecord(model.generationConfig);
  const metaGenerationConfig = toRecord(meta.generationConfig);
  const extraBody = toRecord(generationConfig.extra_body);
  const metaExtraBody = toRecord(metaGenerationConfig.extra_body);
  const capabilities = toRecord(model.capabilities);
  const limits = toRecord(capabilities.limits);
  const metaCapabilities = toRecord(meta.capabilities);
  const metaLimits = toRecord(metaCapabilities.limits);
  const contextWindow = firstNumber(
    meta.contextLimit,
    meta.contextWindowSize,
    meta.contextWindow,
    model.contextWindowSize,
    model.contextWindow,
    model.maxContextWindowTokens,
    metaGenerationConfig.contextWindowSize,
    metaGenerationConfig.contextWindow,
    generationConfig.contextWindowSize,
    generationConfig.contextWindow,
    metaLimits.max_context_window_tokens,
    limits.max_context_window_tokens,
  );
  const supportsThinking = firstBoolean(
    meta.supportsThinking,
    meta.supportsReasoning,
    meta.enableThinking,
    meta.enable_thinking,
    model.supportsThinking,
    model.supportsReasoning,
    model.enableThinking,
    model.enable_thinking,
    metaGenerationConfig.enableThinking,
    metaGenerationConfig.enable_thinking,
    metaExtraBody.enableThinking,
    metaExtraBody.enable_thinking,
    generationConfig.enableThinking,
    generationConfig.enable_thinking,
    extraBody.enableThinking,
    extraBody.enable_thinking,
  );

  return {
    id,
    name,
    shortName: name,
    description: asString(model.description) || '',
    provider: 'qwen',
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
  };
}

function buildSpawnCommand(
  qwenCliPath: string,
  nodePath: string,
): { command: string; args: string[] } {
  const args = ['--acp'];
  if (qwenCliPath.endsWith('.js')) {
    return { command: nodePath, args: [qwenCliPath, ...args] };
  }
  return { command: qwenCliPath, args };
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Qwen ACP model discovery timed out: ${label}`)),
      timeoutMs,
    );
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
    throw new Error(
      'Qwen Code CLI not found. Build the current qwen-code checkout with npm run build && npm run bundle, or set QWEN_CODE_CLI to a dist/cli.js path.',
    );
  }

  const nodePath = args.resolvedPaths.nodeRuntimePath || process.execPath;
  const { command, args: spawnArgs } = buildSpawnCommand(qwenCliPath, nodePath);
  const env = withElectronRunAsNodeEnv(
    {
      ...process.env,
      ...getProxyEnvVars(),
    },
    command,
    spawnArgs,
  );
  const child = spawn(command, spawnArgs, {
    cwd: args.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
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
    await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
      'initialize',
      args.timeoutMs,
    );

    const result = toRecord(
      await withTimeout(
        connection.newSession({
          cwd: args.cwd,
          mcpServers: [],
        }),
        'session/new',
        args.timeoutMs,
      ),
    );
    const modelState = toRecord(result.models);
    const models = Array.isArray(modelState.availableModels)
      ? modelState.availableModels
          .map(toQwenModelDefinition)
          .filter((model): model is ModelDefinition => !!model)
      : [];
    const serverDefault = asString(modelState.currentModelId);

    if (models.length === 0) {
      throw new Error(
        'Qwen ACP session/new did not return models.availableModels',
      );
    }

    return { models, serverDefault };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderrSuffix = stderr.trim()
      ? ` Recent stderr: ${stderr.trim().slice(-1000)}`
      : '';
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
  fetchModels: ({ hostRuntime, resolvedPaths, timeoutMs }) =>
    fetchQwenModelsFromAcp({
      resolvedPaths,
      cwd: hostRuntime.appRootPath || process.cwd(),
      timeoutMs,
    }),
  validateStoredConnection: async () => ({
    success: true,
    shouldRefreshModels: true,
  }),
  testConnection: async () => null,
};
