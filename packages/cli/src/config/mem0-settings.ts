/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { resolveBundleDir } from '@qwen-code/qwen-code-core/utils/bundlePaths.js';
import { findGitRoot } from '@qwen-code/qwen-code-core/utils/gitUtils.js';
import { getProjectHash } from '@qwen-code/qwen-code-core/utils/paths.js';
import { isInternalSecretEnvVar } from '@qwen-code/qwen-code-core/utils/sanitize-child-env.js';

const protocolIds = [
  'mem0-v2',
  'mem0-v3',
  'mem0-oss-2026-08',
  'aliyun-polardb-mysql-2026-08',
  'mem0-platform-v3',
  'mem0-oss-rest-2026-08',
] as const;

const scopeValue = z.string().trim().min(1).max(256);
const credentialEnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'Must be an environment variable name.');
const mem0SettingsSchema = z
  .object({
    baseUrl: z.string().url(),
    protocol: z.enum(protocolIds).default('mem0-v2'),
    envKey: credentialEnvName.optional(),
    credentialEnv: credentialEnvName.optional(),
    scope: z
      .object({
        userId: scopeValue.optional(),
        agentId: scopeValue.optional(),
        appId: scopeValue.optional(),
      })
      .strict()
      .optional(),
    allowInsecureHttp: z.boolean().default(false),
    enableWrites: z.boolean().default(false),
    timeoutMs: z.number().int().min(1).max(30_000).default(5000),
  })
  .strict();

export type Mem0Settings = z.input<typeof mem0SettingsSchema>;

export function createBundledMem0Server(
  value: unknown,
  cwd: string,
  allowWrites = true,
): MCPServerConfig {
  const parsed = mem0SettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'memory.mem0 is invalid: ' +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'mem0'}: ${issue.message}`)
          .join('; '),
    );
  }
  const settings = parsed.data;
  if (
    settings.envKey !== undefined &&
    settings.credentialEnv !== undefined &&
    settings.envKey !== settings.credentialEnv
  ) {
    throw new Error(
      'memory.mem0.envKey and credentialEnv must match when both are set.',
    );
  }
  const envKey = settings.envKey ?? settings.credentialEnv ?? 'MEM0_API_KEY';
  const enableWrites = settings.enableWrites && allowWrites;
  if (
    envKey.toUpperCase() === 'QWEN_BUNDLED_MEM0_CONFIG' ||
    isInternalSecretEnvVar(envKey)
  ) {
    throw new Error('memory.mem0.envKey must refer to a Mem0 credential.');
  }
  if (
    [...settings.baseUrl].some(
      (char) =>
        char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\',
    )
  ) {
    throw new Error('memory.mem0.baseUrl is invalid.');
  }
  const url = new URL(settings.baseUrl);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
  if (basePath.includes('%') || basePath.includes('//')) {
    throw new Error(
      'memory.mem0.baseUrl contains an unsupported proxy prefix.',
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new Error(
      'memory.mem0.baseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
    );
  }
  if (
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !settings.allowInsecureHttp
  ) {
    throw new Error(
      'memory.mem0.baseUrl requires HTTPS; set allowInsecureHttp for a trusted HTTP endpoint.',
    );
  }
  const repositoryRoot = realpathSync(findGitRoot(cwd) ?? cwd);
  const scopeId =
    'qwen-' + getProjectHash(homedir() + '\n' + repositoryRoot).slice(0, 32);
  const platformV3 = ['mem0-v3', 'mem0-platform-v3'].includes(
    settings.protocol,
  );
  const scope = {
    ...(platformV3 ? { appId: scopeId } : { userId: scopeId }),
    ...settings.scope,
  };
  if (
    (platformV3 &&
      (scope.userId !== undefined || scope.agentId !== undefined)) ||
    (!platformV3 && scope.appId !== undefined)
  ) {
    throw new Error('memory.mem0.scope does not match the selected protocol.');
  }
  const config = {
    version: 1,
    timeoutMs: settings.timeoutMs,
    provider: {
      type: 'mem0',
      preset: settings.protocol,
      endpoint: {
        origin: url.origin,
        basePath,
        allowInsecureHttp: settings.allowInsecureHttp,
      },
      credentialEnv: envKey,
      scope,
    },
    ...(enableWrites ? { write: { enabled: true } } : {}),
  };
  return {
    command: process.execPath,
    args: [mem0RuntimePath()],
    env: { QWEN_BUNDLED_MEM0_CONFIG: JSON.stringify(config) },
    includeTools: [
      'context_search',
      ...(enableWrites ? ['context_remember'] : []),
    ],
    timeout: settings.timeoutMs + 5000,
    trust: false,
  };
}

function mem0RuntimePath(): string {
  let directory = resolveBundleDir(import.meta.url);
  const bundled = join(directory, 'mem0', 'main.js');
  if (existsSync(bundled)) return bundled;
  // Source and compiled-workspace launches use the repository's bundle too.
  while (dirname(directory) !== directory) {
    if (
      existsSync(
        join(directory, 'integrations', 'external-context', 'package.json'),
      )
    ) {
      const runtime = join(directory, 'dist', 'mem0', 'main.js');
      if (existsSync(runtime)) return runtime;
      break;
    }
    directory = dirname(directory);
  }
  throw new Error(
    'Bundled Mem0 runtime is missing. Run npm run bundle for a source checkout.',
  );
}

export function bundledMem0Hooks(
  server: MCPServerConfig | undefined,
): Record<string, unknown> | undefined {
  if (
    !server ||
    // Identity, not duck-typing. `mergeMem0Hooks` files whatever this returns
    // under `systemHooks` — the one hook source folder trust does not gate — so
    // only the server `createBundledMem0Server` built for this process may
    // qualify. Every file-sourced entry in the effective MCP map carries a
    // provenance `scope` ('project' from `.mcp.json`, 'workspace'/'system' from
    // settings; see `McpServerScope`), and the bundled one rides
    // `topTierMcpServers` and never gets stamped. Without this check a
    // repository-authored `external-context` server that merely names our env
    // var is rendered as `[System]` configuration and runs a *different* script
    // (`write-confirmation.js` next to its own `args[0]`) than the one the MCP
    // approval dialog showed.
    server.scope !== undefined ||
    !server.env?.['QWEN_BUNDLED_MEM0_CONFIG'] ||
    !server.includeTools?.includes('context_remember') ||
    server.scope !== undefined ||
    server.extensionName !== undefined ||
    server.command !== process.execPath ||
    server.args?.length !== 1 ||
    server.args[0] !== mem0RuntimePath()
  )
    return undefined;
  const hookPath = join(dirname(server.args[0]), 'write-confirmation.js');
  const quote = (value: string) =>
    "'" +
    value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") +
    "'";
  return {
    PreToolUse: [
      {
        matcher: 'mcp__external-context__context_remember',
        hooks: [
          {
            type: 'command',
            command:
              (process.platform === 'win32' ? '& ' : 'exec ') +
              quote(server.command) +
              ' ' +
              quote(hookPath),
            ...(process.platform === 'win32' ? { shell: 'powershell' } : {}),
            timeout: 8,
            name: 'bundled-mem0-write-confirmation',
          },
        ],
      },
    ],
  };
}
