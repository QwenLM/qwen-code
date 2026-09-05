# Approval Mode Contract

## Decision

Keep `ApprovalMode` and `APPROVAL_MODES` in core as the runtime source of
truth. TypeScript packages derive their local types and validators from either
that core contract or the TypeScript SDK's checked tuple. Python and Java keep
native public types, with their accepted values checked against a small JSON
fixture that is also checked against core.

This avoids adding a runtime dependency from the published SDKs to core and
does not introduce code generation for one five-value domain.

## Changes

- Export the string-union form of core's `ApprovalMode`.
- Replace repeated TypeScript unions and validation arrays with the core or
  SDK contract.
- Type the CLI and TypeScript SDK system-message `permission_mode` fields with
  the shared union.
- Check core, TypeScript, Python, and Java accepted values against one fixture
  in their existing test suites.
- Trigger the Python and Java SDK workflows when the fixture changes.

Adjacent value domains such as channel modes, hook permission decisions, and
desktop cycling preferences remain independent because their supported values
and semantics intentionally differ.

## Verification

- Core approval-mode tests.
- CLI ACP and non-interactive type checking plus focused tests.
- TypeScript SDK drift and query-option tests.
- Python validation tests.
- Java permission-mode tests.
- Relevant lint, typecheck, and build commands.
