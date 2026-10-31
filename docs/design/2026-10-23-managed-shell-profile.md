# Unified Managed Shell Profile

[English](2026-10-23-managed-shell-profile.md) | [简体中文](2026-10-23-managed-shell-profile.zh-CN.md)

## Problem and scope

Managed Agent has not shipped. Maintaining `hosted-workspace-shell/1` and
`hosted-workspace-shell/2` adds an unnecessary compatibility boundary: `/2`
adds `glob`, while lifecycle, MCP management and other Session capabilities
recognize `/1`. Issue #15078 consequently includes a Shell profile that can
execute tools but cannot use the existing lifecycle protocol.

Unify Shell execution under `hosted-workspace-shell/1`, with its existing
tools and `glob`. The files, MCP, read-only child and team-lead profiles keep
their current scope. Profile consolidation adds no combined cancel-and-close operation. The accompanying lifecycle default and finite writer handoff are specified in the [lifecycle design](2026-10-23-managed-shell-lifecycle.md); resource-settlement requirements remain in force.

## Proposed changes

The Hosted Harness exposes one Shell profile and one Shell tool list. Its
profile predicates, tool declarations, approval selection, Plan admission and
Workspace recovery use the same identifier. `glob` follows the existing
bounded Workspace search execution and read-only approval rules.

The Java control plane recognizes only that Shell identifier for public Shell
and approval-selection admission. Compiling a definition for Session creation
rejects noncanonical Shell identifiers even if deployment configuration still
allowlists them. Its existing lifecycle v2, MCP and original
Runtime cleanup paths continue to apply to the unified profile. Public API
fields and the lifecycle wire protocol do not change.

Remove `/2` from accepted Shell profiles instead of retaining an alias or a
migration path. The user confirmed that these profiles have not shipped.
Existing development fixtures must select `/1`; removed profile values remain
unsupported. Stored Session definitions still pin their selected profile, and
arbitrary profile changes during load remain refused.

## Affected components

- CLI profile definitions, tool declarations and profile admission consumers.
- Java public Shell classification and persisted approval-selection checks.
- Focused profile, tool, Hosted Session, recovery and Java consumer tests.
- Current profile documentation in both languages; historical verification
  reports retain the identifiers actually tested at their recorded commits.

## Validation and acceptance

The unified Shell profile must offer `read_file`, `write_file`, `edit`,
`run_shell_command`, `monitor` and `glob` on the ordinary Workspace execution
path. Native `glob` must retain argument validation, bounded results and
containment, and be pre-approved as a read operation under default and
auto-edit policies. Foreground-only transports retain their existing limits.

Creation, load and Workspace recovery must reject the removed Shell profile.
The files profiles and read-only child profile must retain their existing
tool lists. Public Shell selection, live approval and Plan admission must use
the unified identifier.

With lifecycle v2 enabled for `/1`, the unified profile must still use the
existing effects, resource preparation and resource settlement phases. Active
Turns must still refuse close with `turn_active`. Unknown execution or output
outcomes must continue to block retirement. This work does not establish
Linux process-fault or deployment acceptance merely by passing unit tests.

Run focused CLI and Java consumer checks, the root build/typecheck and the
Hosted execution probe recorded in `.qwen/e2e-tests/managed-shell-profile.md`.
Record unavailable checks separately from successful results.

## Rollout and open questions

Deploy matching control-plane, Harness and Runtime artifacts together before
enabling the profile. Since the canonical identifier gains `glob`, an older
Runtime's capability identity alone does not prove that it can execute the
new tool. No production data migration or compatibility alias is introduced.

There are no open product decisions for this consolidation. The accompanying lifecycle enablement follows the linked design; real-process acceptance must still be recorded separately.
