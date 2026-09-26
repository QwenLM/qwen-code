/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';

// An HTTP transport fixture, not a substitute for the Spring/MySQL slice.
export async function startHostedSessionStore(sessionId: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-store-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId,
  };
  const transcriptPath = path.join(root, `${sessionId}.jsonl`);
  const journal = new LocalJsonlManagedSessionJournalStore({
    runtimeBaseDir: root,
    sessionId,
    transcriptPath,
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const refs = new Map<string, ManagedSessionDurableRef>();
  const transactions: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const pending = new Set<Promise<void>>();
  let handle: ManagedSessionJournalHandle | undefined;
  let writerToken: string | undefined;
  let writerGeneration = 0;
  let seals = 0;
  const scan = () =>
    LocalJsonlManagedSessionJournalStore.read(transcriptPath, sessionKey);
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const request = (async () => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const prefix = `/internal/managed-session-store/v1/sessions/${sessionId}`;
      assert(url.pathname.startsWith(prefix));
      assert.equal(req.headers['x-qwen-tenant-id'], sessionKey.tenantId);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(
        Buffer.concat(chunks).toString() || '{}',
      ) as Record<string, unknown>;
      assert.equal(
        body.workspaceId ?? url.searchParams.get('workspaceId'),
        sessionKey.workspaceId,
      );
      const route = url.pathname.slice(prefix.length);
      const json = (value: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (route === '/writers:acquire') {
        if (handle) {
          res.statusCode = 409;
          json({
            error: { code: 'writer_busy', message: 'writer still attached' },
          });
          return;
        }
        writerToken = String(req.headers['x-qwen-managed-writer-token']);
        handle = await journal.open({ sessionKey });
        writerGeneration++;
      } else {
        assert.equal(req.headers['x-qwen-managed-writer-token'], writerToken);
      }
      const current = await scan();
      const head = {
        writerGeneration,
        journalRevision: transactions.length,
        committedSequence: current.committed,
        lastCommitDigest: current.lastMarkerDigest,
        activationEpoch: current.activation?.epoch ?? 0,
      };
      if (route === '/writers:acquire' || route === '/writers:renew') {
        json({ ...head, leaseUntil: Date.now() + Number(body.leaseMillis) });
      } else if (route === '/restore') {
        json({
          ...head,
          state: 'ACTIVE',
          storageVersion: 1,
          latestCheckpointResourceId: null,
          compactedThroughRevision: 0,
          recoveryStatus: 'READY',
          recoveryDetailCode: null,
        });
      } else if (route === '/transactions:commit') {
        assert(handle);
        assert.equal(body.writerGeneration, writerGeneration);
        assert.equal(body.expectedJournalRevision, transactions.length);
        assert.equal(body.expectedCommittedSequence, current.committed);
        for (const resource of body.resources as Array<
          ManagedSessionDurableRef & { bytesBase64?: string }
        >) {
          if (resource.bytesBase64 !== undefined) {
            const local = await resources.publish(
              resource.kind,
              Buffer.from(resource.bytesBase64, 'base64'),
            );
            assert.equal(local.digest, resource.digest);
            assert.equal(local.byteLength, resource.byteLength);
            refs.set(resource.resourceId, local);
          } else {
            assert(refs.has(resource.resourceId));
          }
        }
        const bytes = Buffer.from(String(body.recordBytesBase64), 'base64');
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          body.recordDigest,
        );
        await handle.appendTransaction(
          bytes
            .toString()
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown),
        );
        const committed = await scan();
        assert.equal(committed.uncommitted, 0);
        assert.equal(committed.committed, body.lastSequence);
        assert.equal(committed.lastMarkerDigest, body.commitDigest);
        transactions.push({
          ...body,
          journalRevision: transactions.length + 1,
          byteLength: bytes.length,
          recordEncoding: 'identity',
        });
        json({
          ...body,
          journalRevision: transactions.length,
          committedSequence: committed.committed,
        });
      } else if (route === '/transactions') {
        const after = Number(url.searchParams.get('afterRevision'));
        const page = transactions.slice(after, after + 100);
        json({
          transactions: page,
          nextRevision: after + page.length,
          hasMore: after + page.length < transactions.length,
        });
      } else if (route.startsWith('/resources/')) {
        const ref = refs.get(route.slice('/resources/'.length));
        assert(ref);
        res.setHeader('X-Qwen-Resource-Kind', ref.kind);
        res.setHeader('X-Qwen-Resource-Schema-Version', ref.schemaVersion);
        res.setHeader('X-Qwen-Resource-Digest', ref.digest);
        res.end(await resources.read(ref));
      } else if (route === '/writers:seal') {
        assert(handle);
        await handle.abort();
        handle = undefined;
        seals++;
        json({ writerGeneration, state: 'SEALED' });
      } else {
        throw new Error(`Unexpected Store route: ${route}`);
      }
    })().catch((error: unknown) => {
      failures.push(String(error));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'fixture_error', message: String(error) },
        }),
      );
    });
    pending.add(request);
    void request.then(() => pending.delete(request));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessionKey,
    scan,
    readResource: (ref: ManagedSessionDurableRef) => {
      const local = refs.get(ref.resourceId);
      assert(local);
      return resources.read(local);
    },
    failures,
    get seals() {
      return seals;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(pending);
      await handle?.abort();
      handle = undefined;
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
