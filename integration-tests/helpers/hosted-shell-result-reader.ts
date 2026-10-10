/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHttpManagedSessionStores } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  storeUrl: string;
  outputs: Array<{
    sessionKey: ManagedSessionKey;
    manifestRef: ManagedSessionDurableRef;
    executionCallId: string;
    turnId: string;
    stdoutBytes: number;
    stdoutDigest: string;
    stderrDigest: string;
  }>;
};
assert.equal(config.outputs.length, 1);
for (const output of config.outputs) {
  const stores = createHttpManagedSessionStores({
    baseUrl: config.storeUrl,
    sessionKey: output.sessionKey,
    writerId: randomUUID(),
  });
  await stores.journalStore.open({ sessionKey: output.sessionKey });
  const reader = new ResourceToolResultSegmentStore(stores.toolResultResources);
  try {
    const manifest = parseToolResultManifestBytes(
      await stores.resourceStore.read(output.manifestRef),
    );
    assert.equal(manifest.tenantId, output.sessionKey.tenantId);
    assert.equal(manifest.sessionId, output.sessionKey.sessionId);
    assert.equal(manifest.executionCallId, output.executionCallId);
    assert.equal(manifest.turnId, output.turnId);
    assert.equal(manifest.captureStatus, 'complete');
    assert.equal(manifest.contents.length, 2);
    for (const stream of manifest.contents) {
      const digest = createHash('sha256');
      for (
        let offset = 0;
        offset < stream.byteLength;
        offset += 16 * 1024 * 1024
      ) {
        const range = await reader.readRange({
          manifestRef: output.manifestRef,
          expectedIdentity: manifest,
          streamId: stream.streamId,
          offset,
          length: Math.min(16 * 1024 * 1024, stream.byteLength - offset),
        });
        assert.equal(range.status, 'ok');
        if (range.status === 'ok') digest.update(range.result);
      }
      const actual = digest.digest('hex');
      assert.equal(actual, stream.digest);
      assert.equal(
        actual,
        stream.streamId === 'stdout'
          ? output.stdoutDigest
          : output.stderrDigest,
      );
      if (stream.streamId === 'stdout')
        assert.equal(stream.byteLength, output.stdoutBytes);
      const tail = await reader.readRange({
        manifestRef: output.manifestRef,
        expectedIdentity: manifest,
        streamId: stream.streamId,
        offset: stream.byteLength - 12,
        length: 12,
      });
      assert.equal(tail.status, 'ok');
      if (tail.status === 'ok')
        assert.equal(tail.result.toString(), `${stream.streamId}-tail\0`);
    }
  } finally {
    await reader.close();
    await stores.close();
  }
}
console.log('HOSTED_SHELL_RETAINED_OUTPUT_OK');
