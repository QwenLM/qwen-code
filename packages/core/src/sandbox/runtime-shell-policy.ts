/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfigParameters,
  ShellExecutionSandboxPolicy,
} from '../config/config.js';
import { isSubpath, realpathNearestExisting } from '../utils/paths.js';

export function assertShellSandboxCwd(
  policy: Readonly<ShellExecutionSandboxPolicy>,
  cwd: string,
): void {
  if (
    !path.isAbsolute(cwd) ||
    statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true ||
    !isSubpath(policy.workspace, realpathSync(cwd))
  ) {
    throw new Error(
      'Shell sandbox cwd must remain inside the admitted workspace.',
    );
  }
}

export function admitShellSandbox(
  params: ConfigParameters,
  runtimeRoot: string,
  globalConfigRoot: string,
): Readonly<ShellExecutionSandboxPolicy> | undefined {
  if (params.sandbox?.command === 'bwrap') {
    throw new Error(
      'Whole-CLI bwrap is no longer supported. Use tools.executionSandbox instead.',
    );
  }
  const policy = params.shellExecutionSandbox;
  if (!policy) return undefined;
  const legacySelection = process.env['QWEN_SANDBOX']?.trim().toLowerCase();
  if (
    process.env['SANDBOX']?.trim() ||
    (legacySelection && !['false', '0'].includes(legacySelection)) ||
    process.env['QWEN_SANDBOX_NET']?.trim() ||
    process.env['QWEN_SANDBOX_PROXY_COMMAND']?.trim()
  ) {
    throw new Error(
      'Tool execution sandbox cannot be combined with legacy sandbox environment settings. Remove SANDBOX, QWEN_SANDBOX, QWEN_SANDBOX_NET and QWEN_SANDBOX_PROXY_COMMAND and restart.',
    );
  }
  if (
    params.provisionalWorkspace ||
    params.sdkMode ||
    params.experimentalZedIntegration ||
    params.sandbox ||
    params.overrideExtensions?.some(
      (name) => name.trim() !== '' && name.trim().toLowerCase() !== 'none',
    ) ||
    Object.keys(params.mcpServers ?? {}).length ||
    Object.keys(params.topTierMcpServers ?? {}).length ||
    params.mcpServerCommand ||
    params.toolDiscoveryCommand ||
    params.toolCallCommand ||
    params.lsp?.enabled ||
    params.lspClient ||
    params.agentExecutionBackend !== undefined ||
    params.executionEnvironment !== undefined ||
    params.executionEnvironmentFactory !== undefined
  ) {
    throw new Error(
      'Tool execution sandbox does not support SDK/ACP sessions, provisional workspaces, extensions, MCP, discovery, LSP, agent execution environments, or a whole-CLI sandbox.',
    );
  }
  if (
    !['read-only', 'workspace-write'].includes(policy.filesystem) ||
    !['open', 'closed'].includes(policy.network) ||
    (policy.requestedBackend !== undefined &&
      !['auto', 'bwrap'].includes(policy.requestedBackend))
  ) {
    throw new Error('Unsupported shell sandbox policy.');
  }
  if (
    policy.bwrapPath !== undefined &&
    (typeof policy.bwrapPath !== 'string' || !path.isAbsolute(policy.bwrapPath))
  ) {
    throw new Error('Invalid tool execution sandbox paths.');
  }
  const canonical = (value: string) => {
    if (typeof value !== 'string' || !path.isAbsolute(value))
      throw new Error('Shell sandbox paths must be absolute.');
    return realpathNearestExisting(value);
  };
  const workspace = canonical(policy.workspace);
  const installation = canonical(policy.installation);
  const state = canonical(policy.state);
  const maskedPaths = Object.freeze((policy.maskedPaths ?? []).map(canonical));
  const protectedRoots = Object.freeze(
    [installation, state, runtimeRoot, globalConfigRoot].map(canonical),
  );
  if (
    protectedRoots.some(
      (root) => isSubpath(root, workspace) || isSubpath(workspace, root),
    )
  ) {
    throw new Error(
      'Shell sandbox workspace overlaps protected state or installation.',
    );
  }
  if (
    maskedPaths.some(
      (maskedPath) =>
        maskedPath === workspace || !isSubpath(workspace, maskedPath),
    )
  ) {
    throw new Error('Shell sandbox masks must remain inside the workspace.');
  }
  const admitted: Readonly<ShellExecutionSandboxPolicy> = Object.freeze({
    workspace,
    installation,
    state,
    ...(maskedPaths.length > 0 ? { maskedPaths } : {}),
    filesystem: policy.filesystem,
    network: policy.network,
    ...(policy.requestedBackend
      ? { requestedBackend: policy.requestedBackend }
      : {}),
    ...(policy.bwrapPath ? { bwrapPath: policy.bwrapPath } : {}),
  });
  assertShellSandboxCwd(admitted, params.targetDir);
  assertShellSandboxCwd(admitted, params.cwd ?? process.cwd());
  return admitted;
}

export async function probeShellSandbox(
  policy: Readonly<ShellExecutionSandboxPolicy>,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  signal.throwIfAborted();
  if (process.platform !== 'linux')
    throw new Error('bwrap execution requires Linux.');
  if (realpathNearestExisting(policy.state) !== policy.state)
    throw new Error('Sandbox state directory changed after admission.');
  await mkdir(policy.state, { recursive: true, mode: 0o700 });
  if (realpathSync(policy.state) !== policy.state)
    throw new Error('Sandbox state directory changed after admission.');
  const { executeBwrap } = await import('./bwrap-execution.js');
  const handle = await executeBwrap(
    policy,
    {
      executable: '/bin/bash',
      args: ['-c', 'true'],
      cwd: policy.workspace,
      env: { PATH: '/usr/bin:/bin' },
    },
    () => {},
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
  const result = await handle.result;
  if (
    result.sandboxStatus.state !== 'confirmed' ||
    result.sandboxStatus.exitCode !== 0 ||
    result.error ||
    result.aborted
  ) {
    throw new Error(
      `Sandbox capability probe failed: ${result.error?.message ?? (result.output || result.sandboxStatus.state)}`,
    );
  }
}
