# Linux CUA discovery and observation fixes

[English](linux-cua-efficiency.md) | [简体中文](linux-cua-efficiency.zh-CN.md)

## Problem and scope

Linux evaluation traces show immediate failures of freshly issued element tokens,
repeated bounded accessibility captures, process-heavy app discovery, and lost
error diagnostics. Fix findings 1–5 from the September 14 investigation and include
the companion Computer Use skill guidance for image forwarding (finding 6).
Status: repository fixes and the forwarding example are verified; finding 2 still
requires an external OSWorld startup configuration change.

## Decisions

- Preserve application-wide AT-SPI indices. Linux caches use the actual index as
  their key; snapshot tokens validate membership, including gaps. Other platforms
  retain dense registration. Replacing a window snapshot invalidates its old tokens.
- X11 discovery failures become `desktop_unavailable` errors with MCP environment
  guidance. Keep the existing Wayland fallback policy. The MCP host must pass its
  actual desktop environment at startup; the REPL must not guess display numbers,
  authentication files, or another user's session. The OSWorld config generator
  is external to this repository and still needs its environment allowlist updated.
- A capture stopped only by `max_elements_reached` or `max_depth_reached` has
  complete reads within its bounds. Report `capture_read_complete`, retain bounded
  observation lineage, and avoid the SDK retry. Read errors, timeouts, unresolved
  window scope, and missing identities still invalidate lineage. Bounded and full
  captures use separate lineage and invalidate one another when coverage changes.
  Unchanged bounded captures return `no_change`; changed bounded captures return
  a full bounded view with stable IDs, following the shared revision policy.
  The SDK recognizes Linux budget details from older drivers too.
- Running Linux apps are processes that own top-level windows, including minimized
  windows. Return those windows, merge launcher metadata, and preserve installed
  launchers. `running_only` omits installed-only entries. `active` remains reserved
  and false. Windowless background apps are consequently not reported as running.
- Preserve exception `code` and a bounded textual `details` representation through
  the REPL protocol and MCP output. Limit code to 256 characters and details to
  4096 characters, plus a truncation notice. Disable custom inspectors and getters;
  allow cyclic values. Retain existing output token limits and execution status.
- The Computer Use skill forwards individual MCP text and image blocks through
  the outer code-mode `text()` and `image()` helpers, including delayed results
  from `node_repl_wait`. This prevents the documented example from serializing
  image base64 into text. The SDK package stages the same canonical skill.

## Validation and acceptance

Regression tests cover sparse indices and gaps, per-window replacement, bounded
no-change/stable-full observations, transitions to full coverage, read failures,
GUI-process filtering with launcher metadata, `running_only`, and actionable error
metadata under output budgets.

Validation completed on September 14, 2026:

- Linux: 26 core element-token tests and 273 platform tests passed; 4 platform
  tests remain ignored. Native compilation passed.
- JavaScript: 57 SDK tests and 83 Node REPL tests passed. Independent capture,
  environment inheritance, built MCP, and CLI-to-MCP checks passed.
- The skill's forwarding example passed 8 checks against real MCP responses,
  including delayed images and errors. This verifies the example's behavior;
  model adherence and Codex UI rendering were not measured.
- A real GTK application in Xvfb exposed two windows and sparse indices 30–35
  in the second window. Direct actions and registry-issued snapshot tokens each
  activated the intended first and last buttons. App discovery returned the
  window-owning process with both windows. Element/depth bounds retained
  `capture_read_complete`; missing desktop environment returned
  `desktop_unavailable` from both discovery tools.
- Root build, typecheck, and bundle passed. Production diff self-audit and
  independent review found no actionable defects.

The two evaluation groups have not been rerun. Benchmark token savings remain
unmeasured.

## Open dependency

An accessible checkout of the Agent-Hub `osworld-v2` template is still needed. Its Codex MCP
configuration must forward desktop session variables before starting node-repl;
repository SDK changes make the misconfiguration explicit but cannot restore
variables the parent removed. Completion requires locating the matching template,
updating its environment allowlist, and verifying discovery from that launcher.
