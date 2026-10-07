/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import { parseManagedCsiBoot } from './managed-csi-envelope.js';
import { ManagedCsiMount } from './managed-csi-mount.js';
import { registerManagedContextRoutes } from './managed-context-worker.js';
import {
  readManagedRuntimeContainerBoot,
  readManagedRuntimeWorkerBoot,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';

const fixture = JSON.parse(
  await fs.readFile(
    new URL(
      './contracts/managed-csi-worker-ack-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { boot: unknown };
const csiBoot = parseManagedCsiBoot(fixture.boot);
const privateContext = {
  ...csiBoot.context,
  capabilityDigest: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
};
const legacyBoot = {
  type: 'boot',
  version: 1,
  token: privateContext.token,
  runtimeInstanceId: privateContext.runtimeInstanceId,
  runtimeIncarnation: privateContext.runtimeIncarnation,
  leaseId: privateContext.leaseId,
  epoch: privateContext.epoch,
  provisionRequestId: privateContext.provisionRequestId,
  tenantId: privateContext.tenantId,
  workspaceId: privateContext.workspaceId,
  workspaceGeneration: privateContext.workspaceGeneration,
  workspaceCwd: privateContext.mountRoot,
  capabilityDigest: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
  isolationClass: 'session',
} satisfies ManagedRuntimeWorkerBoot;
const privateCsiBoot = { ...csiBoot, context: privateContext };
const workers = new Set<ManagedRuntimeAttestationWorkerHandle>();

afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.close()));
  workers.clear();
  vi.restoreAllMocks();
});

describe('reserved private CSI file profile', () => {
  it('pins the registered manifest without enabling a worker', () => {
    const manifest = JSON.stringify({
      profile: 'csi-files-retirement/1',
      tools: ['read_file', 'write_file', 'edit'],
      fileHistory: true,
      invocationProtocol: 2,
      resultRetention: 'until-finalize',
    });
    expect(
      `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    ).toBe(CSI_FILES_RETIREMENT_CAPABILITY_DIGEST);
  });

  it.each([legacyBoot, privateContext])(
    'rejects reserved stdin boot $version',
    async (boot) => {
      await expect(
        readManagedRuntimeWorkerBoot(Readable.from([JSON.stringify(boot)])),
      ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
    },
  );

  it.each([legacyBoot, privateCsiBoot])(
    'rejects reserved container boot $version',
    async (boot) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'csi-guard-'));
      try {
        const bootPath = path.join(directory, 'boot.json');
        await fs.writeFile(bootPath, JSON.stringify(boot));
        await expect(readManagedRuntimeContainerBoot(bootPath)).rejects.toThrow(
          'Managed Runtime worker boot payload is invalid.',
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([legacyBoot, privateContext, privateCsiBoot])(
    'refuses direct boot $version before mount observation or a listener',
    async (boot) => {
      const observation = vi
        .spyOn(ManagedCsiMount.prototype, 'observe')
        .mockRejectedValue(new Error('Unexpected CSI mount observation.'));
      const listen = vi.spyOn(Server.prototype, 'listen');
      await expect(
        startManagedRuntimeAttestationWorker(
          boot,
          undefined,
          undefined,
          boot.version === 3,
        ).then((worker) => {
          workers.add(worker);
          return worker;
        }),
      ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
      expect(observation).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'workspace'] as const)(
    'rejects a direct legacy factory with %s isolation before registering routes',
    (isolationClass) => {
      const app = express();
      const post = vi.spyOn(app, 'post');
      expect(() =>
        registerManagedContextRoutes(app, {
          ...privateContext,
          isolationClass,
        }),
      ).toThrow('Private CSI file profile requires its dedicated worker.');
      expect(post).not.toHaveBeenCalled();
    },
  );
});
