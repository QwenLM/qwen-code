# Mem0 External Context Extension

This package provides a retrieval-only External Context MCP Profile v1 server
for administrator-configured Mem0-compatible HTTP services. It validates a
closed dialect grammar and uses a bounded HTTP request engine; it does not ship
provider presets or provider-specific configuration.

## Installation

Install the published Extension with Qwen Code:

```bash
qwen extensions install @qwen-code/external-context-mem0
```

This command becomes available after the package's first registry release.

Use an explicit package version when the deployment must remain pinned:

```bash
qwen extensions install @qwen-code/external-context-mem0@x.y.z
```

The Extension version follows the Qwen Code release version. Installing the
package does not configure a memory service or install provider data; an
administrator must supply the two files and credential environment described
below.

## Configuration

Set `QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG` in the Extension process environment to
the absolute path of an administrator-owned instance JSON file. The instance
file must conform to
[`schemas/instance-config.schema.json`](./schemas/instance-config.schema.json)
and reference a separate dialect JSON file by absolute `dialectPath`:

```json
{
  "schemaVersion": 2,
  "dialectPath": "/etc/qwen/external-context/memory.dialect.json",
  "endpoint": {
    "origin": "https://memory.example.com",
    "basePath": "",
    "allowInsecureHttp": false
  },
  "credentialEnv": "MEMORY_API_KEY",
  "scope": {
    "userId": "repository-memory"
  },
  "timeoutMs": 5000
}
```

The dialect file must conform to
[`schemas/dialect.schema.json`](./schemas/dialect.schema.json). This synthetic
example describes one supported shape without identifying a provider:

```json
{
  "dialectVersion": 1,
  "id": "organization-memory-v1",
  "auth": "authorization-bearer",
  "search": {
    "method": "POST",
    "path": "/memories/search",
    "queryLocation": "json",
    "userIdLocation": "json.filters",
    "agentIdLocation": "omit",
    "appIdLocation": "omit",
    "limitField": "limit"
  },
  "response": {
    "collection": "results",
    "idField": "id",
    "contentField": "memory",
    "titleField": "omit",
    "uriField": "omit",
    "scoreField": "score",
    "updatedAtField": "omit"
  }
}
```

The administrator controls both files and the process environment. Production
deployments should keep them outside ordinary workspaces and supply the
instance path through a system environment, controlled launcher, or pinned MCP
configuration. `dialectPath` is never resolved relative to the instance file,
expanded from environment variables, or loaded from a URL.

The credential value must exist only in the environment variable named by
`credentialEnv`; neither JSON file may contain it. Both files are limited to
64 KiB and are read once when the Extension starts. Restart the Extension after
changing either file.

The schema intentionally supports only the bounded request and response
grammar recorded in the design. Protocols that require arbitrary templates,
headers, JSONPath, redirects, executable transformations, or write operations
must use a separate MCP Extension.

## Development

```bash
npm run test --workspace=@qwen-code/external-context-mem0
npm run typecheck --workspace=@qwen-code/external-context-mem0
npm run lint --workspace=@qwen-code/external-context-mem0
npm run build --workspace=@qwen-code/external-context-mem0
```

The tests use synthetic dialect and provider-response fixtures only. They make
no request to a live memory service.
