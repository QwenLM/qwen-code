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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { validateSocketPathLength } from './verify-pr-vm-collector.mjs';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const FULL_OID_RE = /^[0-9a-f]{40}$/;

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

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/verify-pr-vm-runner.mjs select --context <snapshot> [--backend <name>] [--kvm] [--vfkit --seatbelt-enforcing] [--provider-configured]\n',
    );
    return 0;
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
  process.exitCode = main(process.argv.slice(2));
}
