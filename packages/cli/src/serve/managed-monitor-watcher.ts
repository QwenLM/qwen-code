/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
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
// failure. The watch's retained output Artifact rides the output leg when
// that lands; stderr is discarded here, as only stdout carries
// observations — the Legacy watch's own discipline. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** A partial line beyond this many bytes is dropped, like the Legacy cap. */
const MONITOR_PARTIAL_LINE_CAP_BYTES = 4096;

export class ManagedMonitorWatcher implements MonitorWatchExecutor {
  constructor(private readonly supervisor: ManagedChildRunSupervisor) {}

  async start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean) => void,
    identity?: { readonly unitName: string; readonly cwd?: string },
  ): Promise<MonitorWatchHandle> {
    const text = command['command'];
    if (typeof text !== 'string' || text.length === 0)
      throw new Error('Monitor watch names no command.');
    const shell = getShellConfiguration();
    const unitName = identity?.unitName ?? `qwen-mon-${randomUUID()}`;
    const cwd = identity?.cwd ?? process.cwd();
    let remainder = '';
    const watch = await this.supervisor.start({
      unitName,
      executable: shell.executable,
      args: [...shell.argsPrefix, text],
      env: sanitizeChildEnv(),
      cwd,
      onOutput: (stream, chunk) => {
        if (stream !== 'stdout') return;
        remainder += chunk.toString('utf8');
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
    watch.child.once('exit', () => {
      if (remainder.length > 0) {
        onLine(remainder);
        remainder = '';
      }
      onExit(false);
    });
    watch.child.once('error', () => onExit(true));
    return {
      receipt: {
        unitName,
        pid: watch.child.pid ?? 0,
        started: true,
      },
      terminate: async () => {
        await watch.terminate(5_000);
      },
    };
  }
}
