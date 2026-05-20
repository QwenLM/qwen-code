/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const OFFLINE_LICENSE_VERSION = 1;
export const OFFLINE_ACTIVATION_VERSION = 1;

export interface OfflineLicensePayload {
  customerId: string;
  expiresAt: string;
  seats: number;
  features: string[];
  /**
   * Vendor-generated offline activation code. The customer pastes this value
   * during first launch; Qwen Code stores only its SHA-256 digest locally.
   */
  activationHash: string;
}

export interface SignedOfflineLicense {
  version: typeof OFFLINE_LICENSE_VERSION;
  payload: OfflineLicensePayload;
  signature: {
    algorithm: 'ed25519';
    value: string;
  };
}

export interface OfflineActivation {
  version: typeof OFFLINE_ACTIVATION_VERSION;
  customerId: string;
  activatedAt: string;
  activationHashSha256: string;
  licenseFingerprint: string;
}

export interface OfflineLicenseStatus {
  active: true;
  customerId: string;
  seats: number;
  features: string[];
  expiresAt: string;
}

export interface VerifyOfflineLicenseOptions {
  licensePath: string;
  activationPath: string;
  publicKeyPem: string;
  requiredFeature: string;
  now?: Date;
}

export interface ActivateOfflineLicenseOptions
  extends VerifyOfflineLicenseOptions {
  activationHash: string;
}

export class OfflineLicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineLicenseError';
  }
}

export function signOfflineLicensePayload(
  payload: OfflineLicensePayload,
  privateKeyPem: string,
): SignedOfflineLicense {
  const signature = sign(null, Buffer.from(canonicalJson(payload)), {
    key: privateKeyPem,
  }).toString('base64');

  return {
    version: OFFLINE_LICENSE_VERSION,
    payload,
    signature: {
      algorithm: 'ed25519',
      value: signature,
    },
  };
}

export async function verifyOfflineLicense(
  options: VerifyOfflineLicenseOptions,
): Promise<OfflineLicenseStatus> {
  const license = await readSignedLicense(options.licensePath);
  validateSignedLicense(license, options.publicKeyPem);
  validatePayload(license.payload, options.requiredFeature, options.now);

  const activation = await readActivation(options.activationPath);
  const fingerprint = fingerprintLicense(license);
  if (activation.licenseFingerprint !== fingerprint) {
    throw new OfflineLicenseError(
      'Offline license activation does not match this license.',
    );
  }
  if (activation.customerId !== license.payload.customerId) {
    throw new OfflineLicenseError(
      'Offline license activation customer does not match this license.',
    );
  }
  if (
    activation.activationHashSha256 !==
    sha256Hex(license.payload.activationHash)
  ) {
    throw new OfflineLicenseError(
      'Offline license activation code does not match this license.',
    );
  }

  return toStatus(license.payload);
}

export async function activateOfflineLicense(
  options: ActivateOfflineLicenseOptions,
): Promise<OfflineLicenseStatus> {
  const license = await readSignedLicense(options.licensePath);
  validateSignedLicense(license, options.publicKeyPem);
  validatePayload(license.payload, options.requiredFeature, options.now);

  if (options.activationHash !== license.payload.activationHash) {
    throw new OfflineLicenseError(
      'Offline license activation code is invalid.',
    );
  }

  const activation: OfflineActivation = {
    version: OFFLINE_ACTIVATION_VERSION,
    customerId: license.payload.customerId,
    activatedAt: (options.now ?? new Date()).toISOString(),
    activationHashSha256: sha256Hex(options.activationHash),
    licenseFingerprint: fingerprintLicense(license),
  };
  await mkdir(path.dirname(options.activationPath), { recursive: true });
  await writeFile(
    options.activationPath,
    `${JSON.stringify(activation, null, 2)}\n`,
    'utf8',
  );

  return toStatus(license.payload);
}

async function readSignedLicense(
  licensePath: string,
): Promise<SignedOfflineLicense> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(licensePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OfflineLicenseError('Offline license file is missing.');
    }
    throw new OfflineLicenseError('Offline license file is invalid JSON.');
  }

  if (!isSignedOfflineLicense(parsed)) {
    throw new OfflineLicenseError('Offline license file has invalid shape.');
  }
  return parsed;
}

async function readActivation(
  activationPath: string,
): Promise<OfflineActivation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(activationPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OfflineLicenseError('Offline license is not activated.');
    }
    throw new OfflineLicenseError('Offline activation file is invalid JSON.');
  }

  if (!isActivation(parsed)) {
    throw new OfflineLicenseError('Offline activation file has invalid shape.');
  }
  return parsed;
}

function validateSignedLicense(
  license: SignedOfflineLicense,
  publicKeyPem: string,
): void {
  const valid = verify(
    null,
    Buffer.from(canonicalJson(license.payload)),
    { key: publicKeyPem },
    Buffer.from(license.signature.value, 'base64'),
  );
  if (!valid) {
    throw new OfflineLicenseError('Offline license signature is invalid.');
  }
}

function validatePayload(
  payload: OfflineLicensePayload,
  requiredFeature: string,
  now: Date = new Date(),
): void {
  if (!Number.isInteger(payload.seats) || payload.seats <= 0) {
    throw new OfflineLicenseError('Offline license seat count is invalid.');
  }
  const expiresAt = new Date(payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new OfflineLicenseError('Offline license expiry is invalid.');
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new OfflineLicenseError('Offline license has expired.');
  }
  if (!payload.features.includes(requiredFeature)) {
    throw new OfflineLicenseError(
      `Offline license does not include required feature: ${requiredFeature}.`,
    );
  }
}

function toStatus(payload: OfflineLicensePayload): OfflineLicenseStatus {
  return {
    active: true,
    customerId: payload.customerId,
    seats: payload.seats,
    features: [...payload.features],
    expiresAt: payload.expiresAt,
  };
}

function fingerprintLicense(license: SignedOfflineLicense): string {
  return sha256Hex(canonicalJson(license));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortForCanonicalJson(record[key])]),
    );
  }
  return value;
}

function isSignedOfflineLicense(value: unknown): value is SignedOfflineLicense {
  if (!isRecord(value)) return false;
  if (value['version'] !== OFFLINE_LICENSE_VERSION) return false;
  if (!isOfflineLicensePayload(value['payload'])) return false;
  const signature = value['signature'];
  return (
    isRecord(signature) &&
    signature['algorithm'] === 'ed25519' &&
    typeof signature['value'] === 'string' &&
    signature['value'].length > 0
  );
}

function isOfflineLicensePayload(
  value: unknown,
): value is OfflineLicensePayload {
  return (
    isRecord(value) &&
    typeof value['customerId'] === 'string' &&
    value['customerId'].trim().length > 0 &&
    typeof value['expiresAt'] === 'string' &&
    typeof value['seats'] === 'number' &&
    Array.isArray(value['features']) &&
    value['features'].every((feature) => typeof feature === 'string') &&
    typeof value['activationHash'] === 'string' &&
    value['activationHash'].length > 0
  );
}

function isActivation(value: unknown): value is OfflineActivation {
  return (
    isRecord(value) &&
    value['version'] === OFFLINE_ACTIVATION_VERSION &&
    typeof value['customerId'] === 'string' &&
    typeof value['activatedAt'] === 'string' &&
    typeof value['activationHashSha256'] === 'string' &&
    typeof value['licenseFingerprint'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
