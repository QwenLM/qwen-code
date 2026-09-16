# VS Code remote webview daemon URL

[中文版](./vscode-remote-webview-daemon-url.zh-CN.md)

## Problem

In a remote window (Remote-SSH, Dev Containers, WSL) the companion spawns `qwen serve` as a child of the extension host, so the daemon binds a random port on the _remote_ machine's loopback (`packages/vscode-ide-companion/src/services/qwenDaemonProcess.ts`: `--hostname 127.0.0.1 --port 0`, URL scraped off stdout). The webview renderer lives in the local desktop client. `WebViewProvider` spread the scraped `runtime.baseUrl` into the `webShellBootstrap` payload unchanged, so the embedded Web Shell fetched `http://127.0.0.1:<port>/capabilities` against the client's own loopback. Every request failed with `ERR_CONNECTION_REFUSED`, surfaced as "Failed to load workspace". Forwarding the port by hand in VS Code's PORTS panel worked until the next extension host restart, which minted a new port (#11976).

Two further gates made a bare `vscode.env.asExternalUri()` call insufficient:

- The webview CSP hardcoded `connect-src http://127.0.0.1:* ws://127.0.0.1:*` (`WebViewContent.ts`), which matches neither the forwarded `localhost` origin nor the `ws:` upgrade the shell performs on top of that URL (`web-shell/client/local-files/bridge-client.ts`, `web-shell/client/voice/useVoiceCapture.ts`). Resolving the URL alone trades a connection refusal for a CSP violation.
- `validateDaemonBaseUrl()` (`services/daemonIdeConnection.ts`) accepts loopback hosts only, so the resolved URL must not replace the daemon URL everywhere. That loopback-only invariant is deliberate; see `docs/developers/daemon/16-vscode-ide-adapter.md`.

## Decision

- Remote awareness is gated on `vscode.env.remoteName`. A local window keeps the previous path unchanged.
- The webview-facing URL is resolved per bootstrap. `WebViewProvider.resolveWebviewDaemonBaseUrl()` calls `vscode.env.asExternalUri()` on the daemon's loopback URL, and the result overrides `baseUrl` in the `webShellBootstrap` payload only. Nothing caches it: a restarted extension host forwards to a fresh client-side port.
- The host side keeps the raw loopback URL. `runtime` is not mutated, so the extension host's own use of it and the daemon adapter's loopback-only invariant are untouched.
- The resolution must still be a loopback address. `resolveWebviewDaemonBaseUrl()` reuses `isLoopbackHostname()` from `services/daemonIdeConnection.ts` and throws otherwise, which the existing bootstrap handler surfaces as `webShellBootstrapError`. The resolved URL shares its payload with the daemon's bearer token, so a relay origin would put that token one CSP relaxation away from a third-party host. Failing closed keeps the token on the host and turns an unsupported remote into an explicit message instead of a DevTools-only CSP violation.
- In remote windows the CSP `connect-src` gains `http://localhost:* ws://localhost:*`, gated on `vscode.env.remoteName` rather than derived from the resolved origin. The HTML is generated in `resolveWebviewView` and at panel creation, before any daemon exists — `daemonProcess.start()` runs only inside the `webShellReady` handler — so the resolved origin is not knowable when the policy is written. A local window's policy stays as narrow as before.
- The daemon needs no change: it is already spawned with `--allow-origin '*'`, so the forwarded origin passes CORS.

## Scope

Covers the daemon URL handed to the embedded Web Shell and the webview CSP. It does not change:

- the MCP IDE server (`ide-server.ts`), whose consumer is the co-located CLI and which already works remotely after #11624;
- the daemon's loopback-only bind posture (`packages/cli/src/serve/loopback-binds.ts`);
- browser-based remotes (vscode.dev tunnels, Codespaces web), where `asExternalUri` returns an HTTPS relay origin instead of a forwarded `localhost`. Enumerating those domains would be guesswork, and for the reason above the policy cannot be derived per bootstrap. Such a window now fails closed with an explicit message rather than mounting a shell that cannot reach anything; supporting it is follow-up work, and whoever relaxes the CSP for it must first decide where the bearer token is allowed to go.

Known limitation: the daemon's Host allowlist (`packages/cli/src/serve/auth.ts`, `hostAllowlist`) accepts only `<host>:<daemon port>`. VS Code normally forwards to the same port number — which is why manual forwarding works today — but if the client-side port differs, the daemon answers `403 Invalid Host header`. Relaxing that DNS-rebinding defense is a separate, security-sensitive decision and is not part of this change.

## Verification

- Unit, `WebViewProvider`: in a remote window the payload carries the resolved URL while `asExternalUri` is fed the loopback one; in a local window the payload is unchanged and `asExternalUri` is never called; two bootstraps produce two resolutions, so a cached URL cannot survive a restart; a relay-origin resolution posts no bootstrap at all and surfaces an error instead.
- Unit, `WebViewContent`: `connect-src` stays loopback-only locally and gains the `localhost` HTTP/WS pair remotely.
- The four behavioural tests fail without the fix. The two local-window tests pass either way and exist to pin that the local path did not widen.
- End-to-end confirmation needs a real Remote-SSH or Dev Container window with a desktop client and cannot run headless; the manual steps live in the E2E test plan.
