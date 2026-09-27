/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Application, RequestHandler } from 'express';
import type { HostedHarnessCapabilities } from './types.js';

export const HOSTED_HARNESS_CAPABILITY_DIGEST_ENV =
  'QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST';
export const HOSTED_HARNESS_PROTOCOL_VERSION = 1 as const;
export const HOSTED_HARNESS_PROTOCOL_HEADER = 'X-Qwen-Harness-Protocol-Version';
export const HOSTED_HARNESS_BOOT_ID_HEADER = 'X-Qwen-Harness-Boot-Id';
export const HOSTED_HARNESS_UPGRADE = 'qwen-hosted-harness/1';

const CAPABILITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type HostedHarnessContract = HostedHarnessCapabilities;

export function isHostedHarnessCapabilityDigest(value: string): boolean {
  return CAPABILITY_DIGEST_PATTERN.test(value);
}

export function createHostedHarnessContract(
  capabilityDigest: string,
  bootId: string = randomUUID(),
): HostedHarnessContract {
  if (!isHostedHarnessCapabilityDigest(capabilityDigest)) {
    throw new Error(
      `${HOSTED_HARNESS_CAPABILITY_DIGEST_ENV} must be sha256:<64 lowercase hex characters>.`,
    );
  }
  if (!UUID_PATTERN.test(bootId)) {
    throw new Error('Hosted Harness bootId must be an RFC UUID v1-v5.');
  }
  return Object.freeze({
    protocolVersions: Object.freeze({
      current: HOSTED_HARNESS_PROTOCOL_VERSION,
      supported: Object.freeze([HOSTED_HARNESS_PROTOCOL_VERSION] as const),
    }),
    bootId: bootId.toLowerCase(),
    capabilityDigest,
  });
}

export function hostedHarnessContractMiddleware(
  contract: HostedHarnessContract,
): RequestHandler {
  return (req, res, next): void => {
    res.setHeader(HOSTED_HARNESS_BOOT_ID_HEADER, contract.bootId);

    if (
      req.get(HOSTED_HARNESS_PROTOCOL_HEADER) !==
      String(HOSTED_HARNESS_PROTOCOL_VERSION)
    ) {
      res.setHeader('Upgrade', HOSTED_HARNESS_UPGRADE);
      res.status(426).json({
        error: 'Hosted Harness protocol version 1 is required.',
        code: 'hosted_harness_protocol_required',
      });
      return;
    }

    const requestedBootId = req.get(HOSTED_HARNESS_BOOT_ID_HEADER);
    if (!requestedBootId || !UUID_PATTERN.test(requestedBootId)) {
      res.status(400).json({
        error: 'X-Qwen-Harness-Boot-Id must be an RFC UUID v1-v5.',
        code: 'invalid_hosted_harness_boot_id',
      });
      return;
    }
    if (requestedBootId.toLowerCase() !== contract.bootId) {
      res.status(409).json({
        error: 'Hosted Harness process generation changed.',
        code: 'hosted_harness_generation_mismatch',
      });
      return;
    }
    next();
  };
}

export function installHostedHarnessContractMiddleware(
  app: Application,
  contract: HostedHarnessContract | undefined,
): void {
  if (!contract) return;
  app.use('/session', hostedHarnessContractMiddleware(contract));
}
