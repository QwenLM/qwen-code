# Bundled Mem0

[English](bundled-mem0.md) | [简体中文](bundled-mem0.zh-CN.md)

Status: implemented; PolarDB V2 was verified through a private tunnel, not public-direct access. Other provider contracts remain bounded by their recorded evidence.

## Problem and scope

[#12596](https://github.com/QwenLM/qwen-code/issues/12596) asks for Mem0 from a normal Qwen Code installation. Requiring an unpublished package, separate MCP configuration, and a manually installed write-confirmation Hook does not meet that goal. [#9964](https://github.com/QwenLM/qwen-code/issues/9964) additionally requires interactive OSS write coverage.

Deliver configurable search and opt-in writes with the main CLI. Do not implement arbitrary REST dialects, unknown protocol versions, automatic recall, or a new service. Existing advanced configurations remain supported. This design supersedes the administrator-only, separately installed delivery requirement of earlier direct-external-context designs for this opt-in built-in path.

## Configuration and contract

Add to user settings (`~/.qwen/settings.json`), then restart Qwen Code. As with `modelProviders`, the top-level `env` field can define the credential value and `envKey` selects its name:

```json
{
  "env": {
    "MEM0_API_KEY": "<your-provider-key>"
  },
  "memory": {
    "mem0": {
      "baseUrl": "https://your-mem0-endpoint.example",
      "protocol": "mem0-v2",
      "envKey": "MEM0_API_KEY"
    }
  }
}
```

`envKey` defaults to `MEM0_API_KEY`. The historical `credentialEnv` remains an alias; unequal names supplied together are rejected. Neither field contains a key value. Reuse the existing environment loader: nonempty process values take precedence over `.env`, then `settings.env`. The MCP process inherits the resolved environment; generated binding configuration contains only the variable reference, not the credential. No new credential store or loader is introduced. The single-file setup needs no shell export, but JSON stores plaintext credentials; use user settings and never commit or publish them. Shell exports and `~/.qwen/.env` remain alternatives.

`baseUrl` is an origin plus optional reverse-proxy prefix, not a full operation URL. Credentials, query, fragment, whitespace and backslashes are rejected. HTTPS is required except loopback HTTP; a trusted plain-HTTP PolarDB endpoint requires `"allowInsecureHttp": true`. This does not bypass routing or provider whitelists.

`protocol` selects a complete contract, not just a version number appended to a URL:

| ID                  | Authentication         | Search                          | Write                                    | Scope                                 |
| ------------------- | ---------------------- | ------------------------------- | ---------------------------------------- | ------------------------------------- |
| `mem0-v2` (default) | `Authorization: Token` | `/v2/memories/search`, `limit`  | `/v1/memories`, synchronous IDs          | required `userId`; optional `agentId` |
| `mem0-v3`           | `Authorization: Token` | `/v3/memories/search/`, `top_k` | `/v3/memories/add/`, asynchronous status | required `appId`                      |
| `mem0-oss-2026-08`  | `X-API-Key`            | `/search`, `top_k`              | `/memories`, synchronous IDs             | required `userId`; optional `agentId` |

The default is the PolarDB-style v1-write/v2-search contract, not a guarantee for every “Mem0 v2” service or Hologres. The OSS contract is pinned to the existing integration; fake-server acceptance does not prove compatibility with every upstream OSS release.

Legacy IDs `mem0-platform-v3` and `mem0-oss-rest-2026-08` remain aliases. `aliyun-polardb-mysql-2026-08` remains accepted with its historical `top_k` field and raw search content, not silently remapped to `limit` or V2 normalization. Private-tunnel acceptance verified `mem0-v2` limit handling and direct-import text; this does not certify public routing or every service. The adapter always caps final search results at five.

## Binding and lifecycle

Only user, system and system-defaults settings may configure the binding. Workspace settings cannot enable it, redirect its endpoint, change scope, or erase an operator binding by replacing the parent `memory` field.

The CLI creates an `external-context` stdio MCP server running its shipped `mem0/main.js`. It exposes `context_search` by default and installs no auto-recall hooks. Explicit operator settings/session/CLI servers named `external-context` produce a configuration conflict; the built-in binding takes precedence over workspace settings and project `.mcp.json` entries. Existing MCP precedence also shadows a same-named extension server; disable the advanced external-context extension when selecting the bundled path. Remove its obsolete manual confirmation Hook too, or both confirmations may run. A user Hook with the same matcher does not replace the mandatory bundled confirmation.

Default scope: `qwen-` plus the first 32 hex characters of SHA-256 over local home directory, newline, and canonical Git root (canonical current directory outside Git). Restarts and Git subdirectories retain scope; a different checkout or moved repository gets another, including temporary `--worktree` and agent-isolation worktrees. The hash is an identifier, not provider-side authorization. To reuse existing memory or intentionally share scope across worktrees, set `scope.userId` (V2/OSS) or `scope.appId` (V3), and optional `scope.agentId` where supported.

Bare, safe, untrusted, provisional and SSH-workspace sessions do not activate this local binding. Noninteractive/ACP sessions and sessions with Hooks disabled retain search but omit writes even when enabled in settings. Restart reloads settings; `/hooks` reload retains the active binding's confirmation Hook.

## Writes and failure semantics

`"enableWrites": true` exposes `context_remember` in interactive CLI sessions with Hooks enabled. Qwen installs the existing exact-content confirmation Hook automatically. Normal MCP permissions still apply; YOLO retains content confirmation. Cancellation issues no write request. Writes send `infer: false` and only approved content.

Valid synchronous IDs mean `stored`; a V3 accepted event means `accepted`, not completed persistence. A definitive rejection is `failed`; fix the reported cause before retrying. Ambiguous transport/response failures are `unknown` and must not automatically retry. Confirmation is an application UX safeguard, not enforceable isolation against a local operator who can alter Hooks or call the service directly.

`timeoutMs` defaults to 5000, bounded to 1–30000. Missing credentials/runtime, unsupported configuration and service errors remain visible; no alternate provider is selected.

## Distribution and compatibility

Reuse the direct external-context adapter, MCP and confirmation code. Bundle self-contained `dist/mem0/main.js` and `dist/mem0/write-confirmation.js`, without another npm dependency or publication. npm and standalone packaging reject missing runtime files and include the `mem0` directory.

The generic dialect integration remains an advanced path. This change does not migrate administrator-authored configurations or claim complete removal/consolidation of both implementations. Removing standalone publication paths is a separate compatibility decision, not a prerequisite for main-package usability.

## Validation and acceptance

1. Unit checks: generated endpoint/protocol/scope, `envKey`/legacy-alias compatibility and conflicts, credential nonserialization, read-only defaults, interactive-only writes, Hook composition and workspace isolation.
2. Packaging: both runtime files required for npm/standalone; a packaged stdio client discovers tools and searches without a separately published package.
3. Controlled-provider interactive checks: V3/OSS approval, cancellation with no HTTP write, YOLO content confirmation. OSS uses `memory.mem0.envKey` with its credential defined only in `settings.env`, not a shell export or hand-authored MCP/Hook configuration. These interactive scenarios run locally and in the release lane, not in PR CI; green PR checks alone do not prove this interaction.
4. Separate live PolarDB acceptance: auth, slash behavior, `limit`, approved write IDs, restart/search with identical scope, targeted cleanup. Never print or commit credentials.

Until step 4 succeeds, report packaged/controlled-provider validation, not real PolarDB end-to-end validation. External gates are credentials, reachable/whitelisted access, and inclusion in a released main CLI version; no standalone Mem0 npm release is needed.
