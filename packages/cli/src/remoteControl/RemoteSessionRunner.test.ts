/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  RemoteSessionRunner,
  type ChildProcessLike,
  type RunnerSpawnFn,
} from './RemoteSessionRunner.js';

class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  pid = 1234;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function collectWrites(stream: PassThrough): string[] {
  const writes: string[] = [];
  stream.on('data', (chunk: Buffer) => {
    writes.push(chunk.toString('utf8'));
  });
  return writes;
}

describe('RemoteSessionRunner', () => {
  it('spawns qwen in stream-json mode and writes initialize first', () => {
    const child = new FakeChildProcess();
    const writes = collectWrites(child.stdin);
    const spawnFn: RunnerSpawnFn = vi.fn(() => child);
    const runner = new RemoteSessionRunner({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/project',
      cliEntryPath: '/tmp/qwen/dist/index.js',
      model: 'qwen-test',
      permissionMode: 'default',
      spawnFn,
      onMessage: vi.fn(),
    });

    runner.start();

    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        '/tmp/qwen/dist/index.js',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--session-id',
        '11111111-1111-4111-8111-111111111111',
        '--model',
        'qwen-test',
        '--approval-mode',
        'default',
      ]),
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(JSON.parse(writes[0]).request.subtype).toBe('initialize');
  });

  it('writes user messages and tool responses to child stdin', () => {
    const child = new FakeChildProcess();
    const writes = collectWrites(child.stdin);
    const runner = new RemoteSessionRunner({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/project',
      cliEntryPath: '/tmp/qwen/dist/index.js',
      spawnFn: () => child,
      onMessage: vi.fn(),
    });

    runner.start();
    runner.submit('hello');
    runner.respondToTool({
      requestId: 'tool-req',
      behavior: 'allow',
    });

    const user = JSON.parse(writes[1]);
    const response = JSON.parse(writes[2]);
    expect(user.type).toBe('user');
    expect(user.message.content).toBe('hello');
    expect(response.response.request_id).toBe('tool-req');
    expect(response.response.response.behavior).toBe('allow');
  });

  it('parses child stdout JSONL messages', async () => {
    const child = new FakeChildProcess();
    const onMessage = vi.fn();
    const runner = new RemoteSessionRunner({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/project',
      cliEntryPath: '/tmp/qwen/dist/index.js',
      spawnFn: () => child,
      onMessage,
    });

    runner.start();
    child.stdout.write('{"type":"result","is_error":false}\n');

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        type: 'result',
        is_error: false,
      });
    });
  });
});
