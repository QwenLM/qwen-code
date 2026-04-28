/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Monitor tool — spawns a long-running shell command and streams
 * its stdout lines back to the agent as event notifications.
 *
 * Use cases: watching log files (`tail -f`), monitoring build output,
 * polling for state changes, watching file changes.
 *
 * The monitor runs in the background. Each stdout line (after throttling)
 * becomes a `<task-notification>` delivered to the agent when idle.
 * Auto-stops after max_events or idle_timeout_ms of silence.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import stripAnsi from 'strip-ansi';
import type { Config } from '../config/config.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  getCommandRoot,
  getShellConfiguration,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { MonitorEntry } from '../services/monitorRegistry.js';

const debugLogger = createDebugLogger('MONITOR');

const DEFAULT_MAX_EVENTS = 1000;
const MAX_MAX_EVENTS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_IDLE_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_LINE_LENGTH = 4096;

// Throttling constants (token bucket)
const THROTTLE_BURST_SIZE = 5;
const THROTTLE_REFILL_INTERVAL_MS = 1000; // 1 token per second

export interface MonitorToolParams {
  command: string;
  description?: string;
  max_events?: number;
  idle_timeout_ms?: number;
}

class MonitorToolInvocation extends BaseToolInvocation<
  MonitorToolParams,
  ToolResult
> {
  private callId?: string;

  constructor(
    private readonly config: Config,
    params: MonitorToolParams,
  ) {
    super(params);
  }

  setCallId(callId: string): void {
    this.callId = callId;
  }

  getDescription(): string {
    const desc = this.params.description || this.params.command;
    return `Monitor: ${desc}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const command = stripShellWrapper(this.params.command);
    const rootCommand = getCommandRoot(command) ?? command;

    return {
      type: 'exec',
      title: 'Monitor',
      command,
      rootCommand,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {},
    } satisfies ToolExecuteConfirmationDetails;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // Early-abort: if the turn was cancelled before we start, don't spawn.
    if (_signal.aborted) {
      return {
        llmContent: 'Monitor was cancelled before it could start.',
        returnDisplay: 'Monitor cancelled.',
      };
    }

    const command = this.params.command.trim();
    const description = this.params.description || command;
    const maxEvents = Math.min(
      this.params.max_events ?? DEFAULT_MAX_EVENTS,
      MAX_MAX_EVENTS,
    );
    const idleTimeoutMs = Math.min(
      this.params.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    );

    const monitorId = `mon_${randomUUID().slice(0, 8)}`;
    const registry = this.config.getMonitorRegistry();

    // Independent AbortController — pressing Ctrl+C on the current turn
    // should NOT kill a long-running monitor the user intentionally started.
    const entryAc = new AbortController();

    const entry: MonitorEntry = {
      monitorId,
      command,
      description,
      status: 'running',
      startTime: Date.now(),
      abortController: entryAc,
      toolUseId: this.callId,
      eventCount: 0,
      lastEventTime: 0,
      maxEvents,
      idleTimeoutMs,
    };

    // Spawn the process
    const { executable, argsPrefix } = getShellConfiguration();
    let child;
    try {
      child = spawn(executable, [...argsPrefix, command], {
        cwd: this.config.getTargetDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          QWEN_CODE: '1',
          TERM: 'dumb', // no color codes for streaming
          PAGER: 'cat',
        },
      });
    } catch (err) {
      registry.register(entry);
      registry.fail(monitorId, getErrorMessage(err));
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(err)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(err)}`,
      };
    }

    entry.pid = child.pid;
    registry.register(entry);

    // Line buffering (separate per stream to avoid interleave corruption)
    let tokenBucket = THROTTLE_BURST_SIZE;
    let lastRefill = Date.now();
    let droppedLines = 0;

    const throttledEmit = (line: string): void => {
      // Refill tokens
      const now = Date.now();
      const elapsed = now - lastRefill;
      const newTokens = Math.floor(elapsed / THROTTLE_REFILL_INTERVAL_MS);
      if (newTokens > 0) {
        tokenBucket = Math.min(THROTTLE_BURST_SIZE, tokenBucket + newTokens);
        lastRefill += newTokens * THROTTLE_REFILL_INTERVAL_MS;
      }

      if (tokenBucket > 0) {
        tokenBucket--;
        registry.emitEvent(monitorId, line);
      } else {
        droppedLines++;
      }
    };

    const processLines = (buffer: { value: string }, data: Buffer): void => {
      if (entry.status !== 'running') return;

      const text = stripAnsi(data.toString('utf-8'));
      buffer.value += text;
      const lines = buffer.value.split('\n');
      buffer.value = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const truncated =
          trimmed.length > MAX_LINE_LENGTH
            ? trimmed.slice(0, MAX_LINE_LENGTH) + '...'
            : trimmed;
        throttledEmit(truncated);
      }
    };

    const stdoutBuf = { value: '' };
    const stderrBuf = { value: '' };
    child.stdout?.on('data', (data: Buffer) => processLines(stdoutBuf, data));
    child.stderr?.on('data', (data: Buffer) => processLines(stderrBuf, data));

    let exited = false;

    child.on('exit', (code, sig) => {
      exited = true;
      // Flush remaining buffers
      for (const buf of [stdoutBuf, stderrBuf]) {
        if (buf.value.trim() && entry.status === 'running') {
          throttledEmit(buf.value.trim());
        }
        buf.value = '';
      }

      if (entry.status !== 'running') return; // already settled

      if (entryAc.signal.aborted) {
        registry.cancel(monitorId);
      } else if (code !== null && code !== 0) {
        registry.fail(monitorId, `Exit code ${code}`);
      } else if (sig) {
        registry.fail(monitorId, `Killed by signal ${sig}`);
      } else {
        registry.complete(monitorId, code);
      }

      if (droppedLines > 0) {
        debugLogger.info(
          `Monitor ${monitorId} dropped ${droppedLines} lines due to throttling`,
        );
      }
    });

    child.on('error', (err) => {
      exited = true;
      if (entry.status === 'running') {
        registry.fail(monitorId, getErrorMessage(err));
      }
    });

    // Wire abort → kill process (tree)
    const abortHandler = (): void => {
      if (!exited && child.pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // process may already be dead
          }
          setTimeout(() => {
            if (!exited && child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                // ignore
              }
            }
          }, 200);
        }
      }
    };
    entryAc.signal.addEventListener('abort', abortHandler, { once: true });

    // Clean up abort listener when process exits to prevent leaks
    child.on('exit', () => {
      entryAc.signal.removeEventListener('abort', abortHandler);
    });

    return {
      llmContent:
        `Monitor started.\n` +
        `id: ${monitorId}\n` +
        `command: ${command}\n` +
        `description: ${description}\n` +
        `max_events: ${maxEvents}\n` +
        `idle_timeout: ${idleTimeoutMs}ms\n` +
        `Events will be delivered as notifications. ` +
        `The monitor auto-stops after ${maxEvents} events or ${idleTimeoutMs}ms of silence.`,
      returnDisplay: `Monitor started: ${description} (${monitorId})`,
    };
  }
}

export class MonitorTool extends BaseDeclarativeTool<
  MonitorToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.MONITOR;

  constructor(private readonly config: Config) {
    super(
      MonitorTool.Name,
      ToolDisplayNames.MONITOR,
      'Starts a long-running shell command and streams its stdout as event notifications back to you.\n\n' +
        'Use this tool for:\n' +
        '- Watching log files: `tail -f /var/log/app.log`\n' +
        '- Monitoring build output: `npm run build --watch`\n' +
        '- Polling for state changes: `while true; do curl -s http://localhost:8080/health; sleep 1; done`\n' +
        '- Watching file changes: `fswatch -r ./src`\n\n' +
        'Each stdout line from the command becomes a notification event delivered to you. ' +
        'The monitor runs in the background — you can continue working while it streams events.\n\n' +
        '**Auto-stop:** The monitor automatically stops after max_events (default 1000) events ' +
        'or after idle_timeout_ms (default 5 minutes) of silence. The process is killed when the monitor stops.\n\n' +
        '**Do NOT use this tool for:**\n' +
        '- One-shot commands (use run_shell_command instead)\n' +
        '- Commands you need the full output from (use run_shell_command instead)\n' +
        '- Commands with no stdout output (use run_shell_command with is_background: true instead)',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run and stream stdout from. Each stdout line becomes an event notification.',
          },
          description: {
            type: 'string',
            description:
              'Brief description of what this monitor watches (e.g., "webpack build output"). Max 80 characters.',
          },
          max_events: {
            type: 'number',
            description:
              'Stop the monitor after this many events. Default 1000. Max 10000.',
          },
          idle_timeout_ms: {
            type: 'number',
            description:
              'Stop the monitor if no output for this many milliseconds. Default 300000 (5 min). Max 600000.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: MonitorToolParams,
  ): string | null {
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    if (params.max_events !== undefined) {
      if (
        typeof params.max_events !== 'number' ||
        !Number.isInteger(params.max_events) ||
        params.max_events <= 0
      ) {
        return 'max_events must be a positive integer.';
      }
      if (params.max_events > MAX_MAX_EVENTS) {
        return `max_events cannot exceed ${MAX_MAX_EVENTS}.`;
      }
    }
    if (params.idle_timeout_ms !== undefined) {
      if (
        typeof params.idle_timeout_ms !== 'number' ||
        !Number.isInteger(params.idle_timeout_ms) ||
        params.idle_timeout_ms <= 0
      ) {
        return 'idle_timeout_ms must be a positive integer.';
      }
      if (params.idle_timeout_ms > MAX_IDLE_TIMEOUT_MS) {
        return `idle_timeout_ms cannot exceed ${MAX_IDLE_TIMEOUT_MS}ms (10 minutes).`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: MonitorToolParams,
  ): ToolInvocation<MonitorToolParams, ToolResult> {
    return new MonitorToolInvocation(this.config, params);
  }
}
