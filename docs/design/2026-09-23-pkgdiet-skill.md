# `/pkgdiet` Dependency Guardrail Skill Design

[English](./2026-09-23-pkgdiet-skill.md) | [中文版](./2026-09-23-pkgdiet-skill.zh-CN.md)

Status: implemented in PR #12572.
Associated files: `packages/core/src/skills/bundled/pkgdiet/SKILL.md`, `packages/core/src/skills/bundled/pkgdiet/SKILL.test.ts`.

## 1. Goal and Motivation

Autonomous AI coding agents frequently scaffold projects, add libraries, and run package manager commands (`npm install`, `pnpm add`, `npx`). Without evaluation guardrails, agents are susceptible to:

- Package hallucination attacks (installing non-existent packages typosquatted by attackers).
- Dependency bloat and unmaintained/deprecated packages.
- Supply-chain compromises.

The `/pkgdiet` skill provides an interactive, opt-in guardrail powered by the PkgDiet Model Context Protocol (MCP) server. Before npm package code is fetched or executed, packages are evaluated for security, deprecation, and bundle weight.

## 2. Design Decisions and Scope

### 2.1 Invocation and Agent Control

- `user-invocable: true`, `disable-model-invocation: true`: The skill is never invoked autonomously by the model. Only an explicit user invocation of `/pkgdiet` can activate the guardrail.
- `allowedTools: undefined`: No tools are pre-approved. Every action, including server registration and package installation, requires explicit user confirmation.
- **Session-Scoped Enforcement:** The guardrail instructions apply strictly to the interactive session in which `/pkgdiet` was invoked; they do not gate background subagents, hooks, workflow scripts, or external terminal commands. Only npm ecosystem managers (`npm`, `pnpm`, `yarn`, `bun`) are covered.

### 2.2 Registration and Storage Scope

- **User-Scope Registration:** The PkgDiet MCP server is registered at user scope by writing `mcpServers.pkgdiet` in a single write into `$QWEN_HOME/settings.json` (when `QWEN_HOME` is set) or `~/.qwen/settings.json`, including `command: "npx"`, `args: ["-y", "pkgdiet@2.0.0", "mcp"]`, and an explicit non-project `cwd` outside the workspace (such as `$QWEN_HOME` or user home) to isolate the evaluator from repository `.npmrc` or local `node_modules` without exposing temporary cwd-less entries to hot-reload file reconciliation.
- **Environment and Process Model:** The server executes as a local stdio child process alongside the session. It inherits the session environment (`sanitizeChildEnv`), preserving third-party API keys and tokens needed by developer tooling. This behavior is explicitly disclosed in the skill metadata and consent prompt.
- **Runtime Resolution:** `npx -y pkgdiet@2.0.0 mcp` resolves the 2.x dependency tree from npm at runtime.

### 2.3 Configuration Precedence and Identity Security

- **Session Policy Filter Verification:** Bootstrap checks `mcp.allowed` and `mcp.excluded` to verify that `pkgdiet` is not suppressed by configuration policy before attempting registration.
- **Allowlist Identity Verification:** The user-scope settings entry is checked against a strict allowlist: it must contain only allowed keys (`command`, `args`, and `cwd`), matching `command: npx`, `args: ["-y", "pkgdiet@2.0.0", "mcp"]`, and an explicit non-project `cwd`. Any extraneous key (e.g. `env`, `headers`, `trust`, `timeout`) is rejected as a mismatch.
- **Untrusted Gated Scopes:** Any `pkgdiet` entry originating in project or workspace scope (`.mcp.json`, `.qwen/settings.json`) is treated as untrusted. The skill halts immediately and refuses approval. Workspace entries can be removed via `"${QWEN_CODE_CLI:-qwen}" mcp remove --scope project pkgdiet`, while `.mcp.json` entries require editing that file directly.
- **Configuration Scope Limitation:** The allowlist applies strictly to the user-scope entry (`$QWEN_HOME/settings.json` or `~/.qwen/settings.json`). SystemDefaults (`system-defaults.json` or `QWEN_CODE_SYSTEM_DEFAULTS_PATH`), System scope (`/etc/qwen-code/settings.json` on Linux, `/Library/Application Support/QwenCode/settings.json` on macOS, `C:\ProgramData\qwen-code\settings.json` on Windows, or `QWEN_CODE_SYSTEM_SETTINGS_PATH`), CLI-flag (`--mcp-config`), extension-contributed, and session-injected (ACP/IDE) sources cannot be inspected or validated by the skill. If `check_dependency` is reachable but no entry exists in the three readable tiers (user, workspace, project), the server's origin cannot be validated and execution halts immediately.
- **Evaluator Registry Integrity:** Bootstrap runs `npm config get registry` from the evaluator's non-project working directory (e.g. `(cd "<cwd>" && npm config get registry)`) before skipping to instructions on reuse or proceeding with registration. If npm fails or exits non-zero, registration halts. The output is normalized by stripping any trailing slash and must match `https://registry.npmjs.org`. Any mirror or redirected registry halts registration as an identity mismatch.
- **Configuration Restoration:** If a prior user-scope entry exists in `$QWEN_HOME/settings.json` (or `~/.qwen/settings.json`), its full configuration object is recorded before modification. If writing the user settings entry fails, reachability fails, or the command exits non-zero, the recorded configuration is restored and execution stops.
- **Bounded Reachability Retries:** Initial server startup allows bounded retries for the cold `npx` download. If still unreachable, it is reported as registered but not running; connection status is verified from `mcp list` and direct terminal execution is suggested for diagnosing stderr.
- **Sandbox Fast-Path:** Inspection and registry verification occur before sandbox installation stops, allowing container-sandboxed sessions with mounted user settings to reuse an existing reachable guardrail without requiring host re-installation, provided that `npm` is executable within the session shell to verify registry integrity in the evaluator `cwd`.

### 2.4 Verdict Contracts and Execution Modes

- **Fail-Closed on Unscreened Packages:** If `check_dependency` returns `ALLOW` with `reasons` indicating that the package was not evaluated (network failure, private `.npmrc` mapping, or fail-open fallback), the skill halts and requests explicit user instructions rather than permitting unscreened installation.
- **Per-Project Policy and Direct Agent Enforcement:** Before checking packages in each project directory (and whenever the working directory changes), the skill inspects for `.pkgdietrc.json`, `pkgdiet.config.json`, `package.json#pkgdiet`, and `.pkgdiet-cache.json`. Active policy rules (`allowedPackages`, `blockedPackages`, `minHealthScore`, `securityMode`) are disclosed to the user and enforced directly by the agent: `blockedPackages` strictly takes precedence over `allowedPackages`. Packages in `blockedPackages` or failing `minHealthScore` under the project's `securityMode` are not installed regardless of the verdict. Packages in `allowedPackages` (and not blocked) are treated as repository-declared. If a tracked `.pkgdiet-cache.json` exists, execution halts until it is removed.
- **Direct Execution and Scaffolder Gating:** All commands that download and execute packages — including `npx`, `npm exec`, `yarn dlx`, `pnpm dlx`, `bunx`, and scaffolders (`npm create`, `npm init <pkg>`, `pnpm create`, `yarn create`, `bun create`) — are gated under the evaluation instructions. For scaffolder commands, the package fetched and executed from the registry is `create-<name>` (or `@scope/create-<name>`); the skill evaluates `create-<name>` rather than the bare argument.
- **Registry Alignment & Local Resolution:** Verdicts are valid only for packages hosted on `https://registry.npmjs.org` at latest. If resolution redirects via `--registry`, project `.npmrc`, `~/.npmrc`, `npm_config_registry`, `.yarnrc.yml`, `.yarnrc`, `bunfig.toml`, or lockfile, the verdict is treated as not applicable and installation does not proceed. If the command is a local script or binary performing no network installs (a compiled binary already present on disk, or a run script invoking local binaries), it is out of scope and runs normally. An on-disk entry (`node_modules/.bin/<name>`) does not exempt a command that may fetch remote code (`npm install`/`ci`/`add`, `npx`, `dlx`, `create`, or downloader wrappers).
- **Version Scoping & Disclosure:** Verdicts apply to latest. When a pinned version or range differs, the check routes to the permission step with explicit disclosure that latest was evaluated.
- **Single-Hop Alternative Bounding:** When `suggest_alternative` is invoked for `WARN` or `BLOCK` verdicts, suggestions are evaluated once and bounded to at most 1 hop to prevent recursive recommendation loops.
- **Execution Mode Parity:** In direct tool mode, tools are called via `tool_call`. In code mode, deferred tools are invoked through `exec` using the `jsName` returned by `tool_search`.

## 3. Teardown and Rollback

Users can remove the persistent server registration at any time by executing:

```bash
"${QWEN_CODE_CLI:-qwen}" mcp remove --scope user pkgdiet
```

## 4. Accepted Residual Risks

1. **Runtime Dependency Fetch:** The initial `npx` execution fetches package code from npm over the network. Network isolation or proxy environments must have connectivity to the public npm registry during bootstrap.
2. **Environment Variable Exposure:** Local MCP servers spawned over stdio inherit exported credentials from the host session environment.
3. **Repository-Declared Policies:** Project-level configuration files (`.pkgdietrc.json`, `pkgdiet.config.json`) override default evaluation thresholds when present in the inspected repository.
4. **Configuration Scope Limitation:** The pkgdiet allowlist is enforced only on the user-scope settings file. In managed or multi-user environments, configurations originating from SystemDefaults, System scope, the `--mcp-config` CLI flag, extension-contributed sources, or session-injected ACP/IDE runtime are outside the skill's inspection and validation reach.
