/**
 * The ONLY module that understands the `permission_request` wire shape.
 *
 * The daemon emits the ACP ToolCall verbatim: `{ toolCallId, title, kind,
 * rawInput, ... }`. It carries NO tool name and NO `input`/`args` — reading
 * those (as the enforcer historically did) silently yields the humanized
 * `title` as the tool and the whole toolCall as the args, which is why every
 * `tool:`/`pathGlob:` rule has been dead. Keep that knowledge here so the
 * evaluator and enforcer stay frame-agnostic.
 */

import { resolve as resolvePath } from 'node:path';
import {
  extractShellOperations,
  splitCompoundCommand,
} from '@qwen-code/qwen-code-core';

export type PolicyOperation = 'read' | 'write' | 'execute';

/**
 * Parameter keys that carry a filesystem path across the tools behind each ACP
 * kind (`write_file`/`edit` use `file_path`, `notebook_edit` uses
 * `notebook_path`, etc.). NOTE: `cwd` is a path candidate here (a call whose
 * own `rawInput.cwd` names a target counts it), AND it is separately read as
 * `rawInput.directory`/`rawInput.cwd` below to resolve the working-directory
 * context — the two uses are not mutually exclusive. Single source of truth
 * so the list cannot drift.
 */
export const PATH_PARAM_KEYS = [
  'file_path',
  'notebook_path',
  'absolute_path',
  'path',
  'cwd',
] as const;

/** Array-valued path parameter keys. */
export const PATH_ARRAY_PARAM_KEYS = ['files'] as const;

export interface FrameContext {
  /** The ACP kind, used as `tool`. '' when absent/malformed. */
  tool: string;
  /** The REAL arguments (`toolCall.rawInput`), never the whole toolCall. */
  args: unknown;
  /** Every path the call touches, including shell-derived paths. */
  paths: string[];
  /** Operations the call implies, for `match.operation`. */
  operations: PolicyOperation[];
  /** Anchors path matching and relative-path resolution. */
  projectRoot: string;
  cwd: string;
  /**
   * Passed through only. NOTHING populates these today (see the design):
   * a permission_request originates from the local model, not a remote token.
   */
  originScope?: string;
  sessionTag?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Operations implied by an ACP kind alone (a shell command can add more). */
function operationsForKind(kind: string): PolicyOperation[] {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return ['read'];
    case 'edit':
      return ['write'];
    case 'execute':
      return ['execute'];
    default:
      return [];
  }
}

function collectPathParams(rawInput: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_PARAM_KEYS) {
    const v = rawInput[key];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  for (const key of PATH_ARRAY_PARAM_KEYS) {
    const v = rawInput[key];
    if (Array.isArray(v)) {
      for (const f of v) if (typeof f === 'string' && f.length > 0) out.push(f);
    }
  }
  return out;
}

/** core `ShellOperation.virtualTool` → policy operation. */
function operationForVirtualTool(virtualTool: string): PolicyOperation | null {
  switch (virtualTool) {
    case 'read_file':
    case 'list_directory':
    case 'grep_search':
    case 'web_fetch':
      return 'read';
    case 'edit':
    case 'write_file':
      return 'write';
    default:
      return null;
  }
}

/**
 * If `simple` is a `cd` invocation, returns its raw target argument (the
 * empty string for a bare `cd` with no argument); otherwise returns
 * `undefined`. Strips one layer of surrounding quotes and skips leading
 * flags (e.g. `cd -P dir`) so the directory argument survives the common
 * cases without a full shell-quoting implementation.
 */
function parseCdTarget(simple: string): string | undefined {
  const match = /^cd(?:\s+(.*))?$/.exec(simple.trim());
  if (!match) return undefined;
  const rest = (match[1] ?? '').trim();
  if (!rest) return '';
  const token = rest.split(/\s+/).find((t) => !t.startsWith('-')) ?? '';
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Applies a parsed `cd` target to the running cwd. A bare `cd`, `cd -`
 * (previous directory) and `cd ~` (home) are left UNCHANGED — we have no
 * honest value for $OLDPWD or $HOME here, and guessing could put a path
 * candidate somewhere bash never touched. An absolute target replaces the
 * cwd outright; a relative target resolves against it (`node:path`'s
 * `resolve` already gives this precedence for free).
 */
function applyCd(target: string, runningCwd: string): string {
  if (!target || target === '-' || target === '~' || target.startsWith('~/')) {
    return runningCwd;
  }
  return resolvePath(runningCwd, target);
}

/**
 * Paths + operations a shell command implies. Best-effort by construction: an
 * unparseable command contributes nothing and NEVER throws, so a call still
 * matches on kind/args. It can only ever ADD candidates, never remove them.
 *
 * Tracks a running cwd across the split subcommands: a `cd` in one
 * subcommand carries forward to the ones after it (`cd config && cat
 * secrets/x` reads `<cwd>/config/secrets/x`, not `<cwd>/secrets/x`).
 * Without this, every subcommand resolved against the SAME static `cwd`
 * regardless of an earlier `cd`, so the candidate path for anything after a
 * `cd` was simply wrong — and a `pathGlob` deny anchored on the real
 * (post-`cd`) location would silently fail to match even though bash truly
 * touches that path. See frameContext.test.ts's "tracks a `cd` across
 * compound subcommands" case for the exploit this closes.
 *
 * Whenever a `cd` moves the running cwd away from the original static `cwd`,
 * paths are resolved against BOTH: the running (cd-aware) cwd, which is
 * correct for the common sequential `cd X && <cmd> <relpath>` shape this
 * fix targets, AND the original static `cwd`, which stays a candidate as a
 * fail-closed fallback. That fallback matters because `applyCd` can't
 * always compute the real post-`cd` directory (an unresolvable target —
 * `cd $DIR`, `cd "$(pwd)"` — makes `runningCwd` a best-effort guess, and
 * `splitCompoundCommand` also splits on `|`, which runs its left side in a
 * subshell whose `cd` never actually affects the rest of the pipeline).
 * Keeping the static-cwd candidate too means this enrichment can only ever
 * ADD a correct candidate, never silently drop one that a pre-fix deny rule
 * already matched.
 *
 * RESIDUAL: the daemon's own local enforcement
 * (`packages/core/src/permissions/permission-manager.ts`,
 * `evaluateCompoundCommand`/`evaluateSingle`) has this SAME single-static-cwd
 * limitation and is intentionally NOT touched here (out of scope — no
 * core/daemon changes). This fix closes the gap only for the remote
 * gateway's auto-vote enforcement path built from this frame; the
 * daemon-local enforcement path retains it.
 */
function shellEnrichment(
  command: string,
  cwd: string,
): { paths: string[]; operations: PolicyOperation[] } {
  const paths: string[] = [];
  const operations: PolicyOperation[] = [];
  try {
    let runningCwd = cwd;
    for (const simple of splitCompoundCommand(command)) {
      const cdTarget = parseCdTarget(simple);
      if (cdTarget !== undefined) {
        runningCwd = applyCd(cdTarget, runningCwd);
      }
      const cwdsToResolve =
        runningCwd === cwd ? [runningCwd] : [runningCwd, cwd];
      for (const resolveCwd of cwdsToResolve) {
        for (const op of extractShellOperations(simple, resolveCwd)) {
          if (typeof op.filePath === 'string' && op.filePath.length > 0) {
            paths.push(op.filePath);
          }
          const mapped = operationForVirtualTool(op.virtualTool);
          if (mapped) operations.push(mapped);
        }
      }
    }
  } catch {
    // Unparseable shell → contribute nothing. Never fail open.
  }
  return { paths, operations };
}

export function frameToContext(
  data: unknown,
  ctx: { projectRoot: string; originScope?: string; sessionTag?: string },
): FrameContext {
  const d = asRecord(data) ?? {};
  const toolCall = asRecord(d['toolCall']) ?? {};
  const tool = asString(toolCall['kind']) ?? '';
  const rawInput = asRecord(toolCall['rawInput']) ?? {};

  const cwd =
    asString(rawInput['directory']) ??
    asString(rawInput['cwd']) ??
    ctx.projectRoot;

  const paths = collectPathParams(rawInput);
  const operations = operationsForKind(tool);

  if (tool === 'execute') {
    const command = asString(rawInput['command']);
    if (command) {
      const extra = shellEnrichment(command, cwd);
      paths.push(...extra.paths);
      operations.push(...extra.operations);
    }
  }

  return {
    tool,
    args: rawInput,
    paths: [...new Set(paths)],
    operations: [...new Set(operations)],
    projectRoot: ctx.projectRoot,
    cwd,
    ...(ctx.originScope !== undefined ? { originScope: ctx.originScope } : {}),
    ...(ctx.sessionTag !== undefined ? { sessionTag: ctx.sessionTag } : {}),
  };
}
