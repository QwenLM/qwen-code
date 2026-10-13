/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const moduleUrl = new URL('./flush-output.ts', import.meta.url).href;

describe('output completion through real OS pipes', () => {
  it('preserves distinct stdout/stderr tails after backpressure', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { once } from 'node:events';
      import { flushOutput } from ${JSON.stringify(moduleUrl)};
      const signal = new AbortController().signal;
      for (const [stream, byte, tail] of [[process.stdout, 65, 'OUT-TAIL'], [process.stderr, 66, 'ERR-TAIL']]) {
        if (!stream.write(Buffer.alloc(1024 * 1024, byte))) await once(stream, 'drain');
        stream.write(tail);
      }
      await Promise.all([flushOutput(process.stdout, signal), flushOutput(process.stderr, signal)]);
      process.exit(42);
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    const receive = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return Buffer.concat(chunks);
    };
    const [stdout, stderr, [code]] = await Promise.all([
      receive(child.stdout),
      receive(child.stderr),
      closed,
    ]);
    expect(code).toBe(42);
    expect(stdout).toEqual(
      Buffer.concat([Buffer.alloc(1024 * 1024, 65), Buffer.from('OUT-TAIL')]),
    );
    expect(stderr).toEqual(
      Buffer.concat([Buffer.alloc(1024 * 1024, 66), Buffer.from('ERR-TAIL')]),
    );
  });

  it('allows EPIPE cancellation when the downstream pipe closes', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { flushOutput } from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      process.stdout.on('error', (error) => {
        if (error.code !== 'EPIPE') throw error;
        controller.abort();
      });
      process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 65));
      await flushOutput(process.stdout, controller.signal);
      process.exit(controller.signal.aborted ? 141 : 0);
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    child.stdout.destroy();
    child.stderr.resume();
    const [code] = await closed;
    expect(code).toBe(141);
  });
});
