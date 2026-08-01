/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn } from 'node:child_process';

/** Buffers streamed chunks and emits complete lines; the partial tail is kept. */
export class LineFramer {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts;
  }
}

export interface LogStream {
  stop(): void;
}

/**
 * Tail the gateway unit's journal, framing lines to `onLine`. The framing is
 * unit-tested (LineFramer); this spawn wrapper is operator-verified on Windows.
 */
export function streamLogs(
  distro: string | undefined,
  onLine: (line: string) => void,
  unit = 'qwen-rc-gateway',
): LogStream {
  const framer = new LineFramer();
  const args = [
    ...(distro ? ['-d', distro] : []),
    '--',
    'bash',
    '-lc',
    `journalctl --user -u ${unit} -f -n 100 --no-pager`,
  ];
  const child = spawn('wsl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (b: Buffer) => framer.push(b.toString('utf8')).forEach(onLine);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { stop: () => child.kill() };
}
