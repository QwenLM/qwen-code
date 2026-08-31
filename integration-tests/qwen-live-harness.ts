/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * e2e harness for the standalone `qwen-live` daemon (packages/qwen-live).
 *
 * Everything here talks to real subprocesses over real network/file
 * boundaries — no package sources are imported:
 *   - `spawnQwenLive` boots `node packages/qwen-live/dist/index.js` with a
 *     hermetic env (tmp data/discovery dirs, fake DashScope endpoint, a real
 *     `qwen serve` URL) and parses the single machine-readable stdout line,
 *     following the `_daemon-harness.spawnDaemon` pattern.
 *   - `FakeHost` speaks Host protocol v6 against the daemon's `/live/host`
 *     WebSocket: discovery-file lookup, Bearer token + `x-qwen-live-nonce`
 *     headers, `host.hello`, auto `host.pong`, auto success replies to
 *     `host.capture_screen_context`, `host.action`, binary input
 *     audio frames (8-byte BigUInt64BE epoch prefix + PCM16), and records
 *     `host.welcome`/`host.state` plus raw output PCM frames.
 *   - `bootLiveStack` assembles the full fixture: tmp workspace + HOME, a
 *     fake OpenAI model endpoint, a real `qwen serve`, a fake DashScope
 *     realtime server, the qwen-live daemon, and a connected FakeHost.
 *   - `waitForLiveLogEvents` reads the daemon's append-only session JSONL
 *     (`<dataDir>/sessions/*.jsonl`) as a synchronization point for
 *     daemon-internal happenings (e.g. "the backend turn_complete event
 *     reached the orchestrator") that have no other observable edge.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  sleep,
  spawnDaemon,
  type SpawnedDaemon,
} from './cli/_daemon-harness.js';
import {
  startFakeDashScopeServer,
  type FakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
  type FakeOpenAIServer,
} from './fake-openai-server.js';

type JsonObject = Record<string, unknown>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QWEN_LIVE_BIN = path.resolve(
  __dirname,
  '../packages/qwen-live/dist/index.js',
);

export const QWEN_LIVE_REALTIME_MODEL = 'fake-omni-realtime';
export const QWEN_LIVE_API_KEY = 'sk-test';
const SERVE_TOKEN = 'qwen-live-e2e-token';
const LIVE_LISTENING_RE = /qwen-live listening on http:\/\/127\.0\.0\.1:(\d+)/;
const DISPOSE_GRACE_MS = 10_000;
const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host';
const LIVE_HOST_PROTOCOL_VERSION = 6;
const LIVE_INPUT_AUDIO_EPOCH_BYTES = 8;

// -- small async utilities ----------------------------------------------------

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

// -- discovery ---------------------------------------------------------------

export interface LiveDiscoveryRecordShape {
  url: string;
  token?: string;
  protocolVersion: number;
  pid: number;
  instanceNonce: string;
}

export function liveDiscoveryPath(discoveryDir: string): string {
  return path.join(discoveryDir, 'live', 'daemon.json');
}

export async function readLiveDiscovery(
  discoveryDir: string,
): Promise<LiveDiscoveryRecordShape> {
  const raw = await readFile(liveDiscoveryPath(discoveryDir), 'utf8');
  return JSON.parse(raw) as LiveDiscoveryRecordShape;
}

// -- qwen-live daemon process --------------------------------------------------

export interface SpawnQwenLiveOptions {
  serveUrl: string;
  serveToken: string;
  realtimeEndpoint: string;
  dataDir: string;
  discoveryDir: string;
  /** Default workspace cwd for handoff-created sessions (QWEN_LIVE_CWD). */
  cwd: string;
  apiKey?: string;
  model?: string;
  bootTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface SpawnedQwenLive {
  proc: ChildProcess;
  port: number;
  url: string;
  stdoutBuf: { value: string };
  stderrBuf: { value: string };
  /** Idempotent. SIGTERM, wait up to 10s, then SIGKILL. */
  dispose: () => Promise<void>;
}

export async function spawnQwenLive(
  opts: SpawnQwenLiveOptions,
): Promise<SpawnedQwenLive> {
  const bootTimeoutMs = opts.bootTimeoutMs ?? 15_000;
  const proc = spawn(process.execPath, [QWEN_LIVE_BIN], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DASHSCOPE_API_KEY: opts.apiKey ?? QWEN_LIVE_API_KEY,
      QWEN_LIVE_REALTIME_ENDPOINT: opts.realtimeEndpoint,
      QWEN_LIVE_REALTIME_MODEL: opts.model ?? QWEN_LIVE_REALTIME_MODEL,
      QWEN_LIVE_SERVE_URL: opts.serveUrl,
      QWEN_SERVER_TOKEN: opts.serveToken,
      QWEN_LIVE_DATA_DIR: opts.dataDir,
      QWEN_LIVE_DISCOVERY_DIR: opts.discoveryDir,
      QWEN_LIVE_CWD: opts.cwd,
      QWEN_LIVE_PORT: '0',
      ...opts.env,
    },
  });

  const stdoutBuf = { value: '' };
  const stderrBuf = { value: '' };
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf.value += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf.value += chunk.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.off('exit', onExit);
      clearTimeout(bootTimer);
    };
    const fail = (error: Error, kill = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (kill && proc.exitCode === null) proc.kill('SIGTERM');
      reject(error);
    };
    const bootTimer = setTimeout(() => {
      fail(
        new Error(
          `qwen-live boot timeout after ${bootTimeoutMs}ms:\n` +
            `stdout=${stdoutBuf.value}\nstderr=${stderrBuf.value}`,
        ),
        true,
      );
    }, bootTimeoutMs);
    const onData = () => {
      const match = stdoutBuf.value.match(LIVE_LISTENING_RE);
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code: number | null) => {
      fail(
        new Error(
          `qwen-live exited with ${code} before listening:\n` +
            `stdout=${stdoutBuf.value}\nstderr=${stderrBuf.value}`,
        ),
      );
    };
    proc.stdout!.on('data', onData);
    proc.once('exit', onExit);
  });

  const dispose = async () => {
    // Signal death leaves exitCode null and sets signalCode instead — both
    // mean the child is already gone and the 'exit' event already fired.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, DISPOSE_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    stdoutBuf,
    stderrBuf,
    dispose,
  };
}

// -- fake Host (protocol v6) ---------------------------------------------------

export interface FakeHostStateEntry {
  type: 'host.welcome' | 'host.state';
  epoch: number;
  status: JsonObject;
}

export interface FakeHostWaitOptions {
  timeoutMs?: number;
  /** Only consider entries at or after this index (default 0). */
  fromIndex?: number;
}

export class FakeHost {
  /** Every parsed text frame from the daemon, in arrival order. */
  readonly messages: JsonObject[] = [];
  /** host.welcome / host.state frames, normalized. */
  readonly states: FakeHostStateEntry[] = [];
  /** Raw binary output frames (bare PCM16). */
  readonly audioFrames: Buffer[] = [];

  private socket: WebSocket | undefined;
  private readonly emitter = new EventEmitter();
  private readonly hostInstanceNonce = randomUUID();
  private screenshotPath: string | undefined;

  constructor(private readonly discoveryDir: string) {
    this.emitter.setMaxListeners(0);
  }

  /** Read the discovery file, connect, send host.hello, await host.welcome. */
  async connect(timeoutMs = 10_000): Promise<void> {
    const record = await readLiveDiscovery(this.discoveryDir);
    const socket = new WebSocket(
      `${record.url.replace(/^http/, 'ws')}/live/host`,
      {
        headers: {
          Authorization: `Bearer ${record.token ?? ''}`,
          'x-qwen-live-nonce': record.instanceNonce,
        },
      },
    );
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data)
          ? Buffer.from(data)
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        this.audioFrames.push(frame);
        this.emitter.emit('audio', frame);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const message = parsed as JsonObject;
      this.messages.push(message);
      if (message['type'] === 'host.ping') {
        this.send({ type: 'host.pong', pingId: message['pingId'] });
      } else if (message['type'] === 'host.capture_screen_context') {
        // The hello advertises `appshot: true`, so the daemon may request a
        // capture; settle it immediately (a real Host replies with a
        // screenshot it wrote to disk plus the accessibility dump).
        this.send({
          type: 'host.screen_context_result',
          requestId: message['requestId'],
          success: true,
          appName: 'FakeApp',
          windowTitle: 'Fake Window',
          accessibilityText: 'fake accessibility text',
          screenshotPath: this.fakeScreenshotPath(),
        });
      } else if (
        message['type'] === 'host.welcome' ||
        message['type'] === 'host.state'
      ) {
        const entry: FakeHostStateEntry = {
          type: message['type'],
          epoch: Number(message['epoch']),
          status: (message['status'] ?? {}) as JsonObject,
        };
        this.states.push(entry);
        this.emitter.emit('state', entry);
      }
      this.emitter.emit('message', message);
    });
    socket.on('close', (code, reason) => {
      this.emitter.emit('close', code, String(reason));
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      }),
      timeoutMs,
      'the /live/host WebSocket to open',
    );
    this.send({
      type: 'host.hello',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      hostVersion: '1.0.0-e2e',
      bundleId: LIVE_HOST_BUNDLE_ID,
      instanceNonce: this.hostInstanceNonce,
      permissions: {
        microphone: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      selfChecks: {
        audioInput: true,
        audioOutput: true,
        globalShortcut: true,
        appshot: true,
      },
    });
    await this.waitForState((entry) => entry.type === 'host.welcome', {
      timeoutMs,
    });
  }

  action(action: 'toggle' | 'new' | 'stop'): void {
    this.send({ type: 'host.action', action });
  }

  /** Input audio frame: 8-byte BigUInt64BE epoch prefix + PCM16 payload. */
  sendAudio(epoch: number, pcm16: Buffer): void {
    const frame = Buffer.alloc(LIVE_INPUT_AUDIO_EPOCH_BYTES + pcm16.byteLength);
    frame.writeBigUInt64BE(BigInt(epoch), 0);
    pcm16.copy(frame, LIVE_INPUT_AUDIO_EPOCH_BYTES);
    this.socketOrThrow().send(frame, { binary: true });
  }

  waitForState(
    predicate: (entry: FakeHostStateEntry) => boolean,
    opts: FakeHostWaitOptions = {},
  ): Promise<FakeHostStateEntry> {
    const fromIndex = opts.fromIndex ?? 0;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    for (let i = Math.max(fromIndex, 0); i < this.states.length; i++) {
      if (predicate(this.states[i])) return Promise.resolve(this.states[i]);
    }
    return new Promise<FakeHostStateEntry>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off('state', onState);
      };
      const timer = setTimeout(() => {
        cleanup();
        const recent = this.states
          .slice(-8)
          .map((entry) => `${entry.type}:${String(entry.status['state'])}`)
          .join(', ');
        reject(
          new Error(
            `FakeHost: timed out after ${timeoutMs}ms waiting for a host ` +
              `state (recent: ${recent})`,
          ),
        );
      }, timeoutMs);
      const onState = (entry: FakeHostStateEntry) => {
        if (!predicate(entry)) return;
        cleanup();
        resolve(entry);
      };
      this.emitter.on('state', onState);
    });
  }

  waitForAudioFrame(opts: FakeHostWaitOptions = {}): Promise<Buffer> {
    const fromIndex = opts.fromIndex ?? 0;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (this.audioFrames.length > fromIndex) {
      return Promise.resolve(this.audioFrames[fromIndex]);
    }
    return new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off('audio', onAudio);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `FakeHost: timed out after ${timeoutMs}ms waiting for an output ` +
              `audio frame (have ${this.audioFrames.length})`,
          ),
        );
      }, timeoutMs);
      const onAudio = () => {
        if (this.audioFrames.length <= fromIndex) return;
        cleanup();
        resolve(this.audioFrames[fromIndex]);
      };
      this.emitter.on('audio', onAudio);
    });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }

  private send(message: JsonObject): void {
    this.socketOrThrow().send(JSON.stringify(message));
  }

  /**
   * Lazily materialize a real (1x1) PNG for `host.screen_context_result`:
   * the daemon registers the path as an asset, so it should exist on disk.
   * Written into the discovery dir, which the fixture already tears down.
   */
  private fakeScreenshotPath(): string {
    if (!this.screenshotPath) {
      const file = path.join(this.discoveryDir, 'fake-appshot.png');
      writeFileSync(
        file,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8' +
            'z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      this.screenshotPath = file;
    }
    return this.screenshotPath;
  }

  private socketOrThrow(): WebSocket {
    if (!this.socket) throw new Error('FakeHost is not connected');
    return this.socket;
  }
}

// -- daemon session log (JSONL) ------------------------------------------------

export interface LiveLogEvent {
  ts: number;
  seq: number;
  type: string;
  payload: JsonObject;
}

export async function readLiveLogEvents(
  dataDir: string,
): Promise<LiveLogEvent[]> {
  const sessionsDir = path.join(dataDir, 'sessions');
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const events: LiveLogEvent[] = [];
  for (const file of files.sort()) {
    if (!file.includes('.jsonl')) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(sessionsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LiveLogEvent);
      } catch {
        /* torn tail line while the daemon is mid-write */
      }
    }
  }
  return events;
}

/**
 * Wait until at least `minCount` session-log events match `predicate`.
 * The JSONL log has no push channel, so this is a bounded condition-poll
 * with an explicit deadline (25ms period).
 */
export async function waitForLiveLogEvents(
  dataDir: string,
  predicate: (event: LiveLogEvent) => boolean,
  opts: { minCount?: number; timeoutMs?: number; description?: string } = {},
): Promise<LiveLogEvent[]> {
  const minCount = opts.minCount ?? 1;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matches = (await readLiveLogEvents(dataDir)).filter(predicate);
    if (matches.length >= minCount) return matches;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ` +
          `${opts.description ?? 'live session-log events'} ` +
          `(${matches.length}/${minCount})`,
      );
    }
    await sleep(25);
  }
}

// -- full fixture ---------------------------------------------------------------

export interface BootLiveStackOptions {
  /**
   * Builds the fake OpenAI handler once the fixture directories exist, so
   * handlers can reference paths inside the workspace.
   */
  makeOpenAIHandler: (info: { workspaceDir: string }) => FakeOpenAIHandler;
}

export interface LiveStack {
  workspaceDir: string;
  homeDir: string;
  dataDir: string;
  discoveryDir: string;
  fakeOpenAI: FakeOpenAIServer;
  serve: SpawnedDaemon;
  fakeDash: FakeDashScopeServer;
  live: SpawnedQwenLive;
  host: FakeHost;
  /**
   * Session created directly by the test harness to pre-spawn the serve
   * daemon's ACP child (kept open for the fixture's lifetime). Tests that
   * enumerate serve sessions should exclude this id.
   */
  prewarmSessionId: string;
  dispose(): Promise<void>;
}

export async function bootLiveStack(
  options: BootLiveStackOptions,
): Promise<LiveStack> {
  const workspaceDir = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'qwen-live-e2e-ws-')),
  );
  const homeDir = mkdtempSync(path.join(tmpdir(), 'qwen-live-e2e-home-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qwen-live-e2e-data-'));
  const discoveryDir = mkdtempSync(path.join(tmpdir(), 'qwen-live-e2e-disc-'));
  const qwenHome = path.join(homeDir, '.qwen');
  mkdirSync(qwenHome, { recursive: true });
  // Keep the model round-trips predictable: no follow-up suggestion turns.
  writeFileSync(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
  );

  const disposers: Array<() => Promise<void> | void> = [];
  const disposeAll = async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* keep tearing down */
      }
    }
    // Debug escape hatch: keep the temp dirs (session JSONL logs live in
    // `<dataDir>/sessions`) for post-mortem inspection. KEEP_OUTPUT=true is
    // the repo-wide convention (test-helper.ts, globalSetup.ts) and is set
    // by the e2e lanes; QWEN_LIVE_E2E_KEEP keeps only these fixtures.
    if (
      !process.env['QWEN_LIVE_E2E_KEEP'] &&
      process.env['KEEP_OUTPUT'] !== 'true'
    ) {
      for (const dir of [workspaceDir, homeDir, dataDir, discoveryDir]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };

  try {
    const fakeOpenAI = await startFakeOpenAIServer(
      options.makeOpenAIHandler({ workspaceDir }),
    );
    disposers.push(() => fakeOpenAI.close());

    const serve = await spawnDaemon({
      workspaceCwd: workspaceDir,
      token: SERVE_TOKEN,
      bootTimeoutMs: 30_000,
      env: {
        HOME: homeDir,
        QWEN_HOME: qwenHome,
        QWEN_ACP_LOCAL_READ_ROOTS: '',
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeOpenAI.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        http_proxy: '',
        https_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        all_proxy: '',
      },
    });
    disposers.push(() => serve.dispose());

    // Pre-spawn the serve daemon's ACP child so the qwen-live orchestrator's
    // first createSession (inside the 5s tool-dispatch budget) is fast.
    const prewarm = await serve.client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });

    const fakeDash = await startFakeDashScopeServer();
    disposers.push(() => fakeDash.close());

    const live = await spawnQwenLive({
      serveUrl: serve.base,
      serveToken: SERVE_TOKEN,
      realtimeEndpoint: fakeDash.url,
      dataDir,
      discoveryDir,
      cwd: workspaceDir,
    });
    disposers.push(() => live.dispose());

    const host = new FakeHost(discoveryDir);
    disposers.push(() => {
      host.close();
    });
    await host.connect();

    return {
      workspaceDir,
      homeDir,
      dataDir,
      discoveryDir,
      fakeOpenAI,
      serve,
      fakeDash,
      live,
      host,
      prewarmSessionId: prewarm.sessionId,
      dispose: disposeAll,
    };
  } catch (error) {
    await disposeAll();
    throw error;
  }
}

/**
 * Drive the Host `toggle` action and wait for the call to become live:
 * returns the realtime connection the daemon opened against the fake
 * DashScope server and the call epoch (from the `listening` host.state).
 */
export async function startLiveCall(stack: LiveStack): Promise<{
  epoch: number;
  conn: Awaited<ReturnType<FakeDashScopeServer['waitForConnection']>>;
}> {
  const stateIndex = stack.host.states.length;
  const connection = stack.fakeDash.waitForConnection(20_000);
  stack.host.action('toggle');
  const conn = await connection;
  const listening = await stack.host.waitForState(
    (entry) => entry.status['state'] === 'listening',
    { timeoutMs: 20_000, fromIndex: stateIndex },
  );
  return { epoch: listening.epoch, conn };
}
