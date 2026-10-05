/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  parseStoredTransaction,
  type StoredTransaction,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  LocalRecoveryBundle,
  UnsupportedSourceEntryError,
  recoveryDigest,
  recoveryJson,
  type BundleIndex,
  type RecoveryRpc,
} from './workspace-recovery-bundle.js';
import {
  verifyRecoverySession,
  type RecoverySessionSource,
  type RecoverySessionIO,
} from './workspace-recovery-session.js';

interface RecoveryContext {
  protocol: 'workspace-recovery/1';
  mode: 'capture' | 'verify';
  request: {
    operationId: string;
    tenantId: string;
    storageId: string;
    sourceRoot: string;
    bundleRoot: string;
    fileHistoryRoot: string;
    fenceOperationId: string;
    mountRevision: number;
  };
  registration: Record<string, unknown>;
  sourceDigest: string;
  sessionCount: number;
  capture: null | { operationId: string; manifestDigest: string };
}
interface SourceRow {
  sessionId: string;
  sourceDigest: string;
  sourceJson: string;
  source: RecoverySessionSource;
}

export function createRecoveryRpc(
  input: Readable,
  output: Writable,
): RecoveryRpc {
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let id = 0;
  let busy = false;
  return async (method, params) => {
    if (busy) throw new Error('concurrent_recovery_request');
    busy = true;
    try {
      const requestId = ++id;
      await new Promise<void>((accept, reject) => {
        output.write(
          `${JSON.stringify({ id: requestId, method, params })}\n`,
          (error) => (error ? reject(error) : accept()),
        );
      });
      while (!pending.includes(10)) {
        const chunk = await iterator.next();
        if (chunk.done) throw new Error('recovery_parent_closed');
        pending = Buffer.concat([
          pending,
          Buffer.from(chunk.value as Uint8Array),
        ]);
        if (pending.length > 24 * 1024 * 1024)
          throw new Error('recovery_response_too_large');
      }
      const end = pending.indexOf(10);
      const response = JSON.parse(
        pending.subarray(0, end).toString('utf8'),
      ) as { id?: unknown; error?: { code?: unknown }; result?: unknown };
      pending = pending.subarray(end + 1);
      if (response.id !== requestId || pending.length !== 0)
        throw new Error('unexpected_recovery_response');
      if (response.error)
        throw new Error(
          typeof response.error.code === 'string'
            ? response.error.code
            : 'recovery_rpc_failed',
        );
      if (!Object.hasOwn(response, 'result'))
        throw new Error('invalid_recovery_response');
      return response.result;
    } finally {
      busy = false;
    }
  };
}

function decoded(value: string, digest: string, byteLength: number): Buffer {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > 16 * 1024 * 1024 ||
    value.length > 24 * 1024 * 1024
  )
    throw new Error('resource_limit_exceeded');
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value ||
    bytes.length !== byteLength ||
    recoveryDigest(bytes) !== digest
  )
    throw new Error('source_digest_mismatch');
  return bytes;
}

async function* sources(rpc: RecoveryRpc): AsyncGenerator<SourceRow> {
  let afterSessionId: string | null = null;
  let previous = '';
  do {
    const page = (await rpc('sessions', { afterSessionId })) as {
      sessions: SourceRow[];
      nextSessionId: string | null;
    };
    if (!Array.isArray(page.sessions) || page.sessions.length > 32)
      throw new Error('invalid_session_page');
    for (const row of page.sessions) {
      if (
        row.sessionId <= previous ||
        row.sessionId !== row.source.sessionId ||
        recoveryDigest(row.sourceJson) !== row.sourceDigest ||
        recoveryJson(JSON.parse(row.sourceJson)) !== recoveryJson(row.source)
      )
        throw new Error('invalid_session_source');
      previous = row.sessionId;
      yield row;
    }
    if (page.nextSessionId !== null && page.nextSessionId !== previous)
      throw new Error('invalid_session_cursor');
    afterSessionId = page.nextSessionId;
  } while (afterSessionId !== null);
}

function sessionIO(
  row: SourceRow,
  bundle: LocalRecoveryBundle,
  rpc: RecoveryRpc,
): RecoverySessionIO {
  const sessionId = row.sessionId;
  return {
    async *transactions() {
      for (
        let revision = 1;
        revision <= (row.source.head?.journalRevision ?? 0);
        revision++
      ) {
        let transaction: StoredTransaction;
        if (bundle.mode === 'capture') {
          transaction = parseStoredTransaction(
            await rpc('transaction', { sessionId, revision }),
          );
          const bytes = decoded(
            transaction.recordBytesBase64,
            transaction.recordDigest,
            transaction.byteLength,
          );
          const path = await bundle.blob(bytes);
          const { recordBytesBase64: _bytes, ...metadata } = transaction;
          await bundle.asset('transaction', [sessionId, String(revision)], {
            type: 'transaction',
            sessionId,
            revision,
            transaction: { ...metadata, recordEncoding: 'identity' },
            path,
          });
        } else {
          const saved = await bundle.lookup(
            'transaction',
            sessionId,
            String(revision),
          );
          const metadata = saved['transaction'] as Omit<
            StoredTransaction,
            'recordBytesBase64'
          >;
          const bytes = await bundle.readBlob(
            saved['path'],
            metadata.recordDigest,
            metadata.byteLength,
          );
          transaction = parseStoredTransaction({
            ...metadata,
            recordBytesBase64: bytes.toString('base64'),
          });
          await bundle.asset(
            'transaction',
            [sessionId, String(revision)],
            saved,
          );
        }
        if (transaction.journalRevision !== revision)
          throw new Error('journal_revision_mismatch');
        yield transaction;
      }
    },
    async read(ref) {
      if (bundle.mode === 'capture') {
        const resource = (await rpc('resource', { sessionId, ref })) as {
          ref: typeof ref;
          bytesBase64: string;
        };
        if (recoveryJson(resource.ref) !== recoveryJson(ref))
          throw new Error('reference_conflict');
        const bytes = decoded(resource.bytesBase64, ref.digest, ref.byteLength);
        const path = await bundle.blob(bytes);
        await bundle.asset('resource', [sessionId, ref.resourceId], {
          type: 'resource',
          sessionId,
          ref,
          path,
        });
        return bytes;
      }
      const saved = await bundle.lookup('resource', sessionId, ref.resourceId);
      if (recoveryJson(saved['ref']) !== recoveryJson(ref))
        throw new Error('reference_conflict');
      const bytes = await bundle.readBlob(
        saved['path'],
        ref.digest,
        ref.byteLength,
      );
      await bundle.asset('resource', [sessionId, ref.resourceId], saved);
      return bytes;
    },
    async enqueue(ref) {
      await rpc('enqueueRef', { sessionId, ref });
    },
    async nextReference() {
      return (await rpc('nextRef', { sessionId })) as Awaited<
        ReturnType<RecoverySessionIO['nextReference']>
      >;
    },
    async completeReference(ref) {
      await rpc('completeRef', { sessionId, ref });
    },
    async publicationReceipt(params) {
      const identity = [
        sessionId,
        params.executionCallId,
        String(params.sequence),
      ];
      if (bundle.mode === 'capture') {
        const receipt = (await rpc('publicationReceipt', params)) as Awaited<
          ReturnType<RecoverySessionIO['publicationReceipt']>
        >;
        await bundle.asset('publicationReceipt', identity, {
          type: 'publicationReceipt',
          sessionId,
          request: params,
          receipt,
        });
        return receipt;
      }
      const saved = await bundle.lookup('publicationReceipt', ...identity);
      if (recoveryJson(saved['request']) !== recoveryJson(params))
        throw new Error('publication_receipt_mismatch');
      await bundle.asset('publicationReceipt', identity, saved);
      return saved['receipt'] as Awaited<
        ReturnType<RecoverySessionIO['publicationReceipt']>
      >;
    },
    async publicationObject(params) {
      const identity = [sessionId, params.publicationId, params.slotKey];
      if (bundle.mode === 'capture') {
        const object = (await rpc('publicationObject', params)) as Awaited<
          ReturnType<RecoverySessionIO['publicationObject']>
        >;
        const bytes = decoded(
          object.bytesBase64,
          object.digest,
          object.byteLength,
        );
        const path = await bundle.blob(bytes);
        const { bytesBase64: _bytes, ...metadata } = object;
        await bundle.asset('publicationObject', identity, {
          type: 'publicationObject',
          sessionId,
          publicationId: params.publicationId,
          object: metadata,
          path,
        });
        return object;
      }
      const saved = await bundle.lookup('publicationObject', ...identity);
      const metadata = saved['object'] as Omit<
        Awaited<ReturnType<RecoverySessionIO['publicationObject']>>,
        'bytesBase64'
      >;
      const bytes = await bundle.readBlob(
        saved['path'],
        metadata.digest,
        metadata.byteLength,
      );
      await bundle.asset('publicationObject', identity, saved);
      return { ...metadata, bytesBase64: bytes.toString('base64') };
    },
    async verifyBackup(params) {
      await bundle.backup(params.ownerSessionId, params.backupFileName);
    },
  };
}

export async function runRecoveryWorker(rpc: RecoveryRpc): Promise<unknown> {
  let capturing = false;
  try {
    const context = (await rpc('context', {})) as RecoveryContext;
    capturing = context.mode === 'capture';
    if (
      context.protocol !== 'workspace-recovery/1' ||
      !['capture', 'verify'].includes(context.mode) ||
      !/^[0-9a-f-]{36}$/.test(context.request.operationId)
    )
      throw new Error('invalid_recovery_context');
    const bundle = new LocalRecoveryBundle(
      context.request.bundleRoot,
      context.request.operationId,
      context.mode,
      rpc,
    );
    await bundle.initialize(
      context.request.sourceRoot,
      context.request.fileHistoryRoot,
    );
    let manifest: Record<string, unknown> | undefined;
    if (context.mode === 'verify') {
      if (!context.capture) throw new Error('capture_not_sealed');
      manifest = await bundle.readManifest(context.capture.manifestDigest);
      if (
        manifest['provider'] !== 'local-workspace-bundle/1' ||
        manifest['captureOperationId'] !== context.capture.operationId ||
        manifest['sourceDigest'] !== context.sourceDigest ||
        recoveryJson(manifest['registration']) !==
          recoveryJson(context.registration)
      )
        throw new Error('bundle_manifest_mismatch');
    } else await bundle.compareTree(context.request.sourceRoot, 'workspace');
    const sourceHash = createHash('sha256');
    let sessionCount = 0;
    const sessionChunks = async function* () {
      for await (const row of sources(rpc)) {
        if (context.mode === 'capture')
          await bundle.history(row.sessionId, context.request.fileHistoryRoot);
        const summary = await verifyRecoverySession(
          row.source,
          sessionIO(row, bundle, rpc),
        );
        await rpc('sessionComplete', { sessionId: row.sessionId, summary });
        const bytes = Buffer.from(`${row.sourceJson}\n`);
        sourceHash.update(bytes);
        sessionCount++;
        yield bytes;
      }
    };
    let sessionsIndex: BundleIndex;
    if (context.mode === 'capture')
      sessionsIndex = await bundle.publish(
        '.w1-recovery/sessions.ndjson',
        sessionChunks(),
      );
    else {
      let byteLength = 0;
      for await (const bytes of sessionChunks()) byteLength += bytes.length;
      sessionsIndex = manifest!['sessions'] as BundleIndex;
      if (
        sessionsIndex.byteLength !== byteLength ||
        sessionsIndex.count !== sessionCount
      )
        throw new Error('bundle_index_mismatch');
      await bundle.checkIndex(sessionsIndex);
    }
    if (
      sourceHash.digest('hex') !== context.sourceDigest ||
      sessionCount !== context.sessionCount ||
      sessionsIndex.digest !== context.sourceDigest
    )
      throw new Error('source_set_mismatch');
    if (context.mode === 'capture') {
      await bundle.recheckTree(context.request.sourceRoot, 'workspace');
      for await (const row of sources(rpc)) {
        await bundle.recheckHistory(
          row.sessionId,
          context.request.fileHistoryRoot,
        );
      }
    }
    const entries = await bundle.census();
    const assetChunks = async function* () {
      let afterKey: string | null = null;
      do {
        const page = (await rpc('assetPage', { afterKey })) as {
          assets: Array<{ key: string; metadata: unknown }>;
          nextKey: string | null;
        };
        for (const asset of page.assets) {
          if (context.mode === 'verify') await rpc('asset', asset);
          yield Buffer.from(`${recoveryJson({ version: 1, ...asset })}\n`);
        }
        afterKey = page.nextKey;
      } while (afterKey !== null);
    };
    let assetsIndex: BundleIndex;
    if (context.mode === 'capture')
      assetsIndex = await bundle.publish(
        '.w1-recovery/assets.ndjson',
        assetChunks(),
      );
    else {
      const hash = createHash('sha256');
      let byteLength = 0;
      let count = 0;
      for await (const bytes of assetChunks()) {
        hash.update(bytes);
        byteLength += bytes.length;
        count++;
      }
      assetsIndex = manifest!['assets'] as BundleIndex;
      if (
        assetsIndex.digest !== hash.digest('hex') ||
        assetsIndex.byteLength !== byteLength ||
        assetsIndex.count !== count
      )
        throw new Error('bundle_index_mismatch');
      await bundle.checkIndex(assetsIndex);
    }
    let manifestDigest: string;
    if (context.mode === 'capture') {
      manifest = {
        version: 1,
        provider: 'local-workspace-bundle/1',
        tenantId: context.request.tenantId,
        storageId: context.request.storageId,
        captureOperationId: context.request.operationId,
        registration: context.registration,
        fenceOperationId: context.request.fenceOperationId,
        mountRevision: context.request.mountRevision,
        sourceDigest: context.sourceDigest,
        sessionCount,
        sessions: sessionsIndex,
        assets: assetsIndex,
        activation: false,
      };
      manifestDigest = (
        await bundle.publish(
          '.w1-recovery/manifest.json',
          (async function* () {
            yield Buffer.from(`${recoveryJson(manifest)}\n`);
          })(),
        )
      ).digest;
    } else manifestDigest = context.capture!.manifestDigest;
    await bundle.census();
    return await rpc('finish', {
      manifestDigest,
      result: {
        contentVerified: true,
        activation: false,
        sessionCount,
        entries,
        assets: assetsIndex.count,
        provider: 'local-workspace-bundle/1',
      },
    });
  } catch (error) {
    if (
      capturing &&
      error instanceof Error &&
      (error.message === 'source_drift' ||
        error instanceof UnsupportedSourceEntryError)
    )
      await rpc('invalidate', { code: error.message });
    throw error;
  }
}

export async function runWorkspaceRecoveryWorker(): Promise<void> {
  const rpc = createRecoveryRpc(process.stdin, process.stdout);
  try {
    await runRecoveryWorker(rpc);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'recovery_worker_failed';
    const code = /^[a-z0-9_]{1,64}$/.test(message)
      ? message
      : (error as NodeJS.ErrnoException).code
        ? 'bundle_io_failed'
        : 'protocol_validation_failed';
    await rpc('failure', { code }).catch(() => undefined);
    const detail =
      error instanceof UnsupportedSourceEntryError
        ? ` (${error.reason} at ${JSON.stringify(error.entryPath)})`
        : '';
    process.stderr.write(`${code}: ${message}${detail}\n`);
    process.exitCode = 1;
  } finally {
    process.stdin.destroy();
  }
}
