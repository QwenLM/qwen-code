/** Real SQL/HTTP/file acceptance with explicitly mapped placement and mount provenance. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = process.cwd();
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const output = process.argv[3];
process.env.QWEN_HOME = path.join(output, 'home');
process.env.QWEN_RUNTIME_DIR = path.join(output, 'runtime');
const key = input.sessionKey;
const core = (name) =>
  pathToFileURL(`${root}/packages/core/dist/src/${name}.js`).href;
const cli = (name) =>
  pathToFileURL(`${root}/packages/cli/dist/src/serve/${name}.js`).href;
const { createHttpManagedSessionStores } = await import(
  core('managed-runtime/http-managed-session-store')
);
const { openManagedSession } = await import(
  core('managed-runtime/managed-session-assembly')
);
const { createManagedHarnessHandle } = await import(
  core('managed-runtime/managed-harness-factory')
);
const { ManagedHookActivationController } = await import(
  core('managed-runtime/managed-hook-activation')
);
const { TurnBudget } = await import(core('core/turn-budget'));
const { managedToolDigest, managedToolResponseParts } = await import(
  core('tools/managed-tool-protocol')
);
const { convertToFunctionResponse } = await import(
  core('core/coreToolScheduler')
);
const { ManagedCsiMount } = await import(cli('managed-csi-mount'));
const { ManagedCsiRootDirectory } = await import(
  cli('managed-csi-root-directory')
);
const { startManagedCsiFileWorker } = await import(
  cli('managed-csi-file-worker')
);
const { computeManagedContextDigest } = await import(
  cli('managed-workspace-binding')
);

const headers = {
  authorization: `Bearer ${input.operatorToken}`,
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
const checks = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function post(
  origin,
  route,
  body,
  supplied = headers,
  expected = 200,
  label = route,
) {
  const response = await fetch(new URL(route, origin), {
    method: 'POST',
    headers: supplied,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const answer = await response.json();
  assert.equal(
    response.status,
    expected,
    `${label} (${route}): ${JSON.stringify(answer)}`,
  );
  return answer;
}
const fixture = (route, body = {}) => post(input.adapter, route, body);
const broker = (route, body = {}) =>
  post(input.broker, `/internal/runtime-broker/v1${route}`, {
    protocolVersion: 1,
    requestId: randomUUID(),
    harnessSessionId: key.sessionId,
    runtimeSessionId: key.sessionId,
    ...body,
  });

// This platform facade delegates all file operations to real handles/inodes.
// It does not intercept authentication, SQL native fetch, composition, tools or results.
const native = Object.fromEntries(
  ['open', 'lstat', 'mkdir', 'readdir', 'unlink'].map((name) => [
    name,
    fs[name],
  ]),
);
const actualPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const workspace = await fs.realpath(
  await fs.mkdtemp(path.join(output, 'workspace-')),
);
const rootHandle = await native.open(
  workspace,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
);
const stats = await rootHandle.stat({ bigint: true });
const dev = stats.dev;
const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
const mount = {
  mountId: '9',
  device: `${major}:${minor}`,
  source: '/dev/nvme1n1',
  diskSerial: 'owned-serial',
  rootDevice: dev.toString(),
  rootInode: stats.ino.toString(),
};
const handles = new Map([[rootHandle.fd, workspace]]);
const opened = new Set();
// Translate unconditionally, as managed-csi-mount.test.ts does: this fixture
// fakes the mount, so the owned descriptors are the ones in `handles` whether
// or not the host really exposes /proc/self/fd.
const mappedAddress = (file) => {
  if (process.platform !== 'linux' || typeof file !== 'string') return file;
  const matched = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(file);
  if (!matched) return file;
  const address = handles.get(Number(matched[1]));
  assert.ok(address, 'Unknown owned proc-fd address');
  return matched[2] ? path.join(address, matched[2]) : address;
};
const originalMount = Object.getOwnPropertyDescriptors(
  ManagedCsiMount.prototype,
);
const originalRootDirectoryOpen = Object.getOwnPropertyDescriptor(
  ManagedCsiRootDirectory,
  'open',
);
const nativeRootDirectory = ManagedCsiMount.prototype.rootDirectory;
const nativeListen = Server.prototype.listen;
let retirementJoined = false;
let worker, stores, session;
try {
  await fs.writeFile(path.join(workspace, 'marker.txt'), 'alpha\n', {
    mode: 0o640,
  });
  const { boot, pod } = await fixture('/fixture:setup', { mount });
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
  });
  for (const name of ['open', 'lstat', 'mkdir', 'readdir', 'unlink']) {
    fs[name] = async (file, ...args) => {
      const address = mappedAddress(file);
      const result = await native[name](address, ...args);
      if (name === 'open') {
        handles.set(result.fd, String(address));
        opened.add(result);
        const close = result.close.bind(result);
        const fd = result.fd;
        result.close = async () => {
          await close();
          handles.delete(fd);
          opened.delete(result);
        };
      }
      return result;
    };
  }
  ManagedCsiMount.prototype.kernelObservation = async () => ({
    mountId: mount.mountId,
    device: mount.device,
    source: mount.source,
  });
  ManagedCsiRootDirectory.open = async (mountRoot, device) => {
    assert.equal(mountRoot, boot.context.mountRoot);
    return originalRootDirectoryOpen.value.call(
      ManagedCsiRootDirectory,
      workspace,
      device,
    );
  };
  ManagedCsiMount.prototype.rootDirectory = async function () {
    const directory = await nativeRootDirectory.call(this);
    if (directory === undefined) return undefined;
    assert.equal(directory, boot.context.mountRoot);
    return workspace;
  };
  Server.prototype.listen = function () {
    return Reflect.apply(nativeListen, this, [0, '127.0.0.1']);
  };
  process.env.QWEN_POD_UID = pod.uid;
  process.env.QWEN_POD_NAMESPACE = pod.namespace;
  process.env.QWEN_NODE_NAME = pod.nodeName;
  worker = await startManagedCsiFileWorker(boot);
  Server.prototype.listen = nativeListen;
  await fixture('/fixture:worker', { url: worker.ready.context.url });
  await broker('/tool-sessions:acquire', { turnKind: 'bootstrap' });
  const writerId = randomUUID();
  const writerToken = randomBytes(32).toString('base64url');
  let originalReceiptRequest;
  let coldRefusalChecks = 0;
  stores = createHttpManagedSessionStores({
    baseUrl: input.adapter,
    sessionKey: key,
    writerId,
    writerToken,
    leaseDurationMs: input.coldRecovery ? 10000 : 300000,
    requestTimeoutMs: 20000,
    ...(input.coldRecovery
      ? {
          fetchFn: async (url, options) => {
            const response = await fetch(url, options);
            if (
              response.ok &&
              /\/transactions:commit(?:-v2)?$/u.test(new URL(url).pathname) &&
              JSON.parse(options.body).operation === 'recordToolResult'
            )
              originalReceiptRequest = { url, options };
            return response;
          },
        }
      : {}),
  });
  const definitionRef = await stores.resourceStore.publish(
    'managed-definition',
    Buffer.from(
      JSON.stringify({
        engine: 'managed',
        sessionId: key.sessionId,
        toolProfile: 'csi-files-retirement/1',
      }),
    ),
  );
  const rootSnapshotRef = await stores.resourceStore.publish(
    'managed-root',
    Buffer.from(JSON.stringify({ cwd: '/workspace' })),
  );
  session = await openManagedSession({
    runtimeBaseDir: output,
    transcriptPath: '',
    sessionId: key.sessionId,
    sessionKey: key,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    workerId: writerId,
    activationLeaseDurationMs: input.coldRecovery ? 10000 : 300000,
    journalStore: stores.journalStore,
    resourceStore: stores.resourceStore,
    requireNew: true,
    create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
  });
  const initialActivation = { ...session.activation };
  let expectedActivation = initialActivation;
  const control = async (action, extra = {}) =>
    (
      await broker(`/tool-sessions/${key.sessionId}/control`, {
        operation: { kind: 'csi-file-history', version: 1, action, ...extra },
      })
    ).result.observation;
  let observation = await control('bind');
  let parent = null;
  const record = (type, fields = {}) => ({
    uuid: randomUUID(),
    parentUuid: parent,
    sessionId: key.sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    ...fields,
  });
  const actor = { class: 'harness', activation: session.activation };
  async function history(commandId, preparation, value) {
    const digestContent = {
      schemaVersion: 2,
      profile: 'csi-files-retirement/1',
      runtimeSessionId: key.sessionId,
      ...value,
      preparation,
    };
    const content = {
      ...digestContent,
      record: record('system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: value.state.snapshots },
      }),
    };
    return session.authority.commitDomainRecord(
      {
        operation: 'commitFileHistory',
        commandId,
        sessionKey: key,
        contentDigest: managedToolDigest(digestContent),
      },
      { domain: 'file_history', content },
      { class: 'trusted_entry' },
    );
  }
  const bound = await history(
    `csi-file-history:bind:${key.sessionId}`,
    null,
    observation,
  );
  const resourceUrl = new URL(
    `/internal/managed-session-store/v1/sessions/${key.sessionId}/resources/${bound.recordRef.resourceId}`,
    input.adapter,
  );
  resourceUrl.searchParams.set('workspaceId', key.workspaceId);
  const resourceResponse = await fetch(resourceUrl, {
    headers: { 'X-Qwen-Managed-Writer-Token': writerToken },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(resourceResponse.status, 200);
  assert.equal(resourceResponse.headers.get('cache-control'), 'no-store');
  assert.equal(
    hash(Buffer.from(await resourceResponse.arrayBuffer())),
    bound.recordRef.digest,
  );
  await createManagedHarnessHandle(session).ensureCheckpoint();
  const declarations = JSON.parse(
    await fs.readFile(path.join(output, 'declarations.json'), 'utf8'),
  );
  const usage = [
    {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      thoughtsTokenCount: 0,
      totalTokenCount: 2,
      cachedContentTokenCount: 0,
    },
  ];
  const invocations = [];
  let firstPins;
  let completedTurns = 0;
  for (const [index, mutation] of [
    {
      name: 'write_file',
      args: { file_path: 'marker.txt', content: 'beta\n' },
    },
    {
      name: 'edit',
      args: {
        file_path: 'marker.txt',
        old_string: 'beta',
        new_string: 'gamma',
      },
    },
  ].entries()) {
    const promptId = randomUUID();
    const prompt = `owned file turn ${index + 1}`;
    const bytes = Buffer.from(JSON.stringify([{ type: 'text', text: prompt }]));
    const digest = hash(bytes);
    const contentRef = await session.resources.publish('managed-input', bytes);
    const admissionRef = await session.resources.publish(
      'managed-admission',
      Buffer.from(JSON.stringify({ promptId, digest: `sha256:${digest}` })),
    );
    await session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: promptId,
        sessionKey: key,
        contentDigest: digest,
      },
      {
        inputId: promptId,
        turnId: promptId,
        source: 'hosted-harness',
        contentRef,
        admissionRef,
        deadline: null,
        wakeReason: 'input',
      },
    );
    if (input.hostedProducer) {
      const { runHostedFileTurn } = await import('./csi-hosted-file-turns.mjs');
      const actual = await runHostedFileTurn({
        root,
        output,
        session,
        promptId,
        prompt,
        index,
        mutation,
        recoveryCut: input.recoveryCut,
        files: {
          broker: { baseUrl: input.broker, token: input.operatorToken },
          runtime: input.runtime,
        },
        ...(input.coldRecovery && index === 0
          ? {
              recover: async () => {
                assert.ok(
                  originalReceiptRequest,
                  'Capture an actual old-writer receipt transaction',
                );
                const originalExecutions = (await fixture('/fixture:inspect'))
                  .executions;
                const working = await fs.readFile(
                  path.join(workspace, 'marker.txt'),
                );
                await assert.rejects(
                  session.close({ releaseActivation: false }),
                  (error) =>
                    [
                      'csi_finalize_required',
                      'csi_managed_mutation_unavailable',
                    ].includes(error.remoteCode),
                );
                await stores.stopLocal();
                session = undefined;
                stores = undefined;
                const storeHeaders = {
                  ...headers,
                  'X-Qwen-Managed-Writer-Token': writerToken,
                  'X-Qwen-Tenant-Id': key.tenantId,
                };
                const prefix = `/internal/managed-session-store/v1/sessions/${key.sessionId}`;
                const beforeLive = await fixture('/fixture:image');
                await post(
                  input.adapter,
                  `${prefix}/writers:acquire`,
                  {
                    workspaceId: key.workspaceId,
                    writerId: randomUUID(),
                    leaseMillis: 1000,
                  },
                  storeHeaders,
                  409,
                  'Live original writer must refuse replacement',
                );
                assert.deepEqual(await fixture('/fixture:image'), beforeLive);
                coldRefusalChecks++;
                const waitForExpiry = async () => {
                  const deadline = Date.now() + 30000;
                  for (;;) {
                    const lease = await fixture('/fixture:leases');
                    if (
                      lease.databaseNow >=
                      Math.max(
                        lease.writerLeaseUntil,
                        lease.activationExpiresAt,
                      )
                    )
                      break;
                    assert.ok(
                      Date.now() < deadline,
                      'Original leases must expire naturally',
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                };
                await waitForExpiry();
                const refused = await fixture('/fixture:cold-refusals', {
                  writerToken,
                });
                assert.equal(refused.refusals, 4);
                coldRefusalChecks += refused.refusals;
                const abandonedWriter = randomUUID();
                const abandoned = await post(
                  input.adapter,
                  `${prefix}/writers:acquire`,
                  {
                    workspaceId: key.workspaceId,
                    writerId: abandonedWriter,
                    leaseMillis: 1000,
                  },
                  storeHeaders,
                );
                assert.equal(abandoned.writerGeneration, 2);
                assert.equal(abandoned.activationEpoch, 1);
                const beforeUninstalled = await fixture('/fixture:image');
                await post(
                  input.adapter,
                  '/fixture:publication',
                  {
                    writerId: abandonedWriter,
                    writerGeneration: 2,
                    writerToken,
                  },
                  storeHeaders,
                  409,
                  'Uninstalled writer cannot publish',
                );
                assert.deepEqual(
                  await fixture('/fixture:image'),
                  beforeUninstalled,
                );
                coldRefusalChecks++;
                await waitForExpiry();
                let successorWriter = randomUUID();
                if (input.isolation) {
                  const writers = [successorWriter, randomUUID()];
                  await fixture('/fixture:cold-arm', { writers });
                  const pending = writers.map(async (candidate) => {
                    const response = await fetch(
                      `${input.adapter}${prefix}/writers:acquire`,
                      {
                        method: 'POST',
                        headers: storeHeaders,
                        signal: AbortSignal.timeout(20000),
                        body: JSON.stringify({
                          workspaceId: key.workspaceId,
                          writerId: candidate,
                          leaseMillis: 300000,
                        }),
                      },
                    );
                    return {
                      writerId: candidate,
                      status: response.status,
                      body: await response.json(),
                    };
                  });
                  const contention = await fixture('/fixture:cold-release');
                  const responses = await Promise.all(pending);
                  assert.deepEqual(
                    responses.map((response) => response.status).sort(),
                    [200, 409],
                  );
                  const winner = responses.find(
                    (response) => response.status === 200,
                  );
                  successorWriter = winner.writerId;
                  assert.equal(winner.body.writerGeneration, 3);
                  assert.equal(winner.body.activationEpoch, 1);
                  const warmed = Object.values(contention.warmed);
                  assert.equal(warmed.length, 2);
                  assert.ok(
                    warmed.every(
                      (entry) =>
                        entry.isolation === input.isolation &&
                        entry.autoCommit === false &&
                        entry.writerGeneration === 2,
                    ),
                  );
                  await fs.writeFile(
                    path.join(output, 'cold-contention.json'),
                    JSON.stringify({ contention, responses }, null, 2),
                  );
                }
                stores = createHttpManagedSessionStores({
                  baseUrl: input.adapter,
                  sessionKey: key,
                  writerId: successorWriter,
                  writerToken,
                  leaseDurationMs: 300000,
                  requestTimeoutMs: 20000,
                });
                session = await openManagedSession({
                  runtimeBaseDir: output,
                  transcriptPath: '',
                  sessionId: key.sessionId,
                  sessionKey: key,
                  cwd: '/workspace',
                  version: 'hosted-harness/1',
                  workerId: successorWriter,
                  activationLeaseDurationMs: 300000,
                  journalStore: stores.journalStore,
                  resourceStore: stores.resourceStore,
                });
                assert.equal(
                  (await stores.publication.owner()).writerGeneration,
                  3,
                );
                assert.equal(session.activation.epoch, 2);
                expectedActivation = { ...session.activation };
                const beforeStale = await fixture('/fixture:image');
                const replay = await fetch(originalReceiptRequest.url, {
                  ...originalReceiptRequest.options,
                  signal: AbortSignal.timeout(20000),
                });
                assert.equal(replay.status, 409);
                await replay.arrayBuffer();
                await post(
                  input.adapter,
                  `${prefix}/writers:renew`,
                  {
                    workspaceId: key.workspaceId,
                    writerId,
                    writerGeneration: 1,
                    leaseMillis: 10000,
                  },
                  storeHeaders,
                  409,
                  'Original writer cannot renew after takeover',
                );
                await post(
                  input.adapter,
                  '/fixture:publication',
                  {
                    writerId,
                    writerGeneration: 1,
                    writerToken,
                  },
                  storeHeaders,
                  409,
                  'Original writer cannot publish after takeover',
                );
                assert.deepEqual(await fixture('/fixture:image'), beforeStale);
                coldRefusalChecks += 3;
                const { recoverHostedCsiReceipts } = await import(
                  cli('hosted-csi-cold-recovery')
                );
                const recovered = await recoverHostedCsiReceipts(
                  session,
                  { baseUrl: input.broker, token: input.operatorToken },
                  promptId,
                  prompt,
                  {
                    ...input.runtime,
                    ...(await stores.publication.owner()),
                    activationId: session.activation.activationId,
                    activationEpoch: session.activation.epoch,
                  },
                );
                assert.deepEqual(
                  (await fixture('/fixture:inspect')).executions,
                  originalExecutions,
                );
                assert.deepEqual(
                  await fs.readFile(path.join(workspace, 'marker.txt')),
                  working,
                );
                return { session, ...recovered };
              },
            }
          : {}),
      });
      invocations.push(...actual);
      observation = await control('snapshot');
      assert.deepEqual(session.activation, expectedActivation);
      if (index === 0) firstPins = structuredClone(observation.retainedBackups);
      else
        for (const pin of firstPins)
          assert.deepEqual(
            observation.retainedBackups.find(
              (current) => current.name === pin.name,
            ),
            pin,
          );
      const issued = await fixture('/fixture:inspect');
      const grant = issued.executions
        .filter((row) => row.native_authorization_json)
        .map((row) => JSON.parse(row.native_authorization_json))
        .at(-1);
      assert.ok(grant, 'Hosted execution must mint a native SQL grant');
      const request = {
        protocolVersion: 1,
        requestId: randomUUID(),
        action: 'execute',
        subject: grant.executionCallId,
        identity: grant.identity,
        context: grant.context,
        installedContext: grant.installedContext,
      };
      const workerHeaders = {
        ...headers,
        authorization: `Bearer ${boot.context.token}`,
        'x-qwen-managed-lease-id': boot.context.leaseId,
        'x-qwen-managed-lease-epoch': String(boot.context.epoch),
      };
      const workingBefore = await fs.readFile(
        path.join(workspace, 'marker.txt'),
      );
      for (const [name, override, code] of [
        ['Hosted wrong token', { authorization: 'Bearer foreign' }, 401],
        ['Hosted wrong lease', { 'x-qwen-managed-lease-epoch': '99' }, 409],
      ]) {
        await post(
          worker.ready.context.url,
          '/internal/managed-runtime/csi/v2/execute',
          request,
          { ...workerHeaders, ...override },
          code,
          name,
        );
        assert.deepEqual(
          await fs.readFile(path.join(workspace, 'marker.txt')),
          workingBefore,
          name,
        );
        assert.deepEqual(await fixture('/fixture:inspect'), issued, name);
        checks.push(name);
      }
      completedTurns++;
      continue;
    }
    const harness = createManagedHarnessHandle(session);
    await new ManagedHookActivationController(session).runTurn(
      promptId,
      async (scope) =>
        harness.run(async () => {
          const user = record('user', {
            daemonPromptId: promptId,
            message: { role: 'user', parts: [{ text: prompt }] },
          });
          await session.sink.write(user);
          parent = user.uuid;
          await scope.bindBudget(new TurnBudget(), prompt);
          const complete = await scope.beginMainAttempt('owned-model');
          await complete(true, usage);
          const functions = [
            {
              id: `owned-read-${index}`,
              name: 'read_file',
              args: { file_path: 'marker.txt' },
            },
            { id: `owned-mutate-${index}`, ...mutation },
          ];
          const assistant = record('assistant', {
            daemonPromptId: promptId,
            model: 'owned-model',
            message: {
              role: 'model',
              parts: [
                { text: 'owned tool batch' },
                ...functions.map((functionCall) => ({ functionCall })),
              ],
            },
          });
          await session.sink.write(assistant);
          parent = assistant.uuid;
          const batchId = assistant.uuid;
          const members = [];
          for (const [ordinal, fc] of functions.entries()) {
            const payloadJson = JSON.stringify({
              toolName: fc.name,
              input: fc.args,
            });
            const inputBytes = Buffer.from(
              JSON.stringify({
                harnessSessionId: key.sessionId,
                runtimeSessionId: key.sessionId,
                payloadJson,
              }),
            );
            const definitionBytes = Buffer.from(
              JSON.stringify(
                declarations.find((value) => value.name === fc.name),
              ),
            );
            const inputRef = await session.resources.publish(
              'managed-tool-input',
              inputBytes,
            );
            const toolDefinitionRef = await session.resources.publish(
              'managed-tool-definition',
              definitionBytes,
            );
            const reference = {
              sessionId: key.sessionId,
              promptId,
              callId: randomUUID(),
              argsDigest: `sha256:${hash(payloadJson)}`,
              batchId,
              functionCallId: fc.id,
              ordinal,
              partIndex: ordinal + 1,
              inputRef,
              toolDefinitionRef,
            };
            const request = {
              idempotencyKey: `${key.sessionId}:${reference.callId}`,
              turnId: promptId,
              toolCallId: reference.callId,
              requestDigest: reference.argsDigest,
              reference,
              inputBytesBase64: inputBytes.toString('base64'),
              toolDefinitionBytesBase64: definitionBytes.toString('base64'),
            };
            const prepared = await broker('/executions:prepare', request);
            const repeated = await broker('/executions:prepare', request);
            assert.equal(repeated.executionCallId, prepared.executionCallId);
            members.push({
              executionCallId: prepared.executionCallId,
              reference,
              fc,
              payloadJson,
            });
          }
          const preparation = {
            stage: 'intent',
            turnId: promptId,
            promptId,
            batchId,
            invocations: members.map(({ executionCallId, reference, fc }) => ({
              executionCallId,
              callId: reference.callId,
              functionCallId: fc.id,
              toolName: fc.name,
              partIndex: reference.partIndex,
              ordinal: reference.ordinal,
              requestDigest: reference.argsDigest,
              inputRef: reference.inputRef,
              toolDefinitionRef: reference.toolDefinitionRef,
            })),
            paths: ['marker.txt'],
          };
          const intent = await history(
            `csi-file-history:intent:${batchId}`,
            preparation,
            observation,
          );
          observation = await control('prepare', {
            preparationRef: intent.recordRef,
          });
          await history(
            `csi-file-history:prepared:${batchId}`,
            { ...preparation, stage: 'prepared', intentRef: intent.recordRef },
            observation,
          );
          for (const member of members) {
            const { executionCallId, reference } = member;
            await session.authority.appendExecutionEvent(
              {
                operation: 'toolIntent',
                commandId: `tool-intent:${executionCallId}`,
                sessionKey: key,
                contentDigest: reference.inputRef.digest,
              },
              (sequence) => ({
                v: 1,
                sequence,
                eventId: `tool-intent:${executionCallId}`,
                sessionKey: key,
                kind: 'tool.intent',
                occurredAt: Date.now(),
                subject: {
                  type: 'activation',
                  scopeId: session.activation.activationId,
                  ...session.activation,
                },
                payload: {
                  executionCallId,
                  batchId,
                  ordinal: reference.ordinal,
                  toolDefinitionRef: reference.toolDefinitionRef,
                  argsRef: reference.inputRef,
                  outcomeSource: 'runtime',
                },
              }),
              actor,
            );
          }
          await harness.commitAwaitRuntimeBatch(
            members.map(({ executionCallId, reference, fc }) => ({
              executionCallId,
              functionCallId: fc.id,
              toolName: fc.name,
              invocationBindingId: executionCallId,
              capabilityVersion: boot.identity.capabilityDigest,
              policyVersion: 'csi-files-retirement-policy/1',
              mediaVersion: null,
              modelMessageId: batchId,
              partIndex: reference.partIndex,
              ordinal: reference.ordinal,
              inputDigest: reference.argsDigest.slice(7),
              progressCursor: null,
              attemptId: batchId,
              routeRef: members[0].reference.inputRef,
            })),
            { turnId: promptId, promptId },
          );
          for (const member of members) {
            const { executionCallId, payloadJson, fc } = member;
            // Use the production native request returned by SQL grant for all post-dispatch comparisons.
            const before = await fixture('/fixture:inspect');
            assert.ok(
              before.executions.every(
                (row) =>
                  row.native_authorization_json === null ||
                  typeof row.native_authorization_json === 'string',
              ),
            );
            const started = await broker(
              `/executions/${executionCallId}:start`,
              { payloadJson },
            );
            let status = started.status;
            const deadline = Date.now() + 20000;
            while (status.state !== 'settled' && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 30));
              const url = new URL(
                `/internal/runtime-broker/v1/executions/${executionCallId}`,
                input.broker,
              );
              for (const [name, value] of Object.entries({
                requestId: randomUUID(),
                harnessSessionId: key.sessionId,
                runtimeSessionId: key.sessionId,
              }))
                url.searchParams.set(name, value);
              const response = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(20000),
              });
              assert.equal(response.status, 200);
              status = (await response.json()).status;
            }
            assert.equal(status.state, 'settled', JSON.stringify(status));
            assert.equal(
              status.result.executionStatus,
              'success',
              JSON.stringify(status.result),
            );
            const issued = await fixture('/fixture:inspect');
            const grants = issued.executions.filter(
              (row) => row.native_authorization_json !== null,
            );
            assert.equal(grants.length, invocations.length + 1);
            const grant = grants
              .map((row) => JSON.parse(row.native_authorization_json))
              .find((value) => value.executionCallId === executionCallId);
            assert.ok(grant, 'SQL dispatch must mint the grant');
            const workerHeaders = {
              ...headers,
              authorization: `Bearer ${boot.context.token}`,
              'x-qwen-managed-lease-id': boot.context.leaseId,
              'x-qwen-managed-lease-epoch': String(boot.context.epoch),
            };
            const request = {
              protocolVersion: 1,
              requestId: randomUUID(),
              action: 'execute',
              subject: executionCallId,
              identity: grant.identity,
              context: grant.context,
              installedContext: grant.installedContext,
            };
            const workingBefore = await fs.readFile(
              path.join(workspace, 'marker.txt'),
            );
            const repeated = await broker(
              `/executions/${executionCallId}:start`,
              { payloadJson },
            );
            assert.deepEqual(repeated.status.result, status.result);
            assert.deepEqual(await fixture('/fixture:inspect'), issued);
            assert.deepEqual(
              await fs.readFile(path.join(workspace, 'marker.txt')),
              workingBefore,
            );
            const bindRequest = { ...request, action: 'bind', subject: null };
            const nativeRoute = '/internal/runtime-broker/csi/v1/native:read';
            await post(input.broker, nativeRoute, bindRequest, workerHeaders);
            const foreignBinding = {
              ...bindRequest.installedContext.binding,
              workspaceId: 'foreign-workspace',
            };
            for (const [name, changed, override, code] of [
              [
                'SQL wrong token',
                bindRequest,
                { authorization: 'Bearer foreign' },
                401,
              ],
              [
                'SQL wrong owner',
                {
                  ...bindRequest,
                  identity: {
                    ...bindRequest.identity,
                    sessionId: input.foreignOwnerSessionId,
                  },
                  installedContext: {
                    ...bindRequest.installedContext,
                    sessionId: input.foreignOwnerSessionId,
                    operationId: input.foreignOwnerOperationId,
                  },
                },
                {},
                409,
              ],
              [
                'SQL wrong context',
                {
                  ...bindRequest,
                  context: {
                    ...bindRequest.context,
                    workspaceId: foreignBinding.workspaceId,
                  },
                  installedContext: {
                    ...bindRequest.installedContext,
                    binding: foreignBinding,
                    contextDigest: computeManagedContextDigest(foreignBinding),
                  },
                },
                {},
                409,
              ],
            ]) {
              await post(
                input.broker,
                nativeRoute,
                changed,
                { ...workerHeaders, ...override },
                code,
                name,
              );
              assert.deepEqual(
                await fs.readFile(path.join(workspace, 'marker.txt')),
                workingBefore,
                name,
              );
              checks.push(name);
            }
            for (const [name, changed, override, code] of [
              [
                'wrong token',
                request,
                { authorization: 'Bearer foreign' },
                401,
              ],
              [
                'wrong lease',
                request,
                { 'x-qwen-managed-lease-epoch': '99' },
                409,
              ],
              [
                'wrong owner',
                {
                  ...request,
                  identity: { ...request.identity, sessionId: randomUUID() },
                },
                {},
                409,
              ],
              [
                'wrong context',
                {
                  ...request,
                  installedContext: {
                    ...request.installedContext,
                    binding: {
                      ...request.installedContext.binding,
                      contextRevision: 99,
                    },
                  },
                },
                {},
                409,
              ],
              [
                'ungranted execution',
                { ...request, subject: randomUUID() },
                {},
                409,
              ],
            ]) {
              await post(
                worker.ready.context.url,
                '/internal/managed-runtime/csi/v2/execute',
                changed,
                { ...workerHeaders, ...override },
                code,
                name,
              );
              assert.deepEqual(
                await fs.readFile(path.join(workspace, 'marker.txt')),
                workingBefore,
                name,
              );
              checks.push(name);
            }
            const parts = convertToFunctionResponse(
              fc.name,
              fc.id,
              managedToolResponseParts(status.result.responseParts),
            );
            for (const part of parts)
              if (part.functionResponse)
                part.functionResponse.response.executionStatus =
                  status.result.executionStatus;
            const tool = record('tool_result', {
              daemonPromptId: promptId,
              model: 'owned-model',
              message: { role: 'user', parts },
            });
            const outcomeRef = await session.resources.publish(
              'managed-tool-outcome',
              Buffer.from(
                JSON.stringify({
                  schemaVersion: 1,
                  executionCallId,
                  envelope: status.result,
                  history: {
                    messageId: tool.uuid,
                    timestamp: tool.timestamp,
                    model: 'owned-model',
                    parts,
                  },
                }),
              ),
            );
            await session.authority.appendExecutionEvent(
              {
                operation: 'recordToolResult',
                commandId: executionCallId,
                sessionKey: key,
                contentDigest: outcomeRef.digest,
              },
              (sequence) => ({
                v: 1,
                sequence,
                eventId: `tool-receipt:${executionCallId}`,
                sessionKey: key,
                kind: 'tool.receipt',
                occurredAt: Date.now(),
                payload: {
                  executionCallId,
                  toolOutcomeRef: outcomeRef,
                  resultRef: null,
                  resources: [],
                  historyRevision: sequence,
                },
              }),
              { class: 'trusted_entry' },
            );
            await session.sink.write(tool);
            parent = tool.uuid;
            await harness.resolveAwaitRuntime(executionCallId, outcomeRef);
            invocations.push({
              tool: fc.name,
              executionCallId,
              grantDigest: hash(JSON.stringify(grant)),
              responseParts: status.result.responseParts,
            });
          }
          observation = await control('snapshot');
          await history(
            `csi-file-history:result:${batchId}`,
            null,
            observation,
          );
          const continued = await scope.beginMainAttempt('owned-model');
          await continued(true, usage);
          await harness.consumeRuntimeResults();
          const final = record('assistant', {
            daemonPromptId: promptId,
            model: 'owned-model',
            message: {
              role: 'model',
              parts: [{ text: 'owned continuation complete' }],
            },
          });
          await session.sink.write(final);
          parent = final.uuid;
          await harness.settleConsumedRuntimeContinuation();
          await session.sink.write(
            record('system', {
              parentUuid: null,
              subtype: 'turn_result',
              systemPayload: {
                promptId,
                state: 'completed',
                stopReason: 'end_turn',
                endedAt: Date.now(),
              },
            }),
          );
        }),
    );
    assert.deepEqual(session.activation, expectedActivation);
    if (index === 0) firstPins = structuredClone(observation.retainedBackups);
    else
      for (const pin of firstPins)
        assert.deepEqual(
          observation.retainedBackups.find(
            (current) => current.name === pin.name,
          ),
          pin,
        );
    completedTurns++;
  }
  const retained = [];
  for (const pin of observation.retainedBackups) {
    const bytes = await fs.readFile(
      path.join(workspace, '.qwen-csi-file-history', key.sessionId, pin.name),
    );
    assert.equal(hash(bytes), pin.digest);
    assert.equal(pin.mode, 0o640);
    retained.push(bytes.toString());
  }
  assert.deepEqual(retained.sort(), ['alpha\n', 'beta\n']);
  const finalBytes = await fs.readFile(
    path.join(workspace, 'marker.txt'),
    'utf8',
  );
  assert.equal(finalBytes, 'gamma\n');
  assert.equal(observation.state.snapshots.length, 2);
  const finalWriterGeneration = (await stores.publication.owner())
    .writerGeneration;
  let retirementResult;
  if (input.retirement) {
    await stores.csiRetirement.joinWriter();
    const records = await session.authority.prepareOriginalCsiRelease();
    await stores.csiRetirement.prepare(records);
    // The generic assembly stops its activation timer and refuses the private final boundary.
    await assert.rejects(
      session.close({ releaseActivation: false }),
      /original CSI retirement owns the final boundary/,
    );
    retirementJoined = true;
    const intent = await fixture('/fixture:retire');
    const retirementDescriptors = [...opened];
    assert.ok(retirementDescriptors.length > 0);
    retirementResult = await stores.csiRetirement.complete(intent.retirementId);
    assert.equal(retirementResult.stage, 'DRAINED');
    assert.equal(retirementResult.progressVersion, 4);
    assert.equal(opened.size, 0);
    for (const handle of retirementDescriptors)
      await assert.rejects(handle.stat(), { code: 'EBADF' });
    const closedImage = await fixture('/fixture:image');
    assert.deepEqual(
      await stores.csiRetirement.complete(intent.retirementId),
      retirementResult,
    );
    assert.deepEqual(await fixture('/fixture:image'), closedImage);
    await stores.stopLocal();
  }
  const workerUrl = worker.ready.context.url;
  await worker.close();
  worker = undefined;
  await assert.rejects(
    fetch(workerUrl, { signal: AbortSignal.timeout(2000) }),
    TypeError,
  );
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        completedTurns,
        hostedProducer: input.hostedProducer === true,
        nativeSqlGrant: true,
        workerClosed: true,
        finalBytes,
        retained,
        invocations,
        refusalChecks: checks.length,
        writerGeneration: finalWriterGeneration,
        ...(retirementResult ? { retirement: retirementResult } : {}),
        coldRecovery: input.coldRecovery === true,
        coldRefusalChecks,
        recoveryCut: input.recoveryCut,
        originalActivation: initialActivation,
        platformFixture: `${actualPlatform.value} real inodes; explicit mount/proc-fd and placement mapping`,
        nativeCsiDeployment: false,
        nativeGrantInsertedByFixture: false,
        workerRepliesStubbed: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  const cleanupErrors = [];
  for (const close of [
    () =>
      retirementJoined
        ? stores?.stopLocal()
        : session?.close({ releaseActivation: false }),
    () => (retirementJoined ? stores?.stopLocal() : stores?.close()),
  ]) {
    try {
      await close();
    } catch (error) {
      if (
        !['csi_finalize_required', 'csi_managed_mutation_unavailable'].includes(
          error.remoteCode,
        )
      )
        cleanupErrors.push(error);
    }
  }
  await worker?.close();
  Server.prototype.listen = nativeListen;
  Object.defineProperties(ManagedCsiMount.prototype, originalMount);
  Object.defineProperty(
    ManagedCsiRootDirectory,
    'open',
    originalRootDirectoryOpen,
  );
  Object.defineProperty(process, 'platform', actualPlatform);
  Object.assign(fs, native);
  for (const handle of opened) await handle.close();
  await rootHandle.close();
  await fs.rm(workspace, { recursive: true, force: true });
  assert.deepEqual(cleanupErrors, [], 'Unexpected private cleanup refusal');
}
