/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewBackendPlan,
  probeHostReviewBackends,
  requestedSandboxBackend,
  selectReviewSandboxBackend,
  type ReviewBackendProbe,
} from './sandbox-backends.js';

const emptyProbe = (
  overrides: Partial<ReviewBackendProbe> = {},
): ReviewBackendProbe => ({
  platform: 'linux',
  arch: 'x64',
  hasKvm: false,
  hasFirecracker: false,
  hasJailer: false,
  hasVfkit: false,
  hasSandboxExec: false,
  ...overrides,
});

describe('requestedSandboxBackend', () => {
  it('parses valid operator values and ignores repository .env values', () => {
    expect(
      requestedSandboxBackend(
        { QWEN_REVIEW_SANDBOX_BACKEND: 'firecracker' },
        () => false,
      ),
    ).toBe('firecracker');
    expect(
      requestedSandboxBackend(
        { QWEN_REVIEW_SANDBOX_BACKEND: 'PROVIDER-VM' },
        () => false,
      ),
    ).toBe('provider-vm');
    expect(
      requestedSandboxBackend(
        { QWEN_REVIEW_SANDBOX_BACKEND: 'bogus' },
        () => false,
      ),
    ).toBe('auto');
    expect(
      requestedSandboxBackend(
        { QWEN_REVIEW_SANDBOX_BACKEND: 'container' },
        (k) => k === 'QWEN_REVIEW_SANDBOX_BACKEND',
      ),
    ).toBe('auto');
  });
});

describe('buildReviewBackendPlan', () => {
  it('validates firecracker Linux KVM + jailer + kernel/rootfs prerequisites', () => {
    const missing = buildReviewBackendPlan('firecracker', emptyProbe());
    expect(missing.ready).toBe(false);
    expect(missing.missing).toEqual(
      expect.arrayContaining([
        '/dev/kvm',
        'firecracker',
        'jailer',
        'QWEN_REVIEW_VM_KERNEL',
        'QWEN_REVIEW_VM_ROOTFS',
      ]),
    );

    const ready = buildReviewBackendPlan(
      'firecracker',
      emptyProbe({
        platform: 'linux',
        hasKvm: true,
        hasFirecracker: true,
        hasJailer: true,
        firecrackerKernel: '/opt/vm/vmlinux',
        firecrackerRootfs: '/opt/vm/rootfs.ext4',
      }),
    );
    expect(ready.ready).toBe(true);
    expect(ready.missing).toEqual([]);
  });

  it('validates vfkit macOS Apple Silicon + Seatbelt prerequisites', () => {
    const ready = buildReviewBackendPlan(
      'vfkit',
      emptyProbe({
        platform: 'darwin',
        arch: 'arm64',
        hasVfkit: true,
        hasSandboxExec: true,
        vfkitKernel: '/opt/vm/Image',
        vfkitRootfs: '/opt/vm/rootfs.img',
      }),
    );
    expect(ready.ready).toBe(true);

    const x64Mac = buildReviewBackendPlan(
      'vfkit',
      emptyProbe({
        platform: 'darwin',
        arch: 'x64',
        hasVfkit: true,
        hasSandboxExec: true,
        vfkitKernel: '/opt/vm/Image',
        vfkitRootfs: '/opt/vm/rootfs.img',
      }),
    );
    expect(x64Mac.ready).toBe(false);
    expect(x64Mac.missing).toContain('darwin-arm64-host');
  });

  it('rejects fcsandbox default template and accepts explicit VPC-isolated template or aliyun-ecs', () => {
    const defaultTpl = buildReviewBackendPlan(
      'provider-vm',
      emptyProbe({
        providerVmDriver: 'fcsandbox',
        providerVmEndpoint: 'https://sandbox.example',
        providerVmTemplate: 'default',
      }),
    );
    expect(defaultTpl.ready).toBe(false);
    expect(defaultTpl.missing[0]).toContain('non-default');

    for (const disallowed of [
      'default',
      'BASE',
      'python',
      'code-interpreter',
      'bad name',
    ]) {
      const tpl = buildReviewBackendPlan(
        'provider-vm',
        emptyProbe({
          providerVmDriver: 'fcsandbox',
          providerVmEndpoint: 'https://sandbox.example',
          providerVmTemplate: disallowed,
        }),
      );
      expect(tpl.ready).toBe(false);
    }

    const badEndpoint = buildReviewBackendPlan(
      'provider-vm',
      emptyProbe({
        providerVmDriver: 'aliyun-ecs',
        providerVmEndpoint: 'http://insecure.example',
      }),
    );
    expect(badEndpoint.ready).toBe(false);

    const probeWithDir = probeHostReviewBackends(
      {
        QWEN_REVIEW_VM_KERNEL: tmpdir(),
        QWEN_REVIEW_VM_ROOTFS: tmpdir(),
      },
      () => false,
    );
    expect(probeWithDir.firecrackerKernel).toBeUndefined();
    expect(probeWithDir.vfkitRootfs).toBeUndefined();

    const isolatedTpl = buildReviewBackendPlan(
      'provider-vm',
      emptyProbe({
        providerVmDriver: 'fcsandbox',
        providerVmEndpoint: 'https://sandbox.example',
        providerVmTemplate: 'review-vpc-no-egress-v1',
      }),
    );
    expect(isolatedTpl.ready).toBe(true);

    const ecs = buildReviewBackendPlan(
      'provider-vm',
      emptyProbe({
        providerVmDriver: 'aliyun-ecs',
        providerVmEndpoint: 'https://ecs.cn-hangzhou.aliyuncs.com',
      }),
    );
    expect(ecs.ready).toBe(true);
  });
});

describe('selectReviewSandboxBackend', () => {
  it('selects container for trusted-shared-kernel when available and refuses without host downgrade when absent', () => {
    const ok = selectReviewSandboxBackend({
      executionClass: 'trusted-shared-kernel',
      containerRuntime: 'docker',
      hostProbe: emptyProbe(),
    });
    expect(ok).toEqual({
      kind: 'container',
      backend: 'container',
      runtime: 'docker',
      executionClass: 'trusted-shared-kernel',
    });

    const refused = selectReviewSandboxBackend({
      executionClass: 'trusted-shared-kernel',
      containerRuntime: null,
      hostProbe: emptyProbe(),
    });
    expect(refused.kind).toBe('refused');
  });

  it('never downgrades hardware-isolated to container even when Docker and provider-vm are ready', () => {
    const forcedContainer = selectReviewSandboxBackend({
      executionClass: 'hardware-isolated',
      requestedBackend: 'container',
      containerRuntime: 'docker',
      hostProbe: emptyProbe({
        providerVmDriver: 'fcsandbox',
        providerVmEndpoint: 'https://sandbox.example',
        providerVmTemplate: 'review-vpc-no-egress-v1',
      }),
    });
    expect(forcedContainer.kind).toBe('refused');
    if (forcedContainer.kind === 'refused') {
      expect(forcedContainer.reason).toContain(
        'shared-kernel containers cannot run',
      );
      expect(forcedContainer.checked).toEqual([]);
    }

    const missingHardware = selectReviewSandboxBackend({
      executionClass: 'hardware-isolated',
      containerRuntime: 'docker',
      hostProbe: emptyProbe({ platform: 'darwin', arch: 'arm64' }),
    });
    expect(missingHardware.kind).toBe('refused');
    if (missingHardware.kind === 'refused') {
      expect(missingHardware.checked.map((c) => c.backend)).toEqual([
        'vfkit',
        'provider-vm',
      ]);
    }
  });

  it('prefers host-native hardware backend before provider-vm and reports hardware-planned when ready', () => {
    const sel = selectReviewSandboxBackend({
      executionClass: 'hardware-isolated',
      containerRuntime: 'docker',
      hostProbe: emptyProbe({
        platform: 'linux',
        hasKvm: true,
        hasFirecracker: true,
        hasJailer: true,
        firecrackerKernel: '/opt/vm/vmlinux',
        firecrackerRootfs: '/opt/vm/rootfs.ext4',
        providerVmDriver: 'aliyun-ecs',
        providerVmEndpoint: 'https://ecs.example',
      }),
    });
    expect(sel.kind).toBe('hardware-planned');
    if (sel.kind === 'hardware-planned') {
      expect(sel.backend).toBe('firecracker');
      expect(sel.plan.ready).toBe(true);
    }
  });

  const dirs: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'returns hardware-bridge when host microVM prerequisites AND a valid UDS bridge socket are ready, and refuses invalid sockets',
    async () => {
      const dir = mkdtempSync(join('/tmp', 'qvm-sel-'));
      dirs.push(dir);
      const sock = join(dir, 'fc.sock');
      const srv = createServer();
      servers.push(srv);
      await new Promise<void>((r) => srv.listen(sock, r));

      const bridge = selectReviewSandboxBackend({
        executionClass: 'hardware-isolated',
        containerRuntime: 'docker',
        hostProbe: emptyProbe({
          platform: 'linux',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sock,
          workerPidFile: '/run/fc.pid',
        }),
      });
      expect(bridge.kind).toBe('hardware-bridge');
      if (bridge.kind === 'hardware-bridge') {
        expect(bridge.backend).toBe('firecracker');
        expect(bridge.socketPath).toBe(sock);
        expect(bridge.workerPidFile).toBe('/run/fc.pid');
      }

      const missingSock = selectReviewSandboxBackend({
        executionClass: 'hardware-isolated',
        containerRuntime: 'docker',
        hostProbe: emptyProbe({
          platform: 'linux',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: join(dir, 'does-not-exist.sock'),
        }),
      });
      expect(missingSock.kind).toBe('refused');
      if (missingSock.kind === 'refused') {
        expect(missingSock.reason).toContain('bridge socket invalid');
      }
    },
  );
});
