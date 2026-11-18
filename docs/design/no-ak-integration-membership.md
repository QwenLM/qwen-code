# No-AK integration test membership

[English](no-ak-integration-membership.md) | [简体中文](no-ak-integration-membership.zh-CN.md)

Status: Implemented

## Problem and scope

The no-AK script and its exact-string meta-test can agree while omitting a new
integration test. Checking file existence also admits paths excluded by Vitest
and does not expose substring filters that select multiple files. Issue #14807
asks for a static guard without expanding the 20-minute CI job.

## Design

Add one test to the existing no-AK workflow contract suite. Read the integration
Vitest configuration directly and use the existing `glob` dependency to apply
its include/exclude patterns. Intersect those results with `git ls-files` to
inspect tracked `*.test.ts` files, including staged additions.

Parse the script's relative file arguments, excluding the `--root` argument.
Resolve them as case-insensitive substring filters. Every filter must match one
candidate, except `./test-helper.test.ts`, whose existing two-file match is
pinned explicitly. This prevents another helper file from joining silently.

Every remaining candidate must have an explicit per-file exemption and reason.
Real-model suites require credentials; other existing omissions remain deferred
pending a runtime-budget decision. This does not claim that every deferred suite
is slow. Comparing the entire omitted set also rejects stale exemptions and
requires removing an exemption when its file is enrolled.

## Constraints and risks

Keep the existing script, exact-string pin, order, and existence check unchanged.
Do not add dependencies, configuration, scripts, automatic enrollment, or a
Vitest subprocess inside the guard. Product code and runtime behavior are
unaffected. Future inventory changes intentionally require a selection or
exemption decision; untracked local files are outside the Git-based inventory.

## Validation and acceptance

- The unchanged inventory passes on macOS and Docker Linux.
- A tracked unregistered `cli/zz-probe.test.ts` fails and names the file.
- Removing `cli/tool-hook-updated-input.test.ts` from both list copies fails.
- Replacing an entry with excluded `hook-integration/hooks.test.ts` fails.
- A new accidental substring match fails, including a third helper match.
- Removing the new test restores the old false-green behavior in those probes.
- Run the complete no-AK contract suite, formatting, lint, build, and typecheck.

## Open questions

None for this guard. Enrolling currently exempted tests is separate work and
requires checking credentials and the job's runtime budget.
