# Browser Use Core Migration

## Status

The implementation is delivered as three stacked pull requests. Multi-session
support is part of the release design rather than deferred follow-up work.

## Goal

Bring Browser Use from `agent-browser-use` into Qwen Code while reusing Qwen's
existing Node REPL MCP server, Chrome extension identity, and product UI.

Browser Use is an SDK loaded inside the existing persistent `node_repl`. It is
not a second MCP server and does not provide another `node_repl` tool.

## Architecture

```text
Qwen Code
  -> existing Node REPL MCP server
  -> Browser Use SDK imported by model code
  -> Browser Core
  -> per-user Browser Broker
  -> Native Messaging host
  -> Qwen Chrome extension
  -> chrome.debugger / CDP
```

The first cell initializes the SDK with the existing Node REPL runtime:

```js
globalThis.agent ??= await (
  await import('@qwen-code/browser-use')
).setupBrowserRuntime(nodeRepl);
```

The SDK and Browser Core execute inside the persistent Node Kernel process.
Each Node Kernel owns one logical Browser session and connects to a shared
per-user Browser Broker. Qwen's existing timeout, cancellation, reset, and
process-exit behavior applies without adding Browser-specific scheduling or
protocol code to Node REPL.

```text
Node Kernel A -> Browser SDK/Core A --\
                                      -> Browser Broker -> Native Host -> Chrome
Node Kernel B -> Browser SDK/Core B --/
```

The Broker is the only process that owns the Chrome-extension transport. It
multiplexes Browser sessions over that connection, atomically leases tabs, and
routes tab events only to the owning session. A second Node Kernel therefore
does not compete for the Native Host socket.

## Ownership

- **Node REPL** remains the generic persistent JavaScript runtime and the only
  MCP server used by Browser Use.
- **Browser SDK** provides the model-facing Browser, Tab, Locator, and CUA
  objects inside the existing Node REPL process.
- **Browser Core** owns tab state, document identity, navigation, frames,
  trusted input, screenshots, diagnostics, downloads, uploads, and policy.
- **Browser Broker** owns the process-global Chrome connection, Browser session
  registry, tab leases, and request/event routing. It does not execute model
  code or Browser Core operations.
- **Native Host** remains a framed-message relay between the Broker and Chrome.
- **Chrome extension** owns Chrome permissions and `chrome.debugger` access.

Browser-specific dispatch, policy, audit, and lifecycle logic stays in the
Browser Use package. Node REPL does not gain Browser APIs, a Host Call protocol,
or a Browser-specific programmatic wrapper.

## Multi-session semantics

- Each Browser SDK process establishes one Broker session.
- Repeated setup inside one Node Kernel reuses the same SDK singleton and
  Broker session.
- Tabs created by a session are leased to that session.
- `claimTab()` atomically leases an unowned tab. Claiming a tab leased by
  another live session fails closed with `TAB_ALREADY_CLAIMED`.
- CDP commands, downloads, and tab mutations require the caller to own the tab.
- CDP and lifecycle events are delivered only to the tab owner. Derived popup
  tabs inherit the opener's owner.
- `openTabs()` and bounded History queries are browser-level read operations;
  they do not acquire a tab lease.
- A client disconnect releases its leases after debugger cleanup. Chrome or
  Native Host reconnects preserve live session leases and force each Browser
  Core to resynchronize its claimed tabs.
- Broker failure disconnects every client. Clients reconnect through the same
  protocol; no client may silently fall back to a direct Chrome connection.

## Product decisions

- Installing the Qwen Chrome extension authorizes Browser Use for this release.
- Browser Use may enumerate and claim top-level HTTP(S) tabs by default.
- Browser history uses the optional `history` permission. A dedicated extension
  options surface grants or revokes it; the side panel does not manage it.
- The Qwen toolbar action and side panel remain unchanged.
- The side panel does not manage Browser Use or History permissions.
- A user-facing Browser Use opt-in setting is deferred.

## Delivery plan

The migration is delivered as three stacked pull requests. The Browser Use
package remains internal until the final product-integration pull request.

### PR 1: Browser runtime and multi-session Broker

Add the internal Browser Use package, Browser Core, the model-facing SDK, and
the shared Broker process. Include session lifecycle, atomic tab leases, event
isolation, version negotiation, and deterministic tests. The SDK runs inside
the existing Node REPL, does not register an MCP server, and must not fall back
to direct socket ownership.

### PR 2: Chrome extension, Native Messaging, and permissions

Connect Browser Core to the existing Qwen Chrome extension. Add the required
Chrome permissions, optional History permission flow, event forwarding, Native
Host installation, tab discovery, claim behavior, session-aware tab grouping,
and managed-Chrome verification.

### PR 3: Qwen integration and acceptance

Expose the Browser Use package through the Qwen extension and ship its skill
and installation path. Add two-Node-REPL and model-driven acceptance tests,
including SauceDemo checkout.

```text
PR 1: Browser runtime and multi-session Broker
  -> PR 2: Chrome, Native Messaging, and permissions
    -> PR 3: Qwen integration and acceptance
```

## Acceptance criteria

- Qwen exposes only the existing Node REPL MCP tools.
- Browser Use can be imported and initialized inside that Node REPL.
- Browser SDK state persists across cells and resets with the Node Kernel.
- Node REPL contains no Browser-specific runtime implementation.
- Two independent Node REPL processes can use Browser Use concurrently on
  different tabs.
- A tab has at most one live Browser session owner, and ownership is released
  when that session exits.
- Browser events and page data never cross Browser session boundaries.
- Browser actions use the existing Qwen Chrome extension and trusted CDP input.
- Browser reads and writes obey the configured origin and upload policies.
- Audit output is bounded and excludes typed secrets and sensitive page data.
- Managed-Chrome tests validate the transport and trusted input path.
- The model-driven SauceDemo smoke completes checkout through Browser Use.

## Deferred work

- A user-facing Qwen setting that makes Browser Use explicitly opt-in.
- Strong authentication between same-user local processes.
- Windows Native Host release validation.
- Additional Browser capabilities not required by the acceptance tests.
