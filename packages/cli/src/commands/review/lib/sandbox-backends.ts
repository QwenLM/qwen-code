/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isFileSourcedEnvKey } from '../../../config/environment.js';
import { validateBridgeSocketEndpoint } from './guest-exec-bridge.js';
import type { ReviewExecutionClass } from './sandbox-trust.js';

export type ContainerRuntime = 'docker' | 'podman';

export type HardwareSandboxBackend = 'firecracker' | 'vfkit' | 'provider-vm';

export type RequestedSandboxBackend =
  | 'auto'
  | 'container'
  | HardwareSandboxBackend;

export type ProviderVmDriver = 'fcsandbox' | 'aliyun-ecs';

const VALID_REQUESTED_BACKENDS: ReadonlySet<string> = new Set([
  'auto',
  'container',
  'firecracker',
  'vfkit',
  'provider-vm',
]);

export interface ReviewBackendProbe {
  platform: NodeJS.Platform;
  arch: string;
  hasKvm: boolean;
  hasFirecracker: boolean;
  hasJailer: boolean;
  hasVfkit: boolean;
  hasSandboxExec: boolean;
  firecrackerKernel?: string;
  firecrackerRootfs?: string;
  vfkitKernel?: string;
  vfkitRootfs?: string;
  providerVmDriver?: ProviderVmDriver;
  providerVmTemplate?: string;
  providerVmEndpoint?: string;
  /** Operator-supplied local UDS endpoint speaking `guest-exec-v1` (never from repo `.env`). */
  bridgeSocketPath?: string;
  /** Optional VMM worker PID file used for identity-checked teardown on timeout/fault. */
  workerPidFile?: string;
}

export interface ReviewBackendPlan {
  backend: HardwareSandboxBackend;
  ready: boolean;
  missing: string[];
  driver?: ProviderVmDriver;
  summary: string;
}

export type ReviewBackendSelection =
  | {
      kind: 'container';
      backend: 'container';
      runtime: ContainerRuntime;
      executionClass: 'trusted-shared-kernel';
    }
  | {
      kind: 'hardware-bridge';
      backend: 'firecracker' | 'vfkit';
      executionClass: ReviewExecutionClass;
      plan: ReviewBackendPlan;
      socketPath: string;
      workerPidFile?: string;
    }
  | {
      kind: 'hardware-planned';
      backend: HardwareSandboxBackend;
      executionClass: ReviewExecutionClass;
      plan: ReviewBackendPlan;
      reason: string;
    }
  | {
      kind: 'refused';
      backend: 'refused';
      executionClass: ReviewExecutionClass;
      reason: string;
      checked: ReviewBackendPlan[];
    };

function operatorEnvValue(
  key: string,
  env: NodeJS.ProcessEnv,
  fileSourced: (k: string) => boolean,
): string | undefined {
  if (fileSourced(key)) return undefined;
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/**
 * Operator backend preference from `QWEN_REVIEW_SANDBOX_BACKEND`.
 * Ignores repository `.env` values.
 */
export function requestedSandboxBackend(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): RequestedSandboxBackend {
  const raw = operatorEnvValue(
    'QWEN_REVIEW_SANDBOX_BACKEND',
    env,
    fileSourced,
  )?.toLowerCase();
  if (raw && VALID_REQUESTED_BACKENDS.has(raw)) {
    return raw as RequestedSandboxBackend;
  }
  return 'auto';
}

function commandExists(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const pathEnv = env['PATH'] ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      }
    } catch {
      // Not present or not executable in this PATH entry.
    }
  }
  return false;
}

function readableFilePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    if (!statSync(p).isFile()) return undefined;
    accessSync(p, fsConstants.R_OK);
    return p;
  } catch {
    return undefined;
  }
}

const DISALLOWED_FCSANDBOX_TEMPLATES = new Set([
  'default',
  'base',
  'python',
  'code-interpreter',
]);

function isValidHttpsEndpoint(raw: string | undefined): boolean {
  if (!raw || /\s/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function probeHostReviewBackends(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): ReviewBackendProbe {
  const platform = process.platform;
  const arch = process.arch;
  const rawDriver = operatorEnvValue(
    'QWEN_REVIEW_PROVIDER_VM_DRIVER',
    env,
    fileSourced,
  )?.toLowerCase();
  const providerVmDriver: ProviderVmDriver | undefined =
    rawDriver === 'fcsandbox' || rawDriver === 'aliyun-ecs'
      ? rawDriver
      : undefined;

  const rawKernel = operatorEnvValue('QWEN_REVIEW_VM_KERNEL', env, fileSourced);
  const rawRootfs = operatorEnvValue('QWEN_REVIEW_VM_ROOTFS', env, fileSourced);
  const readableKernel = readableFilePath(rawKernel);
  const readableRootfs = readableFilePath(rawRootfs);

  const canAccess = (p: string, mode: number): boolean => {
    try {
      accessSync(p, mode);
      return true;
    } catch {
      return false;
    }
  };

  return {
    platform,
    arch,
    hasKvm:
      platform === 'linux' &&
      canAccess('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK),
    hasFirecracker: platform === 'linux' && commandExists('firecracker', env),
    hasJailer: platform === 'linux' && commandExists('jailer', env),
    hasVfkit: platform === 'darwin' && commandExists('vfkit', env),
    hasSandboxExec:
      platform === 'darwin' &&
      canAccess('/usr/bin/sandbox-exec', fsConstants.X_OK),
    firecrackerKernel: readableKernel,
    firecrackerRootfs: readableRootfs,
    vfkitKernel: readableKernel,
    vfkitRootfs: readableRootfs,
    providerVmDriver,
    providerVmTemplate: operatorEnvValue(
      'QWEN_REVIEW_FCSANDBOX_TEMPLATE',
      env,
      fileSourced,
    ),
    providerVmEndpoint: operatorEnvValue(
      'QWEN_REVIEW_PROVIDER_VM_ENDPOINT',
      env,
      fileSourced,
    ),
    bridgeSocketPath: operatorEnvValue(
      'QWEN_REVIEW_VM_BRIDGE_SOCKET',
      env,
      fileSourced,
    ),
    workerPidFile: operatorEnvValue(
      'QWEN_REVIEW_VM_PID_FILE',
      env,
      fileSourced,
    ),
  };
}

/**
 * Pure prerequisite validator and launch-plan descriptor for one hardware
 * backend (mirrors `scripts/verify-pr-vm-runner.mjs` contract).
 */
export function buildReviewBackendPlan(
  backend: HardwareSandboxBackend,
  probe: ReviewBackendProbe,
): ReviewBackendPlan {
  const missing: string[] = [];

  if (backend === 'firecracker') {
    if (probe.platform !== 'linux') missing.push('linux-host');
    if (!probe.hasKvm) missing.push('/dev/kvm');
    if (!probe.hasFirecracker) missing.push('firecracker');
    if (!probe.hasJailer) missing.push('jailer');
    if (!probe.firecrackerKernel?.trim()) missing.push('QWEN_REVIEW_VM_KERNEL');
    if (!probe.firecrackerRootfs?.trim()) missing.push('QWEN_REVIEW_VM_ROOTFS');
    return {
      backend,
      ready: missing.length === 0,
      missing,
      summary:
        missing.length === 0
          ? 'Linux KVM Firecracker microVM (+jailer) prerequisites satisfied'
          : `firecracker unavailable (missing: ${missing.join(', ')})`,
    };
  }

  if (backend === 'vfkit') {
    if (probe.platform !== 'darwin' || probe.arch !== 'arm64') {
      missing.push('darwin-arm64-host');
    }
    if (!probe.hasVfkit) missing.push('vfkit');
    if (!probe.hasSandboxExec) missing.push('/usr/bin/sandbox-exec');
    if (!probe.vfkitKernel?.trim()) missing.push('QWEN_REVIEW_VM_KERNEL');
    if (!probe.vfkitRootfs?.trim()) missing.push('QWEN_REVIEW_VM_ROOTFS');
    return {
      backend,
      ready: missing.length === 0,
      missing,
      summary:
        missing.length === 0
          ? 'macOS Apple Silicon vfkit (+enforcing Seatbelt) prerequisites satisfied'
          : `vfkit unavailable (missing: ${missing.join(', ')})`,
    };
  }

  // provider-vm (Aliyun fcsandbox with custom isolated VPC template, or ephemeral ECS)
  if (!probe.providerVmDriver) {
    missing.push('QWEN_REVIEW_PROVIDER_VM_DRIVER (fcsandbox|aliyun-ecs)');
  }
  if (!isValidHttpsEndpoint(probe.providerVmEndpoint?.trim())) {
    missing.push('QWEN_REVIEW_PROVIDER_VM_ENDPOINT (valid https:// URL)');
  }
  if (probe.providerVmDriver === 'fcsandbox') {
    const tpl = probe.providerVmTemplate?.trim();
    if (
      !tpl ||
      /\s/.test(tpl) ||
      DISALLOWED_FCSANDBOX_TEMPLATES.has(tpl.toLowerCase())
    ) {
      missing.push(
        'QWEN_REVIEW_FCSANDBOX_TEMPLATE (non-default VPC-isolated template required)',
      );
    }
  }
  return {
    backend: 'provider-vm',
    ready: missing.length === 0,
    missing,
    driver: probe.providerVmDriver,
    summary:
      missing.length === 0
        ? `provider-vm (${probe.providerVmDriver}) prerequisites satisfied`
        : `provider-vm unavailable (missing: ${missing.join(', ')})`,
  };
}

function hardwareCandidateOrder(
  platform: NodeJS.Platform,
  arch: string,
): HardwareSandboxBackend[] {
  if (platform === 'linux') return ['firecracker', 'provider-vm'];
  if (platform === 'darwin' && arch === 'arm64') {
    return ['vfkit', 'provider-vm'];
  }
  return ['provider-vm'];
}

export interface SelectReviewBackendOptions {
  executionClass: ReviewExecutionClass;
  requestedBackend?: RequestedSandboxBackend;
  containerRuntime: ContainerRuntime | null;
  hostProbe?: ReviewBackendProbe;
}

function resolveHardwareBridgeOrPlan(
  plan: ReviewBackendPlan,
  executionClass: ReviewExecutionClass,
  probe: ReviewBackendProbe,
  checked: ReviewBackendPlan[],
): ReviewBackendSelection {
  if (
    (plan.backend === 'firecracker' || plan.backend === 'vfkit') &&
    probe.bridgeSocketPath
  ) {
    const endpoint = validateBridgeSocketEndpoint(
      probe.bridgeSocketPath,
      probe.platform,
    );
    if (!endpoint.ok) {
      return {
        kind: 'refused',
        backend: 'refused',
        executionClass,
        reason: `hardware backend "${plan.backend}" bridge socket invalid (${endpoint.reason}) — refusing fail-closed without downgrading`,
        checked,
      };
    }
    return {
      kind: 'hardware-bridge',
      backend: plan.backend,
      executionClass,
      plan,
      socketPath: probe.bridgeSocketPath,
      ...(probe.workerPidFile ? { workerPidFile: probe.workerPidFile } : {}),
    };
  }
  return {
    kind: 'hardware-planned',
    backend: plan.backend,
    executionClass,
    plan,
    reason:
      executionClass === 'hardware-isolated'
        ? `hardware-isolated backend "${plan.backend}" is configured (${plan.summary}), but inline guest execution transport is not attached (set QWEN_REVIEW_VM_BRIDGE_SOCKET to a guest-exec-v1 UDS endpoint) — refusing fail-closed rather than downgrading to container or host`
        : `hardware backend "${plan.backend}" prerequisites are ready, but inline guest execution transport is not attached (set QWEN_REVIEW_VM_BRIDGE_SOCKET to a guest-exec-v1 UDS endpoint) — refusing rather than downgrading to shared-kernel container or host`,
  };
}

/**
 * Selects the sandbox execution backend fail-closed for a given
 * `executionClass`.
 *
 * - `hardware-isolated` NEVER downgrades to `container` or `direct`.
 * - `trusted-shared-kernel` allows `container`, or an explicitly requested
 *   hardware backend.
 */
export function selectReviewSandboxBackend(
  opts: SelectReviewBackendOptions,
): ReviewBackendSelection {
  const requested = opts.requestedBackend ?? 'auto';
  const probe = opts.hostProbe ?? probeHostReviewBackends();

  if (opts.executionClass === 'trusted-shared-kernel') {
    if (requested === 'auto' || requested === 'container') {
      if (opts.containerRuntime) {
        return {
          kind: 'container',
          backend: 'container',
          runtime: opts.containerRuntime,
          executionClass: 'trusted-shared-kernel',
        };
      }
      return {
        kind: 'refused',
        backend: 'refused',
        executionClass: 'trusted-shared-kernel',
        reason:
          'trusted-shared-kernel execution requires a container runtime (docker or podman), and neither answered',
        checked: [],
      };
    }
    // Operator explicitly requested hardware isolation even for a trusted PR.
    const plan = buildReviewBackendPlan(requested, probe);
    if (plan.ready) {
      return resolveHardwareBridgeOrPlan(plan, 'trusted-shared-kernel', probe, [
        plan,
      ]);
    }
    return {
      kind: 'refused',
      backend: 'refused',
      executionClass: 'trusted-shared-kernel',
      reason: `requested hardware backend "${requested}" is not ready: ${plan.summary}`,
      checked: [plan],
    };
  }

  // executionClass === 'hardware-isolated'
  if (requested === 'container') {
    return {
      kind: 'refused',
      backend: 'refused',
      executionClass: 'hardware-isolated',
      reason:
        'execution class is "hardware-isolated", so QWEN_REVIEW_SANDBOX_BACKEND=container is refused — shared-kernel containers cannot run untrusted or high-risk PRs',
      checked: [],
    };
  }

  const candidates: HardwareSandboxBackend[] =
    requested === 'auto'
      ? hardwareCandidateOrder(probe.platform, probe.arch)
      : [requested];

  const checked = candidates.map((b) => buildReviewBackendPlan(b, probe));
  const readyPlan = checked.find((p) => p.ready);
  if (readyPlan) {
    return resolveHardwareBridgeOrPlan(
      readyPlan,
      'hardware-isolated',
      probe,
      checked,
    );
  }

  return {
    kind: 'refused',
    backend: 'refused',
    executionClass: 'hardware-isolated',
    reason: `hardware-isolated execution required and no hardware backend is ready (${checked.map((c) => c.summary).join('; ')}) — refusing fail-closed without downgrading to shared-kernel container or host`,
    checked,
  };
}
