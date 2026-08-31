/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeModeBindingPlan } from '../tools/code-mode.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import type {
  CodeModeToolResult,
  ToolCallRuntimeContext,
} from './tool-call-runtime.js';
import {
  CODE_MODE_MAX_FRAME_BYTES,
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_MAX_SOURCE_CHARS,
  CODE_MODE_TIMEOUT_MS,
  encodeFrame,
  FrameDecoder,
  type CompleteMessage,
  type HostMessage,
  type ParentMessage,
} from './protocol.js';

const CODE_MODE_HOST_STARTUP_GRACE_MS = 5000;

export interface CodeModeExecutionResult {
  output: string;
  value?: unknown;
  content?: Array<{ type: 'image' | 'audio'; value: unknown }>;
}

function hostCommand(): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  if (currentFile.endsWith('.ts')) {
    const require = createRequire(import.meta.url);
    return {
      command: process.execPath,
      args: [
        '--import',
        require.resolve('tsx'),
        path.join(path.dirname(currentFile), 'host.ts'),
      ],
    };
  }
  const sibling = path.join(path.dirname(currentFile), 'host.js');
  if (existsSync(sibling)) {
    return { command: process.execPath, args: [sibling] };
  }
  return {
    command: process.execPath,
    args: [path.join(resolveBundleDir(import.meta.url), 'codeModeHost.js')],
  };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
}

function boundedToolResult(result: CodeModeToolResult): CodeModeToolResult {
  const bounded = {
    ...result,
    output: result.output.slice(0, CODE_MODE_MAX_OUTPUT_CHARS),
  };
  try {
    if (
      Buffer.byteLength(JSON.stringify(bounded)) <=
      CODE_MODE_MAX_FRAME_BYTES / 2
    ) {
      return bounded;
    }
  } catch {
    // Fall through to the text-only representation.
  }
  return { ...bounded, content: undefined };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Code mode execution was cancelled.');
}

export async function executeCodeMode(
  source: string,
  plan: CodeModeBindingPlan,
  runtime: ToolCallRuntimeContext,
  signal: AbortSignal,
  options: {
    timeoutMs?: number;
    maxOutputChars?: number;
  } = {},
): Promise<CodeModeExecutionResult> {
  if (source.length > CODE_MODE_MAX_SOURCE_CHARS) {
    throw new Error('JavaScript source exceeds the size limit.');
  }
  if (signal.aborted) throw abortReason(signal);

  const command = hostCommand();
  const timeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? CODE_MODE_TIMEOUT_MS),
    CODE_MODE_TIMEOUT_MS,
  );
  const maxOutputChars = Math.min(
    Math.max(1, options.maxOutputChars ?? CODE_MODE_MAX_OUTPUT_CHARS),
    CODE_MODE_MAX_OUTPUT_CHARS,
  );
  const child = spawn(command.command, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(),
  });
  const byJsName = new Map(
    plan.bindings.map((item) => [item.jsName, item.name]),
  );
  const decoder = new FrameDecoder<HostMessage>();
  const nestedControllers = new Map<string, AbortController>();
  let stderr = '';
  let completed: CompleteMessage | undefined;
  let protocolError: Error | undefined;

  const send = (message: ParentMessage): void => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(encodeFrame(message));
    }
  };
  const cancelNested = (reason: unknown): void => {
    for (const controller of nestedControllers.values())
      controller.abort(reason);
    nestedControllers.clear();
  };
  const onAbort = () => {
    cancelNested(abortReason(signal));
    terminate(child);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8192)
      stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
  });
  child.stdin.on('error', (error) => {
    if (!completed && !protocolError) protocolError = error;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.type === 'complete') {
          completed = message;
          cancelNested(
            new Error(
              'The exec program finished before this call was awaited.',
            ),
          );
          child.stdin.end();
          continue;
        }
        if (message.type === 'error') {
          protocolError = new Error(message.error);
          child.stdin.end();
          continue;
        }
        const actualName = byJsName.get(message.name);
        if (!actualName) {
          send({
            type: 'tool_result',
            id: message.id,
            ok: false,
            error: `Tool "${message.name}" is not available in code mode.`,
          });
          continue;
        }
        const controller = new AbortController();
        nestedControllers.set(message.id, controller);
        void runtime
          .dispatch(actualName, message.args, controller.signal)
          .then((result) =>
            send({
              type: 'tool_result',
              id: message.id,
              ok: true,
              result: boundedToolResult(result),
            }),
          )
          .catch((error) =>
            send({
              type: 'tool_result',
              id: message.id,
              ok: false,
              error: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, CODE_MODE_MAX_OUTPUT_CHARS),
            }),
          )
          .finally(() => nestedControllers.delete(message.id));
      }
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
      terminate(child);
    }
  });

  const wallTimer = setTimeout(() => {
    protocolError = new Error(
      `JavaScript execution timed out after ${timeoutMs}ms.`,
    );
    cancelNested(protocolError);
    terminate(child);
  }, timeoutMs + CODE_MODE_HOST_STARTUP_GRACE_MS);

  try {
    send({
      type: 'execute',
      source,
      tools: plan.bindings.map(({ name, jsName, description, deferred }) => ({
        name,
        jsName,
        description,
        deferred,
      })),
      timeoutMs,
      maxOutputChars,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } finally {
    clearTimeout(wallTimer);
    signal.removeEventListener('abort', onAbort);
    cancelNested(new Error('Code mode runtime stopped.'));
    terminate(child);
  }

  if (signal.aborted) throw abortReason(signal);
  if (protocolError) throw protocolError;
  if (!completed) {
    throw new Error(
      `Code mode host exited without a result${stderr ? `: ${stderr}` : '.'}`,
    );
  }
  return {
    output: completed.output,
    ...(completed.value === undefined ? {} : { value: completed.value }),
    ...(completed.content === undefined ? {} : { content: completed.content }),
  };
}
