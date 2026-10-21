# Mem0

Mem0 connects Qwen Code to an external memory service. It is included in the main CLI package: do not install `@qwen-code/external-context-mem0` or register a separate MCP server for this path.

## Connect

Merge this into user settings (`~/.qwen/settings.json`), then restart Qwen Code in a trusted project. Like `modelProviders`, `envKey` names the credential variable and the top-level `env` field can supply its value:

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

This single-file setup does not require a shell export. Credentials in JSON are plaintext: keep them in user settings, do not commit them to a repository, and avoid sharing the file in reports. Alternatively, omit the top-level `env` entry and set the key in the launching shell or `~/.qwen/.env`. Nonempty process environment values take precedence over `.env` values, which take precedence over `settings.env`.

Use the endpoint origin, optionally with a reverse-proxy prefix; do not append `/v2/memories/search` or another operation path. Choose the contract your service actually implements:

- `mem0-v2` (default): PolarDB-style `Authorization: Token`, V2 search using `limit`, V1 write.
- `mem0-v3`: Mem0 Platform V3, `Authorization: Token`, V3 search/add.
- `mem0-oss-2026-08`: pinned OSS REST contract, `X-API-Key`, `/search` and `/memories`.

These are complete contracts, not universal version compatibility. Unknown versions and different request/response shapes need a verified adapter, not a renamed URL. Historical preset IDs remain accepted; `aliyun-polardb-mysql-2026-08` preserves its historical `top_k` search field and raw search content.

A trusted PolarDB address such as `http://your-endpoint:8080` additionally needs `"allowInsecureHttp": true`. Plain HTTP sends the credential unencrypted. This setting does not make a private endpoint reachable or bypass IP whitelists.

Qwen automatically registers `external-context` and discovers `context_search`. Ask Qwen to search external memory; nothing is recalled or sent automatically at each turn. A same-named server in operator settings, session configuration or `--mcp-config` conflicts; remove that manual configuration when switching to the built-in path. Workspace settings and project `.mcp.json` entries of that name are overridden. Existing MCP precedence also shadows a same-named extension server, so disable the advanced external-context extension when using the bundled path. Remove its old manual write-confirmation Hook as well to avoid duplicate confirmations; a user Hook with the same matcher does not replace the bundled confirmation.

## Scope and writes

The default user/repository scope survives restart and starting from Git subdirectories. Moving the repository or using another checkout changes it, including temporary `--worktree` and agent-isolation worktrees. To reuse a known scope across worktrees, set `scope.userId` for V2/OSS or `scope.appId` for V3; optional `scope.agentId` applies only to V2/OSS. Scope identifiers are not provider-side access controls.

Search is read-only by default. To enable saving, add `"enableWrites": true` inside `memory.mem0`, restart the interactive CLI, and ask Qwen to save specific content. The automatically installed Hook asks you to approve the exact content, including in YOLO mode. Rejecting sends no write request. Writes use `infer: false`.

PolarDB can return a single-user message array encoded as JSON for these direct imports. `mem0-v2` restores that message's exact text when the result is marked `infer: false`; the historical `aliyun-polardb-mysql-2026-08` preset, ordinary text, and other protocols are left unchanged.

Noninteractive/ACP sessions and sessions with Hooks disabled keep search only. Bare/safe mode, untrusted/provisional folders and SSH workspaces do not activate this local binding. Workspace settings cannot configure the binding.

`stored` means valid synchronous IDs were returned. `accepted` means an asynchronous request was accepted, not that persistence finished. `failed` means a definitive rejection: fix the reported cause before retrying. `unknown` means the write may have happened: do not retry automatically.

## Options and troubleshooting

`envKey` defaults to `MEM0_API_KEY`; use it to reference another credential variable and define that value through any of the sources above. The historical `credentialEnv` field remains a compatible alias. If both fields are set, their names must match; conflicting names produce an error rather than silently selecting a credential. `timeoutMs` defaults to 5000, between 1 and 30000.

Check the MCP connection status for missing credentials and provider errors. A timeout requires checking endpoint routing, source-IP whitelists and service availability. A 401/403 requires checking the credential and selected protocol. Do not paste credentials into logs or issue reports.

For source checkouts, build and bundle once so `dist/mem0/main.js` and `dist/mem0/write-confirmation.js` exist. Installed main packages ship both. This feature needs a main CLI release containing the change; publishing a standalone Mem0 package is not required.
