/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { Terminal } from '@xterm/headless';
import { getPty } from '../utils/getPty.js';
import { loadXtermHeadless } from '../utils/load-xterm-headless.js';
import {
  disposeConoutWorker,
  noteConPtyHostReleased,
  releaseConPtyHost,
} from './conpty-host.js';

/**
 * Minimal PTY surface used by the web terminal registry. Backed by node-pty.
 */
export interface WebTerminalPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /**
   * Release node-pty's Windows conout worker without signalling the shell pid.
   * Used after the shell has exited, where `kill()` would reach a possibly
   * recycled pid, and on the live-release path where a deferred `kill()` would
   * otherwise strand the worker. When the kill is still deferred (the shell
   * has not emitted its first output byte) it disposes only the worker, leaving
   * the native ConPTY close to the queued `kill()` — see `disposeConoutWorker`
   * and `releaseConPtyHost`. No-op off Windows. See #11303.
   */
  releaseHost?(): void;
}

export interface WebTerminalSnapshot {
  output: string;
  exited: boolean;
  exitCode?: number;
  workspaceCwd: string;
  handlesPrimaryDa?: boolean;
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
  queryTerminal?: Terminal;
  queryReplyDisposable?: { dispose(): void };
  /**
   * Set once the PTY-side resources above have been freed. The exit-time
   * release frees them while the session stays in the map for scrollback
   * replay, so a later `release()` — tab close, workspace drain, `dispose()`,
   * idle reclaim — must not free them a second time. See #11353.
   */
  ptyResourcesReleased: boolean;
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
      const scopeColumn =
        process.platform === 'linux'
          ? 'sid='
          : process.platform === 'darwin'
            ? 'tdev='
            : undefined;
      const processes = spawnSync(
        'ps',
        ['-A', '-o', scopeColumn ? `pid=,ppid=,${scopeColumn}` : 'pid=,ppid='],
        {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          timeout: 2_000,
        },
      );
      const rows = (processes.stdout?.split('\n') ?? []).flatMap((line) => {
        const [pidText, parentPidText, scope] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const parentPid = Number(parentPidText);
        return Number.isInteger(pid) && Number.isInteger(parentPid)
          ? [{ pid, parentPid, scope }]
          : [];
      });
      const rootScope = rows.find(({ pid }) => pid === pty.pid)?.scope;
      const targets = new Set([pty.pid]);
      let found = true;
      while (found) {
        found = false;
        for (const { pid, parentPid, scope } of rows) {
          if (
            pid > 1 &&
            !targets.has(pid) &&
            (targets.has(parentPid) ||
              (rootScope !== undefined &&
                rootScope !== '0' &&
                rootScope !== '??' &&
                scope === rootScope))
          ) {
            targets.add(pid);
            found = true;
          }
        }
      }
      for (const pid of [...targets].reverse()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }
      try {
        process.kill(-pty.pid, 'SIGKILL');
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
    const useBundledConpty = os.platform() === 'win32';
    // PowerShell can probe primary DA before a browser attaches. The bundled
    // backend needs a server answer; renderer-dependent queries stay client-owned.
    let queryTerminal: Terminal | undefined;
    if (useBundledConpty) {
      // `loadXtermHeadless` is a suspension point AFTER the getPty() re-checks
      // above: a release()/releaseWorkspace()/dispose() landing during it must
      // cancel the spawn here, or create() would leak a PTY the caller already
      // gave up on. The rejection arm is folded into the same re-check — no
      // responder is still a valid terminal, but a cancelled one is not.
      const headlessModule = await loadXtermHeadless().catch(() => undefined);
      if (this.cancelledCreations.has(terminalId)) {
        this.finishCreating(terminalId);
        return { error: 'Web terminal creation cancelled' };
      }
      if (this.disposed) {
        this.finishCreating(terminalId);
        return { error: 'Web terminal registry disposed' };
      }
      if (headlessModule) {
        queryTerminal = new headlessModule.Terminal({
          allowProposedApi: true,
          cols: 80,
          rows: 24,
          scrollback: 0,
          logLevel: 'off',
        });
      }
      // Without headless, the browser answers live DA; startup may time out.
    }
    let spawned: SpawnedWebTerminalPty;
    let proc: WebTerminalPty;
    let queryReplyDisposable: { dispose(): void } | undefined;
    const sessionRef: { current?: PtySession } = {};
    const earlyOutput: string[] = [];
    let earlyExit: { exitCode: number; signal?: number } | undefined;
    const handleData = (data: string) => {
      const session = sessionRef.current;
      if (!session) {
        earlyOutput.push(data);
        return;
      }
      session.unacknowledgedInputBytes = Math.max(
        0,
        session.unacknowledgedInputBytes - Buffer.byteLength(data),
      );
      if (queryTerminal) {
        try {
          queryTerminal.write(data);
        } catch {
          // Terminal disposed mid-stream (release raced a trailing chunk).
        }
      }
      let buffered = data;
      if (Buffer.byteLength(buffered) > MAX_BUFFER_BYTES) {
        buffered = Buffer.from(buffered)
          .subarray(-MAX_BUFFER_BYTES)
          .toString('utf8');
        while (Buffer.byteLength(buffered) > MAX_BUFFER_BYTES)
          buffered = buffered.slice(1);
        session.buffer = [];
        session.bufferBytes = 0;
      }
      session.buffer.push(buffered);
      session.bufferBytes += Buffer.byteLength(buffered);
      while (
        session.buffer.length > MAX_BUFFER_CHUNKS ||
        session.bufferBytes > MAX_BUFFER_BYTES
      ) {
        const dropped = session.buffer.shift();
        if (dropped !== undefined) {
          session.bufferBytes -= Buffer.byteLength(dropped);
        }
      }
      for (const listener of session.outputListeners) listener(buffered);
    };
    const handleExit = (e: { exitCode: number; signal?: number }) => {
      const session = sessionRef.current;
      if (!session) {
        earlyExit = e;
        return;
      }
      session.exited = true;
      session.exitCode = e.exitCode;
      for (const listener of [...session.exitListeners]) listener(e);
      // Nothing needs the PTY once the shell is gone: write() and resize()
      // already short-circuit on `exited`, and readSnapshot() replays the
      // JS-side `buffer`, not the console. Waiting for release() instead left
      // every exited web terminal holding node-pty's conout worker — and, on
      // the inbox ConPTY backend, its conhost.exe (microsoft/node-pty#965);
      // the bundled backend this registry now spawns with releases its host
      // reference at spawn, so the conhost half survives only on the inbox
      // retry fallback — for up to IDLE_RECLAIM_MS, because the
      // route keeps the session alive for scrollback and the client treats the
      // 4000 close as non-retryable, so only a tab close releases it. Exited
      // sessions also do not count against the admission cap, so accumulation
      // inside that window was unbounded. See #11303 / #11353.
      //
      // Deferred one turn rather than run inline: onExit can arrive slightly
      // before late PTY data is processed, the same race shellExecutionService
      // drains before finalizing. setImmediate runs after the poll-phase
      // callbacks already queued this tick, so trailing output still reaches
      // `buffer` before the data listener is detached. handleData is fully
      // synchronous, so one turn is enough — there is no chain to flush.
      setImmediate(() => this.releasePtyResources(session));
    };
    let dataDisposable: { dispose(): void } | undefined;
    let exitDisposable: { dispose(): void } | undefined;
    const spawnPty = (useBundled: boolean) =>
      ptyImpl.module.spawn(file, args, {
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
        // Windows: with the inbox ConPTY backend a natural shell exit orphans
        // the `conhost.exe --headless` it spawned (microsoft/node-pty#965);
        // the bundled backend releases its host reference right after spawn.
        // Mirrors the #11497 shell path. Off Windows the option is inert:
        // `useConptyDll` appears nowhere in the POSIX prebuilds.
        useConptyDll: useBundled,
      });
    try {
      try {
        spawned = spawnPty(useBundledConpty) as SpawnedWebTerminalPty;
      } catch (firstError) {
        // The bundled backend adds a synchronous throw point: its conpty.dll
        // missing or unloadable. A web terminal has no child_process
        // fallback, so retry once on the inbox backend — the pre-fix leaking
        // behavior beats a terminal that cannot start at all. A failed spawn
        // produced no child process, so the retry cannot double-spawn (the
        // `ptySpawned` argument from #11497).
        if (!useBundledConpty) throw firstError;
        spawned = spawnPty(false) as SpawnedWebTerminalPty;
      }
      dataDisposable = spawned.onData(handleData);
      exitDisposable = spawned.onExit(handleExit);
      proc = {
        pid: spawned.pid,
        write: (data) => spawned.write(data),
        resize: (cols, rows) => spawned.resize(cols, rows),
        kill: () => {
          spawned.kill();
          // Mirror the cancel path (shellExecutionService.performCancelKill):
          // node-pty's WindowsTerminal.kill() defers its whole teardown while
          // `_isReady` is false, so note the close only when kill() really ran.
          // release() then disposes the worker a deferred kill left behind,
          // without double-closing a pseudo-console kill() already closed.
          if ((spawned as { _isReady?: boolean })._isReady !== false) {
            noteConPtyHostReleased(spawned);
          }
        },
        releaseHost: () => {
          // Branches on `_isReady` alone, and release() reaches it from BOTH
          // arms — the live one and the already-exited one — with a different
          // reason on each.
          //
          // LIVE: node-pty's WindowsTerminal.kill() defers its whole teardown
          // while `_isReady` is false, so killPtyTree has just queued a kill()
          // in `_deferreds`. That queued teardown runs the native
          // ClosePseudoConsole when it fires, so closing the pseudo-console
          // here would double-close the same HPCON. Dispose only the conout
          // worker now — the one resource a deferred kill can strand, and an
          // idempotent one — and leave the native close to the queued kill().
          //
          // EXITED: no kill() ran and nothing is queued, because release() only
          // calls killPtyTree on the live arm. The native exit-watcher has
          // already erased the baton, so a native close here would no-op rather
          // than double-close; the conout worker is still the one resource
          // node-pty never releases on a natural exit, and this branch frees
          // it. Same outcome releaseConPtyHost would have had on that arm,
          // reached for a different reason.
          if ((spawned as { _isReady?: boolean })._isReady === false) {
            disposeConoutWorker(spawned);
            return;
          }
          releaseConPtyHost(spawned);
        },
      };
      if (queryTerminal) {
        queryReplyDisposable = queryTerminal.onData((reply) => {
          // Only primary DA is independent of the browser's size, modes and theme.
          if (reply !== '\x1b[?1;2c') return;
          try {
            proc.write(reply);
          } catch {
            // A reply racing shell exit finds a dead PTY — drop it.
          }
        });
      }
    } catch {
      queryReplyDisposable?.dispose();
      queryTerminal?.dispose();
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
      queryTerminal,
      queryReplyDisposable,
      ptyResourcesReleased: false,
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
      ...(session.queryTerminal ? { handlesPrimaryDa: true } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    };
  }

  write(terminalId: string, data: string): WebTerminalWriteResult {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return 'unavailable';
    const bytes = Buffer.byteLength(data);
    const isRecoveryControl =
      data.length === 1 && '\x03\x04\x1a\x1c'.includes(data);
    if (
      !isRecoveryControl &&
      session.unacknowledgedInputBytes !== 0 &&
      session.unacknowledgedInputBytes + bytes > MAX_UNACKNOWLEDGED_INPUT_BYTES
    ) {
      return 'backpressure';
    }
    try {
      session.pty.write(data);
      if (!isRecoveryControl) session.unacknowledgedInputBytes += bytes;
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
    session.outputListeners.clear();
    session.exitListeners.clear();
    if (!session.exited) {
      // killPtyTree has to run before releasePtyResources: its pty.kill()
      // defers the whole teardown while `_isReady` is false, so a terminal
      // released before its shell's first output byte (tab closed during slow
      // pwsh startup, or a workspace drain) still has a kill() queued in
      // node-pty's `_deferreds`. The wrapper's kill() notes the close only when
      // it really ran; releaseHost then disposes the worker a deferred kill
      // would strand, and skips the native close so the queued kill() stays the
      // single closer — never a second close.
      killPtyTree(session.pty);
    }
    this.releasePtyResources(session);
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

  /**
   * Free a session's PTY-side resources exactly once: detach the data/exit
   * listeners, dispose the bundled-backend query responder, then release the
   * ConPTY host / conout worker that node-pty strands on a natural exit.
   * Without the second half every terminal the user exits leaks a worker for
   * the life of the CLI — the same defect the shell-tool path has. On the
   * bundled ConPTY backend this registry spawns with, the host reference is
   * already released at spawn, so only the conout worker is left to free here;
   * the conhost.exe half survives solely on the inbox spawn-failure retry,
   * where the native baton is already gone. See releaseConPtyHost and #11303.
   *
   * Deliberately leaves the session's map entry and its `buffer` alone, and
   * never signals the pid: on the exited path the shell is gone and its pid may
   * be recycled, which is why #11313 added `releaseHost` instead of reusing
   * `kill()`. Keeping the entry is what lets `readSnapshot()` still replay the
   * scrollback after an exit-time release.
   *
   * Called from `handleExit` (deferred one turn, so an exited web terminal
   * stops holding the worker for the whole idle-reclaim window — #11353) and
   * from `release()` on both of its arms, where the flag keeps a release that
   * follows an exit-time release from disposing anything twice.
   */
  private releasePtyResources(session: PtySession): void {
    if (session.ptyResourcesReleased) return;
    session.ptyResourcesReleased = true;
    session.dataDisposable?.dispose();
    session.exitDisposable?.dispose();
    session.queryReplyDisposable?.dispose();
    session.queryTerminal?.dispose();
    session.pty.releaseHost?.();
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
