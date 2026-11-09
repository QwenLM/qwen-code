/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Application } from 'express';
import type { GenerateContentParameters } from '@google/genai';
import {
  parseStoredTransaction,
  describeTransaction,
  requireStoredTransactionMatches,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { scanManagedSessionJournal } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_SIDE_QUERY_MAX_BYTES,
  MANAGED_SIDE_QUERY_VERSION,
  ManagedSideQueryError,
  prepareManagedSideQuery,
  type ManagedSideQueryPair,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-side-query.js';
import {
  generateManagedSideQuery,
  type ManagedSideQueryResult,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-side-query-model.js';
import type { ContentGeneratorConfig } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import type { HostedHarnessContract } from './hosted-harness-contract.js';
import { parseHostedModelConfig } from './hosted-model-config.js';

interface Claim {
  instanceId: string;
  bootId: string;
  generation: number;
  token: string;
}
interface Submission {
  queryId: string;
  sessionId: string;
  claim: Claim;
  store: { baseUrl: string; token: string; tenantId: string };
  modelConfigDigest: string;
  deadlineAt: number;
}
interface FrozenInput {
  queryId: string;
  sessionId: string;
  tenantId: string;
  workspaceId: string;
  kind: 'btw' | 'recap';
  question: string | null;
  privateHistory: ManagedSideQueryPair[];
  processingVersion: string;
  modelConfigDigest: string;
  deadlineAt: number;
  source: {
    journalRevision: number;
    committedSequence: number;
    lastCommitDigest: string | null;
    completedTurnSequence: number;
  };
}
interface Execution {
  submission: Submission;
  abort: AbortController;
  state: 'accepted' | 'running' | 'settled';
  active: boolean;
}
interface ResultUpdate {
  status: string;
  outcome: string;
  text: string;
  usage?: Record<string, unknown>;
  errorCode?: string;
}

const digest = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedSideQueryError('invalid_side_query');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 4096): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    /[\p{Cc}]/u.test(value)
  )
    throw new ManagedSideQueryError('invalid_side_query');
  return value;
};
const counter = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ManagedSideQueryError('invalid_side_query');
  return Number(value);
};
function parseClaim(value: unknown): Claim {
  const raw = object(value);
  const generation = counter(raw['generation']);
  if (generation < 1) throw new ManagedSideQueryError('invalid_side_query');
  return {
    instanceId: text(raw['instanceId'], 128),
    bootId: text(raw['bootId'], 128),
    generation,
    token: text(raw['token'], 1024),
  };
}
function sameClaim(first: Claim, second: Claim): boolean {
  return (
    first.instanceId === second.instanceId &&
    first.bootId === second.bootId &&
    first.generation === second.generation &&
    timingSafeEqual(
      createHash('sha256').update(first.token).digest(),
      createHash('sha256').update(second.token).digest(),
    )
  );
}
function parseSubmission(
  value: unknown,
  contract: HostedHarnessContract,
): Submission {
  const raw = object(value);
  const store = object(raw['store']);
  const claim = parseClaim(raw['claim']);
  if (
    claim.bootId !== contract.bootId ||
    claim.instanceId !== (contract.instanceId ?? contract.bootId)
  )
    throw new ManagedSideQueryError('side_query_claim_mismatch');
  const queryId = text(raw['queryId'], 128);
  const sessionId = text(raw['sessionId'], 128);
  const url = new URL(text(store['baseUrl']));
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(
      `/sessions/${encodeURIComponent(sessionId)}/side-queries/${encodeURIComponent(queryId)}`,
    )
  )
    throw new ManagedSideQueryError('invalid_side_query_store');
  const deadlineAt = counter(raw['deadlineAt']);
  if (deadlineAt > Date.now() + 300_000)
    throw new ManagedSideQueryError('invalid_side_query_deadline');
  const modelConfigDigest = text(raw['modelConfigDigest'], 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(modelConfigDigest))
    throw new ManagedSideQueryError('invalid_side_query_model_digest');
  return {
    queryId,
    sessionId,
    claim,
    modelConfigDigest,
    deadlineAt,
    store: {
      baseUrl: url.toString().replace(/\/$/, ''),
      token: text(store['token']),
      tenantId: text(store['tenantId'], 128),
    },
  };
}

class QueryStore {
  constructor(
    private readonly execution: Execution,
    private readonly fetchFn: typeof fetch,
  ) {}

  async request(
    path: string,
    body: Record<string, unknown> = {},
    interruptible = true,
  ): Promise<unknown> {
    const { submission, abort } = this.execution;
    const response = await this.fetchFn(`${submission.store.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${submission.store.token}`,
        'X-Qwen-Tenant-Id': submission.store.tenantId,
        'X-Qwen-Managed-Max-Readable-Storage-Version': '4',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ ...body, claim: submission.claim }),
      signal: interruptible
        ? AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ManagedSideQueryError(`side_query_store_${response.status}`);
    }
    if (!response.body)
      throw new ManagedSideQueryError('invalid_side_query_store_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MANAGED_SIDE_QUERY_MAX_BYTES * 2) {
        await reader.cancel();
        throw new ManagedSideQueryError('context_too_large');
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async journal(input: FrozenInput) {
    const chunks: Buffer[] = [];
    let revision = 0;
    let size = 0;
    let activationEpoch = 0;
    const key = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    };
    while (revision < input.source.journalRevision) {
      const page = object(
        await this.request('/transactions', {
          afterRevision: revision,
          limit: 50,
        }),
      );
      if (
        !Array.isArray(page['transactions']) ||
        page['transactions'].length === 0
      )
        throw new ManagedSideQueryError('invalid_frozen_journal');
      for (const raw of page['transactions']) {
        const transaction = parseStoredTransaction(raw);
        if (
          transaction.journalRevision !== revision + 1 ||
          transaction.journalRevision > input.source.journalRevision
        )
          throw new ManagedSideQueryError('invalid_frozen_journal');
        const bytes = Buffer.from(transaction.recordBytesBase64, 'base64');
        size += bytes.byteLength;
        if (size > MANAGED_SIDE_QUERY_MAX_BYTES)
          throw new ManagedSideQueryError('context_too_large');
        if (
          bytes.byteLength !== transaction.byteLength ||
          digest(bytes) !== transaction.recordDigest
        )
          throw new ManagedSideQueryError('invalid_frozen_journal');
        const records = bytes
          .toString('utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown);
        const descriptor = describeTransaction(
          records,
          bytes,
          activationEpoch,
          key,
        );
        requireStoredTransactionMatches(transaction, descriptor);
        activationEpoch = transaction.activationEpoch;
        chunks.push(bytes);
        revision = transaction.journalRevision;
      }
    }
    const scan = scanManagedSessionJournal(Buffer.concat(chunks), key);
    if (
      scan.committed !== input.source.committedSequence ||
      scan.lastMarkerDigest !== input.source.lastCommitDigest ||
      scan.uncommitted !== 0
    )
      throw new ManagedSideQueryError('invalid_frozen_journal');
    return scan.events;
  }

  resources(): ManagedSessionResourceStore {
    let loadedBytes = 0;
    return {
      publish: async () => {
        throw new ManagedSideQueryError('side_query_read_only');
      },
      read: async (ref) => {
        const raw = object(
          await this.request('/resources/read', { resourceId: ref.resourceId }),
        );
        const bytes = Buffer.from(
          text(
            raw['bytes'] ?? raw['bytesBase64'],
            MANAGED_SIDE_QUERY_MAX_BYTES * 2,
          ),
          'base64',
        );
        loadedBytes += bytes.byteLength;
        if (loadedBytes > MANAGED_SIDE_QUERY_MAX_BYTES)
          throw new ManagedSideQueryError('context_too_large');
        if (
          raw['resourceId'] !== ref.resourceId ||
          raw['kind'] !== ref.kind ||
          raw['schemaVersion'] !== ref.schemaVersion ||
          raw['digest'] !== ref.digest ||
          raw['byteLength'] !== ref.byteLength ||
          bytes.byteLength !== ref.byteLength ||
          digest(bytes) !== ref.digest
        )
          throw new ManagedSideQueryError('invalid_side_query_resource');
        return bytes;
      },
    };
  }

  async publish(request: GenerateContentParameters): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(request));
    const refs: ManagedSessionDurableRef[] = [];
    const stage = async (
      kind: string,
      body: Buffer,
    ): Promise<ManagedSessionDurableRef> => {
      if (body.byteLength > 64 * 1024)
        throw new ManagedSideQueryError('context_too_large');
      const ref = {
        resourceId: randomUUID(),
        kind,
        schemaVersion: 1,
        byteLength: body.byteLength,
        digest: digest(body),
      };
      await this.request('/resources/stage', {
        resource: { ...ref, bytesBase64: body.toString('base64') },
      });
      refs.push(ref);
      return ref;
    };
    let root: ManagedSessionDurableRef;
    if (bytes.byteLength <= 64 * 1024)
      root = await stage('managed-side-query-input', bytes);
    else {
      const parts = [];
      for (let offset = 0; offset < bytes.byteLength; offset += 60 * 1024)
        parts.push(
          await stage(
            'managed-side-query-chunk',
            bytes.subarray(offset, offset + 60 * 1024),
          ),
        );
      root = await stage(
        'managed-side-query-input',
        Buffer.from(
          JSON.stringify({
            format: 'qwen-side-query-input/1',
            byteLength: bytes.byteLength,
            digest: digest(bytes),
            parts,
          }),
        ),
      );
    }
    await this.request('/input-ready', {
      publication: {
        resourceId: root.resourceId,
        digest: root.digest,
        resourceIds: refs.map((ref) => ref.resourceId),
      },
    });
  }
}

export function registerHostedSideQueryRoutes(
  app: Application,
  contract: HostedHarnessContract,
  instance: { accepting(): boolean; beginOperation?: () => () => void },
  options: {
    fetchFn?: typeof fetch;
    generate?: (
      model: ContentGeneratorConfig,
      request: GenerateContentParameters,
      signal: AbortSignal,
      onProgress?: (text: string) => void,
    ) => Promise<ManagedSideQueryResult>;
  } = {},
): void {
  const executions = new Map<string, Execution>();
  let active = 0;
  const snapshot = (entry: Execution) => ({
    queryId: entry.submission.queryId,
    state: entry.state,
    active: entry.active,
  });
  const execute = async (entry: Execution): Promise<void> => {
    const finish = instance.beginOperation?.();
    const store = new QueryStore(entry, options.fetchFn ?? globalThis.fetch);
    let startedAt = Date.now();
    let partialText = '';
    let publishedText = '';
    let heartbeatPending = false;
    let heartbeatWork: Promise<void> | undefined;
    let deadlineWork: Promise<unknown> | undefined;
    const result = (update: ResultUpdate) =>
      store.request('/result', { update }, false);
    const deadline = setTimeout(
      () => {
        entry.abort.abort();
        deadlineWork = result({
          status: 'interrupted',
          outcome: 'deadline_exceeded',
          text: partialText,
          errorCode: 'deadline_exceeded',
        }).catch(() => {});
      },
      Math.max(0, entry.submission.deadlineAt - Date.now()),
    );
    const heartbeat = setInterval(() => {
      if (heartbeatPending || entry.abort.signal.aborted) return;
      heartbeatPending = true;
      heartbeatWork = store
        .request('/heartbeat', {}, false)
        .then(async (value) => {
          if (object(value)['active'] !== true) {
            entry.abort.abort();
            return;
          }
          if (
            entry.state === 'running' &&
            !entry.abort.signal.aborted &&
            partialText !== publishedText
          ) {
            publishedText = partialText;
            await result({
              status: 'running',
              outcome: 'pending',
              text: publishedText,
            });
          }
        })
        .catch(() => entry.abort.abort())
        .finally(() => {
          heartbeatPending = false;
        });
    }, 1000);
    try {
      const input = (await store.request('/input')) as FrozenInput;
      if (
        input.queryId !== entry.submission.queryId ||
        input.sessionId !== entry.submission.sessionId ||
        input.tenantId !== entry.submission.store.tenantId ||
        input.modelConfigDigest !== entry.submission.modelConfigDigest ||
        input.deadlineAt !== entry.submission.deadlineAt ||
        input.processingVersion !== MANAGED_SIDE_QUERY_VERSION ||
        !['btw', 'recap'].includes(input.kind) ||
        !Array.isArray(input.privateHistory)
      )
        throw new ManagedSideQueryError('invalid_frozen_input');
      const model = parseHostedModelConfig(
        await store.request('/model-config'),
        entry.submission.modelConfigDigest,
      );
      model.timeout = Math.max(1, input.deadlineAt - Date.now());
      const events = await store.journal(input);
      const request = await prepareManagedSideQuery(
        { ...input, throughSequence: input.source.completedTurnSequence },
        events,
        store.resources(),
        model,
      );
      if (!request) {
        await result({
          status: 'completed',
          outcome: 'insufficient_context',
          text: '',
        });
        return;
      }
      await store.publish(request);
      entry.abort.signal.throwIfAborted();
      const running = object(await store.request('/running'));
      if (running['started'] !== true) return;
      entry.state = 'running';
      entry.abort.signal.throwIfAborted();
      // All resource reads and attachment validation precede the running CAS.
      startedAt = Date.now();
      const response = await (options.generate ?? generateManagedSideQuery)(
        model,
        request,
        entry.abort.signal,
        (text) => {
          partialText = text;
        },
      );
      partialText = response.text;
      let answer = response.text;
      let outcome = response.outcome;
      if (input.kind === 'recap' && outcome === 'success') {
        const tagged = /^\s*<recap>([\s\S]+?)<\/recap>\s*$/iu.exec(answer);
        if (tagged?.[1]?.trim()) answer = tagged[1].trim();
        else outcome = 'invalid_recap';
      }
      if (entry.abort.signal.aborted)
        throw new ManagedSideQueryError('interrupted');
      await heartbeatWork;
      entry.abort.signal.throwIfAborted();
      await result({
        status: outcome === 'success' ? 'completed' : 'failed',
        outcome,
        text: answer,
        usage: {
          ...(response.usage ?? {}),
          model: model.model,
          purpose: input.kind,
          startedAt,
          completedAt: Date.now(),
        },
      });
    } catch (error) {
      const code =
        error instanceof ManagedSideQueryError
          ? error.code
          : entry.abort.signal.aborted
            ? 'interrupted'
            : 'model_error';
      await result({
        status: entry.abort.signal.aborted ? 'interrupted' : 'failed',
        outcome: code,
        text: partialText,
        errorCode: code,
      }).catch(() => {});
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      await heartbeatWork;
      await deadlineWork;
      entry.active = false;
      entry.state = 'settled';
      active -= 1;
      finish?.();
    }
  };

  app.post('/side-queries', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const submission = parseSubmission(req.body, contract);
      const prior = executions.get(submission.queryId);
      if (prior) {
        if (
          !sameClaim(prior.submission.claim, submission.claim) ||
          JSON.stringify(prior.submission) !== JSON.stringify(submission)
        )
          return res.status(409).json({ code: 'side_query_claim_mismatch' });
        return res.status(202).json(snapshot(prior));
      }
      if (!instance.accepting() || active >= 4)
        return res.status(503).json({ code: 'side_query_unavailable' });
      for (const [id, entry] of executions) {
        if (executions.size < 256) break;
        if (!entry.active) executions.delete(id);
      }
      const entry: Execution = {
        submission,
        abort: new AbortController(),
        state: 'accepted',
        active: true,
      };
      executions.set(submission.queryId, entry);
      active += 1;
      void execute(entry);
      return res.status(202).json(snapshot(entry));
    } catch {
      return res.status(400).json({ code: 'invalid_side_query' });
    }
  });
  for (const operation of ['status', 'cancel'] as const)
    app.post(`/side-queries/:id/${operation}`, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const entry = executions.get(req.params['id']);
        const claim = parseClaim(object(req.body)['claim']);
        if (!entry || !sameClaim(entry.submission.claim, claim))
          return res.status(404).json({ code: 'side_query_not_found' });
        if (operation === 'cancel') entry.abort.abort();
        return res
          .status(operation === 'cancel' ? 202 : 200)
          .json(snapshot(entry));
      } catch {
        return res.status(400).json({ code: 'invalid_side_query' });
      }
    });
}
