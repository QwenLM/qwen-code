# Local accounting for background API events

## Problem

Internal prompt IDs suppress transcript recording so auxiliary requests do not
appear as conversation turns. The same condition currently suppresses local token
usage persistence. Successful prompt suggestions, forked queries, speculation and
side queries consequently disappear from the monthly usage history.

Error and cancellation telemetry also lack local accounting records. Treating
those missing records as zero usage would conflate unavailable usage with a
reported measurement.

## Success records

Keep the existing usage-statistics opt-out and transcript suppression independent.
Persist internal successful responses through the existing monthly token-usage
writer when usage statistics are enabled.

Add optional fields to version 1 records:

- `feature`: `main`, `subagent`, `prompt_suggestion`, `forked_query`,
  `speculation` or `side_query`. Recognized internal IDs take precedence over a
  subagent name. A side-query suffix is never persisted.
- `usageStatus`: `reported` when at least one normalized token counter is
  positive, otherwise `unknown`. The telemetry event has already replaced missing
  counters with zeros, so this deliberately does not infer a known zero charge.

Use a supplied request-session snapshot for persistence, falling back to the
configuration session only when no snapshot was supplied. Preserve a safe
subagent source identifier when present; otherwise use the feature label instead
of attributing an internal request to `main`.

Legacy records without these optional fields remain readable. Validate the new
enums and reject contradictory status/counter combinations. Summary JSON adds
`usageCoverage` counts for `reported`, `unknown` and `legacy` success records.
Existing numeric totals and CSV columns remain unchanged. `requests` continues to
count accepted success rows, not HTTP attempts. Numeric zeros on unknown rows are
compatibility placeholders; totals are not complete billing measurements.

## Error and cancellation records

Write these existing telemetry events to `usage-events-YYYY-MM.jsonl` in the
existing runtime usage directory. Each record has its own schema version,
`recordType: usage_outcome`, a generated local ID, timestamp/local date/month,
session, model, auth type, feature, status, scope, `usageStatus: unknown` and
literal `tokens: null`. They never enter success totals or CSV output.

An API error has `scope: telemetry_event`. The current cancellation producer is
the interaction cancellation handler and may run during tool execution; its
record therefore has `scope: interaction`. This is not a complete ledger of
individual HTTP attempts or background aborts. No new outcome reader or UI is
introduced. Writes are best effort and a failed outcome sink must not prevent
successful usage recording.

## Privacy and compatibility

Read event metadata through own data-property descriptors, without invoking
accessors. Persist only bounded identity strings matching an identifier character
allowlist, rejecting URL syntax and explicit path prefixes. Unsafe model/auth
values become `unknown`; unsafe subagent identifiers fall back to the feature.
This can coarsen grouping for non-identifier custom names.

Do not persist prompt IDs, side-query suffixes, provider response IDs, task names,
request/response bodies, raw error messages, or content fingerprints. Existing
local record IDs and captured session IDs are not gateway request IDs and do not
establish provider billing or fallback attribution.

There are no changes to model selection, outbound requests, background feature
switches, telemetry consent, or transcript visibility. No historical backfill or
data migration is performed.

## Verification

Collocated logger and usage-service tests cover internal response recording,
opt-out, unchanged transcript suppression, session snapshots, feature precedence,
legacy reads, status consistency, identifier filtering and companion records.
Existing stats command tests cover downstream summary/export behavior. Synthetic
bundle checks additionally exercise real JSONL writes and an unavailable outcome
file without making model requests.
