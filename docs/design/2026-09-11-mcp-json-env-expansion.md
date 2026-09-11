# `.mcp.json` Environment-Variable Expansion — Design

[English](2026-09-11-mcp-json-env-expansion.md) | [简体中文](2026-09-11-mcp-json-env-expansion.zh-CN.md)

**Date:** 2026-09-11
**Status:** In review (PR #11501)
**Related issues:** #11499, #4615, #4466, #6131, #8653
**Related PRs:** #11501, #4474, #4713, #6177

---

## Problem

`.mcp.json` is checked into the repository, so referencing a secret by name is the only safe way to configure an authenticated server — but the placeholder was sent verbatim. A server configured with `"Authorization": "Bearer ${MY_TOKEN}"` received the header `Authorization: Bearer ${MY_TOKEN}` and answered 401, surfacing only as "Disconnected" with nothing pointing at the cause.

This is an inconsistency inside qwen-code rather than a new feature: the byte-identical server entry expands from `.qwen/settings.json` and does not from `.mcp.json`. #4466 / #4474 established this as correct behavior for MCP headers in `settings.json`; `.mcp.json` arrived later (#4713) and never picked it up. Claude Code, whose format this is, documents expansion in `command`, `args`, `env`, `url` and `headers`, including the same leave-the-placeholder-when-unset behavior. Claude's `${VAR:-default}` syntax is not added — only plain expansion, matching what qwen's resolver already supports elsewhere.

The resolver is `resolveEnvVarsInObject` (`packages/core/src/utils/envVarResolver.ts`), shared with every settings scope; the loader is `loadProjectMcpServers` (`packages/cli/src/config/mcpJson.ts`), reached through `assembleMcpServers` from six call sites: config boot (`loadCliConfig`), the settings-file hot reload (`hot-reload.ts`), the ACP workspace reload (`acpAgent.ts`), `qwen mcp list`, `qwen mcp approve` and `qwen mcp reconnect`.

---

## 1. Expansion is restricted to an allowlist of fields, which is NOT settings parity

An earlier revision handed the whole server entry to `resolveEnvVarsInObject` and described that as parity with settings scopes. Review pointed out that this silently started expanding `description` and `extensionName`, which no release had ever expanded. The fix changes the shape of the claim, so the divergence is stated plainly.

`loadSettings` resolves the entire settings document, so every string in it expands. This loader does not. It expands an explicit allowlist and leaves every other field byte-identical, including `description`, `extensionName` and `includeTools`. The allowlist is:

- stdio: `command`, `args`, `env`, `cwd`
- SSE / streamable HTTP: `url`, `httpUrl`, `headers`
- WebSocket: `tcp`
- OAuth: `oauth` — `MCPOAuthConfig.clientSecret` is exactly the kind of value a checked-in file must reference rather than embed
- Google auth: `targetAudience`, `targetServiceAccount` — these select which identity is impersonated and which audience the token is minted for, so they decide what the connection authenticates as, and they are exactly the values that differ per environment (project number, service-account name)

`authProviderType` is deliberately not on the list. It selects a provider from a fixed enum (`google_credentials`, `dynamic_discovery`, `service_account_impersonation`); the value is a constant, not something that varies per environment, so a placeholder there gains nothing.

`.mcp.json` is therefore deliberately narrower than a settings scope, for two reasons. A `.mcp.json` is repository-supplied and untrusted until approved, which is not true of `~/.qwen/settings.json`; expansion is a channel for a committed file to read the environment, so it covers exactly the fields that need it. And `description` / `extensionName` are precisely the fields `packages/core/src/mcp/configHash.ts` classifies as non-behavioral and strips from the approval digest — expanding a value that by definition cannot affect what the server does buys nothing. The allowlist is also narrower than "behavioral" as `configHash.ts` defines it: `includeTools`, `excludeTools`, `timeout` and `trust` all count toward the approval digest and none of them expand.

The `--mcp-config` expansion, added in the revision after the first review round (`4d024d692f`), deliberately does **not** follow that narrower rule: `parseMcpConfig` resolves the whole object, metadata included, i.e. full settings parity. The asymmetry is the point. `--mcp-config` is passed by the operator running the command, exactly like a settings file they own; a `.mcp.json` is supplied by the repository and untrusted until approved. So a `$`-bearing `description` behaves differently between the two sources, and that is intended. Nothing verifies authorship of a `--mcp-config` path — the operator's choice to pass it is the trust decision, and `--mcp-config` servers are not gated, which predates this change.

---

## 2. `getHomeEnvFallbackVars()` is deliberately not passed

Triage on #11499 asked for the home-`.env` fallback, on the grounds that a token living only in `~/.qwen/.env` would expand in `.qwen/settings.json` and stay literal in `.mcp.json`. That does not reproduce: `loadSettings()` calls `loadEnvironment()` (`settings.ts`, inside `loadSettings`, unless the caller passes `skipLoadEnvironment`, which none of the six call sites does) before any of them reads `.mcp.json`, so a key from `~/.qwen/.env` is already in `process.env` and expands fine.

Passing the fallback would actively hurt. `getHomeEnvFallbackVars()` filters neither `isLoaderEnvKey` nor `isPrivateProvenanceEnvKey`, while `loadEnvironment` rejects both at every scope, so the only keys the fallback adds on top of `process.env` are precisely the ones the env loader deliberately withheld — `NODE_OPTIONS` among them. Wiring that into a repository-controlled, untrusted-until-approved file would let a committed `.mcp.json` read exactly those values: the #8653 vector rather than a fix.

A test pins this: it sets a temporary `QWEN_HOME`, writes a `.env` there holding an ordinary key and `NODE_OPTIONS`, asserts `getHomeEnvFallbackVars()` really does surface both — so the test cannot pass vacuously — and then asserts neither is substituted into the MCP config. One residual difference: a variable added to a `.env` file after boot is seen by the ACP workspace reload, which calls `loadSettings()` afresh and so re-runs `loadEnvironment()`, but not by the settings-watcher hot reload, which reloads scopes from disk without touching the environment.

Which `.env` files are in `process.env` by the time `.mcp.json` is read: `findEnvFiles` walks up from the project directory and takes the first `<dir>/.qwen/.env` or `<dir>/.env` it finds — a workspace file only when that workspace is trusted — then adds the home candidates: `<QWEN_HOME>/.env`, the legacy `~/.qwen/.env` when `QWEN_HOME` redirects, and `~/.env`. A checked-out repository can therefore ship a `.env` that supplies the values its own `.mcp.json` placeholders resolve to; the gate on that is workspace trust, and the approval gate still applies to the server itself.

---

## 3. A nesting cap, because the resolver recurses

`resolveEnvVarsInObject` recurses without a depth bound, so a hostile or generated `.mcp.json` could overflow the stack and take down `qwen`, `qwen mcp list` and `qwen mcp approve` with a `RangeError` instead of producing a diagnostic.

Measured against the built resolver on node v24.11 (win32): a nested **array** throws somewhere in the ~2000–3000 range in an empty process, and the exact boundary is not stable — it moves between runs with JIT state, so it is a band rather than a number. A figure of 2000 inside the bundled CLI is consistent with that, since startup has already spent part of the stack by the time the loader runs. Arrays recurse through `Array.prototype.map`, which costs more stack per level than the object branch; nested **objects** survive 5000 and throw by 10000. `JSON.parse` throws at none of these depths — it parses 100000 levels fine — so the loader's pre-existing parse `try/catch` never covered this.

The threshold moves with the V8 build and with how much stack the caller has left, which is the argument for a fixed cap rather than trying to compute a safe depth. `MAX_MCP_SERVER_CONFIG_DEPTH = 64` is orders of magnitude above any real config (`env`, `headers` and `args` nest two or three levels). An entry above the cap is reported through the loader's existing `errors` collection and skipped, so a pathological file costs that one server and not the process. The depth probe (`exceedsMaxDepth`) is itself iterative — a recursive probe would overflow on the input it exists to reject. A per-entry `try/catch` backs it up, keeping the loader's documented "never throws" contract total. The probe carries no `seen` set: its input is always `JSON.parse` output, a finite tree, and a cycle — were one ever passed — terminates by exceeding the cap.

Depth is counted from the server entry (entry = 1), and the three recursive consumers start at different points relative to it: `parseMcpConfig` hands the resolver the whole map of servers, one level above the entry, so it recurses at most cap + 1; `hashMcpServerConfig` stringifies the entry, so cap; `resolveTransportEnvVars` hands the resolver one field of the entry, so cap − 1. `parseMcpConfig` applies the same cap to `--mcp-config`, failing loudly and whole there — an explicit operator argument — where `.mcp.json` skips the one entry.

---

## 4. Approval hashing happens after resolution, on purpose

Triage called this a real side effect: "matching it is consistency rather than novelty, but it does extend an existing wart". The decision is to match, and both halves were reproduced before deciding. Approving a project server and a workspace server with the same `${TOK}` header, then rotating the variable with both files untouched, sends **both** back to `pending` — the workspace-scope server behaves that way on `main` today, so this aligns `.mcp.json` with shipped behavior rather than inventing it.

The alternative was tested and is worse. Hashing the raw pre-resolution text would keep an approval valid across a change of the _effective_ config: with `httpUrl: "https://${HOSTVAR}/mcp"`, repointing `HOSTVAR` left the server resolving to `https://attacker.test/mcp` while still counting as approved. Since the hash exists to bind a decision to the exact configuration the user reviewed, and `url` / `headers` are behavioral fields by the definition in `packages/core/src/mcp/configHash.ts`, binding to the resolved form is the security-correct end of the tradeoff. The stored record is a SHA-256 digest, so no secret is written to the approvals file. The cost is the one triage named: rotating a token, or a colleague with their own key, re-triggers approval. That is the right price, and it is the price workspace scope already pays.

What review did change is that the behavior was not _disclosed_ anywhere. The approval dialog and a docstring were misleading, and both are fixed as text only — the hashing logic is untouched:

- the approval dialog said approval is bound to this exact configuration and that you will be asked again "if `.mcp.json` changes", which omitted the environment-variable half; it now also names a substituted variable changing value;
- `mcpApprovals.ts` documented the digest without saying it is computed over the _resolved_ config, so a reader would reasonably assume it hashed the file bytes; the docstring now records that, and why the raw-text alternative is worse.

---

## 5. No expansion when the approval gate is off (`--yolo`, bare mode, safe mode)

The third review round found a hole in the previous revision; the decision taken on it is recorded here rather than inherited silently from what settings scopes do.

The safety argument for expanding a repository-supplied file is that the user sees the server before anything connects to it. `--yolo` skips the MCP approval prompt (#6177, closing #6131), so under `--yolo` that argument is absent: a cloned repository could name any variable in its own `headers` and have the real value posted to an endpoint its author chose. Before this change the same file leaked only the literal placeholder, so the previous revision had introduced a regression on that path. Bare and safe mode drop `.mcp.json` entirely and were never exposed, but they turn the same gate off and are handled by the same condition.

**Decision: `.mcp.json` placeholders are expanded if and only if the approval gate is armed.** The condition — `!bareMode && !safeMode && approvalMode !== YOLO` — lives in one place, `isMcpApprovalGateArmed(bareMode, safeMode, approvalMode)` in `mcpApprovals.ts`, and feeds `expandEnv` at the three call sites where the gate can be off: boot (`loadCliConfig`), the settings-file hot reload (`hot-reload.ts`) and the ACP workspace reload (`acpAgent.ts`). The same value decides whether `pendingMcpServers` is computed — directly at boot, and as the argument to `recomputeMcpGating` in both reload paths — so the two decisions are the same call and cannot drift. ACP `session/new` and the ACP workspace MCP discovery config both build their `Config` through `loadCliConfig`, so the predicate applies at session creation as well as in the reload loop. Under `--yolo` a `.mcp.json` server therefore connects with its placeholder as literal text — exactly what `main` does today, which fails with the 401 this change fixes for gated sessions rather than leaking anything — and the loader reports it through `errors`, surfaced as a stderr warning naming the server. Bare and safe mode never load `.mcp.json`.

That includes a server the user approved earlier with `qwen mcp approve`: under `--yolo` it also receives the literal, so the 401 of #11499 remains in the CI scenario where a checked-out repository is run headless. The alternative — expand, hash the result, keep it if the digest matches a stored approval and fall back to the literal otherwise — was considered and rejected, because it expands the value before consent has been checked, which is exactly the action this decision exists to avoid; a fresh CI checkout also has no approval store to match against. What the user reviews when the gate is armed is also narrower than "the server": the dialog's `summarize()` (`useMcpApproval.ts`) shows the resolved `url` / `command` / `args` but only the key names of `env` and `headers`, so it shows where the server connects and what runs, not which variable a header reads.

`qwen mcp list`, `qwen mcp approve` and `qwen mcp reconnect` keep the default `expandEnv: true`. None of the three has a `--yolo`, and the gate is always armed on their paths: `list` prints non-approved gated servers without connecting and live-tests only approved ones; `reconnect` passes `getPendingGatedMcpServers` unconditionally into its throwaway `Config`, so discovery skips pending servers before `discoverToolsForServer` runs; `approve` never connects. They also have to keep expanding: the approval digest is the digest of the resolved config (section 4), and narrowing expansion there would silently invalidate every approval taken at a normal boot.

Why this option and not the other two:

- _Change `--yolo` so it prompts for, or refuses, gated servers._ That reverses #6177, which made `--yolo` skip the prompt so headless and non-interactive runs neither hang on a dialog nor silently drop servers (#6131). This change is about a resolver, not about what `--yolo` means.
- _Keep expanding under `--yolo`._ That leaves the hole open.

Gating the expansion is the only option that keeps `--yolo` semantics intact and keeps a repository's file from turning a variable name into its value with nobody looking.

A runtime switch to YOLO does not reopen this. `pendingMcpServers` is set at construction (`packages/core/src/config/config.ts`, constructor), replaced by `setPendingMcpServers` and narrowed by `approveMcpServerForSession` — nothing re-adds a server — and `isMcpServerPendingApproval` just reads it, so a server that was pending stays pending after `setApprovalMode(YOLO)`; a hot reload after the switch recomputes with the gate off and therefore without expansion, which closes the hole for anything new and, for a server already approved and connected, is the limitation below.

**Known limitation — a mid-session switch to YOLO.** A session that booted gate-armed, approved a server and connected it with resolved credentials, then switches to YOLO (`/approval-mode yolo`, Shift+Tab cycling, ACP `session/set_mode`), rewrites that server to the literal form on the next settings reload — any edit, MCP-related or not: the transport fingerprint changes, the connection is torn down and re-made with the placeholder, and the server 401s until the mode is switched back and reloaded; the loader's warning names it on stderr. Not fixed here. Deciding expansion once per session would re-open the hole this section closes for a server added to `.mcp.json` after the switch — it would expand and connect with nobody asked; keeping already-resolved entries is a per-entry merge with no criterion for matching a resolved entry to its unresolved successor. Same limitation, per Config, in a daemon: sessions that disagree on approval mode each assemble their own map, so one `.mcp.json` server can hold two connections with different credentials.

**The approval store is read and written only from a gate-armed Config.** The store is one record per workspace and the digest is of the config as the session holds it; a gate-off session holds `.mcp.json` unexpanded, so its digest never matches an approval recorded from the expanded form. Unguarded, a `--yolo` daemon or TUI session reported an approved server as pending and, on approve, persisted the literal digest, which every gate-armed boot then rejected (the automated review of 2026-09-11 on `e1aa3572e4` measured a 4/4 ping-pong between a `--yolo` daemon and the CLI). The three read sites — daemon workspace status, ink `/mcp` dialog, OpenTUI dialog data — therefore report no approval state from a gate-off Config, and the two write sites — the daemon `workspaceMcpManage approve` endpoint and the dialogs' Approve action — refuse. Canonicalising to the expanded form instead would expand `.mcp.json` under `--yolo` for the hash, the action this section exists to avoid, and would show the user a literal while binding to the expanded value. `qwen mcp approve` keeps hashing the expanded form: narrowing it would invalidate every store already written. Cost: under `--yolo` there is no pre-approval from the `/mcp` dialog or the daemon endpoint — `qwen mcp approve` remains — and a daemon started in YOLO shows the IDE no approval state, which under YOLO does not affect connection anyway.

Workspace-scope `.qwen/settings.json` under `--yolo` behaves the same way today: its servers are resolved by `loadSettings` regardless of approval mode, so a gated workspace server connects with real values under `--yolo`. That is named here so the precedent is explicit, not as a reason the `.mcp.json` hole would have been acceptable. This change does not modify settings resolution, and the decision above stands on its own: `.mcp.json` arrives with the repository rather than being written by the user, which is why it is the file that is fixed here.

Resolution reads the process-wide `process.env`, as every settings scope does; the resolver has no per-workspace view, and none is introduced here.

Tests: the loader (`mcpJson.test.ts`: `expandEnv: false` leaves `${VAR}` literal, default and explicit `true` expand); `assembleMcpServers` (`mcpServers.test.ts`); the predicate's truth table (`mcpApprovals.test.ts`); and each of the three call sites. Boot: `config.test.ts` mocks `fs.writeFileSync`, so a real `.mcp.json` cannot be planted there; the test wraps `assembleMcpServers` in a pass-through spy and asserts that `loadCliConfig` passes `{ expandEnv: false }` and no `pendingMcpServers` under `--yolo`, `-y` and `--approval-mode yolo`, and `{ expandEnv: true }` with a computed `pendingMcpServers` by default. Settings hot reload (`hot-reload.test.ts`) and ACP `workspaceMcpReload` (`acpAgent.test.ts`): a `.mcp.json` with `${VAR}` in a temp project directory goes through the real loader, and the map handed to `reinitializeMcpServers` is asserted literal under YOLO and expanded under DEFAULT; the hot-reload case also asserts the `pending` half (none under YOLO, `['proj']` under DEFAULT). Each site was checked by mutation — forcing `expandEnv: true` at that site makes its YOLO case fail (boot: 3 failed / 1 passed; hot reload: 1 / 1; ACP reload: 1 / 1). The digest: `approve.test.ts` approves a server whose header references a variable, asserts `approved` against the loader's default (so `qwen mcp approve` and boot hash the same form), then changes the variable with the file untouched and asserts `pending`. The store guard: the ink dialog (`MCPManagementDialog.test.tsx`) and OpenTUI dialog data (`dialog-data.test.ts`) carry no approval state from a YOLO Config, and the daemon `workspaceMcpManage approve` endpoint (`acpAgent.test.ts`) rejects from one.

---

## Non-goals

- Claude's `${VAR:-default}` syntax.
- An escape for a literal `$` — the shared resolver has no `$$` form, and adding one would change every settings scope.
- Masking resolved secrets in `qwen mcp list` before approval — the same exposure already ships for workspace scope through code this change does not touch, so the rule belongs in the shared display path for both gated scopes.
- Changing what `--yolo` means for MCP approval (#6177), or how workspace-scope settings are resolved under it.
- MCP servers supplied by extensions: the extension manager resolves a Qwen-format manifest whole, with no gate input, and extension servers are never approval-gated. The "if and only if" in section 5 is scoped to the `.mcp.json` loader.
