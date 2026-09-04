# Local REST provider extension example

This directory is a copyable starting point for a provider team that has an
existing REST API but no remote MCP endpoint. The provider team owns the copy,
its release process, and all API-specific behavior.

## Customize

1. Rename the package, Extension, and MCP server to one stable,
   provider-specific name.
   Keep this repository copy private; if the provider intentionally publishes a
   scoped npm package, remove `"private": true` only in that reviewed copy.
2. Replace the environment-variable names in `qwen-extension.json` and
   `src/provider.ts`.
3. Replace only the API mapping in `src/provider.ts`. Do not add model-selected
   endpoints, tenants, repositories, namespaces, or filters.
4. Keep the `context_search` schemas and result limits in `src/profile.ts`
   aligned with `../../contracts/v1/`.
5. Add provider-specific tests for authentication, request mapping, malformed
   responses, timeouts, cancellation, and secret redaction.

The example endpoint accepts the same small Generic HTTP Search V1 shape as the
private reference integration:

```http
POST /v1/context/search
Authorization: Bearer <credential>
Content-Type: application/json

{"query":"normalized query","limit":5}
```

Configure the environment in an administrator-controlled launcher or trusted
Qwen environment:

```bash
export PROVIDER_CONTEXT_BASE_URL=https://context.example.com
export PROVIDER_CONTEXT_TOKEN=replace-me
```

For a managed launch, export both values before starting Qwen. Qwen loads
trusted repository `.env` and `.qwen/.env` files before resolving this
manifest; those files can fill a missing value but cannot override an existing
process environment value. Treat the repository, its environment files, and
same-UID code as trusted, or use a separately isolated service boundary.

Do not commit a credential to the manifest. This example intentionally does
not declare Extension `settings` as a credential path until Qwen's complete
settings-to-MCP-child runtime path has a passing E2E.

Outbound Provider requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

## Build and test locally

```bash
npm install
npm run typecheck
npm run build
qwen extensions link "$PWD"
```

`npm run build` bundles the MCP server and its runtime dependencies into
`dist/main.js`. Publish only after that file is present and the provider's own
contract and security tests pass. Installing a released Extension must not need
to run `npm install` or an install script on the user's machine.

Keep the MCP call timeout longer than the adapter's Provider timeout. This
example gives the Provider request 5000ms and Qwen's MCP call 8000ms so the
adapter can return a stable, redacted error after aborting the request.
