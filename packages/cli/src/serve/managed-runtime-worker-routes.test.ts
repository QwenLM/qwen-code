/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MANAGED_TOOL_RESULT_ROUTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  resolveManagedRuntimeWorkerRoutePlan,
  type ManagedRuntimeWorkerRouteInput,
} from './managed-runtime-worker-routes.js';
import {
  MEASURED_WORKSPACE_CAPABILITY_DIGEST,
  MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST,
  RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CAPABILITY_DIGEST,
  resolveManagedShellPublisherMode,
} from './managed-workspace-activation.js';
import { MANAGED_TERMINAL_WORKER_ROUTE } from './managed-terminal-routes.js';
import { OWNED_MANAGED_RUNTIME_ROUTES } from './managed-runtime-attestation-contract.js';
import { MANAGED_CONTEXT_WORKER_ROUTES } from './managed-context-worker.js';
import { MANAGED_RUNTIME_PROVIDER_ROUTE } from './managed-runtime-provider-protocol.js';
import { MANAGED_RUNTIME_TOOL_V4_ROUTES } from './managed-runtime-tool-v4-routes.js';
import {
  MANAGED_EXTENSION_RETIRE_ROUTE,
  MANAGED_EXTENSION_RUNTIME_ROUTE,
  MANAGED_EXTENSION_UPLOAD_ROUTE,
} from './managed-extension-runtime.js';
import { MANAGED_EXTENSION_COMMAND_ROUTE } from './managed-extension-command-runtime.js';
import {
  MANAGED_CSI_ACK_ROUTE,
  MANAGED_CSI_ATTEST_ROUTE,
  MANAGED_CSI_DRAIN_ROUTE,
} from './managed-csi-worker.js';
import { MANAGED_SHELL_PUBLISHER_ROUTE } from './managed-shell-publisher.js';
import { PUBLICATION_INSTALL_ROUTE } from './remote-shell-result-publication.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';

const PLAIN_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SSH_ROUTE = Object.freeze({
  method: 'POST',
  path: '/internal/managed-runtime/v3/ssh-test',
});
const EXTENSION_ROUTES = [
  MANAGED_EXTENSION_RUNTIME_ROUTE,
  MANAGED_EXTENSION_UPLOAD_ROUTE,
  MANAGED_EXTENSION_RETIRE_ROUTE,
  MANAGED_EXTENSION_COMMAND_ROUTE,
];
const CSI_ROUTES = [
  MANAGED_CSI_ATTEST_ROUTE,
  MANAGED_CSI_DRAIN_ROUTE,
  MANAGED_CSI_ACK_ROUTE,
];

const routeKey = (route: { method: string; path: string }) =>
  `${route.method} ${route.path}`;
const keys = (routes: ReadonlyArray<{ method: string; path: string }>) =>
  [...new Set(routes.map(routeKey))].sort();

function planInput(
  overrides: Partial<ManagedRuntimeWorkerRouteInput> = {},
): ManagedRuntimeWorkerRouteInput {
  return {
    bootVersion: 2,
    capabilityDigest: PLAIN_DIGEST,
    managedExtensions: false,
    csi: false,
    capturePublisher: false,
    remotePublishers: false,
    publication: false,
    ...overrides,
  };
}

describe('resolveManagedShellPublisherMode', () => {
  it.each([
    // digest, extensions, capture, remotePublishers, expected
    [
      WORKSPACE_CAPABILITY_DIGEST,
      false,
      false,
      false,
      {
        resident: false,
        requiresActivation: true,
        remotePublisher: true,
        publisher: true,
        installRoute: true,
      },
    ],
    [
      RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
      true,
      false,
      false,
      {
        resident: true,
        requiresActivation: true,
        remotePublisher: false,
        publisher: false,
        installRoute: false,
      },
    ],
    [
      PLAIN_DIGEST,
      true,
      false,
      false,
      {
        resident: false,
        requiresActivation: true,
        remotePublisher: true,
        publisher: true,
        installRoute: true,
      },
    ],
    [
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      false,
      true,
      false,
      {
        resident: false,
        requiresActivation: true,
        remotePublisher: false,
        publisher: true,
        installRoute: false,
      },
    ],
    [
      PLAIN_DIGEST,
      false,
      false,
      true,
      {
        resident: false,
        requiresActivation: false,
        remotePublisher: false,
        publisher: true,
        installRoute: false,
      },
    ],
    [
      RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
      false,
      false,
      false,
      {
        resident: true,
        requiresActivation: true,
        remotePublisher: false,
        publisher: false,
        installRoute: false,
      },
    ],
  ] as const)(
    'pins the publisher surface for %s (ext=%s capture=%s remote=%s)',
    (
      digest,
      managedExtensions,
      capturePublisher,
      remotePublishers,
      expected,
    ) => {
      expect(
        resolveManagedShellPublisherMode({
          capabilityDigest: digest,
          managedExtensions,
          capturePublisher,
          remotePublishers,
        }),
      ).toEqual(expected);
    },
  );
});

describe('resolveManagedRuntimeWorkerRoutePlan', () => {
  const base = keys(MANAGED_CONTEXT_WORKER_ROUTES);

  it('boot v1 admits exactly the owned v2 routes and the provider route', () => {
    const plan = resolveManagedRuntimeWorkerRoutePlan(
      planInput({ bootVersion: 1 }),
    );
    expect(keys(plan.routes)).toEqual(
      keys([...OWNED_MANAGED_RUNTIME_ROUTES, MANAGED_RUNTIME_PROVIDER_ROUTE]),
    );
  });

  it.each([
    ['plain minimal', planInput(), base],
    [
      'workspace tools',
      planInput({ capabilityDigest: WORKSPACE_CAPABILITY_DIGEST }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        PUBLICATION_INSTALL_ROUTE,
      ]),
    ],
    [
      'measured workspace tools',
      planInput({ capabilityDigest: MEASURED_WORKSPACE_CAPABILITY_DIGEST }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        ...MANAGED_RUNTIME_TOOL_V4_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        PUBLICATION_INSTALL_ROUTE,
      ]),
    ],
    [
      'terminal-capable measured workspace',
      planInput({
        capabilityDigest: MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST,
      }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        MANAGED_TERMINAL_WORKER_ROUTE,
        ...MANAGED_RUNTIME_TOOL_V4_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        PUBLICATION_INSTALL_ROUTE,
      ]),
    ],
    [
      'resident files only',
      planInput({ capabilityDigest: RESIDENT_WORKSPACE_CAPABILITY_DIGEST }),
      base,
    ],
    [
      // The documented tightening: the install route was never mounted for
      // resident capability, so the plan no longer admits it either.
      'resident with extensions',
      planInput({
        capabilityDigest: RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
        managedExtensions: true,
      }),
      keys([...MANAGED_CONTEXT_WORKER_ROUTES, ...EXTENSION_ROUTES]),
    ],
    [
      'plain with extensions',
      planInput({ managedExtensions: true }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        ...EXTENSION_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        PUBLICATION_INSTALL_ROUTE,
      ]),
    ],
    [
      'workspace with capture publisher',
      planInput({
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
        capturePublisher: true,
      }),
      keys([...MANAGED_CONTEXT_WORKER_ROUTES, ...MANAGED_TOOL_RESULT_ROUTES]),
    ],
    [
      'workspace with external publication',
      planInput({
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
        publication: true,
      }),
      keys([...MANAGED_CONTEXT_WORKER_ROUTES, ...MANAGED_TOOL_RESULT_ROUTES]),
    ],
    [
      'workspace with remote publishers',
      planInput({
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
        remotePublishers: true,
      }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        PUBLICATION_INSTALL_ROUTE,
        MANAGED_SHELL_PUBLISHER_ROUTE,
      ]),
    ],
    [
      'plain with remote publishers only',
      planInput({ remotePublishers: true }),
      keys([
        ...MANAGED_CONTEXT_WORKER_ROUTES,
        ...MANAGED_TOOL_RESULT_ROUTES,
        MANAGED_SHELL_PUBLISHER_ROUTE,
      ]),
    ],
    [
      'plain with CSI',
      planInput({ csi: true }),
      keys([...MANAGED_CONTEXT_WORKER_ROUTES, ...CSI_ROUTES]),
    ],
    [
      'plain with SSH',
      planInput({ sshRoute: SSH_ROUTE }),
      keys([...MANAGED_CONTEXT_WORKER_ROUTES, SSH_ROUTE]),
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(keys(resolveManagedRuntimeWorkerRoutePlan(input).routes)).toEqual(
      expected,
    );
  });
});

// Behavioral conformance: boot the real worker and probe every known route.
// The gate refuses with an empty-body 404; anything that passes the gate is
// distinguishable (Express 404 carries HTML, handlers carry JSON).

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-context-v1.fixtures.json',
    ),
    'utf8',
  ),
) as { boot: ManagedContextBoot };

const UNIVERSE = keys([
  ...OWNED_MANAGED_RUNTIME_ROUTES,
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  ...MANAGED_CONTEXT_WORKER_ROUTES,
  ...MANAGED_RUNTIME_TOOL_V4_ROUTES,
  MANAGED_TERMINAL_WORKER_ROUTE,
  ...MANAGED_TOOL_RESULT_ROUTES,
  ...EXTENSION_ROUTES,
  ...CSI_ROUTES,
  MANAGED_SHELL_PUBLISHER_ROUTE,
  PUBLICATION_INSTALL_ROUTE,
  SSH_ROUTE,
  { method: 'POST', path: '/internal/managed-runtime/v3/definitely-unknown' },
]);

const openWorkers = new Set<ManagedRuntimeAttestationWorkerHandle>();
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all([...openWorkers].map((worker) => worker.close()));
  openWorkers.clear();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempMountRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-route-plan-'));
  const real = await fs.promises.realpath(root);
  tempRoots.push(real);
  return real;
}

async function probeWorker(
  boot: ManagedContextBoot | ManagedRuntimeWorkerBoot,
  input: ManagedRuntimeWorkerRouteInput,
): Promise<void> {
  const worker = await startManagedRuntimeAttestationWorker(boot);
  openWorkers.add(worker);
  const headers = {
    authorization: `Bearer ${boot.token}`,
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-qwen-managed-lease-id': boot.leaseId,
    'x-qwen-managed-lease-epoch': String(boot.epoch),
  };
  const passed: string[] = [];
  for (const key of UNIVERSE) {
    const [method, routePath] = key.split(' ');
    const response = await fetch(`${worker.ready.url}${routePath}`, {
      method,
      headers,
      body: '{}',
    });
    const body = await response.text();
    if (!(response.status === 404 && body === '')) passed.push(key);
  }
  const plan = resolveManagedRuntimeWorkerRoutePlan(input);
  // gate = plan, and every route the inventory expects mounted passes the
  // gate (mounts ⊆ gate): a mounted-but-gated route would land in the gated
  // set and break the equality.
  expect(passed.sort()).toEqual(keys(plan.routes));
}

describe('worker gate conformance', () => {
  it('boot v1 admits exactly the plan surface', async () => {
    const mountRoot = await tempMountRoot();
    const boot: ManagedRuntimeWorkerBoot = {
      type: 'boot',
      version: 1,
      token: fixtures.boot.token,
      runtimeInstanceId: fixtures.boot.runtimeInstanceId,
      runtimeIncarnation: fixtures.boot.runtimeIncarnation,
      leaseId: fixtures.boot.leaseId,
      epoch: fixtures.boot.epoch,
      provisionRequestId: fixtures.boot.provisionRequestId,
      tenantId: fixtures.boot.tenantId,
      workspaceId: fixtures.boot.workspaceId,
      workspaceGeneration: fixtures.boot.workspaceGeneration,
      workspaceCwd: mountRoot,
      capabilityDigest: PLAIN_DIGEST,
      isolationClass: 'session',
    };
    await probeWorker(boot, planInput({ bootVersion: 1 }));
  });

  it.each([
    ['plain', PLAIN_DIGEST],
    ['workspace', WORKSPACE_CAPABILITY_DIGEST],
    ['measured', MEASURED_WORKSPACE_CAPABILITY_DIGEST],
    ['terminal', MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST],
    ['resident', RESIDENT_WORKSPACE_CAPABILITY_DIGEST],
  ] as const)(
    'boot v2 %s admits exactly the plan surface',
    async (_name, capabilityDigest) => {
      const mountRoot = await tempMountRoot();
      const boot: ManagedContextBoot = {
        ...fixtures.boot,
        capabilityDigest,
        mountRoot,
      };
      await probeWorker(boot, planInput({ capabilityDigest }));
    },
  );
});
