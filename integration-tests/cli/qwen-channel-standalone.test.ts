/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  type MockServerHandle,
} from '../../packages/channels/plugin-example/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
// Match the rest of the integration suite: prefer the bundled CLI path
// that `globalSetup.ts` configures via `TEST_CLI_PATH` (root
// `dist/cli.js`), falling back to the per-package output for direct
// `vitest run integration-tests/...` invocations that bypass globalSetup.
// The root bundle only exists after `npm run bundle` (`npm run build`
// emits packages/*/dist/ only), so a bundle-only fallback fails with
// misleading "Process exited before ..." errors when the last build step
// was a plain build (#8975).
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');

let child: ChildProcess | undefined;
let testRoot: string | undefined;
let mockServer: MockServerHandle | undefined;

// One shared transcript per spawned child, with the `data` listeners
// attached at first observation: consecutive waiters must see output
// delivered before they attach. A fresh per-call listener starts from an
// empty buffer, so a single pipe chunk carrying two awaited lines is
// consumed by the first waiter and lost to the second — a spurious
// timeout on a correctly behaving service under CPU saturation (#8975).
interface ChildTranscript {
  output: string;
  exited: boolean;
  exitCode: number | null;
  waiters: Set<() => void>;
}

const childTranscripts = new WeakMap<ChildProcess, ChildTranscript>();

function observeChild(proc: ChildProcess): ChildTranscript {
  const existing = childTranscripts.get(proc);
  if (existing) return existing;
  const transcript: ChildTranscript = {
    output: '',
    exited: false,
    exitCode: null,
    waiters: new Set(),
  };
  childTranscripts.set(proc, transcript);
  const onData = (chunk: Buffer) => {
    transcript.output += chunk.toString('utf-8');
    for (const notify of transcript.waiters) notify();
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  // Settle completeness on 'close', not 'exit' (R15-22): Node documents
  // 'exit' as firing before stdio streams are necessarily drained, so a
  // waiter whose needle sits in the undelivered tail would reject with
  // 'Process exited (0) before …' against a correctly behaving child.
  // 'close' fires after the streams drain (and also carries the code);
  // every spawn here pipes stdio.
  proc.once('close', (code) => {
    transcript.exited = true;
    transcript.exitCode = code;
    for (const notify of transcript.waiters) notify();
  });
  return transcript;
}

function waitForLine(
  proc: ChildProcess,
  needle: string,
  timeoutMs = 30000,
): Promise<void> {
  const transcript = observeChild(proc);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `Timed out waiting for "${needle}". Output: ${transcript.output}`,
        ),
      );
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      transcript.waiters.delete(check);
    };
    const check = () => {
      if (transcript.output.includes(needle)) {
        finish();
        resolve();
        return true;
      }
      if (transcript.exited) {
        finish();
        reject(
          new Error(
            `Process exited (${String(transcript.exitCode)}) before "${needle}". Output: ${transcript.output}`,
          ),
        );
        return true;
      }
      return false;
    };
    if (!check()) transcript.waiters.add(check);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForListeningUrl(
  proc: ChildProcess,
  timeoutMs = 60000,
): Promise<string> {
  const transcript = observeChild(proc);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `Timed out waiting for the listening URL. Output: ${transcript.output}`,
        ),
      );
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      transcript.waiters.delete(check);
    };
    const check = () => {
      // Require a terminator after the URL (R15-3): the buffer grows in
      // pipe chunks, and a boundary can fall INSIDE the URL — without the
      // lookahead, `[^\s)]+` terminates at buffer end and resolves a
      // truncated prefix (`http://127.0.0` instead of
      // `http://127.0.0.1:41237`), the exact chunk-splitting flake this
      // file's header cites. The emitter always follows the URL with
      // whitespace or ')', so the lookahead matches only complete lines.
      const match = transcript.output.match(
        /listening on (https?:\/\/[^\s)]+)(?=[\s)])/,
      );
      if (match) {
        finish();
        resolve(match[1]!);
        return true;
      }
      if (transcript.exited) {
        finish();
        reject(
          new Error(
            `Process exited (${String(transcript.exitCode)}) before the listening URL. Output: ${transcript.output}`,
          ),
        );
        return true;
      }
      return false;
    };
    if (!check()) transcript.waiters.add(check);
  });
}

async function pollHttp(
  url: string,
  accept: (status: number, body: unknown) => boolean,
  timeoutMs = 30000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON; keep the raw text for the accept predicate.
      }
      if (accept(res.status, body)) return body;
      lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out polling ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  await Promise.allSettled([mockServer?.close() ?? Promise.resolve()]);
  mockServer = undefined;
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

function runToCompletion(
  proc: ChildProcess,
  timeoutMs = 30000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Process did not exit within ${timeoutMs}ms. Output: ${output}`,
        ),
      );
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
    });
    // Settle on 'close', not 'exit' (R15-22): 'exit' can fire before the
    // final pipe chunks are read (libuv processes SIGCHLD before the last
    // pipe read under CPU saturation), so an assertion on the trailing
    // line — e.g. `expect(output).toContain('Stopped channels stay
    // stopped')` — would fail against a correctly behaving command.
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// The suites below assert POSIX graceful-SIGTERM semantics (catchable
// SIGTERM → exit code 0 → pidfile removal): on Windows Node cannot deliver
// a catchable SIGTERM, the child's shutdown handler never runs and kill
// force-terminates, so the code/pidfile assertions would fail. House
// convention for POSIX-dependent suites (qwen-serve-baseline.test.ts,
// daemon-invocation-context.test.ts) (#8975).
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const isPosix = process.platform !== 'win32';

describePosix('qwen channel start standalone (#8975)', () => {
  it('keeps serving with 0 channels instead of exiting', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-standalone-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    // Nothing configured: the effective channel set is empty.
    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({}),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      'utf-8',
    );
    const pidFile = path.join(qwenHome, 'channels', 'service.pid');

    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      },
    });

    await waitForLine(child, 'serving with 0 channels');
    // The child emits the ready line BEFORE writing the pidfile, and the
    // parent's pipe-buffer wakeup gives no ordering guarantee for the child's
    // subsequent file syscalls — poll across the process boundary instead
    // of asserting immediately.
    const pidFileDeadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      if (Date.now() > pidFileDeadline) {
        throw new Error(`Timed out waiting for pid file at ${pidFile}`);
      }
      await sleep(50);
    }

    // The pre-fix process exited on its own in under a second once the event
    // loop drained; give it ample time to do so and require it still alive.
    await sleep(2000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
    child = undefined;
  }, 60000);
});

describePosix(
  'qwen serve --channel all with an empty channel config (#8975)',
  () => {
    // End-to-end replay of the production shape from the issue: the ADA
    // sandbox restart where `qwen serve --channel all` boots with zero
    // configured channels. Serve must stay up, report the worker running and
    // shut down cleanly — a regression re-adding "at least one channel"
    // validation to the serve startup path fails here.
    it('keeps serving, reports the worker running, and shuts down cleanly', async () => {
      testRoot = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'qwen-channel-serve-')),
      );
      const qwenHome = path.join(testRoot, 'qwen-home');
      const runtimeDir = path.join(testRoot, 'runtime');
      const workspace = path.join(testRoot, 'workspace');
      const homeDir = path.join(testRoot, 'home');
      mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
      mkdirSync(runtimeDir);
      mkdirSync(qwenHome, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      // Nothing configured: the effective channel set is empty.
      writeFileSync(
        path.join(qwenHome, 'settings.json'),
        JSON.stringify({}),
        'utf-8',
      );
      const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
      writeFileSync(
        trustedFoldersPath,
        JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
        'utf-8',
      );
      // `serve --channel all` reserves the channel-service pidfile for
      // ANY selection, so this child writes it too: the clean shutdown
      // must remove it, or the stale reservation can abort the next boot
      // with channel_service_conflict (#8975).
      const pidFile = path.join(qwenHome, 'channels', 'service.pid');

      child = spawn(
        process.execPath,
        [CLI_BIN, 'serve', '--channel', 'all', '--port', '0'],
        {
          cwd: workspace,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            // Strip the bearer-token env toggle: `qwen serve` resolves the
            // token as `--token ?? env[QWEN_SERVER_TOKEN]`, so a token
            // exported on the dev machine or CI runner would silently flip
            // auth on and 401 the unauthenticated poll below — mirroring
            // qwen-serve-routes.test.ts, which strips behavior-flipping
            // env toggles for the same reason (#8975).
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([k]) => k !== 'QWEN_SERVER_TOKEN',
              ),
            ),
            // The env-toggle strip alone is not enough: the serve
            // fast-path .env loader reads $HOME/.env and $HOME/.qwen/.env
            // regardless of QWEN_HOME, so a QWEN_SERVER_TOKEN defined in
            // the real home of the dev machine or CI runner would flip
            // auth on and 401 the unauthenticated polls below. Sandbox
            // HOME like qwen-serve-routes.test.ts does (#8975).
            HOME: homeDir,
            QWEN_HOME: qwenHome,
            QWEN_RUNTIME_DIR: runtimeDir,
            QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
          },
        },
      );

      const baseUrl = await waitForListeningUrl(child);

      // The final pidfile-ABSENCE assertion is only meaningful if the
      // pidfile existed in the first place: poll for its creation, or a
      // serve that never writes the reservation ships green (R14).
      {
        const pidFileDeadline = Date.now() + 30000;
        while (!existsSync(pidFile)) {
          if (Date.now() > pidFileDeadline) {
            throw new Error(`Timed out waiting for pidfile ${pidFile}`);
          }
          await sleep(250);
        }
      }

      await pollHttp(`${baseUrl}/health`, (status) => status === 200);

      interface ControlState {
        enabled?: boolean;
        transition?: string;
        workers?: Array<{
          state?: string;
          channels?: string[];
          restartCount?: number;
        }>;
      }
      const control = (await pollHttp(
        `${baseUrl}/workspace/channel`,
        (_status, body) => {
          const state = body as ControlState;
          return (
            state.enabled === true &&
            state.transition === 'idle' &&
            Array.isArray(state.workers) &&
            state.workers.length > 0 &&
            state.workers[0]!.state === 'running'
          );
        },
      )) as ControlState;
      // Zero configured channels: the committed worker runs with no channels.
      expect(control.workers?.[0]?.channels).toEqual([]);

      // Settling window mirroring the standalone siblings: a serve that
      // self-exits ~1-2s after reporting zero-channel running must fail
      // HERE, not get preempted by the SIGTERM below — the graceful-exit
      // assertions accept a self-exit identically to a clean shutdown
      // (#8975).
      await sleep(2000);

      // Liveness: the server process is still up after the checks.
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      // Re-poll the control state after the settling window: the first
      // poll is a single-instant snapshot, and a zero-channel worker
      // crash after that instant is crash-restarted by the supervisor
      // with the serve process staying alive — so the process-level
      // liveness check above cannot see a dead or crash-looping worker
      // (#8975). Requiring `restartCount === 0` closes the remaining
      // hole: the pre-R14 predicate accepted the 'running' state a
      // crash-restart restores, so even a crash during the window
      // shipped green (R14).
      await pollHttp(`${baseUrl}/workspace/channel`, (_status, body) => {
        const state = body as ControlState;
        return (
          state.enabled === true &&
          state.transition === 'idle' &&
          Array.isArray(state.workers) &&
          state.workers.length > 0 &&
          state.workers[0]!.state === 'running' &&
          state.workers[0]!.restartCount === 0
        );
      });

      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child!.once('exit', (code, signal) => resolve({ code, signal }));
      });
      // Lost-exit-event guard: if the child already exited before the
      // listener attached, the promise never settles and the suite hangs
      // into the timeout — fail fast instead (R14).
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `serve child exited prematurely before SIGTERM ` +
            `(code ${child.exitCode}, signal ${child.signalCode})`,
        );
      }
      child.kill('SIGTERM');
      const { code, signal } = await exited;
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      child = undefined;
    }, 120000);
  },
);

// The handoff core — start connects, stop persists `stopped`, the next
// start skips it — runs on ALL platforms: stop persists the record BEFORE
// signalling the service (ordering pinned by stop.test.ts), and the read
// side uses no POSIX facility. Only the graceful-SIGTERM exit-code
// assertions are POSIX-gated. A writer/reader path-derivation split (both
// sides canonicalize the workspace before hashing it, R9-2) is
// realistically triggered only on Windows, so gating the whole suite
// POSIX-only would leave the one platform that needs it uncovered
// (#8975).
describe('qwen channel stop → start round trip (#8975)', () => {
  // The PR's second core promise — explicit stops are remembered across
  // restarts — has no cross-process coverage in the unit suite: every
  // unit test mocks one half of the stop-write/start-read handoff. Run a
  // REAL service with a real (mock-plugin) channel, stop it with the real
  // CLI, and require the next `channel start` to skip it through the
  // state file both processes derive from the same workspace — a split in
  // path derivation (env/QWEN_HOME resolution) ships green in the unit
  // suite and surfaces only as silently resurrected channels (#8975).
  it('skips an explicitly stopped channel on the next channel start', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-roundtrip-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    mockServer = await createMockServer({ httpPort: 0, wsPort: 0 });

    // Make the mock channel type available via the extension mechanism —
    // the same way a user-installed channel plugin is loaded.
    const extensionDir = path.join(qwenHome, 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(
      path.join(REPO_ROOT, 'packages', 'channels', 'plugin-example'),
      path.join(extensionDir, 'qwen-channel-plugin-example'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      'utf-8',
    );
    writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        channels: {
          mockbot: {
            type: 'plugin-example',
            serverWsUrl: mockServer.wsUrl,
            senderPolicy: 'open',
            sessionScope: 'user',
            cwd: workspace,
          },
        },
      }),
      'utf-8',
    );
    const env = {
      ...process.env,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    };
    const spawnService = () =>
      spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

    // Phase 1: the service starts and the channel really connects; the
    // pidfile lists the connected set the stop will persist (#8975).
    child = spawnService();
    await waitForLine(child, '[Channel] "mockbot" connected.');
    await waitForLine(child, '[Channel] Running 1 channel(s).');
    const pidFile = path.join(qwenHome, 'channels', 'service.pid');
    const pidFileDeadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      if (Date.now() > pidFileDeadline) {
        throw new Error(`Timed out waiting for pid file at ${pidFile}`);
      }
      await sleep(50);
    }
    const serviceExited = new Promise<number | null>((resolve) => {
      child!.once('exit', (code) => resolve(code));
    });
    // Lost-exit-event guard: the listener attaches only after
    // waitForLine + the pidfile poll above — an exit processed during one
    // of those awaits is lost, and unlike the first round-trip test this
    // one has no output assertion that would fail first: phase 2's stop
    // on the crashed service still exits 0 (crash path via
    // peekServiceInfo), so `await serviceExited` would hang into the
    // 120s timeout with none of the crash output. Fail fast (R14-20).
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `service child exited prematurely before phase-2 stop ` +
          `(code ${child.exitCode}, signal ${child.signalCode})`,
      );
    }

    // Phase 2: a real `qwen channel stop` persists the running channel as
    // stopped and terminates the service. The exit-code 0 shape is POSIX
    // graceful-shutdown semantics; on Windows the stop force-terminates,
    // so only wait the termination out there (#8975).
    const stopProc = spawn(process.execPath, [CLI_BIN, 'channel', 'stop'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const stopResult = await runToCompletion(stopProc);
    expect(stopResult.code).toBe(0);
    expect(stopResult.output).toContain('Stopped channels stay stopped');
    if (isPosix) {
      expect(await serviceExited).toBe(0);
    } else {
      await serviceExited;
    }
    child = undefined;

    // Phase 3: the next start reads the state file the stop wrote, skips
    // the stopped channel, and serves with 0 channels instead of
    // resurrecting it.
    child = spawnService();
    await waitForLine(child, '"mockbot" skipped (stopped before restart)');
    await waitForLine(child, 'serving with 0 channels');
    // Liveness: the all-stopped branch must hold the event loop open —
    // the pre-#8975 shape emits both awaited lines, then drains its event
    // loop and self-exits 0, which the graceful-exit assertions below
    // would also match (#8975).
    await sleep(2000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    // Terminate on BOTH platforms: on Windows kill('SIGTERM')
    // force-terminates (Node cannot deliver a catchable SIGTERM there), so
    // only the graceful exit-code assertions are POSIX-gated. Skipping the
    // kill itself on Windows would leak the zero-channel service — kept
    // alive forever by its ref'd keep-alive interval — as an immortal
    // process, because the `child = undefined` below defeats the
    // afterEach SIGKILL sweep (R9-1).
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    if (isPosix) {
      expect(signal).toBeNull();
      expect(code).toBe(0);
    }
    child = undefined;

    // Phase 3b (R15-46): a SECOND bare start must STILL skip. Phase 3's
    // skip is read-only only if the stop record survives being honored —
    // a consume-once mutation (record deleted after selectActiveChannels
    // honors it) passes phase 3 and then phase 4 re-records `active`
    // before phase 5, so every phase stays green while the SECOND restart
    // resurrects the channel (the adoption merge cannot restore a
    // snapshot-identical, generation-unchanged legacy entry). Re-assert
    // the skip before phase 4 re-establishes the record.
    child = spawnService();
    await waitForLine(child, '"mockbot" skipped (stopped before restart)');
    await waitForLine(child, 'serving with 0 channels');
    const secondSkipExited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const secondSkipShutdown = await secondSkipExited;
    if (isPosix) {
      expect(secondSkipShutdown.signal).toBeNull();
      expect(secondSkipShutdown.code).toBe(0);
    }
    child = undefined;

    // Phase 4: an explicit by-name start clears the stop record and the
    // channel connects again — the inverse half of "Stopped channels stay
    // stopped UNTIL STARTED AGAIN BY NAME". Every other service spawn in
    // this file is a bare `channel start`, so the record-clearing write
    // half has no cross-process coverage elsewhere: the unit suite mocks
    // both halves apart (#8975).
    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start', 'mockbot'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    // The by-name path (startSingle) connects first, then reports
    // "is running" — it does not emit the startAll "connected." line.
    await waitForLine(child, '[Channel] "mockbot" is running.');
    // Stop via SIGTERM: a plain shutdown persists no stop record, so the
    // bare start below must run the channel again.
    const byNameExited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const byNameShutdown = await byNameExited;
    if (isPosix) {
      expect(byNameShutdown.signal).toBeNull();
      expect(byNameShutdown.code).toBe(0);
    }
    child = undefined;

    // Phase 5: the next bare start runs the channel — the by-name start
    // cleared the record, so neither the skip line nor the zero-channel
    // serve may appear (#8975).
    child = spawnService();
    await waitForLine(child, '[Channel] Running 1 channel(s).');
    expect(observeChild(child).output).not.toContain(
      '"mockbot" skipped (stopped before restart)',
    );
    const finalExited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const finalShutdown = await finalExited;
    if (isPosix) {
      expect(finalShutdown.signal).toBeNull();
      expect(finalShutdown.code).toBe(0);
    }
    child = undefined;
  }, 180000);

  // The legacy global-file handoff (R11-38): recordStoppedChannels
  // dual-writes the stop record into the legacy global file FOR THIS —
  // the standalone service is a global singleton, so a restart from
  // ANOTHER workspace must still see the stop via adoption. The sibling
  // test above runs every phase from the same cwd and the unit suite
  // mocks each half apart (stop.test.ts mocks the store; start.test.ts
  // mocks adoptLegacyChannelState), so a divergence between the legacy
  // WRITE path (stop.ts's zero-arg channelRuntimeStatePath) and the
  // adoption READ (a start from a different cwd) shipped green — with
  // the user-visible result being exactly the #8975 regression: stopped
  // in workspace A, resurrected by `channel start` from workspace B.
  it('keeps the stop visible to a restart from a SECOND workspace (legacy adoption)', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-crossws-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspaceA = path.join(testRoot, 'workspace-a');
    const workspaceB = path.join(testRoot, 'workspace-b');
    mkdirSync(path.join(workspaceA, '.qwen'), { recursive: true });
    mkdirSync(path.join(workspaceB, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    mockServer = await createMockServer({ httpPort: 0, wsPort: 0 });

    const extensionDir = path.join(qwenHome, 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(
      path.join(REPO_ROOT, 'packages', 'channels', 'plugin-example'),
      path.join(extensionDir, 'qwen-channel-plugin-example'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({
        [workspaceA]: 'TRUST_FOLDER',
        [workspaceB]: 'TRUST_FOLDER',
      }),
      'utf-8',
    );
    // The same project checked out twice: both workspaces configure the
    // channel, so a start from B has something to resurrect.
    const channelsSettings = JSON.stringify({
      channels: {
        mockbot: {
          type: 'plugin-example',
          serverWsUrl: mockServer.wsUrl,
          senderPolicy: 'open',
          sessionScope: 'user',
          cwd: workspaceA,
        },
      },
    });
    writeFileSync(
      path.join(workspaceA, '.qwen', 'settings.json'),
      channelsSettings,
      'utf-8',
    );
    writeFileSync(
      path.join(workspaceB, '.qwen', 'settings.json'),
      channelsSettings,
      'utf-8',
    );
    const env = {
      ...process.env,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    };

    // Phase 1: the service starts from workspace A and connects.
    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
      cwd: workspaceA,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    await waitForLine(child, '[Channel] "mockbot" connected.');
    const pidFile = path.join(qwenHome, 'channels', 'service.pid');
    const pidFileDeadline = Date.now() + 5000;
    while (!existsSync(pidFile)) {
      if (Date.now() > pidFileDeadline) {
        throw new Error(`Timed out waiting for pid file at ${pidFile}`);
      }
      await sleep(50);
    }
    const serviceExited = new Promise<number | null>((resolve) => {
      child!.once('exit', (code) => resolve(code));
    });
    // Lost-exit-event guard, twin of the legacy-adoption round-trip pin
    // (R14-20): same attach-after-await shape, same hang risk.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `service child exited prematurely before phase-2 stop ` +
          `(code ${child.exitCode}, signal ${child.signalCode})`,
      );
    }

    // Phase 2: stop from workspace A — persists the scoped record AND
    // the legacy global record (the dual write under test).
    const stopProc = spawn(process.execPath, [CLI_BIN, 'channel', 'stop'], {
      cwd: workspaceA,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const stopResult = await runToCompletion(stopProc);
    expect(stopResult.code).toBe(0);
    if (isPosix) {
      expect(await serviceExited).toBe(0);
    } else {
      await serviceExited;
    }
    child = undefined;

    // Phase 3: restart from workspace B. Its scoped state file does not
    // exist yet — the stop must reach it through the legacy file's
    // adoption, or mockbot resurrects (#8975).
    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
      cwd: workspaceB,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    await waitForLine(child, '"mockbot" skipped (stopped before restart)');
    await waitForLine(child, 'serving with 0 channels');
    await sleep(2000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    if (isPosix) {
      expect(signal).toBeNull();
      expect(code).toBe(0);
    }
    child = undefined;

    // Phase 3b (R15-46): a SECOND bare start from workspace B must STILL
    // skip — the adopted stop record must survive being honored once, or a
    // consume-once mutation resurrects the channel on the second restart
    // (twin of the legacy-adoption round-trip pin).
    child = spawn(process.execPath, [CLI_BIN, 'channel', 'start'], {
      cwd: workspaceB,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    await waitForLine(child, '"mockbot" skipped (stopped before restart)');
    await waitForLine(child, 'serving with 0 channels');
    const secondSkipExited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const secondSkipShutdown = await secondSkipExited;
    if (isPosix) {
      expect(secondSkipShutdown.signal).toBeNull();
      expect(secondSkipShutdown.code).toBe(0);
    }
    child = undefined;
  }, 120000);
});

// Runs on ALL platforms — the writer/reader path-derivation split this
// round trip pins (both halves hash the workspace via
// hashDaemonWorkspace) realistically triggers only on Windows
// (case-preserving cwd on a case-insensitive FS), where the POSIX-gated
// siblings cannot even collect. Only the graceful-SIGTERM exit-code
// assertions stay POSIX-gated: on Windows kill('SIGTERM') force-
// terminates and the shutdown handler never runs (R9-8).
//
// CI disclosure (R15-24): as of this PR no CI job COLLECTS this file on
// Windows — integration_cli is ubuntu-only, test_windows runs only the
// unit `test:ci` and only on merge_group, and e2e.yml covers Linux+macOS.
// The suite is platform-agnostic so it WILL exercise the Windows
// path-derivation shape wherever it is collected (e.g. locally or by a
// future Windows integration job), but today its Windows-specific value is
// not gated by any job. This comment states what CI actually exercises
// rather than claiming a Windows collection that does not exist.
describe('qwen serve --channel all stop → restart round trip (#8975)', () => {
  // The daemon half of the stop-write → restore-read handoff: every unit
  // test mocks at least one side of the path derivation (daemon-worker
  // tests mock daemonChannelRuntimeStatePath as a constant; route tests
  // mock the manager snapshots). Run a REAL `qwen serve --channel all`
  // with a real (mock-plugin) channel, stop it through the real
  // DELETE /workspace/channel route, restart serve, and require the
  // restored worker to run without the stopped channel — a divergence
  // between the route's write path and the daemon worker's read path
  // ships green through the whole unit suite and surfaces only as
  // explicitly stopped channels silently resurrecting (#8975).
  it('DELETE /workspace/channel keeps the channel stopped across a serve restart', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-channel-daemon-roundtrip-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    mkdirSync(runtimeDir);
    mkdirSync(qwenHome, { recursive: true });
    mockServer = await createMockServer({ httpPort: 0, wsPort: 0 });

    const extensionDir = path.join(qwenHome, 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(
      path.join(REPO_ROOT, 'packages', 'channels', 'plugin-example'),
      path.join(extensionDir, 'qwen-channel-plugin-example'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      'utf-8',
    );
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeFileSync(
      trustedFoldersPath,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      'utf-8',
    );
    writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        channels: {
          mockbot: {
            type: 'plugin-example',
            serverWsUrl: mockServer.wsUrl,
            senderPolicy: 'open',
            sessionScope: 'user',
            cwd: workspace,
          },
        },
      }),
      'utf-8',
    );
    const env = {
      // Strip any inherited bearer token, then set a known one: the
      // DELETE route is a strict mutation that refuses without a token
      // even on loopback, and a token exported on the dev machine or CI
      // runner would otherwise flip auth on with an unknown value
      // (#8975).
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'QWEN_SERVER_TOKEN'),
      ),
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      QWEN_SERVER_TOKEN: 'integration-token-8975',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    };
    // A token is configured, so EVERY route — reads included — requires
    // the bearer header (#8975).
    const authFetch = (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: 'Bearer integration-token-8975',
        },
      });
    // pollHttp uses bare fetch; mirror its loop with the auth header.
    const pollAuthHttp = async (
      url: string,
      accept: (status: number, body: unknown) => boolean,
      timeoutMs = 30000,
    ): Promise<unknown> => {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const res = await authFetch(url);
          const text = await res.text();
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // Not JSON; keep the raw text for the accept predicate.
          }
          if (accept(res.status, body)) return body;
          lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        } catch (error) {
          lastError = error;
        }
        await sleep(250);
      }
      throw new Error(
        `Timed out polling ${url}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    };
    const spawnServe = () =>
      spawn(
        process.execPath,
        [CLI_BIN, 'serve', '--channel', 'all', '--port', '0'],
        {
          cwd: workspace,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      );

    interface ControlState {
      enabled?: boolean;
      transition?: string;
      workers?: Array<{
        state?: string;
        channels?: string[];
        restartCount?: number;
      }>;
    }

    // Phase 1: serve boots with `--channel all` and the channel really
    // connects — the worker reports the committed name.
    child = spawnServe();
    let baseUrl = await waitForListeningUrl(child);
    await pollAuthHttp(`${baseUrl}/health`, (status) => status === 200);
    await pollAuthHttp(`${baseUrl}/workspace/channel`, (_status, body) => {
      const state = body as ControlState;
      return (
        state.enabled === true &&
        state.transition === 'idle' &&
        Array.isArray(state.workers) &&
        state.workers.length > 0 &&
        state.workers[0]!.state === 'running' &&
        (state.workers[0]!.channels ?? []).includes('mockbot')
      );
    });

    // Phase 2: the real DELETE route tears the worker down and persists
    // the stopped record through the daemon path derivation.
    const deleteRes = await authFetch(`${baseUrl}/workspace/channel`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    await pollAuthHttp(
      `${baseUrl}/workspace/channel`,
      (_status, body) => (body as ControlState).enabled === false,
    );

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Lost-exit-event guard, twin of the zero-channel test (R14).
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `serve child exited prematurely before SIGTERM ` +
          `(code ${child.exitCode}, signal ${child.signalCode})`,
      );
    }
    child.kill('SIGTERM');
    const shutdown = await exited;
    // Graceful-exit semantics are POSIX-only: on Windows the kill
    // force-terminates (R9-8).
    if (isPosix) {
      expect(shutdown.signal).toBeNull();
      expect(shutdown.code).toBe(0);
    }
    child = undefined;

    // Phase 3: the restarted serve reads the state file the DELETE route
    // wrote; the stopped channel is skipped, so the restored worker runs
    // with zero channels instead of resurrecting it.
    child = spawnServe();
    baseUrl = await waitForListeningUrl(child);
    await pollAuthHttp(`${baseUrl}/health`, (status) => status === 200);
    const restored = (await pollAuthHttp(
      `${baseUrl}/workspace/channel`,
      (_status, body) => {
        const state = body as ControlState;
        return (
          state.enabled === true &&
          state.transition === 'idle' &&
          Array.isArray(state.workers) &&
          state.workers.length > 0 &&
          state.workers[0]!.state === 'running'
        );
      },
    )) as ControlState;
    expect(restored.workers?.[0]?.channels).toEqual([]);
    // Settling window mirroring the standalone siblings: a serve that
    // self-exits ~1-2s after reporting zero-channel running must fail
    // HERE, not get preempted by the SIGTERM below — the graceful-exit
    // assertions accept a self-exit identically to a clean shutdown
    // (#8975).
    await sleep(2000);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    // Post-window re-poll, twin of the zero-channel test: a crash-
    // restart of the restored worker keeps the serve process alive, so
    // the process-level liveness check above cannot see it. Requiring
    // `restartCount === 0` makes even one crash-restart during the
    // window fail the round trip (R14).
    await pollAuthHttp(`${baseUrl}/workspace/channel`, (_status, body) => {
      const state = body as ControlState;
      return (
        state.enabled === true &&
        state.transition === 'idle' &&
        Array.isArray(state.workers) &&
        state.workers.length > 0 &&
        state.workers[0]!.state === 'running' &&
        state.workers[0]!.restartCount === 0
      );
    });

    const restartedExited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Lost-exit-event guard, twin of the zero-channel test (R14).
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `restarted serve child exited prematurely before SIGTERM ` +
          `(code ${child.exitCode}, signal ${child.signalCode})`,
      );
    }
    child.kill('SIGTERM');
    const restartedShutdown = await restartedExited;
    if (isPosix) {
      expect(restartedShutdown.signal).toBeNull();
      expect(restartedShutdown.code).toBe(0);
    }
    child = undefined;
  }, 180000);
});
