# Managed worktree controls in the composer

[English](2026-10-28-managed-worktree-composer.md) | [简体中文](2026-10-28-managed-worktree-composer.zh-CN.md)

## Problem and scope

Managed's full-width Session files fieldset has been moved beside the workspace below the composer using Local's layout and stable Git chip styles. The chip shows the actual current Git branch, such as main. The user requested the same simple worktree selection as daemon: choose Worktree, then send the first message to create the isolated checkout, without a base-ref form.

## Branch contract and ownership

Add optional nullable currentBranch to WebShell worktree options and current_branch to public options. Read the selected source checkout's symbolic branch using the existing verified repository path and native Git runner: a named branch returns its real name, detached checkout returns HEAD, unavailable safe inspection returns null. This observation is independent of the selected baseRef/baseCommit; capture it before validating the worktree base so an invalid base or unborn branch does not erase the source branch. Preserve actor authorization, storage guards, deployment gates and rejection of private/unsafe layouts. No ordinary daemon Git API, schema migration, writer or model request is added.

## Composer behavior

Fetch Managed options for the selected workspace/cwd without baseRef and remain usable in current mode even when worktrees are unsupported. Key branch observations by workspace/cwd, abort old selections and retain the matching branch while refreshing the same source. Recheck worktree support when switching mode or opening the popover. The current-mode chip displays the observed branch; unknown information uses a generic files control, never a fabricated branch or a mode label presented as a branch. Worktree intent uses daemon's Worktree label and purple indication.

The popover reuses daemon's Git mode/current branch/worktree labels, first-message description and stable styles. It contains current/worktree selection and retained-worktree management; both choices close immediately. Worktree intent has the same clear button to return to the current branch. Remove base-ref, commit and file-selection fields from this choice. New worktree requests send worktree: {} so the existing server resolves current HEAD at admission and allocates its own branch/path. Selection alone sends no create or model request. The public API keeps its existing optional explicit base-ref support.

Checking/errors remain visible after closing. Busy/loading/pending state freezes edits and the clear button, while unsupported worktrees can return to current mode. Existing pending requests, including explicit base refs created before this simplification, retry their exact stored payload and idempotency key. File references remain unavailable until the target worktree is ready. Controlled open state retains dialogOpen and disabled on the composer for focus protection. Shared hooks, daemon behavior, backend lifecycle, authorization and storage guards remain unchanged.

## Simplification acceptance

Verify that choosing Worktree closes the picker, changes the chip, creates nothing until the first message, and sends worktree: {} with the original input. Verify clear/current mode, unavailable-worktree errors without fallback, manager access, frozen retries including a legacy explicit base ref, and stale-workspace branch rejection. Run focused creator and Local popover tests, repository build/typecheck/bundle, and Chrome against the built frontend with the existing backend. This frontend-only increment needs no new Java package/startup or repeated Java tests; retain the existing shared verification budget and prior backend evidence.

## Session information placement

In Home chat, place ready worktree status, branch and base commit inside the existing session details card beside its folder/status/ID metadata. Add a passive optional details content slot to the shared card and supply the existing Managed worktree status renderer from the Managed navigation row. Keep preparing/removing and blocked/failed attention visible above chat in compact form without branch/base details. Ready chat has no persistent worktree block. The standalone Managed page retains its full display because its plain navigation has no details card; the worktree manager also retains full information. No new API requests, state transitions or model calls are added. Verify card content/ID copy/portals, Home readiness and errors, standalone and manager behavior, then the existing ready session in Chrome.

This placement passed 183 distinct cases across the affected page, navigation row, worktree manager and shared details-card suites, with repository build/typecheck/bundle and scoped lint/format checks. Chrome verified the user's existing ready session: no ready block above chat, full state/branch/base in its details card. The frontend preview's deep-link HTML marker was corrected separately in the local harness; no backend restart or new model turn was needed. Full CI and other platforms remain unverified.

## Verification and status

The earlier layout increment passed repository build/typecheck/bundle,263 composer cases,18 Local popover cases and the selected creator cases; its retained evidence is in the local E2E plan. The Storage.prototype fixture mismatch on Node26.12.1 was diagnosed and corrected. Real Chrome verified layout, base editing, non-Git switchback and management. Those results did not establish a real branch label; that is the current correction.

The baseline confirmed native Git on the existing project reported main while the existing options response had no currentBranch. The correction passed 29 Java tests, including native Git branch/base independence, nested paths, checkout changes, detached and unborn branches, safe denial, camel/snake response projections, ManagedAgentApiContractTest and SurfaceRegistryGateTest. Checkstyle, packaging and regenerated WebShell types passed. All 287 focused creator/client/provider tests passed, along with repository build, typecheck, bundle and targeted ESLint.

Before the simplification, a fresh local runtime returned currentBranch=main, matching native Git. Real Chrome displayed main beside the Managed workspace and kept Current directory/main and Independent worktree inside the popover. The existing services were not restarted; project content and the parent marker were preserved. Measured Java-related verification, including the retained earlier work and fresh startup, used 186.33 seconds of the shared 600-second budget. No model prompt was sent. This is local macOS evidence; full CI and other platforms remain unverified.

The simplified frontend passed all 145 creator cases and 18 Local popover cases across the applicable runs, plus repository build/typecheck/bundle and targeted formatting/lint checks. An initial collection failure during a concurrent SDK rebuild and two new fixture mismatches were corrected in the verification setup; the affected cases passed without changing production behavior. Real Chrome using the production-built frontend and existing backend verified two simple choices, automatic closing, the purple Worktree chip, reset to main and retained-worktree management. No model prompt or worktree mutation was used for that browser check; first-message payload and legacy retry behavior were verified through the provider tests. Backend files and the Java verification budget are unchanged in this increment.
