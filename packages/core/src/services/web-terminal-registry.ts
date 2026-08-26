/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { getPty } from '../utils/getPty.js';

/**
 * Minimal PTY surface used by the web terminal registry. Backed by node-pty.
 */
export interface WebTerminalPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface WebTerminalSnapshot {
  output: string;
  exited: boolean;
  exitCode?: number;
  workspaceCwd: string;
}

export interface CreateWebTerminalOptions {
  terminalId?: string;
  workspaceCwd: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface CreateWebTerminalResult {
  terminalId: string;
}

export type WebTerminalWriteResult = 'written' | 'backpressure' | 'unavailable';

/** Upper bound on replayed scrollback per PTY session (roughly 4 MB). */
const MAX_BUFFER_CHUNKS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_UNACKNOWLEDGED_INPUT_BYTES = 256 * 1024;
export const MAX_CONCURRENT_WEB_TERMINALS = 8;
/** Reclaim a PTY session after this long with no connected listener. */
const IDLE_RECLAIM_MS = 15 * 60 * 1000;

interface PtySession {
  pty: WebTerminalPty;
  workspaceCwd: string;
  buffer: string[];
  bufferBytes: number;
  unacknowledgedInputBytes: number;
  exited: boolean;
  exitCode?: number;
  outputListeners: Set<(data: string) => void>;
  exitListeners: Set<(e: { exitCode: number; signal?: number }) => void>;
  reclaimTimer?: ReturnType<typeof setTimeout>;
  dataDisposable?: { dispose(): void };
  exitDisposable?: { dispose(): void };
}

interface SpawnedWebTerminalPty extends WebTerminalPty {
  onData(callback: (data: string) => void): { dispose(): void } | undefined;
  onExit(
    callback: (e: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } | undefined;
}

function killPtyTree(pty: WebTerminalPty): void {
  if (process.platform === 'win32') {
    const taskkill = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;
    try {
      spawnSync(taskkill, ['/f', '/t', '/pid', String(pty.pid)], {
        windowsHide: true,
      });
    } catch {
      // Fall through to the node-pty host cleanup.
    }
  } else {
    if (pty.pid > 1) {
      try {
        process.kill(-pty.pid, 'SIGKILL');
        return;
      } catch {
        // Fall through when the process group has already exited.
      }
    }
  }
  try {
    pty.kill();
  } catch {
    // Already gone.
  }
}

export function resolveWebTerminalShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: env['COMSPEC'] ?? 'cmd.exe', args: [] }
    : { file: env['SHELL'] ?? '/bin/sh', args: [] };
}

/**
 * Long-lived interactive PTY sessions keyed by `terminalId` for the browser
 * terminal WebSocket route.
 */
export class WebTerminalRegistry {
  private readonly sessions = new Map<string, PtySession>();
  private readonly creating = new Map<string, string>();
  private readonly cancelledCreations = new Set<string>();
  private disposed = false;

  private readonly nextId = (() => {
    let counter = 0;
    return () => `web-term-${Date.now()}-${++counter}`;
  })();

  async create(
    options: CreateWebTerminalOptions,
  ): Promise<CreateWebTerminalResult | { error: string; retryable?: boolean }> {
    if (this.disposed) return { error: 'Web terminal registry disposed' };
    const terminalId = options.terminalId ?? this.nextId();
    if (this.sessions.has(terminalId)) {
      return { error: `Web terminal ${terminalId} already exists` };
    }
    if (this.creating.has(terminalId)) {
      return {
        error: `Web terminal ${terminalId} is being created`,
        retryable: true,
      };
    }
    const liveSessions = [...this.sessions.values()].filter(
      (session) => !session.exited,
    ).length;
    if (liveSessions + this.creating.size >= MAX_CONCURRENT_WEB_TERMINALS) {
      return { error: 'Web terminal limit reached', retryable: true };
    }
    this.creating.set(terminalId, options.workspaceCwd);
    let ptyImpl;
    try {
      ptyImpl = await getPty();
    } catch {
      this.finishCreating(terminalId);
      return { error: 'PTY not available' };
    }
    if (this.cancelledCreations.has(terminalId)) {
      this.finishCreating(terminalId);
      return { error: 'Web terminal creation cancelled' };
    }
    if (this.disposed) {
      this.finishCreating(terminalId);
      return { error: 'Web terminal registry disposed' };
    }
    if (!ptyImpl) {
      this.finishCreating(terminalId);
      return { error: 'PTY not available' };
    }

    const env = { ...(options.env ?? process.env) };
    const { file, args } = resolveWebTerminalShell(process.platform, env);
    delete env['NO_COLOR'];
    delete env['FORCE_COLOR'];
    delete env['npm_config_prefix'];
    let spawned: SpawnedWebTerminalPty;
    let proc: WebTerminalPty;
    const sessionRef: { current?: PtySession } = {};
    const earlyOutput: string[] = [];
    let earlyExit: { exitCode: number; signal?: number } | undefined;
    const handleData = (data: string) => {
      const session = sessionRef.current;
      if (!session) {
        earlyOutput.push(data);
        return;
      }
      session.unacknowledgedInputBytes = 0;
      if (Buffer.byteLength(data) > MAX_BUFFER_BYTES) {
        data = Buffer.from(data).subarray(-MAX_BUFFER_BYTES).toString('utf8');
        while (Buffer.byteLength(data) > MAX_BUFFER_BYTES) data = data.slice(1);
        session.buffer = [];
        session.bufferBytes = 0;
      }
      session.buffer.push(data);
      session.bufferBytes += Buffer.byteLength(data);
      while (
        session.buffer.length > MAX_BUFFER_CHUNKS ||
        session.bufferBytes > MAX_BUFFER_BYTES
      ) {
        const dropped = session.buffer.shift();
        if (dropped !== undefined) {
          session.bufferBytes -= Buffer.byteLength(dropped);
        }
      }
      for (const listener of session.outputListeners) listener(data);
    };
    const handleExit = (e: { exitCode: number; signal?: number }) => {
      const session = sessionRef.current;
      if (!session) {
        earlyExit = e;
        return;
      }
      session.exited = true;
      session.exitCode = e.exitCode;
      for (const listener of session.exitListeners) listener(e);
    };
    let dataDisposable: { dispose(): void } | undefined;
    let exitDisposable: { dispose(): void } | undefined;
    try {
      spawned = ptyImpl.module.spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: options.workspaceCwd,
        env: {
          ...env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLICOLOR: '1',
          PROMPT_EOL_MARK: '',
        },
      }) as SpawnedWebTerminalPty;
      dataDisposable = spawned.onData(handleData);
      exitDisposable = spawned.onExit(handleExit);
      proc = {
        pid: spawned.pid,
        write: (data) => spawned.write(data),
        resize: (cols, rows) => spawned.resize(cols, rows),
        kill: () => spawned.kill(),
      };
    } catch {
      this.finishCreating(terminalId);
      return { error: 'Failed to spawn shell' };
    }

    const session: PtySession = {
      pty: proc,
      workspaceCwd: options.workspaceCwd,
      buffer: [],
      bufferBytes: 0,
      unacknowledgedInputBytes: 0,
      exited: false,
      outputListeners: new Set(),
      exitListeners: new Set(),
      dataDisposable,
      exitDisposable,
    };
    sessionRef.current = session;
    this.sessions.set(terminalId, session);
    this.finishCreating(terminalId);
    for (const data of earlyOutput) handleData(data);
    if (earlyExit) handleExit(earlyExit);
    this.scheduleReclaim(terminalId, session);

    return { terminalId };
  }

  addOutputListener(
    terminalId: string,
    listener: (data: string) => void,
  ): (() => void) | undefined {
    const session = this.sessions.get(terminalId);
    if (!session) return undefined;
    session.outputListeners.add(listener);
    this.clearReclaim(session);
    return () => {
      if (this.sessions.get(terminalId) !== session) return;
      session.outputListeners.delete(listener);
      if (session.outputListeners.size === 0)
        this.scheduleReclaim(terminalId, session);
    };
  }

  addExitListener(
    terminalId: string,
    listener: (e: { exitCode: number; signal?: number }) => void,
  ): (() => void) | undefined {
    const session = this.sessions.get(terminalId);
    if (!session) return undefined;
    session.exitListeners.add(listener);
    return () => session.exitListeners.delete(listener);
  }

  /** Read buffered output and exit state when a browser tab reconnects. */
  readSnapshot(terminalId: string): WebTerminalSnapshot | undefined {
    const session = this.sessions.get(terminalId);
    if (!session) return undefined;
    return {
      output: session.buffer.join(''),
      exited: session.exited,
      workspaceCwd: session.workspaceCwd,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    };
  }

  write(terminalId: string, data: string): WebTerminalWriteResult {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return 'unavailable';
    const bytes = Buffer.byteLength(data);
    if (
      session.unacknowledgedInputBytes + bytes >
      MAX_UNACKNOWLEDGED_INPUT_BYTES
    ) {
      return 'backpressure';
    }
    try {
      session.pty.write(data);
      session.unacknowledgedInputBytes += bytes;
      return 'written';
    } catch {
      return 'unavailable';
    }
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return false;
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const terminalId of [...this.sessions.keys()])
      this.release(terminalId);
  }

  release(terminalId: string, workspaceCwd?: string): boolean {
    const creatingWorkspaceCwd = this.creating.get(terminalId);
    if (creatingWorkspaceCwd !== undefined) {
      if (workspaceCwd !== undefined && workspaceCwd !== creatingWorkspaceCwd) {
        return false;
      }
      this.cancelledCreations.add(terminalId);
      return true;
    }
    const session = this.sessions.get(terminalId);
    if (
      !session ||
      (workspaceCwd !== undefined && workspaceCwd !== session.workspaceCwd)
    ) {
      return false;
    }
    this.clearReclaim(session);
    this.sessions.delete(terminalId);
    if (!session.exited) {
      for (const listener of session.exitListeners) {
        listener({ exitCode: 143, signal: 15 });
      }
    }
    session.dataDisposable?.dispose();
    session.exitDisposable?.dispose();
    session.outputListeners.clear();
    session.exitListeners.clear();
    if (!session.exited) {
      killPtyTree(session.pty);
    }
    return true;
  }

  releaseWorkspace(workspaceCwd: string): void {
    for (const [terminalId, creatingWorkspaceCwd] of this.creating) {
      if (creatingWorkspaceCwd === workspaceCwd) {
        this.release(terminalId, workspaceCwd);
      }
    }
    for (const [terminalId, session] of this.sessions) {
      if (session.workspaceCwd === workspaceCwd) {
        this.release(terminalId, workspaceCwd);
      }
    }
  }

  private finishCreating(terminalId: string): void {
    this.creating.delete(terminalId);
    this.cancelledCreations.delete(terminalId);
  }

  private clearReclaim(session: PtySession): void {
    if (session.reclaimTimer) {
      clearTimeout(session.reclaimTimer);
      session.reclaimTimer = undefined;
    }
  }

  private scheduleReclaim(terminalId: string, session: PtySession): void {
    if (session.reclaimTimer) clearTimeout(session.reclaimTimer);
    session.reclaimTimer = setTimeout(() => {
      if (
        !this.disposed &&
        this.sessions.get(terminalId) === session &&
        session.outputListeners.size === 0
      ) {
        this.release(terminalId);
      }
    }, IDLE_RECLAIM_MS);
    session.reclaimTimer.unref?.();
  }
}
