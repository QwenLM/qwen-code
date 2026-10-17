# Typed Browser Facade and Skill Implementation Plan

## Status

- **State:** Facade implemented and validated; Skill work superseded by main
- **Date:** 2026-09-13
- **Main rebase amendment:** 2026-09-29
- **Chinese design:** [`docs/design/2026-09-13-typed-browser-facade-and-skill.zh-CN.md`](../../../docs/design/2026-09-13-typed-browser-facade-and-skill.zh-CN.md)
- **Canonical Browser Use design:** [`docs/design/browser-use.md`](../../../docs/design/browser-use.md)

Main now owns the canonical bundled `browser-use` Skill through the Chrome
extension and bundled Browser Use runtime. The rebase keeps that Skill and
publishes this Cua-backed facade only as an SDK subpath. Skill staging steps
below are retained only as historical sequencing and are not part of the
rebased implementation.

## Objective

Add a typed Browser facade without exposing arbitrary Driver dispatch or adding
per-action user confirmation prompts. Do not replace main's canonical bundled
Browser Use Skill.

The first release wraps the routine Standard-profile subset of existing Cua
Driver Browser tools behind fixed methods. It excludes existing-profile
attachment, file transfer, dialog mutation, and `browser_download` until a
trusted host broker exists.

## Public Surface

Add:

```text
@qwen-code/cua-sdk/browser-use
```

with:

- `BrowserUse`
- `BrowserBinding`
- `BrowserTab`
- `BrowserUseError`
- typed options and result interfaces

Supported Driver mappings:

| Public method                | Driver tool                                  |
| ---------------------------- | -------------------------------------------- |
| `BrowserUse.listApps`        | `list_apps`                                  |
| `BrowserUse.listWindows`     | `list_windows`                               |
| `BrowserUse.prepareIsolated` | `browser_prepare` with isolated profile only |
| `BrowserUse.bindWindow`      | `get_browser_state` bind mode                |
| `BrowserTab.observe`         | `get_browser_state` semantic snapshot mode   |
| `BrowserTab.navigate`        | `browser_navigate`                           |
| `BrowserTab.click`           | `browser_click`                              |
| `BrowserTab.type`            | `browser_type`                               |
| `BrowserTab.pointer`         | `browser_pointer`                            |
| `BrowserTab.inspectDialog`   | `browser_dialog[action=inspect]`             |

## Implementation Steps

1. Add `browser-use/index.js` with strict validation, private fixed tool names,
   same-process `create()`, daemon `connect()`, and drain-before-teardown
   `close()`.
2. Add `browser-use/index.d.ts` with no caller-supplied raw session, target,
   tab, or tool name fields.
3. Add package export, files, typecheck, and test scripts.
4. Add unit tests with a fake Driver session that rejects unexpected
   `callTool()` names or arguments.
5. Add type tests for illegal public fields and valid task flows.
6. Add README documentation for exact binding, semantic refs, typed refusal
   errors, and the protected-operation limitations.
7. Preserve main's canonical bundled `browser-use` Skill unchanged.
8. Add facade API-surface and package-content tests.
9. Run existing Computer Use tests to prove no regression.
10. Run or document the real-browser E2E gate from the design.

## Authorization Decision

This implementation does not add nested confirmation UI. It exposes only the
operations that remain inside the Driver's standard routine profile without
file transfer or consequential dialog mutation.

The facade:

- does not accept an authorization callback from model code;
- does not expose trusted adapter methods;
- does not allow reserved transport evidence in public options;
- does not expose existing-profile preparation, file transfer, dialog
  mutation, or `browser_download`;
- surfaces existing-profile and protected-resource refusals unchanged.

The private adapter also treats SDK action projections with
`effect: "refused"` as failures. When that projection omits the original
refusal envelope, it recovers the stable Driver code from the standardized
`refused (<code>):` text prefix and still exposes only typed error details.

A future trusted CUA REPL can insert policy evaluation at the facade's private
call boundary without changing the public API.

## Test Matrix

| Area               | Required evidence                                                   |
| ------------------ | ------------------------------------------------------------------- |
| Discovery          | app/window parsing without a second direct runtime                  |
| Binding            | exact/heuristic behavior, tab ownership, malformed result rejection |
| Observation        | semantic fields, continuation, screenshot, query/scope forwarding   |
| Navigation         | fixed tool, URL validation, no mutation on heuristic binding        |
| Click/type/pointer | strict addressing, fixed IDs, no automatic route change             |
| Dialog             | inspect-only validation                                             |
| Errors             | code/details preserved, raw payload not exposed                     |
| Cancellation       | pre-dispatch stop, no mutation replay                               |
| Lifecycle          | handle invalidation, active-call drain, idempotent close            |
| Preparation        | prepared PID requires fresh window discovery and binding            |
| Main Skill         | existing Chrome-extension Skill remains unchanged                    |
| Packaging          | export, declarations, and README present                             |

## Completion Gate

The change is complete only when:

1. design review findings are resolved;
2. the typed facade is implemented without replacing main's Skill;
3. focused JS and TypeScript tests pass;
4. main's existing bundled Skill tests pass;
5. package export and content tests pass;
6. existing Computer Use tests pass;
7. the real-browser E2E passes; an environment blocker may be recorded as
   progress but is not completion.

## Review Resolutions

The requested Sub Agent review found no Critical issue and two High blockers.
The audited plan now:

- treats every structured refusal as `BrowserUseError`;
- removes upload and dialog mutation from the first facade;
- restricts preparation to isolated profiles;
- owns app/window discovery to avoid a second direct runtime;
- performs no implicit session reconnect for binding-owned handles;
- drains active calls before teardown;
- requires rediscovery and rebinding after preparation; and
- keeps real-browser E2E as a hard completion gate.

## Implementation Result

Completed on 2026-09-13:

- `@qwen-code/cua-sdk/browser-use` is exported and included by npm packing;
- main's canonical bundled Skill is preserved and no second Skill is staged;
- facade, declaration, package, main Skill, and existing Computer Use tests
  pass;
- root repository build and workspace typecheck pass; and
- the real-browser E2E passes against a driver-owned isolated Chrome profile,
  including exact binding, semantic screenshot, ref click, text replacement,
  stale-ref refusal, dialog inspection, unchanged foreground/pointer evidence,
  and process cleanup.
