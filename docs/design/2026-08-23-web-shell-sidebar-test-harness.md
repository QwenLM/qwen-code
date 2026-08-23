# Web Shell sidebar test harness

## Context

The sidebar test suites repeat the same session-page interpretation, DOM
shims, session fixtures, and interaction helpers. The copies already disagree
about how an explicitly unloaded page (`data: undefined`) should expose its
sessions.

## Decision

Add one collocated test harness for the stable shared behavior. All three
sidebar suites use the same session-page resolver and DOM setup; the two suites
that build session fixtures also share those helpers. Keep suite-specific mock
controllers and render options local because the workspace-removal suite
models additional catalog invalidation, channels, and multi-workspace routes.

## Validation

Run the three sidebar suites together, then run the Web Shell typecheck and
build. The refactor must not change production files or test expectations.
