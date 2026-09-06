/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';
import { convertOutcomeToMcpResult } from './output-adapter.js';
import { createDebugLogger } from './debug-log.js';
import type { NodeReplExecOutcome } from './kernel-manager.js';

const debugLogger = createDebugLogger('NODE_REPL');

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_YIELD_TIME_MS = 10_000;
const MAX_YIELD_TIME_MS = 60_000;
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
  'default execution limit is 10 minutes. A call yields with a cell ID when',
  'work is still running; use node_repl_wait or node_repl_cancel with that ID.',
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
  'Timeout and cancellation stop only the active cell and retain the kernel.',
  'An explicit reset or a real process crash discards bindings. For rerunnable',
  'declarations prefer assignment, var, a fresh name, or block scope.',
].join('\n');

export const NODE_REPL_INSTRUCTIONS = [
  'This server is one session-persistent JavaScript kernel. Reuse imported',
  'objects and helpers across cells. Top-level const, let, function, and class',
  'bindings persist and cannot be redeclared; update persistent state with',
  'explicit globalThis properties or assignment, and put disposable locals in',
  'an explicit block. Never use the same name for a lexical binding and a',
  'globalThis property because the lexical binding wins. Top-level var may be',
  'redeclared. Use await import() instead of static import.',
  '',
  'Return only decision-relevant output with nodeRepl.write(string) and images',
  'with nodeRepl.emitImage(...). A running cell returns an ID; use',
  'node_repl_wait to continue waiting or node_repl_cancel to abort it. Timeout',
  'and cancellation retain the kernel and existing bindings but do not commit',
  'new bindings from that cell. Pass nodeRepl.signal to cancellable async APIs',
  'so cancellation waits for their terminal result. Reset and a real process',
  'crash discard state. Runtime errors retain completed statement state;',
  'cancellation does not roll back effects already performed before it.',
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

interface ActiveCell {
  id: string;
  controller: AbortController;
  result: Promise<NodeReplExecOutcome>;
  outcome?: NodeReplExecOutcome;
  error?: Error;
}

function activeCellResult(cell: ActiveCell): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `node_repl cell ${cell.id} is still running. ` +
          'Use node_repl_wait or node_repl_cancel with this cell_id.',
      },
    ],
  };
}

function cellError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function waitForCell(
  cell: ActiveCell,
  yieldTimeMs: number,
): Promise<NodeReplExecOutcome | null> {
  if (cell.outcome) return cell.outcome;
  if (cell.error) throw cell.error;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), yieldTimeMs);
    void cell.result.then(
      (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Builds an McpServer exposing the five node_repl tools backed by a single
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
  let activeCell: ActiveCell | null = null;

  const server = new McpServer(
    {
      name: 'node-repl',
      version: resolvePackageVersion(),
    },
    { instructions: NODE_REPL_INSTRUCTIONS },
  );

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
        yield_time_ms: z
          .number()
          .int()
          .min(1)
          .max(MAX_YIELD_TIME_MS)
          .optional()
          .describe(
            `Wait before yielding a running cell ID (default ${DEFAULT_YIELD_TIME_MS}ms).`,
          ),
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .optional()
          .describe('Optional short label for this cell.'),
      },
    },
    async (
      { code, timeout_ms, yield_time_ms, title },
      extra,
    ): Promise<CallToolResult> => {
      if (title) {
        debugLogger.debug(`exec cell: ${title}`);
      }
      if (activeCell) {
        return cellError(
          `node_repl already has active cell ${activeCell.id}; wait for or cancel it before starting another cell.`,
        );
      }
      const controller = new AbortController();
      let result: Promise<NodeReplExecOutcome>;
      try {
        result = manager.exec({
          code,
          timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
          signal: controller.signal,
        });
      } catch (error) {
        return cellError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const cell: ActiveCell = { id: randomUUID(), controller, result };
      void cell.result.then(
        (outcome) => {
          cell.outcome = outcome;
        },
        (error: unknown) => {
          cell.error =
            error instanceof Error ? error : new Error(String(error));
        },
      );
      activeCell = cell;
      const onAbort = () => cell.controller.abort();
      extra?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let outcome: NodeReplExecOutcome | null;
        try {
          outcome = await waitForCell(
            cell,
            yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
          );
        } catch (error) {
          if (activeCell === cell) activeCell = null;
          return cellError(
            `node_repl cell ${cell.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!outcome) return activeCellResult(cell);
        if (activeCell === cell) activeCell = null;
        return convertOutcomeToMcpResult(outcome);
      } finally {
        extra?.signal?.removeEventListener('abort', onAbort);
      }
    },
  );

  const cellIdSchema = z
    .string()
    .uuid()
    .describe('Cell ID returned by node_repl.');

  server.registerTool(
    'node_repl_wait',
    {
      title: 'Wait for Node REPL cell',
      description:
        'Wait for the active cell without cancelling it. Returns the final ' +
        'result or the same running cell ID when the yield interval expires.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        cell_id: cellIdSchema,
        yield_time_ms: z
          .number()
          .int()
          .min(1)
          .max(MAX_YIELD_TIME_MS)
          .optional(),
      },
    },
    async ({ cell_id, yield_time_ms }): Promise<CallToolResult> => {
      const cell = activeCell;
      if (!cell || cell.id !== cell_id) {
        return cellError(`node_repl has no active cell ${cell_id}.`);
      }
      let outcome: NodeReplExecOutcome | null;
      try {
        outcome = await waitForCell(
          cell,
          yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
        );
      } catch (error) {
        if (activeCell === cell) activeCell = null;
        return cellError(
          `node_repl cell ${cell.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!outcome) return activeCellResult(cell);
      if (activeCell === cell) activeCell = null;
      return convertOutcomeToMcpResult(outcome);
    },
  );

  server.registerTool(
    'node_repl_cancel',
    {
      title: 'Cancel Node REPL cell',
      description:
        'Cancel the active cell while retaining the persistent kernel and ' +
        'bindings committed by earlier cells.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        cell_id: cellIdSchema,
        yield_time_ms: z
          .number()
          .int()
          .min(1)
          .max(MAX_YIELD_TIME_MS)
          .optional(),
      },
    },
    async ({ cell_id, yield_time_ms }): Promise<CallToolResult> => {
      const cell = activeCell;
      if (!cell || cell.id !== cell_id) {
        return cellError(`node_repl has no active cell ${cell_id}.`);
      }
      cell.controller.abort();
      let outcome: NodeReplExecOutcome | null;
      try {
        outcome = await waitForCell(
          cell,
          yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
        );
      } catch (error) {
        if (activeCell === cell) activeCell = null;
        return cellError(
          `node_repl cell ${cell.id} failed after cancellation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!outcome) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Cancellation was requested for node_repl cell ${cell.id}; ` +
                'use node_repl_wait to receive its terminal result.',
            },
          ],
        };
      }
      if (activeCell === cell) activeCell = null;
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
      if (activeCell) {
        return cellError(
          `node_repl cell ${activeCell.id} is active; cancel it before resetting the kernel.`,
        );
      }
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
      activeCell?.controller.abort();
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
