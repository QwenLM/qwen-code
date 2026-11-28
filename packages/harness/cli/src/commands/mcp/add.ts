/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp add' command
import type { McpCommandOptions } from './options.js';
import { Command, Option } from '@commander-js/extra-typings';
import type { MCPServerConfig } from '@qwen-code/core';
import { saveNewMcpServer } from './save.js';

/**
 * Flatten each `--flag a,b` occurrence into a string array, preserving the
 * repeat-flag form (`--flag a --flag b`). Trims whitespace and drops empties.
 */
function splitCommaList(values: string[]): string[] {
  return values.flatMap((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface AddServerOptions {
  scope: string;
  transport: string | undefined;
  transportExplicit: boolean;
  env: string[] | undefined;
  header: string[] | undefined;
  headersHelper: string | undefined;
  clientId: string | undefined;
  clientSecret: boolean | undefined;
  callbackPort: number | undefined;
  timeout?: number;
  trust?: boolean;
  alwaysAllow?: string[];
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface AddCommandParsedOptions {
  scope: string;
  transport?: string;
  type?: string;
  env?: string[];
  header?: string[];
  headersHelper?: string;
  clientId?: string;
  clientSecret?: boolean;
  callbackPort?: string;
  timeout?: string;
  trust?: boolean;
  alwaysAllow?: string;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export function readAddCommandOptions(
  options: AddCommandParsedOptions,
): AddServerOptions {
  const transport = options.transport ?? options.type;
  return {
    scope: options.scope,
    transport,
    transportExplicit: transport !== undefined,
    env: options.env,
    header: options.header,
    headersHelper: options.headersHelper,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    callbackPort: options.callbackPort
      ? Number(options.callbackPort)
      : undefined,
    timeout: options.timeout ? Number(options.timeout) : undefined,
    trust: options.trust,
    alwaysAllow: options.alwaysAllow
      ? splitCommaList([options.alwaysAllow])
      : undefined,
    description: options.description,
    includeTools: options.includeTools
      ? splitCommaList(options.includeTools)
      : undefined,
    excludeTools: options.excludeTools
      ? splitCommaList(options.excludeTools)
      : undefined,
  };
}

export interface AddServerConfig {
  readonly config: MCPServerConfig;
  readonly transport: string;
}

export async function buildMcpServerConfig(
  commandOrUrl: string,
  args: Array<string | number> | undefined,
  options: AddServerOptions,
): Promise<AddServerConfig> {
  const { readClientSecret } = await import('../../utils/clientSecret.js');
  const {
    transport: explicitTransport,
    env,
    header,
    headersHelper,
    clientId,
    clientSecret: clientSecretFlag,
    callbackPort,
    timeout,
    trust,
    alwaysAllow,
    description,
    includeTools,
    excludeTools,
  } = options;

  // URL-ish heuristic for auto-detecting HTTP transport.
  const looksLikeUrl =
    commandOrUrl.startsWith('http://') ||
    commandOrUrl.startsWith('https://') ||
    commandOrUrl.startsWith('localhost') ||
    commandOrUrl.endsWith('/sse') ||
    commandOrUrl.endsWith('/mcp');

  // Auto-detect transport from URL when not explicitly specified.
  const transport = explicitTransport ?? (looksLikeUrl ? 'http' : 'stdio');

  const headers = header?.reduce(
    (acc, curr) => {
      const [key, ...valueParts] = curr.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim() && value) {
        acc[key.trim()] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  // Build the oauth sub-object only when at least one OAuth field is set.
  const buildOauthConfig = (
    secretValue: string | undefined,
  ): MCPServerConfig['oauth'] | undefined => {
    if (!clientId && callbackPort === undefined && secretValue === undefined) {
      return undefined;
    }
    const oauth: NonNullable<MCPServerConfig['oauth']> = {};
    if (clientId !== undefined) oauth.clientId = clientId;
    if (callbackPort !== undefined) oauth.callbackPort = callbackPort;
    if (secretValue !== undefined) oauth.clientSecret = secretValue;
    return oauth;
  };

  let newServer: Partial<MCPServerConfig> = {};

  switch (transport) {
    case 'sse':
    case 'http':
    case 'ws': {
      // Read secret BEFORE writing config so cancellation doesn't leave partial state.
      const secretValue =
        clientSecretFlag && clientId ? await readClientSecret() : undefined;

      newServer = {
        url: commandOrUrl,
        type: transport,
        headers,
        headersHelper,
        oauth: buildOauthConfig(secretValue),
        timeout,
        trust,
        alwaysAllow,
        description,
        includeTools,
        excludeTools,
      };
      break;
    }
    case 'stdio':
    default: {
      // Warn if args look like an OAuth-only setup but transport is stdio.
      if (clientId || clientSecretFlag || callbackPort !== undefined) {
        process.stderr.write(
          'Warning: --client-id, --client-secret, and --callback-port are only supported for HTTP/SSE transports and will be ignored for stdio.\n',
        );
      }

      newServer = {
        command: commandOrUrl,
        args: args?.map(String),
        env: env?.reduce(
          (acc, curr) => {
            const [key, value] = curr.split('=');
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, string>,
        ),
        timeout,
        trust,
        alwaysAllow,
        description,
        includeTools,
        excludeTools,
      };
      break;
    }
  }

  // Remove undefined fields
  const config = Object.fromEntries(
    Object.entries(newServer).filter(([, value]) => value !== undefined),
  ) as MCPServerConfig;

  return { config, transport };
}

export function createMcpAddCommandBase() {
  return new Command('add')
    .description('Add a server')
    .allowUnknownOption()
    .argument('<name>', 'Name of the server')
    .argument('[commandOrUrl]', 'Command (stdio) or URL (sse, http)')
    .argument('[args...]', 'Additional arguments for the server command')
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'Configuration scope (user, local, or project)',
      )
        .choices(['user', 'local', 'project'] as const)
        .default('local'),
    )
    .addOption(
      new Option(
        '-t, --transport <transport>',
        'Transport type (stdio, sse, http, ws). Defaults to stdio if not specified.',
      ).choices(['stdio', 'sse', 'http', 'ws'] as const),
    )
    .addOption(new Option('--type <transport>').hideHelp())
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .option(
      '-H, --header <header...>',
      'Set HTTP headers for SSE and HTTP transports (e.g. -H "X-Api-Key: abc123")',
    )
    .option(
      '--headers-helper <headersHelper>',
      'External script to generate dynamic HTTP headers.',
    )
    .option('--client-id <clientId>', 'OAuth client ID for HTTP/SSE servers')
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    )
    .option('--callback-port <callbackPort>', 'Fixed port for OAuth callback')
    .addOption(
      new Option(
        '--timeout <timeout>',
        'Set connection timeout in milliseconds',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--trust',
        'Trust the server (bypass all tool call confirmation prompts)',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--always-allow <alwaysAllow>',
        'Comma-separated list of tool names to auto-approve',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--description <description>',
        'Set the description for the server',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--include-tools <includeTools...>',
        'Comma-separated list of tool names to include',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--exclude-tools <excludeTools...>',
        'Comma-separated list of tool names to exclude',
      ).hideHelp(),
    );
}

export function createAddCommand(commandOptions: McpCommandOptions = {}) {
  return createMcpAddCommandBase().action(
    async (name, commandOrUrl, args, options) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      if (!commandOrUrl) {
        throw new Error(
          'Missing required argument: commandOrUrl. Provide the command (stdio) or URL (sse, http), optionally using `--` to separate command args.',
        );
      }

      const parsed = readAddCommandOptions(options as AddCommandParsedOptions);
      const { config, transport } = await buildMcpServerConfig(
        commandOrUrl,
        args as Array<string | number>,
        parsed,
      );
      await saveNewMcpServer(name, config, parsed.scope, {
        source: 'mcp.add',
        projectConfigValidator: commandOptions.projectConfigValidator,
        transport,
      });
      await exitCli();
    },
  );
}
