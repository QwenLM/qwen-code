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
  // A resync_required frame carries no sequence id and is not part of the
  // replayed stream — cursor-expired-resync asserts it exists exactly
  // once and that nothing else replays behind it.
  resyncFrame?: Record<string, unknown>;

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
            if (frame.event === 'agent.session.resync_required') {
              this.resyncFrame = frame.data;
              continue;
            }
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
  runtimeSessions: Array<{ runtime_session_id: string }>;
  monitorObservations: number;
  replayFloor: Record<string, unknown>;
};

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// The background producer: announce, hold on a FIFO the driver owns, then
// finish. The gate makes "mid-run" a deterministic state, never a sleep.
function backgroundProducer(): string {
  return [
    "const fs = require('fs');",
    "fs.appendFileSync('bg-started.txt', String(process.pid) + '\\n');",
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

function producerFor(
  name: string,
  phase = 1,
): { monitor: boolean; script: string } {
  if (name.includes('monitor') || name === 'observation-advance-reply') {
    return { monitor: true, script: monitorProducer() };
  }
  const gate = phase === 2 ? 'run-gate-2' : 'run-gate';
  switch (name) {
    case 'publisher-kill-mid-capture':
      return { monitor: false, script: pacedProducer() };
    case 'in-flight-cap':
    case 'receipt-drop-after-watermark':
    case 'capture-commit-reply':
    case 'manifest-commit':
    case 'page-envelope-commit':
    case 'cancel-during-capture':
    case 'cancel-status-unavailable':
    case 'cancel-reply-lost':
    case 'routine-release-refusal':
    case 'drain-release':
      return { monitor: false, script: patternProducer(24, gate) };
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

// Slice-2 broker arms. A reply-drop forwards and consumes the committed
// upstream answer, then destroys the reply socket — the request DID land
// server-side; a request-hold parks the request pre-forward until the case
// releases it; an answer-once fabricates one upstream refusal. Every arm
// fires exactly once and reports itself through the results file, so a
// gate can never pass against a fault that never fired.
type BrokerArm =
  | {
      kind: 'drop';
      match: (
        op: string,
        parsed: Record<string, unknown> | undefined,
      ) => boolean;
      label: string;
    }
  | {
      kind: 'hold';
      match: (
        op: string,
        parsed: Record<string, unknown> | undefined,
      ) => boolean;
      label: string;
    }
  | {
      kind: 'answer';
      match: (
        op: string,
        parsed: Record<string, unknown> | undefined,
      ) => boolean;
      label: string;
      status: number;
      body: Record<string, unknown>;
    };
const brokerArms: BrokerArm[] = [];
const brokerHolds: Array<() => void> = [];
const brokerDrops: string[] = [];
const brokerAnswers: string[] = [];
const brokerFives: Array<{ op: string; status: number; body: string }> = [];
// Every control call's wire kind, in order — "exactly one stop reaches
// the worker" is a count over this log.
const brokerControlKinds: string[] = [];

function brokerOperation(req: { method?: string }, url: URL): string {
  const path = url.pathname;
  if (req.method === 'GET') return 'status';
  for (const suffix of [
    ':prepare',
    ':start',
    ':cancel',
    ':release',
    ':acknowledge',
    ':acquire',
    ':publisher',
  ]) {
    if (path.endsWith(suffix)) return suffix.slice(1);
  }
  if (path.endsWith('/control')) return 'control';
  return path.split('/').at(-1)!;
}

function releaseBrokerHolds() {
  const held = brokerHolds.splice(0);
  console.log(`FG8_PROXY release ${held.length} held requests`);
  for (const resolve of held) resolve();
}

const brokerProxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, config.brokerUrl);
    const operation = brokerOperation(req, url);
    operations.push(operation);
    console.log(`FG8_PROXY ${req.method} ${operation} begin`);
    let parsed: Record<string, unknown> | undefined;
    if (req.method === 'POST' && body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
    }
    if (operation === 'control') {
      brokerControlKinds.push(
        String(
          (parsed?.['operation'] as { kind?: string } | undefined)?.kind ??
            'unknown',
        ),
      );
    }
    const armIndex = brokerArms.findIndex((arm) => {
      try {
        return arm.match(operation, parsed);
      } catch {
        return false;
      }
    });
    const arm = armIndex >= 0 ? brokerArms.splice(armIndex, 1)[0] : undefined;
    if (arm !== undefined && arm.kind === 'answer') {
      brokerAnswers.push(arm.label);
      console.log(
        `FG8_PROXY answered ${arm.status} for ${operation} (${arm.label})`,
      );
      res.writeHead(arm.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(arm.body));
      return;
    }
    if (arm !== undefined && arm.kind === 'hold') {
      console.log(`FG8_PROXY hold ${operation} (${arm.label})`);
      await new Promise<void>((resolve) => brokerHolds.push(resolve));
    }
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
    if (upstream.status >= 500) {
      brokerFives.push({
        op: operation,
        status: upstream.status,
        body: bytes.toString('utf8').slice(0, 1000),
      });
    }
    if (arm !== undefined && arm.kind === 'drop') {
      brokerDrops.push(arm.label);
      console.log(`FG8_DROPPED ${operation} (${arm.label})`);
      req.socket.destroy();
      return;
    }
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
// Slice-2 store arms: reply drops keyed by request shape, fired once each
// and reported back through the results file, plus a 5xx capture log so a
// store-failure case can point at the exact failed commit.
const storeDropArms: Array<{
  match: (parsed: Record<string, unknown>, path: string) => boolean;
  label: string;
}> = [];
const storeDrops: string[] = [];
const storeFives: Array<{ op: string; status: number; body: string }> = [];
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
    const storeArmIndex = storeDropArms.findIndex((arm) => {
      try {
        return parsed !== undefined && arm.match(parsed, url.pathname);
      } catch {
        return false;
      }
    });
    if (storeArmIndex >= 0) {
      const arm = storeDropArms.splice(storeArmIndex, 1)[0];
      storeDrops.push(arm.label);
      console.log(`FG8_DROPPED store ${arm.label}`);
      req.socket.destroy();
      return;
    }
    if (upstream.status >= 500) {
      storeFives.push({
        op: String(parsed?.['kind'] ?? parsed?.['operation'] ?? url.pathname),
        status: upstream.status,
        body: bytes.toString('utf8').slice(0, 1000),
      });
    }
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

// Per-case monitor quota: a stop-armed case keeps the watch alive until
// the driver drives the stop, so the quota is never the thing under gate.
function monitorMaxEvents(name: string): number {
  if (name === 'monitor-stop-reply') return 99;
  return 2;
}

let current = config.cases[0];
let modelCalls = 0;
const model = await startFakeOpenAIServer(() => {
  modelCalls++;
  // FG8b drives two phases per case — the faulted pass, then the clean
  // re-drive — each with its own first call that must issue the tool call.
  const phase = modelCalls > 2 ? 2 : 1;
  const producer = producerFor(current.name, phase);
  if (modelCalls === 1 || (config.letter === 'fg8b' && modelCalls === 3)) {
    return {
      toolCalls: [
        producer.monitor
          ? fakeToolCall(
              'monitor',
              {
                command: `${quote(process.execPath)} -e ${quote(producer.script)}`,
                max_events: monitorMaxEvents(current.name),
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
          ? Math.floor(Number(row['created_at']) / 1000)
          : row['created_at'],
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

// === Slice-2 drivers (FG8a/b/d and the FG8e cursor-expired case) ===

// The driver issues broker verbs against its own proxy — same surface the
// CLI rides, with the token the proxy injects for it.
async function brokerDriver(
  verb: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    new URL(`/internal/runtime-broker/v1${verb}`, proxyUrl),
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

// Cancel admission through the public surface (202 on acceptance).
async function publicCancelTurn(sessionId: string, turnId: string) {
  const response = await fetch(
    new URL(`/v1/agents/sessions/${sessionId}/events`, config.storeUrl),
    {
      method: 'POST',
      headers: {
        'X-Qwen-Tenant-Id': config.tenantId,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        type: 'agent.session.cancel',
        turn_id: turnId,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 202, text);
  return JSON.parse(text) as Record<string, unknown>;
}

function runtimeSessionIdOf(state: ProbeState): string {
  const row = state.runtimeSessions[0];
  assert(row, 'no runtime session row yet');
  return row.runtime_session_id;
}

function processRowOf(state: ProbeState) {
  return state.executions.find((row) =>
    row.execution_call_id.endsWith(':process'),
  );
}

function invocationOf(state: ProbeState) {
  return state.executions.find(
    (row) => !row.execution_call_id.endsWith(':process'),
  );
}

function monitorOf(state: ProbeState) {
  return state.monitors[0] as
    | {
        observationSequence?: number;
        notifiedThrough?: number;
        stopReason?: string | null;
      }
    | undefined;
}

// One line per physical process start — second-admit failures can never
// hide behind an overwritten marker (the slice-1 lesson, applied forward).
function startedPids(): string[] {
  try {
    const text = readFileSync(
      path.join(current.directory, 'bg-started.txt'),
      'utf8',
    );
    return text.trim() === '' ? [] : text.trimEnd().split('\n');
  } catch {
    return [];
  }
}

// A driver-driven control call against a live background run, the same
// verb the drain arm reaches for (`shell-terminate` on the hold row).
async function shellTerminate(runtimeSessionId: string) {
  const state = await probe<ProbeState>(current.sessionId, 'state');
  const inv = invocationOf(state);
  const proc = processRowOf(state);
  assert(inv, 'an invocation row is required');
  assert(proc, 'a :process row is required');
  return brokerDriver(
    `/tool-sessions/${encodeURIComponent(runtimeSessionId)}/control`,
    {
      protocolVersion: 1,
      requestId: randomUUID(),
      harnessSessionId: current.sessionId,
      runtimeSessionId,
      operation: {
        kind: 'shell-terminate',
        sessionKey: {
          tenantId: config.tenantId,
          workspaceId: current.workspaceId,
          sessionId: current.sessionId,
        },
        operationId: inv.execution_call_id,
        targetOperationId: proc.execution_call_id,
      },
    },
  );
}

async function bootSlice2Harness(withMonitorFifo: boolean, withGate2 = false) {
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
  execFileSync('mkfifo', [
    path.join(current.directory, withMonitorFifo ? 'monitor-gate' : 'run-gate'),
  ]);
  if (withGate2) {
    execFileSync('mkfifo', [path.join(current.directory, 'run-gate-2')]);
  }
  return cli;
}

// FG8a — one background capability per case, exactly one committed reply
// destroyed, and every re-drive resolves by the original identity.
async function runReplyCase() {
  const monitor =
    current.name.includes('monitor') ||
    current.name === 'observation-advance-reply';
  const cli = await bootSlice2Harness(monitor);
  try {
    if (current.name === 'dispatch-reply') {
      brokerArms.push({
        kind: 'drop',
        match: (op) => op === 'start',
        label: 'dispatch',
      });
    }
    if (current.name === 'capture-commit-reply') {
      storeDropArms.push({
        label: 'publish-page',
        match: (parsed, path) =>
          path.endsWith('/tool-results:publish') &&
          parsed['kind'] === 'managed-tool-result-page',
      });
    }
    const sessionStore =
      current.name === 'capture-commit-reply' ||
      current.name === 'observation-advance-reply'
        ? storeProxyUrl
        : config.storeUrl;
    const { clientId } = await createSession(cli, sessionStore);
    const promptId = await submitPrompt(
      cli,
      clientId,
      `fg8 ${current.name} launch`,
    );
    step('prompt admitted');
    if (current.name === 'dispatch-reply') {
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        return processRowOf(state) !== undefined && brokerDrops.length === 1;
      }, 120_000);
      step('dropped the dispatch reply after commit');
      await releaseFifo(current.directory, 'run-gate');
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        const child = childRunOf(state);
        return child?.run?.state === 'settled';
      }, 120_000);
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        drops: [...brokerDrops],
        startOps: operations.filter((op) => op === 'start').length,
        pids: startedPids(),
        runState: childRunOf(state)?.run?.state ?? null,
        stopReason: childRunOf(state)?.stopReason ?? null,
      };
    }
    if (current.name === 'monitor-stop-reply') {
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        return (monitorOf(state)?.observationSequence ?? 0) >= 1;
      }, 120_000);
      step('watch live');
      brokerArms.push({
        kind: 'drop',
        match: (op, parsed) =>
          op === 'control' &&
          (parsed?.['operation'] as { kind?: string } | undefined)?.kind ===
            'monitor-stop',
        label: 'monitor-stop',
      });
      await publicCancelTurn(current.sessionId, promptId);
      step('cancelled the turn');
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        const monitor = monitorOf(state);
        return (
          monitor?.stopReason != null &&
          ['stop_requested', 'exited'].includes(String(monitor.stopReason))
        );
      }, 180_000);
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        drops: [...brokerDrops],
        monitorStopOps: brokerControlKinds.filter(
          (kind) => kind === 'monitor-stop',
        ).length,
        stopReason: monitorOf(state)?.stopReason ?? null,
        observationSequence: monitorOf(state)?.observationSequence ?? 0,
        notifiedThrough: monitorOf(state)?.notifiedThrough ?? 0,
      };
    }
    if (current.name === 'capture-commit-reply') {
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        return progressLines() >= 24 && storeDrops.length === 1;
      }, 180_000);
      step('dropped one page publish reply');
      await releaseFifo(current.directory, 'run-gate');
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        return childRunOf(state)?.run?.state === 'settled';
      }, 180_000);
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        storeDrops: [...storeDrops],
        runState: childRunOf(state)?.run?.state ?? null,
        stopReason: childRunOf(state)?.stopReason ?? null,
        committedSegments: fullSegments(state).length,
      };
    }
    if (current.name === 'observation-advance-reply') {
      await waitUntil(async () => {
        checkProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        return (monitorOf(state)?.observationSequence ?? 0) >= 1;
      }, 120_000);
      step('watch live');
      storeDropArms.push({
        label: 'commit-monitor-run',
        match: (parsed) => parsed['operation'] === 'commitMonitorRun',
      });
      // The producer only holds mid-window; the second advance carries the
      // drop and its re-drive, then the quota stop settles the watch.
      await releaseFifo(current.directory, 'monitor-gate');
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        const state = await probe<ProbeState>(current.sessionId, 'state');
        const monitor = monitorOf(state);
        return storeDrops.length === 1 && monitor?.stopReason != null;
      }, 180_000);
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const commits = commitLog.filter(
        (entry) => entry.op === 'commitMonitorRun' && entry.status === 200,
      );
      return {
        case: current.name,
        storeDrops: [...storeDrops],
        commitMonitorRunLanded: commits.length,
        stopReason: monitorOf(state)?.stopReason ?? null,
        observationSequence: monitorOf(state)?.observationSequence ?? 0,
        notifiedThrough: monitorOf(state)?.notifiedThrough ?? 0,
        observationResources: state.monitorObservations,
      };
    }
    throw new Error(`unknown fg8a case ${current.name}`);
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')}\n` +
        `brokerDrops=${brokerDrops.join(',')} storeDrops=${storeDrops.join(',')} controlKinds=${brokerControlKinds.join(',')}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

// FG8e cursor-expired-resync: an honestly expired resume cursor must read
// exactly one resync_required frame and no fabricated replay.
async function runCursorCase() {
  const observer = new Observer('public', current.sessionId);
  const cli = await bootSlice2Harness(false);
  try {
    const { clientId, created } = await createSession(cli, config.storeUrl);
    await probe(current.sessionId, 'relay-start', {
      created,
      baseUrl: cli.baseUrl,
      bootId: cli.bootId,
    });
    await observer.start();
    const promptId = await submitPrompt(
      cli,
      clientId,
      `fg8 ${current.name} launch`,
    );
    step('prompt admitted');
    await waitUntil(async () => {
      checkProxy();
      if (observer.failure) throw observer.failure;
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const launchSettled = observer.frames.some(
        (frame) =>
          frame.data['terminal'] === true &&
          observer.turnIdOf(frame) === promptId,
      );
      return launchSettled && processRowOf(state) !== undefined;
    }, 120_000);
    step('launch settled, run live');
    observer.controller.abort();
    await observer.task;
    if (observer.failure) throw observer.failure;
    const cursor = observer.frames.at(-1)!.id;
    step(`stream aborted at ${cursor}`);
    await releaseFifo(current.directory, 'run-gate');
    await waitUntil(async () => {
      checkProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const child = childRunOf(state);
      return child?.run?.state === 'settled';
    }, 120_000);
    await submitPrompt(cli, clientId, `fg8 ${current.name} post-gap`);
    await waitUntil(async () => {
      checkProxy();
      const ledger = await probe<Array<Record<string, unknown>>>(
        current.sessionId,
        'ledger',
      );
      return ledger.length > cursor + 1;
    }, 120_000);
    step('backlog committed past the cursor');
    const floor = await probe<{
      replay_floor_sequence: number;
      last_sequence: number;
      covered_sequence: number;
    }>(current.sessionId, 'advance-floor', { floor: cursor + 1 });
    assert.equal(
      Number(floor.replay_floor_sequence),
      cursor + 1,
      'the replay floor must advance past the resume cursor',
    );
    step(`replay floor advanced to ${cursor + 1}`);
    // Exactly one resync frame, no fabricated replay behind it.
    const resumed = new Observer('public', current.sessionId);
    await resumed.start(cursor);
    await waitUntil(() => {
      if (resumed.failure) throw resumed.failure;
      return resumed.resyncFrame !== undefined;
    }, 120_000);
    const frame = resumed.resyncFrame!;
    assert.equal(Number(frame.floorSequence), cursor + 1);
    await resumed.close();
    const ledger = await probe<Array<Record<string, unknown>>>(
      current.sessionId,
      'ledger',
    );
    await probe(current.sessionId, 'relay-stop');
    const replayCount = resumed.frames.length;
    assert.equal(
      replayCount,
      0,
      'an expired cursor gets no fabricated replay frames',
    );
    return {
      case: current.name,
      cursor,
      floorSequence: Number(frame.floorSequence),
      action: frame.action,
      replayFrames: replayCount,
      ledgerLength: ledger.length,
      promptId,
    };
  } catch (cause) {
    await diagnose(cli, `cursor case failed: ${String(cause)}`);
    throw cause;
  } finally {
    observer.controller.abort();
    await cli.close();
  }
}

// FG8b — one-shot store failure per case: the blocked half with the
// trigger armed, then the honest landing after it is dropped.
async function runStoreCase() {
  const target = current.name.replace('-commit', '');
  const producersGateTwice =
    current.name === 'manifest-commit' ||
    current.name === 'page-envelope-commit';
  const cli = await bootSlice2Harness(false, producersGateTwice);
  let triggerName = '';
  try {
    const { clientId } = await createSession(cli, storeProxyUrl);
    const installed = await probe<{ name: string; marker: string }>(
      current.sessionId,
      'trigger-install',
      { target },
    );
    triggerName = installed.name;
    step(`trigger ${triggerName} armed for ${target}`);
    assert.equal(
      await probe<number>(current.sessionId, 'trigger-present', {
        name: triggerName,
      }),
      1,
      'trigger present before the fault window',
    );
    await submitPrompt(cli, clientId, `fg8 ${current.name} fault`);
    step('fault pass submitted');
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      return (
        brokerFives.some((entry) => entry.body.includes(installed.marker)) ||
        storeFives.some((entry) => entry.body.includes(installed.marker))
      );
    }, 120_000);
    step(`fault fired with marker ${installed.marker}`);
    const blocked = await probe<ProbeState>(current.sessionId, 'state');
    await probe(current.sessionId, 'trigger-drop', { name: triggerName });
    assert.equal(
      await probe<number>(current.sessionId, 'trigger-present', {
        name: triggerName,
      }),
      0,
      'trigger dropped after the fault window',
    );
    // The fault pass's producer may hold its gate; release it so that pass
    // unwinds and the clean re-drive gets a fresh turn.
    if (producersGateTwice) {
      await releaseFifo(current.directory, 'run-gate');
      step('fault pass unwound');
    }
    await submitPrompt(cli, clientId, `fg8 ${current.name} replay`);
    step('clean pass submitted');
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return state.executions.some((row) =>
        row.execution_call_id.endsWith(':process'),
      );
    }, 180_000);
    step('clean pass dispatched');
    if (producersGateTwice) {
      await releaseFifo(current.directory, 'run-gate-2');
    } else {
      await releaseFifo(current.directory, 'run-gate');
    }
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const children = state.childRuns as Array<{
        run?: { state?: string };
        stopReason?: string | null;
      }>;
      return children.some(
        (child) =>
          child?.run?.state === 'settled' && child.stopReason === 'exited',
      );
    }, 180_000);
    step('clean pass settled with real exit evidence');
    const settled = await probe<ProbeState>(current.sessionId, 'state');
    const landed = (
      settled.childRuns as Array<{
        run?: { state?: string };
        stopReason?: string | null;
      }>
    ).filter(
      (child) =>
        child?.run?.state === 'settled' && child.stopReason === 'exited',
    );
    return {
      case: current.name,
      marker: installed.marker,
      firedWithMarker: true,
      brokerMarkers: brokerFives
        .filter((entry) => entry.body.includes(installed.marker))
        .map((entry) => entry.op),
      storeMarkers: storeFives
        .filter((entry) => entry.body.includes(installed.marker))
        .map((entry) => entry.op),
      blocked: {
        executions: blocked.executions.map((row) => [
          row.execution_call_id,
          row.execution_state,
        ]),
        processRows: blocked.executions.filter((row) =>
          row.execution_call_id.endsWith(':process'),
        ).length,
        // The full rows, not just counts: the IT re-reads every one of
        // these after the clean pass and proves the prefix never drifted.
        resources: blocked.resources.map((row) => [
          row.resource_id,
          row.kind,
          row.sha256,
          row.byte_length,
        ]),
        resourceByKind: kindCounts(blocked),
        childRuns: (
          blocked.childRuns as Array<{
            run?: { state?: string };
          }>
        ).map((child) => child?.run?.state ?? null),
      },
      settled: {
        executions: settled.executions.map((row) => [
          row.execution_call_id,
          row.execution_state,
        ]),
        processRows: settled.executions.filter((row) =>
          row.execution_call_id.endsWith(':process'),
        ).length,
        resourceByKind: kindCounts(settled),
        landedRuns: landed.length,
        childRuns: (
          settled.childRuns as Array<{
            run?: { state?: string };
            stopReason?: string | null;
          }>
        ).map((child) => [
          child?.run?.state ?? null,
          child?.stopReason ?? null,
        ]),
      },
      modelCalls,
      pids: startedPids(),
    };
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} target=${target} brokerFives=${brokerFives
        .map((entry) => entry.op)
        .join(',')} storeFives=${storeFives
        .map((entry) => entry.op)
        .join(',')}`,
    );
    throw cause;
  } finally {
    try {
      if (triggerName !== '') {
        await probe(current.sessionId, 'trigger-drop', { name: triggerName });
      }
    } catch {
      // best-effort teardown
    }
    await cli.close();
  }
}

function kindCounts(state: ProbeState) {
  const counts: Record<string, number> = {};
  for (const row of state.resources) {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  }
  return counts;
}

// FG8d — cancellation arms against a live background run, then the
// routine/drain release split.
async function runCancelCase() {
  const cli = await bootSlice2Harness(false);
  try {
    const { clientId } = await createSession(cli, config.storeUrl);
    if (current.name === 'cancel-before-start') {
      brokerArms.push({
        kind: 'hold',
        match: (op) => op === 'start',
        label: 'dispatch-hold',
      });
    }
    await submitPrompt(cli, clientId, `fg8 ${current.name} launch`);
    step('prompt admitted');
    if (current.name === 'cancel-before-start') {
      // The cancel lands while the dispatch is held pre-start: nothing may
      // start, and the record settles from the ledger's never-started
      // proof (#14021).
      await waitUntil(() => brokerHolds.length === 1, 120_000);
      step('dispatch held');
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const inv = invocationOf(state);
      assert(inv, 'the admitted invocation exists');
      const runtimeSessionId = runtimeSessionIdOf(state);
      const cancel = await brokerDriver(
        `/executions/${encodeURIComponent(inv.execution_call_id)}:cancel`,
        {
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: current.sessionId,
          runtimeSessionId,
        },
      );
      assert(
        cancel.status === 200,
        `cancel refused: ${cancel.status} ${JSON.stringify(cancel.body)}`,
      );
      step('cancel committed mid-hold');
      releaseBrokerHolds();
      await waitUntil(async () => {
        checkProxy();
        const settledState = await probe<ProbeState>(
          current.sessionId,
          'state',
        );
        const row = invocationOf(settledState);
        return processRowOf(settledState) === undefined && row !== undefined;
      }, 180_000);
      const settleState = await probe<ProbeState>(current.sessionId, 'state');
      const children = settleState.childRuns as Array<{
        run?: { state?: string };
        stopReason?: string | null;
      }>;
      await waitUntil(() => {
        return children.some((child) => child?.run?.state === 'settled');
      }, 120_000);
      return {
        case: current.name,
        cancelStatus: cancel.status,
        processRows: settleState.executions.filter((row) =>
          row.execution_call_id.endsWith(':process'),
        ).length,
        pids: startedPids(),
        childStates: (
          (await probe<ProbeState>(current.sessionId, 'state'))
            .childRuns as Array<{
            run?: { state?: string };
            stopReason?: string | null;
          }>
        ).map((child) => [
          child?.run?.state ?? null,
          child?.stopReason ?? null,
        ]),
        startOps: operations.filter((op) => op === 'start').length,
      };
    }
    // The remaining cases need a live background run first.
    await waitUntil(async () => {
      checkProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return fullSegments(state).length >= 3;
    }, 180_000);
    step('run live mid-capture');
    const state = await probe<ProbeState>(current.sessionId, 'state');
    const runtimeSessionId = runtimeSessionIdOf(state);
    const inv = invocationOf(state);
    assert(inv, 'an invocation row is required');
    if (current.name === 'cancel-during-capture') {
      const stop = await shellTerminate(runtimeSessionId);
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      step('terminate issued mid-capture');
      await waitUntil(async () => {
        checkProxy();
        const settleState = await probe<ProbeState>(current.sessionId, 'state');
        const child = childRunOf(settleState);
        return child?.run?.state === 'settled';
      }, 180_000);
      const settleState = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        stopStatus: stop.status,
        stopReason: childRunOf(settleState)?.stopReason ?? null,
        stopRequested:
          (childRunOf(settleState) as { stopRequested?: boolean } | undefined)
            ?.stopRequested ?? null,
        runState: childRunOf(settleState)?.run?.state ?? null,
        committedSegments: fullSegments(settleState).length,
        pids: startedPids(),
      };
    }
    if (current.name === 'cancel-status-unavailable') {
      brokerArms.push({
        kind: 'answer',
        match: (op) => op === 'control',
        label: 'control-unavailable',
        status: 409,
        body: {
          protocolVersion: 1,
          harnessSessionId: current.sessionId,
          runtimeSessionId,
          code: 'runtime_broker_execution_unknown',
          error: 'status unavailable in this window',
        },
      });
      const refused = await shellTerminate(runtimeSessionId);
      assert.equal(
        refused.status,
        409,
        'the window must answer the stop as unproven',
      );
      step('stop answered unavailable');
      // No terminal event may be fabricated off the unproven answer: a
      // bound the live record must hold before the honest re-drive.
      const during = await probe<ProbeState>(current.sessionId, 'state');
      assert.notEqual(
        childRunOf(during)?.run?.state,
        'settled',
        'no fabricated settle during the unavailable window',
      );
      const stopped = await shellTerminate(runtimeSessionId);
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      step('stop re-driven');
      await waitUntil(async () => {
        checkProxy();
        const settleState = await probe<ProbeState>(current.sessionId, 'state');
        return childRunOf(settleState)?.run?.state === 'settled';
      }, 180_000);
      const settleState = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        refusedStatus: refused.status,
        stoppedStatus: stopped.status,
        answers: [...brokerAnswers],
        stopReason: childRunOf(settleState)?.stopReason ?? null,
        runState: childRunOf(settleState)?.run?.state ?? null,
        pids: startedPids(),
      };
    }
    if (current.name === 'cancel-reply-lost') {
      brokerArms.push({
        kind: 'drop',
        match: (op) => op === 'cancel',
        label: 'cancel-reply',
      });
      const first = await brokerDriver(
        `/executions/${encodeURIComponent(inv.execution_call_id)}:cancel`,
        {
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: current.sessionId,
          runtimeSessionId,
        },
      );
      assert(
        brokerDrops.includes('cancel-reply'),
        'the drop arm must have fired',
      );
      assert(
        first.status === 0,
        `a destroyed reply can never answer 200 (got ${first.status})`,
      );
      step('cancel reply dropped after commit');
      const second = await brokerDriver(
        `/executions/${encodeURIComponent(inv.execution_call_id)}:cancel`,
        {
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: current.sessionId,
          runtimeSessionId,
        },
      );
      assert.equal(second.status, 200, JSON.stringify(second.body));
      step('cancel re-driven');
      const settleState = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        drops: [...brokerDrops],
        cancelOps: operations.filter((op) => op === 'cancel').length,
        secondStatus: second.status,
        invocationState: invocationOf(settleState)?.execution_state ?? null,
        invocationStatus: invocationOf(settleState)?.execution_status ?? null,
      };
    }
    if (current.name === 'routine-release-refusal') {
      const progressBefore = progressLines();
      const refused = await brokerDriver(
        `/tool-sessions/${encodeURIComponent(runtimeSessionId)}:release`,
        {
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: current.sessionId,
          runtimeSessionId,
        },
      );
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(
        refused.body['code'],
        'runtime_session_held',
        'the routine arm must answer held',
      );
      step('routine release refused held');
      // Nothing is stopped while the arm refuses: the producer keeps
      // advancing its own progress log.
      await waitUntil(() => progressLines() > progressBefore, 30_000);
      const after = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        refusedStatus: refused.status,
        refusedCode: refused.body['code'],
        processAlive: processRowOf(after) !== undefined,
        progressBefore,
        progressAfter: progressLines(),
        runState: childRunOf(after)?.run?.state ?? null,
        pids: startedPids(),
      };
    }
    if (current.name === 'drain-release') {
      const released = await brokerDriver(
        `/tool-sessions/${encodeURIComponent(runtimeSessionId)}:release`,
        {
          protocolVersion: 1,
          requestId: randomUUID(),
          harnessSessionId: current.sessionId,
          runtimeSessionId,
          drain: true,
        },
      );
      assert.equal(released.status, 200, JSON.stringify(released.body));
      step('drain release accepted');
      await waitUntil(async () => {
        checkProxy();
        const settleState = await probe<ProbeState>(current.sessionId, 'state');
        return childRunOf(settleState)?.run?.state === 'settled';
      }, 180_000);
      const settleState = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: current.name,
        releasedStatus: released.status,
        releasedFlag: released.body['released'] ?? null,
        stopReason: childRunOf(settleState)?.stopReason ?? null,
        stopRequested:
          (childRunOf(settleState) as { stopRequested?: boolean } | undefined)
            ?.stopRequested ?? null,
        runState: childRunOf(settleState)?.run?.state ?? null,
        stopOps: brokerControlKinds.filter((kind) => kind === 'shell-terminate')
          .length,
        committedSegments: fullSegments(settleState).length,
        pids: startedPids(),
      };
    }
    throw new Error(`unknown fg8d case ${current.name}`);
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')}\n` +
        `brokerDrops=${brokerDrops.join(',')} answers=${brokerAnswers.join(',')} controlKinds=${brokerControlKinds.join(',')}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

const LETTER_OK: Record<string, string> = {
  fg8a: 'FG8_ORIGINAL_IDENTITY_OK',
  fg8b: 'FG8_STORE_FAILURES_OK',
  fg8d: 'FG8_CANCELLATION_DRAIN_OK',
  fg8e: 'FG8_STREAM_GAPS_OK',
  fg8f: 'FG8_OUTPUT_DELIVERY_OK',
};

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
    brokerArms.length = 0;
    brokerDrops.length = 0;
    brokerAnswers.length = 0;
    brokerFives.length = 0;
    brokerControlKinds.length = 0;
    brokerHolds.length = 0;
    storeDropArms.length = 0;
    storeDrops.length = 0;
    storeFives.length = 0;
    commitLog.length = 0;
    if (config.letter === 'fg8a') {
      reports.push(await runReplyCase());
    } else if (config.letter === 'fg8b') {
      reports.push(await runStoreCase());
    } else if (config.letter === 'fg8d') {
      reports.push(await runCancelCase());
    } else if (config.letter === 'fg8f') {
      reports.push(await runPublishCase());
    } else if (current.name === 'cursor-expired-resync') {
      reports.push(await runCursorCase());
    } else {
      const surface = current.name.startsWith('public') ? 'public' : 'web';
      reports.push(await runStreamCase(surface));
    }
    console.log(`FG8_CASE_OK ${current.name}`);
  }
  checkProxy();
  checkStoreProxy();
  await writeFile(config.resultFile, JSON.stringify(reports));
  console.log(LETTER_OK[config.letter]);
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
