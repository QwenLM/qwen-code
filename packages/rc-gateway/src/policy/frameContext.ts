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

export type PolicyOperation = 'read' | 'write' | 'execute';

/**
 * Parameter keys that carry a filesystem path across the tools behind each ACP
 * kind (`write_file`/`edit` use `file_path`, `notebook_edit` uses
 * `notebook_path`, shell uses `directory`, etc.). Single source of truth so the
 * list cannot drift.
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
  /** Every path the call touches (shell-derived paths added in Task 2). */
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

/** Operations implied by an ACP kind alone (shell adds more in Task 2). */
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
