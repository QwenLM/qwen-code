/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activateOfflineLicense,
  signOfflineLicensePayload,
  verifyOfflineLicense,
} from './offline-license.js';

describe('offline license activation', () => {
  it('activates a signed license with the correct activationHash and verifies locally afterwards', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qwen-license-'));
    const licensePath = path.join(dir, 'license.json');
    const activationPath = path.join(dir, 'activation.json');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({
      format: 'pem',
      type: 'spki',
    }) as string;
    const privateKeyPem = privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;

    const signedLicense = signOfflineLicensePayload(
      {
        customerId: 'gov-customer-a',
        expiresAt: '2099-01-01T00:00:00.000Z',
        seats: 20,
        features: ['agent-cli'],
        activationHash: 'offline-code-from-vendor',
      },
      privateKeyPem,
    );
    await writeJson(licensePath, signedLicense);

    await expect(
      activateOfflineLicense({
        licensePath,
        activationPath,
        publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'offline-code-from-vendor',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      active: true,
      customerId: 'gov-customer-a',
      seats: 20,
    });

    const activation = JSON.parse(await readFile(activationPath, 'utf8'));
    expect(activation).toMatchObject({
      version: 1,
      customerId: 'gov-customer-a',
      activationHashSha256: expect.any(String),
      licenseFingerprint: expect.any(String),
    });
    expect(JSON.stringify(activation)).not.toContain(
      'offline-code-from-vendor',
    );

    await expect(
      verifyOfflineLicense({
        licensePath,
        activationPath,
        publicKeyPem,
        requiredFeature: 'agent-cli',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      active: true,
      customerId: 'gov-customer-a',
      seats: 20,
    });
  });

  it('rejects invalid activationHash values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qwen-license-'));
    const licensePath = path.join(dir, 'license.json');
    const activationPath = path.join(dir, 'activation.json');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({
      format: 'pem',
      type: 'spki',
    }) as string;
    const privateKeyPem = privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;

    const signedLicense = signOfflineLicensePayload(
      {
        customerId: 'gov-customer-b',
        expiresAt: '2099-01-01T00:00:00.000Z',
        seats: 10,
        features: ['agent-cli'],
        activationHash: 'vendor-code',
      },
      privateKeyPem,
    );
    await writeJson(licensePath, signedLicense);

    await expect(
      activateOfflineLicense({
        licensePath,
        activationPath,
        publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'wrong-code',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Offline license activation code is invalid.');
  });

  it('rejects local verification before activation is stored', async () => {
    const fixture = await createSignedFixture();

    await expect(
      verifyOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Offline license is not activated.');
  });

  it('rejects expired licenses before activation', async () => {
    const fixture = await createSignedFixture({
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      activateOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'fixture-code',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Offline license has expired.');
  });

  it('rejects licenses that do not include the required feature', async () => {
    const fixture = await createSignedFixture({
      features: ['other-feature'],
    });

    await expect(
      activateOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'fixture-code',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow(
      'Offline license does not include required feature: agent-cli.',
    );
  });

  it('rejects licenses whose signed payload has been tampered with', async () => {
    const fixture = await createSignedFixture();
    const tampered = {
      ...fixture.signedLicense,
      payload: {
        ...fixture.signedLicense.payload,
        seats: 999,
      },
    };
    await writeJson(fixture.licensePath, tampered);

    await expect(
      activateOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'fixture-code',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Offline license signature is invalid.');
  });

  it('rejects licenses with blank customer IDs', async () => {
    const fixture = await createSignedFixture({
      customerId: '   ',
    });

    await expect(
      activateOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        activationHash: 'fixture-code',
        now: new Date('2026-05-19T00:00:00.000Z'),
      }),
    ).rejects.toThrow('Offline license file has invalid shape.');
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
}

async function createSignedFixture(
  overrides: Partial<Parameters<typeof signOfflineLicensePayload>[0]> = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qwen-license-'));
  const licensePath = path.join(dir, 'license.json');
  const activationPath = path.join(dir, 'activation.json');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({
    format: 'pem',
    type: 'spki',
  }) as string;
  const privateKeyPem = privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }) as string;
  const signedLicense = signOfflineLicensePayload(
    {
      customerId: 'fixture-customer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      seats: 5,
      features: ['agent-cli'],
      activationHash: 'fixture-code',
      ...overrides,
    },
    privateKeyPem,
  );
  await writeJson(licensePath, signedLicense);
  return { licensePath, activationPath, publicKeyPem, signedLicense };
}
