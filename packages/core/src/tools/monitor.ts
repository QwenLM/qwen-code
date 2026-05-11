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
import path from 'node:path';
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
  detectCommandSubstitution,
  getCommandRoot,
  getShellConfiguration,
  hasUnsafeMonitorBackgroundOperator,
  normalizeMonitorCommand as normalizeMonitorShellCommand,
  splitCommands,
} from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isSubpaths } from '../utils/paths.js';
import type { MonitorEntry } from '../services/monitorRegistry.js';
import { MAX_CONCURRENT_MONITORS } from '../services/monitorRegistry.js';
import {
  extractCommandRules,
  isShellCommandReadOnlyAST,
} from '../utils/shellAstParser.js';
import { getCurrentAgentId } from '../agents/runtime/agent-context.js';

const debugLogger = createDebugLogger('MONITOR');

const DEFAULT_MAX_EVENTS = 1000;
const MAX_MAX_EVENTS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_IDLE_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_DISPLAY_DESCRIPTION_LENGTH = 80;
const PARTIAL_LINE_BUFFER_CAP = 4096;

// Throttling constants (token bucket)
const THROTTLE_BURST_SIZE = 5;
const THROTTLE_REFILL_INTERVAL_MS = 1000; // 1 token per second

function truncateDisplayDescription(description: string): string {
  return description.length > MAX_DISPLAY_DESCRIPTION_LENGTH
    ? description.slice(0, MAX_DISPLAY_DESCRIPTION_LENGTH - 1) + '…'
    : description;
}

// Tag names that form the structural <task-notification> envelope. If any of
// these appear verbatim inside untrusted monitor output (logs, server stdout,
// etc.) and downstream rendering ever skips XML escaping, an attacker could
// spoof a notification boundary or inject fake task metadata. We defang them
// by inserting a zero-width space (U+200B) immediately after the `<` (or
// `</`), which is invisible in display but breaks the tag from a parser's
// perspective.
const STRUCTURAL_ENVELOPE_TAGS = new Set([
  'task-notification',
  'task-id',
  'tool-use-id',
  'kind',
  'status',
  'event-count',
  'summary',
  'result',
]);

const STRUCTURAL_TAG_REGEX = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)>/g;

/**
 * Sanitize a single monitor output line before it is forwarded to the model.
 *
 * Two defenses, in order:
 *   1. Strip C0 control characters (0x00–0x1F) except tab (0x09) and C1
 *      control characters (0x80–0x9F). These can carry terminal escape
 *      sequences, NUL bytes, or framing characters that survive
 *      `strip-ansi` and may interfere with downstream rendering or
 *      transport.
 *   2. Defang structural envelope tag names (see `STRUCTURAL_ENVELOPE_TAGS`)
 *      by inserting a zero-width space after the `<` / `</`. This is a
 *      defense-in-depth measure: `escapeXml` in MonitorRegistry already
 *      protects the XML structure today, but if any future emission path
 *      forgets to escape, untrusted log content cannot spoof a
 *      `</task-notification>` boundary or fabricate a sibling notification.
 *
 * Exported for unit testing.
 */
export function sanitizeMonitorLine(line: string): string {
  let cleaned = '';
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x09) {
      cleaned += line[i];
      continue;
    }
    if (code < 0x20) continue; // C0 controls (NUL, BEL, ESC, etc.)
    if (code >= 0x80 && code <= 0x9f) continue; // C1 controls
    cleaned += line[i];
  }

  cleaned = cleaned.replace(STRUCTURAL_TAG_REGEX, (match, slash, tagName) => {
    if (!STRUCTURAL_ENVELOPE_TAGS.has(String(tagName).toLowerCase())) {
      return match;
    }
    return slash === '/' ? `</\u200B${tagName}>` : `<\u200B${tagName}>`;
  });

  return cleaned;
}

export interface MonitorToolParams {
  command: string;
  description?: string;
  max_events?: number;
  idle_timeout_ms?: number;
  directory?: string;
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
    const desc =
      this.params.description ||
      normalizeMonitorShellCommand(this.params.command).spawnCommand;
    return `Monitor: ${truncateDisplayDescription(desc)}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    const command = normalizeMonitorShellCommand(
      this.params.command,
    ).safetyCommand;

    if (detectCommandSubstitution(command)) {
      return 'deny';
    }

    try {
      const isReadOnly = await isShellCommandReadOnlyAST(command);
      if (isReadOnly) {
        return 'allow';
      }
    } catch (e) {
      debugLogger.warn('AST read-only check failed, falling back to ask:', e);
    }

    return 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const normalized = normalizeMonitorShellCommand(this.params.command);
    const subCommands = splitCommands(normalized.safetyCommand);
    const confirmableSubCommands: string[] = [];

    for (const sub of subCommands) {
      // Only filter out read-only commands via AST analysis.
      // We intentionally do NOT consult pm.isCommandAllowed() here because
      // that evaluates under 'run_shell_command' context, which would let
      // existing Bash(...) allow rules shrink the monitor confirmation scope.
      // Monitor is a long-running background process with a different risk
      // profile than one-shot shell execution and should maintain its own
      // permission boundary.
      let isReadOnly = false;
      try {
        isReadOnly = await isShellCommandReadOnlyAST(sub);
      } catch (e) {
        // Conservative fallback: if AST analysis fails, keep the sub-command
        // in the confirmation scope instead of accidentally dropping it.
        debugLogger.warn(
          'AST read-only check failed for monitor sub-command, falling back to ask:',
          e,
        );
      }

      if (isReadOnly) {
        continue;
      }

      confirmableSubCommands.push(sub);
    }

    const effectiveSubCommands =
      confirmableSubCommands.length > 0 ? confirmableSubCommands : subCommands;
    const rootCommands = [
      ...new Set(
        effectiveSubCommands
          .map((sub) => getCommandRoot(sub))
          .filter((sub): sub is string => !!sub),
      ),
    ];

    let permissionRules: string[] = [];
    try {
      const allRules: string[] = [];
      for (const sub of effectiveSubCommands) {
        const rules = await extractCommandRules(sub);
        allRules.push(...rules);
      }
      permissionRules = [...new Set(allRules)].map(
        (rule) => `Monitor(${rule})`,
      );
    } catch (e) {
      debugLogger.warn('Failed to extract monitor command rules:', e);
      permissionRules = [`Monitor(${normalized.safetyCommand})`];
    }

    return {
      type: 'exec',
      title: 'Monitor',
      command: normalized.spawnCommand,
      rootCommand:
        rootCommands.join(', ') ||
        (getCommandRoot(normalized.safetyCommand) ?? normalized.spawnCommand),
      permissionRules,
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

    const normalized = normalizeMonitorShellCommand(this.params.command);
    const command = normalized.spawnCommand;
    if (normalized.strippedTrailingAmp) {
      debugLogger.warn(
        'Stripped trailing & from monitor command — monitor lifecycle handles backgrounding',
      );
    }
    const description = sanitizeMonitorLine(this.params.description || command);
    const displayDescription = truncateDisplayDescription(description);
    const maxEvents = Math.min(
      this.params.max_events ?? DEFAULT_MAX_EVENTS,
      MAX_MAX_EVENTS,
    );
    const idleTimeoutMs = Math.min(
      this.params.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    );

    const monitorId = `mon_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const registry = this.config.getMonitorRegistry();
    const ownerAgentId = getCurrentAgentId() ?? undefined;

    // Check concurrent monitor limit before spawning
    const running = registry.getRunning();
    if (running.length >= MAX_CONCURRENT_MONITORS) {
      return {
        llmContent: `Cannot start monitor: maximum concurrent monitors (${MAX_CONCURRENT_MONITORS}) reached. Stop an existing monitor first.`,
        returnDisplay: `Monitor rejected: too many concurrent monitors.`,
      };
    }

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
      droppedLines: 0,
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };

    // Spawn the process
    const { executable, argsPrefix } = getShellConfiguration();
    let child;
    try {
      child = spawn(executable, [...argsPrefix, command], {
        cwd: this.params.directory || this.config.getTargetDir(),
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
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(err)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(err)}`,
      };
    }

    entry.pid = child.pid;
    let exited = false;

    // Capture async spawn errors (ENOENT, EACCES, etc.) during the window
    // before the real error handler is attached at the end of this method.
    let earlySpawnError: Error | undefined;
    const captureEarlySpawnError = (err: Error): void => {
      earlySpawnError ??= err;
    };
    child.on('error', captureEarlySpawnError);

    // ----- Line buffering & throttling state ---------------------------------
    // Declared up-front (before `abortHandler`) so that the synchronous abort
    // path — either `entryAc.signal.aborted` already true at registration
    // time, or `registry.register()` throwing — can flush via
    // `flushPartialLineBuffers` without hitting a TDZ ReferenceError.
    const stdoutBuf = { value: '' };
    const stderrBuf = { value: '' };
    let tokenBucket = THROTTLE_BURST_SIZE;
    let lastRefill = Date.now();

    const throttledEmit = (line: string): void => {
      // Apply prompt-injection defenses uniformly across every emission
      // path (live data, partial-line force-flush, cleanup flush). Empty
      // lines after sanitization consume no throttle budget.
      const sanitized = sanitizeMonitorLine(line);
      if (sanitized.length === 0 || sanitized.trim().length === 0) return;

      // Refill tokens
      const now = Date.now();
      const elapsed = now - lastRefill;
      if (elapsed < 0) {
        // Clock went backwards (suspend/resume, NTP); reset to avoid
        // starving the bucket until the clock catches up.
        // Note: logged to debug file only; no operator-visible output.
        // If throttled line drops are observed without an active debug
        // session, clock anomaly vs. genuine rate limiting cannot be
        // distinguished from the notification alone.
        debugLogger.warn(
          `Monitor ${monitorId}: clock moved backwards by ${-elapsed}ms, resetting refill timestamp`,
        );
        lastRefill = now;
      } else {
        const newTokens = Math.floor(elapsed / THROTTLE_REFILL_INTERVAL_MS);
        if (newTokens > 0) {
          tokenBucket = Math.min(THROTTLE_BURST_SIZE, tokenBucket + newTokens);
          lastRefill += newTokens * THROTTLE_REFILL_INTERVAL_MS;
        }
      }

      if (tokenBucket > 0) {
        tokenBucket--;
        registry.emitEvent(monitorId, sanitized);
      } else {
        entry.droppedLines++;
      }
    };

    // Flush any buffered partial lines via the throttled path. Called from
    // both the abort handler (before the registry settles to 'cancelled',
    // while emitEvent still accepts events) and from `cleanup()` (which
    // covers natural exit / error paths). Idempotent: clears each buffer
    // after flushing.
    const flushPartialLineBuffers = (): void => {
      for (const buf of [stdoutBuf, stderrBuf]) {
        const trimmed = buf.value.trim();
        if (trimmed.length > 0) {
          throttledEmit(trimmed);
        }
        buf.value = '';
      }
    };

    const killChildProcessGroup = (): void => {
      if (exited || !child.pid) return;

      if (process.platform === 'win32') {
        const tk = spawn(
          'taskkill',
          ['/pid', child.pid.toString(), '/f', '/t'],
          { stdio: 'ignore' },
        );
        tk.on('error', (err) =>
          debugLogger.warn(
            `Monitor taskkill failed for pid ${child.pid}: ${getErrorMessage(err)}`,
          ),
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (err) {
          debugLogger.warn(
            `Monitor ${monitorId} SIGTERM failed (pid=${child.pid}): ${getErrorMessage(err)}`,
          );
        }
        setTimeout(() => {
          if (!exited && child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (err) {
              debugLogger.warn(
                `Monitor ${monitorId} SIGKILL escalation failed (pid=${child.pid}): ${getErrorMessage(err)}`,
              );
            }
          }
        }, 200).unref?.();
      }
    };

    // Wire abort → kill process (tree) before exposing the entry via register().
    // We also flush any buffered partial lines BEFORE the kill: by the time
    // `cancel()` calls `settle()`, the entry status flips to 'cancelled' and
    // `emitEvent` no-ops, so a flush deferred to the post-exit `cleanup()`
    // would be silently dropped. Flushing here preserves the last partial
    // line(s) the child wrote between the abort signal and process exit.
    const abortHandler = (): void => {
      flushPartialLineBuffers();
      killChildProcessGroup();
    };
    entryAc.signal.addEventListener('abort', abortHandler, { once: true });
    if (entryAc.signal.aborted) {
      abortHandler();
    }

    try {
      registry.register(entry);
    } catch (err) {
      abortHandler();
      entryAc.signal.removeEventListener('abort', abortHandler);
      (
        child.stdout as { destroy?: () => void } | null | undefined
      )?.destroy?.();
      (
        child.stderr as { destroy?: () => void } | null | undefined
      )?.destroy?.();
      child.removeListener('error', captureEarlySpawnError);
      child.on('error', () => {});
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(err)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(err)}`,
      };
    }

    const processLines = (buffer: { value: string }, data: Buffer): void => {
      if (entry.status !== 'running') return;

      const text = stripAnsi(data.toString('utf-8'));
      buffer.value += text;

      // Guard against unbounded partial-line accumulation. If a command emits
      // a long stream without newlines, buffer.value would otherwise grow
      // without bound and each chunk would re-split the entire string.
      // When no newline has arrived yet and the buffer has already exceeded
      // PARTIAL_LINE_BUFFER_CAP, force-emit a single truncated event through the
      // throttled path and reset the buffer so it cannot keep growing.
      if (
        !buffer.value.includes('\n') &&
        buffer.value.length > PARTIAL_LINE_BUFFER_CAP
      ) {
        const trimmed = buffer.value.trim();
        if (trimmed.length > 0) {
          throttledEmit(trimmed.slice(0, PARTIAL_LINE_BUFFER_CAP) + '...');
        }
        buffer.value = '';
        return;
      }

      const lines = buffer.value.split('\n');
      buffer.value = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const truncated =
          trimmed.length > PARTIAL_LINE_BUFFER_CAP
            ? trimmed.slice(0, PARTIAL_LINE_BUFFER_CAP) + '...'
            : trimmed;
        throttledEmit(truncated);
      }
    };

    child.stdout?.on('data', (data: Buffer) => processLines(stdoutBuf, data));
    child.stderr?.on('data', (data: Buffer) => processLines(stderrBuf, data));

    // Shared cleanup: flush buffers, remove abort listener, log dropped lines.
    // Called from `close` after stdio streams drain, and from `error` when no
    // close event is guaranteed (e.g. ENOENT).
    //
    // The flush is unconditional (no `entry.status === 'running'` guard):
    //   - For natural exit / error paths the status is still 'running' here,
    //     so the flush emits via the throttled path as before.
    //   - For external cancel paths the buffers were already flushed in
    //     `abortHandler` (so this is a no-op) but removing the guard keeps
    //     cleanup defensive against future status-flip races.
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;

      flushPartialLineBuffers();

      entryAc.signal.removeEventListener('abort', abortHandler);

      if (entry.droppedLines > 0) {
        debugLogger.info(
          `Monitor ${monitorId} dropped ${entry.droppedLines} lines due to throttling`,
        );
      }
    };

    let exitResult: { code: number | null; sig: NodeJS.Signals | null } | null =
      null;

    const settleFromExit = (
      code: number | null,
      sig: NodeJS.Signals | null,
    ): void => {
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
    };

    const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
      exited = true;
      exitResult = { code, sig };
    };

    const onClose = (code: number | null, sig: NodeJS.Signals | null): void => {
      exited = true;
      cleanup();

      const result = exitResult ?? { code, sig };
      settleFromExit(result.code, result.sig);
    };

    const onError = (err: Error): void => {
      exited = true;
      cleanup();
      if (entry.status === 'running') {
        registry.fail(monitorId, getErrorMessage(err));
      }
    };

    child.on('exit', onExit);
    child.on('close', onClose);
    child.on('error', onError);
    child.removeListener('error', captureEarlySpawnError);

    if (earlySpawnError) {
      onError(earlySpawnError);
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(earlySpawnError)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(earlySpawnError)}`,
      };
    }

    return {
      llmContent:
        `Monitor started.\n` +
        `id: ${monitorId}\n` +
        `command: ${command}\n` +
        `description: ${description}\n` +
        `max_events: ${maxEvents}\n` +
        `idle_timeout: ${idleTimeoutMs}ms\n` +
        `Events will be delivered as notifications. ` +
        `The monitor auto-stops after ${maxEvents} events or ${idleTimeoutMs}ms of silence.\n` +
        `To inspect: /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter — detail view + live updates).`,
      returnDisplay: `Monitor started: ${displayDescription} (${monitorId})`,
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
      'Starts a long-running shell command and streams its stdout/stderr as event notifications back to you.\n\n' +
        'Use this tool for:\n' +
        '- Watching log files: `tail -f /var/log/app.log`\n' +
        '- Monitoring build output: `npm run build --watch`\n' +
        '- Polling for state changes: `while true; do curl -s http://localhost:8080/health; sleep 1; done`\n' +
        '- Watching file changes: `fswatch -r ./src`\n\n' +
        'Each output line from the command becomes a notification event delivered to you. ' +
        'The monitor runs in the background — you can continue working while it streams events.\n\n' +
        '**Auto-stop:** The monitor automatically stops after max_events (default 1000) events ' +
        'or after idle_timeout_ms (default 5 minutes) of silence. The process is killed when the monitor stops.\n\n' +
        '**Do NOT use this tool for:**\n' +
        '- One-shot commands (use run_shell_command instead)\n' +
        '- Commands you need the full output from (use run_shell_command instead)\n' +
        '- Commands with no output (use run_shell_command with is_background: true instead)',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run and monitor. Each output line (stdout and stderr) becomes an event notification.',
          },
          description: {
            type: 'string',
            description:
              'Brief description of what this monitor watches (e.g., "webpack build output"). Truncated to 80 characters in display.',
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
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be within the workspace.',
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
    if (
      typeof params.command !== 'string' ||
      !normalizeMonitorShellCommand(params.command).analysisCommand
    ) {
      return 'Command cannot be empty.';
    }
    if (hasUnsafeMonitorBackgroundOperator(params.command)) {
      return 'Monitor commands must not contain non-final top-level background operators. Remove "&" and let the monitor manage process lifetime.';
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
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return 'Directory must be an absolute path.';
      }
      const resolvedDirectoryPath = path.resolve(params.directory);
      const userSkillsDirs = this.config.storage.getUserSkillsDirs();
      if (isSubpaths(userSkillsDirs, resolvedDirectoryPath)) {
        return 'Explicitly running monitor commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.';
      }
      // Use WorkspaceContext.isPathWithinWorkspace so the check canonicalises
      // the path, resolves symlinks, and matches on path segments rather than
      // raw string prefix (prevents e.g. '/tmp/project-evil' from slipping
      // past a '/tmp/project' workspace).
      const ws = this.config.getWorkspaceContext();
      if (!ws.isPathWithinWorkspace(params.directory)) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
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
