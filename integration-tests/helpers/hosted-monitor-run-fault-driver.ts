/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// FG8 (issue #14054): the fault-injection driver for the monitor_run and
// background-shell fault gates. Each case boots its own packaged Harness
// against a broker-fronting operation log, drives the real public/WebShell
// SSE streams of the Session, and proves continuity across abort/resume
// while the background capability keeps progressing. JDBC ground truth
// lives behind the IT's probe; this driver reports stream frames, broker
// operations and model calls.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { relayUpstream } from './hosted-relay-headers.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  letter: string;
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  statusGateUrl: string;
  cases: Array<{
    name: string;
    sessionId: string;
    workspaceId: string;
    directory: string;
  }>;
  resultFile: string;
};

type Frame = { id: number; event: string; data: Record<string, unknown> };

class Observer {
  frames: Frame[] = [];
  controller = new AbortController();
  task?: Promise<void>;
  failure?: unknown;

  constructor(
    private readonly surface: 'public' | 'web',
    private readonly sessionId: string,
  ) {}

  async start(after?: number) {
    const response = await fetch(
      new URL(
        this.surface === 'public'
          ? `/v1/agents/sessions/${this.sessionId}/events?stream=true&after=0`
          : '/api/agent/web-shell/v1/events/stream',
        config.storeUrl,
      ),
      {
        method: this.surface === 'public' ? 'GET' : 'POST',
        headers: {
          'X-Qwen-Tenant-Id': config.tenantId,
          Accept: 'text/event-stream',
          ...(this.surface === 'web'
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(this.surface === 'public' && after !== undefined
            ? { 'Last-Event-ID': String(after) }
            : {}),
        },
        ...(this.surface === 'web'
          ? {
              body: JSON.stringify({
                sessionId: this.sessionId,
                afterSequence: after ?? 0,
              }),
            }
          : {}),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(300_000),
        ]),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/event-stream/,
    );
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    this.task = (async () => {
      let pending = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const lines = block.split('\n');
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const frame = {
              id: Number(
                lines
                  .find((line) => line.startsWith('id:'))
                  ?.slice(3)
                  .trim(),
              ),
              event:
                lines
                  .find((line) => line.startsWith('event:'))
                  ?.slice(6)
                  .trim() ?? '',
              data: JSON.parse(data) as Record<string, unknown>,
            };
            assert.match(String(frame.id), /^\d+$/);
            assert.equal(
              frame.id,
              frame.data['sequence'],
              'SSE id must equal payload sequence',
            );
            assert.equal(frame.event, frame.data['type']);
            this.frames.push(frame);
          }
        }
      } catch (cause) {
        if (!this.controller.signal.aborted) this.failure = cause;
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /** The turn a frame belongs to, read in the surface's own key style. */
  turnIdOf(frame: Frame): string | undefined {
    const value = frame.data[this.surface === 'web' ? 'turnId' : 'turn_id'];
    return typeof value === 'string' ? value : undefined;
  }

  /** Wait until a terminal frame of a turn other than {@code exclude} arrived. */
  async terminalOfOtherTurn(exclude: string) {
    await waitUntil(() => {
      if (this.failure) throw this.failure;
      return this.frames.some((frame) => {
        const turnId = this.turnIdOf(frame);
        return (
          frame.data['terminal'] === true &&
          turnId !== undefined &&
          turnId !== exclude
        );
      });
    }, 120_000);
  }

  async close() {
    this.controller.abort();
    await this.task;
    if (this.failure) throw this.failure;
  }
}

async function probe<T>(
  sessionId: string,
  phase: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    new URL(`/fg8/${sessionId}/${phase}`, config.statusGateUrl),
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as T;
}

// One Session per case on the background-capable v3 lane: the captureBytes
// budget is what admits is_background and monitor at all.
async function createSession(
  cli: HostedHarnessProcess,
  storeBaseUrl: string,
): Promise<{ clientId: string; created: Record<string, unknown> }> {
  const created = await cli.request('/session', {
    method: 'POST',
    headers: { ...cli.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: current.sessionId,
      sessionScope: 'thread',
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 64 * 1024 * 1024,
      managedSessionStore: {
        baseUrl: storeBaseUrl,
        tenantId: config.tenantId,
        workspaceId: current.workspaceId,
        writerId: cli.bootId,
        leaseDurationMs: 60_000,
      },
    }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 200, createdBody);
  const parsed = JSON.parse(createdBody) as Record<string, unknown>;
  return { clientId: parsed['clientId'] as string, created: parsed };
}

async function submitPrompt(
  cli: HostedHarnessProcess,
  clientId: string,
  text: string,
): Promise<string> {
  const prompt = [{ type: 'text', text }];
  const promptId = randomUUID();
  const submitted = await cli.request(`/session/${current.sessionId}/prompt`, {
    method: 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptId,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    }),
  });
  assert.equal(submitted.status, 202, await submitted.text());
  return promptId;
}

// The shared failure dump: the harness's daemon log tail, the store-side
// ground truth, and the case directory's evidence files. Each catch passes
// its case-specific fields in the header.
async function diagnose(cli: HostedHarnessProcess, header: string) {
  let daemonLog = '<unavailable>';
  try {
    daemonLog = await readFile(
      path.join(cli.root, 'runtime/debug/daemon/daemon.log'),
      'utf8',
    );
  } catch {
    // best effort — the harness root may already be gone
  }
  let finalState = '<unavailable>';
  try {
    finalState = JSON.stringify(await probe(current.sessionId, 'state'))?.slice(
      -3000,
    );
  } catch (stateError) {
    finalState = `<state probe failed: ${stateError}>`;
  }
  let caseFiles = '<unavailable>';
  try {
    caseFiles = readdirSync(current.directory)
      .map(
        (name) =>
          `${name}@${statSync(path.join(current.directory, name)).mtimeMs}`,
      )
      .join(',');
    try {
      caseFiles +=
        ' mon-mark=[' +
        readFileSync(path.join(current.directory, 'mon-mark.txt'), 'utf8')
          .trim()
          .replaceAll('\n', ' ') +
        ']';
    } catch {
      // no monitor timeline on this case
    }
  } catch {
    // best effort — the case directory may already be gone
  }
  console.error(
    `FG8_DIAG ${current.name} ${header}\n` +
      `finalState=${finalState}\n` +
      `caseFiles=${caseFiles}\n` +
      `daemonLogTail=${daemonLog.slice(-3000)}\n` +
      `harness output:\n${cli.output}`,
  );
}

type ProbeState = {
  executions: Array<{
    execution_call_id: string;
    execution_state: string;
    execution_status: string | null;
  }>;
  monitors: Array<Record<string, unknown>>;
  childRuns: Array<Record<string, unknown>>;
  resources: Array<{
    resource_id: string;
    kind: string;
    byte_length: number;
    sha256: string;
  }>;
};

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// The background producer: announce, hold on a FIFO the driver owns, then
// finish. The gate makes "mid-run" a deterministic state, never a sleep.
function backgroundProducer(): string {
  return [
    "const fs = require('fs');",
    "fs.writeFileSync('bg-started.txt', String(process.pid));",
    "process.stdout.write('FG8_RUN_STARTED\\n');",
    "fs.readFileSync('run-gate');",
    "process.stdout.write('FG8_RUN_RESUMED\\n');",
  ].join('\n');
}

// The monitor producer: one observation window, a deterministic hold, then
// the second window that reaches max_events and auto-stops the watch. The
// mon-mark timeline makes "where was the producer when the watch idled
// out" readable from the case directory. The producer never exits on its
// own: a natural exit closes the scope and its cancel write races the
// quota settle, flipping the record to stop_requested (seen twice on the
// lane) — so the quota stop's kill is the only way out.
function monitorProducer(): string {
  return [
    "const fs = require('fs');",
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    "const mark = (s) => fs.appendFileSync('mon-mark.txt', `${s} ${Date.now()}\\n`);",
    '(async () => {',
    "  mark('start');",
    "  process.stdout.write('FG8_MON_0\\n');",
    "  mark('wrote0');",
    '  await sleep(1600);',
    "  mark('past-sleep');",
    "  fs.writeFileSync('mon-mid.txt', '1');",
    "  mark('at-gate');",
    "  fs.readFileSync('monitor-gate');",
    "  mark('past-gate');",
    "  process.stdout.write('FG8_MON_1\\n');",
    '  await sleep(1600);',
    "  process.stdout.write('FG8_MON_2\\n');",
    "  mark('done');",
    '  await new Promise(() => {});',
    '})();',
  ].join('\n');
}

// FG8f output delivery: the producer writes deterministic one-segment
// blocks — block i repeats its own index line to exactly 1 MiB — so the
// gate-side digest of every committed segment is computable without moving
// the bytes. A progress.txt line lands after the pipe accepts a block,
// which is what makes the pause watermark's reach into the producer
// observable. The two implementations must stay byte-identical to the IT's
// Java-side expectation builder.
const SEGMENT_BYTES = 1024 * 1024;

// Finite producer: `blocks` full segments awaited against pipe
// backpressure, then a FIFO hold so the driver sequences the exit
// cascade, then a short tail line.
function patternProducer(blocks: number, gate: string): string {
  return [
    "const fs = require('fs');",
    "const line = (i) => `FG8B${String(i).padStart(8, '0')};`;",
    'const write = (buf) => new Promise((res) =>',
    "  process.stdout.write(buf) ? res() : process.stdout.once('drain', res));",
    '(async () => {',
    "  fs.writeFileSync('bg-started.txt', String(process.pid));",
    `  for (let i = 0; i < ${blocks}; i++) {`,
    '    await write(Buffer.alloc(1048576, line(i)));',
    "    fs.appendFileSync('progress.txt', `${i}\\n`);",
    '  }',
    `  fs.readFileSync('${gate}');`,
    "  process.stdout.write('FG8_PRODUCER_DONE\\n');",
    '})();',
  ].join('\n');
}

// Kill-case producer: paced full segments forever — the capture is
// mid-append whenever the gate fires, never parked at a boundary.
function pacedProducer(): string {
  return [
    "const fs = require('fs');",
    "const line = (i) => `FG8B${String(i).padStart(8, '0')};`;",
    'const write = (buf) => new Promise((res) =>',
    "  process.stdout.write(buf) ? res() : process.stdout.once('drain', res));",
    '(async () => {',
    "  fs.writeFileSync('bg-started.txt', String(process.pid));",
    '  for (let i = 0; ; i++) {',
    '    await write(Buffer.alloc(1048576, line(i)));',
    "    fs.appendFileSync('progress.txt', `${i}\\n`);",
    '    await new Promise((r) => setTimeout(r, 100));',
    '  }',
    '})();',
  ].join('\n');
}

function producerFor(name: string): { monitor: boolean; script: string } {
  if (name.includes('monitor')) {
    return { monitor: true, script: monitorProducer() };
  }
  switch (name) {
    case 'publisher-kill-mid-capture':
      return { monitor: false, script: pacedProducer() };
    case 'in-flight-cap':
    case 'receipt-drop-after-watermark':
      return { monitor: false, script: patternProducer(24, 'run-gate') };
    default:
      return { monitor: false, script: backgroundProducer() };
  }
}

// The step log carries the case-relative clock so a stall's timeline is
// readable straight off the driver log.
let caseStart = Date.now();
function step(text: string) {
  console.log(`FG8_STEP ${current.name} ${text} @+${Date.now() - caseStart}ms`);
}

async function releaseFifo(directory: string, name: string) {
  // Bounded: a producer that never opens the gate for reading must surface
  // as a named failure (with the case's DIAG), not a silent hang.
  const deadline = Date.now() + 90_000;
  let writer;
  for (;;) {
    try {
      writer = await open(
        path.join(directory, name),
        constants.O_WRONLY | constants.O_NONBLOCK,
      );
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENXIO') throw cause;
      if (Date.now() >= deadline) {
        throw new Error(
          `the producer never opened ${name} for reading within 90s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await writer.write('go');
  } finally {
    await writer.close();
  }
}

const operations: string[] = [];
let proxyFailure: unknown;
const brokerProxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, config.brokerUrl);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    operations.push(operation);
    console.log(`FG8_PROXY ${req.method} ${operation} begin`);
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    console.log(`FG8_PROXY ${req.method} ${operation} -> ${upstream.status}`);
    relayUpstream(res, upstream, bytes);
  } catch (cause) {
    proxyFailure = cause;
    console.log(`FG8_PROXY failed: ${cause}`);
    res.destroy();
  }
});
await new Promise<void>((resolve) =>
  brokerProxy.listen(0, '127.0.0.1', resolve),
);
const proxyAddress = brokerProxy.address();
assert(proxyAddress && typeof proxyAddress !== 'string');
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

// FG8f's store-fronting proxy: an output-delivery case creates its Session
// with managedSessionStore.baseUrl pointing here, so the case can hold
// full segment commits (the pause watermark must then reach the producer)
// or drop one journal-commit reply after it landed (the re-drive must
// resolve by the original capture identity). Everything else relays
// verbatim.
let storeProxyFailure: unknown;
let holdSegments = false;
let heldSegments = 0;
const heldReplies: Array<() => void> = [];
let dropNextCommit = false;
let droppedCommits = 0;
const commitLog: Array<{ op: string; status: number | 'dropped' }> = [];
const storeProxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, config.storeUrl);
    let parsed: Record<string, unknown> | undefined;
    if (req.method === 'POST' && body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
    }
    if (
      holdSegments &&
      req.method === 'POST' &&
      url.pathname.endsWith('/tool-results:publish') &&
      parsed?.['kind'] === 'managed-tool-result-content' &&
      parsed?.['byteLength'] === SEGMENT_BYTES
    ) {
      heldSegments++;
      console.log(`FG8_STORE_PROXY hold segment ${heldSegments}`);
      // Held BEFORE the commit reaches the store: the committed prefix
      // freezes while the producer's pipe backs up to the pause watermark.
      await new Promise<void>((resolve) => heldReplies.push(resolve));
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length'].includes(key)) continue;
      if (typeof value === 'string') headers[key] = value;
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const isCommit =
      req.method === 'POST' &&
      (/:commit(?:-v2)?$/.test(url.pathname) ||
        url.pathname.endsWith('/receipts/commit'));
    if (isCommit && dropNextCommit) {
      dropNextCommit = false;
      droppedCommits++;
      // The commit landed; the reply never does. A socket destroy is the
      // loss — no HTTP status the harness could mistake for a refusal.
      commitLog.push({
        op: String(parsed?.['operation']),
        status: 'dropped',
      });
      console.log(`FG8_DROPPED commit ${url.pathname}`);
      req.socket.destroy();
      return;
    }
    if (isCommit) {
      commitLog.push({
        op: String(parsed?.['operation']),
        status: upstream.status,
      });
      console.log(
        `FG8_STORE_PROXY commit op=${String(parsed?.['operation'])} -> ${upstream.status}`,
      );
    }
    relayUpstream(res, upstream, bytes);
  } catch (cause) {
    storeProxyFailure = cause;
    console.log(`FG8_STORE_PROXY failed: ${cause}`);
    res.destroy();
  }
});
await new Promise<void>((resolve) =>
  storeProxy.listen(0, '127.0.0.1', resolve),
);
const storeProxyAddress = storeProxy.address();
assert(storeProxyAddress && typeof storeProxyAddress !== 'string');
const storeProxyUrl = `http://127.0.0.1:${storeProxyAddress.port}`;

function releaseHeldSegments() {
  holdSegments = false;
  const pending = heldReplies.splice(0);
  console.log(`FG8_STORE_PROXY release ${pending.length} held segments`);
  for (const resolve of pending) resolve();
}

function checkStoreProxy() {
  if (storeProxyFailure) throw storeProxyFailure;
}

let current = config.cases[0];
let modelCalls = 0;
const model = await startFakeOpenAIServer(() => {
  modelCalls++;
  const producer = producerFor(current.name);
  if (modelCalls === 1) {
    return {
      toolCalls: [
        producer.monitor
          ? fakeToolCall(
              'monitor',
              {
                command: `${quote(process.execPath)} -e ${quote(producer.script)}`,
                max_events: 2,
                // The fixture's 60 s events poll/heartbeat can hold a
                // WebShell resume for a full poll cycle; the watch's idle
                // window must outlive that, or it idle-kills the gated
                // producer mid-gap and the gate never reopens.
                idle_timeout_ms: 180_000,
                description: `fg8 ${current.name}`,
              },
              'monitor-watch',
            )
          : fakeToolCall(
              'run_shell_command',
              {
                command: `${quote(process.execPath)} -e ${quote(producer.script)}`,
                is_background: true,
                timeout: 120_000,
                description: `fg8 ${current.name}`,
              },
              'background-shell',
            ),
      ],
    };
  }
  return { content: `FG8 ${current.name} turn ${modelCalls}.` };
});

function checkProxy() {
  if (proxyFailure) throw proxyFailure;
}

// The events one case's Session committed, projected exactly the way the
// public/WebShell surfaces shape them (FG6e's field mapping).
function projection(rows: Array<Record<string, unknown>>, surface: string) {
  return rows.map((row) => {
    const fields: Record<string, unknown> = {
      schema_version: row['schema_version'],
      projection_version: row['projection_version'],
      sequence: row['sequence_id'],
      event_id: row['event_id'],
      session_id: row['session_id'],
      turn_id: row['turn_id'],
      item_id: row['item_id'],
      content_part_id: row['content_part_id'],
      type: row['event_type'],
      created_at:
        surface === 'public'
          ? Math.floor(Number(row['gmt_create']) / 1000)
          : row['gmt_create'],
      data: JSON.parse(String(row['data_json'])),
      terminal: Boolean(row['terminal']),
    };
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => [
          surface === 'web'
            ? key.replace(/_([a-z])/g, (_, letter: string) =>
                letter.toUpperCase(),
              )
            : key,
          value,
        ]),
    );
  });
}

async function runStreamCase(surface: 'public' | 'web') {
  const monitor = current.name.includes('monitor');
  const observer = new Observer(surface, current.sessionId);
  // Hoisted so the DIAG catch can dump both halves of the stream.
  let resumed: Observer | undefined;
  const cli = new HostedHarnessProcess();
  step('harness boot');
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  try {
    execFileSync('mkfifo', [
      path.join(current.directory, monitor ? 'monitor-gate' : 'run-gate'),
    ]);
    const { clientId, created } = await createSession(cli, config.storeUrl);
    await probe(current.sessionId, 'relay-start', {
      created,
      baseUrl: cli.baseUrl,
      bootId: cli.bootId,
    });
    step('relay started');
    await observer.start();
    const promptId = await submitPrompt(
      cli,
      clientId,
      `fg8 ${current.name} launch`,
    );
    step('prompt admitted');
    // The launch turn settles while the capability keeps running: the
    // background process holds its gate, the monitor holds between windows.
    await waitUntil(async () => {
      checkProxy();
      if (observer.failure) throw observer.failure;
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const launchSettled = observer.frames.some(
        (frame) =>
          frame.data['terminal'] === true &&
          observer.turnIdOf(frame) === promptId,
      );
      if (!launchSettled) return false;
      if (monitor) {
        const watch = state.monitors[0] as
          | { observationSequence?: number }
          | undefined;
        return (watch?.observationSequence ?? 0) >= 1;
      }
      const processes = state.executions.filter((row) =>
        row.execution_call_id.endsWith(':process'),
      );
      return (
        processes.length === 1 && processes[0].execution_state === 'PREPARED'
      );
    }, 120_000);
    step('launch settled, capability live');
    assert(
      observer.frames.length >= 2,
      'the launch turn streamed events before the abort',
    );
    observer.controller.abort();
    await observer.task;
    if (observer.failure) throw observer.failure;
    const cursor = observer.frames.at(-1)!.id;
    step(`stream aborted at ${cursor}`);
    // Advance the capability while disconnected so the resume replays a
    // real backlog — a resume opened against an empty backlog passes
    // vacuously on a history-dropping endpoint.
    await releaseFifo(current.directory, monitor ? 'monitor-gate' : 'run-gate');
    step('gate released');
    if (!monitor) {
      // A background shell's exit notification input is silent on the
      // stream until a turn consumes it — this topology runs no scheduler,
      // so the backlog is a second, ordinary prompt after the run provably
      // settled. A monitor observation instead wakes a real turn
      // (monitorWakeKick is wired), so its stream carries the mid-gap
      // traffic itself.
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        const child = state.childRuns[0] as
          | { run?: { state?: string }; stopReason?: string | null }
          | undefined;
        return child?.run?.state === 'settled';
      }, 120_000);
      await submitPrompt(cli, clientId, `fg8 ${current.name} post-gap`);
    }
    // JDBC proof of a committed event beyond cursor, then reconnect.
    await waitUntil(async () => {
      checkProxy();
      const ledger = await probe<Array<Record<string, unknown>>>(
        current.sessionId,
        'ledger',
      );
      return ledger.length > cursor;
    }, 120_000);
    step(`backlog committed beyond ${cursor}`);
    resumed = new Observer(surface, current.sessionId);
    await resumed.start(cursor);
    step('stream resumed');
    await resumed.terminalOfOtherTurn(promptId);
    await waitUntil(async () => {
      checkProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      if (monitor) {
        const watch = state.monitors[0] as
          | { stopReason?: string | null }
          | undefined;
        return watch?.stopReason != null;
      }
      const child = state.childRuns[0] as
        | { run?: { state?: string } }
        | undefined;
      return child?.run?.state === 'settled';
    }, 120_000);
    await probe(current.sessionId, 'relay-stop');
    const ledger = await probe<Array<Record<string, unknown>>>(
      current.sessionId,
      'ledger',
    );
    // The fixture's 60 s events poll bounds the resumed observer's
    // catch-up: rows committed between its replay read and the relay stop
    // arrive a poll cycle late, so the window must outlive two cycles.
    await waitUntil(() => {
      if (resumed!.failure) throw resumed!.failure;
      return resumed!.frames.some((frame) => frame.id === ledger.length);
    }, 120_000);
    await resumed!.close();
    const frames = [...observer.frames, ...resumed!.frames];
    const ids = frames.map((frame) => frame.id);
    assert.deepEqual(
      ids,
      ids.map((_, index) => index + 1),
      'the resumed stream has no gaps and no duplicates',
    );
    assert.deepEqual(
      frames.map((frame) => frame.data),
      projection(ledger, surface),
      `${surface} frames are the exact SQL projection`,
    );
    return {
      case: current.name,
      surface,
      promptId,
      frames: ids,
      operations: [...operations],
      modelCalls,
    };
  } catch (cause) {
    const lastMessages = (
      model.requests.at(-1)?.body as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages?.slice(-2);
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')}\n` +
        // Both halves of the stream — the resumed observer's frames are
        // what a continuity failure actually needs.
        `frames=${JSON.stringify([...observer.frames, ...(resumed?.frames ?? [])].map((frame) => [frame.id, frame.event, frame.data]))}\n` +
        `lastModelMessages=${JSON.stringify(lastMessages)?.slice(-1500)}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

const fullSegments = (state: ProbeState) =>
  state.resources.filter(
    (row) =>
      row.kind === 'managed-tool-result-content' &&
      Number(row.byte_length) === SEGMENT_BYTES,
  );

const childRunOf = (state: ProbeState) =>
  state.childRuns[0] as
    | {
        run?: { state?: string };
        stopReason?: string | null;
        outputRef?: { resourceId?: string } | null;
      }
    | undefined;

function progressLines(): number {
  try {
    const text = readFileSync(
      path.join(current.directory, 'progress.txt'),
      'utf8',
    );
    return text.trim() === '' ? 0 : text.trimEnd().split('\n').length;
  } catch {
    return 0;
  }
}

// FG8f: kill the Harness (the background lane's publisher lives there)
// while the paced producer keeps appending. Mid-capture is a state, not a
// sleep: three full segments committed and more in flight.
async function killMidCapture(cli: HostedHarnessProcess) {
  await waitUntil(async () => {
    checkStoreProxy();
    const state = await probe<ProbeState>(current.sessionId, 'state');
    return fullSegments(state).length >= 3;
  }, 60_000);
  step('killing the harness mid-capture');
  cli.child!.kill('SIGKILL');
  await waitUntil(
    () => cli.child!.exitCode !== null || cli.child!.signalCode !== null,
    10_000,
  );
  const state = await probe<ProbeState>(current.sessionId, 'state');
  return {
    case: current.name,
    committedSegments: fullSegments(state).length,
    recordState: childRunOf(state)?.run?.state ?? null,
  };
}

// The stall detector shared by the two watermark cases: the proxy holds
// segment commits, and the pause watermark must reach the producer — the
// pipe-accepted block count freezes. Detection stays far inside the
// publisher rpc's 30 s budget.
async function awaitProducerStall(): Promise<number> {
  let last = -1;
  let still = 0;
  await waitUntil(() => {
    checkStoreProxy();
    const count = progressLines();
    if (heldSegments >= 1 && count >= 15 && count === last) still++;
    else still = 0;
    last = count;
    return still >= 10;
  }, 30_000);
  return last;
}

async function inFlightCap() {
  holdSegments = true;
  const stallBlocks = await awaitProducerStall();
  step(
    `stalled at ${stallBlocks} blocks with ${heldSegments} segment commits held`,
  );
  releaseHeldSegments();
  // The resume watermark re-arms: the producer advances again while the
  // drain is still short of the full output.
  let committedAtResume = -1;
  await waitUntil(async () => {
    checkStoreProxy();
    if (progressLines() <= stallBlocks) return false;
    const state = await probe<ProbeState>(current.sessionId, 'state');
    committedAtResume = fullSegments(state).length;
    return true;
  }, 30_000);
  await releaseFifo(current.directory, 'run-gate');
  await waitUntil(async () => {
    checkProxy();
    checkStoreProxy();
    const state = await probe<ProbeState>(current.sessionId, 'state');
    return childRunOf(state)?.run?.state === 'settled';
  }, 120_000);
  const state = await probe<ProbeState>(current.sessionId, 'state');
  return {
    case: current.name,
    stallBlocks,
    committedAtResume,
    committedSegments: fullSegments(state).length,
  };
}

async function receiptDrop(cli: HostedHarnessProcess, clientId: string) {
  // Cross the watermarks first: the drop lands after a real pause/resume.
  holdSegments = true;
  await awaitProducerStall();
  releaseHeldSegments();
  await waitUntil(() => {
    checkStoreProxy();
    return progressLines() >= 24;
  }, 60_000);
  // The producer parks on its gate, so the session is quiet: the next
  // journal commit after the arm is the settle cascade's manifest-commit.
  dropNextCommit = true;
  await releaseFifo(current.directory, 'run-gate');
  await waitUntil(async () => {
    checkProxy();
    checkStoreProxy();
    const state = await probe<ProbeState>(current.sessionId, 'state');
    return childRunOf(state)?.run?.state === 'settled';
  }, 120_000);
  assert.equal(droppedCommits, 1, 'the drop arm fired exactly once');
  // The re-drive's real proof is that the Session's writer still commits:
  // a post-drop turn must run to its settleTurn commit. A re-drive minting
  // a fresh identity would wedge the writer against the landed original —
  // every later commit would conflict and this turn would never settle.
  const dropIndex = commitLog.findIndex((entry) => entry.status === 'dropped');
  assert(dropIndex >= 0);
  await submitPrompt(cli, clientId, `fg8 ${current.name} post-drop`);
  await waitUntil(() => {
    checkProxy();
    checkStoreProxy();
    return commitLog
      .slice(dropIndex + 1)
      .some((entry) => entry.op === 'settleTurn' && entry.status === 200);
  }, 120_000);
  const state = await probe<ProbeState>(current.sessionId, 'state');
  return {
    case: current.name,
    droppedCommits,
    // Report the observation, not the conclusion: the IT re-reads which
    // commit the drop actually hit off this log, so a positional misdrop
    // goes red instead of passing on a count alone.
    droppedOp: commitLog[dropIndex].op,
    committedSegments: fullSegments(state).length,
    postDropSettled: commitLog
      .slice(dropIndex + 1)
      .some((entry) => entry.op === 'settleTurn' && entry.status === 200),
  };
}

// FG8f: one output-delivery case — a background run whose capture publishes
// through the store-fronting proxy, the case fault, then probe ground
// truth. No stream observers: this letter pins the output chain, FG8e
// pinned the streams.
async function runPublishCase() {
  const cli = new HostedHarnessProcess();
  step('harness boot');
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  try {
    if (current.name !== 'publisher-kill-mid-capture') {
      execFileSync('mkfifo', [path.join(current.directory, 'run-gate')]);
    }
    const { clientId } = await createSession(cli, storeProxyUrl);
    await submitPrompt(cli, clientId, `fg8 ${current.name} launch`);
    step('prompt admitted');
    // The run is genuinely in flight: its supervised process exists.
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return state.executions.some(
        (row) =>
          row.execution_call_id.endsWith(':process') &&
          row.execution_state === 'PREPARED',
      );
    }, 120_000);
    if (current.name === 'publisher-kill-mid-capture') {
      return await killMidCapture(cli);
    }
    if (current.name === 'in-flight-cap') {
      return await inFlightCap();
    }
    return await receiptDrop(cli, clientId);
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')} heldSegments=${heldSegments} droppedCommits=${droppedCommits}\n` +
        `progress=${progressLines()}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

try {
  const reports = [];
  for (current of config.cases) {
    caseStart = Date.now();
    modelCalls = 0;
    operations.length = 0;
    holdSegments = false;
    heldSegments = 0;
    dropNextCommit = false;
    droppedCommits = 0;
    if (config.letter === 'fg8f') {
      reports.push(await runPublishCase());
    } else {
      const surface = current.name.startsWith('public') ? 'public' : 'web';
      reports.push(await runStreamCase(surface));
    }
    console.log(`FG8_CASE_OK ${current.name}`);
  }
  checkProxy();
  checkStoreProxy();
  await writeFile(config.resultFile, JSON.stringify(reports));
  console.log(
    config.letter === 'fg8f' ? 'FG8_OUTPUT_DELIVERY_OK' : 'FG8_STREAM_GAPS_OK',
  );
} catch (cause) {
  console.error('FG8 failed at', current?.name, cause);
  throw cause;
} finally {
  await model.close();
  brokerProxy.closeAllConnections();
  storeProxy.closeAllConnections();
  await new Promise<void>((resolve) => brokerProxy.close(() => resolve()));
  await new Promise<void>((resolve) => storeProxy.close(() => resolve()));
}
