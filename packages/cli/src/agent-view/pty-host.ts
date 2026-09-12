/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StringDecoder } from 'node:string_decoder';
import { PTY_HOST_AUTH_TOKEN_ENV, PTY_HOST_ID_ENV } from './pty-host-env.js';
import { AGENT_VIEW_WORKER_ENV_KEYS } from './worker-sideband.js';
import type { AgentViewLaunchFile } from './protocol.js';

export const DEFAULT_AGENT_VIEW_PTY_OUTPUT_BYTES = 1024 * 1024;
const INTERNAL_ONLY_WORKER_ENV_KEYS = new Set([
  PTY_HOST_AUTH_TOKEN_ENV,
  PTY_HOST_ID_ENV,
  // The supervisor startup-gate marker (INTERNAL_AGENT_VIEW_SUPERVISOR_ENV):
  // workers must not carry it, or an agent-run `qwen` whose argv mentions
  // the internal flag could re-enter supervisor mode from inside a session.
  'QWEN_AGENT_VIEW_SUPERVISOR',
  // The --bare invocation marker must never leak from the daemon env into
  // workers: a bare-mode `qwen agents` invocation that spawned the daemon
  // would otherwise silently run every later background session bare
  // (minimal settings: no user model/MCP servers/approval mode).
  'QWEN_CODE_SIMPLE',
  'TMUX',
  'TMUX_PANE',
  'STY',
  'WINDOW',
  'WINDOWID',
  'TERMCAP',
  'COLUMNS',
  'LINES',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
]);

export interface AgentViewPtySpawnOptions {
  cwd: string;
  name: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  handleFlowControl: boolean;
}

export interface AgentViewPtyDisposable {
  dispose(): void;
}

export interface AgentViewPtyProcess {
  readonly pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): AgentViewPtyDisposable | void;
  onExit(
    callback: (event: { exitCode: number; signal?: number }) => void,
  ): AgentViewPtyDisposable | void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
}

export interface AgentViewPtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: AgentViewPtySpawnOptions,
  ): AgentViewPtyProcess;
}

export interface AgentViewPtyImplementation {
  module: AgentViewPtyModule;
  name: 'lydell-node-pty' | 'node-pty' | 'injected';
}

export type AgentViewPtyAvailability =
  | { available: true; implementationName: AgentViewPtyImplementation['name'] }
  | { available: false; reason: 'missing' };

export type AgentViewLaunchValidationResult =
  | { ok: true; launch: AgentViewLaunchFile }
  | { ok: false; errors: string[] };

export interface AgentViewPtyHostOptions {
  fakeCommand?: readonly string[];
  maxOutputBytes?: number;
  pty?: AgentViewPtyImplementation | null;
  loadPty?: () => Promise<AgentViewPtyImplementation | null>;
}

export type AgentViewPtyHostExit =
  | { kind: 'exited'; exitCode: number; signal?: number }
  | { kind: 'confirmed-kill' }
  | { kind: 'confirmed-shutdown' }
  | { kind: 'unreachable' };

export interface AgentViewPtyHostHandle {
  hostId?: string;
  pid: number;
  workerPid: number;
  command: readonly string[];
  endpoint?: string;
  authToken?: string;
  output: BoundedOutputRing;
  exited: Promise<AgentViewPtyHostExit>;
  getOutput?(): Promise<string>;
  write(data: Buffer): void;
  resetInput?(): void;
  onData(callback: (data: string) => void): AgentViewPtyDisposable | void;
  resize(size: { columns: number; rows: number }): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
  shutdown?(): void | Promise<void>;
  dispose(): void;
}

export class AgentViewPtyUnavailableError extends Error {
  constructor() {
    super('Agent View PTY is unavailable in this runtime.');
    this.name = 'AgentViewPtyUnavailableError';
  }
}

export class AgentViewLaunchConfigError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid Agent View launch config: ${errors.join('; ')}`);
    this.name = 'AgentViewLaunchConfigError';
  }
}

export class BoundedOutputRing {
  private static readonly MAX_CHUNK_BYTES = 8192;

  private chunks: Buffer[] = [];
  private retainedBytesValue = 0;
  private totalBytesValue = 0;

  constructor(readonly maxBytes: number = DEFAULT_AGENT_VIEW_PTY_OUTPUT_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive integer');
    }
  }

  get retainedBytes(): number {
    return this.retainedBytesValue;
  }

  get totalBytes(): number {
    return this.totalBytesValue;
  }

  get droppedBytes(): number {
    return this.totalBytesValue - this.retainedBytesValue;
  }

  append(data: string | Buffer): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.totalBytesValue += chunk.byteLength;

    if (chunk.byteLength >= this.maxBytes) {
      // Copy instead of retaining a subarray view: a view would pin the
      // entire backing ArrayBuffer of the (potentially huge) source chunk.
      const retained = trimUtf8Start(
        Buffer.from(chunk.subarray(chunk.byteLength - this.maxBytes)),
      );
      this.chunks = [retained];
      this.retainedBytesValue = retained.byteLength;
      return;
    }

    this.appendChunk(chunk);
    this.retainedBytesValue += chunk.byteLength;
    this.trim();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.retainedBytesValue);
  }

  toString(encoding: BufferEncoding = 'utf8'): string {
    return this.toBuffer().toString(encoding);
  }

  private trim(): void {
    let trimmed = false;
    while (this.retainedBytesValue > this.maxBytes) {
      trimmed = true;
      const excess = this.retainedBytesValue - this.maxBytes;
      const first = this.chunks[0];
      if (!first) {
        this.retainedBytesValue = 0;
        return;
      }
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.retainedBytesValue -= first.byteLength;
      } else {
        const retained = trimUtf8Start(first.subarray(excess));
        if (retained.byteLength === 0) {
          this.chunks.shift();
        } else {
          this.chunks[0] = retained;
        }
        this.retainedBytesValue -= first.byteLength - retained.byteLength;
      }
    }
    // Only a size trim can leave continuation bytes at the window start;
    // without one, dropping them would discard data with room still free.
    if (trimmed) this.trimLeadingUtf8ContinuationBytes();
  }

  private appendChunk(chunk: Buffer): void {
    const previous = this.chunks[this.chunks.length - 1];
    if (
      previous &&
      previous.byteLength + chunk.byteLength <=
        BoundedOutputRing.MAX_CHUNK_BYTES
    ) {
      this.chunks[this.chunks.length - 1] = Buffer.concat([previous, chunk]);
      return;
    }
    this.chunks.push(chunk);
  }

  private trimLeadingUtf8ContinuationBytes(): void {
    while (this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const retained = trimUtf8Start(first);
      if (retained.byteLength === first.byteLength) {
        return;
      }
      if (retained.byteLength === 0) {
        this.chunks.shift();
      } else {
        this.chunks[0] = retained;
      }
      this.retainedBytesValue -= first.byteLength - retained.byteLength;
      if (retained.byteLength > 0) return;
    }
  }
}

function trimUtf8Start(buffer: Buffer): Buffer {
  let offset = 0;
  while (
    offset < buffer.byteLength &&
    isUtf8ContinuationByte(buffer[offset]!)
  ) {
    offset++;
  }
  return offset === 0 ? buffer : buffer.subarray(offset);
}

function isUtf8ContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

export async function checkAgentViewPtyAvailability(
  loadPty: () => Promise<AgentViewPtyImplementation | null> = loadAgentViewPty,
): Promise<AgentViewPtyAvailability> {
  const pty = await loadPty();
  if (!pty) {
    return { available: false, reason: 'missing' };
  }
  return { available: true, implementationName: pty.name };
}

export async function loadAgentViewPty(): Promise<AgentViewPtyImplementation | null> {
  if ('bun' in process.versions) {
    return null;
  }

  const lydell = await importPty('@lydell/node-pty', 'lydell-node-pty');
  if (lydell) {
    return lydell;
  }
  return importPty('node-pty', 'node-pty');
}

export function validateAgentViewLaunchConfig(
  value: unknown,
): AgentViewLaunchValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ['launch config must be an object'] };
  }

  requireLiteral(value, 'schemaVersion', 1, errors);
  requireNonEmptyString(value, 'sessionId', errors);
  requireStringArray(value, 'argv', errors, { nonEmpty: true });
  requireStringRecord(value, 'env', errors);
  requireNonEmptyString(value, 'entrypoint', errors);
  requireNonEmptyString(value, 'projectCwd', errors);
  requireNonEmptyString(value, 'activeCwd', errors);
  requireStringArray(value, 'includeDirectories', errors);
  validateOptionalString(value, 'model', errors);
  validateOptionalString(value, 'approvalMode', errors);
  validateOptionalString(value, 'sandbox', errors);
  validateOptionalString(value, 'initialPrompt', errors);
  validateOptionalString(value, 'settingsDigest', errors);
  validateOptionalString(value, 'mcpDigest', errors);
  validateTerminal(value['terminal'], errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, launch: value as unknown as AgentViewLaunchFile };
}

export async function launchAgentViewPtyHost(
  rawLaunch: unknown,
  options: AgentViewPtyHostOptions = {},
): Promise<AgentViewPtyHostHandle> {
  const validation = validateAgentViewLaunchConfig(rawLaunch);
  if (!validation.ok) {
    throw new AgentViewLaunchConfigError(validation.errors);
  }

  const pty =
    options.pty === undefined
      ? await (options.loadPty ?? loadAgentViewPty)()
      : options.pty;
  if (!pty) {
    throw new AgentViewPtyUnavailableError();
  }

  const launch = validation.launch;
  const command = options.fakeCommand ?? launch.argv;
  validateCommand(command);

  const output = new BoundedOutputRing(
    options.maxOutputBytes ?? DEFAULT_AGENT_VIEW_PTY_OUTPUT_BYTES,
  );
  // Strip the outer session's sideband identity from the inherited env so a
  // nested host cannot leak its token/endpoint into the inner worker; the
  // launch env intentionally carries the inner worker's own sideband keys.
  const inheritedEnv = stringProcessEnv(process.env);
  for (const key of AGENT_VIEW_WORKER_ENV_KEYS) {
    delete inheritedEnv[key];
  }
  const term = launch.env['TERM'] || 'xterm-256color';
  const workerEnv: Record<string, string> = {
    ...inheritedEnv,
    ...launch.env,
    TERM: term,
  };
  for (const key of INTERNAL_ONLY_WORKER_ENV_KEYS) {
    delete workerEnv[key];
  }
  const ptyProcess = pty.module.spawn(command[0], command.slice(1), {
    cwd: launch.activeCwd,
    name: term,
    cols: launch.terminal.columns,
    rows: launch.terminal.rows,
    env: workerEnv,
    handleFlowControl: false,
  });
  let inputDecoder = new StringDecoder('utf8');

  const disposables: AgentViewPtyDisposable[] = [];
  let settled = false;
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const resolveExitOnce = (exit: AgentViewPtyHostExit) => {
    if (settled) return;
    settled = true;
    resolveExit(exit);
  };
  const dataDisposable = ptyProcess.onData((data) => {
    output.append(data);
  });
  if (dataDisposable) {
    disposables.push(dataDisposable);
  }

  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
    const exitDisposable = ptyProcess.onExit((event) => {
      resolveExitOnce({ kind: 'exited', ...event });
    });
    if (exitDisposable) {
      disposables.push(exitDisposable);
    }
  });

  return {
    pid: process.pid,
    workerPid: ptyProcess.pid,
    command: [...command],
    output,
    exited,
    write(data: Buffer): void {
      ptyProcess.write(inputDecoder.write(data));
    },
    onData(callback: (data: string) => void): AgentViewPtyDisposable | void {
      return ptyProcess.onData(callback);
    },
    resize(size: { columns: number; rows: number }): void {
      ptyProcess.resize(size.columns, size.rows);
    },
    kill(signal?: string): void {
      // WindowsTerminal.kill throws for any signal string; the argument-less
      // kill terminates the conpty process tree instead.
      ptyProcess.kill(process.platform === 'win32' ? undefined : signal);
    },
    pause(): void {
      ptyProcess.pause?.();
    },
    resume(): void {
      ptyProcess.resume?.();
    },
    shutdown(): void {
      ptyProcess.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    },
    resetInput(): void {
      inputDecoder = new StringDecoder('utf8');
    },
    dispose(): void {
      // Match shutdown(): node-pty's signal-less kill falls back to SIGHUP on
      // POSIX, which nohup-style workers ignore.
      ptyProcess.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      resolveExitOnce({ kind: 'unreachable' });
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
    },
  };
}

async function importPty(
  specifier: '@lydell/node-pty' | 'node-pty',
  name: AgentViewPtyImplementation['name'],
): Promise<AgentViewPtyImplementation | null> {
  try {
    const module = await import(specifier);
    const ptyModule = asPtyModule(module);
    return ptyModule ? { module: ptyModule, name } : null;
  } catch {
    return null;
  }
}

function asPtyModule(module: unknown): AgentViewPtyModule | undefined {
  if (!isRecord(module) || typeof module['spawn'] !== 'function') {
    return undefined;
  }

  return module as unknown as AgentViewPtyModule;
}

function validateCommand(command: readonly string[]): void {
  if (command.length === 0 || command.some((part) => part.length === 0)) {
    throw new AgentViewLaunchConfigError([
      'command must contain at least one non-empty string',
    ]);
  }
}

function stringProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireLiteral(
  record: Record<string, unknown>,
  key: string,
  expected: unknown,
  errors: string[],
): void {
  if (record[key] !== expected) {
    errors.push(`${key} must be ${String(expected)}`);
  }
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function validateOptionalString(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    errors.push(`${key} must be a string when present`);
  }
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  options: { nonEmpty?: boolean } = {},
): void {
  const value = record[key];
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return;
  }
  if (options.nonEmpty && value.length === 0) {
    errors.push(`${key} must not be empty`);
  }
  if (value.some((item) => typeof item !== 'string')) {
    errors.push(`${key} must contain only strings`);
  }
}

function requireStringRecord(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (!isRecord(value)) {
    errors.push(`${key} must be an object with string values`);
    return;
  }
  if (Object.values(value).some((item) => typeof item !== 'string')) {
    errors.push(`${key} must contain only string values`);
  }
}

function validateTerminal(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('terminal must be an object');
    return;
  }
  if (!isPositiveInteger(value['columns'])) {
    errors.push('terminal.columns must be a positive integer');
  }
  if (!isPositiveInteger(value['rows'])) {
    errors.push('terminal.rows must be a positive integer');
  }
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}
