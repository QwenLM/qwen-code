# Remote MCP provider extension example

This manifest is the preferred External Context Provider Extension Profile v1
shape for a provider-operated service.

Before release, the provider owner must:

1. Replace the extension and MCP server names with one stable,
   provider-specific name.
2. Replace the HTTPS MCP endpoint, OAuth read scope, and audience.
3. Implement exactly the `context_search` input and output contracts under
   `../../contracts/v1/`.
4. Keep `includeTools` restricted to `context_search`, even when the same MCP
   service exposes other tools.
5. Publish the Extension from a reviewed Git repository, archive, or scoped npm
   package. An npm release also needs provider-owned package metadata; this
   manifest-only example is directly usable from Git, an archive, or a local
   link.

The manifest contains no static credential and cannot set MCP `trust`. The MCP
service is responsible for OAuth authorization, token audience validation,
rate limiting, request bounds, output sanitization, and provider-side logging.

For a one-off deployment, skip the Extension and register the endpoint directly:

```bash
qwen mcp add \
  --scope project \
  --transport http \
  --include-tools context_search \
  --oauth-scopes context.read \
  --timeout 8000 \
  provider-context \
  https://context.example.com/mcp
```

The CLI does not currently expose an OAuth audience flag. If the provider
requires an explicit audience, use the manifest/configuration JSON above or add
`oauth.audiences` to the generated settings entry before authenticating.

The service should use a shorter internal Provider timeout than this 8000ms MCP
call budget so it can return the profile's stable, redacted error before the
client terminates the call.
