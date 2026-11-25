/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { quote } from 'shell-quote';
import type { Config } from '../../config/config.js';
import type { ShellExecutionConfig } from '../shellExecutionService.js';
import type { EnvironmentSanitizationConfig } from '../environmentSanitization.js';
import { prepareShellSpawn } from '../shellSpawnPreparation.js';
import { findSuitableShell } from '../../utils/Shell.js';
import { getErrorMessage } from '../../utils/errors.js';
import { delay } from '../../utils/delay.js';
import { sha1 } from '../../utils/paths.js';
import { TerminalOutputBuffer } from '../terminal/terminalOutputBuffer.js';
import { TerminalIdleTracker } from '../terminal/terminalIdleTracker.js';
import {
  TerminalRenderer,
  type TerminalScreenSnapshot,
} from '../terminal/terminalRenderer.js';
import { runLogger } from '../../utils/runLogger.js';
import { buildBashPathPolicy } from '../../utils/shell/bashPathPolicy.js';
import {
  getPkillSelfProtectionEnvironment,
  getPkillSelfProtectionSourceCommand,
} from '../../utils/shell/pkillSelfProtection.js';
import {
  appendTaskOutput,
  flushTaskOutput,
  initTaskOutput,
} from '../../utils/task/diskOutput.js';
import {
  spawnTerminalPtyProcess,
  type TerminalPtyDisposable,
  type TerminalPtyProcess,
} from '../terminal/terminalPtyProcess.js';

export const MAX_PTY_SESSIONS = 10;
export const PTY_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const INPUT_TEXT_MIN_DELAY_MS = 50;
const INPUT_KEY_MIN_DELAY_MS = 60;
const INPUT_SCREEN_STABLE_MS = 120;
const INPUT_EVENT_MAX_WAIT_MS = 800;

export type PtyErrorCode =
  | 'pty_spawn_failed'
  | 'pty_session_not_found'
  | 'pty_session_exited'
  | 'pty_max_sessions'
  | 'pty_write_failed'
  | 'pty_snapshot_failed'
  | 'pty_resize_failed'
  | 'pty_close_failed'
  | 'pty_wait_aborted';

export class PtyError extends Error {
  constructor(
    readonly code: PtyErrorCode,
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'PtyError';
  }
}

export function isPtyError(error: unknown): error is PtyError {
  return error instanceof PtyError;
}

export function decodePtyInputEscapes(input: string): string {
  return input.replace(
    /\\(x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|([rntevabf\\0]))/g,
    (_match, _full, hex2, hex4, hexBrace, simple: string | undefined) => {
      if (hex2) return String.fromCharCode(Number.parseInt(hex2, 16));
      if (hex4) return String.fromCharCode(Number.parseInt(hex4, 16));
      if (hexBrace) return String.fromCodePoint(Number.parseInt(hexBrace, 16));
      switch (simple) {
        case 'r':
          return '\r';
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'e':
          return '\x1b';
        case 'v':
          return '\x0b';
        case 'a':
          return '\x07';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case '\\':
          return '\\';
        case '0':
          return '\0';
        default:
          return simple ?? '';
      }
    },
  );
}

function isByteInRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export type PtyInputEventKind = 'text' | 'key' | 'raw';

export interface PtyInputEvent {
  kind: PtyInputEventKind;
  bytes: string;
  label: string;
  value?: string;
}

export interface PtyParsedInput {
  events: PtyInputEvent[];
  warnings: string[];
}

const CSI_KEY_LABELS = new Map<string, string>([
  ['A', 'ArrowUp'],
  ['B', 'ArrowDown'],
  ['C', 'ArrowRight'],
  ['D', 'ArrowLeft'],
  ['H', 'Home'],
  ['F', 'End'],
  ['1~', 'Home'],
  ['2~', 'Insert'],
  ['3~', 'Delete'],
  ['4~', 'End'],
  ['5~', 'PageUp'],
  ['6~', 'PageDown'],
  ['7~', 'Home'],
  ['8~', 'End'],
  ['15~', 'F5'],
  ['17~', 'F6'],
  ['18~', 'F7'],
  ['19~', 'F8'],
  ['20~', 'F9'],
  ['21~', 'F10'],
  ['23~', 'F11'],
  ['24~', 'F12'],
]);

const SS3_KEY_LABELS = new Map<string, string>([
  ['A', 'ArrowUp'],
  ['B', 'ArrowDown'],
  ['C', 'ArrowRight'],
  ['D', 'ArrowLeft'],
  ['H', 'Home'],
  ['F', 'End'],
  ['P', 'F1'],
  ['Q', 'F2'],
  ['R', 'F3'],
  ['S', 'F4'],
]);

const C0_KEY_LABELS = new Map<number, string>([
  [0x03, 'Ctrl+C'],
  [0x04, 'Ctrl+D'],
  [0x07, 'Bell'],
  [0x08, 'Backspace'],
  [0x09, 'Tab'],
  [0x0a, 'LineFeed'],
  [0x0b, 'VerticalTab'],
  [0x0c, 'FormFeed'],
  [0x0d, 'Enter'],
  [0x7f, 'Backspace'],
]);

function pushTextEvent(events: PtyInputEvent[], value: string): void {
  if (!value) return;
  events.push({
    kind: 'text',
    bytes: value,
    value,
    label: `Text(${value.length})`,
  });
}

function parseCsiKeyLabel(paramsAndIntermediates: string, final: string): string | undefined {
  const sequenceBody = `${paramsAndIntermediates}${final}`;
  return CSI_KEY_LABELS.get(sequenceBody)
    ?? (paramsAndIntermediates ? CSI_KEY_LABELS.get(final) : undefined);
}

export function parsePtyInputEvents(chars: string, submit?: boolean): PtyParsedInput {
  const input = decodePtyInputEscapes(chars);
  const events: PtyInputEvent[] = [];
  const warnings: string[] = [];
  let textStart = 0;
  let i = 0;

  const flushTextBefore = (index: number) => {
    if (index > textStart) {
      pushTextEvent(events, input.slice(textStart, index));
    }
  };

  while (i < input.length) {
    const code = input.charCodeAt(i);

    if (code === 0x1b) {
      flushTextBefore(i);

      if (i + 1 >= input.length) {
        events.push({ kind: 'key', bytes: '\x1b', label: 'Escape' });
        i++;
        textStart = i;
        continue;
      }

      const next = input.charCodeAt(i + 1);
      if (next === 0x1b || next < 0x20 || next === 0x7f) {
        events.push({ kind: 'key', bytes: '\x1b', label: 'Escape' });
        i++;
        textStart = i;
        continue;
      }

      if (next === 0x5b) {
        let j = i + 2;
        while (
          j < input.length &&
          isByteInRange(input.charCodeAt(j), 0x30, 0x3f)
        ) {
          j++;
        }
        while (
          j < input.length &&
          isByteInRange(input.charCodeAt(j), 0x20, 0x2f)
        ) {
          j++;
        }

        if (
          j < input.length &&
          isByteInRange(input.charCodeAt(j), 0x40, 0x7e)
        ) {
          const bytes = input.slice(i, j + 1);
          const body = input.slice(i + 2, j);
          const final = input[j];
          const label = parseCsiKeyLabel(body, final);
          if (label) {
            events.push({ kind: 'key', bytes, label });
          } else {
            events.push({ kind: 'raw', bytes, label: 'RawControl' });
            warnings.push(`Unrecognized CSI input sequence: ${JSON.stringify(bytes)}`);
          }
          i = j + 1;
          textStart = i;
          continue;
        }

        const bytes = input.slice(i);
        events.push({ kind: 'raw', bytes, label: 'RawControl' });
        warnings.push(`Incomplete CSI input sequence: ${JSON.stringify(bytes)}`);
        i = input.length;
        textStart = i;
        continue;
      }

      if (next === 0x4f) {
        if (i + 2 < input.length) {
          const final = input[i + 2];
          const bytes = input.slice(i, i + 3);
          const label = SS3_KEY_LABELS.get(final);
          if (label) {
            events.push({ kind: 'key', bytes, label });
          } else {
            events.push({ kind: 'raw', bytes, label: 'RawControl' });
            warnings.push(`Unrecognized SS3 input sequence: ${JSON.stringify(bytes)}`);
          }
          i += 3;
          textStart = i;
          continue;
        }

        const bytes = input.slice(i);
        events.push({ kind: 'raw', bytes, label: 'RawControl' });
        warnings.push(`Incomplete SS3 input sequence: ${JSON.stringify(bytes)}`);
        i = input.length;
        textStart = i;
        continue;
      }

      const bytes = input.slice(i, i + 2);
      events.push({ kind: 'raw', bytes, label: 'RawControl' });
      warnings.push(`Unrecognized ESC input sequence: ${JSON.stringify(bytes)}`);
      i += 2;
      textStart = i;
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      flushTextBefore(i);
      const bytes = input[i];
      events.push({
        kind: 'key',
        bytes,
        label: C0_KEY_LABELS.get(code) ?? `Ctrl+0x${code.toString(16)}`,
      });
      i++;
      textStart = i;
      continue;
    }

    i++;
  }

  flushTextBefore(input.length);
  if (submit) {
    events.push({ kind: 'key', bytes: '\r', label: 'Enter' });
  }
  return { events, warnings };
}

export interface PtyOpenRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
  wait_ms?: number;
  idle_ms?: number;
}

export interface PtyWriteRequest {
  session_id: string;
  chars: string;
  submit?: boolean;
  wait_ms?: number;
  idle_ms?: number;
}

export interface PtySnapshotRequest {
  session_id: string;
  wait_ms?: number;
  idle_ms?: number;
  lines?: number;
  include_raw_tail?: boolean;
  include_metadata?: boolean;
}

export interface PtyResizeRequest {
  session_id: string;
  cols: number;
  rows: number;
  wait_ms?: number;
  idle_ms?: number;
}

export interface PtyCloseRequest {
  session_id: string;
  force?: boolean;
}

export interface PtySessionSummary {
  session_id: string;
  name?: string;
  command: string;
  cwd: string;
  pid?: number;
  output_path?: string;
  alive: boolean;
  cols: number;
  rows: number;
  created_at: number;
  last_used_at: number;
  exit_code?: number;
  signal?: number;
}

export interface PtySnapshotResult {
  session_id: string;
  name?: string;
  command: string;
  cwd: string;
  pid?: number;
  output_path?: string;
  alive: boolean;
  exit_code?: number;
  signal?: number;
  cols: number;
  rows: number;
  cursor: {
    x: number;
    y: number;
  };
  buffer_type: 'normal' | 'alternate';
  screen: string;
  screen_hash?: string;
  raw_tail?: string;
  last_output_at: number;
  input_events?: string[];
  input_warnings?: string[];
  changed_since_input?: boolean;
  settled?: boolean;
}

interface PtySession {
  id: string;
  ownerKey: string;
  name?: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  pid: number;
  outputTaskId?: string;
  outputPath?: string;
  ptyProcess: TerminalPtyProcess;
  renderer: TerminalRenderer;
  outputBuffer: TerminalOutputBuffer;
  idleTracker: TerminalIdleTracker;
  createdAt: number;
  lastUsedAt: number;
  closed: boolean;
  disposed: boolean;
  stopping?: boolean;
  exitCode?: number;
  signal?: number;
  cleanup?: () => void;
  writeQueue: Promise<void>;
  disposables: TerminalPtyDisposable[];
  idleTimer?: ReturnType<typeof setTimeout>;
  exitListeners: Set<(exitCode: number, signal?: number) => void>;
  dataListeners: Set<(data: string) => void>;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function definedEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { [key: string]: string } {
  const result: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function resolveCwd(config: Config, requestedCwd?: string): string {
  const base = config.getTargetDir();
  if (!requestedCwd) return base;
  return path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(base, requestedCwd);
}

function ownerKeyForConfig(config: Config): string {
  return config.getSessionId?.() || `cwd:${config.getTargetDir()}`;
}

function screenHash(screen: string): string {
  return sha1(screen);
}

const DEFAULT_PTY_SANITIZATION_CONFIG: EnvironmentSanitizationConfig = {
  allowedEnvironmentVariables: [],
  blockedEnvironmentVariables: [],
  enableEnvironmentVariableRedaction: false,
};

function buildLoginShellCommand(
  command: string,
  pathExportCommand?: string | null,
  protectionSourceCommand?: string | null,
): string {
  const protectedCommand = protectionSourceCommand
    ? `${protectionSourceCommand} && \\eval ${quote([command])}`
    : command;
  if (!pathExportCommand) {
    return protectedCommand;
  }

  // Login shell startup files can reset PATH, so restore the shared Bash PATH
  // policy after shell initialization and before running the user's command.
  return `${pathExportCommand}; ${protectedCommand}`;
}

async function commandToProgramAndArgs(
  command: string,
  pathExportCommand?: string | null,
): Promise<{
  program: string;
  args: string[];
  environmentOverrides: Record<string, string>;
}> {
  if (os.platform() === 'win32') {
    return {
      program: process.env['COMSPEC'] || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      environmentOverrides: {},
    };
  }

  const shell = await findSuitableShell();
  const protectionSourceCommand =
    await getPkillSelfProtectionSourceCommand(shell);
  return {
    program: shell,
    args: [
      '-lc',
      buildLoginShellCommand(
        command,
        pathExportCommand,
        protectionSourceCommand,
      ),
    ],
    environmentOverrides: getPkillSelfProtectionEnvironment(shell),
  };
}

export class PtySessionService {
  private static instance: PtySessionService | undefined;
  private readonly sessions = new Map<string, PtySession>();
  private didInstallExitHandler = false;

  static getInstance(): PtySessionService {
    this.instance ??= new PtySessionService();
    return this.instance;
  }

  async open(
    request: PtyOpenRequest,
    config: Config,
    shellExecutionConfig: ShellExecutionConfig | undefined,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    if (signal?.aborted) {
      throw new PtyError(
        'pty_wait_aborted',
        'PTY open aborted.',
      );
    }

    this.installExitHandler();

    const ownerKey = ownerKeyForConfig(config);
    this.enforceSessionLimit(ownerKey);

    const cols = positiveInt(request.cols, 160);
    const rows = positiveInt(request.rows, 50);
    const cwd = resolveCwd(config, request.cwd);
    const env: Record<string, string> = {
      GIT_EDITOR: 'true',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      ...request.env,
    };
    const pathPolicy =
      os.platform() === 'win32'
        ? { path: undefined, exportCommand: null }
        : buildBashPathPolicy({
            configEnv: process.env,
            pluginBinPaths: config.getPluginBinPaths(),
            requestPath: env['PATH'],
            basePath: process.env['PATH'],
            isWindows: false,
          });
    if (pathPolicy.path) {
      env['PATH'] = pathPolicy.path;
    }
    const { program, args, environmentOverrides } =
      await commandToProgramAndArgs(
        request.command,
        pathPolicy.exportCommand,
      );
    // Internal protection values win over request-provided environment.
    Object.assign(env, environmentOverrides);
    runLogger.debug(
      `[PTY] open prepare: command=${JSON.stringify(
        request.command,
      )} program=${JSON.stringify(program)} args=${JSON.stringify(
        args,
      )} cwd=${JSON.stringify(cwd)} cols=${cols} rows=${rows}`,
    );

    const defaultShellExecutionConfig = config.getShellExecutionConfig();
    const spawnPreparationConfig = {
      ...defaultShellExecutionConfig,
      ...(shellExecutionConfig ?? {}),
      environmentPreparation:
        shellExecutionConfig?.environmentPreparation ??
        defaultShellExecutionConfig.environmentPreparation,
      pager: shellExecutionConfig?.pager ?? 'cat',
      sanitizationConfig:
        shellExecutionConfig?.sanitizationConfig ??
        config.sanitizationConfig ??
        DEFAULT_PTY_SANITIZATION_CONFIG,
    };
    let preparedSpawn: Awaited<ReturnType<typeof prepareShellSpawn>>;
    try {
      preparedSpawn = await prepareShellSpawn(
        {
          program,
          args,
          cwd,
          env,
        },
        spawnPreparationConfig,
      );
    } catch (error) {
      throw new PtyError(
        'pty_spawn_failed',
        `Failed to prepare terminal command: ${getErrorMessage(error)}`,
        error,
      );
    }

    let ptyProcess: TerminalPtyProcess;
    try {
      runLogger.debug(
        `[PTY] spawn: program=${JSON.stringify(
          preparedSpawn.program,
        )} args=${JSON.stringify(preparedSpawn.args)} cwd=${JSON.stringify(
          preparedSpawn.cwd ?? cwd,
        )}`,
      );
      ptyProcess = await spawnTerminalPtyProcess(
        preparedSpawn.program,
        preparedSpawn.args,
        {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: preparedSpawn.cwd ?? cwd,
          env: definedEnv(preparedSpawn.env),
        },
      );
    } catch (error) {
      preparedSpawn.cleanup?.();
      throw new PtyError(
        'pty_spawn_failed',
        `Failed to spawn terminal command: ${getErrorMessage(error)}`,
        error,
      );
    }

    const id = `term_${crypto.randomBytes(4).toString('hex')}`;
    runLogger.debug(
      `[PTY] spawned: session_id=${id} pid=${ptyProcess.pid}`,
    );
    let outputTaskId: string | undefined;
    let outputPath: string | undefined;
    try {
      outputTaskId = `pty-${ptyProcess.pid}-${crypto
        .randomBytes(4)
        .toString('hex')}`;
      outputPath = await initTaskOutput(outputTaskId);
    } catch (error) {
      runLogger.warn(
        `[PTY] output file init failed: ${getErrorMessage(error)}`,
      );
      outputTaskId = undefined;
      outputPath = undefined;
    }
    const renderer = new TerminalRenderer(cols, rows);
    const outputBuffer = new TerminalOutputBuffer();
    const idleTracker = new TerminalIdleTracker();
    const now = Date.now();
    const session: PtySession = {
      id,
      ownerKey,
      name: request.name,
      command: request.command,
      cwd: preparedSpawn.cwd ?? cwd,
      cols,
      rows,
      pid: ptyProcess.pid,
      outputTaskId,
      outputPath,
      ptyProcess,
      renderer,
      outputBuffer,
      idleTracker,
      createdAt: now,
      lastUsedAt: now,
      closed: false,
      disposed: false,
      cleanup: preparedSpawn.cleanup,
      writeQueue: Promise.resolve(),
      disposables: [],
      exitListeners: new Set(),
      dataListeners: new Set(),
    };

    let didLogFirstOutput = false;
    session.disposables.push(
      ptyProcess.onData((data) => {
        if (!didLogFirstOutput) {
          didLogFirstOutput = true;
          runLogger.debug(
            `[PTY] first output: session_id=${id} bytes=${Buffer.byteLength(
              data,
            )}`,
          );
        }
        outputBuffer.append(data);
        if (session.outputTaskId) {
          appendTaskOutput(session.outputTaskId, data);
        }
        for (const listener of session.dataListeners) {
          try {
            listener(data);
          } catch (error) {
            runLogger.warn(
              `[PTY] data listener failed: ${getErrorMessage(error)}`,
            );
          }
        }
        renderer.write(data);
        idleTracker.markOutput();
      }),
    );
    session.disposables.push(
      ptyProcess.onExit(({ exitCode, signal }) => {
        // Explicit stops are reported by the caller that requested the kill.
        if (session.stopping) return;
        const normalizedSignal = signal > 0 ? signal : undefined;
        runLogger.debug(
          `[PTY] exit: session_id=${id} exit_code=${exitCode} signal=${normalizedSignal ?? 'none'}`,
        );
        session.exitCode = exitCode;
        session.signal = normalizedSignal;
        session.closed = true;
        this.runCleanup(session);
        for (const listener of session.exitListeners) {
          try {
            listener(exitCode, normalizedSignal);
          } catch (error) {
            runLogger.warn(
              `[PTY] exit listener failed: ${getErrorMessage(error)}`,
            );
          }
        }
      }),
    );

    this.sessions.set(id, session);
    this.resetIdleTimer(session);
    await this.waitForSession(session, request.wait_ms, request.idle_ms, signal);
    return this.snapshotSession(session, {
      lines: rows,
      include_raw_tail: true,
      include_metadata: true,
    });
  }

  async write(
    request: PtyWriteRequest,
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireLiveSession(
      ownerKeyForConfig(config),
      request.session_id,
    );
    this.touchSession(session);
    const parsedInput = parsePtyInputEvents(request.chars, request.submit);
    let inputStartScreen: string | undefined;
    let inputChanged = false;
    let inputSettled = true;
    if (parsedInput.events.length > 0) {
      session.writeQueue = session.writeQueue.then(async () => {
        const startSnapshot = await this.renderedScreen(session);
        inputStartScreen = startSnapshot.screen;
        let previousScreen = inputStartScreen;
        for (const event of parsedInput.events) {
          await session.ptyProcess.write(event.bytes);
          const waitResult = await this.waitForScreenStable(
            session,
            {
              previousScreen,
              event,
              waitMs:
                request.wait_ms === undefined
                  ? INPUT_EVENT_MAX_WAIT_MS
                  : Math.min(request.wait_ms, INPUT_EVENT_MAX_WAIT_MS),
              stableMs: request.idle_ms ?? INPUT_SCREEN_STABLE_MS,
            },
            signal,
          );
          inputChanged ||= waitResult.changed;
          inputSettled &&= waitResult.settled;
          previousScreen = waitResult.screen;
        }
      });
      try {
        await session.writeQueue;
      } catch (error) {
        session.writeQueue = Promise.resolve();
        throw new PtyError(
          'pty_write_failed',
          `Failed to write to terminal session ${session.id}: ${getErrorMessage(
            error,
          )}`,
          error,
        );
      }
    }
    await this.waitForSession(session, request.wait_ms, request.idle_ms, signal);
    const snapshot = await this.snapshotSession(session, {
      lines: session.rows,
      include_raw_tail: true,
      include_metadata: true,
    });
    if (parsedInput.events.length > 0) {
      const inputWarnings = [...parsedInput.warnings];
      if (!inputSettled) {
        inputWarnings.push('Timed out before the rendered screen became stable after input.');
      }
      snapshot.input_events = parsedInput.events.map((event) => event.label);
      snapshot.input_warnings = inputWarnings;
      snapshot.changed_since_input =
        snapshot.screen !== inputStartScreen || inputChanged;
      snapshot.settled = inputSettled;
    }
    return snapshot;
  }

  async snapshot(
    request: PtySnapshotRequest,
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireSession(
      ownerKeyForConfig(config),
      request.session_id,
    );
    this.touchSession(session);
    await this.waitForSession(session, request.wait_ms, request.idle_ms, signal);
    return this.snapshotSession(session, request);
  }

  async resize(
    request: PtyResizeRequest,
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireLiveSession(
      ownerKeyForConfig(config),
      request.session_id,
    );
    const cols = positiveInt(request.cols, session.cols);
    const rows = positiveInt(request.rows, session.rows);
    try {
      session.ptyProcess.resize(cols, rows);
      await session.renderer.resize(cols, rows);
    } catch (error) {
      throw new PtyError(
        'pty_resize_failed',
        `Failed to resize terminal session ${session.id}: ${getErrorMessage(
          error,
        )}`,
        error,
      );
    }
    session.cols = cols;
    session.rows = rows;
    this.touchSession(session);
    if (request.wait_ms !== undefined || request.idle_ms !== undefined) {
      await this.waitForSession(
        session,
        request.wait_ms,
        request.idle_ms,
        signal,
      );
    }
    return this.snapshotSession(session, {
      lines: rows,
      include_raw_tail: true,
      include_metadata: true,
    });
  }

  async close(
    request: PtyCloseRequest,
    config: Config,
  ): Promise<PtySessionSummary> {
    const session = this.requireSession(
      ownerKeyForConfig(config),
      request.session_id,
    );
    try {
      await this.disposeSession(session, { kill: true, force: request.force });
    } catch (error) {
      throw new PtyError(
        'pty_close_failed',
        `Failed to close terminal session ${session.id}: ${getErrorMessage(error)}`,
        error,
      );
    }
    const summary = this.toSummary(session);
    return summary;
  }

  list(config: Config): PtySessionSummary[] {
    const ownerKey = ownerKeyForConfig(config);
    return [...this.sessions.values()]
      .filter((session) => session.ownerKey === ownerKey)
      .map((session) => this.toSummary(session));
  }

  findByPid(config: Config, pid: number): PtySessionSummary | undefined {
    const session = this.findSessionByPid(ownerKeyForConfig(config), pid);
    return session ? this.toSummary(session) : undefined;
  }

  async writeByPid(
    request: Omit<PtyWriteRequest, 'session_id'> & { pid: number },
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireLiveSessionByPid(
      ownerKeyForConfig(config),
      request.pid,
    );
    return this.write(
      {
        session_id: session.id,
        chars: request.chars,
        submit: request.submit,
        wait_ms: request.wait_ms,
        idle_ms: request.idle_ms,
      },
      config,
      signal,
    );
  }

  async snapshotByPid(
    request: Omit<PtySnapshotRequest, 'session_id'> & { pid: number },
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireSessionByPid(
      ownerKeyForConfig(config),
      request.pid,
    );
    return this.snapshot(
      {
        session_id: session.id,
        wait_ms: request.wait_ms,
        idle_ms: request.idle_ms,
        lines: request.lines,
        include_raw_tail: request.include_raw_tail,
        include_metadata: request.include_metadata,
      },
      config,
      signal,
    );
  }

  async resizeByPid(
    request: Omit<PtyResizeRequest, 'session_id'> & { pid: number },
    config: Config,
    signal?: AbortSignal,
  ): Promise<PtySnapshotResult> {
    const session = this.requireLiveSessionByPid(
      ownerKeyForConfig(config),
      request.pid,
    );
    return this.resize(
      {
        session_id: session.id,
        cols: request.cols,
        rows: request.rows,
        wait_ms: request.wait_ms,
        idle_ms: request.idle_ms,
      },
      config,
      signal,
    );
  }

  async closeByPid(
    request: Omit<PtyCloseRequest, 'session_id'> & { pid: number },
    config: Config,
  ): Promise<PtySessionSummary> {
    const session = this.requireSessionByPid(
      ownerKeyForConfig(config),
      request.pid,
    );
    return this.close(
      {
        session_id: session.id,
        force: request.force,
      },
      config,
    );
  }

  onExitByPid(
    config: Config,
    pid: number,
    listener: (exitCode: number, signal?: number) => void,
  ): () => void {
    const session = this.requireSessionByPid(ownerKeyForConfig(config), pid);
    if (session.closed) {
      queueMicrotask(() => listener(session.exitCode ?? 0, session.signal));
      return () => {};
    }
    session.exitListeners.add(listener);
    return () => {
      session.exitListeners.delete(listener);
    };
  }

  onDataByPid(
    config: Config,
    pid: number,
    listener: (data: string) => void,
  ): () => void {
    const session = this.requireSessionByPid(ownerKeyForConfig(config), pid);
    if (session.closed) return () => {};
    session.dataListeners.add(listener);
    return () => {
      session.dataListeners.delete(listener);
    };
  }

  private async waitForSession(
    session: PtySession,
    waitMs = 1000,
    idleMs = 150,
    signal?: AbortSignal,
  ): Promise<void> {
    if (session.closed) {
      await session.renderer.flush();
      return;
    }
    try {
      await session.idleTracker.wait(waitMs, idleMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new PtyError(
          'pty_wait_aborted',
          `PTY wait aborted for session ${session.id}.`,
          error,
        );
      }
      throw error;
    }
    await session.renderer.flush();
  }

  private async waitForOutputOrTimeout(
    session: PtySession,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (waitMs <= 0 || session.closed) return;
    if (signal?.aborted) throw new Error('PTY wait aborted.');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        session.dataListeners.delete(onData);
        session.exitListeners.delete(onExit);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onData = () => settle(resolve);
      const onExit = () => settle(resolve);
      const onAbort = () =>
        settle(() => reject(new Error('PTY wait aborted.')));
      const timer = setTimeout(() => settle(resolve), waitMs);
      timer.unref?.();

      session.dataListeners.add(onData);
      session.exitListeners.add(onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async renderedScreen(session: PtySession): Promise<TerminalScreenSnapshot> {
    return session.renderer.snapshot(session.rows);
  }

  private async waitForScreenStable(
    session: PtySession,
    options: {
      previousScreen?: string;
      event: PtyInputEvent;
      waitMs: number;
      stableMs: number;
    },
    signal?: AbortSignal,
  ): Promise<{ screen: string; changed: boolean; settled: boolean }> {
    const differsFromPrevious = (s: string) =>
      options.previousScreen !== undefined && s !== options.previousScreen;

    if (options.waitMs <= 0 || session.closed) {
      const rendered = await this.renderedScreen(session);
      return {
        screen: rendered.screen,
        changed: differsFromPrevious(rendered.screen),
        settled: true,
      };
    }
    if (signal?.aborted) throw new Error('PTY wait aborted.');

    const minDelayMs =
      options.event.kind === 'text'
        ? INPUT_TEXT_MIN_DELAY_MS
        : INPUT_KEY_MIN_DELAY_MS;
    await delay(Math.min(minDelayMs, options.waitMs), signal);

    const deadline = Date.now() + options.waitMs;
    let rendered = await this.renderedScreen(session);
    let screen = rendered.screen;
    let changed = differsFromPrevious(screen);
    let stableSince = Date.now();
    let lastScreen = screen;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('PTY wait aborted.');
      const now = Date.now();
      const stableFor = now - stableSince;
      const hasSettled = changed && stableFor >= options.stableMs;
      if (hasSettled || session.closed) {
        return { screen, changed, settled: true };
      }

      const waitFor = Math.min(
        50,
        Math.max(0, deadline - now),
        Math.max(1, options.stableMs - stableFor),
      );
      if (waitFor > 0) {
        await this.waitForOutputOrTimeout(session, waitFor, signal);
      }

      rendered = await this.renderedScreen(session);
      screen = rendered.screen;
      if (screen !== lastScreen) {
        lastScreen = screen;
        stableSince = Date.now();
      }
      if (differsFromPrevious(screen)) {
        changed = true;
      }
    }

    return {
      screen,
      changed: changed || differsFromPrevious(screen),
      settled: false,
    };
  }

  private async snapshotSession(
    session: PtySession,
    request: Pick<
      PtySnapshotRequest,
      'lines' | 'include_raw_tail' | 'include_metadata'
    >,
  ): Promise<PtySnapshotResult> {
    let rendered: TerminalScreenSnapshot;
    try {
      rendered = await session.renderer.snapshot(request.lines ?? session.rows);
    } catch (error) {
      throw new PtyError(
        'pty_snapshot_failed',
        `Failed to snapshot terminal session ${session.id}: ${getErrorMessage(
          error,
        )}`,
        error,
      );
    }
    const includeRawTail = request.include_raw_tail ?? true;
    return {
      session_id: session.id,
      name: session.name,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      output_path: session.outputPath,
      alive: !session.closed,
      exit_code: session.exitCode,
      signal: session.signal,
      cols: session.cols,
      rows: session.rows,
      cursor: rendered.cursor,
      buffer_type: rendered.bufferType,
      screen: rendered.screen,
      screen_hash: screenHash(rendered.screen),
      raw_tail: includeRawTail ? session.outputBuffer.tailText() : undefined,
      last_output_at: session.idleTracker.getLastOutputAt(),
    };
  }

  private requireSession(ownerKey: string, sessionId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerKey !== ownerKey || session.disposed) {
      throw new PtyError(
        'pty_session_not_found',
        `PTY session not found: ${sessionId}`,
      );
    }
    return session;
  }

  private requireLiveSession(
    ownerKey: string,
    sessionId: string,
  ): PtySession {
    const session = this.requireSession(ownerKey, sessionId);
    if (session.closed) {
      throw new PtyError(
        'pty_session_exited',
        `PTY session has exited: ${sessionId}`,
      );
    }
    return session;
  }

  private findSessionByPid(
    ownerKey: string,
    pid: number,
  ): PtySession | undefined {
    return [...this.sessions.values()].find(
      (session) =>
        session.ownerKey === ownerKey &&
        session.pid === pid &&
        !session.disposed,
    );
  }

  private requireSessionByPid(ownerKey: string, pid: number): PtySession {
    const session = this.findSessionByPid(ownerKey, pid);
    if (!session) {
      throw new PtyError(
        'pty_session_not_found',
        `PTY session not found for PID: ${pid}`,
      );
    }
    return session;
  }

  private requireLiveSessionByPid(
    ownerKey: string,
    pid: number,
  ): PtySession {
    const session = this.requireSessionByPid(ownerKey, pid);
    if (session.closed) {
      throw new PtyError(
        'pty_session_exited',
        `PTY session has exited for PID: ${pid}`,
      );
    }
    return session;
  }

  private toSummary(session: PtySession): PtySessionSummary {
    return {
      session_id: session.id,
      name: session.name,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      output_path: session.outputPath,
      alive: !session.closed,
      cols: session.cols,
      rows: session.rows,
      created_at: session.createdAt,
      last_used_at: session.lastUsedAt,
      exit_code: session.exitCode,
      signal: session.signal,
    };
  }

  private runCleanup(session: PtySession): void {
    if (session.outputTaskId) {
      void flushTaskOutput(session.outputTaskId);
    }
    const cleanup = session.cleanup;
    session.cleanup = undefined;
    cleanup?.();
  }

  private enforceSessionLimit(ownerKey: string): void {
    let active = 0;
    const toPrune: PtySession[] = [];
    for (const session of this.sessions.values()) {
      if (session.ownerKey !== ownerKey) continue;
      if (session.closed) {
        toPrune.push(session);
      } else if (!session.disposed) {
        active++;
      }
    }
    for (const session of toPrune) {
      void this.disposeSession(session, { kill: false });
    }
    if (active >= MAX_PTY_SESSIONS) {
      throw new PtyError(
        'pty_max_sessions',
        `Maximum terminal sessions reached (${MAX_PTY_SESSIONS}). Close an existing session before opening another.`,
      );
    }
  }

  private touchSession(session: PtySession): void {
    session.lastUsedAt = Date.now();
    this.resetIdleTimer(session);
  }

  private resetIdleTimer(session: PtySession): void {
    if (session.disposed) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.disposed) {
        void this.disposeSession(session, { kill: true }).catch((error) => {
          runLogger.warn(`[PTY] idle cleanup failed: ${getErrorMessage(error)}`);
        });
      }
    }, PTY_SESSION_IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }

  private async disposeSession(
    session: PtySession,
    options: { kill: boolean; force?: boolean },
  ): Promise<void> {
    if (session.disposed) {
      this.sessions.delete(session.id);
      return;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    if (options.kill && !session.closed) {
      session.stopping = true;
      try {
        await session.ptyProcess.kill(
          options.force && os.platform() !== 'win32' ? 'SIGKILL' : undefined,
        );
      } finally {
        session.stopping = false;
      }
    }
    session.closed = true;
    this.runCleanup(session);
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.renderer.dispose();
    session.disposed = true;
    this.sessions.delete(session.id);
  }

  private installExitHandler(): void {
    if (this.didInstallExitHandler) return;
    this.didInstallExitHandler = true;
    process.once('exit', () => {
      for (const session of this.sessions.values()) {
        try {
          void session.ptyProcess.kill()?.catch(() => {});
        } catch {
          // best effort cleanup
        }
      }
    });
  }
}
