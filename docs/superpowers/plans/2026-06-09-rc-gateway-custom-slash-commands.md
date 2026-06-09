# Plan — rc-gateway custom slash commands (cycle 20, part 1)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-custom-slash-commands-design.md`.

**Branch:** `add-remote-control-spec` — stay on it; do NOT create a
branch. Run all commands from the repo root `/home/evan/projects/qwen-code`
with absolute paths. Strict TDD: red → green → refactor, one commit per
task, no `--no-verify`. License header on every new `src/*.ts` (copy the
`@license`/Copyright 2025 Qwen Team/SPDX block from any existing file).
NodeNext ESM: relative imports use `.js` extensions. No `any` (eslint
`no-explicit-any: error`) — use `Record<string, unknown>` + safe reads.
Commit messages MUST end with:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Task 1 — front-matter parser + substitution (pure, no fs)

New file `packages/rc-gateway/src/commands/parse.ts`:

- `parseFrontMatter(text: string): { frontMatter: Record<string, unknown>; body: string } | null`
  — returns `null` unless `text` begins with a `---` line and has a
  closing `---` line. Front-matter block parsed with `import { parse }
from 'yaml'` (must be a mapping → else `null`). Body = everything
  after the closing `---` (leading newline trimmed).
- `substitute(body: string, ctx: { args: string[]; named: Record<string,string>; file?: string }): string`
  — single-pass `body.replace(/\$\{([^}]+)\}/g, ...)`:
  `args`→`ctx.args.join(' ')`, `arg`→`ctx.args[0] ?? ''`,
  `arg.N`→`ctx.args[N] ?? ''` (N integer), `named.KEY`→`ctx.named[KEY] ?? ''`,
  `file`→`ctx.file ?? ''`, anything else → `''`. Replacement values are
  NOT re-scanned.

Tests `src/commands/parse.test.ts`: valid front-matter splits;
no-delimiter → null; non-mapping front-matter → null; each placeholder;
missing → empty; `${arg.2}` out of range → empty; a value containing
`${args}` is not re-expanded.

Commit: `test(rc-gateway): front-matter parser + placeholder substitution`
(red) then `feat(rc-gateway): front-matter parser + placeholder substitution`
(green). (Or one commit if you write test+impl together — prefer the
two-commit red/green.)

## Task 2 — CommandLoader (on-demand, two roots, precedence, collision-once)

New file `packages/rc-gateway/src/commands/loader.ts`:

```ts
export type CommandScope = 'read' | 'write' | 'approve';
export interface LoadedCommand {
  name: string;
  description: string; // ≤140
  scope: CommandScope; // declared
  tool?: string;
  sessionScope: string; // default 'required'
  body: string;
  source: 'workspace' | 'user';
}
```

`class CommandLoader`:

- ctor `(resolveWorkspaceCwd: () => Promise<string | undefined>, userCommandsDir: string, audit?: AuditRecorder)`.
- private `warnedCollisions = new Set<string>()`.
- `async load(): Promise<LoadedCommand[]>`:
  1. Read user dir (`userCommandsDir`) then workspace dir
     (`join(await resolveWorkspaceCwd() ?? '', '.qwen', 'commands')`,
     only if cwd is a non-empty string). For each: `readdir`, filter
     `.md`, `readFile`+`parseCommandFile`. Missing dir (ENOENT) → treat
     as empty. A file that fails validation → skipped.
  2. Build a `Map<string, LoadedCommand>` keyed by name: insert user
     first, then workspace (workspace overwrites). On overwrite where a
     user command of that name existed, it is a collision: if name not
     in `warnedCollisions`, `void audit?.record({ action:
'command_collision_workspace_wins', detail: { name } })` and add to
     the set.
  3. Return `[...map.values()]` (stable order: sort by name for
     determinism).
- private `parseCommandFile(text, source): LoadedCommand | null` —
  `parseFrontMatter`; require `name` matches `^[a-z][a-z0-9_-]{0,31}$`;
  `description` non-empty string (clamp to 140); `scope` ∈
  {read,write,approve} (owner/bridge/other → null); `tool` optional
  string; `sessionScope` optional string default 'required'. Any failure
  → null.

Add `command_collision_workspace_wins` to `AuditAction` union in
`auditLog.ts` (and `slash_command_invoked` — see Task 4; add both now if
convenient).

Tests `src/commands/loader.test.ts` (use `node:fs/promises` + a tmp dir
via `os.tmpdir()`+`mkdtemp`, or inject dirs): loads valid command; skips
bad name / bad scope / owner scope / missing front-matter; workspace
shadows user (precedence) and records collision; collision audited only
ONCE across two `load()` calls; missing dirs → `[]`; description clamped
to 140.

Commits: `test(rc-gateway): CommandLoader on-demand two-root loader` /
`feat(rc-gateway): CommandLoader with workspace>user precedence + collision-once audit`.

## Task 3 — GET /rc/commands route

New file `packages/rc-gateway/src/routes/commands.ts`:

- `mapDeclaredScope(scope: CommandScope): RcScope` —
  read→SESSION_READ, write→WRITE, approve→APPROVE.
- `createListCommandsRoute(loader: CommandLoader): RequestHandler` —
  `const cmds = await loader.load()`; map each to
  `{ name, description, scope, tool: c.tool ?? null, sessionScope,
source, invocableByYou }` where
  `invocableByYou = s.includes(WRITE) && s.includes(mapDeclaredScope(c.scope)) && !c.tool`
  (`s = req.rcClient?.scopes ?? []`). Respond `{ v: 1, commands }`.

Tests in `src/commands/commands.route.test.ts` (or extend server.test):
GET returns shape; `invocableByYou` true only when caller has WRITE +
mapped scope and no tool; a `scope: approve` command shows
`invocableByYou:false` for a WRITE-but-not-APPROVE caller; a tool
command shows `invocableByYou:false` even for an all-scope caller.

Commit: `feat(rc-gateway): GET /rc/commands listing with invocableByYou`.

## Task 4 — POST /rc/session/:id/command/:name invoke route

In `routes/commands.ts`:

`createInvokeCommandRoute(daemon: DaemonClient, loader: CommandLoader, audit?: AuditRecorder): RequestHandler`:

1. `const cmds = await loader.load(); const cmd = cmds.find(c => c.name === req.params.name)`.
   Not found → `404 { error:'Unknown command', code:'unknown_command' }`.
2. `cmd.tool` → `400 { code:'direct_tool_unsupported' }`.
3. Clamp: `if (!s.includes(mapDeclaredScope(cmd.scope)))` →
   audit `scope_denied {required: mapDeclaredScope}` + `403 insufficient_scope`.
4. Parse body `{ args, named, fileContext }`: `args` string→split, array
   ok, else `[]`; `named` object→`Record<string,string>` (String each
   value) else `{}`; `fileContext` string|undefined. `argc = args.length`.
   `const text = substitute(cmd.body, { args, named, file: fileContext })`.
5. Abort wiring identical to `routes/prompt.ts`: `AbortController`,
   `res.on('close', () => controller.abort())`,
   `daemon.prompt(req.params.id, { prompt:[{type:'text',text}] }, controller.signal)`
   in try/catch; catch → `if (controller.signal.aborted) return;` else
   `502 daemon_unavailable`. After await `if (controller.signal.aborted) return;`.
6. `void audit?.record({ action:'slash_command_invoked', actorTokenId:
req.rcClient?.id, target: req.params.id, detail: { name: cmd.name,
stopReason: result.stopReason, argc } })`. Respond `200 {stopReason}`.

Add `slash_command_invoked` to `AuditAction` (if not added in Task 2).

Tests: unknown command → 404; tool command → 400; caller missing
declared scope → 403 (+ audit scope_denied); happy path → 200 {stopReason}
with the resolved text reaching the stub's prompt; audit entry serialized
does NOT contain the resolved body text; daemon throw → 502.

Commit: `feat(rc-gateway): POST /rc/session/:id/command/:name invoke route`.

## Task 5 — wire into server.ts

In `createGatewayApp`:

- Build the loader once:
  ```ts
  const commandLoader =
    deps.commandLoader ??
    new CommandLoader(
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      deps.commandsUserDir ?? join(homedir(), '.qwen', 'commands'),
      audit,
    );
  ```
- After the prompt route, add (session pipeline):
  ```ts
  app.post(
    '/rc/session/:id/command/:name',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createInvokeCommandRoute(deps.daemon, commandLoader, audit),
  );
  ```
- Near the audit/search GETs add:
  ```ts
  app.get(
    '/rc/commands',
    requireScope(SESSION_READ, audit),
    createListCommandsRoute(commandLoader),
  );
  ```
- Extend `GatewayDeps` with optional `commandLoader?: CommandLoader` and
  `commandsUserDir?: string` (test injection).
- Export new symbols from `index.ts`.

NOTE on route order: `/rc/session/:id/command/:name` must not collide
with `/rc/session/:id/permission/:requestId` or `.../prompt` — distinct
path segments, fine. Keep it after the prompt route.

Tests: server.test boots with an injected `commandLoader` (a tiny fake or
a real loader pointed at a tmp workspace) and asserts GET 200 +
invoke wiring (404 for unknown). Confirm SESSION_READ gates GET (401/403).

Commit: `feat(rc-gateway): wire custom slash command routes into gateway`.

## Task 6 — e2e against the real daemon

Extend `scripts/rc-gateway-e2e.mjs` (allowed-exception file):

- Before boot or using the daemon's known workspace cwd, create a temp
  fixture `<workspaceCwd>/.qwen/commands/echo.md` (valid `scope: write`
  command) — or assert the empty-list path if creating a fixture in the
  real workspace is undesirable. Minimum assertions:
  - `GET /rc/commands` with the owner token → 200, body has `v:1` and an
    array `commands`.
  - If a fixture was created: it appears with `invocableByYou:true`.
  - `POST /rc/session/<bogus>/command/<unknown>` → 404 unknown_command.
  - `GET /rc/commands` without a token → 401.
  - Clean up any fixture file in a `finally`.
- Bump the e2e pass count in the script's summary.

Commit: `test(rc-gateway): e2e for custom slash command endpoints`.

## Final verification (from repo root, all must pass)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

Also confirm the cycle diff touches only `packages/rc-gateway/` (+ the
e2e script + docs):
`git diff --name-only 4e265e9b2..HEAD`.
