# Mem0

Mem0 connects Qwen Code to an external memory service. It is included in the main CLI package: do not install `@qwen-code/external-context-mem0` or register a separate MCP server for this path.

## Connect

Set the provider credential in the shell that starts Qwen Code:

```sh
export MEM0_API_KEY='<your-provider-key>'
```

Merge this into user settings (`~/.qwen/settings.json`), then restart Qwen Code in a trusted project:

```json
{
  "memory": {
    "mem0": {
      "baseUrl": "https://your-mem0-endpoint.example",
      "protocol": "mem0-v2"
    }
  }
}
```

Use the endpoint origin, optionally with a reverse-proxy prefix; do not append `/v2/memories/search` or another operation path. Choose the contract your service actually implements:

- `mem0-v2` (default): PolarDB-style `Authorization: Token`, V2 search using `limit`, V1 write.
- `mem0-v3`: Mem0 Platform V3, `Authorization: Token`, V3 search/add.
- `mem0-oss-2026-08`: pinned OSS REST contract, `X-API-Key`, `/search` and `/memories`.

These are complete contracts, not universal version compatibility. Unknown versions and different request/response shapes need a verified adapter, not a renamed URL. Historical preset IDs remain accepted; `aliyun-polardb-mysql-2026-08` preserves its historical `top_k` search field.

A trusted PolarDB address such as `http://your-endpoint:8080` additionally needs `"allowInsecureHttp": true`. Plain HTTP sends the credential unencrypted. This setting does not make a private endpoint reachable or bypass IP whitelists.

Qwen automatically registers `external-context` and discovers `context_search`. Ask Qwen to search external memory; nothing is recalled or sent automatically at each turn. A separately configured server with the same name conflicts; remove that manual configuration when switching to the built-in path.

## Scope and writes

The default user/repository scope survives restart and starting from Git subdirectories. Moving the repository or using another checkout changes it. To reuse a known scope, set `scope.userId` for V2/OSS or `scope.appId` for V3; optional `scope.agentId` applies only to V2/OSS. Scope identifiers are not provider-side access controls.

Search is read-only by default. To enable saving, add `"enableWrites": true` inside `memory.mem0`, restart the interactive CLI, and ask Qwen to save specific content. The automatically installed Hook asks you to approve the exact content, including in YOLO mode. Rejecting sends no write request. Writes use `infer: false`.

Noninteractive/ACP sessions and sessions with Hooks disabled keep search only. Bare/safe mode, untrusted/provisional folders and SSH workspaces do not activate this local binding. Workspace settings cannot configure the binding.

`stored` means valid synchronous IDs were returned. `accepted` means an asynchronous request was accepted, not that persistence finished. `unknown` means the write may have happened: do not retry automatically.

## Options and troubleshooting

`credentialEnv` defaults to `MEM0_API_KEY`; use it to reference another exported variable. `timeoutMs` defaults to 5000, between 1 and 30000.

Check the MCP connection status for missing credentials and provider errors. A timeout requires checking endpoint routing, source-IP whitelists and service availability. A 401/403 requires checking the credential and selected protocol. Do not paste credentials into logs or issue reports.

For source checkouts, build and bundle once so `dist/mem0/main.js` and `dist/mem0/write-confirmation.js` exist. Installed main packages ship both. This feature needs a main CLI release containing the change; publishing a standalone Mem0 package is not required.
