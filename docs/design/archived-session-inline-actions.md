# Archived session inline actions

[English](archived-session-inline-actions.md) | [简体中文](archived-session-inline-actions.zh-CN.md)

## Problem and scope

In Settings → Archived conversations, Export conversation and Restore are hidden in each row's More menu. Issue #15866 requests that these frequent actions become discoverable on hover. This change only relocates existing actions; archive storage, routing, lifecycle semantics, and the managed archive interface remain unchanged.

## Design

The archived branch of `WebShellSidebar.tsx` renders Export conversation and Restore as inline buttons before More. Reuse `sessionActionButton` and `sessionActions`, including their existing hover, keyboard focus, and coarse-pointer styles. Each button has a translated accessible name and tooltip. More contains Rename and Delete and is absent when neither action is available.

Preserve existing action visibility and disabled conditions, including workspace resolution, standalone callbacks, session action policy, busy operations, and export progress. Compute the action-slot width from the number of rendered inline buttons plus the optional More button, at the existing 26 pixels per button.

`sessionActions.items` continues to control action availability. `inlineItems` retains its documented scope of standard session rows; archived rows use Export and Restore inline. Extending that option to archive would change the standard-row archive safety policy and is unnecessary for this request. Clarify the existing API comment without introducing configuration.

## Affected files and validation

Update the sidebar component, collocated archive assertions, and archived-settings browser coverage. No new component, public option, CSS, daemon route, or dependency is required. This document and its Chinese counterpart describe the user-visible placement change.

Validate workspace and standalone exports/restores, policy-limited rows, menu contents, disabled states, and exact slot widths in component tests. Browser tests verify hover reveal, keyboard focus, touch visibility, and non-overlapping action bounds. Capture the resulting Settings UI for the PR. Run the repository build, typecheck, bundle, focused tests, formatting, lint, and final preflight; report any unrelated failures explicitly.

## Acceptance criteria and open questions

- Hover or keyboard focus reveals Export conversation and Restore beside More; touch devices can reach the buttons without hover.
- Both inline buttons use existing handlers and restrictions.
- Rename and Delete remain in More; Export and Restore no longer appear there.
- Width matches the actual available buttons, including missing export or restore capabilities.
- Standard session row configuration and behavior are preserved.

No open design questions remain for this scope.
