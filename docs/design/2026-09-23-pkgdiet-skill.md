# `/pkgdiet` Dependency Guardrail Skill Design

[English](./2026-09-23-pkgdiet-skill.md) | [中文版](./2026-09-23-pkgdiet-skill.zh-CN.md)

Status: implemented in PR #12572.
Associated files: `packages/core/src/skills/bundled/pkgdiet/SKILL.md`, `packages/core/src/skills/bundled/pkgdiet/SKILL.test.ts`.

## 1. Goal and Motivation

Autonomous AI coding agents frequently scaffold projects, add libraries, and run package manager commands (`npm install`, `pnpm add`, `npx`). Without evaluation guardrails, agents are susceptible to:

- Package hallucination attacks (installing non-existent packages typosquatted by attackers).
- Dependency bloat and unmaintained/deprecated packages.
- Supply-chain compromises.

The `/pkgdiet` skill provides an interactive, opt-in guardrail powered by the PkgDiet Model Context Protocol (MCP) server. Before package code is fetched or executed, packages are evaluated for security, deprecation, and bundle weight.

## 2. Design Decisions and Scope

### 2.1 Invocation and Agent Control

- `user-invocable: true`, `disable-model-invocation: true`: The skill is never invoked autonomously by the model. Only an explicit user invocation of `/pkgdiet` can activate the guardrail.
- `allowedTools: undefined`: No tools are pre-approved. Every action, including server registration and package installation, requires explicit user confirmation.
- **Session-Scoped Enforcement:** The guardrail instructions apply strictly to the interactive session in which `/pkgdiet` was invoked; they do not gate background subagents, hooks, workflow scripts, or external terminal commands.

### 2.2 Registration and Storage Scope

- **User-Scope Registration:** The PkgDiet MCP server is registered at user scope via `"${QWEN_CODE_CLI:-qwen}" mcp add --scope user pkgdiet npx -y pkgdiet@2.0.0 mcp`. This ensures availability across projects without polluting individual repository workspaces with uncommitted configurations.
- **Environment and Process Model:** The server executes as a local stdio child process alongside the session. It inherits the session environment (`sanitizeChildEnv`), preserving third-party API keys and tokens needed by developer tooling. This behavior is explicitly disclosed in the skill metadata and consent prompt.
- **Runtime Resolution:** `npx -y pkgdiet@2.0.0 mcp` resolves the 2.x dependency tree from npm at runtime.

### 2.3 Configuration Precedence and Identity Security

- **Whole-Entry Identity Verification:** To prevent hostile repositories from intercepting package verdicts by declaring `pkgdiet` with custom `env` (e.g. `NODE_OPTIONS` preload scripts) or `cwd`, the skill inspects the declaring configuration file (`~/.qwen/settings.json`) to verify the full entry: `command: npx`, `args: ["-y", "pkgdiet@2.0.0", "mcp"]`, and no extraneous fields (`env`, `cwd`, `headers`, `url`, etc.).
- **Untrusted Gated Scopes:** Any `pkgdiet` entry originating in project or workspace scope (`.mcp.json`, `.qwen/settings.json`) is treated as untrusted. The skill halts immediately, refuses to advise `mcp approve`, and notes that repository entries must be removed from the declaring project file.
- **Evaluator Registry Integrity:** The bootstrap verifies that the active registry is `https://registry.npmjs.org/`. If project configuration (`.npmrc`, `npm_config_registry`) redirects the package manager, registration halts; redirected resolution is classified as an identity mismatch rather than an accepted residual risk.
- **Full Configuration Restoration:** If a prior user-scope entry exists in `~/.qwen/settings.json`, its full configuration object is recorded and restored upon non-zero command exit or reachability failure.
- **Sandbox Fast-Path:** Inspection occurs before sandbox checks, allowing container-sandboxed sessions with mounted `~/.qwen` settings to reuse an existing reachable guardrail without requiring host re-installation.

### 2.4 Verdict Contracts and Execution Modes

- **Fail-Closed on Unscreened Packages:** If `check_dependency` returns `ALLOW` with `reasons` indicating that the package was not evaluated (network failure, private `.npmrc` mapping, or fail-open fallback), the skill halts and requests explicit user instructions rather than permitting unscreened installation.
- **Project Policy and Cache Gating:** Before checking packages, the skill inspects the repository for `.pkgdietrc.json`, `pkgdiet.config.json`, `package.json#pkgdiet`, and `.pkgdiet-cache.json`. Any active policy rules are disclosed to the user and treated as repository-declared. Reliance on committed `.pkgdiet-cache.json` files is refused.
- **Registry Alignment & Local Resolution:** Verdicts are valid only for packages hosted on `https://registry.npmjs.org` at latest. If resolution redirects via `--registry`, project `.npmrc`, user `~/.npmrc`, `npm_config_registry`, `.yarnrc.yml` (`npmRegistryServer`), `.yarnrc`, `bunfig.toml`, or lockfile, OR if the command executes an existing local binary (`node_modules/.bin`, `devDependencies`, scripts), the verdict is treated as not applicable and execution is halted.
- **Version Scoping:** Verdicts apply to the package at latest. Caching is not reused across differing pinned versions or ranges.
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
