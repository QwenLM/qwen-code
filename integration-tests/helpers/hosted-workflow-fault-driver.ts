/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// FG10a (issue #14165): the fault-injection driver for the workflow
// child_run kind's digest-integrity gate. Each case boots its own packaged
// Harness on the fixture's pinned port (the in-JVM Spring names it in
// harness.base-url), drives the parent Session's `workflow` tool call
// through a scripted model, and leaves the JDBC ground truth to the IT's
// probe. FG10a tampers the pinned launch envelope between the record commit
// and the relay's read — the relay is held to a 3600 s scan delay for the
// letter, so the probe's tamper and its single relay scan are one
// deterministic sequence.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { relayUpstream } from './hosted-relay-headers.js';

const configPath = process.argv[2];
assert(configPath, 'usage: hosted-workflow-fault-driver.ts <driver.json>');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  letter: 'fg10a';
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  statusGateUrl: string;
  storeProxyPort: number;
  harnessPort: number;
  cases: Array<{
    name: string;
    sessionId: string;
    workspaceId: string;
    directory: string;
  }>;
  resultFile: string;
};

// The canned scripts. Every one is plain ASCII so the probe's in-place
// byte rewrite never meets a JSON escape. The flip case corrupts the
// refusal script's sentinel; the substitution case swaps in
// SUBSTITUTE_SCRIPT — a syntactically valid, byte-length-equal script the
// substitute-script-baseline case proves runs to completion, so the
// substitution's refusal is attributable to the digest alone, never to a
// parse error. The positive case echoes its args so the ECMAScript
// rendering of fractional values is asserted end to end.
const REFUSAL_SCRIPT = [
  'export const meta = { name: "fg10tamper", description: "fg10a" };',
  'return "FG10_SHOULD_NEVER_RUN";',
].join('\n');
const SUBSTITUTE_SCRIPT = [
  'export const meta = { name: "fg10substX", description: "fg10a" };',
  'return "FG10_SUBSTITUTED_OKAY";',
].join('\n');
assert.equal(
  Buffer.byteLength(SUBSTITUTE_SCRIPT, 'utf8'),
  Buffer.byteLength(REFUSAL_SCRIPT, 'utf8'),
  'the substitution is byte-length preserving: only the digest can catch it',
);
const POSITIVE_SCRIPT = [
  'export const meta = { name: "fg10probe", description: "fg10a" };',
  'return "FG10_ARGS_ECHO " + JSON.stringify(args);',
].join('\n');
// The fractional and subnormal values that wedged the child's first Turn
// before #13858 canonicalised the digest substrate.
const POSITIVE_ARGS = { temperature: 0.1, tiny: 5e-324, label: 'fg10' };

function scriptFor(name: string): { script: string; args?: unknown } {
  switch (name) {
    case 'tampered-script-refused':
    case 'same-length-substitution-refused':
      return { script: REFUSAL_SCRIPT };
    case 'substitute-script-baseline':
      return { script: SUBSTITUTE_SCRIPT };
    case 'fractional-args-admitted':
      return { script: POSITIVE_SCRIPT, args: POSITIVE_ARGS };
    default:
      throw new Error(`unknown case ${name}`);
  }
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

let current = config.cases[0];
let caseStart = Date.now();
function step(text: string) {
  console.log(
    `FG10_STEP ${current.name} ${text} @+${Date.now() - caseStart}ms`,
  );
}

// --- The scripted model -------------------------------------------------
// The parent's first request carries the launch text and gets the workflow
// tool call; its follow-up (the tool result rides the history) gets canned
// content. A child-side request never carries the launch text: it is an
// agent() dispatch, and FG10a's scripts never call agent() — the positive
// case returns its args inline and the refusal cases are refused before
// any spend — so the request log is the zero-spend witness.
let workflowCallSent = false;
let childModelCalls = 0;
let parentModelCalls = 0;
const model = await startFakeOpenAIServer(async ({ body }) => {
  const text = JSON.stringify(body['messages'] ?? []);
  if (!text.includes(`fg10 ${current.name} launch`)) {
    childModelCalls++;
    return { content: 'FG10_SUB_ANSWER' };
  }
  parentModelCalls++;
  if (!workflowCallSent) {
    workflowCallSent = true;
    return {
      toolCalls: [
        fakeToolCall('workflow', scriptFor(current.name), 'fg10-launch'),
      ],
    };
  }
  return { content: `FG10 ${current.name} done.` };
});

// --- The store-fronting proxy -------------------------------------------
// The server-side session-store.base-url points here, so the relay-created
// child Session's store traffic crosses this proxy; the parent Session's
// does too when the case creates it against the proxy. The commit log is
// the launch's store-side evidence.
let storeProxyFailure: unknown;
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
    if (req.method === 'POST' && /:commit(?:-v2)?$/.test(url.pathname)) {
      const sessionMatch = /\/sessions\/([^/]+)\//.exec(url.pathname);
      const session = sessionMatch?.[1]
        ? decodeURIComponent(sessionMatch[1])
        : '';
      console.log(
        `FG10_STORE_PROXY commit session=${session} op=${String(parsed?.['operation'] ?? '')}`,
      );
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
    relayUpstream(res, upstream, bytes);
  } catch (cause) {
    storeProxyFailure = cause;
    console.log(`FG10_STORE_PROXY failed: ${cause}`);
    res.destroy();
  }
});
await new Promise<void>((resolve, reject) => {
  storeProxy.once('error', reject);
  storeProxy.listen(config.storeProxyPort, '127.0.0.1', resolve);
});
const storeProxyUrl = `http://127.0.0.1:${config.storeProxyPort}`;

function checkStoreProxy() {
  if (storeProxyFailure) throw storeProxyFailure;
}

// --- The probe client ----------------------------------------------------
async function probe<T>(
  sessionId: string,
  phase: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    new URL(`/fg10/${sessionId}/${phase}`, config.statusGateUrl),
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(130_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as T;
}

type ProbeState = {
  childRuns: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
};

function childRunOf(state: ProbeState) {
  return state.childRuns[0] as
    | {
        kind?: string;
        run?: {
          state?: string;
          definition?: { definitionDigest?: string };
        };
        stopReason?: string | null;
        childSessionId?: string | null;
      }
    | undefined;
}

// --- Shared choreography --------------------------------------------------
async function createSession(
  cli: HostedHarnessProcess,
  storeBaseUrl: string,
): Promise<{ clientId: string }> {
  const created = await cli.request('/session', {
    method: 'POST',
    headers: { ...cli.headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: current.sessionId,
      sessionScope: 'thread',
      toolProfile: 'hosted-workspace-shell/1',
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
  return { clientId: JSON.parse(createdBody)['clientId'] as string };
}

async function submitPrompt(
  cli: HostedHarnessProcess,
  clientId: string,
  text: string,
): Promise<void> {
  const prompt = [{ type: 'text', text }];
  const submitted = await cli.request(`/session/${current.sessionId}/prompt`, {
    method: 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      promptId: randomUUID(),
      prompt,
      payloadDigest: `sha256:${sha256(JSON.stringify(prompt))}`,
    }),
  });
  assert.equal(submitted.status, 202, await submitted.text());
}

async function bootHarness(): Promise<HostedHarnessProcess> {
  const cli = new HostedHarnessProcess();
  await cli.start(model.baseUrl, {
    port: config.harnessPort,
    extraArgs: [
      '--managed-runtime-broker-url',
      config.brokerUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  return cli;
}

async function diagnose(cli: HostedHarnessProcess, header: string) {
  let daemonLog = '<unavailable>';
  try {
    daemonLog = readFileSync(
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
  console.error(
    `FG10_DIAG ${current.name} ${header}\n` +
      `finalState=${finalState}\n` +
      `daemonLogTail=${daemonLog.slice(-3000)}\n` +
      `harness output:\n${cli.output}`,
  );
}

/** The mismatch refusal must name the two digests somewhere observable. */
async function refusalNamed(cli: HostedHarnessProcess): Promise<boolean> {
  const needle = 'Workflow launch pin does not match its script';
  if (cli.output.includes(needle)) return true;
  try {
    return readFileSync(
      path.join(cli.root, 'runtime/debug/daemon/daemon.log'),
      'utf8',
    ).includes(needle);
  } catch {
    return false;
  }
}

// --- FG10a: digest integrity ----------------------------------------------
// The gate's assertions sit at the child Turn, not the record's terminal
// settlement: the digest refusal fires inside the Turn
// (hosted-workflow-turn.ts) and the Turn runs independently of the relay's
// later bind/deliver walk, which this fixture's driver-held parent cannot
// drive to completion on macOS (the relay's operations on the parent need a
// coordinator-owned attach — a Linux-only topology here). The probe drives
// exactly one relay scan after the tamper to fire the create; the bind and
// beyond never run, so the driver-held parent never conflicts.
async function runDigestCase() {
  const cli = await bootHarness();
  step('harness boot');
  try {
    // The parent rides the store proxy too: the relay-created child
    // inherits the server-side session-store.base-url (the proxy), and a
    // parent on the direct URL would make the child's load refuse with
    // hosted_session_store_mismatch.
    const { clientId } = await createSession(cli, storeProxyUrl);
    await submitPrompt(cli, clientId, `fg10 ${current.name} launch`);
    step('prompt admitted');
    // The record and its envelope are committed before the relay can read
    // them: the letter runs with the relay scan held at 3600 s, so the
    // tamper and the single driven scan below are the only walk the row
    // ever gets.
    await waitUntil(async () => {
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const run = childRunOf(state);
      return (
        run?.kind === 'workflow' &&
        typeof run.run?.definition?.definitionDigest === 'string'
      );
    }, 120_000);
    step('child_run record committed');
    const refusal =
      current.name === 'tampered-script-refused' ||
      current.name === 'same-length-substitution-refused';
    let tamperProof: Record<string, unknown> | undefined;
    if (refusal) {
      tamperProof = await probe<Record<string, unknown>>(
        current.sessionId,
        'tamper-envelope',
        current.name === 'tampered-script-refused'
          ? { mode: 'flip' }
          : { mode: 'substitute', script: SUBSTITUTE_SCRIPT },
      );
      console.log(
        `FG10_TAMPERED ${String(tamperProof['resourceId'])} ` +
          `${String(tamperProof['shaBefore'])} -> ${String(tamperProof['shaAfter'])}`,
      );
      step('envelope tampered');
    }
    // Exactly one scan: create the child (reads the — possibly tampered —
    // envelope) and dispatch its first Turn. Never a second scan: bind()
    // would drive an operation on the driver-held parent.
    await probe(current.sessionId, 'relay-create');
    step('relay create driven');
    // The child Turn runs to its own terminal state — refused on a digest
    // mismatch, completed on a clean launch.
    let childTurnStatus = '';
    await waitUntil(async () => {
      checkStoreProxy();
      const state = await probe<ProbeState>(current.sessionId, 'state');
      const child = state.sessions.find(
        (row) => row['parent_session_id'] === current.sessionId,
      );
      const turn = state.turns.find(
        (row) => row['session_id'] === child?.['session_id'],
      );
      childTurnStatus = String(turn?.['status'] ?? '');
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(childTurnStatus);
    }, 120_000);
    step(`child turn ${childTurnStatus}`);
    const state = await probe<ProbeState>(current.sessionId, 'state');
    const run = childRunOf(state);
    const expectedSha = sha256(scriptFor(current.name).script);
    let turnOutput: string | null = null;
    if (current.name === 'fractional-args-admitted') {
      assert.equal(
        childTurnStatus,
        'COMPLETED',
        'the fractional-args launch must complete, never wedge',
      );
      assert.equal(
        cli.output.includes('invalid_hosted_prompt'),
        false,
        'the launch never wedged on invalid_hosted_prompt',
      );
      // Not just "did not wedge": the special values must reach the
      // execution end. The child Turn's final content echoes the args —
      // parse the echo out of the Result line and compare VALUES exactly.
      // The wire rendering varies by hop (the server-side store renders
      // the subnormal as 4.9E-324, the sandbox echoes 5e-324, and the
      // canonical substrate sorts the keys) but every hop's rendering
      // parses to the identical double — so the assertion is on the
      // parsed values, never the raw text. A relay that dropped or
      // normalised the args fails this comparison.
      turnOutput = (
        await probe<{ text: string }>(current.sessionId, 'child-turn-output')
      ).text;
      const marker = 'FG10_ARGS_ECHO ';
      const resultLine = turnOutput
        .split('\n')
        .find((line) => line.includes(marker));
      assert.ok(resultLine, `the child Turn echoed its args: ${turnOutput}`);
      const echoed = JSON.parse(
        (JSON.parse(resultLine) as string).slice(marker.length),
      );
      assert.deepEqual(
        echoed,
        POSITIVE_ARGS,
        `the fractional args reached the child with exact values: ${turnOutput}`,
      );
    } else if (current.name === 'substitute-script-baseline') {
      assert.equal(
        childTurnStatus,
        'COMPLETED',
        'the substitute script launched honestly must complete',
      );
      turnOutput = (
        await probe<{ text: string }>(current.sessionId, 'child-turn-output')
      ).text;
      assert.ok(
        turnOutput.includes('FG10_SUBSTITUTED_OKAY'),
        `the substitute script really ran: ${turnOutput}`,
      );
    } else {
      assert.equal(
        childTurnStatus,
        'FAILED',
        'a tampered launch is refused by the child Turn',
      );
      assert.equal(childModelCalls, 0, 'the child spent no model call');
      assert.equal(
        await refusalNamed(cli),
        true,
        'the refusal names the digest mismatch',
      );
      // Honest, never a false success: the record never settles `settled`.
      assert.notEqual(
        run?.run?.state,
        'settled',
        'a tampered launch never settles settled',
      );
    }
    return {
      case: current.name,
      parentModelCalls,
      childModelCalls,
      childTurnStatus,
      recordState: run?.run?.state ?? null,
      stopReason: run?.stopReason ?? null,
      scriptSha256: expectedSha,
      recordDigest: run?.run?.definition?.definitionDigest ?? null,
      refusalNamed: refusal ? await refusalNamed(cli) : null,
      invalidHostedPromptSeen: cli.output.includes('invalid_hosted_prompt'),
      turnOutput,
      tamperProof: tamperProof ?? null,
    };
  } catch (cause) {
    await diagnose(cli, `modelCalls=${parentModelCalls}+${childModelCalls}`);
    throw cause;
  } finally {
    await cli.close();
  }
}

try {
  const reports = [];
  for (current of config.cases) {
    caseStart = Date.now();
    workflowCallSent = false;
    parentModelCalls = 0;
    childModelCalls = 0;
    reports.push(await runDigestCase());
    console.log(`FG10_CASE_OK ${current.name}`);
  }
  checkStoreProxy();
  await writeFile(config.resultFile, JSON.stringify(reports));
  console.log('FG10_DIGEST_GATE_OK');
} catch (cause) {
  console.error('FG10 failed at', current?.name, cause);
  throw cause;
} finally {
  await model.close();
  storeProxy.closeAllConnections();
  await new Promise<void>((resolve) => storeProxy.close(() => resolve()));
}
