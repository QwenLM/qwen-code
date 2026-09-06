# Cross-package contract ownership

Issue #9151 identifies values whose consumers must agree across package
boundaries but currently own independent copies.

## Decisions

- `acp-bridge` owns `LIVE_TASK_TOOL_NAMES`; CLI imports the value and derived
  type through its existing dependency on the bridge package.
- `core` owns `MAX_SUB_SESSION_PROMPT_CHARS` in a lightweight public subpath.
  The core tool and ACP trust-boundary check both import it while retaining
  their separate enforcement points.
- The CLI extension helper is named `getSanitizedExtensionDisplayName` because
  it prepares untrusted prompt text. Core's `getExtensionDisplayName` remains
  the locale-aware display resolver.
- `writeStderrLine` stays package-local because there is no existing shared
  home and the issue marks it as optional.

## Verification

A table-driven source test pins the single owner and import path for each
shared contract. Existing behavioral tests continue to cover the unchanged
values and enforcement boundaries.
