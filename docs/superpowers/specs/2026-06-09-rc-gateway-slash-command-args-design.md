# Design — rc-gateway slash-command `args:` validation (cycle 28, add-custom-slash-commands)

**Proposal:** `add-custom-slash-commands` (core loader + invoke done cycle 20;
this adds declared-argument validation).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Honor a command's optional `args:` front-matter declaration — an array of
`{ name, required, default? }` — so a command author can require and default its
inputs. A required, defaulted-less, absent arg makes the invoke fail-fast with
`400`; a declared arg with a `default` is auto-filled when absent. Also surface
`slash_command_parse_failed` for malformed command files (the loader silently
skipped them before).

## Deviation note

The proposal's loader/validation lives in the daemon; cycle 20 delivered it
gateway-side (loader + `/rc/commands` + `/rc/session/:id/command/:name`). This
slice extends that gateway loader and route; the daemon stays unmodified. The
`tool:` direct-invoke path remains blocked (no SDK direct-tool API) and so its
`args`-as-tool-argv shaping is out of scope.

## Decisions

### D1 — Declared `args` validate the POSITIONAL `args`, not `named`

The proposal is explicit that the open question is enforced-vs-advisory, but
treats the _positional_ reading as settled, and the text converges on it:

- the front-matter field `args` shares its name with the invoke body's
  **positional** `args` array ("if omitted, args are pass-through" refers to that
  array);
- the design's own example declares `args: [{name: issue, required: true}]` and
  supplies it positionally (`args: ["1234"]`), using `named: {...}` only for
  `--flag` modifiers;
- `named` is explicitly defined as "value of a `--foo` flag" — modeling a
  required core input as a flag is the unnatural reading.

So a declaration at index `i` constrains positional `args[i]`; `name` is just the
label used in errors/audit. `${arg}` / `${arg.N}` are what get validated.
`named` is unaffected (still pass-through, referenced by `${named.KEY}`).

### D2 — Enforced: missing required arg → 400, daemon NOT called

Per the proposal's leaning (open-Q1). For each declaration in order, the
positional value is "present" when `args[i]` is a non-empty string. If absent:

- a `default` (when declared) is padded into the positional array at `i` →
  treated as present, substitution sees it via `${arg}`/`${arg.N}`;
- otherwise if `required` → the arg is **missing**.

If any declared args are missing, the route audits `slash_command_arg_missing`
`{ name, missing: [names] }` and returns `400 { code: 'missing_required_args' }`
WITHOUT calling `daemon.prompt`. `required` absent defaults to `false`; a present
`default` makes the arg non-missing regardless of `required` (a required arg that
also has a default is an author quirk, not an error — the present default simply
satisfies it).

**Scoped OUT (intentionally):** auditing every empty _undeclared_ `${named.x}` /
`${arg.N}` placeholder (the proposal mentions empty-placeholder substitution at
line ~109). That is noisy and a separate concern; this slice repurposes
`slash_command_arg_missing` ONLY for the enforced declared-arg 400 path.
Undeclared placeholders keep resolving to empty string silently (cycle 20).

### D3 — `slash_command_parse_failed` only for front-mattered-but-invalid files

The loader currently returns `null` (silently skips) for any unparseable command
file. The proposal wants bad files audited so the palette degrades visibly. We
emit `slash_command_parse_failed { file, source, reason }` **only when
`parseFrontMatter` SUCCEEDS but field validation fails** (bad name/description/
scope/args). A plain `.md` with no `---` front-matter is not a command file at
all and stays silently skipped (no audit, no noise). Detail carries the filename

- a short reason token — never file content.

### D4 — `args` front-matter schema + total parse

`args` absent → `undefined` (pass-through, unchanged). Present must be an array;
each element a mapping with `name` (string matching `^[a-zA-Z][a-zA-Z0-9_-]{0,31}$`),
optional `required` (boolean), optional `default` (string). Any malformed shape
→ the whole command file is rejected (D3 parse_failed). Unknown element keys are
ignored (forward-compat).

### D5 — Fail-safe wiring order

- **Commit 1 (loader, additive/inert):** parse + validate `args` into
  `LoadedCommand.args`; emit `slash_command_parse_failed`. The invoke route does
  not yet read `cmd.args`, and a command with no `args` is unchanged — so a
  mid-cycle cut leaves the loader carrying an unused field + a harmless new audit.
- **Commit 2 (route enforcement):** validate/default declared args at invoke
  (400 path), and surface `args` in the `GET /rc/commands` listing.

## Files

- `src/commands/loader.ts`: `ArgDecl` type; `LoadedCommand.args?`; parse/validate
  `args`; thread the filename into `parseCommandFile` and emit
  `slash_command_parse_failed` on validation failure.
- `src/commands/loader.test.ts`: args parse (valid/defaults/required-default;
  malformed→reject+parse_failed; no front-matter→silent skip).
- `src/auditLog.ts`: add `slash_command_parse_failed`, `slash_command_arg_missing`.
- `src/routes/commands.ts`: declared-arg validation + default padding before
  `substitute`; 400 `missing_required_args` + `slash_command_arg_missing` audit;
  add `args` to the GET listing.
- `src/routes/commands.route.test.ts` (or commands test): missing required → 400
  - audit + daemon NOT called; default auto-filled; provided value used; no-args
    command unchanged; listing exposes `args`.

## Verification

- vitest (loader + route), typecheck/lint/build, `node scripts/rc-gateway-e2e.mjs`
  (the e2e fixture command has no `args` → stays green; optionally assert a
  missing-required-arg 400 if cheap). `git diff --name-only` → gateway + docs only.

## Deferred (NOT in this slice)

`tool:` direct invoke (no SDK API), the file watcher / 250 ms debounce,
`X-Commands-Revision` ETag, `sessionScope: none` (workspace-level invoke),
auditing undeclared empty placeholders, `${file}` server-side resolution, and
the `slash_command_prompt_submitted` resolved-text audit variant.
