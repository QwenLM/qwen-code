/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import type { CodeModeToolCatalog } from './code-mode-catalog.js';
import type { ToolCallRuntime } from './tool-call-runtime.js';

const MAX_SOURCE_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_NESTED_CALLS = 64;
const EXEC_TIMEOUT_MS = 10_000;

export interface CodeModeExecutionResult {
  outputs: string[];
  truncated: boolean;
}

function resolveWorkerPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(resolveBundleDir(import.meta.url), 'codeModeWorker.js'),
    path.join(moduleDir, 'code-mode-worker.js'),
    path.resolve(moduleDir, '../../dist/src/tools/code-mode-worker.js'),
  ];
  const workerPath = candidates.find((candidate) => existsSync(candidate));
  if (!workerPath) {
    throw new Error(
      'Code mode runtime worker is missing. Rebuild Qwen Code; insecure fallback is disabled.',
    );
  }
  return workerPath;
}

function boundedOutputs(outputs: unknown[]): CodeModeExecutionResult {
  const normalized = outputs.map((value) =>
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  const joined = normalized.join('\n');
  if (joined.length <= MAX_OUTPUT_CHARS) {
    return { outputs: normalized, truncated: false };
  }
  const half = Math.floor((MAX_OUTPUT_CHARS - 80) / 2);
  return {
    outputs: [
      `${joined.slice(0, half)}\n… code mode output truncated …\n${joined.slice(-half)}`,
    ],
    truncated: true,
  };
}

export async function executeCodeMode(
  source: string,
  parentCallId: string,
  catalog: CodeModeToolCatalog,
  runtime: ToolCallRuntime,
  signal: AbortSignal,
): Promise<CodeModeExecutionResult> {
  if (typeof source !== 'string') {
    throw new TypeError('Code mode source must be a string.');
  }
  if (source.length > MAX_SOURCE_CHARS) {
    throw new Error(`Code mode source exceeds ${MAX_SOURCE_CHARS} characters.`);
  }
  if (signal.aborted) throw signal.reason;

  const worker = new Worker(resolveWorkerPath(), {
    env: {},
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  worker.unref();
  const allowed = new Set(catalog.tools.map((tool) => tool.originalName));
  const active = new Map<string, AbortController>();
  let nestedCalls = 0;
  let settled = false;

  return new Promise<CodeModeExecutionResult>((resolve, reject) => {
    const finish = (error?: unknown, result?: CodeModeExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      for (const controller of active.values()) controller.abort(error);
      active.clear();
      const settle = () => {
        if (error !== undefined) reject(error);
        else resolve(result ?? { outputs: [], truncated: false });
      };
      void worker.terminate().then(settle, settle);
    };
    const onAbort = () =>
      finish(
        signal.reason ?? new DOMException('Code mode cancelled.', 'AbortError'),
      );
    const timeout = setTimeout(
      () =>
        finish(
          new DOMException(
            `Code mode execution timed out after ${EXEC_TIMEOUT_MS}ms.`,
            'TimeoutError',
          ),
        ),
      EXEC_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: Record<string, unknown>) => {
      if (message['type'] === 'completed') {
        const outputs = Array.isArray(message['outputs'])
          ? message['outputs']
          : [];
        finish(undefined, boundedOutputs(outputs));
        return;
      }
      if (message['type'] === 'failed') {
        finish(new Error(String(message['error'] ?? 'Code mode failed.')));
        return;
      }
      if (message['type'] !== 'tool-call') return;
      const id = String(message['id'] ?? '');
      const name = String(message['name'] ?? '');
      if (!id || !allowed.has(name)) {
        worker.postMessage({
          type: 'tool-result',
          id,
          error: `Tool ${JSON.stringify(name)} is not callable from code mode.`,
        });
        return;
      }
      nestedCalls++;
      if (nestedCalls > MAX_NESTED_CALLS) {
        worker.postMessage({
          type: 'tool-result',
          id,
          error: `Code mode is limited to ${MAX_NESTED_CALLS} nested tool calls.`,
        });
        return;
      }
      let args: unknown;
      try {
        args = JSON.parse(String(message['argsJson'] ?? ''));
      } catch {
        args = undefined;
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        worker.postMessage({
          type: 'tool-result',
          id,
          error: 'Tool arguments must be a JSON object.',
        });
        return;
      }
      const controller = new AbortController();
      active.set(id, controller);
      void runtime
        .dispatch({
          name,
          args: args as Record<string, unknown>,
          source: {
            kind: 'code_mode',
            parentCallId,
            nestedCallId: id,
          },
          signal: controller.signal,
        })
        .then(
          (result) => {
            if (!settled) {
              worker.postMessage({ type: 'tool-result', id, result });
            }
          },
          (error: unknown) => {
            if (!settled) {
              worker.postMessage({
                type: 'tool-result',
                id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        )
        .finally(() => active.delete(id));
    });
    worker.once('error', finish);
    worker.once('exit', (code) => {
      if (!settled) {
        finish(new Error(`Code mode worker exited unexpectedly (${code}).`));
      }
    });
    worker.postMessage({
      type: 'start',
      source,
      deadlineMs: EXEC_TIMEOUT_MS,
      tools: catalog.tools.map(({ name, originalName }) => ({
        name,
        originalName,
      })),
      allTools: catalog.tools.map(({ name, description }) => ({
        name,
        description,
      })),
    });
  });
}
