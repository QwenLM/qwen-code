/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Config, deriveConfig } from '../config/config.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import type {
  ExecutionEnvironment,
  ExecutionWorkerMessage,
  ExecutionWorkerOptions,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from './execution-environment.js';
import { LocalExecutionEnvironment } from './local-execution-environment.js';

export function createExecutionWorkerEnvironment(
  options: ExecutionWorkerOptions,
): LocalExecutionEnvironment {
  const baseConfig = new Config({
    targetDir: options.workspace,
    cwd: options.workspace,
    sessionId: options.sessionId,
    approvalMode: options.approvalMode,
    permissions: options.permissions
      ? {
          allow: [...(options.permissions.allow ?? [])],
          ask: [...(options.permissions.ask ?? [])],
          deny: [...(options.permissions.deny ?? [])],
        }
      : undefined,
    debugMode: false,
    fileReadCacheDisabled: options.fileReadCacheDisabled,
    truncateToolOutputLines: options.truncateToolOutputLines,
    truncateToolOutputThreshold: options.truncateToolOutputThreshold,
    fileFiltering: options.fileFiltering,
    defaultFileEncoding: options.defaultFileEncoding,
    shellDefaultTimeoutMs: options.shellDefaultTimeoutMs,
    shellHeartbeatIntervalMs: options.shellHeartbeatIntervalMs,
    shellExecutionConfig: {
      maxBufferedOutputBytes: options.maxBufferedOutputBytes,
    },
    fileCheckpointingEnabled: false,
    shouldUseNodePtyShell: false,
    telemetry: { enabled: false },
    deferTelemetryInitialization: true,
    usageStatisticsEnabled: false,
    mcpServers: {},
    // The host does not register worker artifacts.
    artifactRecordingSupported: false,
  });
  // The worker is intentionally constructed without the host's full Config
  // lifecycle, but its file tools still need the same permission rules when
  // filtering search results. Initialise a worker-local manager over the
  // resolved rules and expose it through a narrow Config overlay.
  const permissionManager = new PermissionManager(baseConfig);
  permissionManager.initialize();
  const config = deriveConfig(baseConfig, {
    getPermissionManager: () => permissionManager,
  });
  if (options.outputDirectory) {
    config.storage.getProjectTempDir = () => options.outputDirectory!;
    config.storage.getToolResultsDir = () => options.outputDirectory!;
  }
  return new LocalExecutionEnvironment(config);
}

export async function runExecutionWorker(
  environmentOrFactory:
    | ExecutionEnvironment
    | ((options: Pick<ExecutionWorkerOptions, 'permissions' | 'approvalMode'>) =>
        ExecutionEnvironment),
  input: Readable,
  output: Writable,
): Promise<void> {
  let environment =
    typeof environmentOrFactory === 'function'
      ? undefined
      : environmentOrFactory;
  const requests = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const reply = (message: ExecutionWorkerReply) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const dispatch = (
    id: string,
    request: ExecutionWorkerRequest,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const activeEnvironment = environment;
    if (!activeEnvironment) throw new Error('Worker is not initialized.');
    switch (request.method) {
      case 'prepare':
        return activeEnvironment.prepare(request.request, signal);
      case 'permission':
        return activeEnvironment.permission(request.invocationId, signal);
      case 'confirmation':
        return activeEnvironment.confirmation(request.invocationId, signal);
      case 'confirm':
        return activeEnvironment.confirm(
          request.invocationId,
          request.outcome,
          request.payload,
          signal,
        );
      case 'execute':
        return activeEnvironment.execute(request.invocationId, signal, (update) =>
          reply({ id, update }),
        );
      case 'modificationContent':
        return activeEnvironment.modificationContent(
          request.toolName,
          request.params,
          signal,
        );
      case 'release':
        return activeEnvironment.release(request.invocationId, signal);
      case 'invalidateReadCache':
        return activeEnvironment.invalidateReadCache(request.paths);
      case 'dispose':
        return activeEnvironment.dispose();
      default:
        throw new Error('Unknown execution worker method.');
    }
  };
  try {
    for await (const line of lines) {
      const message: ExecutionWorkerMessage = JSON.parse(line);
      if ('cancel' in message) {
        requests.get(message.cancel)?.controller.abort();
        continue;
      }
      if ('initialize' in message) {
        if (environment || typeof environmentOrFactory !== 'function')
          throw new Error('Worker initialization must be the first message.');
        environment = environmentOrFactory(message.initialize);
        continue;
      }
      if (!environment) throw new Error('Worker is not initialized.');
      if (!message.id || requests.has(message.id))
        throw new Error('Invalid or duplicate worker request ID.');
      const controller = new AbortController();
      const completion = Promise.resolve()
        .then(() => dispatch(message.id, message.request, controller.signal))
        .then(
          (result) => reply({ id: message.id, result: result ?? null }),
          (error: unknown) =>
            reply({
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .finally(() => requests.delete(message.id));
      requests.set(message.id, { controller, completion });
    }
  } finally {
    if (environment) {
      for (const request of requests.values()) request.controller.abort();
      await environment.dispose();
      await Promise.allSettled(
        [...requests.values()].map((request) => request.completion),
      );
    }
    lines.close();
  }
}
