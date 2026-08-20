/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { ToolErrorType } from '../tool-error.js';
import { ToolDisplayNames, ToolNames } from '../tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '../tools.js';
import type { PermissionDecision } from '../../permissions/types.js';
import {
  NodeReplKernelManager,
  type NodeReplExecOutcome,
} from './kernel-manager.js';
import { convertOutcomeToToolResult } from './result-converter.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 80;

function errorResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: `Error: ${message}`,
    error: { message, type },
  };
}

/**
 * Per-session REPL state shared by the three node_repl tools. One instance
 * per ToolRegistry (i.e. per Config / session); the kernel process itself is
 * spawned lazily on the first execution.
 */
export class NodeReplSession {
  private manager: NodeReplKernelManager | null = null;
  private readonly policy = NodeReplSecurityPolicy.default();
  private disposed = false;

  constructor(private readonly config: Config) {}

  getManager(): NodeReplKernelManager {
    if (this.disposed) {
      throw new Error('node_repl session has been disposed');
    }
    if (!this.manager) {
      this.manager = new NodeReplKernelManager({
        cwd: this.config.getTargetDir(),
        homeDir: os.homedir(),
        tmpRootDir: path.join(
          this.config.storage.getProjectTempDir(),
          'node-repl',
        ),
        policy: this.policy,
        readableRoots: [...this.config.getWorkspaceContext().getDirectories()],
      });
    }
    return this.manager;
  }

  hasManager(): boolean {
    return this.manager !== null;
  }

  isWorkspaceTrusted(): boolean {
    return this.config.isTrustedFolder();
  }

  validateModuleRoot(rawPath: string): string {
    return this.policy.validateModuleRoot(rawPath);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.manager) {
      this.manager.dispose();
      this.manager = null;
    }
  }
}

// ---------------------------------------------------------------------------
// node_repl
// ---------------------------------------------------------------------------

export interface NodeReplToolParams {
  code: string;
  timeout_ms?: number;
  title?: string;
}

class NodeReplInvocation extends BaseToolInvocation<
  NodeReplToolParams,
  ToolResult
> {
  constructor(
    private readonly session: NodeReplSession,
    params: NodeReplToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    if (this.params.title) return this.params.title;
    const firstLine = this.params.code.split('\n', 1)[0] ?? '';
    return firstLine.length > 64 ? `${firstLine.slice(0, 64)}…` : firstLine;
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve(this.session.isWorkspaceTrusted() ? 'ask' : 'deny');
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (!this.session.isWorkspaceTrusted()) {
      return errorResult(
        'node_repl is unavailable until the workspace is trusted.',
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    let outcome: NodeReplExecOutcome;
    try {
      outcome = await this.session.getManager().exec({
        code: this.params.code,
        timeoutMs: this.params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal,
      });
    } catch (e) {
      return errorResult(
        `node_repl failed: ${e instanceof Error ? e.message : String(e)}`,
        ToolErrorType.EXECUTION_FAILED,
      );
    }
    return convertOutcomeToToolResult(outcome);
  }
}

export class NodeReplTool extends BaseDeclarativeTool<
  NodeReplToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.NODE_REPL;

  constructor(private readonly session: NodeReplSession) {
    super(
      NodeReplTool.Name,
      ToolDisplayNames.NODE_REPL,
      'Execute JavaScript in a task-persistent Node.js REPL (30 second ' +
        'default timeout) with top-level await. Use nodeRepl.cwd, ' +
        'nodeRepl.homeDir, and nodeRepl.tmpDir to inspect the task paths. ' +
        'Use nodeRepl.write(value) for final text without an added newline: ' +
        'strings are unchanged and other values use safe console-style ' +
        'formatting. console.log() remains useful for debugging or multiple ' +
        'values. Use await nodeRepl.emitImage(image) for PNG/JPEG/WebP bytes ' +
        'or an approved data:/file: URL, and nodeRepl.getHeapStatus() for a ' +
        'read-only memory snapshot. Ordinary expression values are silent. ' +
        'Top-level bindings persist across calls as real references; a failed ' +
        'cell keeps bindings committed before the failure. Reuse existing ' +
        'bindings when possible; for rerunnable names, prefer top-level var, ' +
        'or choose a new name, use a short block scope, or call ' +
        'node_repl_reset. User-exported declarations stay local to their cell. ' +
        'A timeout or cancellation replaces the kernel and loses its bindings. ' +
        'Top-level static imports are unsupported; use await import() for ' +
        'local .js/.mjs modules and packages from ' +
        'node_repl_add_node_module_dir roots. The untrusted runtime exposes ' +
        'no process or environment variables, require, Node builtins, worker ' +
        'threads, shell, or nested Qwen tool access.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            minLength: 1,
            description: 'JavaScript source to execute in the persistent REPL.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: `Execution timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TITLE_LENGTH,
            description:
              'Short human-readable description of what this execution does.',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer
      false, // alwaysLoad
      'node repl javascript execute run code persistent session vm',
    );
  }

  override get maxOutputChars(): number {
    return Infinity;
  }

  protected override validateToolParamValues(
    params: NodeReplToolParams,
  ): string | null {
    if (typeof params.code !== 'string' || params.code.length === 0) {
      return 'Missing or empty "code".';
    }
    if (params.timeout_ms !== undefined) {
      if (!Number.isSafeInteger(params.timeout_ms) || params.timeout_ms <= 0) {
        return '"timeout_ms" must be a positive safe integer.';
      }
    }
    if (params.title !== undefined) {
      // Count Unicode code points, not UTF-16 units, so astral characters
      // (emoji, CJK extensions) are not double-counted against the limit.
      const titleLength =
        typeof params.title === 'string' ? [...params.title].length : 0;
      if (
        typeof params.title !== 'string' ||
        titleLength < 1 ||
        titleLength > MAX_TITLE_LENGTH
      ) {
        return `"title" must be a string of 1..${MAX_TITLE_LENGTH} characters.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: NodeReplToolParams,
  ): ToolInvocation<NodeReplToolParams, ToolResult> {
    return new NodeReplInvocation(this.session, params);
  }

  /** Called by ToolRegistry.stop() at session teardown. */
  dispose(): void {
    this.session.dispose();
  }
}

// ---------------------------------------------------------------------------
// node_repl_reset
// ---------------------------------------------------------------------------

export type NodeReplResetToolParams = object;

class NodeReplResetInvocation extends BaseToolInvocation<
  NodeReplResetToolParams,
  ToolResult
> {
  constructor(
    private readonly session: NodeReplSession,
    params: NodeReplResetToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Reset the Node REPL session state';
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    // Destroys only session-local REPL state; safe by construction.
    return Promise.resolve('allow');
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (!this.session.hasManager()) {
      return {
        llmContent:
          'The Node REPL session was already empty; nothing to reset.',
        returnDisplay: 'REPL already empty',
      };
    }
    try {
      const manager = this.session.getManager();
      const roots = manager.getModuleRoots().length;
      await manager.reset();
      const generation = manager.getGeneration();
      const message =
        `Node REPL process reset to generation ${generation}: all bindings ` +
        'and loaded modules are gone. The next execution starts lazily. ' +
        (roots > 0
          ? `${roots} approved module root(s) remain registered.`
          : 'No module roots are registered.');
      return { llmContent: message, returnDisplay: 'REPL reset' };
    } catch (e) {
      return errorResult(
        `node_repl_reset failed: ${e instanceof Error ? e.message : String(e)}`,
        ToolErrorType.EXECUTION_FAILED,
      );
    }
  }
}

export class NodeReplResetTool extends BaseDeclarativeTool<
  NodeReplResetToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.NODE_REPL_RESET;

  constructor(private readonly session: NodeReplSession) {
    super(
      NodeReplResetTool.Name,
      ToolDisplayNames.NODE_REPL_RESET,
      'Clears all state in the persistent node_repl session (top-level ' +
        'bindings and loaded modules) without ending the task. Use this when ' +
        'reusing an existing binding, top-level var, a short block, or a fresh ' +
        'name cannot recover from conflicting declarations. Approved module ' +
        'roots registered via node_repl_add_node_module_dir are kept.',
      Kind.Execute,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      true,
      false,
      true, // shouldDefer
      false,
      'node repl reset clear state bindings session',
    );
  }

  protected createInvocation(
    params: NodeReplResetToolParams,
  ): ToolInvocation<NodeReplResetToolParams, ToolResult> {
    return new NodeReplResetInvocation(this.session, params);
  }

  dispose(): void {
    this.session.dispose();
  }
}

// ---------------------------------------------------------------------------
// node_repl_add_node_module_dir
// ---------------------------------------------------------------------------

export interface NodeReplAddNodeModuleDirParams {
  path: string;
}

class NodeReplAddNodeModuleDirInvocation extends BaseToolInvocation<
  NodeReplAddNodeModuleDirParams,
  ToolResult
> {
  constructor(
    private readonly session: NodeReplSession,
    params: NodeReplAddNodeModuleDirParams,
    private readonly approvedCanonicalPath: string | null,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Allow node_repl imports from ${this.params.path}`;
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve(
      this.approvedCanonicalPath && this.session.isWorkspaceTrusted()
        ? 'ask'
        : 'deny',
    );
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (!this.approvedCanonicalPath || !this.session.isWorkspaceTrusted()) {
      return errorResult(
        'node_repl module roots cannot be added until the workspace is trusted.',
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    try {
      const registration = await this.session
        .getManager()
        .addModuleRoot(this.params.path, this.approvedCanonicalPath);
      return {
        llmContent: String(registration.added),
        returnDisplay: registration.added
          ? `Added module root: ${registration.path}`
          : `Module root already registered: ${registration.path}`,
      };
    } catch (e) {
      return errorResult(
        `node_repl_add_node_module_dir failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        ToolErrorType.INVALID_TOOL_PARAMS,
      );
    }
  }
}

export class NodeReplAddNodeModuleDirTool extends BaseDeclarativeTool<
  NodeReplAddNodeModuleDirParams,
  ToolResult
> {
  static readonly Name = ToolNames.NODE_REPL_ADD_NODE_MODULE_DIR;

  constructor(private readonly session: NodeReplSession) {
    super(
      NodeReplAddNodeModuleDirTool.Name,
      ToolDisplayNames.NODE_REPL_ADD_NODE_MODULE_DIR,
      'Registers an absolute path to a node_modules directory so packages ' +
        'inside it can be imported (untrusted) with dynamic import() in ' +
        'node_repl. Registration persists across node_repl_reset for the ' +
        'rest of the task. Returns true when newly added and false when the ' +
        'same canonical root was already registered. It never grants elevated ' +
        '(trusted) execution.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description:
              'Absolute path to a node_modules directory to allow imports from.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      true,
      false,
      true, // shouldDefer
      false,
      'node repl module node_modules import package dependency register',
    );
  }

  protected override validateToolParamValues(
    params: NodeReplAddNodeModuleDirParams,
  ): string | null {
    if (typeof params.path !== 'string' || params.path.trim().length === 0) {
      return 'Missing or empty "path".';
    }
    const trimmed = params.path.trim();
    if (!path.isAbsolute(trimmed)) {
      return `"path" must be an absolute path, got: ${params.path}`;
    }
    if (!this.session.isWorkspaceTrusted()) return null;
    try {
      this.session.validateModuleRoot(trimmed);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  }

  protected createInvocation(
    params: NodeReplAddNodeModuleDirParams,
  ): ToolInvocation<NodeReplAddNodeModuleDirParams, ToolResult> {
    const trimmed = params.path.trim();
    const canonicalPath = this.session.isWorkspaceTrusted()
      ? this.session.validateModuleRoot(trimmed)
      : null;
    return new NodeReplAddNodeModuleDirInvocation(
      this.session,
      { path: canonicalPath ?? trimmed },
      canonicalPath,
    );
  }

  override toAutoClassifierInput(
    params: NodeReplAddNodeModuleDirParams,
  ): Record<string, unknown> | string {
    if (!this.session.isWorkspaceTrusted()) return '';
    return { path: this.session.validateModuleRoot(params.path.trim()) };
  }

  dispose(): void {
    this.session.dispose();
  }
}
