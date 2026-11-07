# Complete macOS CI within bounded jobs

[中文版](./macos-ci-test-groups.zh-CN.md)

## Problem

The macOS Node job in run 40885875352 exceeded its 60-minute limit twice. In the second attempt, installation took about 13 minutes and tests continued making progress until cancellation. The CLI suite had not finished, so later workspace and script suites never ran. One hook also timed out; partitioning does not establish that this separate failure is fixed.

## Decision

Keep the 60-minute limit and all existing assertions. Run CLI in three Vitest shards, core in two, the other workspace suites in one group, and standalone/runtime plus root script tests in one group. Disable matrix fail-fast so a failing group does not cancel the others. Run the existing portable process smoke once in the scripts group.

The remaining workspace group obtains all declared `test:ci` scripts from npm's workspace metadata and excludes only CLI and core. Newly added workspace suites therefore enter the run automatically. Heavy groups select workspaces by path to avoid confusing the CLI with the identically named root package. No group uses test filters, `--if-present`, or `--passWithNoTests`.

## Failure handling

Keep the original `Test (macos-latest, Node 22.x)` name as an aggregate check. It succeeds only when the entire matrix succeeds; failed, skipped, or cancelled groups cannot yield a green aggregate. The scripts group executes both standalone and helper suites and retains either failure. Workspace discovery failure or an empty remaining group fails closed.

Record the additional five-minute aggregate job in the workflow budget (nine declared jobs, 305 declared timeout minutes). This budget counts job definitions, not matrix expansion; each macOS execution group still has its original 60-minute limit.

## Validation and limits

CI contract checks pin the complete shard partition, automatic inclusion of new workspace suites, failure propagation, and the aggregate result. No local tests or builds were run. The complete workflow must demonstrate that all groups finish within their existing limits; the previous hook timeout still requires investigation if it recurs. Seven installations cost more runner time, trading repeated setup for completion and independent failure reports. Existing trigger, permission, and checkout rules remain in place.

The first complete partitioned run exposed workflow fixtures that previously had not been reached on macOS. Keep their assertions and make the exercised shell paths work with the system Bash 3.2: read failed-job IDs without `mapfile`, safely iterate empty issue-family arrays under `nounset`, and reject missing OSS credentials with an explicit exit. Include shell stderr in issue-routing assertion diagnostics. These changes require remote validation; the remaining CLI and Windows failures are not established as resolved by them.
