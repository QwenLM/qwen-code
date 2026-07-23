# Gateway Policy Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the rc-gateway policy engine's extraction (its `tool`/`pathGlob` rules have never matched a real daemon frame) and upgrade its matching to reuse core's picomatch path matching and shell-semantics.

**Architecture:** A new `policy/frameContext.ts` becomes the single seam that understands the `permission_request` wire shape — it reads `toolCall.kind` and `toolCall.rawInput`, collects path candidates from real parameter keys, and for `kind:'execute'` runs core's `splitCompoundCommand` + `extractShellOperations` to add the paths a shell command touches. The evaluator consumes that context, swaps its depth-blind hand-rolled glob for core's `matchesPathPattern` on `pathGlob`, and gains a `match.operation` dimension. The enforcer stops doing its own extraction.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, Vitest. Single repo: the `qwen-code` fork, branch `add-remote-control-spec`. Reuses `@qwen-code/qwen-code-core` (already a declared dependency and already imported by rc-gateway).

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-22-gateway-policy-matching-design.md`. Every task implements part of it.
- **No edits outside `packages/rc-gateway/`.** Importing from `@qwen-code/qwen-code-core` is expected and already precedented (`cli.ts:83`, `workflows/sessionSpawner.ts:12-13`, `routes/workflows.ts:15`). **Nothing in `packages/core` or `packages/cli` may be modified.**
- **No daemon change.** Tool identity is the ACP `kind` only (`read | search | edit | execute | fetch | other`). Do not add a tool-name field to any frame.
- **ESM imports use `.js` specifiers** (`import { x } from './x.js'`), matching the existing `packages/rc-gateway/src` style.
- **Tests must use REAL frame shapes** — `{ toolCallId, title, kind, rawInput }`. The synthetic `{ name, input }` shape in `policy/enforcer.test.ts:37,163,253` is exactly what hid this bug for nine cycles; never introduce it in a new test.
- **Fail-closed everywhere.** Malformed input yields no match / the policy default / `prompt`. No code path may turn a parse failure into an `allow`.
- **The enforcer's existing security contract is untouched** (`enforcer.ts:38-54`): fail-closed on empty policy, fail-safe with no `requestId`/approve option, never throws, one-time `allow_once` votes only, audit detail never carries args/paths/prompt.
- **`policy explain` and `policy lint` must keep working.** They build contexts from CLI flags, not frames, and stay daemon-free.
- **Scope exclusions:** `originScope`/`sessionTag` are NOT populated by this arc (no source exists — see the design). No daemon field, no remote approval-mode surface, no runtime "why", no sandboxing, no credential filtering.
- **Two repos.** Task 0 authors an OpenSpec change in `/home/evan/projects/qwen-code-remote` (on a new branch `fix-policy-frame-matching`, PR'd to `main` like prior features). Tasks 1–9 are implementation in the `qwen-code` fork on `add-remote-control-spec`. Spec first, per the repo's convention.
- **Never write a partial-content `## MODIFIED Requirements` fragment.** If a MODIFIED block is used it MUST carry the _complete_ requirement text (header + every scenario); a fragment causes archive-time data loss. This footgun has recurred in prior changes — see Task 0.
- **Commit after every task.** Pre-commit hooks run prettier/eslint on staged files; let them reformat.

---

## File Structure

**Create:**

- `packages/rc-gateway/src/policy/frameContext.ts` — the only module that understands the permission-frame wire shape. Turns a frame into a `FrameContext`.
- `packages/rc-gateway/src/policy/frameContext.test.ts`

**Modify:**

- `packages/rc-gateway/src/policy/evaluator.ts` — consume `ctx.paths`; picomatch `pathGlob`; `match.operation`.
- `packages/rc-gateway/src/policy/loader.ts` — `match.tool` alias normalization; `match.operation` schema; lint warnings.
- `packages/rc-gateway/src/policy/enforcer.ts` — build context via `frameToContext`.
- `packages/rc-gateway/src/policy/enforcer.test.ts` — migrate to real frame shapes.
- `packages/rc-gateway/src/policy/evaluator.test.ts`, `loader.test.ts`, `explain.ts`/its test — follow the widened context.
- `packages/rc-gateway/docs/walkthrough.md` — correct the policy path and document the behavior change.

---

## Task 0: OpenSpec change (qwen-code-remote)

**Files (all in `/home/evan/projects/qwen-code-remote`):**

- Create: `openspec/changes/fix-policy-frame-matching/proposal.md`
- Create: `openspec/changes/fix-policy-frame-matching/design.md`
- Create: `openspec/changes/fix-policy-frame-matching/tasks.md`
- Create: `openspec/changes/fix-policy-frame-matching/specs/policy-engine/spec.md`
- Possibly modify: the authoritative `policy-engine` spec (see Step 1)

**Interfaces:**

- Produces: the normative record of the corrected matching semantics + the new `operation` dimension. No code depends on it; Tasks 1–9 implement it.

- [ ] **Step 1: Establish where the authoritative policy-engine spec lives, and the repo's precedent**

Run:

```bash
cd /home/evan/projects/qwen-code-remote
git checkout -b fix-policy-frame-matching
ls openspec/changes/ | head -30
ls openspec/changes/archive/ 2>/dev/null | head -20
sed -n '1,60p' openspec/changes/add-policy-engine/specs/policy-engine/spec.md
cat openspec/config.yaml
```

Determine: is `add-policy-engine` still a pending change or archived? The
authoritative `policy-engine` requirements live wherever that resolves to.
Then follow the repo's established precedent — recent changes corrected
shared/authoritative content by **direct edit** to the authoritative file and
used their own change dir only for genuinely _new_ requirements. Record what
you find in your report before writing anything.

**Hard rule:** a `## MODIFIED Requirements` block, if you use one, MUST contain
the COMPLETE requirement (its `### Requirement:` header, full RFC-2119 prose,
and ALL its `#### Scenario:` blocks). Never a fragment — a partial MODIFIED
file causes archive-time data loss, and this exact footgun has recurred here.
Verify at the end: `grep -rn "MODIFIED Requirements" openspec/changes/fix-policy-frame-matching` and confirm any hit is a complete requirement.

- [ ] **Step 2: Write `proposal.md`**

Mirror the structure of a recent change (`# <name>` → `## Why` → `## What Changes`). The Why is the verified defect: the gateway policy engine reads `toolCall.name`/`toolCall.input`, but real ACP frames carry `{toolCallId, title, kind, rawInput}`, so `tool` degrades to the humanized title and `candidatePaths` always returns `[]` — every `tool:` and `pathGlob:` rule has been dead, and the enforcer's tests encode the bug via a synthetic `{name, input}` shape. What Changes: kind-based `tool` matching with tool-name aliases, path candidates from real parameter keys plus shell-derived paths, core-backed picomatch path matching, and a new `match.operation` dimension.

- [ ] **Step 3: Write `design.md`**

Copy the fork's design doc, `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-22-gateway-policy-matching-design.md`, changing only the top heading to `# Design — fix-policy-frame-matching`. It already contains the Alternatives and Threat-model sections `openspec/config.yaml` requires.

- [ ] **Step 4: Write the spec delta**

In `specs/policy-engine/spec.md`, write requirements with RFC-2119 keywords, each with at least one `#### Scenario:` (GIVEN/WHEN/THEN). Cover:

1. **Requirement: Permission-frame extraction** — the engine SHALL derive the matched tool from the ACP `toolCall.kind` and the matched arguments from `toolCall.rawInput`. Scenarios: a real execute frame matches a `tool: execute` rule; a real edit frame's `rawInput.file_path` supplies a path candidate; a malformed `toolCall` yields no match and falls through to the policy default.
2. **Requirement: Tool-name aliases** — `match.tool` SHALL accept an ACP kind or a known tool name, normalizing the latter to its kind at load; an unknown value SHALL be a load error. Scenarios: `run_shell_command` normalizes to `execute`; `write_file` and `edit` both normalize to `edit`; `not_a_tool` fails to load.
3. **Requirement: Path candidates and matching** — path candidates SHALL be collected from the call's real path parameters and, for `kind: execute`, from the file operations the shell command implies; `pathGlob` SHALL match with path normalization so equivalent spellings cannot bypass a rule. Scenarios: `cat .env` matches a `**/.env*` deny; `sub/../.env` matches the same rule.
4. **Requirement: Operation dimension** — `match.operation` SHALL narrow a rule to `read`, `write`, or `execute`. Scenarios: a write to a protected path is denied while a read of it is not; an unknown operation value fails to load.
5. **Requirement: Activation advisory** — because matching was previously inert, `policy lint` SHALL report allow rules as newly effective and SHALL warn when an `allow` rule uses a tool-name alias whose kind covers other tools. Scenarios: an `allow write_file` rule produces a widening warning; a `deny write_file` rule does not.

Also state as a documented limitation that `originScope`/`sessionTag` remain unpopulated (no source exists) — matching the fork design, so spec and code agree.

- [ ] **Step 5: Write `tasks.md`**

Mirror a recent change's `tasks.md`: phase headers, each task a `- [ ] **N.M Title**` checkbox with nested `- **Status:** not-started` and a `- **Prompt:** >` blockquote. Summarize Tasks 0–9 of this plan.

- [ ] **Step 6: Validate and commit**

Run:

```bash
cd /home/evan/projects/qwen-code-remote && npx openspec validate fix-policy-frame-matching 2>&1 | tail -20
grep -rn "MODIFIED Requirements" openspec/changes/fix-policy-frame-matching || echo "no MODIFIED blocks"
```

Expected: validation passes; any MODIFIED block is a complete requirement.

```bash
git add openspec/changes/fix-policy-frame-matching openspec/changes/add-policy-engine 2>/dev/null
git commit -m "spec(fix-policy-frame-matching): correct policy matching semantics + operation dimension"
```

---

## Task 1: `frameContext.ts` — frame → context (non-shell)

**Files:**

- Create: `packages/rc-gateway/src/policy/frameContext.ts`
- Test: `packages/rc-gateway/src/policy/frameContext.test.ts`

**Interfaces:**

- Produces: `PolicyOperation`, `PATH_PARAM_KEYS`, `FrameContext`, `frameToContext(data, ctx)`. Consumed by Task 2 (shell enrichment), Task 3/4 (evaluator), Task 7 (enforcer).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/policy/frameContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { frameToContext } from './frameContext.js';

/** A REAL permission_request `data` payload (ACP toolCall shape). */
function frame(kind: string, rawInput: Record<string, unknown>) {
  return {
    requestId: 'q1',
    sessionId: 's1',
    toolCall: { toolCallId: 'tc1', title: 'humanized text', kind, rawInput },
    options: [{ optionId: 'ok', kind: 'allow_once' }],
  };
}

describe('frameToContext', () => {
  it('uses the ACP kind as tool and rawInput as args (never the toolCall)', () => {
    const ctx = frameToContext(frame('execute', { command: 'npm test' }), {
      projectRoot: '/proj',
    });
    expect(ctx.tool).toBe('execute');
    expect(ctx.args).toEqual({ command: 'npm test' });
  });

  it('collects path candidates from real parameter keys', () => {
    const ctx = frameToContext(
      frame('edit', { file_path: 'src/a.ts', content: 'x' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toContain('src/a.ts');
  });

  it('collects notebook_path, absolute_path, path, cwd and files[]', () => {
    const ctx = frameToContext(
      frame('edit', {
        notebook_path: 'nb.ipynb',
        absolute_path: '/abs/x',
        path: 'p',
        cwd: '/c',
        files: ['f1', 'f2', 7],
      }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toEqual(
      expect.arrayContaining(['nb.ipynb', '/abs/x', 'p', '/c', 'f1', 'f2']),
    );
    expect(ctx.paths).not.toContain(7 as unknown as string);
  });

  it('derives operations from the kind', () => {
    expect(
      frameToContext(frame('read', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('search', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('edit', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['write']);
    expect(
      frameToContext(frame('fetch', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('other', {}), { projectRoot: '/p' }).operations,
    ).toEqual([]);
  });

  it('resolves cwd from the call, falling back to projectRoot', () => {
    expect(
      frameToContext(frame('execute', { command: 'ls', directory: '/d' }), {
        projectRoot: '/proj',
      }).cwd,
    ).toBe('/d');
    expect(
      frameToContext(frame('execute', { command: 'ls' }), {
        projectRoot: '/proj',
      }).cwd,
    ).toBe('/proj');
  });

  it('is fail-closed on malformed frames', () => {
    const ctx = frameToContext(
      { toolCall: 'not-an-object' },
      {
        projectRoot: '/proj',
      },
    );
    expect(ctx.tool).toBe('');
    expect(ctx.args).toEqual({});
    expect(ctx.paths).toEqual([]);
    expect(ctx.operations).toEqual([]);
  });

  it('passes through originScope/sessionTag but never invents them', () => {
    const ctx = frameToContext(frame('read', {}), { projectRoot: '/p' });
    expect(ctx.originScope).toBeUndefined();
    expect(ctx.sessionTag).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/frameContext.test.ts`
Expected: FAIL — `Cannot find module './frameContext.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/rc-gateway/src/policy/frameContext.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/frameContext.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/frameContext.ts packages/rc-gateway/src/policy/frameContext.test.ts
git commit -m "feat(rc-gateway): frameContext — read the real ACP permission frame"
```

---

## Task 2: shell-operation enrichment in `frameContext`

**Files:**

- Modify: `packages/rc-gateway/src/policy/frameContext.ts`
- Test: `packages/rc-gateway/src/policy/frameContext.test.ts` (add cases)

**Interfaces:**

- Consumes: `frameToContext` (Task 1); core's `extractShellOperations(simpleCommand: string, cwd: string): ShellOperation[]` where `ShellOperation = { virtualTool: 'read_file'|'list_directory'|'edit'|'write_file'|'web_fetch'|'grep_search'; filePath?: string; domain?: string }`, and `splitCompoundCommand` — both from `@qwen-code/qwen-code-core`.
- Produces: `FrameContext.paths` / `.operations` enriched for `kind:'execute'`.

> **Verify first:** confirm the exact export name for compound splitting in `packages/core/src/permissions/rule-parser.ts` (`splitCompoundCommand`) and that it is re-exported via `@qwen-code/qwen-code-core`. If the name differs, adapt the import and say so in your report. `extractShellOperations` takes a _simple_ command, so splitting first is required.

- [ ] **Step 1: Write the failing test**

Add to `frameContext.test.ts`:

```ts
describe('frameToContext — shell enrichment', () => {
  it('adds paths a shell command reads', () => {
    const ctx = frameToContext(frame('execute', { command: 'cat .env' }), {
      projectRoot: '/proj',
    });
    expect(ctx.paths.some((p) => p.endsWith('.env'))).toBe(true);
    expect(ctx.operations).toContain('read');
    expect(ctx.operations).toContain('execute');
  });

  it('splits compound commands and collects every part', () => {
    const ctx = frameToContext(
      frame('execute', { command: 'npm test && cat secrets.txt' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths.some((p) => p.endsWith('secrets.txt'))).toBe(true);
  });

  it('marks a shell write as a write operation', () => {
    const ctx = frameToContext(
      frame('execute', { command: 'echo hi > out.txt' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.operations).toContain('write');
  });

  it('never throws on an unparseable command (contributes nothing)', () => {
    const ctx = frameToContext(frame('execute', { command: '((((' }), {
      projectRoot: '/proj',
    });
    expect(ctx.tool).toBe('execute');
    expect(ctx.operations).toContain('execute');
  });

  it('does not run shell extraction for non-execute kinds', () => {
    const ctx = frameToContext(
      frame('edit', { file_path: 'a.ts', content: 'cat .env' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toEqual(['a.ts']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/frameContext.test.ts`
Expected: FAIL — the shell cases find no extra paths and no `read`/`write` operation.

- [ ] **Step 3: Write the implementation**

In `frameContext.ts`, add the import and the mapping, then call it from `frameToContext`:

```ts
import {
  extractShellOperations,
  splitCompoundCommand,
} from '@qwen-code/qwen-code-core';

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
 * Paths + operations a shell command implies. Best-effort by construction: an
 * unparseable command contributes nothing and NEVER throws, so a call still
 * matches on kind/args. It can only ever ADD candidates, never remove them.
 */
function shellEnrichment(
  command: string,
  cwd: string,
): { paths: string[]; operations: PolicyOperation[] } {
  const paths: string[] = [];
  const operations: PolicyOperation[] = [];
  try {
    for (const simple of splitCompoundCommand(command)) {
      for (const op of extractShellOperations(simple, cwd)) {
        if (typeof op.filePath === 'string' && op.filePath.length > 0) {
          paths.push(op.filePath);
        }
        const mapped = operationForVirtualTool(op.virtualTool);
        if (mapped) operations.push(mapped);
      }
    }
  } catch {
    // Unparseable shell → contribute nothing. Never fail open.
  }
  return { paths, operations };
}
```

Then in `frameToContext`, after computing `paths`/`operations`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/frameContext.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/frameContext.ts packages/rc-gateway/src/policy/frameContext.test.ts
git commit -m "feat(rc-gateway): frameContext extracts shell-implied paths and operations"
```

---

## Task 3: evaluator consumes `ctx.paths` and matches paths with picomatch

**Files:**

- Modify: `packages/rc-gateway/src/policy/evaluator.ts`
- Test: `packages/rc-gateway/src/policy/evaluator.test.ts` (add cases)

**Interfaces:**

- Consumes: `FrameContext` fields (Task 1); core's `matchesPathPattern(specifier: string, filePath: string, projectRoot: string, cwd: string): boolean` from `@qwen-code/qwen-code-core`.
- Produces: a widened `ToolCallContext` (`paths?`, `operations?`, `projectRoot?`, `cwd?`) that Task 4 and Task 7 rely on.

- [ ] **Step 1: Write the failing test**

Add to `packages/rc-gateway/src/policy/evaluator.test.ts` (follow the file's existing helper style for building a `Policy`):

```ts
import { evaluate } from './evaluator.js';

const denyEnv = {
  defaults: { action: 'prompt' as const },
  rules: [
    {
      id: 'deny-env',
      match: { pathGlob: ['**/.env*'] },
      action: 'deny' as const,
    },
  ],
};

it('matches pathGlob against ctx.paths (not args scraping)', () => {
  const d = evaluate(denyEnv, {
    tool: 'edit',
    args: {},
    paths: ['/proj/.env'],
    projectRoot: '/proj',
    cwd: '/proj',
  });
  expect(d.action).toBe('deny');
  expect(d.ruleId).toBe('deny-env');
});

it('normalizes equivalent path spellings (traversal cannot bypass)', () => {
  for (const p of ['/proj/./.env', '/proj/sub/../.env']) {
    const d = evaluate(denyEnv, {
      tool: 'edit',
      args: {},
      paths: [p],
      projectRoot: '/proj',
      cwd: '/proj',
    });
    expect(d.action, p).toBe('deny');
  }
});

it('still reports no-path-candidates when a pathGlob rule has no paths', () => {
  const d = evaluate(denyEnv, {
    tool: 'edit',
    args: {},
    paths: [],
    projectRoot: '/proj',
    cwd: '/proj',
  });
  expect(d.action).toBe('prompt'); // falls through to the default
  expect(d.source).toBe('default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/evaluator.test.ts`
Expected: FAIL — `paths`/`projectRoot`/`cwd` are not on `ToolCallContext`, and the traversal spellings do not match the hand-rolled glob.

- [ ] **Step 3: Write the implementation**

In `evaluator.ts`:

(a) Widen the context (replacing lines 16-22):

```ts
export interface ToolCallContext {
  tool: string;
  /** Canonicalized internally for argsGlob matching. */
  args?: unknown;
  /**
   * Every path the call touches. Supplied by `frameToContext` in production and
   * by the explain CLI from `--path`. Absent → pathGlob rules cannot match.
   */
  paths?: string[];
  /** Operations the call implies (see Task 4's `match.operation`). */
  operations?: string[];
  /** Anchors picomatch path matching; default to `process.cwd()` when absent. */
  projectRoot?: string;
  cwd?: string;
  originScope?: string;
  sessionTag?: string;
}
```

(b) Delete `candidatePaths` (lines 69-82) — it read `args.path/cwd/files`, which never saw real arguments.

(c) Add the core-backed path matcher near `canonicalArgString`:

```ts
import { matchesPathPattern } from '@qwen-code/qwen-code-core';

/**
 * Path matching via core's picomatch-backed matcher: real `**` depth semantics
 * and path normalization, so an equivalent spelling (`./x`, `a/../x`) cannot
 * bypass a deny that the old hand-rolled glob would have missed.
 * A pattern picomatch rejects yields `false` — never an accidental match.
 */
function pathMatchesAny(
  spec: string | string[] | undefined,
  filePath: string,
  projectRoot: string,
  cwd: string,
): boolean {
  if (spec === undefined) return true;
  const patterns = Array.isArray(spec) ? spec : [spec];
  for (const pattern of patterns) {
    try {
      if (matchesPathPattern(pattern, filePath, projectRoot, cwd)) return true;
    } catch {
      // Unusable pattern → not a match.
    }
  }
  return false;
}
```

(d) In `matchReason` (lines 107-135), replace the `pathGlob` block:

```ts
// pathGlob: present but zero candidate paths → no match.
if (m.pathGlob !== undefined) {
  if (paths.length === 0) return 'no-path-candidates';
  const root = ctx.projectRoot ?? process.cwd();
  const cwd = ctx.cwd ?? root;
  if (!paths.some((p) => pathMatchesAny(m.pathGlob, p, root, cwd))) {
    return 'path-mismatch';
  }
}
```

(e) Wherever `evaluate` and `explainPolicy` currently compute `paths` via `candidatePaths(ctx.args)`, use `const paths = ctx.paths ?? [];` instead. (Search `candidatePaths(` — replace every call site; there is one in the evaluate path and one in the explain path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/evaluator.test.ts`
Expected: PASS, including the two traversal spellings.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/evaluator.ts packages/rc-gateway/src/policy/evaluator.test.ts
git commit -m "fix(rc-gateway): evaluator matches supplied paths with core picomatch"
```

---

## Task 4: `match.operation` dimension

**Files:**

- Modify: `packages/rc-gateway/src/policy/evaluator.ts`
- Test: `packages/rc-gateway/src/policy/evaluator.test.ts` (add cases)

**Interfaces:**

- Consumes: `ToolCallContext.operations` (Task 3); `PolicyRuleMatch.operation` (Task 5 adds the schema — the evaluator only reads it, so this task can land first and Task 5 makes it loadable).
- Produces: the `operation-mismatch` reason token and a specificity weight of 30.

- [ ] **Step 1: Write the failing test**

```ts
const denyEnvWrites = {
  defaults: { action: 'prompt' as const },
  rules: [
    {
      id: 'deny-env-writes',
      match: { pathGlob: ['**/.env*'], operation: 'write' },
      action: 'deny' as const,
    },
  ],
};

it('matches only the named operation', () => {
  const write = evaluate(denyEnvWrites, {
    tool: 'edit',
    args: {},
    paths: ['/proj/.env'],
    operations: ['write'],
    projectRoot: '/proj',
    cwd: '/proj',
  });
  expect(write.action).toBe('deny');

  const read = evaluate(denyEnvWrites, {
    tool: 'read',
    args: {},
    paths: ['/proj/.env'],
    operations: ['read'],
    projectRoot: '/proj',
    cwd: '/proj',
  });
  expect(read.action).toBe('prompt');
  expect(read.source).toBe('default');
});

it('accepts a list of operations', () => {
  const rule = {
    defaults: { action: 'prompt' as const },
    rules: [
      {
        id: 'r',
        match: { operation: ['write', 'execute'] },
        action: 'deny' as const,
      },
    ],
  };
  expect(
    evaluate(rule, { tool: 'execute', args: {}, operations: ['execute'] })
      .action,
  ).toBe('deny');
  expect(
    evaluate(rule, { tool: 'read', args: {}, operations: ['read'] }).action,
  ).toBe('prompt');
});

it('does not match when the call reports no operations', () => {
  expect(
    evaluate(denyEnvWrites, {
      tool: 'other',
      args: {},
      paths: ['/proj/.env'],
      operations: [],
      projectRoot: '/proj',
      cwd: '/proj',
    }).action,
  ).toBe('prompt');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/evaluator.test.ts`
Expected: FAIL — `operation` is ignored, so the read case denies too.

- [ ] **Step 3: Write the implementation**

In `matchReason`, after the `pathGlob` block and before `originScope`:

```ts
// operation (absent → no constraint). Pure AND, like every other dimension:
// it can only ever NARROW a rule.
if (m.operation !== undefined) {
  const want = Array.isArray(m.operation) ? m.operation : [m.operation];
  const have = ctx.operations ?? [];
  if (!want.some((o) => have.includes(o))) return 'operation-mismatch';
}
```

In `specificity` (lines 84-99), add alongside the other 30-weights:

```ts
if (m.operation !== undefined) w += 30;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/evaluator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/evaluator.ts packages/rc-gateway/src/policy/evaluator.test.ts
git commit -m "feat(rc-gateway): match.operation dimension (read/write/execute)"
```

---

## Task 5: loader — `match.tool` aliases + `match.operation` schema

**Files:**

- Modify: `packages/rc-gateway/src/policy/loader.ts`
- Test: `packages/rc-gateway/src/policy/loader.test.ts` (add cases)

**Interfaces:**

- Produces: `TOOL_ALIAS_TO_KIND`, `POLICY_OPERATIONS`, and a `PolicyRuleMatch` that carries `operation?: string | string[]` with `tool` already normalized to a kind. Task 6 (lint) and Task 7 (enforcer) depend on the normalization happening at load.

- [ ] **Step 1: Write the failing test**

```ts
import { loadPolicy } from './loader.js';

it('normalizes a tool-name alias to its ACP kind', () => {
  const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: run_shell_command }
    action: deny
defaults: { action: prompt }
`);
  expect(p.rules[0].match.tool).toBe('execute');
});

it('accepts a kind directly', () => {
  const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: execute }
    action: deny
defaults: { action: prompt }
`);
  expect(p.rules[0].match.tool).toBe('execute');
});

it('maps write_file and edit to the same kind', () => {
  const p = loadPolicy(`
rules:
  - id: a
    match: { tool: write_file }
    action: deny
  - id: b
    match: { tool: edit }
    action: deny
defaults: { action: prompt }
`);
  expect(p.rules[0].match.tool).toBe('edit');
  expect(p.rules[1].match.tool).toBe('edit');
});

it('rejects an unknown tool value', () => {
  expect(() =>
    loadPolicy(`
rules:
  - id: r1
    match: { tool: not_a_tool }
    action: deny
defaults: { action: prompt }
`),
  ).toThrow(/not_a_tool/);
});

it('accepts and validates match.operation', () => {
  const p = loadPolicy(`
rules:
  - id: r1
    match: { operation: write }
    action: deny
defaults: { action: prompt }
`);
  expect(p.rules[0].match.operation).toBe('write');
  expect(() =>
    loadPolicy(`
rules:
  - id: r1
    match: { operation: delete }
    action: deny
defaults: { action: prompt }
`),
  ).toThrow(/operation/);
});

it('leaves the wildcard tool alone', () => {
  const p = loadPolicy(`
rules:
  - id: r1
    match: { tool: "*" }
    action: deny
defaults: { action: prompt }
`);
  expect(p.rules[0].match.tool).toBe('*');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/loader.test.ts`
Expected: FAIL — aliases pass through unchanged and `operation` is ignored.

- [ ] **Step 3: Write the implementation**

In `loader.ts`, add near the top:

```ts
/** ACP kinds a rule's `tool` may name. */
export const POLICY_KINDS = [
  'read',
  'search',
  'edit',
  'execute',
  'fetch',
  'other',
] as const;

/**
 * Tool-name → ACP kind. The permission frame carries only a kind, so a rule
 * naming a tool is normalized to that tool's kind at load.
 *
 * The mapping is LOSSY and widening: `write_file` and `edit` share `edit`, so a
 * rule naming one also matches the other. For `deny` that is safe; for `allow`
 * it grants more than written — `policy lint` warns (Task 6).
 */
export const TOOL_ALIAS_TO_KIND: Record<string, string> = {
  read_file: 'read',
  grep_search: 'search',
  glob: 'search',
  list_directory: 'search',
  ripGrep: 'search',
  write_file: 'edit',
  edit: 'edit',
  run_shell_command: 'execute',
  web_fetch: 'fetch',
  agent: 'other',
  task: 'other',
  lsp: 'other',
};

export const POLICY_OPERATIONS = ['read', 'write', 'execute'] as const;

function normalizeTool(raw: string, ruleRef: string): string {
  if (raw === '*' || raw.includes('*')) return raw; // globs pass through
  if ((POLICY_KINDS as readonly string[]).includes(raw)) return raw;
  const mapped = TOOL_ALIAS_TO_KIND[raw];
  if (mapped) return mapped;
  throw new PolicyError(
    `${ruleRef}: unknown tool '${raw}'. The permission frame carries only an ` +
      `ACP kind, so use one of ${POLICY_KINDS.join(' | ')} (or a known tool ` +
      `name, which is mapped to its kind).`,
  );
}
```

The loader does **not** parse `match` field-by-field — it casts the whole object
(`loader.ts:144-148`: `const match = raw['match'] as Record<string, unknown>;`
then `{ match: match as PolicyRuleMatch, action: raw['action'] }`). So do the
normalization inside the `rulesRaw.map((raw, i) => …)` callback
(`loader.ts:132-164`), **after** `const match = raw['match'] …` and **before**
the `PolicyRule` is built. Use the file's existing error prefix convention,
`rule[${i}]` (as in `rule[${i}].match must be a mapping`):

```ts
if (typeof match['tool'] === 'string') {
  const originalTool = match['tool'];
  const normalizedTool = normalizeTool(originalTool, `rule[${i}]`);
  match['tool'] = normalizedTool;
  // Remember that this rule was WRITTEN as a tool-name alias, so lint (Task 6)
  // can warn precisely instead of substring-searching the source text.
  if (normalizedTool !== originalTool) rule.aliasedTool = originalTool;
}
```

Add `aliasedTool?: string;` to the `PolicyRule` interface (loader.ts:22-40), commented as "set only when `match.tool` was written as a tool name and normalized to its kind". Assign it on the `rule` object built at `loader.ts:145-148` — hold `originalTool`/`normalizedTool` in locals and assign once `rule` exists.

and add operation validation in the same place:

```ts
const operationRaw = match['operation'];
if (operationRaw !== undefined) {
  const list = Array.isArray(operationRaw) ? operationRaw : [operationRaw];
  for (const o of list) {
    if (
      typeof o !== 'string' ||
      !(POLICY_OPERATIONS as readonly string[]).includes(o)
    ) {
      throw new PolicyError(
        `rule[${i}].match.operation must be one of ` +
          `${POLICY_OPERATIONS.join(' | ')} (or a list of them)`,
      );
    }
  }
}
```

Add `operation?: string | string[];` to the `PolicyRuleMatch` interface (loader.ts:11-20).

> Use the file's existing `PolicyError` throughout so messages stay consistent with the rest of the loader.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/loader.ts packages/rc-gateway/src/policy/loader.test.ts
git commit -m "feat(rc-gateway): policy tool aliases normalize to ACP kinds; match.operation schema"
```

---

## Task 6: lint — alias widening + newly-live allow rules

**Files:**

- Modify: `packages/rc-gateway/src/policy/loader.ts` (lint output)
- Test: `packages/rc-gateway/src/policy/loader.test.ts` (add cases)

**Interfaces:**

- Consumes: `TOOL_ALIAS_TO_KIND` (Task 5), the existing `lintPolicyFile` / `formatPolicyLint` (`loader.ts:343,370`).
- Produces: warnings surfaced by `qwen-rc policy lint`.

- [ ] **Step 1: Write the failing test**

```ts
it('warns when an allow rule uses a widening tool alias', async () => {
  const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: write_file }
    action: allow
defaults: { action: prompt }
`);
  expect(warnings.join('\n')).toMatch(/write_file/);
  expect(warnings.join('\n')).toMatch(/also matches/i);
});

it('does not warn for a deny rule using the same alias', () => {
  const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: write_file }
    action: deny
defaults: { action: prompt }
`);
  expect(warnings.join('\n')).not.toMatch(/also matches/i);
});

it('reports how many allow rules are newly effective', () => {
  const warnings = lintWarningsFor(`
rules:
  - id: a
    match: { tool: read_file }
    action: allow
  - id: b
    match: { tool: execute }
    action: allow
defaults: { action: prompt }
`);
  expect(warnings.join('\n')).toMatch(/2 allow rule/);
});
```

> Define `lintWarningsFor` at the top of the test block as a thin wrapper over the pure advisory function — no temp files needed:
>
> ```ts
> import { loadPolicy, policyAdvisories } from './loader.js';
> const lintWarningsFor = (yaml: string) => policyAdvisories(loadPolicy(yaml));
> ```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/loader.test.ts`
Expected: FAIL — no such warnings exist.

- [ ] **Step 3: Write the implementation**

Add to the lint path in `loader.ts`:

```ts
/** Kinds reachable from more than one tool name — aliasing to them widens. */
function kindsWithMultipleTools(): Set<string> {
  const counts = new Map<string, number>();
  for (const kind of Object.values(TOOL_ALIAS_TO_KIND)) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
}

/**
 * Advisory warnings, not errors:
 * 1. An `allow` rule written with a tool-name alias whose kind covers other
 *    tools grants MORE than it says (e.g. `allow write_file` also allows
 *    `edit`) — the one unsafe corner of accepting aliases.
 * 2. Matching is being fixed in this release, so every `allow` rule becomes
 *    effective for the first time. Say so once, with a count.
 */
export function policyAdvisories(policy: Policy): string[] {
  const out: string[] = [];
  const shared = kindsWithMultipleTools();

  for (const rule of policy.rules) {
    if (rule.action !== 'allow') continue;
    // `aliasedTool` is set by the loader ONLY when this rule was written as a
    // tool name (Task 5) — precise, unlike scanning the raw file text.
    const written = rule.aliasedTool;
    if (written === undefined) continue;
    const kind = rule.match.tool;
    if (kind === undefined || !shared.has(kind)) continue;
    const siblings = Object.keys(TOOL_ALIAS_TO_KIND).filter(
      (n) => TOOL_ALIAS_TO_KIND[n] === kind && n !== written,
    );
    out.push(
      `rule '${rule.id ?? '(unnamed)'}': allow on '${written}' maps to kind ` +
        `'${kind}', which also matches ${siblings.join(', ')} — this allows ` +
        `more than written.`,
    );
  }

  const allowCount = policy.rules.filter((r) => r.action === 'allow').length;
  if (allowCount > 0) {
    out.push(
      `${allowCount} allow rule(s) are newly effective: rule matching was ` +
        `previously broken against real permission frames, so these have never ` +
        `auto-approved before. Verify them before relying on this policy.`,
    );
  }
  return out;
}
```

Wire it through the existing lint result shape rather than inventing a new one.
`PolicyLintResult` already carries an optional `deferred: string[]` that
`formatPolicyLint` renders (`loader.ts:363-379`); add a sibling `warnings?:
string[]` the same way:

- In `lintPolicyFile` (`loader.ts:343`), after `policy = loadPolicy(text)`
  succeeds, add `const warnings = policyAdvisories(policy);` and return it
  on the result object alongside `ruleCount`/`deferred`.
- In `formatPolicyLint` (`loader.ts:370`), append one line per warning after the
  existing `deferred` note, prefixed ` warning:`.
- Add `warnings?: string[]` to the `PolicyLintResult` interface.

Then emit the same advisory lines once at boot where the policy is loaded in
`cli.ts` — use the existing `warn` callback that `loadLayeredPolicy` already
accepts; do not add a new logging mechanism.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/loader.ts packages/rc-gateway/src/policy/loader.test.ts packages/rc-gateway/src/cli.ts
git commit -m "feat(rc-gateway): lint warns on alias widening and newly-live allow rules"
```

---

## Task 7: enforcer uses `frameToContext` (+ migrate its tests to real frames)

**Files:**

- Modify: `packages/rc-gateway/src/policy/enforcer.ts`
- Modify: `packages/rc-gateway/src/policy/enforcer.test.ts` (migrate ALL synthetic shapes)
- Modify: `packages/rc-gateway/src/cli.ts` (pass the project root)

**Interfaces:**

- Consumes: `frameToContext` (Tasks 1–2), the widened `ToolCallContext` (Task 3).
- Produces: a `PolicyEnforcer` whose constructor accepts a project-root resolver.

- [ ] **Step 1: Write the failing test**

Rewrite the frame helper in `enforcer.test.ts` to the REAL shape and add a discrimination test:

```ts
/** REAL permission_request data. The old synthetic {name,input} shape is what
 *  hid the extraction bug for nine cycles — never reintroduce it. */
function permissionEvent(
  kind: string,
  rawInput: Record<string, unknown>,
  opts: { requestId?: string } = {},
) {
  return {
    type: 'permission_request',
    data: {
      requestId: opts.requestId ?? 'q1',
      sessionId: 's1',
      toolCall: { toolCallId: 'tc1', title: 'humanized', kind, rawInput },
      options: [
        { optionId: 'always', kind: 'allow_always' },
        { optionId: 'ok', kind: 'allow_once' },
      ],
    },
  };
}

it('matches a rule against a REAL frame (kind + rawInput)', async () => {
  const policy = {
    defaults: { action: 'prompt' as const },
    rules: [
      { id: 'deny-shell', match: { tool: 'execute' }, action: 'deny' as const },
    ],
  };
  const enf = new PolicyEnforcer(
    daemon,
    policy,
    audit,
    undefined,
    () => 0,
    () => '/proj',
  );
  const handled = await enf.handlePermission(
    's1',
    permissionEvent('execute', { command: 'rm -rf /' }),
  );
  expect(handled).toBe(true);
  expect(daemon.lastResponse?.outcome).toEqual({ outcome: 'cancelled' });
});

it('matches a pathGlob rule via rawInput.file_path', async () => {
  const policy = {
    defaults: { action: 'prompt' as const },
    rules: [
      {
        id: 'deny-env',
        match: { pathGlob: ['**/.env*'] },
        action: 'deny' as const,
      },
    ],
  };
  const enf = new PolicyEnforcer(
    daemon,
    policy,
    audit,
    undefined,
    () => 0,
    () => '/proj',
  );
  const handled = await enf.handlePermission(
    's1',
    permissionEvent('edit', { file_path: '/proj/.env' }),
  );
  expect(handled).toBe(true);
});

it('leaves originScope/sessionTag unpopulated (documented limitation)', async () => {
  const policy = {
    defaults: { action: 'prompt' as const },
    rules: [
      {
        id: 'scoped',
        match: { originScope: 'write' },
        action: 'deny' as const,
      },
    ],
  };
  const enf = new PolicyEnforcer(
    daemon,
    policy,
    audit,
    undefined,
    () => 0,
    () => '/proj',
  );
  const handled = await enf.handlePermission(
    's1',
    permissionEvent('execute', { command: 'ls' }),
  );
  expect(handled).toBe(false); // no match → falls through to a human
});
```

> Migrate every remaining `{ name: ..., input: ... }` construction in this file (currently around lines 37, 163, 253) to `permissionEvent(...)`. Adjust each test's expected tool value from a tool name to its kind.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/enforcer.test.ts`
Expected: FAIL — the constructor takes no project-root argument, and the rules do not match.

- [ ] **Step 3: Write the implementation**

In `enforcer.ts`:

(a) Add the resolver to the constructor (keep every existing parameter and its order; append):

```ts
    private readonly projectRootFn: () => string = () => process.cwd(),
```

(b) Replace the extraction block (lines 95-101 and 117) with:

```ts
const requestId = readString(data, 'requestId');
const approveOptionId = selectAllowOnceOptionId(data['options']);
// ... nowMs / oracle as before ...
const ctx = frameToContext(event.data, {
  projectRoot: this.projectRootFn(),
});
const d = evaluate(this.policy, ctx, now, oracle);
```

and add `import { frameToContext } from './frameContext.js';`. Delete the now-unused `readRecord`-based tool/args derivation (and the `readRecord` import if nothing else uses it).

(c) In `cli.ts`, pass the project root where `PolicyEnforcer` is constructed, reusing the already-resolved workspace cwd:

```ts
const enforcer = notifier
  ? new PolicyEnforcer(
      handle.daemon,
      policy,
      audit,
      quota,
      Date.now,
      () => workspaceCwdForPolicy ?? process.cwd(),
    )
  : undefined;
```

> Use whichever variable already holds the daemon workspace cwd at that point in `cli.ts` (the same value that selects the workspace policy layer). If it is resolved later than the enforcer, keep the closure so it is read lazily rather than reordering boot.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/` and `npx tsc --noEmit -p tsconfig.json`
Expected: all policy tests PASS; no NEW tsc errors versus the ~9 pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/enforcer.ts packages/rc-gateway/src/policy/enforcer.test.ts packages/rc-gateway/src/cli.ts
git commit -m "fix(rc-gateway): enforcer reads real permission frames via frameContext"
```

---

## Task 8: keep `policy explain` / `policy lint` working

**Files:**

- Modify: `packages/rc-gateway/src/policy/explain.ts`
- Test: `packages/rc-gateway/src/policy/explain.test.ts` (add a case)

**Interfaces:**

- Consumes: the widened `ToolCallContext` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
it('explains a pathGlob rule from --path', () => {
  const policy = {
    defaults: { action: 'prompt' as const },
    rules: [
      {
        id: 'deny-env',
        match: { pathGlob: ['**/.env*'] },
        action: 'deny' as const,
      },
    ],
  };
  const ex = explainPolicy(policy, {
    tool: 'edit',
    args: {},
    paths: ['/proj/.env'],
    projectRoot: '/proj',
    cwd: '/proj',
  });
  expect(ex.decision.action).toBe('deny');
  expect(ex.traces.find((t) => t.ruleId === 'deny-env')?.status).toBe(
    'matched',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/policy/explain.test.ts`
Expected: FAIL if `explain.ts` still builds a context without `paths` (its `--path` flag previously fed `args`).

- [ ] **Step 3: Write the implementation**

In `explain.ts`'s flag→context construction (around lines 70-80), set `paths` from `--path` and default the roots:

```ts
const ctx: ToolCallContext = {
  tool,
  projectRoot: process.cwd(),
  cwd: process.cwd(),
};
if (flags['path'] !== undefined) ctx.paths = [flags['path']];
if (flags['args'] !== undefined) ctx.args = parseArgsFlag(flags['args']);
if (flags['scope'] !== undefined) ctx.originScope = flags['scope'];
if (flags['tag'] !== undefined) ctx.sessionTag = flags['tag'];
```

Keep the file's existing `--args` parsing and its documented caveat comment (explain.ts:28-36) intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/policy/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/policy/explain.ts packages/rc-gateway/src/policy/explain.test.ts
git commit -m "fix(rc-gateway): policy explain supplies paths for the widened context"
```

---

## Task 9: documentation

**Files:**

- Modify: `packages/rc-gateway/docs/walkthrough.md`

- [ ] **Step 1: Correct the policy path**

`walkthrough.md:235` tells the reader to create `~/.config/qwen-rc/policy.yaml`, a path **no code reads**. Change it (and any nearby prose) to `~/.qwen/rc/policy.yaml`, and mention the workspace layer at `<workspaceCwd>/.qwen/policy.yaml`.

- [ ] **Step 2: Rewrite the example policy for the real semantics**

Replace the example (walkthrough.md:237-248) with one that reflects kind-based matching, and add a short section documenting:

```yaml
defaults:
  action: prompt
rules:
  # `tool` is the ACP kind: read | search | edit | execute | fetch | other.
  # A known tool name (e.g. run_shell_command) is accepted and mapped to its
  # kind — note that mapping is lossy: write_file and edit share `edit`.
  - id: allow-reads
    match: { tool: read }
    action: allow

  # pathGlob matches every path the call touches, INCLUDING paths a shell
  # command reads or writes, so this also blocks `cat .env`.
  - id: deny-dotenv
    match: { pathGlob: ['**/.env*'] }
    action: deny
    reason: secrets

  # operation narrows to read | write | execute.
  - id: deny-writes-to-config
    match: { pathGlob: ['**/config/**'], operation: write }
    action: deny
```

- [ ] **Step 3: Document the behavior change prominently**

Add a clearly-marked note stating that rule matching was previously broken against real permission frames — so `tool:` and `pathGlob:` rules never matched — and that after this change **deny rules begin blocking and allow rules begin auto-approving for the first time**. Tell the reader to run `qwen-rc policy lint <file>` to see which allow rules are newly effective, and note that `write_file`/`edit` (and the other shared kinds) cannot be distinguished remotely.

- [ ] **Step 4: Commit**

```bash
git add packages/rc-gateway/docs/walkthrough.md
git commit -m "docs(rc-gateway): correct policy path; document kind matching and the activation change"
```

---

## Self-review checklist (run before the final review)

- Spec coverage: OpenSpec change (T0) · frameContext (T1, T2) · picomatch pathGlob + ctx.paths (T3) · `match.operation` (T4) · tool aliases + operation schema (T5) · lint warnings (T6) · enforcer + real-frame tests (T7) · explain/lint still work (T8) · docs + activation note (T9). The design's `originScope`/`sessionTag` exclusion is pinned by a test in T7 and stated in T0's spec delta.
- No placeholders; every code step shows real code.
- Type consistency: `FrameContext`/`PolicyOperation`/`PATH_PARAM_KEYS` (T1) are used unchanged in T2/T3/T7; `TOOL_ALIAS_TO_KIND`/`POLICY_OPERATIONS` (T5) are used unchanged in T6.
- No `packages/core` or `packages/cli` edits anywhere.
- No test anywhere constructs the synthetic `{ name, input }` toolCall shape.
