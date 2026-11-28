#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fail-closed backend selection and normalized launch-plan builders for the
 * three hardware-isolated `/verify-pr` backends proven in the PoC:
 *   - Linux KVM: Firecracker + jailer (no NIC, no directory share, vsock UDS)
 *   - macOS VZ:  vfkit inside deny-default Seatbelt (no NIC/virtio-fs/REST)
 *   - Cloud ECS: disposable Aliyun provider-vm (0 inbound, drop egress, IMDSv2,
 *                no public IP, no RAM Role, AutoReleaseTime failsafe)
 *
 * Refuses to silently downgrade `hardware-isolated` work to containers, bwrap,
 * bare Seatbelt, or the host when no hardware backend is available (§4.4/D10).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './lib/entry-point.js';
import {
  HARDWARE_BACKENDS,
  checkTrustClassification,
} from './verify-pr-check.mjs';
import {
  createModelProxy,
  formatLocalBaseUrl,
  isTokenFileRevoked,
  normalizeBasePath,
} from './verify-pr-model-proxy.mjs';
import {
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MODEL_VSOCK_PORT,
  buildInputManifest,
  createRoundInputBundle,
  startInputServer,
} from './verify-pr-vm-channel.mjs';
import {
  startCollectorServer,
  validateSocketPathLength,
} from './verify-pr-vm-collector.mjs';
import {
  probeHostCapabilities,
  stageLocalVmRound,
  verifyFirecrackerDiskConfig,
  verifyVfkitSeatbeltProfile,
} from './verify-pr-vm-host.mjs';
import {
  buildExecutionRecord,
  inspectPidState,
  reapOwnership,
  writeExecutionRecordAndBoundary,
  writeOwnershipRecord,
} from './verify-pr-vm-lifecycle.mjs';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const FULL_OID_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_HOST_JSON_BYTES = 16 * 1024 * 1024;
const CHECK_SCRIPT = fileURLToPath(
  new URL('./verify-pr-check.mjs', import.meta.url),
);

function sha256Json(value) {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error(
      `invalid runId ${JSON.stringify(runId)}: expected 2..32 chars matching ${RUN_ID_RE}`,
    );
  }
}

function assertCsvSafe(name, value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    /[,"\r\n\0]/.test(value)
  ) {
    throw new Error(
      `invalid ${name}: must be non-empty and must not contain commas, quotes, newlines, or NUL bytes`,
    );
  }
}

/**
 * Selects the execution backend for a classified round. Never silently
 * downgrades `hardware-isolated` to shared-kernel or host execution.
 */
export function selectBackend({
  executionClass,
  preferredBackend = null,
  platform = process.platform,
  arch = process.arch,
  kvmAvailable = false,
  vfkitAvailable = false,
  seatbeltEnforcing = false,
  providerConfigured = false,
} = {}) {
  if (executionClass === 'trusted-shared-kernel') {
    if (
      preferredBackend &&
      preferredBackend !== 'container' &&
      !['firecracker', 'vfkit', 'provider-vm'].includes(preferredBackend)
    ) {
      return {
        backend: null,
        error: `unsupported backend ${JSON.stringify(preferredBackend)}`,
      };
    }
    if (
      preferredBackend &&
      ['firecracker', 'vfkit', 'provider-vm'].includes(preferredBackend)
    ) {
      // Upgrading a trusted round to hardware isolation is allowed (§4.4).
      return selectBackend({
        executionClass: 'hardware-isolated',
        preferredBackend,
        platform,
        arch,
        kvmAvailable,
        vfkitAvailable,
        seatbeltEnforcing,
        providerConfigured,
      });
    }
    return { backend: 'container', error: null };
  }

  if (executionClass !== 'hardware-isolated') {
    return {
      backend: null,
      error: `unknown executionClass ${JSON.stringify(executionClass)}`,
    };
  }

  const canFirecracker = platform === 'linux' && kvmAvailable === true;
  const canVfkit =
    platform === 'darwin' &&
    arch === 'arm64' &&
    vfkitAvailable === true &&
    seatbeltEnforcing === true;
  const canProvider = providerConfigured === true;

  if (preferredBackend) {
    if (preferredBackend === 'firecracker') {
      return canFirecracker
        ? { backend: 'firecracker', error: null }
        : {
            backend: null,
            error:
              'firecracker backend requested but Linux /dev/kvm is unavailable (refusing downgrade)',
          };
    }
    if (preferredBackend === 'vfkit') {
      return canVfkit
        ? { backend: 'vfkit', error: null }
        : {
            backend: null,
            error:
              'vfkit backend requested but Apple Silicon vfkit + enforcing Seatbelt is unavailable (bare vfkit and host fallback are refused)',
          };
    }
    if (preferredBackend === 'provider-vm') {
      return canProvider
        ? { backend: 'provider-vm', error: null }
        : {
            backend: null,
            error:
              'provider-vm backend requested but provider cloud profile is not configured (refusing downgrade)',
          };
    }
    return {
      backend: null,
      error: `backend ${JSON.stringify(preferredBackend)} is not permitted for executionClass=hardware-isolated`,
    };
  }

  if (canFirecracker) return { backend: 'firecracker', error: null };
  if (canVfkit) return { backend: 'vfkit', error: null };
  if (canProvider) return { backend: 'provider-vm', error: null };

  return {
    backend: null,
    error:
      'no hardware-isolated backend available (need Linux /dev/kvm, macOS vfkit + enforcing Seatbelt, or configured provider-vm); refusing silent downgrade to container or host',
  };
}

/**
 * Builds the normalized Firecracker + jailer launch plan (D3/D6/D8):
 *   - no NIC (`network-interfaces` absent)
 *   - no virtio-fs / shared host directory
 *   - single virtio-vsock UDS validated < 107 bytes on Linux
 *   - non-root uid/gid + `--new-pid-ns` + cgroup v2 + resource limits
 */
export function buildFirecrackerLaunchPlan({
  runId,
  jailBaseDir,
  firecrackerBin,
  jailerBin,
  vmmUid = 65534,
  vmmGid = 65534,
  cpus = 1,
  memMib = 512,
  maxFsizeBytes = 268435456,
  maxNoFile = 1024,
  guestCid = 3,
  vsockPort = 52,
  inputVsockPort = null,
  modelVsockPort = null,
  bootArgs = 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/opt/poc/init',
}) {
  assertRunId(runId);
  if (!Number.isInteger(vmmUid) || vmmUid <= 0) {
    throw new Error('firecracker requires a non-root vmmUid > 0');
  }
  if (!Number.isInteger(vmmGid) || vmmGid <= 0) {
    throw new Error('firecracker requires a non-root vmmGid > 0');
  }
  if (!Number.isInteger(guestCid) || guestCid < 3) {
    throw new Error('firecracker guestCid must be an integer >= 3');
  }
  for (const [label, val] of [
    ['cpus', cpus],
    ['memMib', memMib],
    ['maxFsizeBytes', maxFsizeBytes],
    ['maxNoFile', maxNoFile],
    ['vsockPort', vsockPort],
  ]) {
    if (!Number.isInteger(val) || val <= 0) {
      throw new Error(`firecracker ${label} must be a positive integer`);
    }
  }
  const seenPorts = new Set([vsockPort]);
  for (const [label, val] of [
    ['inputVsockPort', inputVsockPort],
    ['modelVsockPort', modelVsockPort],
  ]) {
    if (val === null) continue;
    if (!Number.isInteger(val) || val <= 0) {
      throw new Error(`firecracker ${label} must be a positive integer`);
    }
    if (seenPorts.has(val)) {
      throw new Error(
        `firecracker ${label} (${val}) collides with another vsock port`,
      );
    }
    seenPorts.add(val);
  }
  const execName = basename(firecrackerBin);
  const jailRoot = join(jailBaseDir, execName, runId, 'root');
  const hostVsockPath = join(jailRoot, `v.sock_${vsockPort}`);
  const inputVsockPath =
    inputVsockPort !== null ? join(jailRoot, `v.sock_${inputVsockPort}`) : null;
  const modelVsockPath =
    modelVsockPort !== null ? join(jailRoot, `v.sock_${modelVsockPort}`) : null;
  for (const sockPath of [hostVsockPath, inputVsockPath, modelVsockPath]) {
    if (!sockPath) continue;
    const len = validateSocketPathLength(sockPath, 'linux');
    if (!len.ok) {
      throw new Error(
        `firecracker UDS path exceeds Linux sun_path limit (${len.reason}): use a shorter jailBaseDir or runId`,
      );
    }
  }

  const vmConfig = {
    'boot-source': {
      kernel_image_path: '/vmlinuz',
      boot_args: bootArgs,
    },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: '/rootfs.ext4',
        is_root_device: true,
        is_read_only: false,
      },
    ],
    'machine-config': {
      vcpu_count: cpus,
      mem_size_mib: memMib,
      smt: false,
    },
    vsock: {
      guest_cid: guestCid,
      uds_path: '/v.sock',
    },
  };

  const argv = [
    jailerBin,
    '--id',
    runId,
    '--exec-file',
    firecrackerBin,
    '--uid',
    String(vmmUid),
    '--gid',
    String(vmmGid),
    '--new-pid-ns',
    '--cgroup-version',
    '2',
    '--chroot-base-dir',
    jailBaseDir,
    '--resource-limit',
    `no-file=${maxNoFile}`,
    '--resource-limit',
    `fsize=${maxFsizeBytes}`,
    '--',
    '--config-file',
    '/config.json',
    '--log-path',
    '/console.log',
  ];

  const policy = {
    backend: 'firecracker',
    vmmUid,
    vmmGid,
    cpus,
    memMib,
    maxFsizeBytes,
    maxNoFile,
    hasNic: false,
    hasDirectoryShare: false,
    ...(inputVsockPort !== null ? { inputVsockPort } : {}),
    ...(modelVsockPort !== null ? { modelVsockPort } : {}),
    vmConfig,
  };

  return {
    backend: 'firecracker',
    runId,
    jailRoot,
    kernelPath: join(jailRoot, 'vmlinuz'),
    hostVsockPath,
    ...(inputVsockPath !== null ? { inputVsockPort, inputVsockPath } : {}),
    ...(modelVsockPath !== null ? { modelVsockPort, modelVsockPath } : {}),
    workerPidFile: join(jailRoot, `${execName}.pid`),
    vmConfig,
    argv,
    vmmUid,
    vmmGid,
    ownershipTemplate: {
      runId,
      backend: 'firecracker',
      vmmUid,
      expectedExeTokens: [execName],
      workDiskPath: join(jailRoot, 'rootfs.ext4'),
      socketPaths: [
        hostVsockPath,
        ...(inputVsockPath !== null ? [inputVsockPath] : []),
        ...(modelVsockPath !== null ? [modelVsockPath] : []),
        join(jailRoot, 'v.sock'),
      ],
    },
    launchPolicyDigest: sha256Json(policy),
  };
}

/**
 * Builds the normalized macOS sandboxed vfkit launch plan (D3/D7):
 *   - mandatory deny-default Seatbelt wrapper via `env -i` + `sandbox-exec`
 *   - no `virtio-net`, no `virtio-fs`, no Rosetta/GPU/USB/NBD
 *   - `--restful-uri none://` (no inbound REST listener)
 */
export function buildVfkitLaunchPlan({
  runId,
  vfkitBin,
  seatbeltProfile,
  pocDir,
  socketDir,
  kernelPath,
  initramfsPath,
  rootfsPath,
  guestLogPath,
  pidFile,
  homeDir,
  tmpDir,
  cpus = 1,
  memMib = 512,
  vsockPort = 52,
  inputVsockPort = null,
  modelVsockPort = null,
  cmdline = 'console=hvc0 root=/dev/vda rw init=/opt/poc/init reboot=k panic=1',
}) {
  assertRunId(runId);
  if (typeof seatbeltProfile !== 'string' || seatbeltProfile.trim() === '') {
    throw new Error('vfkit requires an explicit enforcing Seatbelt profile');
  }
  const seenPorts = new Set([vsockPort]);
  for (const [label, val] of [
    ['inputVsockPort', inputVsockPort],
    ['modelVsockPort', modelVsockPort],
  ]) {
    if (val === null) continue;
    if (!Number.isInteger(val) || val <= 0) {
      throw new Error(`vfkit ${label} must be a positive integer`);
    }
    if (seenPorts.has(val)) {
      throw new Error(
        `vfkit ${label} (${val}) collides with another vsock port`,
      );
    }
    seenPorts.add(val);
  }
  for (const [label, val] of [
    ['kernelPath', kernelPath],
    ['initramfsPath', initramfsPath],
    ['rootfsPath', rootfsPath],
    ['guestLogPath', guestLogPath],
    ['socketDir', socketDir],
    ['cmdline', cmdline],
  ]) {
    assertCsvSafe(label, val);
  }
  const hostVsockPath = join(socketDir, 'v.sock');
  const inputVsockPath =
    inputVsockPort !== null ? join(socketDir, 'in.sock') : null;
  const modelVsockPath =
    modelVsockPort !== null ? join(socketDir, 'mp.sock') : null;
  for (const sockPath of [hostVsockPath, inputVsockPath, modelVsockPath]) {
    if (!sockPath) continue;
    const len = validateSocketPathLength(sockPath, 'darwin');
    if (!len.ok) {
      throw new Error(
        `vfkit UDS path exceeds macOS sun_path limit (${len.reason}): use a shorter socketDir`,
      );
    }
  }

  const argv = [
    '/usr/bin/env',
    '-i',
    'PATH=/usr/bin:/bin',
    `HOME=${homeDir}`,
    `TMPDIR=${tmpDir}`,
    'LANG=C',
    'LC_ALL=C',
    '/usr/bin/sandbox-exec',
    '-f',
    seatbeltProfile,
    '-D',
    `POC_DIR=${pocDir}`,
    '-D',
    `POC_SOCKET_DIR=${socketDir}`,
    vfkitBin,
    '--cpus',
    String(cpus),
    '--memory',
    String(memMib),
    '--bootloader',
    `linux,kernel=${kernelPath},initrd=${initramfsPath},cmdline="${cmdline}"`,
    '--device',
    `virtio-blk,path=${rootfsPath}`,
    '--device',
    `virtio-serial,logFilePath=${guestLogPath}`,
    '--device',
    `virtio-vsock,port=${vsockPort},socketURL=${hostVsockPath}`,
    ...(inputVsockPath !== null
      ? [
          '--device',
          `virtio-vsock,port=${inputVsockPort},socketURL=${inputVsockPath}`,
        ]
      : []),
    ...(modelVsockPath !== null
      ? [
          '--device',
          `virtio-vsock,port=${modelVsockPort},socketURL=${modelVsockPath}`,
        ]
      : []),
    '--device',
    'virtio-rng',
    '--restful-uri',
    'none://',
    '--pidfile',
    pidFile,
  ];

  const policy = {
    backend: 'vfkit',
    cpus,
    memMib,
    vsockPort,
    ...(inputVsockPort !== null ? { inputVsockPort } : {}),
    ...(modelVsockPort !== null ? { modelVsockPort } : {}),
    restfulUri: 'none://',
    hasNic: false,
    hasDirectoryShare: false,
    sandboxed: true,
    cmdline,
  };

  return {
    backend: 'vfkit',
    runId,
    kernelPath,
    hostVsockPath,
    ...(inputVsockPath !== null ? { inputVsockPort, inputVsockPath } : {}),
    ...(modelVsockPath !== null ? { modelVsockPort, modelVsockPath } : {}),
    socketDir,
    pidFile,
    argv,
    ownershipTemplate: {
      runId,
      backend: 'vfkit',
      expectedExeTokens: [basename(vfkitBin)],
      workDiskPath: rootfsPath,
      socketPaths: [
        hostVsockPath,
        ...(inputVsockPath !== null ? [inputVsockPath] : []),
        ...(modelVsockPath !== null ? [modelVsockPath] : []),
      ],
      socketDir,
    },
    launchPolicyDigest: sha256Json(policy),
  };
}

/**
 * Builds the normalized Aliyun disposable `provider-vm` plan (§5.1 / P7):
 *   - zero public IP (`InternetMaxBandwidthOut=0`)
 *   - empty RAM Role (no IAM metadata credentials)
 *   - `HttpTokens=required` (IMDSv2)
 *   - 0 inbound rules; egress drops RFC1918 and `0.0.0.0/0` using `--PortRange=-1/-1`
 *   - `AutoReleaseTime` failsafe >= 30 minutes (Aliyun API minimum)
 */
export function buildAliyunProviderPlan({
  runId,
  headRefOid,
  region,
  zone,
  vpcId,
  vSwitchId,
  instanceType = 'ecs.e-c1m1.large',
  imageId,
  diskCategory = 'cloud_essd',
  diskSizeGib = 20,
  autoReleaseMinutes = 35,
  now = new Date(),
}) {
  assertRunId(runId);
  if (!FULL_OID_RE.test(headRefOid ?? '')) {
    throw new Error('provider-vm requires a 40-hex headRefOid');
  }
  for (const [label, val] of [
    ['region', region],
    ['zone', zone],
    ['vpcId', vpcId],
    ['vSwitchId', vSwitchId],
    ['imageId', imageId],
  ]) {
    if (typeof val !== 'string' || val.trim() === '' || /\s/.test(val)) {
      throw new Error(`provider-vm requires a valid non-empty ${label}`);
    }
  }
  if (!Number.isInteger(autoReleaseMinutes) || autoReleaseMinutes < 30) {
    throw new Error(
      'Aliyun AutoReleaseTime must be at least 30 minutes in the future',
    );
  }
  const releaseTime = new Date(now.getTime() + autoReleaseMinutes * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const egressRules = [
    {
      priority: '10',
      policy: 'Accept',
      protocol: 'tcp',
      portRange: '443/443',
      destCidrIp: '100.100.0.0/16',
    },
    {
      priority: '11',
      policy: 'Accept',
      protocol: 'tcp',
      portRange: '80/80',
      destCidrIp: '100.100.0.0/16',
    },
    {
      priority: '50',
      policy: 'Drop',
      protocol: 'all',
      portRange: '-1/-1',
      destCidrIp: '172.16.0.0/12',
    },
    {
      priority: '51',
      policy: 'Drop',
      protocol: 'all',
      portRange: '-1/-1',
      destCidrIp: '10.0.0.0/8',
    },
    {
      priority: '52',
      policy: 'Drop',
      protocol: 'all',
      portRange: '-1/-1',
      destCidrIp: '192.168.0.0/16',
    },
    {
      priority: '100',
      policy: 'Drop',
      protocol: 'all',
      portRange: '-1/-1',
      destCidrIp: '0.0.0.0/0',
    },
  ];

  const authorizeEgressArgvs = (sgId) =>
    egressRules.map((rule) => [
      'ecs',
      'AuthorizeSecurityGroupEgress',
      '--RegionId',
      region,
      '--SecurityGroupId',
      sgId,
      '--IpProtocol',
      rule.protocol,
      `--PortRange=${rule.portRange}`,
      '--DestCidrIp',
      rule.destCidrIp,
      '--Policy',
      rule.policy,
      '--Priority',
      rule.priority,
    ]);

  const runInstancesArgv = (sgId) => [
    'ecs',
    'RunInstances',
    '--RegionId',
    region,
    '--ZoneId',
    zone,
    '--VSwitchId',
    vSwitchId,
    '--SecurityGroupId',
    sgId,
    '--InstanceType',
    instanceType,
    '--ImageId',
    imageId,
    '--InstanceName',
    `qwen-verify-${runId}`,
    '--InstanceChargeType',
    'PostPaid',
    '--InternetMaxBandwidthOut',
    '0',
    '--SystemDisk.Category',
    diskCategory,
    '--SystemDisk.Size',
    String(diskSizeGib),
    '--HttpEndpoint',
    'enabled',
    '--HttpTokens',
    'required',
    '--AutoReleaseTime',
    releaseTime,
    '--Amount',
    '1',
    '--Tag.1.Key',
    'qwen-verify-ephemeral',
    '--Tag.1.Value',
    'true',
    '--Tag.2.Key',
    'qwen-run-id',
    '--Tag.2.Value',
    runId,
    '--Tag.3.Key',
    'qwen-head-oid',
    '--Tag.3.Value',
    headRefOid,
  ];

  const policy = {
    backend: 'provider-vm',
    provider: 'aliyun-ecs',
    region,
    zone,
    vpcId,
    vSwitchId,
    instanceType,
    imageId,
    internetMaxBandwidthOut: 0,
    ramRoleName: '',
    httpTokens: 'required',
    inboundAcceptCount: 0,
    egressRules,
  };

  return {
    backend: 'provider-vm',
    runId,
    headRefOid,
    autoReleaseTime: releaseTime,
    egressRules,
    authorizeEgressArgvs,
    runInstancesArgv,
    launchPolicyDigest: sha256Json(policy),
  };
}

/**
 * Matches the real Aliyun `DescribeInvocationResults` terminal states
 * observed in P7 (`InvocationStatus === 'Success'` / `InvokeRecordStatus === 'Finished'`).
 */
export function isAliyunInvocationComplete(inv) {
  if (!inv || typeof inv !== 'object') return false;
  return (
    ['Success', 'Finished', 'Failed', 'Stopped', 'Timeout'].includes(
      inv.InvocationStatus,
    ) || inv.InvokeRecordStatus === 'Finished'
  );
}

/**
 * Identifies transient Aliyun `DeleteInstance` errors during the first few
 * seconds after an instance enters `Running` (`IncorrectInstanceStatus.Initializing`).
 */
export function isAliyunTransientDeleteError(stderr) {
  return (
    typeof stderr === 'string' &&
    /IncorrectInstanceStatus(?:\.Initializing)?/.test(stderr)
  );
}

const PUBLIC_UNRESTRICTED_SANDBOX_TEMPLATES = new Set([
  'code-interpreter-v1',
  'base',
]);

/**
 * Builds the normalized Aliyun Agent Sandbox (`fcsandbox` 2026-05-09 / E2B
 * compatible) plan for `provider-vm` rounds:
 *   - enforces custom hardened templates (`runtimeConfig.internetAccess: false`
 *     + isolated VPC security group) for high-assurance PR verification;
 *     refuses built-in public templates like `code-interpreter-v1` whose P7
 *     probe proved default public egress is OPEN
 *   - binds E2B-compatible data-plane URLs (`https://api.<region>.sandbox.aliyuncs.com`)
 *   - encodes the observed two-step API key teardown (`UpdateApiKey status=inactive`
 *     followed by `DeleteApiKey`)
 */
export function buildAliyunAgentSandboxPlan({
  runId,
  headRefOid,
  region,
  teamId,
  templateName,
  vpcId,
  vSwitchIds,
  securityGroupId,
  image,
  cpu = 2.0,
  memorySizeMib = 2048,
  diskSizeGib = 10,
  timeoutMs = 300_000,
  allowPublicTemplateForProbe = false,
}) {
  assertRunId(runId);
  if (!FULL_OID_RE.test(headRefOid ?? '')) {
    throw new Error('aliyun-agent-sandbox requires a 40-hex headRefOid');
  }
  if (typeof region !== 'string' || region.trim() === '') {
    throw new Error('aliyun-agent-sandbox requires a non-empty region');
  }
  if (typeof teamId !== 'string' || teamId.trim() === '') {
    throw new Error('aliyun-agent-sandbox requires a non-empty teamId');
  }
  if (typeof templateName !== 'string' || templateName.trim() === '') {
    throw new Error('aliyun-agent-sandbox requires a templateName');
  }
  const normalizedTemplate = templateName.trim().toLowerCase();
  if (
    !allowPublicTemplateForProbe &&
    PUBLIC_UNRESTRICTED_SANDBOX_TEMPLATES.has(normalizedTemplate)
  ) {
    throw new Error(
      `refusing built-in template ${JSON.stringify(templateName)} for high-assurance PR verification (P7 proved default public egress is OPEN); use a custom hardened template with internetAccess: false and VPC security group`,
    );
  }
  if (
    !allowPublicTemplateForProbe &&
    (!vpcId ||
      !Array.isArray(vSwitchIds) ||
      vSwitchIds.length === 0 ||
      !securityGroupId)
  ) {
    throw new Error(
      'aliyun-agent-sandbox high-assurance template requires vpcId, non-empty vSwitchIds, and securityGroupId',
    );
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10_000 ||
    timeoutMs > 86_400_000
  ) {
    throw new Error(
      'aliyun-agent-sandbox timeoutMs must be within 10s..86400s',
    );
  }

  const domain = `${region}.sandbox.aliyuncs.com`;
  const apiUrl = `https://api.${domain}`;

  const templateBody = {
    teamID: teamId,
    name: templateName,
    buildConfig: {
      envdInject: { enabled: true },
    },
    runtimeConfig: {
      cpu,
      memorySize: memorySizeMib,
      diskSize: diskSizeGib,
      internetAccess: false,
      ...(vpcId
        ? {
            vpcConfig: {
              vpcId,
              vSwitchIds,
              securityGroupId,
            },
          }
        : {}),
      ...(image
        ? {
            sandboxConfig: {
              generation: 2,
              osType: 'linux',
              image,
            },
          }
        : {}),
    },
  };

  // Two-step teardown observed in P7: DeleteApiKey rejects active keys with
  // InvalidApiKeyStatus ("only inactive API keys can be deleted").
  const revokeApiKeyArgvs = (apiKeyId) => [
    [
      'fcsandbox',
      'UpdateApiKey',
      '--region',
      region,
      '--apiKeyID',
      apiKeyId,
      '--body',
      JSON.stringify({ status: 'inactive' }),
    ],
    ['fcsandbox', 'DeleteApiKey', '--region', region, '--apiKeyID', apiKeyId],
  ];

  const policy = {
    backend: 'provider-vm',
    provider: 'aliyun-fcsandbox',
    region,
    teamId,
    templateName,
    domain,
    apiUrl,
    internetAccess: false,
    vpcId: vpcId ?? null,
    securityGroupId: securityGroupId ?? null,
    cpu,
    memorySizeMib,
    diskSizeGib,
    timeoutMs,
  };

  return {
    backend: 'provider-vm',
    provider: 'aliyun-fcsandbox',
    runId,
    headRefOid,
    domain,
    apiUrl,
    templateName,
    templateBody,
    sandboxCreateOptions: {
      template: templateName,
      apiUrl,
      domain,
      timeoutMs,
    },
    revokeApiKeyArgvs,
    launchPolicyDigest: sha256Json(policy),
  };
}

function withinDir(root, target) {
  return (
    target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

function writePrivateSafeFile(filePath, content) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      throw new Error(
        `refusing to overwrite symlink, non-regular, or multi-link file: ${filePath}`,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  writeFileSync(filePath, content, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function sha256RegularFile(filePath, maxBytes = null) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    return { error: `unreadable:${error.code ?? 'ENOENT'}`, digest: null };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { error: 'non-regular-or-symlink', digest: null };
  }
  if (maxBytes !== null && (st.size === 0 || st.size > maxBytes)) {
    return { error: `bundle-size-budget:${maxBytes}`, digest: null };
  }

  let fd;
  try {
    fd = openSync(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    st = fstatSync(fd);
    if (!st.isFile()) {
      return { error: 'non-regular-or-symlink', digest: null };
    }
    if (maxBytes !== null && (st.size === 0 || st.size > maxBytes)) {
      return { error: `bundle-size-budget:${maxBytes}`, digest: null };
    }
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(256 * 1024);
    let bytesRead = 0;
    for (;;) {
      const bytes = readSync(fd, buf, 0, buf.length, null);
      if (bytes === 0) break;
      bytesRead += bytes;
      if (maxBytes !== null && bytesRead > maxBytes) {
        return { error: `bundle-size-budget:${maxBytes}`, digest: null };
      }
      hash.update(buf.subarray(0, bytes));
    }
    return {
      error: null,
      dev: st.dev,
      ino: st.ino,
      nlink: st.nlink,
      bytes: bytesRead,
      digest: hash.digest('hex'),
    };
  } catch (error) {
    return { error: `unreadable:${error.code ?? 'UNKNOWN'}`, digest: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeOwnedSocket(filePath, identity) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `proxy-socket-stat-failed:${error.code}`;
  }
  if (!st.isSocket() || st.dev !== identity.dev || st.ino !== identity.ino) {
    return 'proxy-socket-identity-changed';
  }
  try {
    unlinkSync(filePath);
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `proxy-socket-remove-failed:${error.code}`;
  }
}

function validateDefaultLaunchInputs(plan) {
  if (plan.backend === 'firecracker') {
    const kernelImage = plan.vmConfig?.['boot-source']?.kernel_image_path;
    const rootDrives = plan.vmConfig?.drives?.filter(
      (drive) => drive.drive_id === 'rootfs',
    );
    const rootImage =
      rootDrives?.length === 1 ? rootDrives[0].path_on_host : null;
    const configArgs = plan.argv.flatMap((arg, i) =>
      arg === '--config-file' ? [plan.argv[i + 1]] : [],
    );
    return kernelImage === '/vmlinuz' &&
      rootImage === '/rootfs.ext4' &&
      Array.isArray(plan.vmConfig?.drives) &&
      plan.vmConfig.drives.length === 1 &&
      plan.kernelPath === join(plan.jailRoot, 'vmlinuz') &&
      plan.ownershipTemplate.workDiskPath ===
        join(plan.jailRoot, 'rootfs.ext4') &&
      configArgs.length > 0 &&
      configArgs.every((arg) => arg === '/config.json')
      ? null
      : 'firecracker argv/config does not match validated launch inputs';
  }
  const bootIndices = plan.argv.flatMap((arg, index) =>
    arg === '--bootloader' ? [index] : [],
  );
  if (
    bootIndices.length !== 1 ||
    !plan.argv[bootIndices[0] + 1]?.startsWith(
      `linux,kernel=${plan.kernelPath},`,
    )
  ) {
    return 'vfkit argv does not match the validated kernel';
  }
  const diskArgs = plan.argv.filter(
    (arg) => typeof arg === 'string' && arg.startsWith('virtio-blk,path='),
  );
  return diskArgs.length === 1 &&
    diskArgs[0] === `virtio-blk,path=${plan.ownershipTemplate.workDiskPath}`
    ? null
    : 'vfkit argv does not match the validated working disk';
}

function readSingleLinkJsonFile(filePath) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    return { error: `unreadable:${error.code ?? 'ENOENT'}`, text: null };
  }
  if (
    st.isSymbolicLink() ||
    !st.isFile() ||
    st.nlink !== 1 ||
    st.size > MAX_HOST_JSON_BYTES
  ) {
    return { error: 'invalid-host-file', text: null };
  }
  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'not-json-object', text: null };
    }
    return { error: null, text, parsed };
  } catch {
    return { error: 'invalid-json', text: null };
  }
}

async function waitForPidFile(pidFile, timeoutMs = 10_000, shouldAbort = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        if (/^\d+$/.test(raw)) {
          const pid = Number(raw);
          if (pid > 1) return pid;
        }
      } catch {
        // Retry until written cleanly.
      }
    }
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * Orchestrates one complete hardware-isolated `/verify-pr` round end to end:
 *   1. Validates host-held `contextPath` + `contextSha256` and cross-checks
 *      `trustClassification` (fail-closed before starting any process).
 *   2. Creates per-round `token.json` (0o600), optional `verify-pr-model-proxy`
 *      bound to that `tokenFile` + `maxRequests`, and `verify-pr-vm-collector`.
 *   3. Launches the configured hardware backend (Firecracker+jailer, sandboxed
 *      vfkit, or provider-vm driver) and records `ownership.json`.
 *   4. Waits for bounded collector completion, then unconditionally reaps the
 *      worker, deletes working disk/sockets, revokes `token.json`, closes the
 *      model proxy, and verifies source golden rootfs digest immutability.
 *   5. Finalizes `execution-record.json` + `boundary.json` (only on clean pass)
 *      and runs production `verify-pr-check.mjs`.
 */
export async function runHardwareRound({
  contextPath,
  contextSha256,
  launcherDir,
  vaultDir,
  approvedRoots = [],
  plan,
  backendVersion = 'unknown',
  platform = `${process.platform}-${process.arch}`,
  sourceKernelPath = null,
  sourceRootfsPath = null,
  sourceInitramfsPath = null,
  stageAssets = false,
  applyChown = null,
  trustedInputDigest = null,
  roundInput = null,
  modelProxy = null,
  collectorOptions = {},
  launchBackend = null,
  providerDriver = null,
  runChecker = true,
  verifyLivePid = true,
}) {
  const errors = [];
  if (!SHA256_RE.test(contextSha256 ?? '')) {
    return {
      ok: false,
      errors: ['contextSha256 must be a 64-hex sha256 digest'],
    };
  }
  if (roundInput === null && !SHA256_RE.test(trustedInputDigest ?? '')) {
    return {
      ok: false,
      errors: ['trustedInputDigest must be a 64-hex sha256 digest'],
    };
  }
  if (
    roundInput !== null &&
    trustedInputDigest !== null &&
    !SHA256_RE.test(trustedInputDigest)
  ) {
    return {
      ok: false,
      errors: ['trustedInputDigest must be a 64-hex sha256 digest'],
    };
  }
  if (!plan || !HARDWARE_BACKENDS.includes(plan.backend)) {
    return {
      ok: false,
      errors: [
        `plan.backend must be a hardware backend (${HARDWARE_BACKENDS.join(' | ')})`,
      ],
    };
  }

  mkdirSync(resolve(launcherDir), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(vaultDir), { recursive: true, mode: 0o700 });
  const realLauncher = realpathSync(resolve(launcherDir));
  const realVault = realpathSync(resolve(vaultDir));
  if (
    realLauncher === realVault ||
    withinDir(realVault, realLauncher) ||
    withinDir(realLauncher, realVault)
  ) {
    return {
      ok: false,
      errors: ['launcherDir and vaultDir must not overlap or nest'],
    };
  }

  const ctxRead = readSingleLinkJsonFile(contextPath);
  if (ctxRead.error) {
    return { ok: false, errors: [`host context rejected: ${ctxRead.error}`] };
  }
  const realContext = realpathSync(resolve(contextPath));
  if (withinDir(realVault, realContext)) {
    return {
      ok: false,
      errors: ['contextPath must not reside inside vaultDir'],
    };
  }
  const actualCtxSha = createHash('sha256')
    .update(ctxRead.text, 'utf8')
    .digest('hex');
  if (actualCtxSha !== contextSha256) {
    return {
      ok: false,
      errors: ['contextPath bytes do not match contextSha256'],
    };
  }
  const contextSnapshot = ctxRead.parsed;
  const tcCheck = checkTrustClassification(
    contextSnapshot.trustClassification,
    contextSnapshot.headRefOid ?? null,
  );
  if (tcCheck.errors.length > 0) {
    return { ok: false, errors: tcCheck.errors };
  }

  if (
    plan.backend === 'provider-vm' &&
    plan.headRefOid !== contextSnapshot.headRefOid
  ) {
    return {
      ok: false,
      errors: ['provider plan headRefOid must match the host context'],
    };
  }
  if (
    plan.backend === 'provider-vm' &&
    typeof plan.runInstancesArgv === 'function'
  ) {
    let launchHeadMatches = false;
    try {
      const argv = plan.runInstancesArgv('preflight-validation');
      const keyIndex = argv.indexOf('--Tag.3.Key');
      launchHeadMatches =
        keyIndex >= 0 &&
        argv[keyIndex + 1] === 'qwen-head-oid' &&
        argv[keyIndex + 3] === contextSnapshot.headRefOid;
    } catch {
      launchHeadMatches = false;
    }
    if (!launchHeadMatches) {
      return {
        ok: false,
        errors: ['provider launch argv head must match the host context'],
      };
    }
  }
  const effectiveProxySocketPath =
    modelProxy !== null
      ? (modelProxy.socketPath ??
        (modelProxy.listenHost === undefined && plan.modelVsockPath
          ? plan.modelVsockPath
          : null))
      : null;
  if (modelProxy !== null) {
    if (
      typeof modelProxy !== 'object' ||
      Array.isArray(modelProxy) ||
      !Number.isSafeInteger(modelProxy.maxRequests) ||
      modelProxy.maxRequests <= 0
    ) {
      return {
        ok: false,
        errors: [
          'modelProxy.maxRequests is required and must be a positive safe integer',
        ],
      };
    }
    if (
      modelProxy.listenHost !== undefined &&
      (typeof modelProxy.listenHost !== 'string' ||
        modelProxy.listenHost === '')
    ) {
      return {
        ok: false,
        errors: ['modelProxy.listenHost must be a non-empty string'],
      };
    }
    if (
      modelProxy.socketPath !== undefined &&
      (typeof modelProxy.socketPath !== 'string' ||
        modelProxy.socketPath.trim() === '')
    ) {
      return {
        ok: false,
        errors: ['modelProxy.socketPath must be a non-empty string'],
      };
    }
    for (const field of ['vmmUid', 'vmmGid']) {
      if (
        modelProxy[field] !== undefined &&
        (!Number.isInteger(modelProxy[field]) || modelProxy[field] <= 0)
      ) {
        return {
          ok: false,
          errors: [`modelProxy.${field} must be a positive integer`],
        };
      }
    }
    if (
      (modelProxy.vmmUid === undefined) !==
      (modelProxy.vmmGid === undefined)
    ) {
      return {
        ok: false,
        errors: ['modelProxy.vmmUid and vmmGid must be provided together'],
      };
    }
    if (modelProxy.vmmUid !== undefined && !effectiveProxySocketPath) {
      return {
        ok: false,
        errors: ['modelProxy.vmmUid and vmmGid require socketPath'],
      };
    }
  }

  const isLocalVmm = plan.backend === 'firecracker' || plan.backend === 'vfkit';
  if (roundInput !== null) {
    if (typeof roundInput !== 'object' || Array.isArray(roundInput)) {
      return { ok: false, errors: ['roundInput must be an object'] };
    }
    if (isLocalVmm && !plan.inputVsockPath) {
      return {
        ok: false,
        errors: [
          'roundInput requires plan.inputVsockPath (pass inputVsockPort to launch plan)',
        ],
      };
    }
    const reqBase = roundInput.baseRefOid ?? contextSnapshot.baseRefOid;
    const reqHead = roundInput.headRefOid ?? contextSnapshot.headRefOid;
    if (
      !FULL_OID_RE.test(reqBase ?? '') ||
      reqBase !== contextSnapshot.baseRefOid
    ) {
      return {
        ok: false,
        errors: [
          'roundInput.baseRefOid must match the host context baseRefOid',
        ],
      };
    }
    if (
      !FULL_OID_RE.test(reqHead ?? '') ||
      reqHead !== contextSnapshot.headRefOid
    ) {
      return {
        ok: false,
        errors: [
          'roundInput.headRefOid must match the host context headRefOid',
        ],
      };
    }
    if (!roundInput.repoDir && !roundInput.bundlePath) {
      return {
        ok: false,
        errors: ['roundInput requires repoDir or prebuilt bundlePath'],
      };
    }
    if (
      modelProxy !== null &&
      (!plan.modelVsockPath || effectiveProxySocketPath !== plan.modelVsockPath)
    ) {
      return {
        ok: false,
        errors: [
          'roundInput with modelProxy must bind plan.modelVsockPath for guest access',
        ],
      };
    }
  }
  let kernelDigest = null;
  let rootfsDigest = null;
  let stagedAssets = null;
  const failBeforeLaunch = (failureErrors) => {
    if (stagedAssets) {
      try {
        stagedAssets.cleanup();
      } catch {
        // Best-effort cleanup of unlaunched per-round staged assets.
      }
      stagedAssets = null;
    }
    return { ok: false, errors: failureErrors };
  };
  if (isLocalVmm) {
    if (!plan.hostVsockPath) {
      return failBeforeLaunch(['local VMM plan requires hostVsockPath']);
    }
    if (
      typeof launchBackend !== 'function' &&
      (!Array.isArray(plan.argv) || plan.argv.length === 0)
    ) {
      return failBeforeLaunch(['local VMM plan requires non-empty argv']);
    }
    if (!sourceKernelPath || !sourceRootfsPath) {
      return failBeforeLaunch([
        'local VMM backends require sourceKernelPath and sourceRootfsPath for digest verification',
      ]);
    }
    if (stageAssets === true) {
      try {
        stagedAssets = stageLocalVmRound({
          plan,
          sourceKernelPath,
          sourceRootfsPath,
          sourceInitramfsPath,
          approvedRoots,
          vaultDir: realVault,
          applyChown,
        });
      } catch (error) {
        return failBeforeLaunch([`stage-assets-failed:${error.message}`]);
      }
    }
    const kHash = sha256RegularFile(sourceKernelPath);
    if (kHash.error) {
      return failBeforeLaunch([`sourceKernelPath rejected (${kHash.error})`]);
    }
    const rHash = sha256RegularFile(sourceRootfsPath);
    if (rHash.error) {
      return failBeforeLaunch([`sourceRootfsPath rejected (${rHash.error})`]);
    }
    const launchKernel = sha256RegularFile(plan.kernelPath);
    if (launchKernel.error || launchKernel.digest !== kHash.digest) {
      return failBeforeLaunch([
        'planned kernel must be a regular file matching sourceKernelPath',
      ]);
    }
    const workDisk = plan.ownershipTemplate?.workDiskPath;
    if (!workDisk) {
      return failBeforeLaunch([
        'local VMM plan requires ownershipTemplate.workDiskPath',
      ]);
    }
    const realSrcRootfs = realpathSync(resolve(sourceRootfsPath));
    let realWorkDisk = resolve(workDisk);
    try {
      realWorkDisk = realpathSync(realWorkDisk);
    } catch {
      // Keep lexical resolved path if working disk does not exist yet.
    }
    if (realWorkDisk === realSrcRootfs) {
      return failBeforeLaunch([
        'working disk path must be a per-round copy distinct from sourceRootfsPath',
      ]);
    }
    const launchDisk = sha256RegularFile(workDisk);
    if (launchDisk.error || launchDisk.digest !== rHash.digest) {
      return failBeforeLaunch([
        'working disk must be a regular-file copy matching sourceRootfsPath',
      ]);
    }
    if (
      launchDisk.nlink !== 1 ||
      (launchDisk.dev === rHash.dev && launchDisk.ino === rHash.ino)
    ) {
      return failBeforeLaunch([
        'working disk must be independently owned storage, not a hardlink or shared inode',
      ]);
    }
    if (typeof launchBackend !== 'function') {
      const launchError = validateDefaultLaunchInputs(plan);
      if (launchError) return failBeforeLaunch([launchError]);
      const diskConfigCheck = verifyFirecrackerDiskConfig(plan, {
        requireExists: stageAssets === true,
      });
      if (!diskConfigCheck.ok) {
        return failBeforeLaunch([diskConfigCheck.error]);
      }
      const vfkitProfileCheck = verifyVfkitSeatbeltProfile(plan, {
        approvedRoots,
        vaultDir: realVault,
        requireExists: stageAssets === true,
      });
      if (!vfkitProfileCheck.ok) {
        return failBeforeLaunch([vfkitProfileCheck.error]);
      }
    }
    kernelDigest = kHash.digest;
    rootfsDigest = rHash.digest;
  }

  const tokenFile = join(realLauncher, 'token.json');
  const proxyToken = randomBytes(24).toString('hex');
  const proxyNonce = randomBytes(24).toString('hex');

  let effectiveTrustedInputDigest = trustedInputDigest;
  let preparedInput = null;
  if (roundInput !== null) {
    const maxBundleBytes =
      roundInput.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
    if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes <= 0) {
      return failBeforeLaunch([
        'roundInput.maxBundleBytes must be a positive safe integer',
      ]);
    }
    try {
      const entropyHex =
        roundInput.entropyHex ?? randomBytes(32).toString('hex');
      if (
        typeof entropyHex !== 'string' ||
        /^[0-9a-f]{64}$/.exec(entropyHex)?.[0] !== entropyHex
      ) {
        throw new Error('entropyHex must be a 64-char lowercase hex string');
      }
      let bundleInfo;
      const prebuiltHashBudget = Math.min(
        maxBundleBytes,
        DEFAULT_MAX_BUNDLE_BYTES,
      );
      if (roundInput.repoDir) {
        bundleInfo = createRoundInputBundle({
          repoDir: roundInput.repoDir,
          baseRefOid: contextSnapshot.baseRefOid,
          headRefOid: contextSnapshot.headRefOid,
          outPath: join(realLauncher, 'round-input.bundle'),
          maxBundleBytes: prebuiltHashBudget,
        });
      } else {
        const bHash = sha256RegularFile(
          roundInput.bundlePath,
          prebuiltHashBudget,
        );
        if (bHash.error) {
          throw new Error(`roundInput.bundlePath rejected (${bHash.error})`);
        }
        const realBundle = realpathSync(resolve(roundInput.bundlePath));
        if (withinDir(realVault, realBundle)) {
          throw new Error(
            'roundInput.bundlePath must not reside inside vaultDir',
          );
        }
        const bStat = lstatSync(realBundle);
        if (bStat.nlink !== 1) {
          throw new Error(
            'roundInput.bundlePath must be a single-link regular file',
          );
        }
        if (
          bStat.dev !== bHash.dev ||
          bStat.ino !== bHash.ino ||
          bStat.size !== bHash.bytes
        ) {
          throw new Error(
            'roundInput.bundlePath changed while it was being hashed',
          );
        }
        if (
          roundInput.bundleSha256 !== undefined &&
          roundInput.bundleSha256 !== bHash.digest
        ) {
          throw new Error(
            'roundInput.bundlePath bytes do not match bundleSha256',
          );
        }
        if (
          roundInput.bundleBytes !== undefined &&
          roundInput.bundleBytes !== bStat.size
        ) {
          throw new Error(
            'roundInput.bundlePath size does not match bundleBytes',
          );
        }
        const privateBundle = join(realLauncher, 'round-input.bundle');
        const stagedBundle = join(
          realLauncher,
          `.round-input.bundle.tmp.${process.pid}`,
        );
        let existingPrivate = null;
        try {
          existingPrivate = lstatSync(privateBundle);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (
          existingPrivate &&
          (!existingPrivate.isFile() ||
            existingPrivate.isSymbolicLink() ||
            existingPrivate.nlink !== 1)
        ) {
          throw new Error(
            'refusing to overwrite a non-regular or multi-link private bundle',
          );
        }
        let sourceFd;
        let stagedFd;
        let stagedIdentity;
        let cleanupError;
        try {
          sourceFd = openSync(
            realBundle,
            fsConstants.O_RDONLY |
              fsConstants.O_NOFOLLOW |
              fsConstants.O_NONBLOCK,
          );
          const sourceStat = fstatSync(sourceFd);
          if (sourceStat.size === 0 || sourceStat.size > prebuiltHashBudget) {
            throw new Error(`bundle-size-budget:${prebuiltHashBudget}`);
          }
          if (
            !sourceStat.isFile() ||
            sourceStat.nlink !== 1 ||
            sourceStat.dev !== bHash.dev ||
            sourceStat.ino !== bHash.ino ||
            sourceStat.size !== bStat.size
          ) {
            throw new Error(
              'roundInput.bundlePath changed before its private copy was opened',
            );
          }
          stagedFd = openSync(
            stagedBundle,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW |
              fsConstants.O_NONBLOCK,
            0o600,
          );
          fchmodSync(stagedFd, 0o600);
          stagedIdentity = fstatSync(stagedFd);
          if (!stagedIdentity.isFile() || stagedIdentity.nlink !== 1) {
            throw new Error(
              'private bundle staging must be a single-link file',
            );
          }
          const copyHash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(256 * 1024);
          let copiedBytes = 0;
          for (;;) {
            const bytes = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytes === 0) break;
            copiedBytes += bytes;
            if (copiedBytes > prebuiltHashBudget) {
              throw new Error(`bundle-size-budget:${prebuiltHashBudget}`);
            }
            copyHash.update(buffer.subarray(0, bytes));
            let offset = 0;
            while (offset < bytes) {
              offset += writeSync(
                stagedFd,
                buffer,
                offset,
                bytes - offset,
                null,
              );
            }
          }
          const copiedSha256 = copyHash.digest('hex');
          if (copiedBytes !== bStat.size || copiedSha256 !== bHash.digest) {
            throw new Error(
              'roundInput.bundlePath changed while its private copy was made',
            );
          }
          renameSync(stagedBundle, privateBundle);
          bundleInfo = {
            bundlePath: privateBundle,
            bundleSha256: copiedSha256,
            bundleBytes: copiedBytes,
          };
        } finally {
          try {
            if (sourceFd !== undefined) closeSync(sourceFd);
            if (stagedFd !== undefined) closeSync(stagedFd);
            if (stagedIdentity !== undefined) {
              let remaining;
              try {
                remaining = lstatSync(stagedBundle);
              } catch (error) {
                if (error.code !== 'ENOENT') cleanupError = error;
              }
              if (
                !cleanupError &&
                remaining &&
                (!remaining.isFile() ||
                  remaining.dev !== stagedIdentity.dev ||
                  remaining.ino !== stagedIdentity.ino)
              ) {
                cleanupError = new Error(
                  'private bundle staging changed identity before cleanup',
                );
              }
              if (!cleanupError && remaining) unlinkSync(stagedBundle);
            }
          } catch (error) {
            cleanupError = error;
          }
        }
        if (cleanupError) throw cleanupError;
      }
      if (bundleInfo.bundleBytes > prebuiltHashBudget) {
        throw new Error(
          `roundInput bundle exceeds guest transport limit ${prebuiltHashBudget} bytes`,
        );
      }
      const manifestModelProxy = modelProxy
        ? {
            port: plan.modelVsockPort ?? DEFAULT_MODEL_VSOCK_PORT,
            basePath: normalizeBasePath(new URL(modelProxy.baseUrl).pathname),
            token: proxyToken,
            nonce: proxyNonce,
          }
        : null;
      const built = buildInputManifest({
        runId: plan.runId,
        repo: contextSnapshot.repo ?? '',
        prNumber: contextSnapshot.number ?? contextSnapshot.pr ?? null,
        baseRefOid: contextSnapshot.baseRefOid,
        headRefOid: contextSnapshot.headRefOid,
        bundleSha256: bundleInfo.bundleSha256,
        bundleBytes: bundleInfo.bundleBytes,
        modelProxy: manifestModelProxy,
        entropyHex,
      });
      if (
        trustedInputDigest !== null &&
        trustedInputDigest !== built.trustedInputDigest
      ) {
        return failBeforeLaunch([
          'trustedInputDigest does not match generated roundInput manifest digest',
        ]);
      }
      effectiveTrustedInputDigest = built.trustedInputDigest;
      preparedInput = { ...bundleInfo, ...built };
    } catch (error) {
      return failBeforeLaunch([`round-input-rejected:${error.message}`]);
    }
  }

  try {
    writePrivateSafeFile(
      tokenFile,
      `${JSON.stringify({ runId: plan.runId, revoked: false }, null, 2)}\n`,
    );
  } catch (error) {
    return failBeforeLaunch([`token-file-rejected:${error.message}`]);
  }

  let proxyServer = null;
  let proxyInfo = null;
  let proxySocketOwned = false;
  let proxySocketIdentity = null;
  let inputServer = null;
  let collector = null;
  let ownershipPath = null;
  let launched = null;
  let providerAlloc = null;
  let collectorSummary = {
    outputStatus: 'incomplete',
    reason: 'not-started',
    files: [],
    vaultEntries: [],
  };
  let teardownStatus = 'failed';
  let diskDestroyed = false;
  let tokenRevoked = false;
  let sourceRootfsUnchanged = true;
  let workerPid = null;
  let supervisorPid = null;
  let workerExe = null;
  let workerExitEvidence = 'unknown';
  let workerIdentityUnproven = false;
  let providerLifecycle = null;

  const startedAt = new Date().toISOString();
  let endedAt = startedAt;
  let destroyedAt = null;
  const ownedSocketPaths = new Set();
  let ownedSocketDir = undefined;
  const syncOwnershipSockets = (extra = {}) => {
    if (!isLocalVmm || !ownershipPath) return;
    writeOwnershipRecord(ownershipPath, {
      ...plan.ownershipTemplate,
      socketPaths: [...ownedSocketPaths],
      socketDir: ownedSocketDir,
      tokenFile,
      ...extra,
    });
  };

  try {
    // Establish the recovery record for already-validated per-round assets
    // before listener or process launch. Socket paths are added only after
    // each listener succeeds so refusing a pre-existing path never deletes
    // it during teardown.
    if (isLocalVmm) {
      ownershipPath = join(realLauncher, 'ownership.json');
      syncOwnershipSockets();
    }

    // 1. Optional host-side model proxy bound to this round's token.json
    if (modelProxy) {
      proxyServer = createModelProxy({
        baseUrl: modelProxy.baseUrl,
        apiKey: modelProxy.apiKey,
        token: proxyToken,
        nonce: proxyNonce,
        idleTimeoutMs: modelProxy.idleTimeoutMs,
        tokenFile,
        maxRequests: modelProxy.maxRequests,
      });
      if (effectiveProxySocketPath) {
        const sockLen = validateSocketPathLength(effectiveProxySocketPath);
        if (!sockLen.ok) throw new Error(`model proxy: ${sockLen.reason}`);
        try {
          lstatSync(effectiveProxySocketPath);
          throw new Error(
            `model proxy: refusing existing socket path ${effectiveProxySocketPath}`,
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise((res, rej) => {
          proxyServer.once('error', rej);
          proxyServer.listen(effectiveProxySocketPath, res);
        });
        proxySocketOwned = true;
        const socketStat = lstatSync(effectiveProxySocketPath);
        proxySocketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
        chmodSync(effectiveProxySocketPath, 0o600);
        const proxyUid = modelProxy.vmmUid ?? plan.vmmUid ?? null;
        const proxyGid = modelProxy.vmmGid ?? plan.vmmGid ?? null;
        if (Number.isInteger(proxyUid) && Number.isInteger(proxyGid)) {
          chownSync(effectiveProxySocketPath, proxyUid, proxyGid);
        }
        ownedSocketPaths.add(effectiveProxySocketPath);
        syncOwnershipSockets();
        proxyInfo = {
          socketPath: effectiveProxySocketPath,
          token: proxyToken,
          nonce: proxyNonce,
        };
      } else {
        const listenHost = modelProxy.listenHost ?? '127.0.0.1';
        await new Promise((res, rej) => {
          proxyServer.once('error', rej);
          proxyServer.listen(0, listenHost, res);
        });
        const { port } = proxyServer.address();
        proxyInfo = {
          port,
          baseUrl: formatLocalBaseUrl(
            listenHost,
            port,
            normalizeBasePath(new URL(modelProxy.baseUrl).pathname),
          ),
          token: proxyToken,
          nonce: proxyNonce,
        };
      }
    }

    // 1.5. Optional host-to-guest read-only input server (vsock port 53)
    if (preparedInput && plan.inputVsockPath) {
      inputServer = startInputServer({
        socketPath: plan.inputVsockPath,
        manifest: preparedInput.manifest,
        manifestBytes: preparedInput.manifestBytes,
        bundlePath: preparedInput.bundlePath,
        tokenFile,
        vmmUid: plan.vmmUid ?? null,
        vmmGid: plan.vmmGid ?? null,
        ...(roundInput.maxReads !== undefined
          ? { maxReads: roundInput.maxReads }
          : {}),
      });
      await inputServer.ready;
      ownedSocketPaths.add(plan.inputVsockPath);
      syncOwnershipSockets();
    }

    // 2. Start bounded content-only collector when plan carries a UDS path
    if (plan.hostVsockPath) {
      collector = startCollectorServer({
        ...collectorOptions,
        socketPath: plan.hostVsockPath,
        vaultDir: realVault,
        vmmUid: plan.vmmUid ?? null,
        vmmGid: plan.vmmGid ?? null,
      });
      await collector.ready;
      ownedSocketPaths.add(plan.hostVsockPath);
      if (plan.backend === 'firecracker' && plan.jailRoot) {
        ownedSocketPaths.add(join(plan.jailRoot, 'v.sock'));
      }
      if (plan.ownershipTemplate?.socketDir) {
        ownedSocketDir = plan.ownershipTemplate.socketDir;
      }
      syncOwnershipSockets();
    }

    // 3. Launch hardware backend (or injected driver) and record ownership
    if (plan.backend === 'provider-vm') {
      if (!providerDriver || typeof providerDriver.allocate !== 'function') {
        throw new Error(
          'provider-vm execution requires providerDriver.{allocate,destroy}',
        );
      }
      providerAlloc = await providerDriver.allocate({
        plan,
        vaultDir: realVault,
        launcherDir: realLauncher,
        proxyInfo,
        collectorSocketPath: plan.hostVsockPath ?? null,
        inputSocketPath: plan.inputVsockPath ?? null,
        roundInput: preparedInput,
      });
      if (collector) {
        collectorSummary = await collector.done;
      } else if (providerAlloc?.outputStatus) {
        collectorSummary = {
          outputStatus: providerAlloc.outputStatus,
          reason: providerAlloc.outputReason ?? 'provider',
          files: providerAlloc.files ?? [],
          vaultEntries: [],
        };
      }
    } else {
      if (typeof launchBackend === 'function') {
        launched = await launchBackend({
          plan,
          vaultDir: realVault,
          launcherDir: realLauncher,
          proxyInfo,
          collectorSocketPath: plan.hostVsockPath,
          inputSocketPath: plan.inputVsockPath ?? null,
          roundInput: preparedInput,
        });
      } else {
        // Re-verify on-disk VM configs right before spawn to narrow the window
        // after staging/token/collector setup.
        const preSpawnConfigCheck = verifyFirecrackerDiskConfig(plan, {
          requireExists: stageAssets === true,
        });
        if (!preSpawnConfigCheck.ok) {
          throw new Error(preSpawnConfigCheck.error);
        }
        const preSpawnProfileCheck = verifyVfkitSeatbeltProfile(plan, {
          approvedRoots,
          vaultDir: realVault,
          requireExists: stageAssets === true,
        });
        if (!preSpawnProfileCheck.ok) {
          throw new Error(preSpawnProfileCheck.error);
        }
        const child = spawn(plan.argv[0], plan.argv.slice(1), {
          stdio: 'ignore',
          detached: plan.backend === 'firecracker',
          env: {
            // The VMM/helper must not inherit host credentials.
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          },
        });
        let spawnError = null;
        let childExited = false;
        const onChildError = (err) => {
          spawnError = err;
          childExited = true;
        };
        child.once('error', onChildError);
        child.once('exit', () => {
          childExited = true;
        });
        // Wait one turn (or spawn/error event) so ENOENT / EACCES surfaces
        // cleanly instead of leaving an unhandled error or undefined PID.
        await new Promise((resolveSpawn, rejectSpawn) => {
          if (spawnError) {
            rejectSpawn(spawnError);
            return;
          }
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        });
        const expectedExeTokens = plan.ownershipTemplate.expectedExeTokens;
        launched = {
          workerPid: child.pid,
          supervisorPid: child.pid,
          workerExe: expectedExeTokens[0],
          child,
          childExited: () => childExited,
          ...(plan.backend === 'firecracker'
            ? { processGroupId: child.pid }
            : {}),
        };
        workerPid = child.pid;
        supervisorPid = child.pid;
        workerExe = expectedExeTokens[0];
        syncOwnershipSockets({
          worker: {
            pid: child.pid,
            expectedExeTokens,
            ...(plan.backend === 'firecracker'
              ? { processGroupId: child.pid }
              : {}),
          },
        });
        let pid = child.pid;
        let supPid = child.pid;
        if (plan.backend === 'firecracker' && plan.workerPidFile) {
          const fcPid = await waitForPidFile(
            plan.workerPidFile,
            10_000,
            () => childExited,
          );
          if (!fcPid) {
            workerIdentityUnproven = true;
            throw new Error(
              `timed out waiting for firecracker worker pid file ${plan.workerPidFile}`,
            );
          }
          pid = fcPid;
        }
        launched.workerPid = pid;
        launched.supervisorPid = supPid;
        workerPid = pid;
        supervisorPid = supPid;
        workerExe = plan.ownershipTemplate.expectedExeTokens[0];
        syncOwnershipSockets({
          worker: {
            pid,
            expectedExeTokens: plan.ownershipTemplate.expectedExeTokens,
            ...(launched.processGroupId > 1
              ? { processGroupId: launched.processGroupId }
              : {}),
          },
          ...(child.pid !== pid
            ? {
                helpers: [
                  {
                    pid: child.pid,
                    expectedExeTokens: plan.ownershipTemplate.expectedExeTokens,
                  },
                ],
              }
            : {}),
        });
      }

      workerPid = launched?.workerPid ?? null;
      supervisorPid = launched?.supervisorPid ?? workerPid;
      workerExe =
        launched?.workerExe ??
        plan.ownershipTemplate?.expectedExeTokens?.[0] ??
        null;

      ownershipPath = join(realLauncher, 'ownership.json');
      syncOwnershipSockets({
        worker: {
          pid: workerPid,
          expectedExeTokens:
            launched?.expectedExeTokens ??
            plan.ownershipTemplate?.expectedExeTokens ??
            [],
          ...(launched?.processGroupId > 1
            ? { processGroupId: launched.processGroupId }
            : {}),
        },
        ...(Number.isInteger(launched?.supervisorPid) &&
        launched.supervisorPid > 1 &&
        launched.supervisorPid !== workerPid
          ? {
              helpers: [
                {
                  pid: launched.supervisorPid,
                  expectedExeTokens:
                    launched.expectedExeTokens ??
                    plan.ownershipTemplate?.expectedExeTokens ??
                    [],
                },
              ],
            }
          : {}),
      });

      let collectorFinished = false;
      let earlyExitTimer = null;
      const onEarlyExit = () => {
        if (collectorFinished || earlyExitTimer) return;
        earlyExitTimer = setTimeout(() => {
          earlyExitTimer = null;
          if (collectorFinished) return;
          const workerStillAlive =
            Number.isInteger(workerPid) && workerPid > 1
              ? inspectPidState(workerPid).alive
              : false;
          if (!workerStillAlive) {
            errors.push('worker-exited-before-collector-done');
            collector.close();
          }
        }, 500);
        earlyExitTimer.unref?.();
      };
      if (launched?.child) {
        if (launched.childExited?.() || launched.child.exitCode !== null) {
          onEarlyExit();
        } else {
          launched.child.once('exit', onEarlyExit);
        }
      }
      try {
        collectorSummary = await collector.done;
      } finally {
        collectorFinished = true;
        if (earlyExitTimer) {
          clearTimeout(earlyExitTimer);
          earlyExitTimer = null;
        }
        if (launched?.child) {
          launched.child.removeListener('exit', onEarlyExit);
        }
      }
    }

    endedAt = new Date().toISOString();
  } catch (error) {
    errors.push(`round-execution-error:${error.message}`);
    endedAt = new Date().toISOString();
    if (collector) {
      collector.close();
      try {
        collectorSummary = await collector.done;
      } catch {
        // Ignore collector shutdown error.
      }
    }
  } finally {
    // 4. Unconditional teardown: close model proxy & input server UDS first
    //    (so no further calls can fly and per-round socketDir is empty before
    //    reapOwnership rmdirs it), then reap local VMM or destroy provider VM,
    //    revoke token.json, and verify source golden immutability.
    const replacedSocketPaths = new Set();
    if (proxyServer) {
      let proxyIdentityChanged = false;
      if (proxySocketOwned && effectiveProxySocketPath) {
        const cleanupError = removeOwnedSocket(
          effectiveProxySocketPath,
          proxySocketIdentity,
        );
        if (cleanupError) {
          errors.push(cleanupError);
          proxyIdentityChanged =
            cleanupError === 'proxy-socket-identity-changed';
          if (proxyIdentityChanged) {
            replacedSocketPaths.add(effectiveProxySocketPath);
          }
        }
      }
      if (proxyServer.listening) {
        if (typeof proxyServer.closeAllConnections === 'function') {
          proxyServer.closeAllConnections();
        }
        if (proxyIdentityChanged) {
          // Avoid libuv uv_pipe_close() blind-unlinking the replacement entry;
          // the old listening inode is already unlinked and unref() prevents
          // the handle from keeping the event loop alive.
          proxyServer.unref();
        } else {
          await new Promise((done) => {
            proxyServer.close(() => done());
          });
        }
      }
    }

    if (inputServer) {
      const inputClose = await inputServer.close();
      if (!inputClose.ok && inputClose.error) {
        errors.push(inputClose.error);
        if (inputClose.identityChanged && plan.inputVsockPath) {
          replacedSocketPaths.add(plan.inputVsockPath);
        }
      }
    }

    if (
      replacedSocketPaths.size > 0 &&
      ownershipPath &&
      existsSync(ownershipPath)
    ) {
      try {
        const curOwn = JSON.parse(readFileSync(ownershipPath, 'utf8'));
        if (Array.isArray(curOwn.socketPaths)) {
          curOwn.socketPaths = curOwn.socketPaths.filter(
            (p) => !replacedSocketPaths.has(p),
          );
          writeOwnershipRecord(ownershipPath, curOwn);
        }
      } catch {
        // Leave existing ownership record intact if unreadable.
      }
    }

    const proxyCleanupFailed = errors.some(
      (error) =>
        error.startsWith('proxy-socket-') || error.startsWith('input-socket-'),
    );
    if (isLocalVmm) {
      let reapClean = true;
      if (ownershipPath && existsSync(ownershipPath)) {
        const roots = [
          ...approvedRoots,
          realLauncher,
          ...(plan.socketDir ? [dirname(plan.socketDir), plan.socketDir] : []),
          ...(plan.jailRoot ? [dirname(plan.jailRoot)] : []),
        ];
        const reapRes = reapOwnership(ownershipPath, { approvedRoots: roots });
        if (
          reapRes.status === 'reaped' &&
          Number.isInteger(reapRes.resolvedWorkerPid) &&
          reapRes.resolvedWorkerPid > 1
        ) {
          workerPid = reapRes.resolvedWorkerPid;
          workerIdentityUnproven = false;
        }
        if (reapRes.status !== 'reaped') {
          reapClean = false;
          errors.push(...reapRes.errors.map((e) => `reap:${e}`));
        }
      } else {
        reapClean = false;
        errors.push('ownership-record-missing-at-teardown');
        // No trusted ownership record: revoke the token without guessing
        // which other paths are safe to delete.
        try {
          writePrivateSafeFile(
            tokenFile,
            `${JSON.stringify({ runId: plan.runId, revoked: true, revokedBy: 'verify-pr-vm-runner' }, null, 2)}\n`,
          );
        } catch (error) {
          reapClean = false;
          errors.push(`token-revoke-failed:${error.message}`);
        }
      }
      if (launched?.child && launched.child.exitCode === null) {
        try {
          launched.child.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      }
      const aliveAfterReap =
        Number.isInteger(workerPid) && workerPid > 1
          ? inspectPidState(workerPid).alive
          : false;
      const supervisorAlive =
        Number.isInteger(supervisorPid) &&
        supervisorPid > 1 &&
        supervisorPid !== workerPid &&
        inspectPidState(supervisorPid).alive;
      workerExitEvidence =
        workerIdentityUnproven || supervisorAlive
          ? 'unknown'
          : aliveAfterReap
            ? 'alive'
            : 'absent';
      const workDisk = plan.ownershipTemplate?.workDiskPath;
      diskDestroyed = workDisk ? !existsSync(workDisk) : true;
      tokenRevoked = isTokenFileRevoked(tokenFile);
      if (sourceRootfsPath && rootfsDigest) {
        const postHash = sha256RegularFile(sourceRootfsPath);
        sourceRootfsUnchanged =
          postHash.error === null && postHash.digest === rootfsDigest;
        if (!sourceRootfsUnchanged) {
          errors.push('source-rootfs-digest-mutated');
        }
      }
      teardownStatus =
        reapClean &&
        !proxyCleanupFailed &&
        !workerIdentityUnproven &&
        !supervisorAlive &&
        !aliveAfterReap &&
        diskDestroyed &&
        tokenRevoked &&
        sourceRootfsUnchanged
          ? 'destroyed'
          : 'failed';
      if (
        stagedAssets &&
        !aliveAfterReap &&
        !supervisorAlive &&
        workerExitEvidence === 'absent'
      ) {
        try {
          stagedAssets.cleanup();
        } catch (error) {
          errors.push(`staged-cleanup-failed:${error.message}`);
        }
      }
      destroyedAt = new Date().toISOString();
    } else if (plan.backend === 'provider-vm') {
      let destroyRes = { terminated: false, diskDeleted: false };
      let destroyClean = true;
      if (
        providerAlloc &&
        providerDriver &&
        typeof providerDriver.destroy === 'function'
      ) {
        try {
          destroyRes = await providerDriver.destroy(providerAlloc);
        } catch (error) {
          destroyClean = false;
          errors.push(`provider-destroy-error:${error.message}`);
        }
      }
      try {
        writePrivateSafeFile(
          tokenFile,
          `${JSON.stringify({ runId: plan.runId, revoked: true, revokedBy: 'verify-pr-vm-runner' }, null, 2)}\n`,
        );
      } catch (error) {
        destroyClean = false;
        errors.push(`token-revoke-failed:${error.message}`);
      }
      tokenRevoked = isTokenFileRevoked(tokenFile);
      diskDestroyed = destroyRes?.diskDeleted === true;
      const terminated = destroyRes?.terminated === true;
      teardownStatus =
        destroyClean &&
        !proxyCleanupFailed &&
        terminated &&
        diskDestroyed &&
        tokenRevoked
          ? 'destroyed'
          : 'failed';
      destroyedAt = new Date().toISOString();
      providerLifecycle = {
        allocationId: providerAlloc?.allocationId ?? '',
        freshDiskId: providerAlloc?.freshDiskId ?? '',
        boundRunId: plan.runId,
        boundHeadRefOid: contextSnapshot.headRefOid ?? '',
        terminationState: terminated ? 'terminated' : 'running',
        diskDeleted: diskDestroyed,
      };
    }
  }

  // 5. Finalize host-held execution-record.json and (only on pass) boundary.json
  const record = buildExecutionRecord({
    contextSnapshot,
    contextSha256,
    runId: plan.runId,
    backend: plan.backend,
    backendVersion,
    platform,
    startedAt,
    endedAt,
    destroyedAt,
    outputStatus: collectorSummary.outputStatus,
    teardownStatus,
    diskDestroyed,
    tokenRevoked,
    launchPolicyDigest: plan.launchPolicyDigest,
    trustedInputDigest: effectiveTrustedInputDigest,
    kernelDigest,
    rootfsDigest,
    supervisorPid,
    workerPid,
    workerExe,
    workerExitEvidence,
    providerLifecycle,
    executionClass: 'hardware-isolated',
  });

  const finalized = writeExecutionRecordAndBoundary({
    record,
    launcherDir: realLauncher,
    artifactDir: realVault,
    verifyLivePid,
  });
  if (!finalized.ok) {
    errors.push(...finalized.errors);
  }

  let checkExitCode = null;
  let checkStdout = '';
  let checkStderr = '';
  if (runChecker && finalized.executionRecordPath) {
    const chk = spawnSync(
      process.execPath,
      [
        CHECK_SCRIPT,
        '--context',
        realContext,
        '--context-sha256',
        contextSha256,
        '--execution-record',
        finalized.executionRecordPath,
        '--execution-record-sha256',
        finalized.executionRecordSha256,
        realVault,
      ],
      { encoding: 'utf8' },
    );
    checkExitCode = chk.status;
    checkStdout = chk.stdout ?? '';
    checkStderr = chk.stderr ?? '';
    if (chk.status !== 0) {
      errors.push(`verify-pr-check-failed:exit=${chk.status}`);
    }
  }

  const ok =
    errors.length === 0 &&
    finalized.ok &&
    sourceRootfsUnchanged &&
    (!runChecker || checkExitCode === 0);

  return {
    ok,
    runId: plan.runId,
    backend: plan.backend,
    outputStatus: collectorSummary.outputStatus,
    teardownStatus,
    sourceRootfsUnchanged,
    trustedInputDigest: effectiveTrustedInputDigest,
    modelProxyStats: proxyServer ? proxyServer.getStats() : null,
    inputServerStats: inputServer ? inputServer.getStats() : null,
    executionRecordPath: finalized.executionRecordPath,
    executionRecordSha256: finalized.executionRecordSha256,
    boundaryPath: finalized.boundaryPath,
    checkExitCode,
    checkStdout,
    checkStderr,
    errors,
  };
}

async function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage:\n' +
        '  node scripts/verify-pr-vm-runner.mjs probe [--firecracker-bin <path>] [--jailer-bin <path>] [--vfkit-bin <path>] [--seatbelt-profile <path>] [--vmm-uid <n>] [--vmm-gid <n>] [--provider-configured]\n' +
        '  node scripts/verify-pr-vm-runner.mjs select --context <snapshot> [--backend <name>] [--probe | --kvm | --vfkit --seatbelt-enforcing] [--provider-configured]\n' +
        '  node scripts/verify-pr-vm-runner.mjs run --config <host-run-config.json>\n',
    );
    return 0;
  }
  const parseProbeFlags = (
    args,
    startIndex,
    { allowSelectFlags = false } = {},
  ) => {
    const parsed = {
      contextPath: null,
      preferredBackend: null,
      useProbe: false,
      kvmAvailable: false,
      vfkitAvailable: false,
      seatbeltEnforcing: false,
      providerConfigured: false,
      firecrackerBin: null,
      jailerBin: null,
      vfkitBin: null,
      seatbeltProfilePath: null,
      vmmUid: 65534,
      vmmGid: 65534,
      hasProbeOnlyFlag: false,
      error: null,
    };
    const takeValue = (flag, index) => {
      const value = args[index + 1];
      if (
        value === undefined ||
        value.trim() === '' ||
        value.startsWith('--')
      ) {
        parsed.error = `missing value for ${flag}`;
        return null;
      }
      return value;
    };
    const parsePositiveInt = (flag, raw) => {
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        parsed.error = `${flag} must be a positive integer`;
        return null;
      }
      return Number(raw);
    };
    for (let i = startIndex; i < args.length; i += 1) {
      const arg = args[i];
      if (allowSelectFlags && arg === '--context') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.contextPath = val;
        i += 1;
      } else if (allowSelectFlags && arg === '--backend') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.preferredBackend = val;
        i += 1;
      } else if (allowSelectFlags && arg === '--probe') {
        parsed.useProbe = true;
      } else if (allowSelectFlags && arg === '--kvm') {
        parsed.kvmAvailable = true;
      } else if (allowSelectFlags && arg === '--vfkit') {
        parsed.vfkitAvailable = true;
      } else if (allowSelectFlags && arg === '--seatbelt-enforcing') {
        parsed.seatbeltEnforcing = true;
      } else if (arg === '--provider-configured') {
        parsed.providerConfigured = true;
      } else if (arg === '--firecracker-bin') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.firecrackerBin = val;
        parsed.hasProbeOnlyFlag = true;
        i += 1;
      } else if (arg === '--jailer-bin') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.jailerBin = val;
        parsed.hasProbeOnlyFlag = true;
        i += 1;
      } else if (arg === '--vfkit-bin') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.vfkitBin = val;
        parsed.hasProbeOnlyFlag = true;
        i += 1;
      } else if (arg === '--seatbelt-profile') {
        const val = takeValue(arg, i);
        if (val === null) break;
        parsed.seatbeltProfilePath = val;
        parsed.hasProbeOnlyFlag = true;
        i += 1;
      } else if (arg === '--vmm-uid') {
        const val = parsePositiveInt(arg, args[(i += 1)]);
        if (val === null) break;
        parsed.vmmUid = val;
        parsed.hasProbeOnlyFlag = true;
      } else if (arg === '--vmm-gid') {
        const val = parsePositiveInt(arg, args[(i += 1)]);
        if (val === null) break;
        parsed.vmmGid = val;
        parsed.hasProbeOnlyFlag = true;
      } else {
        parsed.error = `unknown option ${arg}`;
        break;
      }
    }
    return parsed;
  };
  if (argv[0] === 'probe') {
    const opts = parseProbeFlags(argv, 1, { allowSelectFlags: false });
    if (opts.error) {
      process.stderr.write(`verify-pr vm-runner probe: ${opts.error}\n`);
      return 2;
    }
    const caps = probeHostCapabilities({
      firecrackerBin: opts.firecrackerBin,
      jailerBin: opts.jailerBin,
      vfkitBin: opts.vfkitBin,
      seatbeltProfilePath: opts.seatbeltProfilePath,
      vmmUid: opts.vmmUid,
      vmmGid: opts.vmmGid,
      providerConfigured: opts.providerConfigured,
    });
    process.stdout.write(`${JSON.stringify(caps, null, 2)}\n`);
    const anyHardware =
      caps.kvmAvailable ||
      (caps.vfkitAvailable && caps.seatbeltEnforcing) ||
      caps.providerConfigured;
    return anyHardware ? 0 : 1;
  }
  if (argv[0] === 'run') {
    let configPath = null;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--config') configPath = argv[(i += 1)] ?? null;
      else {
        process.stderr.write(
          `verify-pr vm-runner run: unknown option ${argv[i]}\n`,
        );
        return 2;
      }
    }
    if (!configPath) {
      process.stderr.write('verify-pr vm-runner run: --config is required\n');
      return 2;
    }
    const cfgRead = readSingleLinkJsonFile(configPath);
    if (cfgRead.error) {
      process.stderr.write(
        `verify-pr vm-runner run: config rejected (${cfgRead.error})\n`,
      );
      return 1;
    }
    const cfg = cfgRead.parsed;
    let plan;
    try {
      if (cfg.backend === 'firecracker') {
        plan = buildFirecrackerLaunchPlan(cfg.planOptions);
      } else if (cfg.backend === 'vfkit') {
        plan = buildVfkitLaunchPlan(cfg.planOptions);
      } else {
        process.stderr.write(
          `verify-pr vm-runner run: CLI run supports local firecracker/vfkit plans (got ${JSON.stringify(cfg.backend)})\n`,
        );
        return 2;
      }
    } catch (error) {
      process.stderr.write(`verify-pr vm-runner run: ${error.message}\n`);
      return 1;
    }
    const rawProxy =
      cfg.modelProxy &&
      typeof cfg.modelProxy === 'object' &&
      !Array.isArray(cfg.modelProxy)
        ? cfg.modelProxy
        : null;
    const resolvedModelProxy = rawProxy
      ? {
          baseUrl: rawProxy.baseUrl,
          apiKey: rawProxy.apiKey ?? process.env.REVIEW_OPENAI_API_KEY ?? '',
          listenHost: rawProxy.listenHost,
          socketPath: rawProxy.socketPath,
          idleTimeoutMs: rawProxy.idleTimeoutMs,
          maxRequests: rawProxy.maxRequests,
          vmmUid: rawProxy.vmmUid,
          vmmGid: rawProxy.vmmGid,
        }
      : null;
    const rawCollector =
      cfg.collectorOptions &&
      typeof cfg.collectorOptions === 'object' &&
      !Array.isArray(cfg.collectorOptions)
        ? cfg.collectorOptions
        : {};
    const resolvedCollectorOptions = {};
    for (const key of [
      'allowedFiles',
      'maxFiles',
      'maxFileBytes',
      'maxTotalBytes',
      'maxFrameBytes',
      'maxChunkBytes',
      'maxOversizeDrainBytes',
      'readDeadlineMs',
      'acceptDeadlineMs',
      'rejectControlChars',
    ]) {
      if (rawCollector[key] !== undefined) {
        if (
          key === 'allowedFiles' &&
          Array.isArray(rawCollector[key]) &&
          rawCollector[key].every((name) => typeof name === 'string')
        ) {
          resolvedCollectorOptions[key] = new Set(rawCollector[key]);
        } else {
          resolvedCollectorOptions[key] = rawCollector[key];
        }
      }
    }
    const rawRoundInput =
      cfg.roundInput &&
      typeof cfg.roundInput === 'object' &&
      !Array.isArray(cfg.roundInput)
        ? cfg.roundInput
        : null;
    const resolvedRoundInput = rawRoundInput
      ? {
          repoDir: rawRoundInput.repoDir,
          baseRefOid: rawRoundInput.baseRefOid,
          headRefOid: rawRoundInput.headRefOid,
          bundlePath: rawRoundInput.bundlePath,
          bundleSha256: rawRoundInput.bundleSha256,
          bundleBytes: rawRoundInput.bundleBytes,
          maxBundleBytes: rawRoundInput.maxBundleBytes,
          maxReads: rawRoundInput.maxReads,
          entropyHex: rawRoundInput.entropyHex,
        }
      : null;
    const result = await runHardwareRound({
      contextPath: cfg.contextPath,
      contextSha256: cfg.contextSha256,
      launcherDir: cfg.launcherDir,
      vaultDir: cfg.vaultDir,
      approvedRoots: Array.isArray(cfg.approvedRoots) ? cfg.approvedRoots : [],
      backendVersion: cfg.backendVersion,
      platform: cfg.platform,
      sourceKernelPath: cfg.sourceKernelPath,
      sourceRootfsPath: cfg.sourceRootfsPath,
      sourceInitramfsPath: cfg.sourceInitramfsPath ?? null,
      stageAssets: cfg.stageAssets === true,
      applyChown: cfg.applyChown ?? null,
      trustedInputDigest: cfg.trustedInputDigest ?? null,
      roundInput: resolvedRoundInput,
      collectorOptions: resolvedCollectorOptions,
      modelProxy: resolvedModelProxy,
      plan,
      runChecker: true,
      verifyLivePid: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (argv[0] !== 'select') {
    process.stderr.write(
      `verify-pr vm-runner: unknown subcommand ${argv[0]}\n`,
    );
    return 2;
  }
  const opts = parseProbeFlags(argv, 1, { allowSelectFlags: true });
  if (opts.error) {
    process.stderr.write(`verify-pr vm-runner: ${opts.error}\n`);
    return 2;
  }
  if (
    opts.useProbe &&
    (opts.kvmAvailable || opts.vfkitAvailable || opts.seatbeltEnforcing)
  ) {
    process.stderr.write(
      'verify-pr vm-runner select: --probe cannot be combined with manual --kvm/--vfkit/--seatbelt-enforcing flags\n',
    );
    return 2;
  }
  if (!opts.useProbe && opts.hasProbeOnlyFlag) {
    process.stderr.write(
      'verify-pr vm-runner select: probe-only flags (--firecracker-bin/--jailer-bin/--vfkit-bin/--seatbelt-profile/--vmm-uid/--vmm-gid) require --probe\n',
    );
    return 2;
  }
  if (!opts.contextPath) {
    process.stderr.write('verify-pr vm-runner select: --context is required\n');
    return 2;
  }
  let snap;
  try {
    snap = JSON.parse(readFileSync(opts.contextPath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `verify-pr vm-runner select: could not read valid JSON context ${opts.contextPath}: ${error.message}\n`,
    );
    return 1;
  }
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) {
    process.stderr.write(
      `verify-pr vm-runner select: context ${opts.contextPath} must be a JSON object\n`,
    );
    return 1;
  }
  const executionClass =
    snap?.trustClassification?.executionClass ?? 'hardware-isolated';
  let probe = null;
  let kvmAvailable = opts.kvmAvailable;
  let vfkitAvailable = opts.vfkitAvailable;
  let seatbeltEnforcing = opts.seatbeltEnforcing;
  let providerConfigured = opts.providerConfigured;
  if (opts.useProbe) {
    probe = probeHostCapabilities({
      firecrackerBin: opts.firecrackerBin,
      jailerBin: opts.jailerBin,
      vfkitBin: opts.vfkitBin,
      seatbeltProfilePath: opts.seatbeltProfilePath,
      vmmUid: opts.vmmUid,
      vmmGid: opts.vmmGid,
      providerConfigured: opts.providerConfigured,
    });
    kvmAvailable = probe.kvmAvailable;
    vfkitAvailable = probe.vfkitAvailable;
    seatbeltEnforcing = probe.seatbeltEnforcing;
    providerConfigured = probe.providerConfigured;
  }
  const decision = selectBackend({
    executionClass,
    preferredBackend: opts.preferredBackend,
    kvmAvailable,
    vfkitAvailable,
    seatbeltEnforcing,
    providerConfigured,
  });
  process.stdout.write(
    `${JSON.stringify({ executionClass, ...decision, ...(probe ? { probe } : {}) }, null, 2)}\n`,
  );
  return decision.backend ? 0 : 1;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
