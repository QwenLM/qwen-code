/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ManagedChildRunSupervisor } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core/utils/sanitize-child-env.js';
import type {
  MonitorWatchExecutor,
  MonitorWatchHandle,
} from './hosted-monitor-loop.js';

// H3 of #12827: the managed-runtime worker's cgroup watch for one Monitor.
// It owns nothing the record owns: it spawns the watch command under a unit
// derived from the execution identity, splits stdout into the lines the
// observation loop buffers (with the Legacy partial-line cap), and reports
// the watch's physical end exactly once — natural exit versus mid-run
// failure. The durable capture keeps both streams byte-exact; only stdout
// carries observation lines — the Legacy watch's own discipline. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** A partial line beyond this many bytes is dropped, like the Legacy cap. */
const MONITOR_PARTIAL_LINE_CAP_BYTES = 4096;

export class ManagedMonitorWatcher implements MonitorWatchExecutor {
  constructor(private readonly supervisor: ManagedChildRunSupervisor) {}

  async start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean) => void,
    identity?: Parameters<MonitorWatchExecutor['start']>[3],
  ): Promise<MonitorWatchHandle> {
    const text = command['command'];
    if (typeof text !== 'string' || text.length === 0)
      throw new Error('Monitor watch names no command.');
    const shell = getShellConfiguration();
    const unitName = identity?.unitName ?? `qwen-mon-${randomUUID()}`;
    const cwd = identity?.cwd ?? process.cwd();
    // A StringDecoder keeps a multi-byte rune intact when a chunk ends
    // inside it; a blank line consumes no observation, like the Legacy
    // emit path, while onChunk carries the stdout raw.
    const decoder = new StringDecoder('utf8');
    let remainder = '';
    const watch = await this.supervisor.start({
      unitName,
      executable: shell.executable,
      args: [...shell.argsPrefix, text],
      env: sanitizeChildEnv(),
      cwd,
      onOutput: (stream, chunk) => {
        identity?.onChunk?.(stream, chunk);
        if (stream !== 'stdout') return;
        remainder += decoder.write(chunk);
        let at = remainder.indexOf('\n');
        while (at >= 0) {
          const line = remainder.slice(0, at);
          remainder = remainder.slice(at + 1);
          if (line.length > 0) onLine(line);
          at = remainder.indexOf('\n');
        }
        if (remainder.length > MONITOR_PARTIAL_LINE_CAP_BYTES) remainder = '';
      },
    });
    let exited = false;
    const end = (failed: boolean) => {
      if (exited) return;
      exited = true;
      remainder += decoder.end();
      if (remainder.length > 0) {
        onLine(remainder);
        remainder = '';
      }
      onExit(failed);
    };
    watch.child.once('exit', () => end(false));
    watch.child.once('error', () => end(true));
    // A watch faster than this await's continuation may have emitted its
    // exit already; the check phase is after every awaiting caller, so the
    // host still attaches before the end reports.
    if (watch.child.exitCode != null || watch.child.signalCode != null)
      setImmediate(() => end(false));
    return {
      receipt: {
        unitName,
        pid: watch.child.pid ?? 0,
        started: true,
      },
      process: watch,
      terminate: async () => {
        await watch.terminate(5_000);
      },
    };
  }
}
