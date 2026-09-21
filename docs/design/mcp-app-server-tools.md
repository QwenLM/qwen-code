# MCP App server tool calls

[English](mcp-app-server-tools.md) | [简体中文](mcp-app-server-tools.zh-CN.md)

## Problem and scope

Tableau MCP App 4.8.1 loads its 335,305-byte HTML in Qwen WebShell but refuses to request an embed token because the host lacks `serverTools`. Amplitude also requires App-to-server calls. This change adds `tools/call` for Apps in a bound daemon session. Resource reads, tool listing, external navigation, and other host capabilities are outside scope.

The nested Tableau iframe also encounters `Origin: null` CORS failures under the original two opaque sandbox layers. This change adds isolated rendering origins to preserve the nested iframe's actual Tableau origin. Each render receives a random origin; stable `_meta.ui.domain` configuration remains unsupported.

## Design

Preserve the server-advertised App visibility through discovery and the existing connection pool. Keep an independent App tool lookup in ToolRegistry so App-only tools never enter model declarations, search, or deferred invocation. Apply the existing session server filters, disabled tools, and registry lifecycle to both directories.

WebShell supplies an execution callback bound to the transcript session. The AppBridge advertises `serverTools` only with that callback. The host pins the server and resource URI from the rendered App and accepts only an exact raw tool name and arguments from the iframe. A standalone transcript without a bound session remains display-only.

A mutation-protected REST endpoint resolves the live session owner and validates its registered client. It never falls back to another runtime. The bridge tracks each App call and its originating client separately from model prompts, forwards execution to that session's ACP child, and cancels on disconnection. The child requires an advertised App resource on the same server and an App-visible target tool. Closing sessions reject new calls and abort outstanding ones. Calls may coexist with model prompts; the existing permission queue serializes approval dialogs and the originating client is not inherited from the active model prompt.

Reuse Session.runTool for enablement, permission rules, approval modes, hooks, invocation guards and cancellation. A trusted internal App execution parameter supplies the validated tool and a buildForApp invocation. App execution preserves raw MCP content, structuredContent, isError and \_meta in a transient callback; the normal tool pipeline receives only a fixed summary. Do not send or persist the raw App result as model history, telemetry, hooks or transcript output. Do not reload App HTML for these calls.

Replacing a session attachment refreshes the App callback even when its session and client IDs are unchanged. App tool cards remain visible, but `mcp-app-` tool updates do not count as model generation and cannot restart Processing after the model turn finishes. Ordinary model tool activity remains unchanged.

The daemon's `/mcp-app-sandbox` route now returns only an uncached redirect. A lazily started, static-only HTTP listener binds to `127.0.0.1` on a random port. Each render gets a fresh `UUID.localhost` hostname on that listener, separating Apps from the daemon and from one another. It provides no daemon API, proxy or WebSocket endpoint. Only the exact registered Host, GET method and resource path can retrieve a document; other requests return 404.

A server-side registration pins the validated CSP and hostOrigin. Registrations expire after 60 seconds, with at most 256 pending entries, and are deleted before their sole successful response. Query parameters cannot alter the isolated document's policy or repopulate its consumed origin. Parent origins must be ordinary HTTP(S) loopback origins; sandbox subdomains are rejected. Sandbox origins are not added to the daemon's trusted origins, and its CORS, Host and bearer checks remain unchanged.

Both iframe layers permit scripts, forms and same-origin behavior while retaining sandbox restrictions on top navigation, popups and other ungranted capabilities. A nested Tableau iframe can therefore retain its own origin instead of `null`; the App does not acquire the daemon origin. The proxy checks the parent origin and both the child window and child origin. It also sends `Origin-Agent-Cluster: ?1`. The listener closure owns the registration map and disposer. Both application shutdown paths clear registrations and close connections. Closing during lazy startup rejects the pending start rather than leaving a request unresolved.

## Affected layers

- Core MCP discovery, DiscoveredMCPTool, ToolRegistry and their lifecycle tests.
- ACP Session and agent extension dispatch; daemon bridge, approval ownership and REST routing.
- TypeScript daemon client, WebShell session callback/AppBridge and model activity inference.
- Dedicated sandbox listener, policy registration and daemon shutdown integration.

## Validation and acceptance

Verify App-only discovery and model invisibility, same-server lookup, model-only/disabled/excluded tool denial, raw-result fidelity and absence of synthetic token markers in recorded output. Verify approval allow/deny, hooks, cancellation, session disposal and client/runtime ownership. Build, typecheck, focused tests and two clean self-audit passes precede submission.

Current verification: independent sandbox HTTP probes pass 12/12, complete-daemon origin-wall probes pass 14/14, CLI sandbox tests pass 14 tests, and Web App tests pass 17 tests. Full build, typecheck and bundle pass. These checks cover one-use origins, rejected policy overrides and API/WS paths, shutdown races, and sandbox-origin rejection by the real daemon. They do not establish successful Tableau chart rendering. Also verify attachment replacement and App success/failure after model completion while preserving ordinary model tool activity.

Use the unmodified official Tableau HTML in the actual built Qwen WebShell and the user's Chrome. The official Tableau 4.8.1 App has successfully rendered an authenticated Tableau Cloud chart in the built Qwen WebShell in the user's Chrome. Only model tool selection was made deterministic; the MCP HTML, OAuth, data and embedded Tableau chart were real. An earlier invalid-token fixture proved only the call path and is separate from this authenticated result. Changing the Region filter successfully updated the chart, and a full Qwen page reload restored the chart under a new isolated origin while leaving the Qwen input usable. Report these scopes separately and attach screenshots and loading observations to PR #12258 only after the corresponding behavior is verified.

## Risks and open questions

App tools can have side effects; no new bypass of existing permission or hook policy is permitted. Raw results may contain JWTs and must stay out of model/transcript output. Tableau authentication and embedding policy may reveal additional requirements after the host call succeeds. Browser verification supports the authenticated chart rendering result; untested interactions are not claimed.

A hostname alias on the daemon's own port still reaches its APIs and cannot replace the dedicated listener. Sharing one App origin would permit sibling Apps to access each other's documents, so origins remain unique per render. The random origin addresses nested-frame origin identity, not stable `_meta.ui.domain` support. Remote port forwarding and browsers beyond the tested local Chrome setup have not been verified; the extra loopback listener and `*.localhost` resolution need separate compatibility validation. Authenticated chart rendering, Region filtering and full Qwen page reload are verified in that local Chrome setup.
