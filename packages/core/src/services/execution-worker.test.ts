/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionEnvironment,
  ExecutionWorkerMessage,
  ExecutionWorkerReply,
  ExecutionWorkerOptions,
} from './execution-environment.js';
import {
  createExecutionWorkerEnvironment,
  runExecutionWorker,
} from './execution-worker.js';
import { ToolNames } from '../tools/tool-names.js';

describe('execution worker protocol', () => {
  it('preserves custom ignore rules and the encoding of newly written files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'execution-config-'));
    const environment = createExecutionWorkerEnvironment({
      workspace,
      sessionId: 'config-test',
      truncateToolOutputLines: 100,
      fileReadCacheDisabled: false,
      fileFiltering: {
        respectGitIgnore: true,
        respectQwenIgnore: true,
        customIgnoreFiles: ['.customignore'],
      },
      defaultFileEncoding: 'utf-8-bom',
    });
    const signal = new AbortController().signal;
    try {
      await writeFile(join(workspace, '.customignore'), 'hidden.txt\n');
      await writeFile(join(workspace, 'hidden.txt'), 'hidden');
      await writeFile(join(workspace, 'visible.txt'), 'visible');
      await environment.prepare(
        {
          id: 'glob',
          toolName: ToolNames.GLOB,
          params: { pattern: '*.txt', path: workspace },
        },
        signal,
      );
      const glob = await environment.execute('glob', signal);
      expect(glob.error).toBeUndefined();
      expect(glob.llmContent).toContain('visible.txt');
      expect(glob.llmContent).not.toContain('hidden.txt');
      const file = join(workspace, 'new.txt');
      await environment.prepare(
        {
          id: 'write',
          toolName: ToolNames.WRITE_FILE,
          params: { file_path: file, content: 'new content' },
        },
        signal,
      );
      expect(
        (await environment.execute('write', signal)).error,
      ).toBeUndefined();
      expect((await readFile(file)).subarray(0, 3).toString('hex')).toBe(
        'efbbbf',
      );
    } finally {
      await environment.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([undefined, 0, 40000])(
    'preserves default, disabled and explicit shell truncation (threshold=%s)',
    async (threshold) => {
      const workspace = await mkdtemp(join(tmpdir(), 'execution-truncation-'));
      const options: ExecutionWorkerOptions = {
        workspace,
        outputDirectory: workspace,
        sessionId: 'truncation-test',
        truncateToolOutputLines: 0,
        truncateToolOutputThreshold: threshold,
        fileReadCacheDisabled: false,
      };
      const environment = createExecutionWorkerEnvironment(
        JSON.parse(JSON.stringify(options)),
      );
      const signal = new AbortController().signal;
      try {
        await environment.prepare(
          {
            id: 'output',
            toolName: ToolNames.SHELL,
            params: {
              command: `node -e "process.stdout.write('x'.repeat(35000))"`,
              is_background: false,
            },
          },
          signal,
        );
        const result = await environment.execute('output', signal);
        expect(result.error).toBeUndefined();
        if (threshold === undefined) {
          expect(result.persistedOutputFiles).toHaveLength(1);
          expect(
            await readFile(result.persistedOutputFiles![0], 'utf8'),
          ).toContain('x'.repeat(35000));
        } else {
          expect(result.llmContent).toContain('x'.repeat(35000));
          expect(result.persistedOutputFiles ?? []).toHaveLength(0);
        }
      } finally {
        await environment.dispose();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it('keeps installation output readable by the primary worker after installation exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-output-'));
    const workspace = join(root, 'workspace');
    const outputDirectory = join(root, 'output');
    await mkdir(workspace);
    await mkdir(outputDirectory);
    const options = {
      workspace,
      outputDirectory,
      sessionId: 'output-test',
      truncateToolOutputLines: 100,
      truncateToolOutputThreshold: 1000,
      fileReadCacheDisabled: false,
    };
    const primary = createExecutionWorkerEnvironment(options);
    const install = createExecutionWorkerEnvironment({
      ...options,
      sessionId: 'install-test',
    });
    const signal = new AbortController().signal;
    try {
      await install.prepare(
        {
          id: 'install-log',
          toolName: ToolNames.SHELL,
          params: {
            command: `node -e "process.stdout.write('log-entry\\n'.repeat(6000))"`,
            is_background: false,
          },
        },
        signal,
      );
      const result = await install.execute('install-log', signal);
      const outputFile = result.persistedOutputFiles?.[0];
      expect(outputFile).toBeDefined();
      expect(outputFile).toMatch(outputDirectory);
      await install.dispose();
      expect(await readFile(outputFile!, 'utf8')).toContain(
        'log-entry\n'.repeat(6000),
      );
      await primary.prepare(
        {
          id: 'read-log',
          toolName: ToolNames.READ_FILE,
          params: { file_path: outputFile },
        },
        signal,
      );
      const read = await primary.execute('read-log', signal);
      expect(read.error).toBeUndefined();
      expect(read.llmContent).toContain('log-entry');
    } finally {
      await primary.dispose();
      await install.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps requests isolated, streams output, cancels by request ID, and disposes on EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const environment: ExecutionEnvironment = {
      prepare: vi.fn(),
      permission: vi.fn(),
      confirmation: vi.fn(),
      confirm: vi.fn(),
      modificationContent: vi.fn(),
      release: vi.fn(),
      invalidateReadCache: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(async (id, signal, update) => {
        update?.(`started:${id}`);
        if (id === 'long') {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled long')),
              { once: true },
            );
          });
        }
        if (id === 'bad') throw new Error('tool failed');
        return { llmContent: `done:${id}`, returnDisplay: `done:${id}` };
      }),
    };
    const waiting = new Map<string, (reply: ExecutionWorkerReply) => void>();
    const updates: ExecutionWorkerReply[] = [];
    let buffered = '';
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const reply: ExecutionWorkerReply = JSON.parse(
          buffered.slice(0, newline),
        );
        buffered = buffered.slice(newline + 1);
        if ('update' in reply) {
          updates.push(reply);
          if (reply.id === 'a')
            input.write(`${JSON.stringify({ cancel: 'a' })}\n`);
        } else {
          waiting.get(reply.id)?.(reply);
        }
      }
    });
    const running = runExecutionWorker(environment, input, output);
    const send = (message: Extract<ExecutionWorkerMessage, { id: string }>) =>
      new Promise<ExecutionWorkerReply>((resolve) => {
        waiting.set(message.id, resolve);
        input.write(`${JSON.stringify(message)}\n`);
      });
    const [cancelled, success, failure] = await Promise.all([
      send({ id: 'a', request: { method: 'execute', invocationId: 'long' } }),
      send({ id: 'b', request: { method: 'execute', invocationId: 'short' } }),
      send({ id: 'c', request: { method: 'execute', invocationId: 'bad' } }),
    ]);
    expect(cancelled).toEqual({ id: 'a', error: 'cancelled long' });
    expect(success).toEqual({
      id: 'b',
      result: { llmContent: 'done:short', returnDisplay: 'done:short' },
    });
    expect(failure).toEqual({ id: 'c', error: 'tool failed' });
    expect(updates).toContainEqual({ id: 'a', update: 'started:long' });
    expect(updates).toContainEqual({ id: 'b', update: 'started:short' });
    input.end();
    await running;
    expect(environment.dispose).toHaveBeenCalledOnce();
  });
});
