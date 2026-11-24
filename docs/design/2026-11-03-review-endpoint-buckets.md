# PR review endpoint buckets

[English](2026-11-03-review-endpoint-buckets.md) | [简体中文](2026-11-03-review-endpoint-buckets.zh-CN.md)

## Status and scope

Implemented in PR #16151; not yet verified by CI or live endpoint traffic.
Repository variables and secrets remain unchanged. This covers the shared
`Run review` step, not Triage, Autofix, or conflict resolution.

## Problem

Comparing model names to identify an endpoint cohort disables endpoint splitting
when both gateways serve the same model. A hundred-bucket cycle also concentrates
an 80% rollout into eighty consecutive PR numbers. The existing host log is
printed before the endpoint override and can misidentify the final destination.

## Decisions

- Select the cohort from the PR number before selecting its model and optional
  endpoint/key pair. Equal model names must not disable an endpoint split.
- Keep `QWEN_PR_REVIEW_MODEL_CANARY_PERCENT` in percentage units. Multiples of ten
  use `PR_NUMBER % 10`: at 80%, buckets 0–7 are canary and 8–9 are default.
  Other percentages retain `PR_NUMBER % 100` so 8% does not become 80% or 0%.
  The predicate is `bucket * 100 < percent * bucket_count`.
- Preserve invalid-percentage handling, invalid-PR fallback, and the optional
  endpoint contract. No canary URL keeps the existing model-only split. A URL
  without its key, or an unparseable URL, falls back to the default cohort.
- Label the early host log `initial_openai_host`. After selection, log the
  requested model, bucket and bucket count, final cohort, and endpoint hostname.
  Do not include keys, URL credentials, paths, or query parameters in the notice.

## Compatibility and risks

Changing the bucket cycle can move existing PRs between cohorts. The cohort is
deterministic only while the percentage and configuration stay unchanged. An
80/20 split describes PR buckets, not model requests or concurrent capacity; this
change does not guarantee either gateway can handle its share. Transport errors
do not trigger automatic cross-endpoint failover, and other workflows can still
consume the default endpoint's quota.

The EAS backend model is not confirmed. Keep the working default request name
until explicit `deepseek-v4.1-flash-1017` support is confirmed; a backend model
replacement alone does not establish which request names are supported.

## Validation and acceptance

Workflow meta-tests execute the actual shell selection block. They cover two
consecutive ten-PR cycles at 80%, the 7/8 boundary with identical model names,
percentage precision at 8%, paired endpoint/key selection, configuration fallback,
and the final hostname notice. These tests have not been run locally in this
iteration; no local build or dependency installation is required for delivery.

After CI passes and the PR is merged, inspect one review from each cohort. At
80%, require a 0–7 bucket to announce the Beijing hostname and an 8–9 bucket to
announce the Shanghai EAS hostname. Confirm `Run review` actually ran, rather
than relying on a green workflow with a skipped review. Service-side model and
capacity verification remain separate follow-up work; do not change live model
variables based only on the notice's requested model name.
