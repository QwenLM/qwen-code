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

- **Command-Based Identity Verification:** To prevent hostile repositories from intercepting package verdicts by committing a malicious `.mcp.json` that defines `pkgdiet`, the skill requires an exact command match (`npx -y pkgdiet@2.0.0 mcp`). If an existing entry specifies an alternative command, the skill halts and refuses approval advice.
- **Full Config Tier Inspection:** The skill inspects all configuration tiers (user, project, workspace, system) via `"${QWEN_CODE_CLI:-qwen}" mcp list`.
- **Restoration on Failure:** If a user-scope `pkgdiet` configuration was already present before registration, the prior configuration is recorded and restored if registration fails or reachability cannot be established.

### 2.4 Verdict Contracts and Execution Modes

- **Fail-Closed on Unscreened Packages:** If `check_dependency` returns `ALLOW` with `reasons` indicating that the package was not evaluated (network failure, private `.npmrc` mapping, or fail-open fallback), the skill halts and requests explicit user instructions rather than permitting unscreened installation.
- **Registry Alignment:** Verdicts are valid only for packages hosted on `https://registry.npmjs.org` at latest. If the installation command or project `.npmrc` redirects resolution to a private or alternate registry, the verdict is treated as not applicable.
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
