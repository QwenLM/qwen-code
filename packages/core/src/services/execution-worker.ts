/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Config } from '../config/config.js';
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
  const config = new Config({
    targetDir: options.workspace,
    cwd: options.workspace,
    sessionId: options.sessionId,
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
  });
  if (options.outputDirectory) {
    config.storage.getProjectTempDir = () => options.outputDirectory!;
    config.storage.getToolResultsDir = () => options.outputDirectory!;
  }
  return new LocalExecutionEnvironment(config);
}

export async function runExecutionWorker(
  environment: ExecutionEnvironment,
  input: Readable,
  output: Writable,
): Promise<void> {
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
    switch (request.method) {
      case 'prepare':
        return environment.prepare(request.request, signal);
      case 'permission':
        return environment.permission(request.invocationId, signal);
      case 'confirmation':
        return environment.confirmation(request.invocationId, signal);
      case 'confirm':
        return environment.confirm(
          request.invocationId,
          request.outcome,
          request.payload,
          signal,
        );
      case 'execute':
        return environment.execute(request.invocationId, signal, (update) =>
          reply({ id, update }),
        );
      case 'modificationContent':
        return environment.modificationContent(
          request.toolName,
          request.params,
          signal,
        );
      case 'release':
        return environment.release(request.invocationId, signal);
      case 'invalidateReadCache':
        return environment.invalidateReadCache(request.paths);
      case 'dispose':
        return environment.dispose();
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
    for (const request of requests.values()) request.controller.abort();
    await environment.dispose();
    await Promise.allSettled(
      [...requests.values()].map((request) => request.completion),
    );
    lines.close();
  }
}
