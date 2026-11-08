/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { parseManagedMcpRecipe } from '@qwen-code/qwen-code-core/extension/managed-mcp-recipe.js';
import {
  HookEventName,
  HooksConfigSource,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedExtensionApplyCommand,
  ManagedExtensionMcpPin,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  ManagedHookRuntime,
  type ManagedHookDefinition,
  type ManagedHookManifest,
} from './managed-hook-runtime.js';
import {
  ManagedMcpRuntime,
  type ManagedMcpDefinition,
  type ManagedMcpManifest,
} from './managed-mcp-runtime.js';
import type { ManagedRuntimeExtensionPackage } from './managed-extension-runtime.js';

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid extension recipe.');
  return value as Record<string, unknown>;
}

export function stageManagedExtensionManifests(input: {
  tenantId: string;
  workspaceId: string;
  runtimeSessionId: string;
  command: ManagedExtensionApplyCommand;
  packages: readonly ManagedRuntimeExtensionPackage[];
  baseMcpServers: readonly ManagedExtensionMcpPin[];
  preparedMcpServers?: readonly ManagedExtensionMcpPin[];
  baseHookCatalog: ManagedHookCatalogPin | null;
  mcp: ManagedMcpRuntime;
  oauthAvailable?: boolean;
  hooks: ManagedHookRuntime;
  hydrated: (assetRoot: string) => {
    contributions: ManagedPackageContributions;
    environment: Readonly<Record<string, string>>;
  };
}) {
  const servers = [...input.mcp.resolvePinnedDefinitions(input.baseMcpServers)];
  const hooks = input.baseHookCatalog
    ? [...input.hooks.resolvePinnedCatalog(input.baseHookCatalog).hooks]
    : [];
  const revision = input.command.expectedRevision + 1;
  for (const pkg of input.packages) {
    const { contributions, environment } = input.hydrated(pkg.assetRoot);
    const settings = Object.fromEntries(
      pkg.contributions.settings
        .filter((setting) => Object.hasOwn(environment, setting.envVar))
        .map((setting) => [setting.envVar, environment[setting.envVar]!]),
    );
    for (const [name, raw] of Object.entries(contributions.mcpServers)) {
      const recipe = parseManagedMcpRecipe(raw) as unknown as Record<
        string,
        unknown
      >;
      const transport =
        recipe['command'] !== undefined
          ? 'stdio'
          : recipe['type'] === 'sse'
            ? 'sse'
            : 'streamable-http';
      const serverId = `${pkg.pin.extensionId}:${name}`;
      const auth = recipe['auth'] as { resourceUri: string } | undefined;
      const binding = input.command.mcpAuthBindings?.find(
        (entry) => entry.serverId === serverId,
      );
      if (auth && input.command.selectionVersion !== 2)
        throw new Error('OAuth packages require version 2 selection.');
      if (auth && !binding) continue;
      if (auth && !input.oauthAvailable)
        throw new Error('Personal MCP token delivery is unavailable.');
      if (binding && !auth)
        throw new Error('Personal MCP binding requires an OAuth server.');
      const definition: ManagedMcpDefinition = {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        serverId,
        serverRevision: revision,
        definitionDigest: digest({
          pin: pkg.pin,
          recipe: pkg.contributions.mcpServers[name],
          ...(auth
            ? {
                binding,
                executionActorKey: input.command.actorKey,
                configRevision: revision,
              }
            : {}),
        }),
        transport,
        ...(auth && binding
          ? {
              oauth: {
                resourceUri: auth.resourceUri,
                credentialId: binding.credentialId,
                credentialGeneration: binding.credentialGeneration,
                configRevision: revision,
                executionActorKey: input.command.actorKey,
              },
            }
          : {}),
        ...(transport === 'stdio'
          ? {
              command: recipe['command'] as string,
              args: recipe['args'] as string[] | undefined,
              env: {
                ...settings,
                ...(recipe['env'] === undefined
                  ? {}
                  : (object(recipe['env']) as Record<string, string>)),
              },
            }
          : {
              url: (recipe['httpUrl'] ?? recipe['url']) as string,
              headers: recipe['headers'] as Record<string, string> | undefined,
            }),
        ...(recipe['timeout'] === undefined
          ? {}
          : { timeoutMs: Number(recipe['timeout']) }),
      };
      const unchanged = input.mcp.matchingSessionDefinition(
        input.runtimeSessionId,
        definition.serverId,
        definition.definitionDigest,
      );
      const restored = input.preparedMcpServers?.find(
        (pin) =>
          pin.serverId === definition.serverId &&
          pin.definitionDigest === definition.definitionDigest,
      );
      servers.push(
        restored
          ? { ...definition, serverRevision: restored.serverRevision }
          : unchanged
            ? { ...definition, serverRevision: unchanged.serverRevision }
            : definition,
      );
    }
    for (const [event, rawGroups] of Object.entries(contributions.hooks)) {
      if (
        !Object.values(HookEventName).includes(event as HookEventName) ||
        !Array.isArray(rawGroups)
      )
        throw new Error('Unsupported extension hook event.');
      for (const [groupIndex, rawGroup] of rawGroups.entries()) {
        const group = object(rawGroup);
        if (
          Object.keys(group).some(
            (key) => !['hooks', 'matcher', 'sequential'].includes(key),
          )
        )
          throw new Error('Unsupported extension Hook group field.');
        if (!Array.isArray(group['hooks']))
          throw new Error('Invalid extension Hook group.');
        for (const [index, rawHook] of group['hooks'].entries()) {
          const config = object(rawHook);
          if (!['command', 'http', 'prompt'].includes(String(config['type'])))
            throw new Error('Unsupported extension Hook type.');
          hooks.push({
            hookId: `${pkg.pin.extensionId}:${event}:${groupIndex}:${index}`,
            eventName: event as HookEventName,
            ...(typeof group['matcher'] === 'string'
              ? { matcher: group['matcher'] }
              : {}),
            sequential: group['sequential'] === true,
            onceKey:
              config['once'] === true
                ? `${pkg.pin.extensionId}:${event}:${groupIndex}:${index}`
                : null,
            failClosed: true,
            async: config['async'] === true,
            source: HooksConfigSource.Extensions,
            sourceTrusted: true,
            enabled: true,
            config: {
              ...Object.fromEntries(
                Object.entries(config).filter(
                  ([key]) => !['once', 'async'].includes(key),
                ),
              ),
              ...(config['type'] === 'command'
                ? {
                    env: {
                      ...settings,
                      ...(config['env'] === undefined
                        ? {}
                        : object(config['env'])),
                    },
                  }
                : {}),
            } as unknown as ManagedHookDefinition['config'],
          });
        }
      }
    }
  }
  if (
    servers.length > 32 ||
    new Set(servers.map((server) => server.serverId)).size !== servers.length
  )
    throw new Error(
      'Extension MCP selection has duplicate identities or exceeds its limit.',
    );
  for (const binding of input.command.mcpAuthBindings ?? []) {
    if (
      !servers.some(
        (server) => server.serverId === binding.serverId && server.oauth,
      )
    )
      throw new Error(
        'Personal MCP binding does not match an installed OAuth server.',
      );
  }
  const mcpManifest: ManagedMcpManifest = {
    version: servers.some((server) => server.oauth) ? 2 : 1,
    servers,
  };
  const hookCatalog = hooks.length
    ? {
        catalogId: `extensions:${digest(input.runtimeSessionId).slice(0, 32)}`,
        catalogRevision: revision,
        definitionDigest: digest({
          base: input.baseHookCatalog,
          packages: input.packages
            .filter((pkg) => Object.keys(pkg.contributions.hooks).length > 0)
            .map((pkg) => ({ pin: pkg.pin, hooks: pkg.contributions.hooks })),
        }),
      }
    : null;
  const hookManifest: ManagedHookManifest = {
    version: 1,
    catalogs: hookCatalog
      ? [
          {
            ...hookCatalog,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            hooks,
          },
        ]
      : [],
  };
  // Constructors validate every recipe during staging, without opening a
  // transport or dispatching a Hook.
  const workspace = {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    workspaceGeneration: '1',
  };
  new ManagedMcpRuntime(workspace, async () => undefined, mcpManifest);
  new ManagedHookRuntime(workspace, async () => undefined, hookManifest);
  return {
    mcpManifest,
    hookManifest,
    mcpServers: servers.map(
      ({ serverId, serverRevision, definitionDigest }) => ({
        serverId,
        serverRevision,
        definitionDigest,
      }),
    ),
    hookCatalog,
  };
}
