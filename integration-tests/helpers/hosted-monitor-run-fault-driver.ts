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
import { SseObserver, projectEvents } from './hosted-sse-observer.js';
import { quotePosix } from './hosted-shell-quote.js';

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
// budget is what admits is_background and monitor at all. FG8c's reload
// sends the same body to /load under the new Harness's writer identity.
function sessionBody(
  cli: HostedHarnessProcess,
  storeBaseUrl: string,
  leaseDurationMs: number,
) {
  return {
    sessionScope: 'thread',
    toolProfile: 'hosted-workspace-shell/1',
    captureBytes: 64 * 1024 * 1024,
    managedSessionStore: {
      baseUrl: storeBaseUrl,
      tenantId: config.tenantId,
      workspaceId: current.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs,
    },
  };
}

async function createSession(
  cli: HostedHarnessProcess,
  storeBaseUrl: string,
  leaseDurationMs = 60_000,
): Promise<{ clientId: string; created: Record<string, unknown> }> {
  const created = await cli.request('/session', {
    method: 'POST',
    headers: { ...cli.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: current.sessionId,
      ...sessionBody(cli, storeBaseUrl, leaseDurationMs),
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

// FG8c's monitor producer: announce its pid, emit one observation, then
// hold on a FIFO the driver never opens — the watch is live and silent, so
// only its idle window can end it.
function crashMonitorProducer(): string {
  return [
    "const fs = require('fs');",
    "fs.writeFileSync('bg-started.txt', String(process.pid));",
    "process.stdout.write('FG8_MON_0\\n');",
    "fs.readFileSync('monitor-gate');",
  ].join('\n');
}

function producerFor(name: string): { monitor: boolean; script: string } {
  if (name === 'monitor-worker-kill') {
    return { monitor: true, script: crashMonitorProducer() };
  }
  if (name.includes('monitor') || name.startsWith('observation')) {
    return { monitor: true, script: monitorProducer() };
  }
  switch (name) {
    case 'publisher-kill-mid-capture':
    case 'harness-kill-capture':
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
// op:status log mirrors `operations` for failure evidence — a store/
// dispatch rejection is only visible to the gate through its HTTP status
// (e.g. an FG8b trigger's SQLSTATE surfacing as a 500 on prepare/:start).
const operationsLog: Array<{ op: string; status: number }> = [];
// FG8a's lose-once arms (a dropped reply destroies the client socket AFTER
// the committed upstream response was consumed — the same shape a real
// network loss has to the Harness) and the hold arms FG8d needs to park a
// matched request before it is forwarded. Matching on the control channel
// is by POST body, because every control call shares one path.
const brokerIdentity: {
  harnessSessionId?: string;
  runtimeSessionId?: string;
} = {};
const brokerControlKinds: Array<string> = [];
let proxyFailure: unknown;
let dropNextStart = false;
let dropNextMonitorStop = false;
let brokerDropped = 0;
let brokerStartedForwards = 0;
let brokerMonitorStopForwards = 0;
let brokerStartAttempts = 0;
let brokerStartFailures = 0;
let holdNextStart = false;
let heldStartArrived = false;
let pausedBrokerControls = false;
const heldStartReplies: Array<(destroy: boolean) => void> = [];
const heldControlReplies: Array<() => void> = [];
// What the paused arm actually parked, by method and path: the hold
// witness names the request it holds instead of trusting a count.
const heldControlLog: string[] = [];
// FG8c: every broker answer (op, status, declared code; a release's
// Runtime Session and arm), and the after-commit :start hold.
const brokerAnswers: Array<{
  op: string;
  status: number;
  code: string;
  kind?: string;
  runtimeSessionId?: string;
  drain?: boolean;
}> = [];
let holdCommittedStart = false;
let committedStartHeld = false;
const heldCommittedStarts: Array<() => void> = [];

function releaseCommittedStarts() {
  holdCommittedStart = false;
  for (const resolve of heldCommittedStarts.splice(0)) resolve();
}

function releaseHeldStart(destroy: boolean) {
  holdNextStart = false;
  const pending = heldStartReplies.splice(0);
  console.log(`FG8_PROXY release held :start destroy=${destroy}`);
  for (const resolve of pending) resolve(destroy);
}

function releaseBrokerControls() {
  pausedBrokerControls = false;
  const pending = heldControlReplies.splice(0);
  console.log(`FG8_PROXY release ${pending.length} held control/status calls`);
  for (const resolve of pending) resolve();
}

const brokerProxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
    } catch (cause) {
      // A request body fails only with its connection — a client killed
      // mid-request, as FG8c kills the Harness: the request was never
      // forwarded, and the proxy itself has not failed.
      console.log(`FG8_PROXY client went away mid-request: ${cause}`);
      return;
    }
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, config.brokerUrl);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    let parsed: Record<string, unknown> | undefined;
    if (req.method === 'POST' && body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
    }
    if (parsed) {
      for (const key of ['harnessSessionId', 'runtimeSessionId'] as const) {
        const value = parsed[key];
        if (typeof value === 'string' && value.length > 0)
          brokerIdentity[key] = value;
      }
    }
    const isControl = url.pathname.endsWith('/control');
    let controlKind: string | undefined;
    if (isControl) {
      const nested = parsed?.['operation'];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const kind = (nested as Record<string, unknown>)['kind'];
        if (typeof kind === 'string') {
          controlKind = kind;
          brokerControlKinds.push(kind);
        }
      }
    }
    const isMonitorStop = isControl && controlKind === 'monitor-stop';
    // Holds that park before any upstream byte flows, by case design.
    if (holdNextStart && operation === 'start') {
      heldStartArrived = true;
      console.log('FG8_PROXY holding :start before forward');
      const destroy = await new Promise<boolean>((resolve) =>
        heldStartReplies.push(resolve),
      );
      if (destroy) {
        console.log('FG8_PROXY held :start destroyed, never forwarded');
        req.socket.destroy();
        return;
      }
    }
    if (pausedBrokerControls && (req.method === 'GET' || isControl)) {
      console.log(`FG8_PROXY holding ${req.method} ${operation}`);
      heldControlLog.push(`${req.method} ${url.pathname}`);
      await new Promise<void>((resolve) => heldControlReplies.push(resolve));
    }
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
    operationsLog.push({ op: operation, status: upstream.status });
    if (operation === 'start') {
      brokerStartAttempts++;
      if (upstream.status >= 400) {
        brokerStartFailures++;
      }
    }
    if (operation === 'start' && upstream.status === 200) {
      brokerStartedForwards++;
    }
    if (isMonitorStop) {
      brokerMonitorStopForwards++;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    console.log(`FG8_PROXY ${req.method} ${operation} -> ${upstream.status}`);
    // FG8c reads every broker answer by its declared code — a crash case's
    // refusals are its evidence — and every release by the Runtime Session
    // it names and the arm it asked for.
    let answerCode = '';
    if (upstream.status >= 400) {
      try {
        answerCode = String(
          (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>)[
            'code'
          ] ?? '',
        );
      } catch {
        // an unparsable refusal keeps the empty code
      }
    }
    const released = /\/tool-sessions\/([^/]+):release$/.exec(url.pathname);
    brokerAnswers.push({
      op: operation,
      status: upstream.status,
      code: answerCode,
      ...(controlKind ? { kind: controlKind } : {}),
      ...(released
        ? {
            runtimeSessionId: decodeURIComponent(released[1]),
            drain: parsed?.['drain'] === true,
          }
        : {}),
    });
    if (
      holdCommittedStart &&
      operation === 'start' &&
      upstream.status === 200
    ) {
      // FG8c harness-kill-dispatch: the broker committed the admission and
      // started the process; the reply never reaches the Harness, which the
      // case kills while this socket is parked.
      holdCommittedStart = false;
      committedStartHeld = true;
      console.log('FG8_PROXY holding the committed :start reply');
      await new Promise<void>((resolve) => heldCommittedStarts.push(resolve));
      console.log('FG8_DROPPED broker committed :start reply');
      req.socket.destroy();
      return;
    }
    const matchDrop =
      (dropNextStart && operation === 'start') ||
      (dropNextMonitorStop && isMonitorStop);
    if (matchDrop) {
      dropNextStart = false;
      dropNextMonitorStop = false;
      brokerDropped++;
      console.log(
        `FG8_DROPPED broker ${operation}${isMonitorStop ? ' monitor-stop' : ''}`,
      );
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
let segmentReleaseBudget = 0;
const heldReplies: Array<() => void> = [];
let droppedCommits = 0;
let droppedOps = 0;
const commitLog: Array<{
  op: string;
  commandId?: string;
  kind?: string;
  // The shell child_run record a commitChildRunRecord carries, when its
  // stop fields are what tells one revision from another.
  stopRequested?: boolean;
  stopReason?: string | null;
  status: number | 'dropped';
}> = [];
// FG8a's discriminated arms: a dropped PAGE publish reply (capture commit)
// and a dropped journal commit filtered by operation name (observation
// advance). Filters live in a Set — drop each op once. FG8d's
// cancel-reply-lost arm is keyed by content instead: commitChildRunRecord
// names every shell revision (admit, dispatch, attach, each output advance,
// the settle), so only the revision that sets stopRequested may fall.
let dropNextPagePublish = false;
let droppedPagePublishes = 0;
const dropCommitOps = new Set<string>();
let dropNextStopRevision = false;

// The shell child_run record a journal commit carries. The journal event
// names it only by recordRef; the record body rides the same commit as a
// staged `managed-child_run` resource in the `resources` array — undefined
// when the commit carries none.
function shellRunOf(
  parsed: Record<string, unknown> | undefined,
): { stopRequested: boolean; stopReason: string | null } | undefined {
  const resources = parsed?.['resources'];
  if (!Array.isArray(resources)) return undefined;
  for (const resource of resources) {
    if (typeof resource !== 'object' || resource === null) continue;
    const fields = resource as Record<string, unknown>;
    if (
      fields['kind'] !== 'managed-child_run' ||
      typeof fields['bytesBase64'] !== 'string'
    )
      continue;
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(
        Buffer.from(fields['bytesBase64'], 'base64').toString('utf8'),
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (run['kind'] !== 'shell' || typeof run['stopRequested'] !== 'boolean')
      continue;
    return {
      stopRequested: run['stopRequested'],
      stopReason: (run['stopReason'] as string | null | undefined) ?? null,
    };
  }
  return undefined;
}
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
      if (segmentReleaseBudget > 0) {
        segmentReleaseBudget--;
      } else {
        heldSegments++;
        console.log(`FG8_STORE_PROXY hold segment ${heldSegments}`);
        // Held BEFORE the commit reaches the store: the committed prefix
        // freezes while the producer's pipe backs up to the pause watermark.
        await new Promise<void>((resolve) => heldReplies.push(resolve));
      }
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
    // Content segments are the only resource kind with its own POST
    // (`/tool-results:publish`); pages and manifests are staged locally
    // and ride fused inside journal commits in their `resources` array
    // (http-managed-session-store.ts commitResources → commitBody).
    const commitOp = String(parsed?.['operation']);
    const resources = parsed?.['resources'];
    const carriesPageEnvelope =
      Array.isArray(resources) &&
      resources.some(
        (resource) =>
          typeof resource === 'object' &&
          resource !== null &&
          (resource as Record<string, unknown>)['kind'] ===
            'managed-tool-result-page',
      );
    const shellRun =
      commitOp === 'commitChildRunRecord' ? shellRunOf(parsed) : undefined;
    // The revision requestStop commits: the first to carry the stop mark,
    // before the settle names its stop reason.
    const isStopRevision =
      shellRun?.stopRequested === true && shellRun.stopReason === null;
    const entry = {
      op: commitOp,
      ...(typeof parsed?.['commandId'] === 'string'
        ? { commandId: parsed['commandId'] }
        : {}),
      ...(carriesPageEnvelope ? { kind: 'managed-tool-result-page' } : {}),
      ...(shellRun ?? {}),
    };
    // The op-filtered Set arms FG8f's settle manifest-commit and FG8a's
    // monitor observation advance, each keyed to fire on the named
    // operation only. FG8a's capture-commit arm drops the first journal
    // commit carrying a page envelope — the capture-page commit whose reply
    // is the loss — and FG8d's stop arm the first commit of the stop
    // revision. Only a commit the store accepted may lose its reply: a
    // refused one never landed, so it relays and the arm stays armed.
    const pageEnvelopeFell = dropNextPagePublish && carriesPageEnvelope;
    const stopRevisionFell = dropNextStopRevision && isStopRevision;
    if (
      isCommit &&
      upstream.ok &&
      (dropCommitOps.has(commitOp) || pageEnvelopeFell || stopRevisionFell)
    ) {
      dropCommitOps.delete(commitOp);
      if (stopRevisionFell) dropNextStopRevision = false;
      if (pageEnvelopeFell) {
        dropNextPagePublish = false;
        droppedPagePublishes++;
      } else {
        droppedCommits++;
        droppedOps++;
      }
      // The commit landed; the reply never does. A socket destroy is the
      // loss — no HTTP status the harness could mistake for a refusal.
      commitLog.push({ ...entry, status: 'dropped' });
      console.log(
        pageEnvelopeFell
          ? `FG8_DROPPED page-envelope commit ${commitOp}`
          : `FG8_DROPPED commit ${commitOp} ${entry.commandId ?? ''}`,
      );
      req.socket.destroy();
      return;
    }
    if (isCommit) {
      commitLog.push({ ...entry, status: upstream.status });
      console.log(
        `FG8_STORE_PROXY commit op=${commitOp} ${entry.commandId ?? ''}` +
          (shellRun
            ? ` stopRequested=${shellRun.stopRequested} stopReason=${shellRun.stopReason}`
            : '') +
          ` -> ${upstream.status}`,
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

function releaseHeldSegments(count = Number.POSITIVE_INFINITY) {
  holdSegments = Number.isFinite(count);
  const pending = heldReplies.splice(0, count);
  segmentReleaseBudget = holdSegments ? count - pending.length : 0;
  console.log(`FG8_STORE_PROXY release ${pending.length} held segments`);
  for (const resolve of pending) resolve();
}

function checkStoreProxy() {
  if (storeProxyFailure) throw storeProxyFailure;
}

let current = config.cases[0];
let modelCalls = 0;
// FG8c generation-remint: the post-crash prompt's first model call asks for
// a foreground Shell, so the turn awaits the Runtime warm every turn issues
// and its refusal lands among that prompt's broker answers (the Shell
// itself never runs).
let foregroundNext = false;
const model = await startFakeOpenAIServer(() => {
  modelCalls++;
  const producer = producerFor(current.name);
  if (foregroundNext) {
    foregroundNext = false;
    return {
      toolCalls: [
        fakeToolCall(
          'run_shell_command',
          {
            command: 'echo FG8_FOREGROUND',
            description: `fg8 ${current.name} foreground`,
          },
          'foreground-shell',
        ),
      ],
    };
  }
  if (modelCalls === 1) {
    return {
      toolCalls: [
        producer.monitor
          ? fakeToolCall(
              'monitor',
              {
                command: `${quotePosix(process.execPath)} -e ${quotePosix(producer.script)}`,
                max_events: 2,
                // The fixture's 60 s events poll/heartbeat can hold a
                // WebShell resume for a full poll cycle; the watch's idle
                // window must outlive that, or it idle-kills the gated
                // producer mid-gap and the gate never reopens.
                // FG8c's monitor-worker-kill wants the idle stop inside
                // the case, after the worker is gone: the window runs from
                // the watch's last flush (its one observation), and a loaded
                // lane was seen to take ~25 s from there to the kill, so
                // 60 s keeps the order.
                idle_timeout_ms:
                  current.name === 'monitor-worker-kill' ? 60_000 : 180_000,
                description: `fg8 ${current.name}`,
              },
              'monitor-watch',
            )
          : fakeToolCall(
              'run_shell_command',
              {
                command: `${quotePosix(process.execPath)} -e ${quotePosix(producer.script)}`,
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

async function runStreamCase(surface: 'public' | 'web') {
  const monitor = current.name.includes('monitor');
  const observer = new SseObserver({
    surface,
    sessionId: current.sessionId,
    storeUrl: config.storeUrl,
    tenantId: config.tenantId,
    timeoutMs: 300_000,
  });
  // Hoisted so the DIAG catch can dump both halves of the stream.
  let resumed: SseObserver | undefined;
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
    resumed = new SseObserver({
      surface,
      sessionId: current.sessionId,
      storeUrl: config.storeUrl,
      tenantId: config.tenantId,
      timeoutMs: 300_000,
    });
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
      projectEvents(ledger, surface),
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
        stopRequested?: boolean;
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
  const stallBlocks = await awaitProducerStall();
  step(
    `stalled at ${stallBlocks} blocks with ${heldSegments} segment commits held`,
  );
  // Leave at least 3 MiB held, allowing for a pipe chunk beyond the
  // 16 MiB pause threshold. The late JDBC sample cannot race the drain,
  // and a resume-at-empty regression cannot advance the producer.
  releaseHeldSegments(13);
  let committedAtResume = -1;
  await waitUntil(async () => {
    checkStoreProxy();
    if (progressLines() <= stallBlocks) return false;
    const state = await probe<ProbeState>(current.sessionId, 'state');
    committedAtResume = fullSegments(state).length;
    return true;
  }, 30_000);
  releaseHeldSegments();
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
  await awaitProducerStall();
  releaseHeldSegments();
  await waitUntil(() => {
    checkStoreProxy();
    return progressLines() >= 24;
  }, 60_000);
  // The producer parks on its gate, so the shell record is quiet: its next
  // commit after the arm is the settle cascade's manifest-commit. The arm
  // is keyed to that operation, not to "the next commit": the Session's
  // activation renewal commits on its own clock and took a bare next-commit
  // drop on the 0.75 Linux rig (droppedOp renewActivation).
  dropCommitOps.add('commitChildRunRecord');
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
      holdSegments = true;
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
    releaseHeldSegments();
    await cli.close();
  }
}

// FG8a/FG8b/FG8d letters: per-case choreography below; the IT asserts
// wire/JDBC truth off the results file and the operation log.
async function runReplyLossCase() {
  const cli = await bootHarness();
  try {
    const name = current.name;
    const monitor = name.includes('monitor') || name.startsWith('observation');
    if (name === 'dispatch-reply') dropNextStart = true;
    if (name === 'capture-commit-reply') dropNextPagePublish = true;
    execFileSync('mkfifo', [
      path.join(current.directory, monitor ? 'monitor-gate' : 'run-gate'),
    ]);
    const { clientId } = await createSession(cli, storeProxyUrl);
    await submitPrompt(cli, clientId, `fg8a ${name} launch`);
    step('prompt admitted');
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      if (monitor) {
        const watch = (await probe<ProbeState>(current.sessionId, 'state'))
          .monitors[0] as { observationSequence?: number } | undefined;
        return (watch?.observationSequence ?? 0) >= 1;
      }
      const rows = (await probe<ProbeState>(current.sessionId, 'state'))
        .executions;
      return rows.some(
        (row) =>
          row.execution_call_id.endsWith(':process') &&
          (row.execution_state === 'PREPARED' ||
            // A cgroup-less runtime settles the row terminal not-started
            // in one beat post-#14277 — no PREPARED flicker to catch.
            (row.execution_state === 'SETTLED' &&
              row.execution_status === 'not_started')),
      );
    }, 120_000);
    step('capability live');
    if (name === 'dispatch-reply') {
      await waitUntil(() => brokerDropped >= 1, 60_000);
      step('dispatch reply dropped once');
      // The proxy consumed the upstream :start reply before destroying
      // the client socket, so on a cgroup host the physical process is
      // already running and its producer is parked on the run-gate —
      // the run can never settle until the gate opens. A cgroup-less
      // runtime never starts, so there is nothing to open. One look at
      // the marker decides neither: the Broker answers :start once
      // beginDispatch committed, and the worker may write the marker
      // after that — wait until the run either started or settled as
      // never started.
      await waitUntil(async () => {
        checkProxy();
        if (bgStartedFile()) return true;
        const state = await probe<ProbeState>(current.sessionId, 'state');
        const runState = childRunOf(state)?.run?.state;
        return (
          runState === 'failed' ||
          state.executions.some(
            (row) =>
              row.execution_call_id.endsWith(':process') &&
              row.execution_state === 'SETTLED',
          )
        );
      }, 60_000);
      if (bgStartedFile()) {
        await releaseFifo(current.directory, 'run-gate');
        step('run-gate released for the started producer');
      } else {
        step('the dispatch settled as never started');
      }
    } else if (name === 'monitor-stop-reply') {
      dropNextMonitorStop = true;
      await releaseFifo(current.directory, 'monitor-gate');
      step('gate released with monitor-stop arm set');
      await waitUntil(() => brokerDropped >= 1, 180_000);
      step('monitor-stop reply dropped once');
    } else if (name === 'observation-advance-reply') {
      dropCommitOps.add('commitMonitorRun');
      await releaseFifo(current.directory, 'monitor-gate');
      step('gate released with observation-commit arm set');
      await waitUntil(() => droppedOps >= 1, 120_000);
      step('observation advance reply dropped once');
    } else if (name === 'capture-commit-reply') {
      // The page envelope has no POST of its own: staged locally, it
      // joins the settle cascade's first journal commit (`resources`
      // array), which exists only once the fixture's 24 blocks have
      // flushed at finish. Withhold the witness until that commit exists
      // instead of deadlocking on it before the release.
      await waitUntil(() => {
        checkStoreProxy();
        return progressLines() >= 24;
      }, 180_000);
      await releaseFifo(current.directory, 'run-gate');
      step('gate released');
      await waitUntil(() => droppedPagePublishes >= 1, 180_000);
      step('page-envelope commit reply dropped once');
    }
    await waitUntil(async () => {
      checkProxy();
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      if (monitor) {
        const watch = state.monitors[0] as
          | { stopReason?: string | null }
          | undefined;
        return watch?.stopReason != null;
      }
      const runState = childRunOf(state)?.run?.state;
      return runState === 'settled' || runState === 'failed';
    }, 180_000);
    step('settled after the lost reply');
    return {
      case: name,
      brokerDropped,
      brokerStartedForwards,
      brokerMonitorStopForwards,
      droppedPagePublishes,
      droppedOps,
      droppedCommitOps: commitLog
        .filter((entry) => entry.status === 'dropped')
        .map((entry) => entry.op),
      operations: [...operations],
      record: childRunOf(await probe<ProbeState>(current.sessionId, 'state')),
      monitor: (await probe<ProbeState>(current.sessionId, 'state'))
        .monitors[0],
      committedSegments: fullSegments(
        await probe<ProbeState>(current.sessionId, 'state'),
      ).length,
    };
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')} ` +
        `brokerDropped=${brokerDropped} droppedOps=${droppedOps} ` +
        `droppedPagePublishes=${droppedPagePublishes}\n` +
        `progress=${progressLines()}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

async function runStoreFailureCase() {
  const cli = await bootHarness();
  try {
    const name = current.name;
    execFileSync('mkfifo', [path.join(current.directory, 'run-gate')]);
    const { clientId } = await createSession(cli, storeProxyUrl);
    await submitPrompt(cli, clientId, `fg8b ${name} launch`);
    step('prompt admitted');
    const blockedCommit =
      name === 'invocation-commit' || name === 'process-ledger-commit';
    if (blockedCommit) {
      // The trigger rejects the admission commit inside a real
      // transaction: the turn wedges recovery-blocked and renews, never
      // minting a second execution identity. The rejected op in the
      // proxy log is the observable consequence; JDBC owns the rest of
      // the gate.
      const rejectOp = name === 'invocation-commit' ? 'prepare' : 'start';
      await waitUntil(
        () =>
          operationsLog.some(
            (entry) => entry.op === rejectOp && entry.status >= 400,
          ),
        120_000,
      );
      step(`the rejected ${rejectOp} reached the commit surface`);
      // The bounded uncertain retry may surface as an identical second
      // rejection or nothing at all: the stable window is what makes
      // "no second identity ever minted" observable.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    } else {
      // manifest/page-envelope-commit: the trigger keeps refusing the
      // target commit kind for the rest of the case.
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        const rows = (await probe<ProbeState>(current.sessionId, 'state'))
          .executions;
        return rows.some(
          (row) =>
            row.execution_call_id.endsWith(':process') &&
            row.execution_state === 'PREPARED',
        );
      }, 120_000);
      step('run live');
      await waitUntil(() => {
        checkStoreProxy();
        return progressLines() >= 24;
      }, 180_000);
      await releaseFifo(current.directory, 'run-gate');
      step('gate released');
      // Both arms block the settle. A 24-block capture fills no page
      // before finish (a page holds 512 segments): its only page envelope
      // is staged when the stream seals and rides the next output-advance
      // commitChildRunRecord, and the finalize's success manifest rides
      // the advance after it — the settle needs both first. Refusing the
      // page refuses the first advance and, since every later manifest
      // still names the staged page, every retry; refusing the manifest
      // refuses the second. Either way the run never settles — the
      // issue's "blocks the run" cell made literal. The witness is the
      // refused advance itself (for the page arm, one that carried the
      // page envelope); the stable window after it is what makes "never
      // settles" observable without hanging the fork (run 38868090681:
      // three commitChildRunRecord 500s, then silence, then a drain
      // release that changed nothing).
      await waitUntil(() => {
        checkStoreProxy();
        return commitLog.some(
          (entry) =>
            entry.op === 'commitChildRunRecord' &&
            entry.status === 500 &&
            (name === 'manifest-commit' ||
              entry.kind === 'managed-tool-result-page'),
        );
      }, 180_000);
      step('the settle commit was refused');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      step('still blocked after the stable window');
      const state = await probe<ProbeState>(current.sessionId, 'state');
      return {
        case: name,
        recovered: false,
        bgStarted: bgStartedFile(),
        brokerStartAttempts,
        brokerStartFailures,
        operations: [...operations],
        refusedSettleCommits: commitLog.filter(
          (entry) =>
            entry.op === 'commitChildRunRecord' && entry.status === 500,
        ).length,
        committedSegments: fullSegments(state).length,
        record: childRunOf(state),
      };
    }
    return {
      case: name,
      bgStarted: bgStartedFile(),
      executions: (await probe<ProbeState>(current.sessionId, 'state'))
        .executions,
      brokerStartAttempts,
      brokerStartFailures,
      operations: [...operations],
      record: childRunOf(await probe<ProbeState>(current.sessionId, 'state')),
    };
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')} ` +
        `brokerStartAttempts=${brokerStartAttempts} ` +
        `brokerStartFailures=${brokerStartFailures}\n` +
        `progress=${progressLines()}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

// FG8d's six cases share one tenant, and the fixture admits four active
// captures (`active-captures=4`). A capture a case leaves OPEN keeps the
// expiry its last grant renewal set (the writer lease or the activation,
// whichever ends first), and grant renewals stop once the tool call that
// launched the run returns, so under the default 60 s lease the capture
// holds its slot for up to a minute after its case moves on. On a fast
// host drain-release found all four slots held and its reservation was
// refused (the store's "Publication capacity exhausted", which the Harness
// logged as "The request is invalid."), so the run never started. Under a
// 10 s lease a capture stops counting within ten seconds of its last
// renewal. FG8d's one store arm matches a single stop-revision commit, so
// the extra writer and activation renewals a shorter lease brings never
// trip it.
const CANCEL_DRAIN_LEASE_MS = 10_000;

async function runCancelDrainCase() {
  const cli = await bootHarness();
  try {
    const name = current.name;
    if (name === 'cancel-before-start') holdNextStart = true;
    execFileSync('mkfifo', [path.join(current.directory, 'run-gate')]);
    const { clientId } = await createSession(
      cli,
      storeProxyUrl,
      CANCEL_DRAIN_LEASE_MS,
    );
    const promptId = await submitPrompt(cli, clientId, `fg8d ${name} launch`);
    step('prompt admitted');
    if (name === 'cancel-before-start') {
      // The dispatch is parked before forwarding; the tool's reservation
      // committed, so the broker already owns a row that a cancel can
      // settle — zero OS effects is provable after the cancel lands.
      await waitUntil(() => heldStartArrived, 60_000);
      step(':start held before forward');
      const cancel = await cli.request(`/session/${current.sessionId}/cancel`, {
        method: 'POST',
        headers: cli.headers(clientId),
      });
      assert.equal(cancel.status, 204, await cancel.text());
      step('daemon cancel answered 204');
      await waitUntil(() => operations.includes('cancel'), 60_000);
      step('broker saw the :cancel');
      releaseHeldStart(true);
      step('held :start destroyed, never forwarded');
      // Never-started settles only after the cancel batch lands: wait for
      // every invocation row to reach a terminal state. A :process row
      // must never exist here (the ITS JDBC assertion owns "zero OS
      // effects", and would fail if one appeared by now).
      await waitUntil(async () => {
        checkProxy();
        const rows = (await probe<ProbeState>(current.sessionId, 'state'))
          .executions;
        return (
          rows.length > 0 &&
          rows.every((row) => row.execution_state === 'SETTLED')
        );
      }, 120_000);
      step('cancelled invocation settled without a process row');
    } else {
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        const rows = (await probe<ProbeState>(current.sessionId, 'state'))
          .executions;
        return rows.some(
          (row) =>
            row.execution_call_id.endsWith(':process') &&
            row.execution_state === 'PREPARED',
        );
      }, 120_000);
      step('run live');
      if (name === 'cancel-during-capture') {
        await waitUntil(async () => {
          checkStoreProxy();
          const state = await probe<ProbeState>(current.sessionId, 'state');
          return fullSegments(state).length >= 3;
        }, 120_000);
        step('mid-capture (3 full segments)');
        // `children/operations` encodes the child-agent cancel family and
        // rejects shell records; the only stop surface a shell child_run
        // answers is the broker's drain release. The drain arm IS this
        // case's cancel: stopRequested commits with the stop evidence,
        // and the record settles cancelled, never exited.
        await awaitTurnHandback();
        const canceled = await brokerRelease(true);
        step(`drain cancel mid-capture -> ${canceled.status}`);
        assert.equal(canceled.status, 200, JSON.stringify(canceled.body));
        await waitUntil(async () => {
          const record = childRunOf(
            await probe<ProbeState>(current.sessionId, 'state'),
          );
          return record?.stopRequested === true;
        }, 60_000);
        step('stopRequested committed by the drain arm');
      } else if (name === 'cancel-status-unavailable') {
        await waitUntil(async () => {
          checkStoreProxy();
          const state = await probe<ProbeState>(current.sessionId, 'state');
          return fullSegments(state).length >= 1;
        }, 120_000);
        step('mid-capture');
        const processRow = (
          await probe<ProbeState>(current.sessionId, 'state')
        ).executions.find((row) => row.execution_call_id.endsWith(':process'));
        assert(processRow, 'the mid-capture run has its :process row');
        const processCallId = processRow.execution_call_id;
        await awaitTurnHandback();
        pausedBrokerControls = true;
        step('maintenance route held');
        // Positive hold witness: a status read must actually be parked in
        // the proxy, otherwise the held arm was never armed and the outage
        // is fiction. A quiet Harness issues no status reads of its own on
        // this lane, so the driver issues the one it would: the Harness's
        // backgroundProcessStatus read (GET /executions/<call>:process,
        // the Broker's real route) through the same proxy. It parks only
        // if the arm truly swallows the call, and after the restore it
        // must come back answered, not refused.
        const statusUrl = new URL(
          `/internal/runtime-broker/v1/executions/${encodeURIComponent(processCallId)}`,
          proxyUrl,
        );
        for (const [key, value] of Object.entries({
          protocolVersion: '1',
          requestId: randomUUID(),
          harnessSessionId:
            brokerIdentity.harnessSessionId ?? current.sessionId,
          runtimeSessionId: brokerIdentity.runtimeSessionId!,
        }))
          statusUrl.searchParams.set(key, value);
        const captiveStatus: Promise<{
          status: number;
          body: Record<string, unknown>;
        }> = fetch(statusUrl, {
          headers: { Authorization: 'Bearer hosted-tools-broker-token' },
          signal: AbortSignal.timeout(120_000),
        }).then(
          async (response) => {
            // Settles, never rejects: the read is awaited only after the
            // restore, and an early failure must not surface as an
            // unhandled rejection before then.
            const text = await response.text().catch(() => '');
            let body: Record<string, unknown> = { text };
            try {
              body = JSON.parse(text) as Record<string, unknown>;
            } catch {
              // a non-JSON answer keeps its text for the assertion message
            }
            return { status: response.status, body };
          },
          (cause: unknown) => ({ status: 0, body: { error: String(cause) } }),
        );
        await waitUntil(
          () =>
            heldControlLog.includes(`GET ${statusUrl.pathname}`) &&
            heldControlReplies.length >= 1,
          60_000,
        );
        step('the status read is really held');
        const unFabricated = childRunOf(
          await probe<ProbeState>(current.sessionId, 'state'),
        );
        assert.equal(unFabricated?.run?.state, 'running');
        assert.ok(unFabricated?.stopReason == null);
        step('no fabricated terminal while status is unreachable');
        const outletDrain = await brokerRelease(true);
        step(`drain release under the outage -> ${outletDrain.status}`);
        assert.equal(outletDrain.status, 200, JSON.stringify(outletDrain.body));
        releaseBrokerControls();
        step('maintenance route restored');
        const restored = await captiveStatus;
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.equal(restored.body['executionCallId'], processCallId);
        step('the held status read was answered after the restore');
      } else if (name === 'cancel-reply-lost') {
        await waitUntil(async () => {
          checkStoreProxy();
          const state = await probe<ProbeState>(current.sessionId, 'state');
          return fullSegments(state).length >= 1;
        }, 120_000);
        step('mid-capture');
        await awaitTurnHandback();
        dropNextStopRevision = true;
        // Same drain surface: the stopRequested write's commit reply is
        // what gets dropped after it committed — the arm matches that
        // revision by content, not by the operation name every shell
        // revision shares; the committed record must never mint a second
        // stop revision.
        const canceled = await brokerRelease(true);
        step(`drain cancel with armed reply drop -> ${canceled.status}`);
        assert.equal(canceled.status, 200, JSON.stringify(canceled.body));
        await waitUntil(() => {
          checkStoreProxy();
          return commitLog.some(
            (entry) =>
              entry.status === 'dropped' &&
              entry.stopRequested === true &&
              entry.stopReason === null,
          );
        }, 60_000);
        step('stopRequested commit reply dropped once');
        await waitUntil(async () => {
          const record = childRunOf(
            await probe<ProbeState>(current.sessionId, 'state'),
          );
          return record?.stopRequested === true;
        }, 60_000);
        step('stopRequested committed despite the lost reply');
      } else if (name === 'routine-release-refusal') {
        await awaitTurnHandback();
        const progressBefore = progressLines();
        const refusal = await brokerRequest(
          `/tool-sessions/${encodeURIComponent(brokerIdentity.runtimeSessionId!)}:release`,
          {},
        );
        step(
          `routine release -> ${refusal.status} ${refusal.code} at progress ${progressBefore}`,
        );
        assert.equal(refusal.status, 409, JSON.stringify(refusal.body));
        assert.equal(refusal.code, 'runtime_session_held');
        assert.ok(
          !brokerControlKinds.some(
            (kind) => kind === 'shell-terminate' || kind === 'monitor-stop',
          ),
          `the routine arm must stop nothing, saw ${brokerControlKinds.join(',')}`,
        );
        // The producer may already be parked on its gate by now; what the
        // refusal must not do is cut it short: it still reaches its full
        // 24 blocks, and once the gate opens it exits on its own — the IT
        // pins that natural exit (settled / exited / 0).
        await waitUntil(() => progressLines() >= 24, 120_000);
        step('producer completed its blocks past the refusal');
        await releaseFifo(current.directory, 'run-gate');
        step('gate released for the natural exit');
      } else if (name === 'drain-release') {
        await awaitTurnHandback();
        const drained = await brokerRequest(
          `/tool-sessions/${encodeURIComponent(brokerIdentity.runtimeSessionId!)}:release`,
          { drain: true },
        );
        step(`drain release -> ${drained.status}`);
        assert.equal(drained.status, 200, JSON.stringify(drained.body));
        assert.equal(drained.body['released'], true);
      } else {
        throw new Error(`unknown FG8d case ${name}`);
      }
    }
    if (name !== 'cancel-before-start') {
      // "Settled" is the whole terminal family here: drain-driven cancels
      // land cancelled, natural exits land settled, quoted proofs land
      // failed — the IT's per-case assertions pin the exact wording.
      await waitUntil(async () => {
        checkProxy();
        checkStoreProxy();
        const record = childRunOf(
          await probe<ProbeState>(current.sessionId, 'state'),
        );
        return (
          record?.run?.state !== undefined && record.run.state !== 'running'
        );
      }, 180_000);
      step('run reached a terminal record');
    }
    const terminal = await probe<ProbeState>(current.sessionId, 'state');
    return {
      case: name,
      promptId,
      bgStarted: bgStartedFile(),
      executions: terminal.executions,
      controlKinds: [...brokerControlKinds],
      droppedCancelReply: commitLog.some(
        (entry) =>
          entry.status === 'dropped' &&
          entry.stopRequested === true &&
          entry.stopReason === null,
      ),
      // Every journal command that set the stop mark, dropped or answered:
      // a re-drive of the lost reply resends the same command, a second
      // stop revision would add another.
      stopRevisionCommandIds: [
        ...new Set(
          commitLog
            .filter(
              (entry) =>
                entry.stopRequested === true && entry.stopReason === null,
            )
            .map((entry) => entry.commandId ?? '<none>'),
        ),
      ],
      operations: [...operations],
      record: childRunOf(terminal),
    };
  } catch (cause) {
    await diagnose(
      cli,
      `modelCalls=${modelCalls} operations=${operations.join(',')} ` +
        `controlKinds=${brokerControlKinds.join(',')}\n` +
        `progress=${progressLines()}`,
    );
    throw cause;
  } finally {
    await cli.close();
  }
}

async function bootHarness() {
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
  return cli;
}

// FG8d's driver-issued broker calls re-run through the broker proxy so
// the operation log keeps them too; the identity tuple is whatever the
// in-flight dispatch traffic captured from the Harness's own calls.
async function brokerRequest(
  pathSuffix: string,
  fields: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ status: number; code: string; body: Record<string, unknown> }> {
  const runtimeSessionId = brokerIdentity.runtimeSessionId;
  assert(
    runtimeSessionId,
    'a dispatch must expose the runtime session identity before any release',
  );
  const response = await fetch(
    new URL(`/internal/runtime-broker/v1${pathSuffix}`, proxyUrl),
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        harnessSessionId: brokerIdentity.harnessSessionId ?? current.sessionId,
        runtimeSessionId,
        ...fields,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Refusals are asserted on status+code; a body that does not parse
    // keeps the empty default.
  }
  return {
    status: response.status,
    code: String(parsed['code'] ?? ''),
    body: parsed,
  };
}

// A driver release answers for the background hold only once the
// dispatching turn is done with the Runtime Session. While a foreground
// execution is still active the Broker answers runtime_session_busy ahead
// of the hold (releaseSessionAfterSweep). And the Harness hands the
// Runtime Session back with its own routine release when the turn ends; a
// release that lands while that attempt is in flight joins it and gets its
// answer (runtime_session_held, even for a drain — 0.75 rig, baseline
// cancel-status-unavailable). Neither is the cell these cases gate, so wait
// until every invocation row settled with the background `:process` row
// still live, and the Harness's own release was answered.
async function awaitTurnHandback() {
  await waitUntil(async () => {
    checkProxy();
    checkStoreProxy();
    if (!operationsLog.some((entry) => entry.op === 'release')) return false;
    const rows = (await probe<ProbeState>(current.sessionId, 'state'))
      .executions;
    return (
      rows.some(
        (row) =>
          row.execution_call_id.endsWith(':process') &&
          row.execution_state === 'PREPARED',
      ) &&
      rows
        .filter((row) => !row.execution_call_id.endsWith(':process'))
        .every((row) => row.execution_state === 'SETTLED')
    );
  }, 120_000);
  step('turn handed the Runtime Session back with the background run live');
}

async function brokerRelease(drain: boolean, timeoutMs?: number) {
  return brokerRequest(
    `/tool-sessions/${encodeURIComponent(brokerIdentity.runtimeSessionId!)}:release`,
    drain ? { drain: true } : {},
    timeoutMs,
  );
}

function bgStartedFile(): boolean {
  try {
    readFileSync(path.join(current.directory, 'bg-started.txt'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// FG8g (H4f-c): the public task cancel of a live background Shell or
// Monitor watch. The process holds on its gate, so only the cancel can end
// it: the operation completes from the committed record, the record
// settles cancelled by stop_requested, and the retained key replays.
async function api(
  route: string,
  init: { method?: string; key?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(route, config.storeUrl), {
    method: init.method ?? 'GET',
    headers: {
      'X-Qwen-Tenant-Id': config.tenantId,
      ...(init.key ? { 'Idempotency-Key': init.key } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function runCancelCase() {
  const monitor = current.name.includes('monitor');
  const cli = await bootHarness();
  try {
    execFileSync('mkfifo', [
      path.join(current.directory, monitor ? 'monitor-gate' : 'run-gate'),
    ]);
    const { clientId } = await createSession(cli, config.storeUrl);
    await submitPrompt(cli, clientId, `fg8 ${current.name} launch`);
    step('prompt admitted');
    const sessionRoute = `/v1/agents/sessions/${current.sessionId}`;
    const kind = monitor ? 'monitor' : 'background_shell';
    let task: Record<string, unknown> | undefined;
    await waitUntil(async () => {
      checkProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const live = monitor
        ? ((state.monitors[0] as { observationSequence?: number })
            ?.observationSequence ?? 0) >= 1
        : state.executions.some(
            (row) =>
              row.execution_call_id.endsWith(':process') &&
              row.execution_state === 'PREPARED',
          );
      if (!live) return false;
      const tasks = await api(`${sessionRoute}/tasks`);
      assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
      task = (tasks.body['data'] as Array<Record<string, unknown>>).find(
        (candidate) => candidate['kind'] === kind,
      );
      return task !== undefined;
    }, 120_000);
    assert.deepEqual(task!['action_capabilities'], ['cancel']);
    step(`${kind} live as ${task!['id']}`);
    const cancelRoute = `${sessionRoute}/tasks/${task!['id']}/cancel`;
    const admitted = await api(cancelRoute, {
      method: 'POST',
      key: `fg8g-${current.name}`,
    });
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.body['type'], 'task_cancel');
    const operationId = admitted.body['id'] as string;
    let operation: Record<string, unknown> = admitted.body;
    await waitUntil(async () => {
      operation = (await api(`${sessionRoute}/operations/${operationId}`)).body;
      return operation['status'] === 'completed';
    }, 120_000);
    step('cancel completed');
    const state = await probe<ProbeState>(current.sessionId, 'state');
    const record = (monitor ? state.monitors[0] : state.childRuns[0]) as {
      stopReason?: string | null;
      stopRequested?: boolean;
      run?: { state?: string };
    };
    assert.equal(record.run?.state, 'cancelled');
    assert.equal(record.stopReason, 'stop_requested');
    if (!monitor) assert.equal(record.stopRequested, true);
    const settledTask = (await api(`${sessionRoute}/tasks/${task!['id']}`))
      .body;
    assert.equal(settledTask['state'], 'cancelled');
    assert.deepEqual(settledTask['action_capabilities'], []);
    const replay = await api(cancelRoute, {
      method: 'POST',
      key: `fg8g-${current.name}`,
    });
    assert.equal(replay.body['id'], operationId);
    assert.equal(replay.body['status'], 'completed');
    assert.equal(replay.body['replayed'], true);
    return {
      case: current.name,
      taskId: task!['id'],
      operation,
      operations: [...operations],
    };
  } catch (cause) {
    await diagnose(cli, `operations=${operations.join(',')}`);
    throw cause;
  } finally {
    await cli.close();
  }
}

// FG8c — process crashes. The Harness, the managed worker, and the
// background process itself are killed (or stopped) for real, one at a
// time, under a live background run; a Harness restart reloads the Session
// cold from the store under a new writer identity. Crash Sessions run a
// 10 s writer lease: a reload outlives the killed writer without a minute's
// wait, the capture a crashed or closed Session leaves OPEN expires within
// seconds — the fixture tenant admits four active captures, and seven cases
// in a row under a 60 s lease exhausted it on the seventh — and a renewal,
// due at half the lease, still has 5 s of slack on a loaded lane. Crash
// Sessions talk to the store directly: a Harness killed mid-upload must not
// leave the store proxy holding an aborted request.
const CRASH_LEASE_MS = 10_000;

type RuntimeProbe = {
  bindings: Array<{
    binding_id: string;
    binding_state: string;
    runtime_generation: number;
    loss_evidence: number | boolean;
    stop_evidence: number | boolean;
  }>;
  slots: Array<{ last_generation: number; active_binding_id: string | null }>;
  runtimeSessions: Array<{ runtime_session_id: string; session_state: string }>;
  executions: Array<{
    execution_call_id: string;
    execution_state: string;
    execution_status: string | null;
    runtime_generation: number;
    runtime_session_id: string;
    loss_evidence_id: string | null;
    abandoned: number | boolean;
    result_json: string | null;
  }>;
};

function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2];
  } catch {
    return undefined;
  }
}

const pidAlive = (pid: number) => {
  const state = procState(pid);
  return state !== undefined && state !== 'Z' && state !== 'X';
};

function bgPid(): number {
  const pid = Number(
    readFileSync(path.join(current.directory, 'bg-started.txt'), 'utf8'),
  );
  assert(Number.isSafeInteger(pid) && pid > 0, `bg pid ${pid}`);
  return pid;
}

async function crashSnapshot(label: string) {
  const state = await probe<ProbeState>(current.sessionId, 'state');
  const runtime = await probe<RuntimeProbe>(current.sessionId, 'runtime');
  const snapshot = {
    label,
    record: childRunOf(state) ?? null,
    monitor: state.monitors[0] ?? null,
    bindings: runtime.bindings,
    slots: runtime.slots,
    runtimeSessions: runtime.runtimeSessions,
    executions: runtime.executions,
    fullSegments: fullSegments(state).length,
  };
  console.log(`FG8_CRASH_STATE ${current.name} ${JSON.stringify(snapshot)}`);
  return snapshot;
}

async function harnessJson(
  cli: HostedHarnessProcess,
  method: string,
  route: string,
  clientId?: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await cli.request(route, {
    method,
    headers: {
      ...cli.headers(clientId),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}

async function sigkillHarness(cli: HostedHarnessProcess) {
  const child = cli.child!;
  const pid = child.pid!;
  const exited = new Promise<[number | null, string | null]>((resolve) =>
    child.once('exit', (code, signal) => resolve([code, signal])),
  );
  assert(child.kill('SIGKILL'));
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  step(`harness ${pid} SIGKILLed`);
  return { process: 'harness', pid, signal };
}

// The case's own worker: the JVM's worker children diffed around the
// case's first dispatch — exactly one is new.
async function caseWorker(before: number[]): Promise<number> {
  const after = await probe<number[]>(current.sessionId, 'workers');
  const fresh = after.filter((pid) => !before.includes(pid));
  assert.equal(fresh.length, 1, `one new worker: ${before} -> ${after}`);
  return fresh[0];
}

// The case's Session status as the Harness reports it.
async function sessionStatus(cli: HostedHarnessProcess, clientId: string) {
  const status = await harnessJson(
    cli,
    'GET',
    `/session/${current.sessionId}/status`,
    clientId,
  );
  assert.equal(status.status, 200, JSON.stringify(status.body));
  return status.body;
}

// Create the Session on a booted Harness and launch the case's background
// run through a launch turn that settles while the run keeps its hold
// (unless the case parks the :start reply, when `settle` is false). The run
// is live once its supervised process announced itself and the `:process`
// row is PREPARED; the turn has settled once the Session reports no active
// prompt.
async function launchCrashRun(cli: HostedHarnessProcess, settle: boolean) {
  const workersBefore = await probe<number[]>(current.sessionId, 'workers');
  const monitor = current.name === 'monitor-worker-kill';
  if (current.name !== 'harness-kill-capture') {
    execFileSync('mkfifo', [
      path.join(current.directory, monitor ? 'monitor-gate' : 'run-gate'),
    ]);
  }
  const { clientId } = await createSession(
    cli,
    config.storeUrl,
    CRASH_LEASE_MS,
  );
  const promptId = await submitPrompt(
    cli,
    clientId,
    `fg8c ${current.name} launch`,
  );
  step('prompt admitted');
  await waitUntil(async () => {
    checkProxy();
    checkStoreProxy();
    if (!bgStartedFile()) return false;
    const state = await probe<ProbeState>(current.sessionId, 'state');
    return state.executions.some(
      (row) =>
        row.execution_call_id.endsWith(':process') &&
        row.execution_state === 'PREPARED',
    );
  }, 120_000);
  step('run live');
  if (settle) {
    await waitUntil(async () => {
      checkProxy();
      if ((await sessionStatus(cli, clientId))['hasActivePrompt'] !== false)
        return false;
      if (!monitor) return true;
      // The watch committed its observation before the case faults it.
      const watch = (await probe<ProbeState>(current.sessionId, 'state'))
        .monitors[0] as { observationSequence?: number } | undefined;
      return (watch?.observationSequence ?? 0) >= 1;
    }, 120_000);
    step('launch turn settled, run still live');
  }
  const worker = await caseWorker(workersBefore);
  return { clientId, promptId, worker };
}

// The cold reload on a fresh Harness, under its own writer identity. The
// killed writer's lease runs from its last renewal, which the store can
// commit just after the kill, so the one 409 that heals on its own — the
// writer conflict — is retried until the lease lapses; any other answer is
// the reload's.
async function reloadSession(cli: HostedHarnessProcess) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const loaded = await harnessJson(
      cli,
      'POST',
      `/session/${current.sessionId}/load`,
      undefined,
      sessionBody(cli, config.storeUrl, CRASH_LEASE_MS),
    );
    step(`reload -> ${loaded.status} ${JSON.stringify(loaded.body)}`);
    if (
      loaded.status !== 409 ||
      loaded.body['code'] !== 'managed_session_writer_conflict' ||
      Date.now() >= deadline
    ) {
      return loaded;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// DELETE /session — the close whose drain arm releases every hold the
// Session knows of, live or restored.
async function closeCrashSession(cli: HostedHarnessProcess, clientId: string) {
  const at = brokerAnswers.length;
  const closed = await harnessJson(
    cli,
    'DELETE',
    `/session/${current.sessionId}`,
    clientId,
  );
  step(`close -> ${closed.status}`);
  return {
    status: closed.status,
    releases: brokerAnswers
      .slice(at)
      .filter((answer) => answer.op === 'release')
      .map(({ runtimeSessionId, drain, status, code }) => ({
        runtimeSessionId,
        drain,
        status,
        code,
      })),
  };
}

async function sigkillWorker(worker: number, signals: unknown[]) {
  process.kill(worker, 'SIGKILL');
  await waitUntil(() => !pidAlive(worker), 10_000);
  signals.push({ process: 'worker', pid: worker, signal: 'SIGKILL' });
  step(`worker ${worker} SIGKILLed`);
}

async function runCrashCase() {
  const name = current.name;
  const report: Record<string, unknown> = { case: name };
  const signals: Array<Record<string, unknown>> = [];
  report['signals'] = signals;
  const harnesses: HostedHarnessProcess[] = [];
  let bg: number | undefined;
  let stoppedWorker: number | undefined;
  try {
    // harness-kill-dispatch parks the committed :start reply, so its launch
    // turn never learns the run started and never settles.
    if (name === 'harness-kill-dispatch') holdCommittedStart = true;
    const first = await bootHarness();
    harnesses.push(first);
    const launched = {
      cli: first,
      ...(await launchCrashRun(first, name !== 'harness-kill-dispatch')),
    };
    bg = bgPid();
    report['promptId'] = launched.promptId;
    if (name === 'harness-kill-dispatch' || name === 'harness-kill-capture') {
      if (name === 'harness-kill-dispatch') {
        // The broker writes the row and starts the process before it
        // answers, so the parked reply can trail the live run.
        await waitUntil(() => committedStartHeld, 30_000);
      } else {
        // Mid-capture is a state: three full segments committed, the paced
        // producer still appending.
        await waitUntil(async () => {
          const state = await probe<ProbeState>(current.sessionId, 'state');
          return fullSegments(state).length >= 3;
        }, 60_000);
      }
      signals.push(await sigkillHarness(launched.cli));
      releaseCommittedStarts();
      report['committedStartDropped'] = committedStartHeld;
      // The killed writer's lease must lapse before another writer may
      // open (the reload retries a writer conflict until it has).
      await new Promise((resolve) => setTimeout(resolve, CRASH_LEASE_MS + 200));
      const at = brokerAnswers.length;
      const cli = await bootHarness();
      harnesses.push(cli);
      const loaded = await reloadSession(cli);
      // Once another writer opened, the dead one is fenced: any commit it
      // still had in flight has landed or been refused, so this count is
      // the capture's last.
      report['segmentsAtReload'] = (
        await crashSnapshot('after-reload')
      ).fullSegments;
      report['reload'] = {
        status: loaded.status,
        code: loaded.body['code'] ?? null,
        reason: loaded.body['reason'] ?? null,
      };
      report['reloadOps'] = brokerAnswers
        .slice(at)
        .map(({ op, status, code }) => ({ op, status, code }));
      report['bgAliveAfterReload'] = pidAlive(bg);
      if (loaded.status === 200) {
        report['close'] = await closeCrashSession(
          cli,
          loaded.body['clientId'] as string,
        );
        // The restored drain's stop is the only thing that may end the run.
        await waitUntil(() => !pidAlive(bg!), 30_000).catch(() => undefined);
        report['bgAliveAfterClose'] = pidAlive(bg);
      }
    } else if (name === 'worker-kill' || name === 'generation-remint') {
      await sigkillWorker(launched.worker, signals);
      await crashSnapshot('after-kill');
      if (name === 'generation-remint') {
        // Two ordinary prompts after the loss, each reaching for the
        // Runtime with a foreground Shell: the first finds the dead worker,
        // the second the lost generation.
        const attempts = [];
        for (const attempt of [1, 2]) {
          const at = brokerAnswers.length;
          foregroundNext = true;
          await submitPrompt(
            launched.cli,
            launched.clientId,
            `fg8c ${name} post-crash ${attempt}`,
          );
          await waitUntil(
            async () =>
              (await sessionStatus(launched.cli, launched.clientId))[
                'hasActivePrompt'
              ] === false,
            120_000,
          );
          attempts.push(
            brokerAnswers
              .slice(at)
              .map(({ op, status, code }) => ({ op, status, code })),
          );
        }
        report['postCrash'] = attempts;
      }
      report['close'] = await closeCrashSession(
        launched.cli,
        launched.clientId,
      );
    } else if (name === 'worker-stop') {
      process.kill(launched.worker, 'SIGSTOP');
      stoppedWorker = launched.worker;
      await waitUntil(() => procState(launched.worker) === 'T', 5_000);
      signals.push({
        process: 'worker',
        pid: launched.worker,
        signal: 'SIGSTOP',
      });
      step('worker SIGSTOPped');
      // The uncertainty window: a release sweep's status read against the
      // stopped worker runs into the broker's 30 s worker-request bound.
      const started = Date.now();
      const held = await brokerRelease(false, 90_000);
      report['stoppedRelease'] = {
        status: held.status,
        code: held.code,
        elapsedMs: Date.now() - started,
      };
      step(`routine release while stopped -> ${held.status} ${held.code}`);
      const during = await crashSnapshot('while-stopped');
      report['whileStopped'] = {
        recordState: during.record?.run?.state ?? null,
        stopReason: during.record?.stopReason ?? null,
        processRow: during.executions.find((row) =>
          row.execution_call_id.endsWith(':process'),
        )?.execution_state,
        bindingStates: during.bindings.map((row) => row.binding_state),
      };
      process.kill(launched.worker, 'SIGCONT');
      await waitUntil(() => procState(launched.worker) !== 'T', 5_000);
      stoppedWorker = undefined;
      signals.push({
        process: 'worker',
        pid: launched.worker,
        signal: 'SIGCONT',
      });
      step('worker SIGCONTed');
      await releaseFifo(current.directory, 'run-gate');
      await waitUntil(async () => {
        checkStoreProxy();
        const record = childRunOf(
          await probe<ProbeState>(current.sessionId, 'state'),
        );
        return record?.run?.state === 'settled';
      }, 120_000);
      step('resumed run settled');
      report['close'] = await closeCrashSession(
        launched.cli,
        launched.clientId,
      );
    } else if (name === 'process-kill') {
      process.kill(bg, 'SIGKILL');
      await waitUntil(() => !pidAlive(bg!), 10_000);
      signals.push({ process: 'background', pid: bg, signal: 'SIGKILL' });
      step('background process SIGKILLed');
      await waitUntil(async () => {
        checkStoreProxy();
        const record = childRunOf(
          await probe<ProbeState>(current.sessionId, 'state'),
        );
        return record?.run?.state === 'settled';
      }, 120_000);
      step('killed run settled');
      report['close'] = await closeCrashSession(
        launched.cli,
        launched.clientId,
      );
    } else {
      assert.equal(name, 'monitor-worker-kill');
      // The idle window must still be open at the kill, or the stop would
      // meet a live worker and settle honestly — a case that never faulted.
      const watch = (await probe<ProbeState>(current.sessionId, 'state'))
        .monitors[0] as
        | { run?: { state?: string }; stopReason?: string | null }
        | undefined;
      assert.equal(
        watch?.run?.state,
        'running',
        'the watch is live at the kill',
      );
      assert.equal(watch?.stopReason, null);
      await sigkillWorker(launched.worker, signals);
      // The watch is silent past its observation, so its idle window ends
      // it — and that auto-stop must ask the worker the Runtime lost.
      await waitUntil(async () => {
        const watch = (await probe<ProbeState>(current.sessionId, 'state'))
          .monitors[0] as { run?: { state?: string } } | undefined;
        return watch?.run?.state === 'recovery_blocked';
      }, 120_000).catch((cause) => {
        throw new Error(
          'the watch never parked after its idle stop met the lost worker',
          { cause },
        );
      });
      step('watch parked');
      report['close'] = await closeCrashSession(
        launched.cli,
        launched.clientId,
      );
    }
    report['monitorStops'] = brokerAnswers
      .filter((answer) => answer.kind === 'monitor-stop')
      .map(({ status, code }) => ({ status, code }));
    report['starts'] = brokerAnswers.filter(
      (answer) => answer.op === 'start',
    ).length;
    report['modelCalls'] = modelCalls;
    checkProxy();
    checkStoreProxy();
    return report;
  } catch (cause) {
    await diagnose(
      harnesses.at(-1) ?? new HostedHarnessProcess(),
      `modelCalls=${modelCalls} signals=${JSON.stringify(signals)}\n` +
        `answers=${JSON.stringify(brokerAnswers)}`,
    );
    throw cause;
  } finally {
    releaseCommittedStarts();
    if (stoppedWorker !== undefined) {
      try {
        process.kill(stoppedWorker, 'SIGCONT');
      } catch {
        // already gone
      }
    }
    for (const cli of harnesses) await cli.close();
    // The case owns its physical leftovers: a refused reload or a killed
    // worker leaves the background process running, and nothing in
    // production reaps it in this topology.
    if (bg === undefined && bgStartedFile()) bg = bgPid();
    if (bg !== undefined && pidAlive(bg)) {
      try {
        process.kill(bg, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

try {
  const reports = [];
  for (current of config.cases) {
    caseStart = Date.now();
    modelCalls = 0;
    operations.length = 0;
    operationsLog.length = 0;
    holdSegments = false;
    heldSegments = 0;
    segmentReleaseBudget = 0;
    droppedCommits = 0;
    droppedOps = 0;
    dropNextStart = false;
    dropNextMonitorStop = false;
    brokerDropped = 0;
    brokerStartedForwards = 0;
    brokerMonitorStopForwards = 0;
    brokerStartAttempts = 0;
    brokerStartFailures = 0;
    holdNextStart = false;
    heldStartArrived = false;
    pausedBrokerControls = false;
    brokerControlKinds.length = 0;
    brokerIdentity.harnessSessionId = undefined;
    brokerIdentity.runtimeSessionId = undefined;
    dropNextPagePublish = false;
    droppedPagePublishes = 0;
    dropCommitOps.clear();
    dropNextStopRevision = false;
    // Per-case like every arm above: a drop the previous case witnessed
    // must not read as this case's (FG8a's capture-commit drop would
    // otherwise surface in observation-advance-reply's droppedCommitOps).
    commitLog.length = 0;
    heldControlLog.length = 0;
    brokerAnswers.length = 0;
    holdCommittedStart = false;
    committedStartHeld = false;
    foregroundNext = false;
    if (config.letter === 'fg8a') {
      reports.push(await runReplyLossCase());
    } else if (config.letter === 'fg8b') {
      reports.push(await runStoreFailureCase());
    } else if (config.letter === 'fg8d') {
      reports.push(await runCancelDrainCase());
    } else if (config.letter === 'fg8c') {
      reports.push(await runCrashCase());
    } else if (config.letter === 'fg8f') {
      reports.push(await runPublishCase());
    } else if (config.letter === 'fg8g') {
      reports.push(await runCancelCase());
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
    config.letter === 'fg8f'
      ? 'FG8_OUTPUT_DELIVERY_OK'
      : config.letter === 'fg8a'
        ? 'FG8_REPLY_LOSS_OK'
        : config.letter === 'fg8b'
          ? 'FG8_STORE_FAILURE_OK'
          : config.letter === 'fg8d'
            ? 'FG8_CANCEL_DRAIN_OK'
            : config.letter === 'fg8g'
              ? 'FG8_TASK_CANCEL_OK'
              : config.letter === 'fg8c'
                ? 'FG8_PROCESS_CRASH_OK'
                : 'FG8_STREAM_GAPS_OK',
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
