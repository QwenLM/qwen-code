/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as acorn from 'acorn';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runInSandbox,
  SOURCE_MAX_BYTES,
  SYNC_CPU_TIMEOUT_MS,
  WorkflowScriptError,
  type SandboxBridges,
} from './sandbox.js';
import { Scheduler } from './scheduler.js';
import { canonicalHash, Journal } from './journal.js';
import { assertSafeResumeRunId } from './resolveNamed.js';
import type { AgentSpawner } from './spawner.js';
import type { WorktreeProvider } from './worktree.js';

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string }>;
}

export interface ParsedScript {
  meta: WorkflowMeta;
  body: string;
  scriptHash: string;
}

/** The opts object a script passes to agent(); only these keys are honored. */
interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  agentType?: string;
  isolation?: 'worktree';
  timeoutMs?: number;
}

/** Walk a verified-literal AST node into a JS value (no eval). */
function evalLiteral(node: acorn.Node, source: string): unknown {
  const n = node as unknown as {
    type: string;
    value?: unknown;
    elements?: acorn.Node[];
    properties?: Array<{
      type: string;
      computed: boolean;
      kind: string;
      key: { type: string; name?: string; value?: unknown };
      value: acorn.Node;
    }>;
    quasis?: Array<{ value: { cooked: string } }>;
    expressions?: acorn.Node[];
    operator?: string;
    argument?: acorn.Node;
    start: number;
    loc?: { start: { line: number; column: number } };
  };
  const fail = (): never => {
    const line = n.loc ? ` at line ${n.loc.start.line}` : '';
    throw new WorkflowScriptError(
      `workflow meta must be a pure literal (no computed values)${line}`,
    );
  };
  switch (n.type) {
    case 'Literal':
      return n.value;
    case 'TemplateLiteral':
      if ((n.expressions?.length ?? 0) !== 0) return fail();
      return n.quasis?.[0]?.value.cooked ?? '';
    case 'UnaryExpression':
      if ((n.operator === '-' || n.operator === '+') && n.argument) {
        const v = evalLiteral(n.argument, source);
        if (typeof v === 'number') return n.operator === '-' ? -v : v;
      }
      return fail();
    case 'ArrayExpression':
      return (n.elements ?? []).map((el) => {
        if (!el) return fail();
        return evalLiteral(el, source);
      });
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of n.properties ?? []) {
        if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init')
          return fail();
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? String(prop.key.value)
              : undefined;
        if (key === undefined) return fail();
        out[key] = evalLiteral(prop.value, source);
      }
      return out;
    }
    default:
      return fail();
  }
}

/**
 * Static meta parse + pure-literal AST check (design: "static meta parse").
 * Verifies the 512 KB cap, that exactly one `export const meta = <literal>`
 * exists, evaluates it, and strips the `export` keyword so the body runs inside
 * the sandbox's async IIFE. Throws WorkflowScriptError (with line info) before
 * any code executes.
 */
export function parseWorkflowScript(source: string): ParsedScript {
  if (Buffer.byteLength(source, 'utf8') > SOURCE_MAX_BYTES) {
    throw new WorkflowScriptError('workflow script exceeds 512 KB source cap');
  }
  let program: acorn.Node;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw new WorkflowScriptError(
      `workflow script parse error${loc ? ` at line ${loc.line}:${loc.column}` : ''}: ${(e as Error).message}`,
    );
  }

  const body = (program as unknown as { body: acorn.Node[] }).body;
  let metaExport:
    | {
        node: acorn.Node & {
          start: number;
          declaration: acorn.Node & { start: number };
        };
        init: acorn.Node;
      }
    | undefined;

  for (const stmt of body) {
    const s = stmt as unknown as {
      type: string;
      start: number;
      declaration?: unknown;
    };
    if (
      s.type === 'ExportDefaultDeclaration' ||
      s.type === 'ExportAllDeclaration'
    ) {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    if (s.type !== 'ExportNamedDeclaration') continue;
    const decl = s.declaration as unknown as {
      type: string;
      declarations?: Array<{
        id: { type: string; name?: string };
        init: acorn.Node;
      }>;
      start: number;
    } | null;
    if (!decl || decl.type !== 'VariableDeclaration') {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    const d = decl.declarations?.[0];
    if (!d || d.id.type !== 'Identifier' || d.id.name !== 'meta' || !d.init) {
      throw new WorkflowScriptError('workflow scripts may only export `meta`');
    }
    metaExport = {
      node: stmt as acorn.Node & {
        start: number;
        declaration: acorn.Node & { start: number };
      },
      init: d.init,
    };
  }

  if (!metaExport) {
    throw new WorkflowScriptError(
      'workflow script must `export const meta = { ... }`',
    );
  }

  const metaValue = evalLiteral(
    metaExport.init,
    source,
  ) as Partial<WorkflowMeta>;
  if (
    typeof metaValue.name !== 'string' ||
    typeof metaValue.description !== 'string'
  ) {
    throw new WorkflowScriptError(
      'workflow meta requires string `name` and `description`',
    );
  }
  if (
    metaValue.phases !== undefined &&
    (!Array.isArray(metaValue.phases) ||
      metaValue.phases.some(
        (p) => typeof (p as { title?: unknown })?.title !== 'string',
      ))
  ) {
    throw new WorkflowScriptError(
      'workflow meta.phases must be an array of { title: string }',
    );
  }

  // Blank out just the `export ` keyword span so line/column numbers are
  // preserved for stack traces; the remaining `const meta = {...}` is a
  // harmless local inside the IIFE.
  const exportStart = metaExport.node.start;
  const declStart = metaExport.node.declaration.start;
  const stripped =
    source.slice(0, exportStart) +
    ' '.repeat(declStart - exportStart) +
    source.slice(declStart);

  return {
    meta: metaValue as WorkflowMeta,
    body: stripped,
    scriptHash: createHash('sha256').update(source).digest('hex'),
  };
}

export interface WorkflowRunOptions {
  runId?: string;
  args?: unknown;
  resumeFromRunId?: string;
  budgetTotal?: number;
  wallClockMs?: number;
  lifetimeAgentCap?: number;
  signal?: AbortSignal;
  onPhase?: (title: string, index: number) => void;
  onAgentCount?: (counted: number) => void;
}

export interface WorkflowRunResult {
  runId: string;
  result: unknown;
  status: 'completed' | 'failed' | 'cancelled';
  tokensSpent: number;
}

function defaultRunsDir(): string {
  return join(homedir(), '.qwen', 'workflows', 'runs');
}

/**
 * The one engine (design: Approach A). Assembles the agent bridge over
 * scheduler + journal + spawner + optional worktree, and runs the script in the
 * sandbox. Works with ANY AgentSpawner (HeadlessSpawner in core; SessionSpawner
 * in the gateway).
 */
export class WorkflowEngine {
  constructor(
    private readonly spawner: AgentSpawner,
    private readonly opts: {
      runsDir?: string;
      worktree?: WorktreeProvider;
      systemContext?: string;
    } = {},
  ) {}

  async run(
    source: string,
    runOpts: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const parsed = parseWorkflowScript(source);
    const runId = runOpts.runId ?? randomUUID();
    const runsDir = this.opts.runsDir ?? defaultRunsDir();
    // SECURITY: `resumeFromRunId` is caller-supplied (tool params AND gateway
    // request body) and is about to be joined into `runsDir`. Guard it here —
    // the single path-join chokepoint both surfaces feed — with the same
    // bare-identifier rule used for named workflows, so a traversal id can
    // never read/replay a journal outside the runs directory. (`runId` above
    // is always internally generated, so it needs no guard.)
    if (runOpts.resumeFromRunId !== undefined) {
      assertSafeResumeRunId(runOpts.resumeFromRunId);
    }
    const journal = await Journal.open(join(runsDir, runId), {
      meta: parsed.meta,
      scriptHash: parsed.scriptHash,
      args: runOpts.args ?? null,
      resumeDir: runOpts.resumeFromRunId
        ? join(runsDir, runOpts.resumeFromRunId)
        : undefined,
    });
    const scheduler = new Scheduler(
      undefined,
      runOpts.lifetimeAgentCap ?? 1000,
    );
    const budgetTotal = runOpts.budgetTotal ?? Number.POSITIVE_INFINITY;
    let tokensSpent = 0;

    // Wall-clock watchdog (distinct from the vm sync timeout — see sandbox.ts).
    const controller = new AbortController();
    if (runOpts.signal) {
      runOpts.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
    const wallMs = runOpts.wallClockMs ?? SYNC_CPU_TIMEOUT_MS;
    const deadline = Date.now() + wallMs;
    const timer = setTimeout(() => controller.abort(), wallMs);
    timer.unref?.();

    let phaseIndex = -1;
    const bridges: SandboxBridges = {
      budgetTotal: () => budgetTotal,
      budgetSpent: () => tokensSpent,
      log: (m) => journal.log(m),
      phase: (title) => {
        phaseIndex += 1;
        journal.phase(title, phaseIndex);
        runOpts.onPhase?.(title, phaseIndex);
      },
      agent: (promptJson, optsJson, resolve, reject) => {
        const seq = journal.nextSeq(); // SYNC seq at entry — deterministic
        let prompt: unknown;
        let opts: AgentOpts;
        try {
          prompt = JSON.parse(promptJson);
          opts = JSON.parse(optsJson) as AgentOpts;
        } catch {
          reject('workflow: malformed agent arguments');
          return;
        }
        const promptHash = canonicalHash(prompt);
        const optsHash = canonicalHash(opts);

        const cached = journal.lookup(seq, 'agent', promptHash, optsHash);
        if (cached) {
          resolve(JSON.stringify(cached.result));
          return;
        }
        if (tokensSpent >= budgetTotal) {
          reject('workflow budget exhausted');
          return;
        }
        if (controller.signal.aborted || Date.now() > deadline) {
          reject('workflow cancelled or wall-clock ceiling exceeded');
          return;
        }
        if (!scheduler.tryCountAgent()) {
          reject('workflow lifetime agent cap exceeded');
          return;
        }
        runOpts.onAgentCount?.(scheduler.counted);

        void (async () => {
          const release = await scheduler.acquire();
          let cwd: string | undefined;
          try {
            if (opts.isolation === 'worktree') {
              // Fail loud, NEVER silently downgrade to the shared tree. If a
              // script asks for worktree isolation but no provider is wired,
              // error this agent (the catch below maps it to the design's null
              // envelope) rather than running it in the shared working tree.
              // NOTE: full GitWorktreeProvider wiring into the CLI tool and the
              // gateway route is a deliberate follow-up; only the silent-
              // downgrade hole is closed here.
              if (!this.opts.worktree) {
                throw new Error(
                  "workflow: isolation 'worktree' requested but no worktree " +
                    'provider is wired for this run — refusing to fall back to ' +
                    'the shared working tree',
                );
              }
              cwd = await this.opts.worktree.acquire(runId, seq);
            }
            const out = await this.spawner.spawn({
              prompt:
                typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
              systemContext: this.opts.systemContext ?? '',
              model: opts.model,
              agentType: opts.agentType,
              schema: opts.schema,
              cwd,
              signal: controller.signal,
            });
            tokensSpent += out.tokens;
            const env =
              out.structured !== undefined
                ? { kind: 'structured' as const, value: out.structured }
                : out.text !== undefined
                  ? { kind: 'text' as const, text: out.text }
                  : { kind: 'null' as const };
            await journal.append({
              seq,
              kind: 'agent',
              promptHash,
              optsHash,
              result: env,
              tokens: out.tokens,
            });
            resolve(JSON.stringify(env));
          } catch (e) {
            // Spawn/exec/schema/worktree failure → agent() resolves null (design).
            const env = { kind: 'null' as const };
            // HARDENING: a SECOND failure here (e.g. journal.append ENOSPC) must
            // NOT escape this IIFE as an unhandled rejection and leave the agent
            // unsettled — that would hang agent() until the wall-clock deadline.
            // Swallow the append failure and ALWAYS resolve a null envelope so
            // the agent settles.
            await journal
              .append({
                seq,
                kind: 'agent',
                promptHash,
                optsHash,
                result: env,
                tokens: 0,
                error: String((e as Error)?.message ?? e),
              })
              .catch(() => {});
            resolve(JSON.stringify(env));
          } finally {
            release();
          }
        })();
      },
    };

    try {
      const result = await runInSandbox(parsed.body, bridges, {
        argsJson:
          runOpts.args === undefined ? undefined : JSON.stringify(runOpts.args),
        syncTimeoutMs: wallMs,
        filename: `${parsed.meta.name}.js`,
      });
      clearTimeout(timer);
      await journal.setStatus('completed', tokensSpent);
      if (this.opts.worktree) await this.opts.worktree.cleanup(runId);
      return { runId, result, status: 'completed', tokensSpent };
    } catch (e) {
      clearTimeout(timer);
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      await journal.setStatus(status, tokensSpent);
      if (this.opts.worktree) await this.opts.worktree.cleanup(runId);
      if (status === 'cancelled') {
        return { runId, result: undefined, status, tokensSpent };
      }
      throw e instanceof WorkflowScriptError
        ? e
        : new WorkflowScriptError(String((e as Error)?.message ?? e));
    }
  }
}
