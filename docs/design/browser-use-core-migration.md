# Browser Use Core Migration

## Status

Implementation ready for staged delivery.

## Goal

Bring the Browser Use capabilities from `agent-browser-use` into Qwen Code
while preserving Qwen's existing Node runtime, Chrome extension identity, and
product UI.

The result should provide persistent browser automation through Qwen's
`node_repl`, including tab management, semantic DOM interaction, trusted input,
navigation, frames, screenshots, diagnostics, downloads, uploads, and browser
history.

## Design principles

### Keep the Node Kernel generic

Qwen's existing Node Kernel remains the shared JavaScript runtime. It continues
to own process isolation, persistent bindings, cancellation, output budgets,
and detection of unfinished operations.

The Kernel may expose a generic host-capability channel, but it must not contain
Browser, Tab, Locator, Playwright, CUA, History, or Chrome-specific behavior.
Browser functionality is installed and dispatched by Browser Use itself.

### Keep Browser Use in one Qwen package

Browser Core, the Browser SDK, the Qwen adapter, transport, Native Messaging
host, skill, and integration scripts remain within a single internal
`browser-use` workspace package. Separate upstream module boundaries may be
preserved inside that package, but they do not become additional Qwen workspace
packages without a second real consumer.

### Reuse Qwen product surfaces

The migration keeps the existing Qwen Chrome extension, extension identity,
toolbar action, and side panel. The reference implementation supplies browser
runtime behavior, not Qwen's product shell.

Installing the Chrome extension is the Browser Use authorization event for this
release. Browser Use may enumerate and claim top-level HTTP(S) tabs by default.
The side panel does not own Browser Use or History permission management.

### Keep policy outside page execution

Origin restrictions, tab ownership, audit records, and sensitive-data
redaction remain in trusted host code. Page JavaScript and model-generated code
must not be treated as trusted audit evidence.

## Architecture

```text
Qwen Browser Use MCP
  -> Browser Use SDK
  -> generic Node REPL host capability
  -> Qwen Browser adapter
  -> Browser Core
  -> local Chrome transport and Native Messaging host
  -> Qwen Chrome extension
  -> chrome.debugger / CDP
```

The layers have the following ownership:

- **Node REPL** provides only the generic execution and host-capability
  lifecycle.
- **Browser SDK** provides the model-facing Browser, Tab, Locator, and CUA
  objects.
- **Browser adapter** applies Qwen policy and produces trusted, bounded audit
  records.
- **Browser Core** owns model-independent behavior such as tab state,
  document identity, navigation, frames, input, screenshots, diagnostics, and
  concurrency.
- **Chrome transport** carries Browser Core requests and CDP events between the
  Qwen process and Chrome.
- **Chrome extension** owns Chrome permissions and access to
  `chrome.debugger`.

## Delivery plan

The migration is delivered as four stacked pull requests. Each pull request is
independently reviewable and uses the previous pull request as its base.

### PR 1: Generic Node REPL host capability

Add the capability-neutral request channel, lifecycle tracking, structured
errors, cancellation behavior, and unfinished-call detection to Node REPL.

This pull request must be useful without Browser Use and must contain no
browser-specific API or naming.

### PR 2: Browser Core and Browser SDK

Add the internal Browser Use package, model-neutral browser runtime, Qwen
adapter, model-facing SDK, and deterministic unit tests using a fake Chrome
bridge.

This pull request establishes browser behavior but does not yet connect the
Qwen Chrome extension or expose Browser Use as an installed Qwen extension.

### PR 3: Chrome extension and Native Messaging

Connect Browser Core to the existing Qwen Chrome extension through the local
transport and Native Messaging host. Add the required Chrome permissions,
event forwarding, tab discovery and claim behavior, and Native Host lifecycle.

The Qwen toolbar action and side panel remain intact. The side panel does not
gain feature or permission toggles.

### PR 4: Qwen integration and acceptance

Expose Browser Use through the Qwen extension manifest and skill, complete the
build and installation path, and add managed-Chrome and model-driven smoke
tests.

This pull request proves the complete Qwen-to-Chrome path without widening the
responsibilities established in the first three pull requests.

```text
PR 1: Node REPL capability
  -> PR 2: Browser Core and SDK
    -> PR 3: Chrome and Native Messaging
      -> PR 4: Qwen integration and acceptance
```

## Acceptance criteria

- Node REPL contains no browser-specific runtime implementation.
- Browser SDK state persists across Browser Use `node_repl` cells and is reset
  with the underlying Kernel generation.
- Browser actions use the existing Qwen Chrome extension and trusted CDP input.
- Browser reads and writes obey the configured origin policy.
- Audit output is bounded and does not expose typed secrets, evaluation source,
  history entries, or other sensitive page data.
- Unit tests cover each layer independently.
- Managed-Chrome smoke tests validate the transport and trusted input path.
- The model-driven SauceDemo smoke completes checkout through Browser Use.

## Deferred work

- A user-facing Qwen setting that makes Browser Use explicitly opt-in.
- Side-panel feature or permission management.
- A process-global broker for simultaneous Qwen sessions.
- Strong authentication between same-user local processes.
- Windows Native Host release validation.
- Action-time confirmations and additional browser capabilities not required by
  the current acceptance tests.
