/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';
import { convertOutcomeToMcpResult } from './output-adapter.js';
import { createDebugLogger } from './debug-log.js';

const debugLogger = createDebugLogger('NODE_REPL');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_TITLE_LENGTH = 80;

export interface NodeReplServerContext {
  /** Working directory for the kernel child (module resolution base). */
  cwd: string;
  /** Home directory exposed to the cell as nodeRepl.homeDir. */
  homeDir: string;
  /** Root dir under which per-session temp dirs are created. */
  tmpRootDir: string;
  /** Directories the cell may read via file: URLs / emitImage. */
  readableRoots: string[];
  moduleRoots?: string[];
}

const JS_DESCRIPTION =
  'Execute JavaScript in a persistent Node.js session with top-level await. ' +
  'The first call preloads global cua and displays runtime documentation. ' +
  'Use cua.getApp(name) to start Computer Use, or cua.rewriteDocumentation() ' +
  'after context compaction. Use nodeRepl.write(value) for explicit output.';

export const NODE_REPL_INSTRUCTIONS =
  'Use js for persistent JavaScript and follow the runtime documentation returned on the first call.';

/**
 * Read the package version at runtime so it cannot drift from package.json.
 * `../package.json` resolves correctly from both the built (dist/) and source
 * (src/) layouts, since both are one level below the package root.
 */
function resolvePackageVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === 'string') return version;
  } catch {
    // Fall through to the sentinel below.
  }
  return '0.0.0';
}

function cellError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createNodeReplMcpServer(context: NodeReplServerContext): {
  server: McpServer;
  dispose: () => Promise<void>;
} {
  const manager = new NodeReplKernelManager({
    cwd: context.cwd,
    homeDir: context.homeDir,
    tmpRootDir: context.tmpRootDir,
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: context.readableRoots,
    preloadCua: true,
  });
  const initialized = (async () => {
    for (const root of context.moduleRoots ?? [])
      await manager.addModuleRoot(root);
  })();
  void initialized.catch(() => undefined);
  let active: AbortController | undefined;

  const server = new McpServer(
    { name: 'node-repl', version: resolvePackageVersion() },
    { instructions: NODE_REPL_INSTRUCTIONS },
  );

  server.registerTool(
    'js',
    {
      title: 'JavaScript',
      description: JS_DESCRIPTION,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        code: z.string().min(1).describe('JavaScript source to execute.'),
        timeout_ms: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_MS)
          .default(DEFAULT_TIMEOUT_MS)
          .describe(`Execution timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`),
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .optional()
          .describe('Short user-facing description of this call.'),
      },
    },
    async ({ code, timeout_ms, title }, extra): Promise<CallToolResult> => {
      if (active)
        return cellError(
          'A js call is already running. Wait for its terminal result.',
        );
      if (title) debugLogger.debug(`exec cell: ${title}`);
      const controller = new AbortController();
      active = controller;
      const onAbort = () => controller.abort();
      extra.signal.addEventListener('abort', onAbort, { once: true });
      if (extra.signal.aborted) controller.abort();
      try {
        await initialized;
        const outcome = await manager.exec({
          code,
          timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
          signal: controller.signal,
        });
        return convertOutcomeToMcpResult(outcome);
      } catch (error) {
        return cellError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        extra.signal.removeEventListener('abort', onAbort);
        if (active === controller) active = undefined;
      }
    },
  );

  server.registerTool(
    'js_reset',
    {
      title: 'Reset JavaScript session',
      description:
        'Discard all bindings and module state. The next js call starts a fresh session and displays documentation again.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      active?.abort();
      try {
        await initialized;
        await manager.reset();
        return {
          content: [
            {
              type: 'text',
              text: 'JavaScript session reset. All bindings were discarded; host module roots were retained.',
            },
          ],
        };
      } catch (error) {
        return cellError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  return {
    server,
    async dispose() {
      active?.abort();
      await manager.dispose();
    },
  };
}

/**
 * Resolves the kernel host context from the process environment, so the server
 * needs no qwen-code Config. `cwd` is the process cwd (set by the MCP host via
 * mcpServers.<name>.cwd); extra readable roots come from QWEN_NODE_REPL_ROOTS
 * (path-list, os-specific delimiter).
 */
export function resolveContextFromEnv(): NodeReplServerContext {
  const cwd = process.cwd();
  const extraRoots = (process.env['QWEN_NODE_REPL_ROOTS'] ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    cwd,
    homeDir: os.homedir(),
    tmpRootDir: path.join(os.tmpdir(), 'qwen-node-repl'),
    readableRoots: [cwd, ...extraRoots],
    moduleRoots: (process.env['QWEN_NODE_REPL_MODULE_DIRS'] ?? '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}
