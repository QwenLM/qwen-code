# Plan — slash-command args validation (cycle 28)

Spec: `../specs/2026-06-09-rc-gateway-slash-command-args-design.md`. TDD, two
commits, loader-inert first.

## Commit 1 — loader parses + validates `args` (+ parse_failed audit)

1. `auditLog.ts`: add `slash_command_parse_failed`, `slash_command_arg_missing`
   to the union + AUDIT_ACTIONS.
2. `loader.ts`:
   - `export interface ArgDecl { name: string; required: boolean; default?: string }`.
   - `LoadedCommand.args?: ArgDecl[]`.
   - `parseArgDecls(raw): ArgDecl[] | null` — null = invalid (array of objects;
     name regex; required boolean→default false; default string).
   - thread `file` into `parseCommandFile(text, source, file)`; on any validation
     failure where front-matter parsed, `audit.record({action:
'slash_command_parse_failed', detail:{file, source, reason}})` then return
     null. No audit when `parseFrontMatter` returned null (not a command file).
3. `loader.test.ts`: valid args parsed; defaults/required captured; malformed
   args (`args: 7`, non-object element, bad name, non-bool required, non-string
   default) → command skipped + parse_failed audit with {file,source}; a bad
   `scope` also emits parse_failed; a no-front-matter `.md` → skipped, NO audit.
4. typecheck/lint/build/test. Commit:
   `feat(rc-gateway): loader parses slash-command args decls + parse_failed audit`

## Commit 2 — route enforces declared args

5. `routes/commands.ts`:
   - after scope check, build `resolvedArgs = [...args]`; for each decl `d` at
     index `i`: if `resolvedArgs[i]` is null/'' → if `d.default !== undefined`
     set `resolvedArgs[i] = d.default` else if `d.required` push `d.name` to
     `missing`.
   - if `missing.length` → audit `slash_command_arg_missing {name, missing}` +
     400 `missing_required_args`, return (daemon NOT called).
   - `substitute(cmd.body, { args: resolvedArgs, named, file })`.
   - GET listing: add `args: c.args ?? null`.
6. route test: declared required missing → 400 + audit + daemon.prompt NOT
   called (spy/fake daemon); default auto-fills (provided body omits it, prompt
   text contains the default); provided value overrides default; command with no
   args unchanged (back-compat); GET lists `args`.
7. typecheck/lint/build/test + e2e. Commit:
   `feat(rc-gateway): /rc/session/:id/command enforces declared args (400 on missing)`

## Then

opus review (positional-vs-named correctness, default/required edge cases,
parse_failed scoping, no-daemon-on-400, privacy of audit detail) → fix → push →
update both memory files.
