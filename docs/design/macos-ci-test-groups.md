# Complete macOS CI within bounded jobs

[中文版](./macos-ci-test-groups.zh-CN.md)

## Problem

The macOS Node job in run 40885875352 exceeded its 60-minute limit twice. In the second attempt, installation took about 13 minutes and tests continued making progress until cancellation. The CLI suite had not finished, so later workspace and script suites never ran. One hook also timed out; partitioning does not establish that this separate failure is fixed.

## Decision

Keep the 60-minute limit and all existing assertions. Run CLI in three Vitest shards, core in two, the other workspace suites in one group, and standalone/runtime plus root script tests in one group. Disable matrix fail-fast so a failing group does not cancel the others. Run the existing portable process smoke once in the scripts group.

The remaining workspace group obtains all declared `test:ci` scripts from npm's workspace metadata and excludes only CLI and core. Newly added workspace suites therefore enter the run automatically. Heavy groups select workspaces by path to avoid confusing the CLI with the identically named root package. No group uses test filters, `--if-present`, or `--passWithNoTests`.

## Failure handling

Keep the original `Test (macos-latest, Node 22.x)` name as an aggregate check. It succeeds only when the entire matrix succeeds; failed, skipped, or cancelled groups cannot yield a green aggregate. The scripts group executes both standalone and helper suites and retains either failure. Workspace discovery failure or an empty remaining group fails closed.

## Validation and limits

CI contract checks pin the complete shard partition, automatic inclusion of new workspace suites, failure propagation, and the aggregate result. No local tests or builds were run. The complete workflow must demonstrate that all groups finish within their existing limits; the previous hook timeout still requires investigation if it recurs. Seven installations cost more runner time, trading repeated setup for completion and independent failure reports. Existing trigger, permission, and checkout rules remain in place.
