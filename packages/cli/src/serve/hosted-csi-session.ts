/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Application, Response } from 'express';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import {
  assertManagedSessionKey,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHttpManagedSessionStores,
  type HttpManagedSessionStores,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { requestWasAuthenticated } from './auth.js';
import { listenerIdentityOf } from './local-control/listener-identity.js';
import type { HostedHarnessContract } from './hosted-harness-contract.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import {
  runHostedHarnessTurn,
  type HostedTurnSession,
} from './hosted-harness-turn.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEASE_MS = 60_000;

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

interface Admission {
  bindingId: string;
  generation: string;
  workspaceGeneration: string;
  cwd: string;
}

interface Owner {
  key: ManagedSessionKey;
  fingerprint: string;
  initialization: Promise<void>;
  blocked: boolean;
  stopped: boolean;
  admission?: Admission;
  stores?: HttpManagedSessionStores;
  session?: HostedTurnSession;
  timer?: NodeJS.Timeout;
  renewing?: Promise<void>;
  active?: { promptId: string; abort: AbortController };
  tasks: Set<Promise<unknown>>;
  turns: Map<string, { text: string; result: Promise<ChatRecord> }>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Refusal('csi_request_invalid', 400);
  return value as Record<string, unknown>;
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  const body = object(value);
  if (
    Object.keys(body).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(body, k))
  )
    throw new Refusal('csi_request_invalid', 400);
  return body;
}

function active(owner: Owner): void {
  if (owner.blocked || owner.stopped)
    throw new Refusal('csi_attachment_recovery_required');
}

function respond(res: Response, pending: Promise<unknown>): void {
  void pending.then(
    (result) => res.json(result),
    (cause: unknown) => {
      const failure =
        cause instanceof Refusal
          ? cause
          : new Refusal('csi_operation_unavailable', 503);
      res
        .status(failure.status)
        .json({ error: failure.code, code: failure.code });
    },
  );
}

function track<T>(owner: Owner, pending: Promise<T>): Promise<T> {
  owner.tasks.add(pending);
  void pending
    .finally(() => owner.tasks.delete(pending))
    .catch(() => undefined);
  return pending;
}

async function acquire(
  broker: HostedWorkspaceBrokerOptions,
  key: ManagedSessionKey,
): Promise<Admission> {
  const response = await fetch(
    new URL(
      '/internal/runtime-broker/v1/tool-sessions:acquire',
      resolveManagedRuntimeBrokerBaseUrl(broker.baseUrl),
    ),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${broker.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        harnessSessionId: key.sessionId,
        runtimeSessionId: key.sessionId,
        turnKind: 'bootstrap',
      }),
    },
  );
  if (!response.ok) throw new Refusal('csi_runtime_admission_closed');
  const body = object(await response.json());
  const scope = object(body['scope']);
  const runtime = object(body['runtime']);
  const cwd = scope['canonicalCwd'];
  if (
    body['protocolVersion'] !== 1 ||
    body['acquired'] !== true ||
    body['harnessSessionId'] !== key.sessionId ||
    body['runtimeSessionId'] !== key.sessionId ||
    scope['tenantId'] !== key.tenantId ||
    scope['workspaceId'] !== key.workspaceId ||
    scope['capabilityDigest'] !== CSI_FILES_RETIREMENT_CAPABILITY_DIGEST ||
    scope['isolationClass'] !== 'session' ||
    typeof cwd !== 'string' ||
    cwd.length > 4096 ||
    !path.posix.isAbsolute(cwd) ||
    cwd.includes('\0') ||
    cwd.includes('\\') ||
    path.posix.normalize(cwd) !== cwd ||
    typeof scope['workspaceGeneration'] !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(scope['workspaceGeneration']) ||
    typeof runtime['bindingId'] !== 'string' ||
    !UUID.test(runtime['bindingId']) ||
    runtime['generation'] !== '1'
  )
    throw new Refusal('csi_runtime_identity_conflict');
  return {
    cwd,
    bindingId: runtime['bindingId'],
    generation: '1',
    workspaceGeneration: scope['workspaceGeneration'],
  };
}

async function current(
  owner: Owner,
  broker: HostedWorkspaceBrokerOptions,
): Promise<void> {
  active(owner);
  if (!isDeepStrictEqual(await acquire(broker, owner.key), owner.admission))
    throw new Refusal('csi_runtime_identity_conflict');
  await owner.stores!.assertWritable();
  active(owner);
}

async function initialize(
  owner: Owner,
  contract: HostedHarnessContract,
  storeUrl: string,
  writerToken: string,
  broker: HostedWorkspaceBrokerOptions,
): Promise<void> {
  try {
    owner.admission = await acquire(broker, owner.key);
    active(owner);
    const stores = createHttpManagedSessionStores({
      baseUrl: storeUrl,
      sessionKey: owner.key,
      writerId: contract.bootId,
      writerToken,
      leaseDurationMs: LEASE_MS,
    });
    owner.stores = stores;
    const journal = await stores.journalStore.open({ sessionKey: owner.key });
    if ((await stores.publication.owner()).writerGeneration !== 1)
      throw new Refusal('csi_writer_generation_conflict');
    active(owner);
    const definitionRef = await stores.resourceStore.publish(
      'managed-definition',
      Buffer.from(
        JSON.stringify({
          engine: 'managed',
          sessionId: owner.key.sessionId,
          toolProfile: 'csi-files-retirement/1',
        }),
      ),
    );
    const rootSnapshotRef = await stores.resourceStore.publish(
      'managed-root',
      Buffer.from(JSON.stringify({ cwd: owner.admission.cwd })),
    );
    active(owner);
    const authority = await LocalManagedSessionAuthority.open({
      journal,
      resources: stores.resourceStore,
      sessionKey: owner.key,
      cwd: owner.admission.cwd,
      version: 'hosted-harness/1',
      requireNew: true,
      create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
    });
    active(owner);
    const activation = await authority.installActivation({
      activationId: randomUUID(),
      workerId: contract.bootId,
      leaseDurationMs: LEASE_MS,
    });
    if (activation.epoch !== 1)
      throw new Refusal('csi_activation_epoch_conflict');
    active(owner);
    const deny = async () => {
      throw new Refusal('csi_finalize_required');
    };
    const managed: ManagedSession = {
      authority,
      resources: stores.resourceStore,
      sink: new ManagedSessionRecordSink(
        authority,
        stores.resourceStore,
        () => ({ class: 'harness', activation }),
      ),
      activation,
      releaseActivation: deny,
      replaceActivation: deny,
      close: deny,
    };
    owner.session = { managed, cwd: owner.admission.cwd, blocked: false };
    owner.timer = setInterval(() => {
      if (owner.stopped || owner.blocked || owner.renewing) return;
      const pending = authority
        .renewActivation({ leaseDurationMs: LEASE_MS })
        .then(() => undefined)
        .catch(async () => {
          owner.blocked = true;
          owner.session!.blocked = true;
          owner.active?.abort.abort();
          clearInterval(owner.timer);
          await stores.stopLocal();
        });
      owner.renewing = track(owner, pending);
      void pending
        .finally(() => {
          owner.renewing = undefined;
        })
        .catch(() => undefined);
    }, LEASE_MS / 3);
    owner.timer.unref();
  } catch (cause) {
    owner.blocked = true;
    await owner.stores?.stopLocal();
    throw cause;
  }
}

export function registerHostedCsiSessionRoutes(
  app: Application,
  contract: HostedHarnessContract,
  storeUrl: string,
  broker: HostedWorkspaceBrokerOptions,
  ordinaryOwns: (id: string) => boolean,
): { stopLocal: () => Promise<void> } {
  const owners = new Map<string, Owner>();
  let stopped = false;
  app.use('/session/:id/internal-csi', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !requestWasAuthenticated(req) ||
      listenerIdentityOf(req).kind !== 'primary'
    ) {
      res.status(403).json({ code: 'csi_operator_authentication_required' });
      return;
    }
    if (stopped) {
      res.status(409).json({ code: 'csi_attachment_stopped' });
      return;
    }
    if (!UUID.test(req.params['id']!)) {
      res.status(400).json({ code: 'csi_request_invalid' });
      return;
    }
    next();
  });
  app.post('/session/:id/internal-csi/attach', (req, res) => {
    try {
      const id = req.params['id']!;
      const body = closed(req.body, ['tenantId', 'workspaceId', 'writerToken']);
      const writerToken = body['writerToken'];
      if (
        typeof writerToken !== 'string' ||
        !/^[A-Za-z0-9_-]{32,512}$/u.test(writerToken)
      )
        throw new Refusal('csi_request_invalid', 400);
      const tenantId = body['tenantId'];
      const workspaceId = body['workspaceId'];
      if (typeof tenantId !== 'string' || typeof workspaceId !== 'string')
        throw new Refusal('csi_request_invalid', 400);
      let key: ManagedSessionKey;
      try {
        key = assertManagedSessionKey({ tenantId, workspaceId, sessionId: id });
      } catch {
        throw new Refusal('csi_request_invalid', 400);
      }
      if (ordinaryOwns(id)) throw new Refusal('csi_session_owner_conflict');
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ key, writerToken }))
        .digest('hex');
      let owner = owners.get(id);
      if (owner) {
        if (owner.fingerprint !== fingerprint)
          throw new Refusal('csi_session_owner_conflict');
        active(owner);
      } else {
        owner = {
          key,
          fingerprint,
          initialization: Promise.resolve(),
          blocked: false,
          stopped: false,
          tasks: new Set(),
          turns: new Map(),
        };
        owners.set(id, owner);
        owner.initialization = initialize(
          owner,
          contract,
          storeUrl,
          writerToken,
          broker,
        );
      }
      const selected = owner;
      respond(
        res,
        track(
          selected,
          (async () => {
            await selected.initialization;
            await current(selected, broker);
            return { sessionId: id, bootId: contract.bootId, attached: true };
          })(),
        ),
      );
    } catch (cause) {
      respond(res, Promise.reject(cause));
    }
  });
  app.post('/session/:id/internal-csi/text', (req, res) => {
    try {
      const owner = owners.get(req.params['id']!);
      if (!owner?.session) throw new Refusal('csi_attachment_unavailable');
      active(owner);
      const body = closed(req.body, ['promptId', 'text']);
      const promptId = body['promptId'];
      const text = body['text'];
      if (
        typeof promptId !== 'string' ||
        !UUID.test(promptId) ||
        typeof text !== 'string' ||
        !text.trim() ||
        Buffer.byteLength(text) > 16 * 1024
      )
        throw new Refusal('csi_request_invalid', 400);
      const existing = owner.turns.get(promptId);
      if (existing) {
        if (existing.text !== text) throw new Refusal('csi_prompt_conflict');
        respond(
          res,
          track(
            owner,
            current(owner, broker).then(() => existing.result),
          ),
        );
        return;
      }
      if (owner.active) throw new Refusal('csi_turn_active');
      const abort = new AbortController();
      owner.active = { promptId, abort };
      const result = (async () => {
        try {
          await current(owner, broker);
          const prompt = [{ type: 'text', text }];
          const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
          const managed = owner.session!.managed;
          const contentRef = await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify(prompt)),
          );
          const admissionRef = await managed.resources.publish(
            'managed-admission',
            Buffer.from(JSON.stringify({ promptId, digest })),
          );
          active(owner);
          await managed.authority.submitInput(
            {
              operation: 'submitInput',
              commandId: promptId,
              sessionKey: owner.key,
              contentDigest: digest.slice(7),
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
          return await runHostedHarnessTurn({
            session: owner.session!,
            sessionId: owner.key.sessionId,
            cwd: owner.admission!.cwd,
            promptId,
            text,
            abort,
            historyMode: 'settled',
          });
        } catch (cause) {
          owner.blocked = true;
          owner.session!.blocked = true;
          clearInterval(owner.timer);
          await owner.stores!.stopLocal();
          throw cause;
        } finally {
          owner.active = undefined;
        }
      })();
      owner.turns.set(promptId, { text, result });
      respond(res, track(owner, result));
    } catch (cause) {
      respond(res, Promise.reject(cause));
    }
  });
  app.get('/session/:id/internal-csi/history', (req, res) => {
    const owner = owners.get(req.params['id']!);
    if (!owner?.session) {
      respond(res, Promise.reject(new Refusal('csi_attachment_unavailable')));
      return;
    }
    respond(
      res,
      track(
        owner,
        current(owner, broker).then(() =>
          owner.session!.managed.sink.project(),
        ),
      ),
    );
  });
  app.use('/session/:id', (req, res, next) => {
    if (
      req.path.startsWith('/internal-csi') ||
      owners.has(req.params['id']!.toLowerCase())
    ) {
      res.status(409).json({ code: 'csi_private_route_closed' });
      return;
    }
    next();
  });
  app.post('/session', (req, res, next) => {
    const id = (req.body as Record<string, unknown> | undefined)?.['sessionId'];
    if (typeof id === 'string' && owners.has(id.toLowerCase())) {
      res.status(409).json({ code: 'csi_private_route_closed' });
      return;
    }
    next();
  });
  let stopping: Promise<void> | undefined;
  return {
    stopLocal: () => {
      if (stopping) return stopping;
      stopped = true;
      for (const owner of owners.values()) {
        owner.stopped = true;
        if (owner.session) owner.session.blocked = true;
        clearInterval(owner.timer);
        owner.active?.abort.abort();
      }
      stopping = (async () => {
        await Promise.allSettled(
          [...owners.values()].map((owner) => owner.initialization),
        );
        await Promise.allSettled(
          [...owners.values()].flatMap((owner) => [...owner.tasks]),
        );
        await Promise.all(
          [...owners.values()].map((owner) => owner.stores?.stopLocal()),
        );
      })();
      return stopping;
    },
  };
}
