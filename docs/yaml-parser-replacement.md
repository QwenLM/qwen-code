# YAML parser replacement — research findings

Internal design document for replacing the hand-rolled 192-line YAML parser at
`packages/core/src/utils/yaml-parser.ts` with a real library, so the deferred
`mcpServers` and `hooks` fields from Claude Code's declarative-agent schema can
round-trip safely through subagent / skill / converter code paths.

Companion to [`docs/declarative-agents-port.md`](./declarative-agents-port.md).
Issue: [#4821](https://github.com/QwenLM/qwen-code/issues/4821). Prereq for
the follow-up to [PR #4842](https://github.com/QwenLM/qwen-code/pull/4842).

## Phase 0 — Sources verified

| Source                                                  | Version / Date                         | Why authoritative                                                                                                               |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `~/code/claude-code/src/utils/yaml.ts`                  | older CC snapshot (pre-2.1.168)        | direct source — 15-line wrapper that names the library                                                                          |
| `~/code/claude-code/src/utils/frontmatterParser.ts`     | same snapshot                          | direct source — 370-line frontmatter splitter + 2-pass recovery                                                                 |
| `/private/tmp/cc-2.1.168/claude.strings`                | extracted from CC 2.1.168              | authoritative for current behavior — strings carry obfuscated symbol names but contain the JSON schema and error message text   |
| `packages/core/src/utils/yaml-parser.ts` (this repo)    | HEAD of `lazzy/gifted-hamilton-684741` | the parser being replaced                                                                                                       |
| live `node -e` probes against `yaml@2.8.1` in this tree | 2026-06-08                             | empirical security behavior — anchors, merge keys, `!!js/function`, billion-laughs, `maxAliasCount` (results inline in Phase 4) |

Confidence labels: **C** confirmed by direct evidence; **I** inferred from
multiple confirmed facts; **O** open question.

## Phase 1 — Which YAML library does CC use?

**Answer: [`yaml`](https://www.npmjs.com/package/yaml) (eemeli/yaml), NOT
`js-yaml`.** Confirmed by reading `~/code/claude-code/src/utils/yaml.ts`
verbatim:

```ts
export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input);
}
```

- **Library**: `yaml` npm package. **C**
- **API**: top-level `.parse(input)`. Uses the package's default schema (which
  is YAML 1.2 `core` — JSON-superset, no JS extensions). **C**
- **Bun shortcut**: when running under Bun, CC uses `Bun.YAML.parse()` to
  avoid bundling ~270 KB of YAML parser. **C** Not relevant to qwen-code
  (we don't target Bun runtime).
- **Schema mode**: NOT explicitly set anywhere in CC. Relies on `yaml`
  package's default behavior, plus zod validation at the consumer layer
  (`DL7`, `gS8`, `TKO`/`_u` per `docs/declarative-agents-port.md`). **C**

### Why `yaml` rather than `js-yaml`

| Dimension                | `js-yaml` 4.x                                                                              | `yaml` (eemeli) 2.x                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Default schema           | `DEFAULT_SAFE_SCHEMA` (since 4.x) — safe; older versions had `DEFAULT_FULL_SCHEMA` with JS | `core` (YAML 1.2 spec) — JSON types only             |
| `!!js/function` tag      | NOT supported in 4.x (was in 3.x)                                                          | Never supported                                      |
| Billion-laughs guard     | None (manual responsibility)                                                               | Built-in `maxAliasCount: 100` default                |
| Merge keys (`<<`)        | Supported (must opt-out via `MERGE_SCHEMA` or filtering)                                   | Disabled by default, opt-in via `{ merge: true }`    |
| Already a qwen-code dep? | `js-yaml@4.1.1` ✓                                                                          | `yaml@2.8.1` ✓ (already imported by `skill-manager`) |

Both are reasonable choices in 2026, but **the original task brief
recommended `js-yaml`'s `FAILSAFE_SCHEMA` / `CORE_SCHEMA`**. We are deviating
from that guidance for three concrete reasons:

1. **CC parity**. The whole point of porting CC's frontmatter schema is to
   let users drop a CC agent file into `.qwen/agents/` and have it parse
   identically. Using the same parser CC uses minimizes drift on edge-case
   YAML constructs (multi-doc streams, flow vs block scalars, tag handling).
2. **`yaml` is already a direct user inside `skill-manager.ts`** — see
   `packages/core/src/skills/skill-manager.ts:13` (`import * as yaml from 'yaml'`).
   Standardizing on `yaml` eliminates one of two duplicate YAML stacks in
   the same package. **C** (grep result documented in Phase 6).
3. **Safer defaults than `js-yaml`**. `yaml`'s built-in `maxAliasCount` blocks
   billion-laughs without manual configuration; merge keys are disabled by
   default; arbitrary tags become literal strings with a `YAMLWarning` rather
   than triggering callable resolvers. Empirical evidence in Phase 4.

If a future maintainer wants to drop the `yaml` dependency and unify on
`js-yaml`, the migration is mechanical: replace `yaml.parse` / `yaml.stringify`
with `jsYaml.load(s, { schema: jsYaml.CORE_SCHEMA })` / `jsYaml.dump`. The
two libraries agree on output for the 100% subset that CC and qwen-code
actually use (key-value pairs, lists, nested maps, scalar booleans/numbers).
Track that decision separately if it comes up.

## Phase 2 — Frontmatter parsing pipeline (CC)

`~/code/claude-code/src/utils/frontmatterParser.ts` is 370 lines. Key
findings:

| Step                | Logic                                                                                                                     | Source                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Delimiter match     | Regex `/^---\s*\n([\s\S]*?)\n---\s*\n?/` — opens at column 0, body is non-greedy, closing `---` must be on its own line   | `frontmatterParser.ts:~123` (line numbers from old snapshot; treat as approximate) **C**               |
| Pass 1 parse        | Call `parseYaml(body)`. If success → return parsed object + content remainder.                                            | same file, top of try block **C**                                                                      |
| Pass 2 recovery     | On `YAMLException`, walk lines, auto-quote values that look like dates/colons/specials, retry `parseYaml` once.           | lines ~85–121 in old snapshot **C** (`tab → 2 spaces` normalisation, ISO-date heuristic, colon-trap)   |
| Failure fallthrough | Both passes failed → log via `logForDebugging`, return `{ data: {}, content: text }`. Agent loads with empty frontmatter. | end of function **C**                                                                                  |
| Telemetry           | Wrapped further upstream — `tengu_frontmatter_shadow_unknown_key` / `_mismatch` events fire from `ug5.agent` (Ig5 schema) | `claude.strings:308120`, `309074`, `309076` (cross-cited in `docs/declarative-agents-port.md` Phase 1) |

**Implication for qwen-code**: we do NOT need to clone the 2-pass recovery.
qwen-code's `subagent-manager.ts` already enforces stricter "throw on malformed
frontmatter at top level" semantics for its loader (see `parseSubagentContent`),
and the 2-pass recovery is specifically there to forgive old hand-edited CC
agent files. Porting a stricter posture is fine; we just need to **not crash
the whole loader** when nested fields are malformed. See Phase 5 for the
warn-and-drop posture.

## Phase 3 — Nested validation via zod (CC)

The relevant CC validators per `docs/declarative-agents-port.md` Phase 1 +
binary strings cross-check:

### `mcpServers` (CC symbol `gS8` / JSON-shadow `jL7`)

```
mcpServers: z.union([
  z.string(),                                            // server name reference
  z.record(z.string(), McpServerConfigSchema()),         // inline { name: spec }
])
```

`McpServerConfigSchema()` (from `claude.strings:124–135` ref) is a
**discriminated union** over `type`:

| `type`             | Required fields                      | Notes                                              |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| `"stdio"`          | `command: string`, `args?: string[]` | Plus `env?: Record<string,string>`, `cwd?: string` |
| `"sse"`            | `url: string`                        | Plus `headers?: Record<string,string>`             |
| `"http"`           | `url: string`                        | Plus `headers?`, `method?`                         |
| `"websocket"`      | `url: string`                        | qwen-code parity unknown — defer until needed      |
| `"sdk"`            | varies                               | Internal CC use; we do NOT need to support         |
| `"claudeai-proxy"` | varies                               | Internal CC use; we do NOT need to support         |

**For qwen-code v1**: validate as `Record<string, unknown>` (lenient
DL7-style), and let the downstream merge into `Config.getMcpServers()` do the
shape coercion. `qwen-code` already has `MCPServerConfig` class with
`type` discrimination — we reuse that converter instead of duplicating the
zod schema. See Phase 4 of the runtime-wiring plan in
`docs/declarative-agents-port.md`.

### `hooks` (CC symbol `TKO` / `_u`)

```
hooks: Partial<Record<HookEvent, HookMatcher[]>>
HookMatcher: { matcher?: string, hooks: HookConfig[] }
HookConfig (discriminated union on `type`):
  - { type: 'command', command: string, timeout?: number, ... }
  - { type: 'prompt',  prompt: string, ... }
  - { type: 'agent',   agent: string, ... }
  - { type: 'http',    url: string, headers?, ... }
```

The hook-event keys per the strings cross-check are the same set qwen-code
already supports: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
`SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`,
`Notification` — plus a few qwen-only events (`TodoCreated`, `TodoCompleted`)
that CC does not have.

**For qwen-code v1**: validate as `Record<string, unknown>` (lenient), then
hand off to qwen-code's existing `SessionHooksManager` validators, which
already implement the `HookDefinition[]` per-event shape (see
`packages/core/src/hooks/types.ts:207–211` per the Phase-1 runtime mapping).

### Why both validators are `z.unknown()` at the `Ig5` shadow level

`Ig5` is the **telemetry shadow schema** — it fires
`tengu_frontmatter_shadow_unknown_key` events when a YAML key isn't in the
known set, and `_mismatch` events when a known key has the wrong type. It
deliberately uses `z.unknown()` for `mcpServers` and `hooks` because
**`Ig5` runs at PARSE time** and would emit spurious mismatch events for
every inline mcpServers spec. The real validation is delegated to:

- `gS8` (for `mcpServers`) — called **at agent registration time** from
  `DL7` per-item `safeParse`
- `TKO` (for `hooks`) — called **at hook firing time** from `_u().safeParse`

This **lazy validation** is the model qwen-code should mimic: keep the
frontmatter parser permissive (`z.unknown()` equivalent in TS), validate at
the point of use. Trying to bring the full zod tree forward into
`SubagentConfig` would force us to also import qwen's `MCPServerConfig` class
and `HookDefinition` type into a layer where they don't currently live, and
would require us to invent fake validators for `type: 'sdk'` /
`type: 'claudeai-proxy'` which we don't actually support.

## Phase 4 — Security posture

Empirical verification of `yaml@2.8.1` defaults in this qwen-code tree:

### Probe results

```
$ node -e "const y=require('yaml'); console.log(y.parse('a: 1').constructor.name, y.parseDocument('a: 1').schema?.name)"
Object core
```

→ default schema is `'core'` (YAML 1.2 JSON-superset). **C**

```
$ node -e "const y=require('yaml'); console.log(y.parse('!!js/function \"function(){}\"'))"
function(){}
(node:18525) [TAG_RESOLVE_FAILED] YAMLWarning: Unresolved tag: tag:yaml.org,2002:js/function
```

→ `!!js/function` tag does NOT execute. The value resolves to the **literal
string** `"function(){}"` (not a callable function object), and emits a
non-fatal `YAMLWarning`. Adversary cannot achieve RCE via this vector. **C**

```
$ node -e "const y=require('yaml'); const bomb = 'a: &a [hi,hi]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]'; try { y.parse(bomb) } catch(e){ console.log('REJECTED:', e.message) }"
REJECTED: Excessive alias count indicates a resource exhaustion attack
```

→ alias-expansion / billion-laughs is REJECTED **by default**. The library
ships with `maxAliasCount: 100` (the failed parse counts 1+10+100 = 111
aliases). **C**

```
$ node -e "const y=require('yaml'); console.log(JSON.stringify(y.parse('defaults: &d\n  a: 1\nfoo:\n  <<: *d\n  b: 2')))"
{"defaults":{"a":1},"foo":{"<<":{"a":1},"b":2}}
```

→ merge key (`<<`) is parsed as a **literal key string** by default, NOT
expanded. The `<<` parser is opt-in via `{ merge: true }`. We will NOT
enable it. **C**

```
$ node -e "const y=require('yaml'); const yml='mcpServers:\n  filesystem:\n    type: stdio\n    command: node\n    args:\n      - /path/to/server.js'; console.log(JSON.stringify(y.parse(yml), null, 2))"
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "node", "args": ["/path/to/server.js"] }
  }
}
```

→ CC-shape nested mcpServers parses correctly into deeply-nested
object/array. **C**

### Safety summary

| Vector                         | `yaml@2.8.1` default              | Action needed in qwen-code                             |
| ------------------------------ | --------------------------------- | ------------------------------------------------------ |
| Arbitrary JS execution         | Impossible — no eval              | None                                                   |
| `!!js/function` tag            | Becomes literal string + warning  | None                                                   |
| Billion laughs                 | Rejected (`maxAliasCount: 100`)   | None — keep default                                    |
| Merge keys (`<<`)              | Treated as literal key            | None — keep default (do NOT pass `merge: true`)        |
| Anchors / aliases (normal use) | Allowed, useful for CC-shape data | None                                                   |
| Arbitrary unknown tags         | String + `YAMLWarning`            | Optionally redirect warnings to a logger (see Phase 6) |

**Conclusion**: `yaml` package's stock behavior is already safer than what
the original task brief asked for via `js-yaml`'s `FAILSAFE_SCHEMA`. No
schema lockdown call is required.

## Phase 5 — Recovery semantics

CC chooses **graceful warn-and-drop** at every layer:

1. YAML parser throws → frontmatter parser logs + returns `{}` (empty data)
2. Field has wrong shape (e.g., `mcpServers: "this is a string"`) → `safeParse`
   fails → field is dropped from the emitted config
3. Field has _nearly_ wrong shape (e.g., individual `mcpServers` item is a
   string when the schema wants an object) → per-item `safeParse` drops just
   that item, keeps the rest

qwen-code already implements the per-field warn-and-drop posture for
`permissionMode`, `maxTurns`, `color`, `effort` (see
`packages/core/src/subagents/agent-frontmatter-schema.ts`). We extend the same
pattern to `mcpServers` and `hooks`.

What we DO NOT clone from CC:

- **2-pass YAML recovery with auto-quoting**. This is dead weight for
  qwen-code — we're a new project, no legacy hand-edited frontmatter files
  to forgive. A clean error is more useful than a guessed reinterpretation.
- **`tengu_*` telemetry events**. Replaced by qwen-code's own logger /
  whatever telemetry layer the rest of the loader uses.

## Phase 6 — Recommendation for qwen-code

### Library choice

- **Use `yaml@^2.8.1`** (already a transitive — promote to a direct
  `packages/core/package.json` dep so we don't break under stricter resolution
  modes; also lets us pin the major).
- **Use default schema** (`core`), no schema flag.
- **Do not** pass `{ merge: true }`. Do not enable any non-default option.
- For deterministic stringify output (test snapshots), pass
  `{ lineWidth: 0, defaultStringType: 'PLAIN' }` to `yaml.stringify` so the
  library doesn't wrap long lines or arbitrarily switch to block-scalar
  quoting based on content length.

### API surface to preserve

Current `packages/core/src/utils/yaml-parser.ts` exports:

```ts
export function parse(yamlString: string): Record<string, unknown>;
export function stringify(
  obj: Record<string, unknown>,
  options?: { lineWidth?: number; minContentWidth?: number },
): string;
```

The replacement keeps both signatures **identical** so the 5 callers
(`subagent-manager.ts`, `claude-converter.ts`, `rulesDiscovery.ts`,
`skill-manager.ts`, `skill-load.ts`) and the `index.ts` re-export require
zero call-site changes.

Implementation sketch:

```ts
import * as yaml from 'yaml';

export function parse(yamlString: string): Record<string, unknown> {
  const parsed = yaml.parse(yamlString);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function stringify(
  obj: Record<string, unknown>,
  options?: { lineWidth?: number; minContentWidth?: number },
): string {
  return yaml.stringify(obj, {
    lineWidth: options?.lineWidth ?? 0,
    minContentWidth: options?.minContentWidth ?? 20,
  });
}
```

**Why coerce non-object top-levels to `{}`**: every existing caller assumes a
record. A YAML file that parses to `null` (empty file), `["foo"]` (a list),
or `"hello"` (a bare scalar) would currently crash downstream destructuring.
Returning `{}` preserves the old hand-rolled parser's behavior on the same
inputs. Document this as a deliberate guardrail in a one-line comment.

### Callers that need no changes

| File                                                 | Usage                                                                | Compatible?                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/core/src/index.ts:360`                     | re-exports `*` from yaml-parser                                      | yes — same names                                                         |
| `packages/core/src/subagents/subagent-manager.ts:15` | `parse`, `stringify`                                                 | yes                                                                      |
| `packages/core/src/extension/claude-converter.ts:26` | `parse`, `stringify`                                                 | yes — round-trip is now safe for `mcpServers` + `hooks` (see Phase 3)    |
| `packages/core/src/utils/rulesDiscovery.ts:20`       | `parse as parseYaml`                                                 | yes                                                                      |
| `packages/core/src/skills/skill-manager.ts:13`       | `parse as parseYaml` (and `import * as yaml from 'yaml'` separately) | yes — and the duplicate `import * as yaml` can be removed in a follow-up |
| `packages/core/src/skills/skill-load.ts:11`          | `parse as parseYaml`                                                 | yes                                                                      |

### Test fixtures needed

Three concrete YAML snippets that the current hand-rolled parser fails on
and the replacement must handle (one per nested shape):

```yaml
# Fixture 1 — mcpServers (record of records)
mcpServers:
  filesystem:
    type: stdio
    command: node
    args:
      - /path/to/server.js
    env:
      DEBUG: '1'
  github:
    type: http
    url: https://mcp.example.com/github
    headers:
      Authorization: 'Bearer xxx'
```

```yaml
# Fixture 2 — hooks (record of arrays of records, two levels of nesting under the event name)
hooks:
  PreToolUse:
    - matcher: 'Read|Write'
      hooks:
        - type: command
          command: echo before
          timeout: 5000
  PostToolUse:
    - matcher: '*'
      hooks:
        - type: command
          command: echo after
```

```yaml
# Fixture 3 — mixed shallow + deep, plus everything PR #4842 already supports
name: agent-x
description: test
permissionMode: acceptEdits
maxTurns: 5
color: cyan
tools:
  - Read
  - Write
mcpServers:
  filesystem:
    type: stdio
    command: node
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: log
```

### Tests that must change

`packages/core/src/utils/yaml-parser.test.ts` has 2 "pin tests" at the
bottom (lines 200–227) titled `known limitations — nested YAML (pin until
js-yaml lands)`. The replacement MUST flip those into positive-form
nested-parsing assertions:

```ts
it('parses array-of-records', () => {
  const yaml =
    'mcpServers:\n  - filesystem:\n      type: stdio\n      command: node';
  expect(parse(yaml)).toEqual({
    mcpServers: [{ filesystem: { type: 'stdio', command: 'node' } }],
  });
});

it('parses record-of-records', () => {
  const yaml = 'hooks:\n  PreToolUse:\n    - matcher: Read';
  expect(parse(yaml)).toEqual({
    hooks: { PreToolUse: [{ matcher: 'Read' }] },
  });
});
```

These two assertions plus the three fixtures above are the **acceptance
gate** for Phase 2 of the implementation plan. Anything else (escaping
edge cases, quoted-vs-unquoted booleans, numeric strings) is regression
coverage from the existing test suite and should pass unchanged.

### Round-trip parity check

Existing test `should maintain round-trip integrity for escaped strings`
(line 111-129) exercises 7 strings through `stringify → parse`. `yaml`'s
default `stringify` produces slightly different output than the hand-rolled
formatter (more aggressive quoting in some cases, different escape sequences).
Two acceptable outcomes:

1. **Adjust the test fixtures** to assert behavior under the new parser
   — the round-trip property (`parse(stringify(x)) === x`) is what matters,
   not byte-identical YAML output.
2. **Leave the bytewise-identical assertions** and let them fail visibly,
   then update them to reflect `yaml`'s output verbatim. Easier to review
   diff.

Recommendation: **option 1** — change the assertions to property-based
(`expect(parse(stringify(obj))).toEqual(obj)`) since byte-identical YAML
output is not a documented contract of the module.

### Breaking changes for callers — none expected, but verify

- `subagent-manager.ts` re-serializes the parsed object back to YAML for
  the `saveSubagent` path. With the new parser, `mcpServers` and `hooks`
  will round-trip cleanly. Update `NESTED_FIELDS_NOT_ROUND_TRIPPABLE` in
  `claude-converter.ts` (Phase 3 of the implementation) to drop these
  two field names.
- `skill-manager.ts` already imports `yaml` directly (separate from the
  hand-rolled parser). Once `yaml-parser.ts` is also using `yaml`, the
  duplicate import is removable as a tiny follow-up — out of scope here.

### Migration risk

Low. The 5 callers all destructure a `Record<string, unknown>` — same return
type. The 2 deliberate "garbles" pin tests are the only failures expected;
they're known and we flip them on purpose. Wider regression coverage comes
from the existing test suites in `packages/core/src/subagents/`,
`packages/core/src/skills/`, and `packages/core/src/extension/`.

## Open questions

| #   | Question                                                                                                                                              | Blocking?                                                               | Resolution path                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Does `yaml.parse` need an explicit logger to redirect `YAMLWarning` (e.g., `Unresolved tag`) to qwen-code's logger instead of `process.emitWarning`?  | No — defer                                                              | If logs get noisy in CI, plumb `{ logLevel: 'silent' }` or a custom `onWarning` callback. Not load-bearing for v1.                                                      |
| Q2  | Should `parse()` continue to return `{}` for empty-string / null-document YAML, or throw?                                                             | No — preserve current behavior                                          | Current hand-rolled returns `{}`; we keep that. Add a regression test pinning the choice.                                                                               |
| Q3  | When `mcpServers` is malformed at the top level (e.g., `mcpServers: "string"`), should the whole agent fail to load, or load with that field dropped? | Yes — drives the warn-and-drop posture in Phase 3 of the implementation | **Resolution**: drop the field, emit a console warning (parity with CC `DL7` per Phase 3 of `docs/declarative-agents-port.md`).                                         |
| Q4  | Same as Q3 but for `hooks`: drop the field, the event, or just the individual matcher?                                                                | Yes — drives the warn-and-drop posture                                  | **Resolution**: drop the whole `hooks` field on top-level shape failure. Per-event / per-matcher granularity is deferred to a future PR if a real user surfaces a need. |
| Q5  | Does the `Bun.YAML.parse` shortcut from CC's helper apply to qwen-code?                                                                               | No                                                                      | qwen-code does not target Bun runtime. Skip.                                                                                                                            |

---

**Status**: research complete, ready to implement Phase 2 (replace
`yaml-parser.ts`) and Phase 3 (re-surface `mcpServers` + `hooks` on
`SubagentConfig`) per `docs/declarative-agents-port.md`.
