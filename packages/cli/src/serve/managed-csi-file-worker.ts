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
import {
  validateManagedCsiPodIdentity,
  type ManagedCsiMountReceipt,
} from './managed-csi-envelope.js';
import { ManagedCsiMount } from './managed-csi-mount.js';
import { composeManagedCsiFiles } from './managed-csi-file-composer.js';
import {
  readCsiNativeRequest,
  readCurrentCsiNative,
} from './managed-csi-native-readback.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import {
  CSI_FILE_HISTORY_PATH,
  readCsiFileHistoryEnvelope,
  readCsiFileHistoryObservation,
  readCsiPreparationEvidence,
  type CsiFileHistoryObservation,
} from './managed-csi-file-history-protocol.js';
import {
  CSI_FILE_FINALIZE_PATH,
  CSI_FILE_FINALIZE_LIMIT,
  readCsiFileFinalizeRequest,
  requireSavedCsiApplicationCut,
} from './managed-csi-file-finalize-protocol.js';

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
  let originalMount: ManagedCsiMountReceipt | undefined;
  let retirementId: string | undefined;
  let operationFailed = false;
  type FinalizeRequest = ReturnType<typeof readCsiFileFinalizeRequest>;
  let preCut: { request: FinalizeRequest; result: Promise<Buffer> } | undefined;
  let finalization:
    | { request: FinalizeRequest; result: Promise<Buffer> }
    | undefined;
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
      () => {
        operationFailed = true;
        operations.delete(operation);
      },
    );
    return operation;
  };
  const canInstall = () =>
    !closed && retirementId === undefined && mount.isAvailable;
  const executor = new ManagedToolExecutor(async (reference) =>
    canInstall() && reference.sessionId === boot.identity.sessionId
      ? composition?.tools
      : undefined,
  );
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
        if (closed || (boot.version === 6 && retirementId !== undefined))
          throw new Error();
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
        await track(mount.observe());
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
        if (closed || (boot.version === 6 && retirementId !== undefined))
          throw new Error();
        validateManagedCsiFileAttestationRequest(req.body, boot);
        const observation = await track(mount.observe());
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
        if (
          (boot.version !== 5 && boot.version !== 6) ||
          closed ||
          (boot.version === 6 && retirementId !== undefined)
        )
          throw new Error();
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
    `${MANAGED_CSI_FILE_PREFIX}/execute`,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        const request = readCsiNativeRequest(req.body);
        const installed = installations.installation(boot.identity.sessionId);
        if (
          (boot.version !== 5 && boot.version !== 6) ||
          request.action !== 'execute' ||
          typeof request.subject !== 'string' ||
          !installed ||
          !binding ||
          bindIdentity !== JSON.stringify(installed) ||
          !isDeepStrictEqual(request.identity, boot.identity) ||
          !isDeepStrictEqual(
            request.context,
            createManagedContextAttestationResponse(boot.context),
          ) ||
          !isDeepStrictEqual(request.installedContext, installed) ||
          !canInstall()
        )
          throw new Error();
        const originalBinding = binding;
        const result = await track(
          Promise.resolve().then(async () => {
            await originalBinding;
            if (!canInstall() || !composition) throw new Error();
            const current = await readCurrentCsiNative(
              boot,
              installed,
              'execute',
              request.subject,
            );
            if (!canInstall()) throw new Error();
            const evidence = current.evidence;
            const reference = evidence['executionReference'] as Record<
              string,
              unknown
            >;
            const inputRef = reference['inputRef'] as { resourceId: string };
            const input = (
              evidence['resources'] as Array<{
                reference: { resourceId: string };
                bytesBase64: string;
              }>
            ).find(
              (resource) =>
                resource.reference.resourceId === inputRef.resourceId,
            );
            if (!input) throw new Error();
            const wrapper = parseManagedCsiFileJson(
              Buffer.from(input.bytesBase64, 'base64'),
              64 * 1024,
            ) as Record<string, unknown>;
            const payloadJson = wrapper['payloadJson'];
            if (typeof payloadJson !== 'string') throw new Error();
            const payload = parseManagedCsiFileJson(
              Buffer.from(payloadJson),
              64 * 1024,
            ) as Record<string, unknown>;
            const toolName = payload['toolName'];
            if (
              !['read_file', 'write_file', 'edit'].includes(String(toolName)) ||
              reference['argsDigest'] !==
                `sha256:${createHash('sha256').update(payloadJson).digest('hex')}` ||
              !canInstall()
            )
              throw new Error();
            const preparedRef = evidence['preparedRef'] as {
              resourceId: string;
            } | null;
            if (preparedRef !== null) {
              const preparedResource = (
                evidence['resources'] as Array<{
                  reference: { resourceId: string };
                  bytesBase64: string;
                }>
              ).find(
                (resource) =>
                  resource.reference.resourceId === preparedRef.resourceId,
              );
              if (!preparedResource) throw new Error();
              const preparedBody = parseManagedCsiFileJson(
                Buffer.from(preparedResource.bytesBase64, 'base64'),
                64 * 1024,
              ) as Record<string, unknown>;
              const preparation = preparedBody['preparation'] as Record<
                string,
                unknown
              >;
              const intentRef = preparation['intentRef'] as {
                resourceId: string;
              };
              const saved = preparations.get(intentRef.resourceId);
              const invocation = (
                preparation['invocations'] as Array<Record<string, unknown>>
              ).find((item) => item['executionCallId'] === request.subject);
              if (
                preparedBody['schemaVersion'] !== 2 ||
                preparedBody['profile'] !== boot.identity.profile ||
                preparedBody['runtimeSessionId'] !== boot.identity.sessionId ||
                preparation['stage'] !== 'prepared' ||
                preparation['promptId'] !== reference['promptId'] ||
                preparation['batchId'] !== reference['batchId'] ||
                !saved ||
                !invocation ||
                invocation['toolName'] !== toolName ||
                invocation['requestDigest'] !== reference['argsDigest'] ||
                [
                  'callId',
                  'functionCallId',
                  'partIndex',
                  'ordinal',
                  'inputRef',
                  'toolDefinitionRef',
                ].some(
                  (field) =>
                    !isDeepStrictEqual(invocation[field], reference[field]),
                ) ||
                !isDeepStrictEqual(saved.reference, intentRef) ||
                !isDeepStrictEqual(
                  await saved.observation,
                  readCsiFileHistoryObservation(
                    {
                      state: preparedBody['state'],
                      backupDirectory: preparedBody['backupDirectory'],
                      retainedBackups: preparedBody['retainedBackups'],
                    },
                    boot.identity.sessionId,
                  ),
                ) ||
                !canInstall()
              )
                throw new Error();
            } else if (toolName !== 'read_file') {
              throw new Error();
            }
            return executor.execute(
              {
                sessionId: reference['sessionId'] as string,
                promptId: reference['promptId'] as string,
                callId: reference['callId'] as string,
                argsDigest: reference['argsDigest'] as string,
              },
              toolName as string,
              payload['input'] as Record<string, unknown>,
            );
          }),
        );
        const response = { ...request, state: 'settled', result };
        if (closed || Buffer.byteLength(JSON.stringify(response)) > 64 * 1024)
          throw new Error();
        res.json(response);
      } catch {
        refuse(res, 'managed_csi_execution_unavailable');
      }
    },
    handleManagedRuntimeJsonError,
  );
  app.post(
    CSI_FILE_FINALIZE_PATH,
    ...middleware,
    async (req: Request, res: Response) => {
      try {
        const installed = installations.installation(boot.identity.sessionId);
        if (
          boot.version !== 6 ||
          !installed ||
          !binding ||
          !originalMount ||
          closed ||
          bindIdentity !== JSON.stringify(installed)
        )
          throw new Error();
        const request = readCsiFileFinalizeRequest(
          req.body,
          boot,
          installed,
          pod,
          originalMount,
        );
        if (retirementId !== undefined && retirementId !== request.retirementId)
          throw new Error();
        if (request.operation === 'observe') {
          if (preCut && !isDeepStrictEqual(preCut.request, request))
            throw new Error();
          if (!preCut) {
            retirementId = request.retirementId;
            executor.sealAdmission(request.retirementId);
            const originalBinding = binding;
            const result = (async () => {
              const joined = await Promise.allSettled([
                originalBinding,
                observationTail,
                ...operations,
                ...[...preparations.values()].map(
                  (prepared) => prepared.observation,
                ),
              ]);
              if (
                operationFailed ||
                joined.some((item) => item.status === 'rejected') ||
                closed ||
                !composition
              )
                throw new Error('Original CSI work did not join successfully.');
              const execution = await executor.csiRetirementInventory(
                request.retirementId,
                boot.identity.sessionId,
              );
              if (
                execution.workState !== 'QUIESCENT' ||
                execution.pendingStarts ||
                execution.pendingInvocations
              )
                throw new Error('Original CSI execution is not quiescent.');
              const files = await composition.retirementInventory();
              const prepared = [];
              for (const [resourceId, item] of [...preparations.entries()].sort(
                ([a], [b]) => a.localeCompare(b),
              ))
                prepared.push({
                  resourceId,
                  reference: structuredClone(item.reference),
                  observation: await item.observation,
                });
              if (operations.size || operationFailed || closed)
                throw new Error();
              const bytes = Buffer.from(
                JSON.stringify({
                  ...request,
                  state: 'FROZEN_CANDIDATE',
                  execution,
                  preparations: prepared,
                  files,
                }),
              );
              if (bytes.length > CSI_FILE_FINALIZE_LIMIT) throw new Error();
              return bytes;
            })();
            preCut = { request, result };
          }
          res.type('application/json').send(await preCut.result);
          return;
        }
        if (
          !preCut ||
          preCut.request.retirementId !== request.retirementId ||
          preCut.request.preparedCommitSha256 !== request.preparedCommitSha256
        )
          throw new Error();
        if (finalization && !isDeepStrictEqual(finalization.request, request))
          throw new Error();
        if (!finalization) {
          const candidate = preCut;
          const result = (async () => {
            const observation = await candidate.result;
            if (!composition || operations.size || operationFailed || closed)
              throw new Error();
            const preCutObservationSha256 = createHash('sha256')
              .update(observation)
              .digest('hex');
            await requireSavedCsiApplicationCut(
              boot,
              request,
              preCutObservationSha256,
            );
            const frozen = JSON.parse(observation.toString('utf8')) as {
              execution: unknown;
              files: unknown;
            };
            const execution = await executor.csiRetirementInventory(
              request.retirementId,
              boot.identity.sessionId,
            );
            const files = await composition.retirementInventory();
            if (
              !isDeepStrictEqual(execution, frozen.execution) ||
              !isDeepStrictEqual(files, frozen.files) ||
              operations.size ||
              operationFailed ||
              closed
            )
              throw new Error('Original CSI inventory changed after freezing.');
            await executor.closeCsiFiles(
              request.retirementId,
              boot.identity.sessionId,
            );
            await composition.close();
            const cleanup = await composition.retirementCloseInspection();
            if (
              !cleanup.compositionClosed ||
              !cleanup.backend.closed ||
              cleanup.backend.blocked ||
              cleanup.backend.pendingOperations ||
              cleanup.backend.openDescriptors.length ||
              !cleanup.mount.admissionClosed ||
              cleanup.mount.pendingOperations ||
              cleanup.mount.closeFailed ||
              !cleanup.mount.root.admissionClosed ||
              cleanup.mount.root.pendingOperations ||
              cleanup.mount.root.fd !== null
            )
              throw new Error('Original CSI file descriptors did not close.');
            const bytes = Buffer.from(
              JSON.stringify({
                ...request,
                state: 'DRAINED',
                preCutObservationSha256,
                cleanup,
              }),
            );
            if (bytes.length > CSI_FILE_FINALIZE_LIMIT) throw new Error();
            return bytes;
          })();
          finalization = { request, result };
        }
        res.type('application/json').send(await finalization.result);
      } catch {
        refuse(res, 'managed_csi_finalize_unavailable');
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
      ...(boot.version === 5 || boot.version === 6
        ? [
            { method: 'POST', path: CSI_FILE_HISTORY_PATH },
            { method: 'POST', path: `${MANAGED_CSI_FILE_PREFIX}/execute` },
          ]
        : []),
      ...(boot.version === 6
        ? [{ method: 'POST', path: CSI_FILE_FINALIZE_PATH }]
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
      const joined = await Promise.allSettled([
        ...operations,
        ...(preCut ? [preCut.result] : []),
        ...(finalization ? [finalization.result] : []),
      ]);
      const executed = await Promise.allSettled([executor.close()]);
      const retained = await Promise.allSettled([
        composition ? composition.close() : mount.close(),
      ]);
      const errors = [...results, ...joined, ...executed, ...retained].flatMap(
        (result) => (result.status === 'rejected' ? [result.reason] : []),
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
    originalMount = await mount.observe();
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
