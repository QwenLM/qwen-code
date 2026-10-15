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
- The resolution must still be a loopback address. `resolveWebviewDaemonBaseUrl()` reuses `isLoopbackHostname()` from `services/daemonIdeConnection.ts` and throws otherwise, which the existing bootstrap handler surfaces as `webShellBootstrapError`. It also rejects a bracketed IPv6 literal before that predicate, even though the shared predicate accepts `[::1]`: Chromium treats bracketed IPv6 CSP host-sources as invalid and ignores them, so `WebViewContent.ts` cannot grant the resolved origin. This matches the existing refusals in `packages/web-shell/client/config/daemon.ts` and `packages/cli/src/serve/web-shell-static.ts` without narrowing the extension host's own loopback support. The resolved URL shares its payload with the daemon's bearer token, so a relay origin would put that token one CSP relaxation away from a third-party host. Failing closed keeps the token on the host and turns an unsupported remote into an explicit message instead of a DevTools-only CSP violation.
- In remote windows the CSP `connect-src` gains `http://localhost:* ws://localhost:*`, gated on `vscode.env.remoteName` rather than derived from the resolved origin. The HTML is generated in `resolveWebviewView` and at panel creation, before any daemon exists — `daemonProcess.start()` runs only inside the `webShellReady` handler — so the resolved origin is not knowable when the policy is written. A local window's policy stays as narrow as before. No separate `wss:` or `https:` entry is needed: under CSP scheme matching an `http:` source also matches `https:` and a `ws:` source also matches `wss:`, confirmed in headless Chromium against both policy variants.
- The daemon needs no change: it is already spawned with `--allow-origin '*'`, so the forwarded origin passes CORS.

## Scope

Covers the daemon URL handed to the embedded Web Shell and the webview CSP. It does not change:

- the MCP IDE server (`ide-server.ts`), whose consumer is the co-located CLI and which already works remotely after #11624;
- the daemon's loopback-only bind posture (`packages/cli/src/serve/loopback-binds.ts`);
- browser-based remotes (vscode.dev tunnels, Codespaces web), where `asExternalUri` returns an HTTPS relay origin instead of a forwarded `localhost`. Enumerating those domains would be guesswork, and for the reason above the policy cannot be derived per bootstrap. Such a window now fails closed with an explicit message rather than mounting a shell that cannot reach anything; supporting it is follow-up work, and whoever relaxes the CSP for it must first decide where the bearer token is allowed to go.

A tunnel resolution to a bracketed IPv6 literal is also unsupported and fails closed with an explicit message. Headless Chromium rejects the bare-host, concrete-port, and wildcard-port forms as invalid CSP host-sources, and `http://localhost:*` does not cover an `http://[::1]:<port>` request. Supporting that resolution therefore requires a browser-compatible policy representation rather than removing the guard.

Known limitation, measured against a real daemon rather than inferred: the Host allowlist (`packages/cli/src/serve/auth.ts`, `hostAllowlist`) accepts only `<host>:<daemon port>`, and it rejects **before** authentication. `Host: localhost:<daemon port>` returns 200; the same request with any other port in the Host returns `403 {"error":"Invalid Host header"}` even when it carries a valid bearer token — omitting the token instead yields 401 for the allowlisted Host and still 403 for the other, which pins the ordering. VS Code's forwarding usually reuses the daemon's port number, which is why manual forwarding works today, so the common path passes; when the client-side port differs the shell gets a 403 instead of a workspace. A raw TCP forward preserves the Host header and therefore hits this, while a proxy that rewrites Host to the daemon's own authority does not. Relaxing that DNS-rebinding defense is a separate, security-sensitive decision and is not part of this change.

## Verification

- Unit, `WebViewProvider`: in a remote window the payload carries the resolved URL while `asExternalUri` is fed the loopback one; in a local window the payload is unchanged and `asExternalUri` is never called; two bootstraps produce two resolutions, so a cached URL cannot survive a restart; relay-origin and bracketed IPv6 resolutions post no bootstrap at all and surface an error instead.
- Unit, `WebViewContent`: `connect-src` stays loopback-only locally and gains the `localhost` HTTP/WS pair remotely.
- The five behavioural tests fail without the fix. The two local-window tests pass either way and exist to pin that the local path did not widen.
- Mechanism, reproduced without a desktop client: the real CLI was started inside a Docker container using the extension's exact argv, with its URL scraped by the extension's exact regex. From inside the container `/capabilities` returns 200; the identical `http://127.0.0.1:<port>` request from the host is refused — the reported failure, with no stand-in process. Both CSP variants were then loaded in headless Chromium with the delivered policy read back from the DOM: the pre-change policy blocks `http://localhost:<port>` and `ws://localhost:<port>` with a `connect-src` violation, the post-change policy allows both, and `wss://localhost:<port>` is allowed by the `ws:` source in both. A separate Chromium probe confirmed that bracketed IPv6 host-sources with no port, a concrete port, or a wildcard port are all ignored as invalid; the valid `127.0.0.1` source remains active, while `localhost` does not cover a literal `[::1]` request.
- End-to-end confirmation needs a real Remote-SSH or Dev Container window with a desktop client and cannot run headless; the manual steps live in the E2E test plan. What the mechanism-level probes cannot cover is VS Code's own tunnel — in particular whether a live window reuses the daemon's port (200) or gets a different one (403).
