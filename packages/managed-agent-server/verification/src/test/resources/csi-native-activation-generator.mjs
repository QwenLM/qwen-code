/** Native producer bytes for the explicitly invoked Java SQL integration gate. */
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { pathToFileURL, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
const root = process.cwd();
const evidence = pathToFileURL(process.argv[3] + '/');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const authorityModule = pathToFileURL(
  root + '/packages/core/dist/src/managed-runtime/managed-session-authority.js',
);
const adapterModule = pathToFileURL(
  root +
    '/packages/core/dist/src/managed-runtime/http-managed-session-store.js',
);
const hostedModule = pathToFileURL(
  root + '/packages/cli/dist/src/serve/hosted-harness-contract.js',
);
const { LocalManagedSessionAuthority } = await import(authorityModule.href);
const { createHttpManagedSessionStores } = await import(adapterModule.href);
const { createHostedHarnessContract } = await import(hostedModule.href);
const { createManagedHarnessHandle } = await import(
  pathToFileURL(
    root + '/packages/core/dist/src/managed-runtime/managed-harness-factory.js',
  ).href
);
const contract = createHostedHarnessContract(input.capabilityDigest);
const writerId = contract.bootId;
const token = randomBytes(32).toString('base64url');
const requests = [],
  commits = [],
  resources = new Map();
let leaseUntil = 0,
  state = 'SEALED',
  writerGeneration = 0,
  sequence = 0,
  activationEpoch = 0,
  latestCheckpointResourceId = null,
  lastDigest = null;
const transactions = [];
const initialClock = Date.now();
let nativeClock = initialClock,
  clockCalls = 0;
const now = () => {
  clockCalls++;
  return nativeClock++;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const grant = () => ({
  writerGeneration,
  leaseUntil,
  journalRevision: transactions.length,
  committedSequence: sequence,
  ...(lastDigest === null ? {} : { lastCommitDigest: lastDigest }),
  activationEpoch,
  replayed: false,
});
const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      rawBody: raw,
      body,
      rawBodySha256: hash(Buffer.from(raw)),
    });
    const prefix =
      '/internal/managed-session-store/v1/sessions/' +
      encodeURIComponent(input.sessionKey.sessionId);
    if (!url.pathname.startsWith(prefix + '/'))
      throw new Error('Foreign Session path');
    const suffix = url.pathname.slice(prefix.length);
    const method = suffix.startsWith('/resources/')
      ? 'GET'
      : {
          '/writers:acquire': 'POST',
          '/writers:renew': 'POST',
          '/writers:seal': 'POST',
          '/restore': 'GET',
          '/transactions': 'GET',
          '/transactions:commit': 'POST',
        }[suffix];
    if (!method || req.method !== method)
      throw new Error('Unsupported collector route');
    let answer;
    if (suffix === '/writers:acquire') {
      writerGeneration++;
      state = 'ACTIVE';
      leaseUntil = Date.now() + 300000;
      answer = grant();
    } else if (suffix === '/writers:renew') {
      leaseUntil = Date.now() + 300000;
      answer = grant();
    } else if (suffix === '/writers:seal') {
      state = 'SEALED';
      answer = { writerGeneration, state, replayed: false };
    } else if (suffix === '/restore') {
      answer = {
        state,
        storageVersion: 1,
        writerGeneration,
        journalRevision: transactions.length,
        committedSequence: sequence,
        ...(lastDigest === null ? {} : { lastCommitDigest: lastDigest }),
        activationEpoch,
        compactedThroughRevision: 0,
        recoveryStatus: 'READY',
        ...(latestCheckpointResourceId === null
          ? {}
          : { latestCheckpointResourceId }),
      };
    } else if (suffix === '/transactions') {
      let after = Number(url.searchParams.get('afterRevision') ?? 0),
        limit = Number(url.searchParams.get('limit') ?? 100);
      const rows = transactions.slice(after, after + limit);
      answer = {
        transactions: rows,
        nextRevision: after + rows.length,
        hasMore: after + rows.length < transactions.length,
      };
    } else if (suffix === '/transactions:commit') {
      const bytes = Buffer.from(body.recordBytesBase64, 'base64');
      if (hash(bytes) !== body.recordDigest)
        throw new Error('Actual adapter record digest mismatch');
      for (const r of body.resources) {
        if (r.bytesBase64 !== null && r.bytesBase64 !== undefined) {
          const rb = Buffer.from(r.bytesBase64, 'base64');
          if (hash(rb) !== r.digest || rb.byteLength !== r.byteLength)
            throw new Error('Actual adapter resource bytes mismatch');
          resources.set(r.resourceId, {
            ref: {
              resourceId: r.resourceId,
              kind: r.kind,
              schemaVersion: r.schemaVersion,
              byteLength: r.byteLength,
              digest: r.digest,
            },
            bytesBase64: r.bytesBase64,
            rawUtf8: rb.toString('utf8'),
          });
        } else if (!resources.has(r.resourceId))
          throw new Error('Actual native referenced resource missing');
      }
      commits.push({
        request: body,
        rawBody: raw,
        rawBodySha256: hash(Buffer.from(raw)),
        recordBytesBase64: body.recordBytesBase64,
        recordUtf8: bytes.toString('utf8'),
        parsedRecords: bytes
          .toString('utf8')
          .trimEnd()
          .split('\n')
          .map((v) => JSON.parse(v)),
      });
      let revision = transactions.length + 1;
      transactions.push({
        ...body,
        journalRevision: revision,
        recordEncoding: 'identity',
        byteLength: bytes.byteLength,
      });
      sequence = body.lastSequence;
      lastDigest = body.commitDigest;
      activationEpoch = body.activationEpoch;
      if (body.latestCheckpointResourceId !== null)
        latestCheckpointResourceId = body.latestCheckpointResourceId;
      answer = {
        journalRevision: revision,
        transactionId: body.transactionId,
        commandId: body.commandId,
        operation: body.operation,
        firstSequence: body.firstSequence,
        lastSequence: body.lastSequence,
        committedSequence: body.lastSequence,
        commitDigest: body.commitDigest,
        replayed: false,
      };
    } else if (suffix.startsWith('/resources/')) {
      const r = resources.get(
        decodeURIComponent(suffix.slice('/resources/'.length)),
      );
      if (!r) throw new Error('Unknown native resource');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Qwen-Resource-Kind': r.ref.kind,
        'X-Qwen-Resource-Schema-Version': String(r.ref.schemaVersion),
        'X-Qwen-Resource-Digest': r.ref.digest,
      });
      res.end(Buffer.from(r.bytesBase64, 'base64'));
      return;
    } else throw new Error('Unsupported collector path ' + suffix);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(answer));
  } catch (error) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        error: { code: 'owned_collector_failure', message: String(error) },
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
let stores;
try {
  stores = createHttpManagedSessionStores({
    baseUrl: 'http://127.0.0.1:' + address.port,
    sessionKey: input.sessionKey,
    writerId,
    writerToken: token,
    leaseDurationMs: 300000,
    requestTimeoutMs: 10000,
  });
  if (input.conversation) {
    const { generateNativeTextTurns } = await import(
      './csi-native-text-turns.mjs'
    );
    const observations = await generateNativeTextTurns(
      stores,
      input,
      contract,
      evidence,
      root,
    );
    await writeFile(
      new URL('native-fixture.json', evidence),
      JSON.stringify(
        {
          input,
          writerId,
          workerId: contract.bootId,
          writerToken: token,
          commits,
          resources: [...resources.values()],
          observations,
          provenance: {
            backend:
              'owned HTTP collector; actual SQL admission is in the Java gate',
            manufacturedNativeEvents: false,
            privateExecuteHostedTurn: false,
            sharedHostedTurn: input.streamed === true,
            privateHttpAttachment: false,
          },
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const journal = await stores.journalStore.open({
      sessionKey: input.sessionKey,
    });
    const definitionRef = await stores.resourceStore.publish(
      'managed-definition',
      Buffer.from(
        JSON.stringify({
          engine: 'managed',
          sessionId: input.sessionKey.sessionId,
          toolProfile: 'csi-files-retirement/1',
        }),
      ),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-root',
      Buffer.from(JSON.stringify({ cwd: input.cwd })),
    );
    const authority = await LocalManagedSessionAuthority.open({
      journal,
      resources: stores.resourceStore,
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      version: 'hosted-harness/1',
      now,
      create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
    });
    const first = await authority.installActivation({
      activationId: randomUUID(),
      workerId: contract.bootId,
      leaseDurationMs: 60000,
    });
    const renewed = await authority.renewActivation({ leaseDurationMs: 90000 });
    const initialCheckpoint = await createManagedHarnessHandle({
      authority,
      activation: first,
    }).ensureCheckpoint();
    const afterCheckpointRenewal = await authority.renewActivation({
      leaseDurationMs: 90000,
    });
    async function submitInput(prompt) {
      const promptId = randomUUID();
      const bytes = Buffer.from(JSON.stringify(prompt));
      const digest = hash(bytes);
      const contentRef = await stores.resourceStore.publish(
        'managed-input',
        bytes,
      );
      const admissionRef = await stores.resourceStore.publish(
        'managed-admission',
        Buffer.from(JSON.stringify({ promptId, digest: 'sha256:' + digest })),
      );
      return authority.submitInput(
        {
          operation: 'submitInput',
          commandId: promptId,
          sessionKey: input.sessionKey,
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
    }
    await submitInput([
      { type: 'text', text: '原始输入\n' + '文'.repeat(5000) },
      { type: 'text', text: 'second block' },
    ]);
    await authority.renewActivation({ leaseDurationMs: 90000 });
    await submitInput([{ type: 'text', text: 'unsettled second input' }]);
    const fixture = {
      format: 'csi-native-activation-test-generator/1',
      generatedAt: new Date().toISOString(),
      input,
      hostedContract: contract,
      writerId,
      workerId: contract.bootId,
      writerToken: token,
      first,
      renewed,
      initialCheckpoint,
      afterCheckpointRenewal,
      clock: {
        initialClock,
        finalClock: nativeClock,
        clockCalls,
        incrementMs: 1,
      },
      genesisDefinitionRef: definitionRef,
      rootSnapshotRef,
      commits,
      resources: [...resources.values()],
      rawRequestsBeforeCollectorCleanup: requests.slice(),
      provenance: {
        authorityModule: authorityModule.href,
        httpAdapterModule: adapterModule.href,
        hostedContractModule: hostedModule.href,
        usesDefaultFetch: true,
        usesRealOwnedLoopbackHttp: true,
        backend: 'owned response collector only; not Java or SQL acceptance',
        manufacturedJournalMarkerOrPositiveBody: false,
      },
    };
    await writeFile(
      new URL('native-fixture.json', evidence),
      JSON.stringify(fixture, null, 2) + '\n',
    );
  }
  await stores.close();
  await writeFile(
    new URL('all-http-requests.json', evidence),
    JSON.stringify(requests, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      status: 'generated',
      fixture: new URL('native-fixture.json', evidence).pathname,
      operations: commits.map((x) => x.request.operation),
      writerId,
      workerId: contract.bootId,
      serverPort: address.port,
      serverOwned: true,
    }),
  );
} finally {
  await writeFile(
    new URL('all-http-requests-final.json', evidence),
    JSON.stringify(requests, null, 2) + '\n',
  );
  if (stores)
    try {
      await stores.close();
    } catch {
      // Collector shutdown must still run when store cleanup fails.
    }
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
}
