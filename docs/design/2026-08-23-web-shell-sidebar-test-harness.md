# Web Shell sidebar test harness

[English](2026-08-23-web-shell-sidebar-test-harness.md) | [简体中文](2026-08-23-web-shell-sidebar-test-harness.zh-CN.md)

## Context

The sidebar test suites repeat the same session-page interpretation, DOM
shims, session fixtures, and interaction helpers. The copies already disagree
about how an explicitly unloaded page (`data: undefined`) should expose its
sessions.

## Decision

Add one shared test harness under `client/test/` (the package's existing
test-support directory, excluded from the declaration build and coverage) for
the stable shared behavior. All three sidebar suites use the same session-page
resolver and DOM setup; the two suites that build session fixtures also share
those helpers. The flush helper is re-exported from the existing
`reactHarness` rather than copied. Keep suite-specific mock controllers and
render options local because the workspace-removal suite models additional
catalog invalidation, channels, and multi-workspace routes.

The DOM installer (`installSidebarDomShims`) only fills the pointer-event API
jsdom lacks; `IS_REACT_ACT_ENVIRONMENT` and `Element.prototype.scrollIntoView`
stay owned by the vitest setup file (`client/test/setup.ts`), which runs before
any test module body — re-installing them in the harness would be an
unreachable no-op.

## Validation

Run the three sidebar suites together, then run the Web Shell typecheck and
build. The refactor must not change production files or test expectations.
