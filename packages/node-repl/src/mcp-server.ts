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
// Unlike PR #9499 (unbounded), cap the timeout so a hung cell cannot pin the
// kernel indefinitely. 10 minutes is generous for a REPL cell.
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
}

const NODE_REPL_DESCRIPTION = [
  'Execute JavaScript in a session-persistent Node.js REPL. Top-level bindings',
  '(const/let/var/function/class) persist across calls in the same session, so',
  'you can build up state incrementally. Top-level await is supported; the',
  'default timeout is 30s.',
  '',
  'Output: plain expression results are NOT returned — use nodeRepl.write(value)',
  'for explicit text and nodeRepl.emitImage(png|jpeg|webp) for images; console.*',
  'is also captured. nodeRepl.cwd/homeDir/tmpDir and nodeRepl.getHeapStatus() are',
  'available.',
  '',
  'Modules: top-level static import is NOT allowed — use dynamic await import().',
  'Bare packages resolve from the session cwd node_modules and any directory',
  'registered via node_repl_add_node_module_dir; package entrypoints use Node',
  'singleton caching. Local .js/.mjs reload on each execution. Node builtins are',
  'importable except process/node:process. Use',
  "(await import('node:module')).createRequire(import.meta.url) for CommonJS or",
  'native addons — note this require() is not subject to the process denial or',
  'the module-root containment that the import path enforces.',
  '',
  'Persistence caveat: timeout, cancellation, reset, or a crash replaces the',
  'kernel process and discards all bindings. For rerunnable declarations prefer',
  'var, a fresh name, block scope, or node_repl_reset. Note: re-declaring an',
  'existing top-level function or class in a later call fails — use a fresh name',
  'or node_repl_reset for those.',
].join('\n');

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

/**
 * Builds an McpServer exposing the three node_repl tools backed by a single
 * shared kernel manager. Call `dispose()` on the returned handle (or close the
 * server) to tear down the kernel.
 */
export function createNodeReplMcpServer(context: NodeReplServerContext): {
  server: McpServer;
  dispose: () => void;
} {
  const manager = new NodeReplKernelManager({
    cwd: context.cwd,
    homeDir: context.homeDir,
    tmpRootDir: context.tmpRootDir,
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: context.readableRoots,
  });

  const server = new McpServer({
    name: 'node-repl',
    version: resolvePackageVersion(),
  });

  server.registerTool(
    'node_repl',
    {
      title: 'Node REPL',
      description: NODE_REPL_DESCRIPTION,
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
          .optional()
          .describe(`Execution timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`),
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .optional()
          .describe('Optional short label for this cell.'),
      },
    },
    async ({ code, timeout_ms, title }, extra): Promise<CallToolResult> => {
      if (title) {
        debugLogger.debug(`exec cell: ${title}`);
      }
      const outcome = await manager.exec({
        code,
        timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: extra?.signal,
      });
      return convertOutcomeToMcpResult(outcome);
    },
  );

  server.registerTool(
    'node_repl_reset',
    {
      title: 'Reset Node REPL',
      description:
        'Terminate the current Node REPL kernel process and discard all ' +
        'bindings and module state. The next node_repl call lazily starts a ' +
        'fresh kernel.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const rootCount = manager.getModuleRoots().length;
      await manager.reset();
      return {
        content: [
          {
            type: 'text',
            text:
              `node_repl kernel reset (generation ${manager.getGeneration()}). ` +
              `All bindings were discarded. ${rootCount} registered module ` +
              `root(s) were retained.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'node_repl_add_node_module_dir',
    {
      title: 'Add Node REPL module directory',
      description:
        'Register an additional node_modules directory (absolute path, final ' +
        'segment must be node_modules) for bare-package resolution in the Node ' +
        'REPL. The directory need not exist yet. This only widens the ' +
        'bare-package resolution search path; it grants no additional authority.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Absolute path to a node_modules directory.'),
      },
    },
    async ({ path: modulePath }): Promise<CallToolResult> => {
      try {
        const registration = await manager.addModuleRoot(modulePath);
        return {
          content: [
            {
              type: 'text',
              text: registration.added
                ? `Registered module root: ${registration.path}`
                : `Module root already registered: ${registration.path}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to register module root: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  const dispose = () => {
    try {
      manager.dispose();
    } catch (error) {
      debugLogger.warn(
        `[node-repl] manager dispose failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  return { server, dispose };
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
  };
}
