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
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
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
  startCollectorServer,
  validateSocketPathLength,
} from './verify-pr-vm-collector.mjs';
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
  const execName = basename(firecrackerBin);
  const jailRoot = join(jailBaseDir, execName, runId, 'root');
  const hostVsockPath = join(jailRoot, `v.sock_${vsockPort}`);
  const len = validateSocketPathLength(hostVsockPath, 'linux');
  if (!len.ok) {
    throw new Error(
      `firecracker UDS path exceeds Linux sun_path limit (${len.reason}): use a shorter jailBaseDir or runId`,
    );
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
    vmConfig,
  };

  return {
    backend: 'firecracker',
    runId,
    jailRoot,
    hostVsockPath,
    workerPidFile: join(jailRoot, `${execName}.pid`),
    vmConfig,
    argv,
    vmmUid,
    vmmGid,
    ownershipTemplate: {
      runId,
      backend: 'firecracker',
      expectedExeTokens: [execName],
      workDiskPath: join(jailRoot, 'rootfs.ext4'),
      socketPaths: [hostVsockPath, join(jailRoot, 'v.sock')],
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
  cmdline = 'console=hvc0 root=/dev/vda rw init=/opt/poc/init reboot=k panic=1',
}) {
  assertRunId(runId);
  if (typeof seatbeltProfile !== 'string' || seatbeltProfile.trim() === '') {
    throw new Error('vfkit requires an explicit enforcing Seatbelt profile');
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
  const len = validateSocketPathLength(hostVsockPath, 'darwin');
  if (!len.ok) {
    throw new Error(
      `vfkit UDS path exceeds macOS sun_path limit (${len.reason}): use a shorter socketDir`,
    );
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
    restfulUri: 'none://',
    hasNic: false,
    hasDirectoryShare: false,
    sandboxed: true,
    cmdline,
  };

  return {
    backend: 'vfkit',
    runId,
    hostVsockPath,
    socketDir,
    pidFile,
    argv,
    ownershipTemplate: {
      runId,
      backend: 'vfkit',
      expectedExeTokens: [basename(vfkitBin)],
      workDiskPath: rootfsPath,
      socketPaths: [hostVsockPath],
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

function sha256RegularFile(filePath) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    return { error: `unreadable:${error.code ?? 'ENOENT'}`, digest: null };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { error: 'non-regular-or-symlink', digest: null };
  }
  return {
    error: null,
    digest: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  };
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
  trustedInputDigest,
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
  if (!SHA256_RE.test(trustedInputDigest ?? '')) {
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

  const isLocalVmm = plan.backend === 'firecracker' || plan.backend === 'vfkit';
  let kernelDigest = null;
  let rootfsDigest = null;
  if (isLocalVmm) {
    if (!plan.hostVsockPath) {
      return {
        ok: false,
        errors: ['local VMM plan requires hostVsockPath'],
      };
    }
    if (
      typeof launchBackend !== 'function' &&
      (!Array.isArray(plan.argv) || plan.argv.length === 0)
    ) {
      return {
        ok: false,
        errors: ['local VMM plan requires non-empty argv'],
      };
    }
    if (!sourceKernelPath || !sourceRootfsPath) {
      return {
        ok: false,
        errors: [
          'local VMM backends require sourceKernelPath and sourceRootfsPath for digest verification',
        ],
      };
    }
    const kHash = sha256RegularFile(sourceKernelPath);
    if (kHash.error) {
      return {
        ok: false,
        errors: [`sourceKernelPath rejected (${kHash.error})`],
      };
    }
    const rHash = sha256RegularFile(sourceRootfsPath);
    if (rHash.error) {
      return {
        ok: false,
        errors: [`sourceRootfsPath rejected (${rHash.error})`],
      };
    }
    const workDisk = plan.ownershipTemplate?.workDiskPath;
    if (workDisk) {
      const realSrcRootfs = realpathSync(resolve(sourceRootfsPath));
      let realWorkDisk = resolve(workDisk);
      try {
        realWorkDisk = realpathSync(realWorkDisk);
      } catch {
        // Keep lexical resolved path if working disk does not exist yet.
      }
      if (realWorkDisk === realSrcRootfs) {
        return {
          ok: false,
          errors: [
            'working disk path must be a per-round copy distinct from sourceRootfsPath',
          ],
        };
      }
    }
    kernelDigest = kHash.digest;
    rootfsDigest = rHash.digest;
  }

  const tokenFile = join(realLauncher, 'token.json');
  const proxyToken = randomBytes(24).toString('hex');
  const proxyNonce = randomBytes(24).toString('hex');
  try {
    writePrivateSafeFile(
      tokenFile,
      `${JSON.stringify({ runId: plan.runId, revoked: false }, null, 2)}\n`,
    );
  } catch (error) {
    return { ok: false, errors: [`token-file-rejected:${error.message}`] };
  }

  let proxyServer = null;
  let proxyInfo = null;
  let proxySocketOwned = false;
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
  let providerLifecycle = null;

  const startedAt = new Date().toISOString();
  let endedAt = startedAt;
  let destroyedAt = null;

  try {
    // 1. Optional host-side model proxy bound to this round's token.json
    if (modelProxy) {
      proxyServer = createModelProxy({
        baseUrl: modelProxy.baseUrl,
        apiKey: modelProxy.apiKey,
        token: proxyToken,
        nonce: proxyNonce,
        idleTimeoutMs: modelProxy.idleTimeoutMs,
        tokenFile,
        maxRequests: modelProxy.maxRequests ?? null,
      });
      if (modelProxy.socketPath) {
        const sockLen = validateSocketPathLength(modelProxy.socketPath);
        if (!sockLen.ok) throw new Error(`model proxy: ${sockLen.reason}`);
        try {
          lstatSync(modelProxy.socketPath);
          throw new Error(
            `model proxy: refusing existing socket path ${modelProxy.socketPath}`,
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise((res, rej) => {
          proxyServer.once('error', rej);
          proxyServer.listen(modelProxy.socketPath, res);
        });
        proxySocketOwned = true;
        chmodSync(modelProxy.socketPath, 0o600);
        const proxyUid = modelProxy.vmmUid ?? plan.vmmUid ?? null;
        const proxyGid = modelProxy.vmmGid ?? plan.vmmGid ?? null;
        if (Number.isInteger(proxyUid) && Number.isInteger(proxyGid)) {
          chownSync(modelProxy.socketPath, proxyUid, proxyGid);
        }
        proxyInfo = {
          socketPath: modelProxy.socketPath,
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
        });
      } else {
        const child = spawn(plan.argv[0], plan.argv.slice(1), {
          stdio: 'ignore',
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
        let pid = child.pid;
        let supPid = child.pid;
        if (plan.backend === 'firecracker' && plan.workerPidFile) {
          const fcPid = await waitForPidFile(
            plan.workerPidFile,
            10_000,
            () => childExited,
          );
          if (!fcPid) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore kill error.
            }
            throw new Error(
              `timed out waiting for firecracker worker pid file ${plan.workerPidFile}`,
            );
          }
          pid = fcPid;
        }
        launched = {
          workerPid: pid,
          supervisorPid: supPid,
          workerExe: plan.ownershipTemplate.expectedExeTokens[0],
          child,
          childExited: () => childExited,
        };
      }

      workerPid = launched?.workerPid ?? null;
      supervisorPid = launched?.supervisorPid ?? workerPid;
      workerExe =
        launched?.workerExe ??
        plan.ownershipTemplate?.expectedExeTokens?.[0] ??
        null;

      ownershipPath = join(realLauncher, 'ownership.json');
      writeOwnershipRecord(ownershipPath, {
        ...plan.ownershipTemplate,
        worker: {
          pid: workerPid,
          expectedExeTokens:
            launched?.expectedExeTokens ??
            plan.ownershipTemplate?.expectedExeTokens ??
            [],
        },
        tokenFile,
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
    // 4. Unconditional teardown: close model proxy & its owned UDS first (so
    //    no further upstream calls can fly and per-round socketDir is empty
    //    before reapOwnership rmdirs it), then reap local VMM or destroy
    //    provider VM, revoke token.json, and verify source golden immutability.
    if (proxyServer) {
      if (proxyServer.listening) {
        await new Promise((done) => {
          if (typeof proxyServer.closeAllConnections === 'function') {
            proxyServer.closeAllConnections();
          }
          proxyServer.close(() => done());
        });
      }
      if (proxySocketOwned && modelProxy?.socketPath) {
        try {
          unlinkSync(modelProxy.socketPath);
        } catch {
          // Already removed.
        }
      }
    }

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
        if (reapRes.status !== 'reaped') {
          reapClean = false;
          errors.push(...reapRes.errors.map((e) => `reap:${e}`));
        }
      } else {
        // Launch failed before ownership.json existed: still revoke token.json.
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
      workerExitEvidence = aliveAfterReap ? 'alive' : 'absent';
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
        !aliveAfterReap &&
        diskDestroyed &&
        tokenRevoked &&
        sourceRootfsUnchanged
          ? 'destroyed'
          : 'failed';
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
        destroyClean && terminated && diskDestroyed && tokenRevoked
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
    trustedInputDigest,
    kernelDigest,
    rootfsDigest,
    supervisorPid,
    workerPid,
    workerExe,
    workerExitEvidence,
    providerLifecycle,
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
    modelProxyStats: proxyServer ? proxyServer.getStats() : null,
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
        '  node scripts/verify-pr-vm-runner.mjs select --context <snapshot> [--backend <name>] [--kvm] [--vfkit --seatbelt-enforcing] [--provider-configured]\n' +
        '  node scripts/verify-pr-vm-runner.mjs run --config <host-run-config.json>\n',
    );
    return 0;
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
        resolvedCollectorOptions[key] = rawCollector[key];
      }
    }
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
      trustedInputDigest: cfg.trustedInputDigest,
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
  let contextPath = null;
  let preferredBackend = null;
  let kvmAvailable = false;
  let vfkitAvailable = false;
  let seatbeltEnforcing = false;
  let providerConfigured = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--context') contextPath = argv[(i += 1)] ?? null;
    else if (arg === '--backend') preferredBackend = argv[(i += 1)] ?? null;
    else if (arg === '--kvm') kvmAvailable = true;
    else if (arg === '--vfkit') vfkitAvailable = true;
    else if (arg === '--seatbelt-enforcing') seatbeltEnforcing = true;
    else if (arg === '--provider-configured') providerConfigured = true;
    else {
      process.stderr.write(`verify-pr vm-runner: unknown option ${arg}\n`);
      return 2;
    }
  }
  if (!contextPath) {
    process.stderr.write('verify-pr vm-runner select: --context is required\n');
    return 2;
  }
  let snap;
  try {
    snap = JSON.parse(readFileSync(contextPath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `verify-pr vm-runner select: could not read valid JSON context ${contextPath}: ${error.message}\n`,
    );
    return 1;
  }
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) {
    process.stderr.write(
      `verify-pr vm-runner select: context ${contextPath} must be a JSON object\n`,
    );
    return 1;
  }
  const executionClass =
    snap?.trustClassification?.executionClass ?? 'hardware-isolated';
  const decision = selectBackend({
    executionClass,
    preferredBackend,
    kvmAvailable,
    vfkitAvailable,
    seatbeltEnforcing,
    providerConfigured,
  });
  process.stdout.write(
    `${JSON.stringify({ executionClass, ...decision }, null, 2)}\n`,
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
