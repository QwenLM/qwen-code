/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '@xterm/headless';

const { Terminal } = pkg;

const { spawn, loadPty, spawnSync, osPlatform, loadXtermHeadless } = vi.hoisted(
  () => ({
    spawn: vi.fn(),
    loadPty: vi.fn(),
    spawnSync: vi.fn(),
    osPlatform: vi.fn(),
    loadXtermHeadless: vi.fn(),
  }),
);

vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('../utils/getPty.js', () => ({ loadPty }));
vi.mock('../utils/load-xterm-headless.js', () => ({ loadXtermHeadless }));
// conpty-host reads os.platform() for its win32 release gate, and the
// registry for the bundled-vs-inbox ConPTY backend choice; killPtyTree
// branches on process.platform, so this steers both without touching it.
// Windows CI is skipped on PRs, so the win32 path has to be reachable here.
// Everything else passes through -- Storage (via debugLogger) needs the real
// os.homedir()/os.tmpdir().
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const patched = { ...actual, platform: osPlatform };
  return { ...patched, default: patched };
});

import {
  MAX_CONCURRENT_WEB_TERMINALS,
  resolveWebTerminalShell,
  WebTerminalRegistry,
} from './web-terminal-registry.js';

describe('WebTerminalRegistry', () => {
  let onData: (data: string) => void;
  let onExit: (event: { exitCode: number; signal?: number }) => void;
  let write: ReturnType<typeof vi.fn>;
  let resize: ReturnType<typeof vi.fn>;
  let kill: ReturnType<typeof vi.fn>;
  let nativeKill: ReturnType<typeof vi.fn>;
  let conoutDispose: ReturnType<typeof vi.fn>;
  let disposeData: ReturnType<typeof vi.fn>;
  let disposeExit: ReturnType<typeof vi.fn>;

  const createSpawnedPty = () => ({
    pid: 1,
    write,
    resize,
    kill,
    // node-pty's WindowsPtyAgent internals, which releaseConPtyHost drives
    // directly instead of going through kill(). See #11303.
    _agent: {
      _pty: 42,
      _useConptyDll: false,
      _ptyNative: { kill: nativeKill },
      _conoutSocketWorker: { dispose: conoutDispose },
    },
    onData: vi.fn((listener: (data: string) => void) => {
      onData = listener;
      // Capture this session's spy by value: `disposeData` is reassigned every
      // test, and a deferred exit-time release from an earlier session may
      // fire during a later test — it must hit its own spy. Same reason the
      // detach guard checks listener identity before clearing `onData`.
      const disposeDataSpy = disposeData;
      return {
        // Model node-pty's disposable detaching the listener, so a test can
        // tell a synchronous dispose apart from the deferred one.
        dispose: () => {
          if (onData === listener) onData = () => {};
          disposeDataSpy();
        },
      };
    }),
    onExit: vi.fn(
      (listener: (e: { exitCode: number; signal?: number }) => void) => {
        onExit = listener;
        return { dispose: disposeExit };
      },
    ),
  });

  const ptyLoaded = () => ({
    impl: { module: { spawn }, name: 'node-pty' },
    loadError: null,
  });

  // Makes the next call of `mock` hang until the returned resolver runs.
  const deferNext = (mock: typeof loadPty) => {
    let resolve!: (value: unknown) => void;
    mock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    return resolve;
  };

  const create = (
    registry: WebTerminalRegistry,
    terminalId: string,
    workspaceCwd = '/workspace',
  ) => registry.create({ terminalId, workspaceCwd });

  const start = async (terminalId: string, platform?: NodeJS.Platform) => {
    if (platform) osPlatform.mockReturnValue(platform);
    const registry = new WebTerminalRegistry();
    await create(registry, terminalId);
    return registry;
  };

  // A create stalled on loadPty() until `resume` runs.
  const pendingCreate = (
    terminalId: string,
    workspaceCwd = '/workspace',
    registry = new WebTerminalRegistry(),
  ) => {
    const resolvePty = deferNext(loadPty);
    const creating = create(registry, terminalId, workspaceCwd);
    return { registry, creating, resume: () => resolvePty(ptyLoaded()) };
  };

  const listen = (registry: WebTerminalRegistry, terminalId: string) => {
    const received: string[] = [];
    registry.addOutputListener(terminalId, (data) => {
      received.push(data);
    });
    return received;
  };

  // Releases a POSIX-shaped session (pid 42, no Windows agent) with `ps`
  // answering `ps` and process.kill stubbed, then hands the stub to `check`.
  const releaseTree = async (
    terminalId: string,
    ps: { stdout: string; error?: Error },
    check: (processKill: MockInstance<typeof process.kill>) => void,
  ) => {
    spawn.mockReturnValueOnce({
      pid: 42,
      write,
      resize,
      kill,
      onData: vi.fn((listener) => {
        onData = listener;
        return { dispose: disposeData };
      }),
      onExit: vi.fn((listener) => {
        onExit = listener;
        return { dispose: disposeExit };
      }),
    });
    spawnSync.mockReturnValueOnce(ps);
    const processKill = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true);
    try {
      const registry = await start(terminalId);
      registry.release(terminalId);
      check(processKill);
    } finally {
      processKill.mockRestore();
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    nativeKill = vi.fn();
    conoutDispose = vi.fn();
    disposeData = vi.fn();
    disposeExit = vi.fn();
    spawnSync.mockReturnValue({ stdout: '' });
    osPlatform.mockReturnValue(process.platform);
    spawn.mockImplementation(() => createSpawnedPty());
    loadPty.mockResolvedValue(ptyLoaded());
    loadXtermHeadless.mockResolvedValue({ Terminal });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs an explicit SSH command with the existing terminal lifecycle', async () => {
    const registry = new WebTerminalRegistry();
    const command = {
      file: 'ssh',
      args: ['-tt', 'host', 'cd /srv/project && exec sh -l'],
    };
    await registry.create({ workspaceCwd: '/local/anchor', command });
    expect(spawn).toHaveBeenCalledWith(
      command.file,
      command.args,
      expect.objectContaining({ cwd: '/local/anchor' }),
    );
    registry.releaseWorkspace('/local/anchor');
    expect(kill).toHaveBeenCalled();
  });

  it('uses the resolved workspace and normalizes its environment', async () => {
    const registry = new WebTerminalRegistry();

    await registry.create({
      workspaceCwd: '/workspace',
      env: {
        PATH: '/bin',
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        npm_config_prefix: '/usr/local',
      },
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        cwd: '/workspace',
        env: {
          PATH: '/bin',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLICOLOR: '1',
          PROMPT_EOL_MARK: '',
        },
      }),
    );
  });

  it('selects a native Windows shell', () => {
    expect(resolveWebTerminalShell('win32', { COMSPEC: 'pwsh.exe' })).toEqual({
      file: 'pwsh.exe',
      args: [],
    });
    expect(resolveWebTerminalShell('linux', {})).toEqual({
      file: '/bin/sh',
      args: [],
    });
  });

  it('marks concurrent creation as retryable while rejecting established duplicates', async () => {
    const { registry, creating, resume } = pendingCreate('terminal:manual-1');

    await expect(create(registry, 'terminal:manual-1')).resolves.toEqual({
      error: 'Web terminal terminal:manual-1 is being created',
      retryable: true,
    });
    resume();
    await creating;

    await expect(create(registry, 'terminal:manual-1')).resolves.toEqual({
      error: 'Web terminal terminal:manual-1 already exists',
    });
  });

  it('caps established and in-flight terminal sessions', async () => {
    const registry = new WebTerminalRegistry();
    for (let i = 0; i < MAX_CONCURRENT_WEB_TERMINALS - 1; i++) {
      await create(registry, `terminal:${i}`);
    }
    const pending = pendingCreate('terminal:pending', '/workspace', registry);

    await expect(create(registry, 'terminal:over-limit')).resolves.toEqual({
      error: 'Web terminal limit reached',
      retryable: true,
    });
    pending.resume();
    await pending.creating;

    registry.release('terminal:0');
    await expect(create(registry, 'terminal:replacement')).resolves.toEqual({
      terminalId: 'terminal:replacement',
    });
  });

  it('returns stable errors when PTY loading or spawning fails', async () => {
    // Pin off Windows: on win32 a failed bundled spawn retries once on the
    // inbox backend — covered by the bundled-backend cases below.
    osPlatform.mockReturnValue('linux');
    const registry = new WebTerminalRegistry();
    const expectError = (error: string) =>
      expect(registry.create({ workspaceCwd: '/workspace' })).resolves.toEqual({
        error,
      });
    // A broken standalone archive: the wrapper is present but its native
    // module cannot be dlopen'd, which loadPty() reports as `impl: null` plus
    // a reason on that same call (#11872). The message must name that cause
    // rather than claim no backend module was found.
    loadPty.mockResolvedValueOnce({
      impl: null,
      loadError:
        'Failed to load native module: pty.node, checked: build/Release',
    });
    await expectError(
      `PTY not available: no loadable PTY backend (@lydell/node-pty or node-pty) for linux/${process.arch}: Failed to load native module: pty.node, checked: build/Release`,
    );

    // No backend and nothing recorded: the message stays reason-free.
    loadPty.mockResolvedValueOnce({ impl: null, loadError: null });
    await expectError(
      `PTY not available: no loadable PTY backend (@lydell/node-pty or node-pty) for linux/${process.arch}`,
    );

    // Defensive arm: loadPty() currently always resolves, so this pins the
    // handler rather than a production path.
    loadPty.mockRejectedValueOnce(new Error('native load failed'));
    await expectError(
      `PTY not available: PTY support failed to load on linux/${process.arch}: native load failed`,
    );

    spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expectError('Failed to spawn shell');
  });

  it('spawns Windows terminals with the bundled ConPTY backend', async () => {
    // Mirrors the shellExecutionService bundled-backend case: the inbox
    // backend orphans a `conhost.exe --headless` per natural shell exit
    // (microsoft/node-pty#965), so Windows terminals must spawn with the
    // bundled backend. Hardcoding `useConptyDll: false` turns this red.
    await start('terminal:bundled', 'win32');

    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ useConptyDll: true });
  });

  it('preserves the PTY stream and answers only primary DA on Windows', async () => {
    const registry = await start('terminal:queries', 'win32');
    const received = listen(registry, 'terminal:queries');
    const chunks = [
      '\x1b]0;title',
      'visible\x1b[1;31mred\x1b[0m\x1b[2J\x1b[12;1H',
      '\x1bP',
      '$qm\x1b\\',
      '\x1bP$',
      'qm\x1b\\',
      '\x1b[6n\x1b[?2026$p\x1b[>c',
      '\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07',
      '\x1b]4;0;?;1;?\x07',
      '\x1b[',
      'c',
    ];
    for (const chunk of chunks) onData(chunk);

    // DA is last, so its answer also waits for all preceding queries to parse.
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledExactlyOnceWith('\x1b[?1;2c');
    });
    expect(received).toEqual(chunks);
    expect(registry.readSnapshot('terminal:queries')).toMatchObject({
      output: chunks.join(''),
      handlesPrimaryDa: true,
    });
    registry.dispose();
  });

  it('leaves primary DA to the browser when headless cannot load', async () => {
    loadXtermHeadless.mockRejectedValueOnce(new Error('headless load failed'));
    const registry = await start('terminal:no-responder', 'win32');
    const received = listen(registry, 'terminal:no-responder');

    onData('\x1b[c');

    expect(received.join('')).toBe('\x1b[c');
    expect(
      registry.readSnapshot('terminal:no-responder')?.handlesPrimaryDa,
    ).not.toBe(true);
    expect(write).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('leaves the OSC colour queries for the browser client to answer', async () => {
    // The pinned @xterm/headless 5.5.0 responder answers no colour query:
    // `onData` carries DSR/DA/DECRQM/DECRQSS only, while
    // `_setOrReportSpecialColor` reports on the internal `_onColor` emitter,
    // which the headless Terminal does not expose (`term.onColor` is
    // undefined) and nothing here subscribes to. Scrubbing the family thus
    // deleted it from the browser's stream too, leaving a probing program
    // unanswered where the browser's xterm.js 6.0.0 `_handleColorEvent`
    // answered it at the merge base. The queries — whole or split, every form
    // — must reach the client untouched, and nothing may be written back.
    // The colour queries a reconnect replay re-answers are tracked in #11734.
    const registry = await start('terminal:colour', 'win32');
    const received = listen(registry, 'terminal:colour');

    onData('\x1b]10;?\x07'); // OSC foreground-colour query
    onData('\x1b]11;?'); // OSC background-colour query, split
    onData('\x07'); // ... completed by the next chunk
    onData('\x1b]12;?\x07'); // OSC cursor-colour query
    onData('\x1b]4;5;?\x07'); // OSC palette-colour query
    onData('\x1b]4;0;?;1;?\x07'); // OSC multi-index palette query

    const family =
      '\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b]4;5;?\x07\x1b]4;0;?;1;?\x07';
    expect(received.join('')).toBe(family);
    expect(registry.readSnapshot('terminal:colour')?.output).toBe(family);
    expect(write).not.toHaveBeenCalled();
  });

  it('cancels an in-flight create released during the headless load', async () => {
    // `loadXtermHeadless` is the second suspension point after getPty(); a
    // release() landing during it must cancel the spawn, not leak a PTY the
    // caller already gave up on (the getPty() re-check alone does not cover
    // this window).
    osPlatform.mockReturnValue('win32');
    const resolveHeadless = deferNext(loadXtermHeadless);
    const registry = new WebTerminalRegistry();
    const creating = create(registry, 'terminal:pending-headless');

    await vi.waitFor(() => expect(loadXtermHeadless).toHaveBeenCalled());
    expect(registry.release('terminal:pending-headless')).toBe(true);
    resolveHeadless({ Terminal });

    await expect(creating).resolves.toEqual({
      error: 'Web terminal creation cancelled',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn after disposal wins during the headless load', async () => {
    osPlatform.mockReturnValue('win32');
    const resolveHeadless = deferNext(loadXtermHeadless);
    const registry = new WebTerminalRegistry();
    const creating = create(registry, 'terminal:pending-headless-dispose');

    await vi.waitFor(() => expect(loadXtermHeadless).toHaveBeenCalled());
    registry.dispose();
    resolveHeadless({ Terminal });

    await expect(creating).resolves.toEqual({
      error: 'Web terminal registry disposed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns non-Windows terminals without the bundled backend', async () => {
    const registry = await start('terminal:posix-backend', 'linux');

    // Inert on the POSIX prebuilds, but pinned so the option stays a
    // deliberate platform branch rather than an unconditional `true`.
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ useConptyDll: false });

    // POSIX leaves every query, including primary DA, to the browser.
    onData('\x1b[c');
    expect(registry.readSnapshot('terminal:posix-backend')?.output).toContain(
      '\x1b[c',
    );
    expect(loadXtermHeadless).not.toHaveBeenCalled();
  });

  it('retries a failed bundled spawn once on the inbox backend', async () => {
    // The bundled backend throws synchronously when its conpty.dll is missing
    // or unloadable; a web terminal has no child_process fallback, so the
    // registry drops to the pre-fix inbox behavior rather than fail the
    // terminal outright. Deleting the retry branch in create() turns this red.
    osPlatform.mockReturnValue('win32');
    spawn.mockImplementationOnce(() => {
      throw new Error('Failed to load conpty.dll, error code: 126');
    });
    const registry = new WebTerminalRegistry();

    const created = await create(registry, 'terminal:bundled-retry');

    expect(created).toEqual({ terminalId: 'terminal:bundled-retry' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ useConptyDll: true });
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({ useConptyDll: false });
    // The retried PTY is fully wired: output reaches the session buffer.
    onData('ready');
    expect(registry.readSnapshot('terminal:bundled-retry')?.output).toBe(
      'ready',
    );
  });

  it('reports a spawn failure and frees the id when both backends fail', async () => {
    osPlatform.mockReturnValue('win32');
    const responder = new Terminal();
    const dispose = vi.spyOn(responder, 'dispose');
    loadXtermHeadless.mockResolvedValueOnce({
      Terminal: class {
        constructor() {
          return responder;
        }
      },
    });
    spawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const registry = new WebTerminalRegistry();

    await expect(
      create(registry, 'terminal:bundled-double-fail'),
    ).resolves.toEqual({ error: 'Failed to spawn shell' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();

    // finishCreating ran on the failure path: the same id is creatable again
    // instead of being stuck on "is being created".
    spawn.mockImplementation(() => createSpawnedPty());
    await expect(
      create(registry, 'terminal:bundled-double-fail'),
    ).resolves.toEqual({ terminalId: 'terminal:bundled-double-fail' });
  });

  it('frees a bundled-shape session once across kill and exit-time release', async () => {
    // Bundled ConPTY shape: the host reference was released at spawn, so the
    // native close is only reachable through kill(); the noted release must
    // skip a second close yet still dispose the conout worker, which node-pty
    // otherwise defers until more output that never comes. Mirrors the shell
    // path's bundled cancel case in shellExecutionService.test.ts.
    spawn.mockImplementationOnce(() => {
      const pty = createSpawnedPty();
      pty._agent._useConptyDll = true;
      return pty;
    });
    kill.mockImplementation(() => {
      nativeKill(42, true);
    });
    const registry = await start('terminal:bundled-exit-release', 'win32');

    expect(registry.release('terminal:bundled-exit-release')).toBe(true);
    onExit({ exitCode: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(kill).toHaveBeenCalledOnce();
    // kill()'s own close is the only native close: the noted bundled release
    // adds none, and the exit-time release is a no-op after it.
    expect(nativeKill).toHaveBeenCalledOnce();
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('caps replay output and records exit state', async () => {
    const registry = new WebTerminalRegistry();
    const created = await create(registry, 'terminal:buffer');
    if ('error' in created) throw new Error(created.error);
    const { terminalId } = created;

    for (let i = 0; i < 4001; i++) onData(String(i % 10));
    onExit({ exitCode: 7 });

    const snapshot = registry.readSnapshot(terminalId);
    expect(snapshot?.output).toHaveLength(4000);
    expect(snapshot).toMatchObject({
      exited: true,
      exitCode: 7,
      workspaceCwd: '/workspace',
    });
    expect(registry.write(terminalId, 'ignored')).toBe('unavailable');
    expect(registry.resize(terminalId, 80, 24)).toBe(false);
  });

  it('caps replay output by UTF-8 bytes', async () => {
    const registry = await start('terminal:utf8-buffer');

    onData('界'.repeat(1_500_000));

    const output = registry.readSnapshot('terminal:utf8-buffer')?.output ?? '';
    expect(output.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('releases a live PTY immediately and only once', async () => {
    const registry = await start('terminal:release');

    expect(registry.release('terminal:release')).toBe(true);
    expect(registry.release('terminal:release')).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:release')).toBeUndefined();
  });

  it("releases an exited session's conout worker, never by signalling the pid", async () => {
    const registry = await start('terminal:release-exited', 'win32');
    onExit({ exitCode: 0 });

    expect(registry.release('terminal:release-exited')).toBe(true);
    // The shell is gone, so nothing may signal its (possibly recycled) pid:
    // no taskkill, no process-group kill, and no ptyProcess.kill() either --
    // node-pty's kill() force-terminates the console process list. See #11303.
    expect(spawnSync).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    // node-pty releases neither the ConPTY host nor its conout worker on a
    // natural exit, so the release goes at the agent directly. Only the worker
    // half actually lands: nativeKill is a stub here, and the real one no-ops
    // after a natural exit. See releaseConPtyHost.
    expect(nativeKill).toHaveBeenCalledOnce();
    expect(conoutDispose).toHaveBeenCalledOnce();
    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
  });

  it('releases a live session whose kill was deferred before its first byte', async () => {
    const registry = await start('terminal:release-live-deferred', 'win32');
    // node-pty's WindowsTerminal.kill() queues its teardown while _isReady is
    // false — a terminal released before the shell's first output byte. No
    // onExit fired, so the session is still live.
    (spawn.mock.results[0].value as { _isReady?: boolean })._isReady = false;

    expect(registry.release('terminal:release-live-deferred')).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
    // The deferred kill tore nothing down and is still queued in node-pty's
    // _deferreds; when it runs it closes the pseudo-console. So releaseHost
    // must dispose the worker now (the one resource a never-run deferred kill
    // would strand) WITHOUT closing the pseudo-console itself — a native close
    // here plus the queued kill's later close would double-free the HPCON.
    expect(nativeKill).not.toHaveBeenCalled();
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('still completes a deferred release when the conout worker dispose throws', async () => {
    // The throw guard inside disposeConoutWorker — the twin of the one in
    // releaseConPtyHost. release() calls session.pty.releaseHost?.() bare,
    // after the session is already deleted from the map, and dispose()'s loop
    // has no per-iteration guard, so a throw escaping the worker dispose would
    // abort the teardown of every session still queued behind it.
    conoutDispose.mockImplementation(() => {
      throw new Error('dispose boom');
    });
    const registry = await start('terminal:release-deferred-throws', 'win32');
    (spawn.mock.results[0].value as { _isReady?: boolean })._isReady = false;

    // Remove the try/catch around _conoutSocketWorker.dispose() in
    // disposeConoutWorker and this throws out of release() instead of
    // returning true.
    expect(registry.release('terminal:release-deferred-throws')).toBe(true);
    expect(conoutDispose).toHaveBeenCalledOnce();
    // The queued kill() is still the single closer.
    expect(nativeKill).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();
  });

  it('releases an exited session that never became ready through the deferred arm', async () => {
    const registry = await start('terminal:release-exited-deferred', 'win32');
    // The shell exits before its first output byte — COMSPEC resolving to a
    // binary that quits immediately, or a releaseWorkspace drain racing pwsh
    // startup. That is session.exited === true AND _isReady === false, so
    // release()'s exited arm routes into releaseHost's deferred branch.
    (spawn.mock.results[0].value as { _isReady?: boolean })._isReady = false;
    onExit({ exitCode: 0 });

    expect(registry.release('terminal:release-exited-deferred')).toBe(true);
    // Nothing may signal an exited shell's possibly-recycled pid, and the
    // native baton is already erased — so no kill and no native close on this
    // arm. (Asserting the host WAS released is forbidden; see conpty-host.ts.)
    expect(kill).not.toHaveBeenCalled();
    expect(nativeKill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    // The conout worker is still freed: the one resource node-pty strands on a
    // natural exit, which is the whole point of the else branch in release().
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('does not double-close a live session whose kill already closed it', async () => {
    // Model node-pty's real WindowsTerminal.kill(): when ready it closes the
    // HPCON and disposes the worker. The wrapper notes the close, so the
    // releaseHost below must not add a second native kill (double-free).
    kill.mockImplementation(() => {
      nativeKill(42, false);
      conoutDispose();
    });
    const registry = await start('terminal:release-live-ready', 'win32');

    expect(registry.release('terminal:release-live-ready')).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
    expect(nativeKill).toHaveBeenCalledOnce();
    expect(conoutDispose).toHaveBeenCalledOnce();
  });

  it('leaves an exited session alone off Windows', async () => {
    const registry = await start('terminal:release-exited-posix', 'linux');
    onExit({ exitCode: 0 });

    expect(registry.release('terminal:release-exited-posix')).toBe(true);
    // No ConPTY host and no conout worker to release, and UnixTerminal.kill()
    // would signal an already-exited, possibly recycled pid.
    expect(nativeKill).not.toHaveBeenCalled();
    expect(conoutDispose).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('frees an exited session at exit time, not at the idle reclaim', async () => {
    const registry = await start('terminal:exit-time-release', 'win32');

    onExit({ exitCode: 0 });
    // One turn of the event loop, on real timers: the 15-minute idle reclaim
    // cannot have run, and nothing below calls release(). A live exit closes
    // the route's socket with 4000, which the client treats as non-retryable,
    // so no tab close follows either — that window is what #11353 is about.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // node-pty strands its conout worker on a natural exit, so that worker is
    // the resource an exited web terminal held for up to IDLE_RECLAIM_MS — and
    // exited sessions do not count against the admission cap, so accumulation
    // inside the window was unbounded. See #11303 / #11353.
    expect(conoutDispose).toHaveBeenCalledOnce();
    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
    // Nothing may signal an exited shell's possibly-recycled pid.
    expect(kill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    // The session itself survives the release, for scrollback replay.
    expect(registry.readSnapshot('terminal:exit-time-release')).toBeDefined();
  });

  it('still replays buffered scrollback after the exit-time release', async () => {
    const registry = await start('terminal:replay-after-exit-release', 'win32');

    onData('boot\r\n');
    onExit({ exitCode: 3 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The exit-time release frees PTY handles only. The session and its buffer
    // stay in the map, so a second tab attaching to this terminal id still gets
    // the scrollback plus the exit state — which is what terminal.ts's
    // releaseAfterReplay path depends on.
    expect(conoutDispose).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:replay-after-exit-release')).toEqual(
      {
        output: 'boot\r\n',
        exited: true,
        exitCode: 3,
        workspaceCwd: '/workspace',
        handlesPrimaryDa: true,
      },
    );
  });

  it('does not free an exited session twice when release follows', async () => {
    const registry = await start('terminal:exit-release-once', 'win32');

    onExit({ exitCode: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The tab close, a workspace drain, dispose() or the reclaim all still run
    // release() on a session whose PTY was already freed at exit time.
    expect(registry.release('terminal:exit-release-once')).toBe(true);

    expect(conoutDispose).toHaveBeenCalledOnce();
    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('lets output queued behind onExit reach the scrollback before the release', async () => {
    const registry = await start('terminal:exit-trailing', 'win32');

    // The release is deferred one tick after onExit so a trailing onData
    // queued in the same turn still lands in the scrollback first. The
    // assertion between the two calls pins the defer: a synchronous release
    // has already disposed the data listener before the tail arrives. (The
    // fake's detach on dispose models node-pty and loses that tail too, but
    // no signal in this test depends on it any more.)
    onExit({ exitCode: 0 });
    expect(disposeData).not.toHaveBeenCalled();
    onData('trailing');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(disposeData).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:exit-trailing')).toMatchObject({
      output: 'trailing',
      exited: true,
    });
  });

  it('forwards live output and bounds unacknowledged PTY input', async () => {
    const registry = await start('terminal:io');
    const listener = vi.fn();
    const detachListener = registry.addOutputListener('terminal:io', listener);

    expect(registry.write('terminal:io', 'x'.repeat(256 * 1024))).toBe(
      'written',
    );
    expect(registry.write('terminal:io', '\x03')).toBe('written');
    expect(registry.write('terminal:io', '\x04')).toBe('written');
    expect(registry.write('terminal:io', 'x')).toBe('backpressure');
    expect(write).toHaveBeenCalledTimes(3);
    expect(registry.resize('terminal:io', 120, 40)).toBe(true);
    expect(resize).toHaveBeenCalledWith(120, 40);

    detachListener?.();
    registry.addOutputListener('terminal:io', listener);
    expect(registry.write('terminal:io', 'x')).toBe('backpressure');

    onData('ready');
    expect(listener).toHaveBeenCalledWith('ready');
    expect(registry.write('terminal:io', '12345')).toBe('written');
    expect(registry.write('terminal:io', 'x')).toBe('backpressure');
  });

  it('accepts one complete oversized input frame on an idle session', async () => {
    const registry = await start('terminal:paste');
    const paste = 'x'.repeat(256 * 1024 + 1);

    expect(registry.write('terminal:paste', paste)).toBe('written');
    expect(registry.write('terminal:paste', paste)).toBe('backpressure');
    expect(write).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')(
    'kills every process in the PTY session',
    () =>
      releaseTree(
        'terminal:process-tree',
        { stdout: '42 1 42\n43 42 42\n44 43 42\n45 1 42\n99 1 99\n' },
        (processKill) => {
          expect(spawnSync).toHaveBeenCalledWith(
            'ps',
            [
              '-A',
              '-o',
              process.platform === 'linux'
                ? 'pid=,ppid=,sid='
                : process.platform === 'darwin'
                  ? 'pid=,ppid=,tdev='
                  : 'pid=,ppid=',
            ],
            expect.objectContaining({
              encoding: 'utf8',
              maxBuffer: 8 * 1024 * 1024,
              timeout: 2_000,
            }),
          );
          expect(processKill).toHaveBeenCalledWith(42, 'SIGKILL');
          expect(processKill).toHaveBeenCalledWith(43, 'SIGKILL');
          expect(processKill).toHaveBeenCalledWith(44, 'SIGKILL');
          if (process.platform === 'linux' || process.platform === 'darwin') {
            expect(processKill).toHaveBeenCalledWith(45, 'SIGKILL');
          }
          expect(processKill).toHaveBeenCalledWith(-42, 'SIGKILL');
          expect(processKill).not.toHaveBeenCalledWith(99, 'SIGKILL');
        },
      ),
  );

  it.skipIf(process.platform === 'win32')(
    'falls back to the PTY process group when ps fails',
    () =>
      releaseTree(
        'terminal:process-group',
        {
          stdout: '',
          error: Object.assign(new Error('ps failed'), { code: 'ENOBUFS' }),
        },
        (processKill) => {
          expect(processKill).toHaveBeenCalledWith(-42, 'SIGKILL');
          expect(kill).toHaveBeenCalledOnce();
        },
      ),
  );

  it('does not count exited sessions against the live terminal limit', async () => {
    const registry = new WebTerminalRegistry();
    for (let i = 0; i < MAX_CONCURRENT_WEB_TERMINALS; i++) {
      await create(registry, `terminal:exited-${i}`);
      onExit({ exitCode: 0 });
    }

    await expect(create(registry, 'terminal:replacement')).resolves.toEqual({
      terminalId: 'terminal:replacement',
    });
  });

  it('preserves a clean exit code in snapshots', async () => {
    const registry = await start('terminal:clean-exit');

    onExit({ exitCode: 0 });

    expect(registry.readSnapshot('terminal:clean-exit')).toMatchObject({
      exited: true,
      exitCode: 0,
    });
  });

  it('notifies every exit listener when one releases the session', async () => {
    const registry = await start('terminal:exit-listeners');
    const first = vi.fn(() => registry.release('terminal:exit-listeners'));
    const second = vi.fn();
    registry.addExitListener('terminal:exit-listeners', first);
    registry.addExitListener('terminal:exit-listeners', second);

    onExit({ exitCode: 7 });

    expect(first).toHaveBeenCalledWith({ exitCode: 7 });
    expect(second).toHaveBeenCalledWith({ exitCode: 7 });
  });

  it('does not spawn a PTY after disposal wins an in-flight create', async () => {
    const { registry, creating, resume } = pendingCreate('terminal:pending');

    registry.dispose();
    resume();

    await expect(creating).resolves.toEqual({
      error: 'Web terminal registry disposed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['terminal', 'workspace'] as const)(
    'cancels in-flight creation when releasing its %s',
    async (scope) => {
      const { registry, creating, resume } = pendingCreate('terminal:pending');

      if (scope === 'terminal') {
        expect(registry.release('terminal:pending')).toBe(true);
      } else {
        registry.releaseWorkspace('/workspace');
      }
      resume();

      await expect(creating).resolves.toEqual({
        error: 'Web terminal creation cancelled',
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('keeps another workspace in-flight when one workspace is released', async () => {
    const a = pendingCreate('terminal:a', '/workspace-a');
    const b = pendingCreate('terminal:b', '/workspace-b', a.registry);

    a.registry.releaseWorkspace('/workspace-a');
    a.resume();
    b.resume();

    await expect(a.creating).resolves.toEqual({
      error: 'Web terminal creation cancelled',
    });
    await expect(b.creating).resolves.toEqual({ terminalId: 'terminal:b' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: '/workspace-b' }),
    );
  });

  it('does not let another workspace cancel an in-flight terminal', async () => {
    const { registry, creating, resume } = pendingCreate(
      'terminal:pending',
      '/workspace-a',
    );

    expect(registry.release('terminal:pending', '/workspace-b')).toBe(false);
    resume();

    await expect(creating).resolves.toEqual({
      terminalId: 'terminal:pending',
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('releases only terminals owned by a draining workspace', async () => {
    const registry = new WebTerminalRegistry();
    await create(registry, 'terminal:a', '/workspace-a');
    const killA = kill;
    const exitListener = vi.fn();
    registry.addExitListener('terminal:a', exitListener);
    await create(registry, 'terminal:b', '/workspace-b');

    registry.releaseWorkspace('/workspace-a');

    expect(killA).toHaveBeenCalledOnce();
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 143, signal: 15 });
    expect(registry.readSnapshot('terminal:a')).toBeUndefined();
    expect(registry.readSnapshot('terminal:b')).toBeDefined();
  });

  it('reclaims only after the final listener stays detached', async () => {
    vi.useFakeTimers();
    const registry = await start('terminal:idle');
    const detachOne = registry.addOutputListener('terminal:idle', vi.fn());
    const detachTwo = registry.addOutputListener('terminal:idle', vi.fn());

    detachOne?.();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(kill).not.toHaveBeenCalled();

    detachTwo?.();
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    const detachReconnect = registry.addOutputListener(
      'terminal:idle',
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(kill).not.toHaveBeenCalled();

    detachReconnect?.();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(kill).toHaveBeenCalledOnce();
    expect(registry.readSnapshot('terminal:idle')).toBeUndefined();
  });

  it('does not let a stale detach reclaim a reused terminal id', async () => {
    vi.useFakeTimers();
    const registry = await start('terminal:reused');
    const detach = registry.addOutputListener('terminal:reused', vi.fn());

    registry.release('terminal:reused');
    detach?.();
    kill.mockClear();
    await create(registry, 'terminal:reused');
    registry.addOutputListener('terminal:reused', vi.fn());
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(kill).not.toHaveBeenCalled();
    expect(registry.readSnapshot('terminal:reused')).toBeDefined();
  });
});
