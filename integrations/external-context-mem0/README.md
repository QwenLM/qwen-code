# Mem0 External Context Extension

This package is the retrieval-only Extension defined by the
[Configurable Mem0 Provider Extension](../../docs/design/external-context-mem0-extension.md)
proposal. It implements the External Context MCP Profile v1 server, validates
administrator-owned instance configuration and closed dialect definitions, and
contains a bounded HTTP request engine.

This PR1 package intentionally ships no live provider preset. Its built-in
preset registry is empty, so the process fails closed with an unknown-preset
configuration error. Verified Mem0 Platform and PolarDB presets are staged for
PR2. Do not install this intermediate package as a usable provider Extension.

## Configuration contract

`QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG` must contain the absolute path of an
instance JSON file conforming to
[`schemas/instance-config.schema.json`](./schemas/instance-config.schema.json).
The instance selects one immutable built-in preset and binds its endpoint,
credential environment-variable name, scope, and timeout. Credential values
never belong in the instance file.

Preset authors must conform to
[`schemas/dialect.schema.json`](./schemas/dialect.schema.json). The schema and
semantic validator intentionally support only the bounded request and response
grammar recorded in the design. Protocols that require arbitrary templates,
headers, JSONPath, redirects, or executable transformations must use a separate
MCP Extension.

## Development

```bash
npm run test --workspace=@qwen-code/external-context-mem0
npm run typecheck --workspace=@qwen-code/external-context-mem0
npm run build --workspace=@qwen-code/external-context-mem0
```

The tests use synthetic dialect and provider-response fixtures only. They make
no request to a live memory service.
