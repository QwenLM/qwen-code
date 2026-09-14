/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import prompts from 'prompts';
import { signOfflineLicensePayload } from '@qwen-code/qwen-code-core';
import { ensureOfflineLicense } from './offlineLicense.js';

vi.mock('prompts');

describe('ensureOfflineLicense', () => {
  beforeEach(() => {
    vi.mocked(prompts).mockReset();
  });

  it('prompts for the activationHash on first interactive startup and stores local activation', async () => {
    const fixture = await createSignedFixture();
    vi.mocked(prompts).mockResolvedValue({ value: ' fixture-code ' });

    await expect(
      ensureOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        interactive: true,
      }),
    ).resolves.toMatchObject({
      active: true,
      customerId: 'fixture-customer',
    });

    const activation = await readFile(fixture.activationPath, 'utf8');
    expect(activation).toContain('"activationHashSha256"');
    expect(activation).not.toContain('fixture-code');
  });

  it('blocks without prompting when startup is non-interactive and activation is missing', async () => {
    const fixture = await createSignedFixture();

    await expect(
      ensureOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        interactive: false,
      }),
    ).rejects.toThrow('Offline license is not activated.');
    expect(prompts).not.toHaveBeenCalled();
  });

  it('fails clearly when interactive activation is cancelled', async () => {
    const fixture = await createSignedFixture();
    vi.mocked(prompts).mockResolvedValue({ value: undefined });

    await expect(
      ensureOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        interactive: true,
      }),
    ).rejects.toThrow('Offline license activation was cancelled.');
  });

  it('rejects a wrong activationHash from the prompt', async () => {
    const fixture = await createSignedFixture();
    vi.mocked(prompts).mockResolvedValue({ value: 'wrong-code' });

    await expect(
      ensureOfflineLicense({
        licensePath: fixture.licensePath,
        activationPath: fixture.activationPath,
        publicKeyPem: fixture.publicKeyPem,
        requiredFeature: 'agent-cli',
        interactive: true,
      }),
    ).rejects.toThrow('Offline license activation code is invalid.');
  });
});

async function createSignedFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qwen-cli-license-'));
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

  await writeFile(
    licensePath,
    `${JSON.stringify(
      signOfflineLicensePayload(
        {
          customerId: 'fixture-customer',
          expiresAt: '2099-01-01T00:00:00.000Z',
          seats: 5,
          features: ['agent-cli'],
          activationHash: 'fixture-code',
        },
        privateKeyPem,
      ),
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { licensePath, activationPath, publicKeyPem };
}
