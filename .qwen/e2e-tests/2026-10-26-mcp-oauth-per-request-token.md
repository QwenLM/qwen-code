# MCP OAuth bearer token is refreshed per request

## Automated verification

Run the focused Core tests:

```bash
cd packages/core
npx vitest run src/tools/mcp-client-oauth-token.test.ts
npx vitest run src/mcp/oauth-provider.test.ts
npx vitest run src/tools/mcp-client.test.ts
```

Then run repository verification:

```bash
npm run format
npm run lint
npm run build
npm run typecheck
```

## Manual scenario

Reproduction needs a Streamable HTTP MCP server protected by OAuth (401 plus
protected-resource metadata, no `oauth` block in settings) whose authorization
server issues short-lived access tokens (for example `expires_in=420`) and
rotates refresh tokens. Log the server's token endpoint and MCP requests.

1. Start `qwen serve --port <port> --workspace <dir>` from the source build,
   add the server, and authenticate it once from `/mcp` so credentials are
   stored.
2. Open a session and call one tool of the server. Confirm it succeeds.
3. Keep the same session open until the access token is past its refresh
   buffer (about half of its lifetime for short-lived tokens, five minutes
   before expiry otherwise), then call the tool again in the same session.
4. Confirm the call succeeds and the debug log has no `silent transport drop`
   or `SessionMcpView ... torn down` entry for the server.
5. Confirm the authorization server saw exactly one refresh request for the
   crossing, and the MCP server saw the new access token on the later call.
6. Fire several tool calls concurrently across the same crossing and confirm
   there is still a single refresh request and no re-authentication prompt.

## Regression checks

- A token with no `expires_in` is never refreshed by the per-request path.
- A token that lives less than five minutes is not refreshed on every request.
- A dynamically registered client (`oauth: { enabled: true }` without
  `clientId`) refreshes with the client id stored at registration.
- Custom `headers` from the server config still reach the server.
- A server with no stored credentials sends no `Authorization` header.
- A due token that cannot be refreshed keeps being sent until it actually
  expires. After that (or once the credentials are gone when the token is
  next due), HTTP and SSE requests carry no OAuth bearer rather than the
  connect-time one; an `Authorization` header from the server config is then
  sent unchanged.
- A failed refresh still removes the stored credentials and the next
  connection asks the user to authenticate again.

## Baseline status

Before the change, step 4 fails: the pooled connection keeps sending the
access token captured at connect time, the server answers 401 once it
expires, the pool tears down the session view, and the in-flight tool call
fails; only a new session recovers.
