# Incremental PR lint and static-check build reuse

[English](incremental-pr-lint.md) | [简体中文](incremental-pr-lint.zh-CN.md)

## Problem and scope

PR lint currently scans the entire repository. The static job also installs dependencies with a prepare hook that builds and bundles every workspace, then its bundle-closure check cleans and rebuilds the CLI dependency closure. In run 39977456043, dependency installation including lifecycle scripts took 563 seconds; this does not identify how much time belonged to downloads versus building.

This change targets file-local lint and duplicate build work. Cross-package dependency checks, generated-output checks, runtime dependency audit, and helper tests remain enabled. It does not change runner concurrency or required-check policy.

## Design

Only pull requests set `LINT_BASE_SHA`. A bounded fetch obtains 100 commits of base/head history. The lint scope helper uses a proven merge base and NUL-delimited Git file lists. Unavailable or ambiguous history falls back to full lint. Deleted paths participate in configuration invalidation but are not passed to file linters. Renamed files are checked at their new paths.

ESLint, Prettier and YAML checks select changed complete files. Shell-related changes invoke the existing full ShellCheck lane to preserve sourced-script coverage; unrelated changes skip it. Its legacy output pipeline masks checker failures, so strict ShellCheck failure enforcement requires separate baseline cleanup. Workflow/action changes retain a full actionlint scan because reusable workflow contracts cross files. Changes to lint rules, configuration, ignore files, dependencies or the lint implementation restore full checking. Non-PR events retain full checking. An empty relevant file set is a documented skip; a failed diff is never treated as an empty successful check.

The lint install sets `QWEN_SKIP_PREPARE=1` and `QWEN_SKIP_NOTICE_GENERATION=1` only for that step. Dependency lifecycle scripts and patch-package remain active. The existing clean CLI build/bundle closure check runs after file lint and before i18n, schema and notice checks. Its outputs support later checks. The test job retains normal prepare behavior. Both primary hosted jobs reuse the existing pnpm store cache action; self-hosted stores remain on their existing paths.

## Validation and acceptance

Exercise real temporary Git repositories for ordinary changes, renames, deletions, unusual filenames, configuration invalidation and incomplete history. Check command failures propagate. Run the actual linters and static pipeline on an isolated checkout installed without prepare, so missing build prerequisites cannot hide behind old outputs. Verify generated schemas and notices remain unchanged and run the affected workflow/script suites.

Compare timings on the same runner class after deployment. Local timings and the 563-second historical install are not a promise of CI savings. Full repository checks on main remain the backstop for cross-file effects outside the incremental selection.
