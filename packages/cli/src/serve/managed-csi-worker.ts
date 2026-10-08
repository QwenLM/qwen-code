/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {
  type Application,
  type Request,
  type Response,
} from 'express';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
} from './managed-runtime-attestation-contract.js';
import { createManagedContextAttestationResponse } from './managed-context-envelope.js';
import {
  MANAGED_CSI_ATTEST_PATH,
  MANAGED_CSI_DRAIN_PATH,
  MANAGED_CSI_ACK_PATH,
  MANAGED_CSI_ACK_LIMIT_BYTES,
  MANAGED_CSI_PROTOCOL,
  ManagedCsiDrainRequestError,
  ManagedCsiAckRequestError,
  parseManagedCsiAckRequest,
  parseManagedCsiAckJson,
  parseManagedCsiDrainRequest,
  validateManagedCsiAttestationRequest,
  validateManagedCsiAttestationResponse,
  validateManagedCsiPodIdentity,
  type ManagedCsiBoot,
} from './managed-csi-envelope.js';
import type { ManagedCsiMount } from './managed-csi-mount.js';
import {
  ManagedToolConflictError,
  type ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';

export const MANAGED_CSI_ATTEST_ROUTE = Object.freeze({
  method: 'POST',
  path: MANAGED_CSI_ATTEST_PATH,
});

export const MANAGED_CSI_DRAIN_ROUTE = Object.freeze({
  method: 'POST',
  path: MANAGED_CSI_DRAIN_PATH,
});

export const MANAGED_CSI_ACK_ROUTE = Object.freeze({
  method: 'POST',
  path: MANAGED_CSI_ACK_PATH,
});

export function registerManagedCsiAckRoute(
  app: Application,
  boot: ManagedCsiBoot,
  executor: ManagedToolExecutor,
): void {
  const pod = {
    uid: process.env['QWEN_POD_UID'],
    namespace: process.env['QWEN_POD_NAMESPACE'],
    nodeName: process.env['QWEN_NODE_NAME'],
  };
  validateManagedCsiPodIdentity(pod, boot.storage.namespace);
  app.post(
    MANAGED_CSI_ACK_PATH,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot.context),
    express.json({
      inflate: false,
      limit: MANAGED_CSI_ACK_LIMIT_BYTES,
      strict: true,
      type: 'application/json',
      verify: (_req, _res, bytes) => {
        try {
          parseManagedCsiAckJson(bytes);
        } catch {
          throw new ManagedCsiAckRequestError(400);
        }
      },
    }),
    (req: Request, res: Response) => {
      try {
        const request = parseManagedCsiAckRequest(req.body, boot, pod);
        const confirmed = executor.acknowledgeOriginalCsi(request, boot, pod);
        res.type('application/json').send(confirmed.json);
      } catch (error) {
        if (!(error instanceof ManagedCsiAckRequestError)) throw error;
        res.status(error.status).json({
          code: 'managed_csi_ack_conflict',
          error: 'Managed CSI acknowledgement conflicts.',
        });
      }
    },
    (
      error: unknown,
      req: Request,
      res: Response,
      next: express.NextFunction,
    ) => {
      if (
        (error as { type?: string } | null)?.type === 'entity.verify.failed'
      ) {
        res.status(400).json({
          code: 'managed_csi_ack_conflict',
          error: 'Managed CSI acknowledgement conflicts.',
        });
        return;
      }
      handleManagedRuntimeJsonError(error, req, res, next);
    },
  );
}

export function registerManagedCsiDrainRoute(
  app: Application,
  boot: ManagedCsiBoot,
  executor: ManagedToolExecutor,
): void {
  const pod = {
    uid: process.env['QWEN_POD_UID'],
    namespace: process.env['QWEN_POD_NAMESPACE'],
    nodeName: process.env['QWEN_NODE_NAME'],
  };
  validateManagedCsiPodIdentity(pod, boot.storage.namespace);
  app.post(
    MANAGED_CSI_DRAIN_PATH,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot.context),
    managedRuntimeJsonBody(16 * 1024),
    (req: Request, res: Response) => {
      try {
        const request = parseManagedCsiDrainRequest(req.body, boot, pod);
        if (request.operation === 'seal')
          executor.sealAdmission(request.retirementId);
        res.json({
          protocolVersion: 1,
          managedCsi: MANAGED_CSI_PROTOCOL,
          retirementId: request.retirementId,
          context: createManagedContextAttestationResponse(boot.context),
          storage: boot.storage,
          pod,
          ...executor.getDrainObservation(request.retirementId),
        });
      } catch (error) {
        if (
          !(error instanceof ManagedCsiDrainRequestError) &&
          !(error instanceof ManagedToolConflictError)
        )
          throw error;
        res
          .status(
            error instanceof ManagedCsiDrainRequestError ? error.status : 409,
          )
          .json({
            code: 'managed_csi_drain_conflict',
            error: 'Managed CSI drain request conflicts.',
          });
      }
    },
    handleManagedRuntimeJsonError,
  );
}

export function registerManagedCsiAttestationRoute(
  app: Application,
  boot: ManagedCsiBoot,
  mount: ManagedCsiMount,
): void {
  const pod = {
    uid: process.env['QWEN_POD_UID'],
    namespace: process.env['QWEN_POD_NAMESPACE'],
    nodeName: process.env['QWEN_NODE_NAME'],
  };
  validateManagedCsiPodIdentity(pod, boot.storage.namespace);
  app.post(
    MANAGED_CSI_ATTEST_PATH,
    managedRuntimeNoStore,
    authorizeManagedRuntime(boot.context),
    managedRuntimeJsonBody(16 * 1024),
    async (req: Request, res: Response) => {
      try {
        validateManagedCsiAttestationRequest(req.body, boot);
      } catch {
        res.status(409).json({
          code: 'managed_csi_identity_conflict',
          error: 'Managed CSI identity conflicts.',
        });
        return;
      }
      try {
        const observation = await mount.observe();
        if (!mount.isAvailable) throw new Error();
        const response = {
          protocolVersion: 1,
          managedCsi: MANAGED_CSI_PROTOCOL,
          context: createManagedContextAttestationResponse(boot.context),
          storage: boot.storage,
          pod,
          mount: observation,
        };
        validateManagedCsiAttestationResponse(response, boot, pod);
        res.status(200).json(response);
      } catch {
        res.status(409).json({
          code: 'managed_csi_mount_unavailable',
          error: 'Managed CSI mount is unavailable.',
        });
      }
    },
    handleManagedRuntimeJsonError,
  );
}
