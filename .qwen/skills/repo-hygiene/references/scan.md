# Scan Phase

You are the scan phase. Your only outputs are `<workdir>/findings.json` and
`<workdir>/report-only.md`. Do NOT create a branch, edit code, run
verification commands, or write PR files — a later fix-phase job does that.

## Scan Targets

Dispatch one subagent per partition below (nine subagents, parallel). A
subagent owns its partition and reports **candidates only** — it does not
modify the working tree, does not commit, and does not run verification. A
pattern hit (from `rg` or `grep`) is a lead, not a
finding — confirm each hit by reading the surrounding context before
recording it. The main agent collects, deduplicates across partitions, then
decides which candidates to accept as findings.

For each candidate, grep/code-reference evidence is required; a candidate
that cannot point at file:line with a quote is not a finding.

### Nine partitions (one subagent each)

Each partition below names its package, what it does, its key subdirectories,
and what "correct" looks like inside it. The scope line is a starting
boundary, not a reading list — the subagent finds the package's own entry
points, schemas, registries, and contracts and builds its own map.

Packages intentionally excluded from scan scope: `audio-capture` (native
addon, thin binding), `channels` (daemon-internal worker transport),
`cua-driver` (vendored), `mobile-mcp` (vendored), `web-templates` (build
scaffolding). These are either vendored from upstream or too thin to yield
hygiene findings.

- **cli/config** — config subsystem of the Qwen CLI (`packages/cli/src/config/`).
  - Defines the settings schema (`settingsSchema.ts`, `settings.ts`), the
    multi-scope settings loader (user / project / extension / bundled), and
    the migration logic.
  - The vscode IDE companion's `schemas/settings.schema.json` is a generated
    artifact of this partition; edits to the schema source must regenerate it.
  - Correct: every schema field has a loader, every loader has a default,
    every migration is reversible, and generated artifacts match their source.

- **cli/runtime** — command entry points plus the daemon HTTP server
  (`packages/cli/src/commands/`, `packages/cli/src/serve/`,
  `packages/cli/src/acp-integration/`, `packages/cli/src/services/`,
  `packages/cli/src/remoteInput/`, `packages/cli/src/dualOutput/`,
  `packages/cli/src/startup/`, `packages/cli/src/i18n/`, `packages/cli/src/utils/`,
  `packages/cli/src/core/`, `packages/cli/src/export/`, `packages/cli/src/validate*`).
  - `commands/` registers subcommand entries, argv parsers, and help text.
  - `serve/` is the daemon: Express HTTP routes, channel worker manager,
    channel worker group/supervisor, ACP streamable-http, CDP tunnel,
    workspace registry, workspace service, and the daemon lifecycle.
  - `acp-integration/` hosts the ACP Agent, session tracker, and subagent
    tracker consumed by serve routes and channel workers.
  - Correct: every registered command has a parser and help, every route
    maps to a workspace-scoped runtime, every worker lifecycle has cleanup.

- **cli/ui** — the Ink TUI (`packages/cli/src/ui/`).
  - `App.tsx` / `AppContainer.tsx` are the root containers.
  - `components/DialogManager.tsx` is the global dialog router driven by `uiState`.
  - Domain subpackages (under `components/`): `agent-view/` (chat),
    `arena/` (multi-model compare), `extensions/` (install wizard + tabs),
    `mcp/` (server approval), `hooks/`, `subagents/{create,manage}/`,
    `background-view/`.
  - Shared primitives (under `components/`): `shared/` (`ScrollableList`,
    `TextInput`, `ErrorBoundary`, `text-buffer`, `vim-buffer-actions`),
    `messages/` (history item renderers).
  - Global layers: `contexts/`, `themes/`, `state/`, `layouts/`, `hooks/`, `voice/`,
    `selection/`, `editors/`, `daemon/`, `models/`, `noninteractive/`.
  - Correct: themes flow through semantic tokens, dialogs never double-mount.

- **core** — the shared runtime package (`packages/core/src/`).
  - Consumed by every CLI frontend; does not depend on business-layer code.
  - Key subdirs: `core/` (base LLM client, per-provider content generators,
    tool scheduler, turn management, permission flow, session recovery),
    `agents/` (agent abstractions), `models/` (provider adapters),
    `providers/` (model provider implementations), `tools/` (tool definitions),
    `services/`, `prompts/`, `utils/` (LruCache, retry, filesearch, git,
    shell, terminal, request-tokenizer), `hooks/`, `memory/`, `skills/`,
    `subagents/`, `permissions/`, `confirmation-bus/`, `mcp/`, `lsp/`, `ide/`,
    `goals/`, `resources/`, `followup/`, `extension/`, `config/`, `telemetry/`,
    `output/`, `qwen/`.
  - Cross-package contracts live here: exported types, protocol definitions,
    daemon protocol. Anything that breaks a contract here breaks every
    consumer.
  - Correct: every export has a consumer, every protocol field matches its
    wire form, every retry classifies its errors.

- **extensions** — IDE host integrations (`packages/vscode-ide-companion/`,
  `packages/chrome-extension/`, `packages/zed-extension/`).
  - `vscode-ide-companion`: VS Code extension entry, host API surface,
    `schemas/settings.schema.json` (generated from cli/config).
  - `chrome-extension`: Chrome extension with manifest + background/content
    scripts.
  - `zed-extension`: Zed extension with its host API.
  - Correct: each extension uses its host's API surface correctly, manifest
    versions match host requirements, generated artifacts are not stale.

- **sdk-typescript** — the TypeScript SDK (`packages/sdk-typescript/`).
  - ACP / streamable-http client for TS consumers; public surface is its
    exported types and client classes.
  - Correct: protocol fields match the wire, retry/abort semantics are
    honored, breaking changes bump the version.

- **sdk-python-java** — non-TS SDKs and the ACP bridge
  (`packages/sdk-python/`, `packages/sdk-java/`, `packages/acp-bridge/`).
  - Python and Java SDKs ship ACP clients; `acp-bridge` is the bridge that
    lets non-TS code speak ACP to the daemon.
  - Correct: multi-SDK behavior is consistent, protocol fields match the
    TS SDK, bridge error mapping preserves the original error class.

- **ui-apps** — the two UI apps (`packages/desktop-shell/` and
  `packages/web-shell/`).
  - `desktop-shell`: a thin Tauri shell around Web Shell (window
    management, process lifecycle, signing, updates).
  - `web-shell`: a client React app (`client/`), a Vite build, and a
    daemon proxy; ships as an embeddable component.
  - Correct: IPC message shapes match both ends, routes resolve, state
    cleans up on unmount, portal roots are scoped.

- **docs** — documentation (`docs/`, `README.md`, each package's root docs).
  - `docs/design/` design docs, `docs/developers/` developer guides,
    `docs/users/` user-facing docs, `docs/plans/` implementation plans.
  - Cross-reference against the source files the prose points at; every
    claim about a setting, command, or API must point at the source line
    that backs it.
  - Correct: prose never misleads a user into a wrong action, example code
    runs, every API reference matches the real parser or schema.

A partition is a starting boundary, not a fence. A subagent may follow a
call chain, import graph, or contract reference into another partition to
build evidence. When a finding's minimal fix would touch more than three
production files or more than one hundred lines of production code (tests
and docs excluded from both counts), record it under `reportOnly`, never
under `fixes`.

### Six angles (applied inside each partition)

- **Test-coverage truthfulness**: a test name, `describe` block, wrapper
  argument, mock input shape, env var, feature flag, or version gate claims
  to cover a path it never actually triggers; or an assertion is so strict
  it flakes (e.g. demanding one exact tool call when text output is equally
  valid). Show the gap between the claim and what actually executes.
- **Implementation/contract mismatch**: constant name vs value, JSDoc vs
  implementation, default value vs every caller, unit conversion, fallback
  behavior. Show every caller or every read site that contradicts the
  declared contract.
- **Resource lifecycle**: `AbortController` that is never aborted on a
  fallback path, `finally` that silently swallows, iterator without a
  `return` handler, stream that is not cleaned up, event listener that is
  never removed, `setTimeout`/`setInterval` that is not cleared on
  teardown, file/socket handles that leak across async boundaries. Show the
  allocation and the missing release.
- **Real boundary conditions**: falsy values, empty strings, dotfiles,
  path suffixes, case sensitivity, negative/zero values, duplicates,
  ordering/LRU semantics. Show the branch that handles (or fails to
  handle) the boundary.
- **User-visible configuration/API**: config field names, command options,
  error messages, and example code against the real parser or schema.
  Show the parser/schema line and the prose or example that disagrees.
- **Docs**: docs findings are accepted only when the prose would mislead
  a user into a wrong action, points at a wrong API or design, ships
  example code that cannot run, or provably contradicts current behavior.
  Plain typos, harmless wording, and broken-but-rendering-fine emphasis
  stay untouched.

Do NOT scan GitHub issues as a source. Every finding must be provable from the
repository itself.

Each finding must record: root cause; evidence location (file + line/quote);
why this is a real problem and not a style preference; the minimal fix.
Findings going under `fixes` must additionally record how to prove it fails
or misaligns before the fix and how to verify after the fix (`failBefore` /
`verifyAfter`).

## Steps

1. Dispatch the nine partition subagents in parallel via the `agent` tool.
   Each subagent applies the six angles inside its partition and reports
   candidates. As each subagent returns, immediately merge its confirmed
   findings into `<workdir>/findings.json` (cross-partition dedup can re-run
   at step 2) so a timeout never loses completed partitions. If the `agent`
   tool is unavailable, scan partitions yourself serially in the order listed
   above — and after EACH partition, update `<workdir>/findings.json` with
   the confirmed findings so far. Skipping remaining partitions when time
   runs short is acceptable; losing finished work is not.
2. Collect, deduplicate across partitions, and write every confirmed finding
   to `<workdir>/findings.json` (format in the base document). Findings whose
   minimal fix fits the Scope Limits go under `fixes` with
   `"status": "pending"`; everything else goes under `reportOnly`.
3. Write `<workdir>/report-only.md` (bilingual per Shared Rules): every
   report-only finding with root cause, evidence, and suggested fix. When
   there are none, do NOT write the file — the workflow posts any non-empty
   file as a PR comment, and a sentinel would post as noise.
4. STOP. Do not create a branch, edit code, or write PR files.
