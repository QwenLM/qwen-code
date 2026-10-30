# TUI parity CI efficiency

[English](2026-10-24-tui-parity-ci-efficiency.md) | [简体中文](2026-10-24-tui-parity-ci-efficiency.zh-CN.md)

## Problem and scope

The source TUI workflow previously ran both expensive jobs for almost every package change. Excluding Java service and Companion source-only changes avoids some unrelated failures, but does not distinguish a component change from a runtime-wide change. Meanwhile, the nightly schedule ran installed acceptance, not the source parity and no-flicker suites.

This change separates component checks, mechanism-specific interaction suites, and full acceptance. It changes CI selection, not product behavior or test assertions. The existing source check names, runner trust boundaries, CLI-only builds, runtime/renderer combinations, and installed distribution matrix remain intact. No measured speedup is claimed before observing actual CI runs.

## Decisions

### Cadence and escalation

- PRs keep the existing repository unit, type and build checks. The TUI workflow selects component checks and the interaction groups affected by the diff rather than automatically running all interactions for every package change. The separate `ci.yml` no-AK integration lane still includes some input/editor/statusline tests on PRs; this change does not remove that coverage or claim that all TUI integration tests move off PRs.
- Every night at 03:17 Asia/Shanghai (`17 19 * * *` UTC), run all source TUI suites as well as the existing installed acceptance and distribution matrix. GitHub scheduling can be delayed; this is not an exact-start guarantee.
- `workflow_dispatch` runs the same full selection on the selected ref. Maintainers should run it on a release candidate or a cross-cutting TUI change before shipping. This change does not add a release workflow dependency, a new branch protection requirement, or a label-driven privileged execution path.
- Known foundational renderer/runtime, shared build and test-infrastructure changes conservatively select full source acceptance on the PR. General package or core changes alone do not mean full acceptance.
- Unknown dependency impact is not proof of no TUI effect. Keep a conservative component check and an explicit selection reason for otherwise unclassified changes, with manual full acceptance available for maintainer escalation. Nightly full acceptance supplies the coverage deliberately deferred from PRs.

### Impact classification

Use the paginated GitHub PR-files API without checking out PR code in the classifier. Classify both the current and previous path of a rename and union all selected groups, regardless of file order. Keep the mapping small and explicit; it is an impact policy, not a complete static dependency graph.

| Group       | Behavior protected                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Component   | Existing Ink/OpenTUI component parity checks; no product bundle or interaction matrix for component-only selection |
| Render      | Product migration, viewport harness and statusline behavior, plus the no-flicker gate                              |
| Input       | Input ownership, editor/cancellation behavior and clipboard source                                                 |
| Integration | Foreground shell/PTY ownership and cancellation, extension acquisition and dual output                             |
| Recovery    | Durable session recovery and cold checkpoint restoration                                                           |

Core turn scheduling, cancellation, shell execution, session persistence and telemetry are inputs to these behaviors even when their paths are outside the UI tree. Known shared mechanisms can select multiple groups. A selected product group keeps all three existing `node:ink`, `bun:ink`, and `bun:opentui` legs, whole-file tests, zero retries and strict unhandled-error behavior. The viewport harness is an integration facility check, not a fast product unit test.

The unrelated-path exclusions cover documentation, the Java service, Companion source, and every package tree outside the TUI build/test closure: Web Shell, the Chrome extension, mobile-mcp, qwen-live, external-context, external-context-mem0, test-failure-explorer, and the desktop, live-host and mobile-shell trees that the pnpm workspace itself excludes. The closure was audited from the workspace manifests against the `--cli-only` build filter plus the root and integration-tests dependencies. Web Shell is the one deliberate exception to pure closure membership: the `web-templates` transcript bundle builds it, but no TUI suite renders that bundle, and ci.yml owns Web Shell build and E2E health; the other excluded packages are never built or executed by these gates. Companion manifests, bundler settings and scripts remain outside the Companion exclusion. Excluded manifests lose no unique coverage: a manifest-only change that breaks the shared frozen-lockfile install fails every workflow's install step, and an accompanying root lockfile change still selects full acceptance. Existing workflow-level path filtering remains broad enough to see shared build inputs and all packages; a docs-only PR need not start this workflow at all.

### Failure and evidence contracts

- Missing or inconsistent file counts, the API's 3,000-file cap, or an API error must explicitly fail impact classification. They must not silently produce a skipped or green selection. Downstream source jobs conservatively fall back to full acceptance unless cancelled; the classification failure remains visible.
- Emit a job summary explaining the selected groups and escalation reason. Do not interpolate PR-controlled filenames into shell commands. Product test names come from fixed script lists.
- Preserve existing attempt-qualified product artifacts and fixture isolation. Only bundle when product interaction or checkpoint tests actually need it.
- Keep nightly failures under the existing `Main CI Failure Issue` reporter: a `tui-parity` scheduled failure on `main` is eligible for issue creation or reuse. Repeated signatures reuse a tracker; a first infrastructure-only failure can be rerun instead. PR and manual TUI failures are not automatically filed by that reporter. No new write permissions are needed here.
- Cancel superseded PR runs only. Nightly and manual runs retain unique run-ID concurrency groups and are not cancelled by a later PR update.

## Constraints and deferred work

Do not parallelize the three product legs or introduce additional runner jobs in this change. Integration setup shares lifecycle state, and the ECS pool can run several jobs concurrently; parallelism needs independent home/cache/setup isolation and measured contention evidence first. Shared build artifacts across jobs remain deferred because native dependency compatibility would widen the change.

The Companion exclusion remains conservative: the Web Shell build calls `vscode-ide-companion/scripts/generate-notices.js`, and the shared frozen-lockfile install reads the Companion manifest. Conversely, `copy-bundled-cli.js` consumes the already-built CLI; it is not an input to the CLI build. Keeping non-source Companion paths eligible for classification does not mean every such file affects these gates. Further exclusions for README, resources or extension-only build files remain deferred.

The workflow's own size baseline is updated to its measured byte size for the added classifier, per-step selection conditions and targeted runner. Keep the classifier inline so its read-only job needs no checkout or new execution authority; do not raise the global growth allowance or absolute limit.

Path-based selection can miss a newly introduced cross-module dependency. Adding a new shared TUI mechanism requires updating its mapping and a representative contract test. Nightly coverage and maintainer-triggered full runs mitigate this risk but do not make selective PR checks equivalent to full acceptance. Branch protection and release automation remain separate maintainer decisions; a manual run on a ref is not automatically a required PR check.

## Validation and acceptance

- Execute the actual workflow classifier against unrelated, component-only, each mechanism group, mixed-group and foundational-change inputs. Include real tracked path representatives, both rename directions, order-independent union and paginated listings.
- Exercise schedule and dispatch without a PR payload: all source groups and installed acceptance must run. Inject incomplete counts and API failures: the classifier must report failure and preserve full fallback.
- Verify output-to-job and output-to-step conditions, not only classifier booleans. A component-only PR must not bundle or run interactions; recovery-only selection must run checkpoint restoration without the no-flicker test, and full mode must retain every original suite exactly in its intended lane.
- Retain strict failure handling, runtime matrix, serial execution, check names, CLI-only build, cancellation and artifact contracts. Keep the existing installed acceptance and failure-reporter tests passing.
- Run focused script tests, YAML/actionlint, formatting and ESLint. Run product build/type checks where prerequisites permit and distinguish environment failures from scheduling regressions. A local selection test is not a hosted Actions execution or proof of runner-time savings.

UI verification is not applicable: no product source or interaction changes. Hosted job skipping, queue timing, scheduled execution and actual issue publication require post-publication observation; do not claim them from local tests.
