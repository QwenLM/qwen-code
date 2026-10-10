/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import express from 'express';

const repository = process.cwd();
const fromBuild = (location) =>
  import(pathToFileURL(path.join(repository, location)).href);
const { SessionWriterLease } = await fromBuild(
  'packages/core/dist/src/services/session-writer-lease.js',
);
const { LocalToolResultSegmentStore } = await fromBuild(
  'packages/core/dist/src/managed-runtime/local-managed-tool-result-store.js',
);
const { LocalManagedSessionResourceStore } = await fromBuild(
  'packages/core/dist/src/managed-runtime/managed-session-resources.js',
);
const { LocalShellResultCapture } = await fromBuild(
  'packages/core/dist/src/managed-runtime/local-shell-result-capture.js',
);
const { ManagedToolExecutor, createManagedToolSet } = await fromBuild(
  'packages/cli/dist/src/serve/managed-runtime-tool-executor.js',
);
const { registerManagedRuntimeToolV3Routes } = await fromBuild(
  'packages/cli/dist/src/serve/managed-runtime-tool-v3-routes.js',
);

const root = await mkdtemp(path.join(tmpdir(), 'qwen-java-tool-v3-'));
const runtimeBaseDir = path.join(root, 'runtime');
const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'managed-session-a',
};
const transcriptPath = path.join(
  runtimeBaseDir,
  'chats',
  'managed-session-a.jsonl',
);
await mkdir(path.dirname(transcriptPath), { recursive: true });
const lease = await SessionWriterLease.acquire({
  runtimeBaseDir,
  sessionId: sessionKey.sessionId,
  transcriptPath,
});
const store = await LocalToolResultSegmentStore.openWritable({
  lease,
  sessionKey,
});
const resources = LocalManagedSessionResourceStore.create({
  runtimeBaseDir,
  sessionKey,
});
const identity = {
  tenantId: 'tenant-a',
  sessionId: 'managed-session-a',
  turnId: 'turn-1',
  executionCallId: 'execution-a',
  callId: 'call-01',
  invocationDigest:
    '424b16b9aa8d9f0648c8b2e91ecd9fb09faba205685214a7ccb01702b3dd0ce8',
  bindingGeneration: '1',
  captureId: 'capture-a',
  revision: 1,
};
const publisher = {
  async prepare() {
    return {
      identity,
      sink: new LocalShellResultCapture(store, resources, identity),
    };
  },
  async accept(_original, envelope) {
    return {
      executionCallId: identity.executionCallId,
      manifest: envelope.capture.manifest,
      deliveryStatus: 'committed',
      historyRevision: 7,
      outcomeRef: {
        resourceId: 'outcome-a',
        kind: 'managed-tool-outcome',
        schemaVersion: 1,
        byteLength: 0,
        digest: 'a'.repeat(64),
      },
    };
  },
};
const toolSet = createManagedToolSet(root, 'runtime-session-01');
const executor = new ManagedToolExecutor(async () => toolSet, publisher);
const app = express();
registerManagedRuntimeToolV3Routes(
  app,
  { token: 'fixture-token', leaseId: 'lease-01', epoch: 4 },
  executor,
);
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(`READY:${server.address().port}\n`);

process.on('SIGTERM', () => {
  void (async () => {
    await executor.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    await lease.release();
    await rm(root, { recursive: true, force: true });
  })().finally(() => process.exit());
});
