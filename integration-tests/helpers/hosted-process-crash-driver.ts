/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { relayedHeaders, relayUpstream } from './hosted-relay-headers.js';
import { isLegitimateMountRelease } from './hosted-mount-release.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  sessionId: string;
  workspaceId: string;
  directory: string;
  fault: string;
  storeUrl: string;
  brokerUrl: string;
  controlUrl: string;
  harnessProxyPort?: number;
};
const settlement = config.fault === 'recovery-settlement';
type Transaction = {
  transactionId: string;
  recordBytesBase64: string;
};
const report = {
  fault: config.fault,
  promptId: randomUUID(),
  executionCallId: '',
  idempotencyKey: '',
  modelCalls: 0,
  operations: [] as string[],
  statusReads: [] as Array<{ reconcile: boolean }>,
  signalEvidence: [] as unknown[],
  restoreTransactions: [] as Transaction[],
  staleWriterConflicts: 0,
  fencedWriterRenewals: 0,
  target: undefined as Transaction | undefined,
  cancelAdmissions: 0,
  promptSubmissions: 0,
  continuationsAfterFailure: 0,
  postFailureLoads: [] as boolean[],
  postFailureCancellationLoads: 0,
  // Record non-resuming recovery modes separately from their wire origins.
  // Both modes target the original prompt; cleanup alone cannot prove takeover.
  postFailureLoadOrigins: [] as string[],
  lateCancelReplays: 0,
  originalCancelBody: '',
};
const proof = path.join(config.directory, 'proof.txt');
const inFlight = !['harness-prepare', 'harness-result'].includes(config.fault);
await writeFile(proof, 'x');
let cli = new HostedHarnessProcess();
let clientId = '';
let restoring = false;
let injected = false;
let serviceKilled = false;
let proxyFailure: unknown;
let originalCancel:
  | { path: string; headers: Record<string, string>; body: Buffer }
  | undefined;
let releaseFollowupModel!: () => void;
const followupModel = new Promise<void>((resolve) => {
  releaseFollowupModel = resolve;
});
const sealedWriters = new Set<string>();
// Writer identities (bootIds) of Harness processes this driver has SIGKILLed.
const killedWriters = new Set<string>();

function events(transaction: Transaction) {
  return Buffer.from(transaction.recordBytesBase64, 'base64')
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.subtype === 'managed_session_event_v1')
    .map((record) => record.managedSession);
}

async function control(operation: string) {
  const response = await fetch(`${config.controlUrl}/${operation}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function killHarness() {
  assert(cli.child?.pid);
  const pid = cli.child.pid;
  killedWriters.add(cli.bootId);
  const exited = once(cli.child, 'exit');
  assert(cli.child.kill('SIGKILL'));
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  report.signalEvidence.push({ process: 'harness', pid, signal });
  killedWriters.add(cli.bootId);
}

async function enteredTool() {
  await waitUntil(() => existsSync(`${proof}.read-entered`));
  assert((await lstat(proof)).isFile());
  assert.equal(await readFile(proof, 'utf8'), 'x');
  const evidence = await control('evidence');
  assert.equal(evidence.executionState, 'EXECUTING');
  assert.equal(evidence.dispatchGeneration, 1);
}

const proxy = createServer(async (req, res) => {
  try {
    const store = req.url!.startsWith('/internal/managed-session-store/');
    const url = new URL(req.url!, store ? config.storeUrl : config.brokerUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const fields = body.length
      ? JSON.parse(body.toString())
      : Object.fromEntries(url.searchParams);
    if (
      settlement &&
      !store &&
      !req.url!.startsWith('/internal/runtime-broker/')
    ) {
      const target = new URL(req.url!, cli.baseUrl);
      if (
        req.method === 'GET' &&
        target.pathname.endsWith('/events') &&
        !injected
      ) {
        await enteredTool();
        injected = true;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fixture_event_stream_rejected' }));
        return;
      }
      if (
        req.method === 'POST' &&
        target.pathname === `/session/${config.sessionId}/prompt`
      ) {
        report.promptSubmissions++;
        if (!injected) report.promptId = fields.promptId;
      }
      if (
        injected &&
        req.method === 'POST' &&
        target.pathname ===
          `/session/${config.sessionId}/managed-runtime/continue`
      )
        report.continuationsAfterFailure++;
      let postFailureLoadIndex: number | undefined;
      if (injected && target.pathname.endsWith('/load')) {
        const cancellationOnly =
          fields.cancellationTakeover === true &&
          fields.passiveManagedRuntimeRecovery === true &&
          typeof fields.cancellationPromptId === 'string' &&
          fields.cancellationPromptId === report.promptId &&
          fields.recoveryCleanupPromptId === undefined;
        const cleanupOnly =
          typeof fields.recoveryCleanupPromptId === 'string' &&
          fields.recoveryCleanupPromptId === report.promptId &&
          fields.cancellationTakeover !== true &&
          fields.passiveManagedRuntimeRecovery !== true &&
          fields.cancellationPromptId === undefined;
        const nonDriving =
          fields.driveRuntimeRecovery !== true &&
          fields.mcpManagementOnly !== true &&
          fields.lifecycleAuthority === undefined;
        postFailureLoadIndex = report.postFailureLoads.length;
        report.postFailureLoads.push(
          nonDriving && (cancellationOnly || cleanupOnly),
        );
        if (nonDriving && cancellationOnly)
          report.postFailureCancellationLoads++;
        report.postFailureLoadOrigins.push(
          [
            `takeover=${fields.cancellationTakeover === true}`,
            `passive=${fields.passiveManagedRuntimeRecovery === true}`,
            `drive=${fields.driveRuntimeRecovery === true}`,
            `mcpOnly=${fields.mcpManagementOnly === true}`,
            `promptId=${typeof fields.cancellationPromptId === 'string'}`,
            `promptMatches=${fields.cancellationPromptId === report.promptId}`,
            `cleanup=${typeof fields.recoveryCleanupPromptId === 'string'}`,
            `cleanupMatches=${fields.recoveryCleanupPromptId === report.promptId}`,
            `lifecycle=${fields.lifecycleAuthority !== undefined}`,
          ].join(' '),
        );
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter(
            ([key]) => !['host', 'content-length', 'connection'].includes(key),
          )
          .map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : value!,
          ]),
      );
      if (
        req.method === 'POST' &&
        target.pathname === `/session/${config.sessionId}/cancel` &&
        !originalCancel
      ) {
        originalCancel = { path: target.pathname, headers, body };
        report.originalCancelBody = body.toString();
      }
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      if (postFailureLoadIndex !== undefined) {
        report.postFailureLoadOrigins[postFailureLoadIndex] +=
          ` status=${upstream.status}`;
      }
      if (target.pathname.endsWith('/events') && upstream.body) {
        res.writeHead(upstream.status, relayedHeaders(upstream.headers));
        const reader = upstream.body.getReader();
        res.once('close', () => {
          void reader.cancel().catch(() => {});
        });
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          res.write(next.value);
        }
        res.end();
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (
        (target.pathname === '/session' ||
          target.pathname === `/session/${config.sessionId}/load`) &&
        upstream.ok
      )
        clientId = JSON.parse(bytes.toString()).clientId;
      if (target.pathname.endsWith('/cancel') && upstream.ok) {
        report.cancelAdmissions++;
        if (report.cancelAdmissions === 1) {
          assert.equal(
            (await json(`/session/${config.sessionId}/status`)).hasActivePrompt,
            true,
          );
          serviceKilled = true;
          const signal = await control('recovery-settlement');
          report.signalEvidence.push({ process: 'spring', ...signal });
          assert.notEqual(signal.pid, signal.newPid);
        }
      }
      relayUpstream(res, upstream, bytes);
      return;
    }
    const commit = store && url.pathname.endsWith('/transactions:commit');
    if (
      commit &&
      !restoring &&
      config.fault === 'harness-result' &&
      events(fields).some(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload.role === 'tool_result',
      )
    ) {
      assert.equal(injected, false);
      report.target = fields;
      const evidence = await control('evidence');
      assert.equal(evidence.executionState, 'SETTLED');
      assert.equal(evidence.executionStatus, 'success');
      await killHarness();
      injected = true;
      res.destroy();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value && !['host', 'connection', 'content-length'].includes(name))
        headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    if (!store) {
      const harnessScoped =
        req.method === 'POST' &&
        [
          '/internal/runtime-broker/v1/runtimes:warm',
          '/internal/runtime-broker/v1/runtimes:capabilities',
          '/internal/runtime-broker/v1/tool-sessions:active-holds',
        ].includes(url.pathname);
      assert.equal(fields.harnessSessionId, config.sessionId);
      assert.equal(
        fields.runtimeSessionId,
        harnessScoped ? undefined : report.promptId,
      );
      if (!settlement)
        assert.notEqual(
          operation,
          'release',
          'Unsettled execution must retain its owner',
        );
      if (!(harnessScoped && operation === 'active-holds'))
        report.operations.push(operation);
      if (req.method === 'GET')
        report.statusReads.push({
          reconcile: url.searchParams.get('reconcile') === 'true',
        });
      const executionId = url.pathname.match(/\/executions\/([^/:]+)/)?.[1];
      if (executionId) assert.equal(executionId, report.executionCallId);
      if (operation === 'start' && inFlight)
        await writeFile(`${proof}.read-gate`, '');
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(40_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const responseJson = upstream.headers
      .get('content-type')
      ?.includes('application/json')
      ? JSON.parse(bytes.toString())
      : undefined;
    const writerGrant = `${fields.writerId}:${fields.writerGeneration}`;
    if (
      store &&
      url.pathname.endsWith('/writers:seal') &&
      upstream.status === 200
    )
      sealedWriters.add(writerGrant);
    if (!serviceKilled) {
      if (
        upstream.status === 409 &&
        store &&
        url.pathname.endsWith('/writers:renew') &&
        (sealedWriters.has(writerGrant) ||
          (killedWriters.has(fields.writerId) &&
            fields.writerId !== cli.bootId))
      ) {
        // A renewal already in flight may reach the Store after its writer
        // sealed, or after the driver SIGKILLed the harness holding it. The
        // current boot's grant is never tolerated: catching that conflict is
        // the whole reason the fence exists.
        assert.equal(
          responseJson.error.code,
          'managed_session_writer_conflict',
          `${url}: ${bytes}`,
        );
        report.fencedWriterRenewals++;
      } else if (
        upstream.status === 409 &&
        store &&
        killedWriters.has(fields.writerId)
      ) {
        // A write the killed Harness sent before SIGKILL can be answered only
        // after the cold load's acquire bumped the writer generation; the
        // writer fence rejecting it is the designed outcome, not a failure.
        assert.equal(
          responseJson?.error?.code,
          'managed_session_writer_conflict',
          `${url}: ${bytes}`,
        );
        report.staleWriterConflicts++;
      } else if (url.pathname.endsWith(':release-mount')) {
        assert(
          isLegitimateMountRelease(upstream.status, responseJson.code),
          `${upstream.status} ${url}: ${bytes}`,
        );
      } else if (upstream.status === 409) {
        assert(
          injected &&
            !store &&
            ['status', 'cancel'].includes(operation) &&
            config.fault.startsWith('worker-'),
          `${url}: ${bytes}`,
        );
        assert.equal(responseJson.code, 'runtime_broker_execution_unknown');
      } else assert.equal(upstream.status, 200, `${url}: ${bytes}`);
    }
    if (restoring && store && url.pathname.endsWith('/transactions'))
      report.restoreTransactions.push(...responseJson.transactions);
    if (!store && operation === 'prepare') {
      assert.equal(report.executionCallId, '');
      report.executionCallId = responseJson.executionCallId;
      report.idempotencyKey = fields.idempotencyKey;
      if (config.fault === 'harness-prepare') {
        assert.equal(responseJson.status.state, 'prepared');
        const evidence = await control('evidence');
        assert.equal(evidence.executionState, 'PREPARED');
        assert.equal(evidence.dispatchGeneration, 0);
        await killHarness();
        injected = true;
        res.destroy();
        return;
      }
    }
    if (!store && operation === 'start' && inFlight && !settlement) {
      assert.equal(injected, false);
      assert.equal(responseJson.status.state, 'executing');
      await enteredTool();
      if (
        config.fault === 'harness-start' ||
        config.fault === 'harness-unknown'
      ) {
        await killHarness();
        // harness-start lets the tool settle before the takeover. The unknown
        // case keeps it in flight so the cancellation load must ask the
        // Runtime for evidence instead of re-dispatching it.
        if (config.fault === 'harness-start')
          await unlink(`${proof}.read-gate`);
        injected = true;
        res.destroy();
        return;
      }
      serviceKilled = config.fault === 'spring-kill';
      const signal = await control(config.fault);
      report.signalEvidence.push({ process: config.fault, ...signal });
      if (serviceKilled) {
        assert.notEqual(signal.pid, signal.newPid);
        config.storeUrl = signal.storeUrl;
        config.brokerUrl = signal.brokerUrl;
      }
      injected = true;
    }
    relayUpstream(res, upstream, bytes);
  } catch (cause) {
    if (!serviceKilled || !(cause instanceof TypeError)) proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) =>
  proxy.listen(config.harnessProxyPort ?? 0, '127.0.0.1', resolve),
);
const address = proxy.address();
assert(address && typeof address !== 'string');
const proxyUrl = `http://127.0.0.1:${address.port}`;
const model = await startFakeOpenAIServer(async () => {
  report.modelCalls++;
  if (report.modelCalls > 1) {
    if (settlement) await followupModel;
    return { content: settlement ? 'FOLLOW_UP_OK' : 'UNEXPECTED_CONTINUATION' };
  }
  return {
    toolCalls: [
      fakeToolCall(
        'edit',
        {
          file_path: 'proof.txt',
          old_string: 'x',
          new_string: 'xx',
          replace_all: true,
        },
        'effect',
      ),
    ],
  };
});

async function json(route: string, body?: unknown, expected = 200) {
  if (proxyFailure) throw proxyFailure;
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...cli.headers(clientId),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text + cli.output);
  if (proxyFailure) throw proxyFailure;
  return text ? JSON.parse(text) : undefined;
}

function connection() {
  return {
    managedSessionStore: {
      baseUrl: proxyUrl,
      tenantId: config.tenantId,
      workspaceId: config.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 5_000,
    },
    toolProfile: 'hosted-workspace-files/1',
  };
}

async function start() {
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  await writeFile(path.join(cli.root, 'proof.txt'), 'decoy');
}

async function assertEffect() {
  assert((await lstat(proof)).isFile());
  assert.equal(
    await readFile(proof, 'utf8'),
    ['harness-start', 'harness-result', 'harness-unknown'].includes(
      config.fault,
    )
      ? 'xx'
      : 'x',
  );
  assert.equal(
    await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
    'decoy',
  );
}

async function runExistingCase() {
  const boot = cli.bootId;
  const route = `/session/${config.sessionId}`;
  const created = await json('/session', {
    ...connection(),
    sessionId: config.sessionId,
    sessionScope: 'thread',
  });
  clientId = created.clientId;
  const prompt = [{ type: 'text', text: config.fault }];
  await json(
    `${route}/prompt`,
    {
      promptId: report.promptId,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    },
    202,
  );
  await waitUntil(() => {
    if (proxyFailure) throw proxyFailure;
    return injected;
  }, 60_000);
  if (config.fault === 'harness-start')
    await waitUntil(
      async () => (await control('evidence')).executionState === 'SETTLED',
    );
  if (!config.fault.startsWith('harness-')) {
    await waitUntil(
      async () => !(await json(`${route}/status`)).hasActivePrompt,
      90_000,
    );
    assert.equal((await json(`${route}/status`)).recoveryBlocked, true);
    let cursor = '0';
    while (true) {
      const response = await cli.request(
        `${route}/transcript?cursor=${cursor}&limit=256`,
        { headers: cli.headers(clientId) },
      );
      const text = await response.text();
      if (proxyFailure) throw proxyFailure;
      if (response.status === 503) {
        assert.equal(config.fault, 'spring-kill', text);
        assert.equal(JSON.parse(text).error, 'managed_transcript_unavailable');
        console.log(
          'FG6C spring-kill: live transcript unavailable after restart',
        );
        break;
      }
      assert.equal(response.status, 200, text + cli.output);
      const page = JSON.parse(text);
      assert.equal(
        page.events.filter((event: { type: string }) =>
          event.type.startsWith('turn_'),
        ).length,
        0,
      );
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    await killHarness();
  }
  // harness-unknown holds the tool at its read gate until the cancellation
  // load has asked the Runtime; its effect is asserted after that release.
  if (config.fault !== 'harness-unknown') await assertEffect();
  assert.equal(report.modelCalls, 1);
  for (const [operation, count] of [
    ['acquire', 1],
    ['prepare', 1],
    ['start', config.fault === 'harness-prepare' ? 0 : 1],
  ] as const)
    assert.equal(
      report.operations.filter((value) => value === operation).length,
      count,
    );
  await cli.close();
  const leaseDeadline = Date.now() + 5_100;
  await waitUntil(() => Date.now() >= leaseDeadline);
  cli = new HostedHarnessProcess();
  await start();
  assert.notEqual(cli.bootId, boot);
  restoring = true;
  const unknown = config.fault === 'harness-unknown';
  const operations = report.operations.length;
  // A plain load refuses a Turn whose file history is still pending; the
  // takeover flag routes it through the cancellation recovery load, where
  // decision 9 asks the Broker for evidence.
  const loaded = await json(
    `${route}/load`,
    unknown
      ? { ...connection(), passiveManagedRuntimeRecovery: true }
      : connection(),
    unknown ? 200 : 409,
  );
  if (unknown) {
    const executions =
      loaded._meta['qwen.daemon.managedRuntimeRecovery'].executions;
    assert.equal(executions.length, 1);
    assert.equal(executions[0].outcome, 'known');
    assert.equal(executions[0].status.state, 'executing');
  } else {
    assert.equal(loaded.error, 'hosted_turn_recovery_required');
    assert(report.restoreTransactions.length > 0);
    const restored = report.restoreTransactions.flatMap(events);
    assert.equal(
      restored.filter(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload.turnId === report.promptId,
      ).length,
      1,
    );
    assert.equal(
      restored.filter((event) => event.kind === 'turn.settled').length,
      0,
    );
    assert.equal(
      restored.filter(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload.role === 'tool_result',
      ).length,
      0,
    );
  }
  if (unknown) {
    // Re-attaching and reading status are not dispatches; a parked tool must
    // never be started a second time.
    assert.equal(
      report.operations.filter((value) => value === 'start').length,
      config.fault === 'harness-prepare' ? 0 : 1,
      'Cold load must not re-dispatch the parked tool',
    );
    assert(
      report.statusReads.some((read) => read.reconcile),
      'the cancellation load asks the Runtime about the parked execution once',
    );
    await unlink(`${proof}.read-gate`);
    await waitUntil(
      async () => (await control('evidence')).executionState === 'SETTLED',
      60_000,
    );
  } else {
    assert.equal(
      report.operations.length,
      operations,
      'Cold load must not execute Broker operations',
    );
  }
  assert.equal(report.modelCalls, 1, 'Cold load must not call the model');
  await assertEffect();
  if (proxyFailure) throw proxyFailure;
  await writeFile(`${configPath}.results`, JSON.stringify(report));
  console.log(
    `FG6C ${config.fault}: execution=${report.executionCallId}, signals=${JSON.stringify(report.signalEvidence)}, cold=blocked, statusReads=${JSON.stringify(report.statusReads)}`,
  );
  console.log('HOSTED_PROCESS_CRASH_OK');
}

async function runRecoverySettlement() {
  async function api(route: string, body?: object, expected = 200) {
    if (proxyFailure) throw proxyFailure;
    const response = await fetch(config.storeUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Qwen-Tenant-Id': config.tenantId,
        'X-Qwen-Actor-Id': 'actor',
        'Idempotency-Key': randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${route}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
  const route = `/v1/agents/sessions/${config.sessionId}`;
  const turn = await api(
    `${route}/events`,
    {
      type: 'agent.session.input.message',
      input: [{ type: 'input_text', text: 'RECOVERY_SETTLEMENT' }],
    },
    202,
  );
  await waitUntil(() => {
    if (proxyFailure) throw proxyFailure;
    return report.signalEvidence.length === 1;
  }, 60_000);
  await api(`${route}/recovery/recheck`, { turnId: turn.turn_id }, 202);
  await waitUntil(() => report.cancelAdmissions >= 2, 30_000);
  assert.equal(
    (await json(`/session/${config.sessionId}/status`)).hasActivePrompt,
    true,
  );
  await control('recovery-pending');
  assert.equal(report.modelCalls, 1);
  assert.equal(report.promptSubmissions, 1);
  assert.equal(report.continuationsAfterFailure, 0);
  assert(
    report.postFailureLoads.length > 0,
    `no post-failure loads were recorded at all: ${JSON.stringify(report.postFailureLoadOrigins)}`,
  );
  assert(
    report.postFailureCancellationLoads > 0,
    'replacement must use a targeted cancellation takeover load',
  );
  assert(
    report.postFailureLoads.every(Boolean),
    `replacement must use targeted cancellation or cleanup-only loads: ${report.postFailureLoadOrigins.join(' | ')}`,
  );
  await unlink(`${proof}.read-gate`);
  await waitUntil(async () => {
    await api(`${route}/recovery/recheck`, { turnId: turn.turn_id }, 202);
    return (await api(`${route}/turns/${turn.turn_id}`)).status === 'cancelled';
  }, 60_000);
  await waitUntil(
    async () => (await api(`${route}/recovery`)).nextTurnAllowed === true,
    30_000,
  );
  assert.equal(
    report.modelCalls,
    1,
    'settling cancellation must not continue the original model',
  );
  assert.equal(report.promptSubmissions, 1);
  const followup = await api(
    `${route}/events`,
    {
      type: 'agent.session.input.message',
      input: [{ type: 'input_text', text: 'FOLLOW_UP' }],
    },
    202,
  );
  await waitUntil(() => report.modelCalls === 2);
  assert.equal(
    (await json(`/session/${config.sessionId}/status`)).hasActivePrompt,
    true,
  );
  assert(
    originalCancel,
    'the original input cancellation must have been captured',
  );
  const delayedCancel = await fetch(new URL(originalCancel.path, cli.baseUrl), {
    method: 'POST',
    headers: originalCancel.headers,
    body: originalCancel.body,
  });
  assert.equal(delayedCancel.status, 204, await delayedCancel.text());
  report.lateCancelReplays++;
  releaseFollowupModel();
  await waitUntil(async () => {
    const status = (await api(`${route}/turns/${followup.turn_id}`)).status;
    assert.notEqual(
      status,
      'cancelled',
      'a late original-input cancellation must not cancel the follow-up Turn',
    );
    return status === 'completed';
  }, 30_000);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.promptSubmissions, 2);
  assert.equal(
    JSON.parse(report.originalCancelBody || '{}').promptId,
    report.promptId,
  );
  await waitUntil(async () =>
    JSON.stringify(await api(`${route}/items?limit=100`)).includes(
      'FOLLOW_UP_OK',
    ),
  );
  assert.equal(
    report.operations.filter((operation) => operation === 'start').length,
    1,
  );
  assert.equal(
    report.operations.filter((operation) => operation === 'prepare').length,
    1,
  );
  if (proxyFailure) throw proxyFailure;
  await writeFile(`${configPath}.results`, JSON.stringify(report));
  console.log(
    `FG6C recovery-settlement: execution=${report.executionCallId}, signals=${JSON.stringify(report.signalEvidence)}, cancellations=${report.cancelAdmissions}, submissions=${report.promptSubmissions}, models=${report.modelCalls}, continuations=${report.continuationsAfterFailure}`,
  );
  console.log(
    'HOSTED_PROCESS_CRASH_OK recovery-settlement marker=durable native=running restart=cancel-only toolStarts=1 followup=completed staleCancel=ignored',
  );
}

try {
  await start();
  if (settlement) await runRecoverySettlement();
  else await runExistingCase();
} catch (cause) {
  console.error(`FG6C ${config.fault}`, JSON.stringify(report), cli.output);
  throw cause;
} finally {
  releaseFollowupModel();
  // The parent owns worker cleanup; do not unblock an uncertain Edit.
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
