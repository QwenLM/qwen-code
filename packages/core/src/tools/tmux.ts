/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Tmux tool — creates and drives interactive terminal (tmux)
 * sessions running CLI programs (REPLs, agent CLIs, curses apps).
 *
 * Each created session is registered as a `kind: 'shell'` background task
 * carrying `terminal` metadata, so it appears in the task list, is
 * cancellable via task_stop / the daemon cancel route, and is attachable
 * from the Web Shell live terminal view.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  tmuxNewSession,
  tmuxGetFirstPaneId,
  tmuxSetOption,
  tmuxRespawnPane,
  tmuxPipePane,
  tmuxSendKeys,
  tmuxCapturePaneContent,
  tmuxKillSession,
  tmuxListPanes,
  tmuxHasSession,
  verifyTmux,
} from '../agents/backends/tmux-commands.js';
import type { ShellTask } from '../services/backgroundShellRegistry.js';

/** Dedicated tmux server socket for all tool-created sessions. */
export const TMUX_SERVER_NAME = 'qwen-serve';

const PANE_POLL_INTERVAL_MS = 500;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const MAX_CAPTURE_LINES = 2000;

type TmuxAction = 'create' | 'send' | 'capture' | 'list' | 'kill';

export interface TmuxToolParams {
  action: TmuxAction;
  session_id?: string;
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  keys?: string;
  enter?: boolean;
  literal?: boolean;
  lines?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorResult(message: string): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
  };
}

class TmuxToolInvocation extends BaseToolInvocation<
  TmuxToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: TmuxToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    switch (this.params.action) {
      case 'create':
        return `Tmux create: ${this.params.command ?? ''}`;
      case 'send':
        return `Tmux send → ${this.params.session_id ?? ''}`;
      case 'capture':
        return `Tmux capture: ${this.params.session_id ?? ''}`;
      case 'list':
        return 'Tmux list';
      case 'kill':
        return `Tmux kill: ${this.params.session_id ?? ''}`;
      default:
        return `Tmux ${this.params.action}`;
    }
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return this.params.action === 'capture' || this.params.action === 'list'
      ? 'allow'
      : 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Tmux',
      command: this.getDescription(),
      rootCommand: 'tmux',
      permissionRules: [`Tmux(${this.params.action})`],
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {},
    };
    return details;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    switch (this.params.action) {
      case 'create':
        return this.executeCreate();
      case 'send':
        return this.executeSend();
      case 'capture':
        return this.executeCapture();
      case 'list':
        return this.executeList();
      case 'kill':
        return this.executeKill();
      default:
        return errorResult(`Unknown tmux action: ${this.params.action}.`);
    }
  }

  private checkAvailability(): ToolResult | null {
    if (process.platform === 'win32') {
      return errorResult('The tmux tool is not supported on Windows.');
    }
    if (this.config.getSandbox()) {
      return errorResult(
        'The tmux tool is unavailable while the tool sandbox is active: tmux does not exist inside the sandbox container.',
      );
    }
    return null;
  }

  private findTerminalTask(
    sessionId: string,
  ): { entry: ShellTask } | { error: ToolResult } {
    const registry = this.config.getBackgroundShellRegistry();
    const entry = registry.get(sessionId);
    if (!entry || !entry.terminal) {
      return {
        error: errorResult(
          `No terminal session with id "${sessionId}". Use action=list to see live terminal sessions.`,
        ),
      };
    }
    return { entry };
  }

  private async executeCreate(): Promise<ToolResult> {
    const unavailable = this.checkAvailability();
    if (unavailable) return unavailable;

    try {
      await verifyTmux();
    } catch (err) {
      return errorResult(getErrorMessage(err));
    }

    const command = this.params.command!;
    const cwd = this.params.cwd ?? this.config.getTargetDir();
    const shellId = `bg_${randomBytes(4).toString('hex')}`;
    const tmuxSession = `qsh-${shellId}`;

    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      // Materialize the file so output readers never race the pipe's
      // first append.
      fs.closeSync(fs.openSync(outputPath, 'w'));
    } catch (err) {
      return errorResult(
        `Failed to prepare terminal output file: ${getErrorMessage(err)}`,
      );
    }

    // Sequence: create the session with a plain shell first so
    // remain-on-exit and the output pipe are in place BEFORE the real
    // command starts (a fast-exiting command must still leave a dead pane
    // with its exit status, and the pipe must not miss the banner).
    const paneId = await (async (): Promise<string> => {
      try {
        await tmuxNewSession(
          tmuxSession,
          {
            cols: this.params.cols ?? DEFAULT_COLS,
            rows: this.params.rows ?? DEFAULT_ROWS,
          },
          TMUX_SERVER_NAME,
        );
        const pane = await tmuxGetFirstPaneId(tmuxSession, TMUX_SERVER_NAME);
        await tmuxSetOption(pane, 'remain-on-exit', 'on', TMUX_SERVER_NAME);
        await tmuxPipePane(
          pane,
          `cat >> ${shellQuote(outputPath)}`,
          TMUX_SERVER_NAME,
        );
        await tmuxRespawnPane(
          pane,
          `cd ${shellQuote(cwd)} && ${command}`,
          TMUX_SERVER_NAME,
        );
        return pane;
      } catch (err) {
        await tmuxKillSession(tmuxSession, TMUX_SERVER_NAME).catch(() => {});
        throw err;
      }
    })().catch((err: unknown) => err as Error);
    if (paneId instanceof Error) {
      return errorResult(
        `Failed to create tmux session: ${getErrorMessage(paneId)}`,
      );
    }

    const registry = this.config.getBackgroundShellRegistry();
    // Independent AbortController — cancelling a turn must not kill an
    // intentionally started terminal; the abort listener is what kills
    // the tmux session (task_stop, daemon cancel route, shutdown).
    const entryAc = new AbortController();
    entryAc.signal.addEventListener(
      'abort',
      () => {
        void tmuxKillSession(tmuxSession, TMUX_SERVER_NAME).catch(() => {});
      },
      { once: true },
    );

    registry.register({
      shellId,
      command,
      cwd,
      status: 'running',
      startTime: Date.now(),
      abortController: entryAc,
      outputPath,
      terminal: { socket: TMUX_SERVER_NAME, tmuxSession },
    });

    // Settle the registry entry when the pane's process exits.
    const poll = setInterval(() => {
      void (async () => {
        const current = registry.get(shellId);
        if (!current || current.status !== 'running') {
          clearInterval(poll);
          return;
        }
        const settle = (): void => {
          clearInterval(poll);
          if (entryAc.signal.aborted) {
            registry.cancel(shellId, Date.now());
          } else {
            registry.fail(
              shellId,
              'tmux session ended unexpectedly',
              Date.now(),
            );
          }
        };
        try {
          if (!(await tmuxHasSession(tmuxSession, TMUX_SERVER_NAME))) {
            settle();
            return;
          }
          const panes = await tmuxListPanes(tmuxSession, TMUX_SERVER_NAME);
          const pane = panes.find((p) => p.paneId === paneId) ?? panes[0];
          if (!pane) {
            settle();
            return;
          }
          if (pane.dead) {
            clearInterval(poll);
            if (entryAc.signal.aborted) {
              registry.cancel(shellId, Date.now());
            } else if (pane.deadStatus === 0) {
              registry.complete(shellId, 0, Date.now());
            } else {
              registry.fail(
                shellId,
                `Exit code ${pane.deadStatus}`,
                Date.now(),
              );
            }
          }
        } catch {
          settle();
        }
      })();
    }, PANE_POLL_INTERVAL_MS);
    poll.unref?.();

    return {
      llmContent:
        `Terminal session created.\n` +
        `session_id: ${shellId}\n` +
        `command: ${command}\n` +
        `cwd: ${cwd}\n` +
        `tmux: tmux -L ${TMUX_SERVER_NAME} attach-session -t ${tmuxSession}\n` +
        `Use action=send to type into it, action=capture to read its screen, action=kill to stop it. ` +
        `The session runs in the background until the command exits or it is killed.`,
      returnDisplay: `Terminal started: ${command} (${shellId})`,
    };
  }

  private async executeSend(): Promise<ToolResult> {
    const found = this.findTerminalTask(this.params.session_id!);
    if ('error' in found) return found.error;
    const { entry } = found;
    if (entry.status !== 'running') {
      return errorResult(
        `Terminal session ${entry.shellId} is ${entry.status}; cannot send keys.`,
      );
    }
    const { socket, tmuxSession } = entry.terminal!;
    try {
      const paneId = await tmuxGetFirstPaneId(tmuxSession, socket);
      const keys = this.params.keys ?? '';
      if (this.params.literal && this.params.enter) {
        // send-keys -l would print "Enter" literally; send it separately.
        if (keys.length > 0) {
          await tmuxSendKeys(paneId, keys, { literal: true }, socket);
        }
        await tmuxSendKeys(paneId, 'Enter', {}, socket);
      } else {
        await tmuxSendKeys(
          paneId,
          keys,
          { literal: this.params.literal, enter: this.params.enter },
          socket,
        );
      }
    } catch (err) {
      return errorResult(
        `Failed to send keys to terminal ${entry.shellId}: ${getErrorMessage(err)}`,
      );
    }
    return {
      llmContent: `Keys sent to terminal ${entry.shellId}. Use action=capture to read the result.`,
      returnDisplay: `Keys sent (${entry.shellId})`,
    };
  }

  private async executeCapture(): Promise<ToolResult> {
    const found = this.findTerminalTask(this.params.session_id!);
    if ('error' in found) return found.error;
    const { entry } = found;
    const { socket, tmuxSession } = entry.terminal!;
    try {
      const paneId = await tmuxGetFirstPaneId(tmuxSession, socket);
      const lines = Math.min(this.params.lines ?? 0, MAX_CAPTURE_LINES);
      const content = await tmuxCapturePaneContent(paneId, socket, {
        includeEscapeCodes: false,
        ...(lines > 0 ? { scrollbackLines: lines } : {}),
      });
      const text = content.replace(/\n+$/, '');
      return {
        llmContent: text.length > 0 ? text : '(terminal screen is empty)',
        returnDisplay: `Captured terminal ${entry.shellId}`,
      };
    } catch (err) {
      return errorResult(
        `Failed to capture terminal ${entry.shellId}: ${getErrorMessage(err)}`,
      );
    }
  }

  private executeList(): ToolResult {
    const registry = this.config.getBackgroundShellRegistry();
    const terminals = registry.getAll().filter((e) => e.terminal);
    if (terminals.length === 0) {
      return {
        llmContent: 'No terminal sessions.',
        returnDisplay: 'No terminal sessions.',
      };
    }
    const lines = terminals.map(
      (e) =>
        `${e.shellId} [${e.status}] ${e.command} (cwd: ${e.cwd})` +
        (e.error ? ` — ${e.error}` : ''),
    );
    return {
      llmContent: lines.join('\n'),
      returnDisplay: `${terminals.length} terminal session(s)`,
    };
  }

  private async executeKill(): Promise<ToolResult> {
    const found = this.findTerminalTask(this.params.session_id!);
    if ('error' in found) return found.error;
    const { entry } = found;
    if (entry.status !== 'running') {
      return errorResult(
        `Terminal session ${entry.shellId} is already ${entry.status}.`,
      );
    }
    // requestCancel aborts the entry's AbortController; the abort listener
    // kills the tmux session and the pane poller settles the entry as
    // cancelled.
    this.config.getBackgroundShellRegistry().requestCancel(entry.shellId);
    return {
      llmContent: `Terminal session ${entry.shellId} killed.`,
      returnDisplay: `Terminal killed (${entry.shellId})`,
    };
  }
}

export class TmuxTool extends BaseDeclarativeTool<TmuxToolParams, ToolResult> {
  static readonly Name = ToolNames.TMUX;

  constructor(private readonly config: Config) {
    super(
      TmuxTool.Name,
      ToolDisplayNames.TMUX,
      'Creates and drives an interactive terminal (a tmux session) running a CLI program — REPLs, agent CLIs, curses/TUI apps — and returns each session as a background task.\n\n' +
        'Actions:\n' +
        '- create: start a new terminal running `command` (e.g. `bash`, `python3`, `claude`). Returns a session_id.\n' +
        '- send: type `keys` into a session (set enter=true to press Enter; literal=true to send text without interpreting key names).\n' +
        '- capture: read the session screen (optionally with `lines` of scrollback). Use after send to see the result.\n' +
        '- list: show all terminal sessions and their status.\n' +
        '- kill: stop a session.\n\n' +
        'The terminal keeps running in the background between calls, preserving full interactive state (prompts, scrollback, TUI redraws). The user can watch and type in the session live from the Web Shell terminal view.\n\n' +
        '**Do NOT use this tool for:**\n' +
        '- One-shot commands (use run_shell_command instead)\n' +
        '- Long-running non-interactive daemons (use run_shell_command with is_background: true instead)\n' +
        '- Streaming output lines to yourself (use the monitor tool instead)',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'send', 'capture', 'list', 'kill'],
            description: 'The terminal operation to perform.',
          },
          session_id: {
            type: 'string',
            description:
              'Terminal session id returned by create (bg_xxxxxxxx). Required for send, capture, kill.',
          },
          command: {
            type: 'string',
            description:
              'Shell command to run interactively in the new terminal. Required for create.',
          },
          cwd: {
            type: 'string',
            description:
              '(OPTIONAL) Working directory for the terminal. Defaults to the project root.',
          },
          cols: {
            type: 'integer',
            description: '(OPTIONAL) Terminal width. Default 200.',
          },
          rows: {
            type: 'integer',
            description: '(OPTIONAL) Terminal height. Default 50.',
          },
          keys: {
            type: 'string',
            description:
              'Text or key names to send (tmux send-keys syntax). Required for send.',
          },
          enter: {
            type: 'boolean',
            description: 'Send Enter after the keys. Default false.',
          },
          literal: {
            type: 'boolean',
            description:
              'Send keys literally (-l) without interpreting key names like Enter or C-c. Default false.',
          },
          lines: {
            type: 'integer',
            description:
              '(OPTIONAL) Scrollback lines to include in capture. Default: visible screen only. Max 2000.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — niche; surfaced via tool_search
      false, // alwaysLoad
      'tmux terminal interactive cli tui repl session',
    );
  }

  protected override validateToolParamValues(
    params: TmuxToolParams,
  ): string | null {
    switch (params.action) {
      case 'create':
        if (typeof params.command !== 'string' || !params.command.trim()) {
          return 'action=create requires a non-empty command.';
        }
        break;
      case 'send':
        if (!params.session_id) {
          return 'action=send requires session_id.';
        }
        if (params.keys === undefined && !params.enter) {
          return 'action=send requires keys (or enter=true).';
        }
        break;
      case 'capture':
      case 'kill':
        if (!params.session_id) {
          return `action=${params.action} requires session_id.`;
        }
        break;
      case 'list':
        break;
      default:
        break;
    }
    if (
      params.cols !== undefined &&
      (!Number.isInteger(params.cols) || params.cols <= 0)
    ) {
      return 'cols must be a positive integer.';
    }
    if (
      params.rows !== undefined &&
      (!Number.isInteger(params.rows) || params.rows <= 0)
    ) {
      return 'rows must be a positive integer.';
    }
    if (
      params.lines !== undefined &&
      (!Number.isInteger(params.lines) || params.lines <= 0)
    ) {
      return 'lines must be a positive integer.';
    }
    return null;
  }

  protected createInvocation(
    params: TmuxToolParams,
  ): ToolInvocation<TmuxToolParams, ToolResult> {
    return new TmuxToolInvocation(this.config, params);
  }

  /**
   * The classifier must see the action plus the actual command being run
   * (create) or text being typed (send) to catch destructive payloads.
   */
  override toAutoClassifierInput(
    params: TmuxToolParams,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { action: params.action };
    if (params.command) out['command'] = params.command;
    if (params.keys) out['keys'] = params.keys;
    return out;
  }
}
