/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeNoStore,
  nameManagedRuntimeIncarnation,
  ownedManagedRuntimeRouteGate,
} from './managed-runtime-attestation-contract.js';
import {
  checkManagedContextAttestation,
  createManagedContextAttestationResponse,
  ManagedContextInstallations,
} from './managed-context-envelope.js';
import {
  MANAGED_CSI_FILE_PREFIX,
  MANAGED_CSI_FILE_PROTOCOL,
  MANAGED_CSI_FILE_ROUTES,
  createManagedCsiFileReady,
  parseManagedCsiFileJson,
  parseManagedCsiFileBoot,
  readManagedCsiFileContext,
  readManagedCsiFileDrain,
  validateManagedCsiFileAttestationRequest,
  validateManagedCsiFileAttestationResponse,
  wrapManagedCsiFileContext,
  type ManagedCsiFileBoot,
  type ManagedCsiFileReady,
} from './managed-csi-file-envelope.js';
import { validateManagedCsiPodIdentity } from './managed-csi-envelope.js';
import { ManagedCsiMount } from './managed-csi-mount.js';
import { composeManagedCsiFiles } from './managed-csi-file-composer.js';
import { readCurrentCsiNative } from './managed-csi-native-readback.js';
import {
  CSI_FILE_HISTORY_PATH,
  readCsiFileHistoryEnvelope,
  readCsiFileHistoryObservation,
  readCsiPreparationEvidence,
  type CsiFileHistoryObservation,
} from './managed-csi-file-history-protocol.js';

export interface ManagedCsiFileWorkerHandle {
  readonly ready: ManagedCsiFileReady;
  close(): Promise<void>;
}

const CONFIG = `sha256:${createHash('sha256')
  .update('csi-files-retirement-tools/1\0csi-files-retirement-policy/1')
  .digest('hex')}`;

export async function startManagedCsiFileWorker(
  bootDocument: ManagedCsiFileBoot,
): Promise<ManagedCsiFileWorkerHandle> {
  const boot = parseManagedCsiFileBoot(bootDocument);
  const pod = {
    uid: process.env['QWEN_POD_UID'],
    namespace: process.env['QWEN_POD_NAMESPACE'],
    nodeName: process.env['QWEN_NODE_NAME'],
  };
  validateManagedCsiPodIdentity(pod, boot.storage.namespace);
  Object.freeze(pod);
  const mount = new ManagedCsiMount(
    boot.context.mountRoot,
    boot.storage.diskSerial,
  );
  const installations = new ManagedContextInstallations(boot.context);
  let closed = false;
  let retirementId: string | undefined;
  let composition:
    | Awaited<ReturnType<typeof composeManagedCsiFiles>>
    | undefined;
  let binding: Promise<CsiFileHistoryObservation> | undefined;
  let bindIdentity: string | undefined;
  let observationTail: Promise<unknown> = Promise.resolve();
  const preparations = new Map<
    string,
    {
      reference: unknown;
      observation: Promise<CsiFileHistoryObservation>;
    }
  >();
  const operations = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };
  const canInstall = () =>
    !closed && retirementId === undefined && mount.isAvailable;
  const app = express();
  app.disable('x-powered-by');
  const refuse = (res: Response, code = 'managed_csi_identity_conflict') =>
    res.status(409).json({
      code,
      error: 'Managed CSI file context is unavailable or conflicts.',
    });
  const middleware = [
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot.context),
    nameManagedRuntimeIncarnation(boot.context),
    express.json({
      inflate: false,
      limit: 16 * 1024,
      strict: true,
      type: 'application/json',
      verify: (_req, _res, bytes) => {
        try {
          parseManagedCsiFileJson(bytes, 16 * 1024);
        } catch {
          throw new SyntaxError('Invalid CSI file request.');
        }
      },
    }),
  ];
  app.post(
    `${MANAGED_CSI_FILE_PREFIX}/context-attest`,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        const outcome = checkManagedContextAttestation(
          readManagedCsiFileContext(req.body, boot),
          boot.context,
        );
        if (outcome.status !== 200) {
          res.status(outcome.status).json({
            code: outcome.code,
            error: 'Managed CSI file identity conflicts.',
          });
          return;
        }
        await mount.observe();
        if (closed || !mount.isAvailable) throw new Error();
        res.json(wrapManagedCsiFileContext(boot, outcome.body));
      } catch {
        refuse(res);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    `${MANAGED_CSI_FILE_PREFIX}/context`,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        const context = readManagedCsiFileContext(req.body, boot);
        if (
          !context ||
          typeof context !== 'object' ||
          !('sessionId' in context) ||
          context.sessionId !== boot.identity.sessionId ||
          !('binding' in context) ||
          !context.binding ||
          typeof context.binding !== 'object' ||
          !('cwdRelative' in context.binding) ||
          context.binding.cwdRelative !== '.' ||
          !('contextConfigRef' in context.binding) ||
          context.binding.contextConfigRef !== CONFIG
        )
          throw new Error();
        if (!canInstall()) {
          refuse(res, 'managed_context_unavailable');
          return;
        }
        const outcome = await installations.install(
          context,
          async () => {
            try {
              await mount.observe();
              return canInstall();
            } catch {
              return false;
            }
          },
          canInstall,
        );
        if (!canInstall()) {
          refuse(res, 'managed_context_unavailable');
          return;
        }
        if (outcome.status !== 200) {
          res.status(outcome.status).json({
            code: outcome.code,
            error: 'Managed CSI file context conflicts.',
          });
          return;
        }
        res.json(wrapManagedCsiFileContext(boot, outcome.body));
      } catch {
        refuse(res);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    `${MANAGED_CSI_FILE_PREFIX}/attest`,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        validateManagedCsiFileAttestationRequest(req.body, boot);
        const observation = await mount.observe();
        if (closed || !mount.isAvailable) throw new Error();
        const response = {
          protocolVersion: 2,
          managedCsi: MANAGED_CSI_FILE_PROTOCOL,
          identity: boot.identity,
          context: createManagedContextAttestationResponse(boot.context),
          storage: boot.storage,
          pod,
          mount: observation,
        };
        validateManagedCsiFileAttestationResponse(response, boot, pod);
        res.json(response);
      } catch {
        refuse(res);
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    CSI_FILE_HISTORY_PATH,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        if (boot.version !== 5 || closed) throw new Error();
        const installed = installations.installation(boot.identity.sessionId);
        if (!installed) throw new Error();
        const operation = readCsiFileHistoryEnvelope(req.body, boot, installed);
        const fingerprint = JSON.stringify(installed);
        let observation: CsiFileHistoryObservation;
        if (operation.action === 'prepare') {
          if (!canInstall() || !binding || fingerprint !== bindIdentity)
            throw new Error();
          const originalBinding = binding;
          const ref = operation.preparationRef;
          let prepared = preparations.get(ref.resourceId);
          if (prepared && !isDeepStrictEqual(prepared.reference, ref))
            throw new Error();
          if (!prepared) {
            const pending = track(
              observationTail
                .catch(() => undefined)
                .then(async () => {
                  await originalBinding;
                  if (!canInstall() || !composition) throw new Error();
                  const current = readCsiPreparationEvidence(
                    await readCurrentCsiNative(boot, installed, 'prepare', ref),
                  );
                  if (!canInstall()) throw new Error();
                  const before = await composition.observe();
                  if (
                    !isDeepStrictEqual(
                      current.observation,
                      readCsiFileHistoryObservation(
                        { state: before.history, ...before.storage },
                        boot.identity.sessionId,
                      ),
                    ) ||
                    !canInstall()
                  )
                    throw new Error();
                  await composition.history.prepare(
                    current.preparation.promptId,
                    current.preparation.paths,
                  );
                  const after = await composition.observe();
                  return readCsiFileHistoryObservation(
                    { state: after.history, ...after.storage },
                    boot.identity.sessionId,
                  );
                }),
            );
            prepared = {
              reference: structuredClone(ref),
              observation: pending,
            };
            preparations.set(ref.resourceId, prepared);
            observationTail = pending;
          }
          observation = await prepared.observation;
        } else if (operation.action === 'bind') {
          if (!canInstall()) throw new Error();
          if (binding && fingerprint !== bindIdentity) throw new Error();
          if (!binding) {
            bindIdentity = fingerprint;
            binding = track(
              Promise.resolve().then(async () => {
                await readCurrentCsiNative(boot, installed, 'bind', null);
                if (!canInstall()) throw new Error();
                composition = await composeManagedCsiFiles({
                  mount,
                  ownerSessionId: boot.identity.sessionId,
                  runtimeSessionId: boot.identity.sessionId,
                  profile: boot.identity.profile,
                  capabilityDigest: boot.identity.capabilityDigest,
                });
                if (!canInstall()) throw new Error();
                const observed = await composition.observe();
                const result = readCsiFileHistoryObservation(
                  { state: observed.history, ...observed.storage },
                  boot.identity.sessionId,
                );
                if (
                  result.state.snapshots.length ||
                  Object.keys(result.state.files).length ||
                  result.retainedBackups.length
                )
                  throw new Error();
                return result;
              }),
            );
          }
          observation = await binding;
        } else {
          if (!binding || fingerprint !== bindIdentity) throw new Error();
          const originalBinding = binding;
          const pending = track(
            observationTail
              .catch(() => undefined)
              .then(async () => {
                await originalBinding;
                if (closed || !composition) throw new Error();
                const observed = await composition.observe();
                return readCsiFileHistoryObservation(
                  { state: observed.history, ...observed.storage },
                  boot.identity.sessionId,
                );
              }),
          );
          observationTail = pending;
          observation = await pending;
        }
        if (closed || (operation.action !== 'snapshot' && !canInstall()))
          throw new Error();
        const response = {
          ...(req.body as Record<string, unknown>),
          observation,
        };
        if (Buffer.byteLength(JSON.stringify(response)) > 64 * 1024)
          throw new Error();
        res.json(response);
      } catch {
        refuse(res, 'managed_csi_history_unavailable');
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    `${MANAGED_CSI_FILE_PREFIX}/drain`,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        const request = readManagedCsiFileDrain(req.body, boot, pod);
        if (
          closed ||
          (retirementId !== undefined &&
            retirementId !== request.retirementId) ||
          (request.operation === 'status' && retirementId === undefined)
        )
          throw new Error();
        if (request.operation === 'seal') retirementId ??= request.retirementId;
        await Promise.allSettled([...operations]);
        res.json({
          protocolVersion: 2,
          managedCsi: MANAGED_CSI_FILE_PROTOCOL,
          identity: boot.identity,
          retirementId: request.retirementId,
          context: createManagedContextAttestationResponse(boot.context),
          storage: boot.storage,
          pod,
          state: 'DRAINING',
          workState: 'BLOCKED',
          pendingStarts: 0,
          pendingInvocations: 0,
          blockers: [
            'file-admission-unavailable',
            ...(binding ? ['retained-history-bound'] : []),
          ].sort(),
        });
      } catch {
        refuse(res, 'managed_csi_drain_conflict');
      }
    },
    handleManagedRuntimeJsonError,
  );
  const server = createServer(
    ownedManagedRuntimeRouteGate(app, [
      ...MANAGED_CSI_FILE_ROUTES,
      ...(boot.version === 5
        ? [{ method: 'POST', path: CSI_FILE_HISTORY_PATH }]
        : []),
    ]),
  );
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    closing ??= (async () => {
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
      ]);
      const joined = await Promise.allSettled([...operations]);
      const retained = await Promise.allSettled([
        composition ? composition.close() : mount.close(),
      ]);
      const errors = [...results, ...joined, ...retained].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          'Managed CSI file worker close failed.',
        );
    })();
    return closing;
  };
  try {
    await mount.observe();
    if (!mount.isAvailable)
      throw new Error('Managed CSI mount is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(43190, '0.0.0.0');
    });
    const address = server.address() as AddressInfo | null;
    if (!address)
      throw new Error('Managed Runtime worker listener is unavailable.');
    return { ready: createManagedCsiFileReady(boot, address.port), close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Managed CSI file worker startup failed.',
      );
    }
    throw error;
  }
}
