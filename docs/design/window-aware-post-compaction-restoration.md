# Window-aware post-compaction restoration

[English](window-aware-post-compaction-restoration.md) | [简体中文](window-aware-post-compaction-restoration.zh-CN.md)

## Problem

After a successful summary, restoring recently accessed files can put the next conversation back over a small context window (#15487). The existing 50,000-token file-content budget is independent of the window. Image restoration has a count limit, but no aggregate token budget. Checking only that the candidate is smaller than the original does not prevent this overflow.

## Behavior

The compression service gives restored file contents a budget of `min(50_000, floor(effectiveWindow / 4), floor(autoThreshold / 2))` tokens. The effective window incorporates a smaller server-reported total ceiling when the existing route checks accept it. The auto threshold includes the user's configured percentage. Reserving half that threshold for the summary and other context allows partial restoration at low thresholds, including the default 40K-window threshold.

File contents and restoration-size estimates use the existing CJK-aware text-token estimator. The per-file reader's character-size cap and the file-count limit still apply. Files that exceed the content budget remain available as path references, with the most recently accessed files considered first. Direct restoration callers that omit a budget use the 50,000-token default.

The overflow check includes the summary, restored content, existing non-visible context, and pending tool result. A candidate at or above the effective window's auto-compaction threshold is composed again with all restored file blocks, path references, and images removed. The service subtracts the local history-size difference from its existing token count, retaining the accounting for the summary and non-visible system/tool context. The returned count excludes the pending result, which the caller adds when submitting it. A debug log records the threshold, pending-result estimate, and counts before and after attachment removal.

This second composition preserves plan-mode reminders, running background-agent reminders, and the trailing tool call needed to pair with a pending result. It does not issue another summary request or fire another compaction hook. Existing payload-overflow and hosted-file-restoration exclusions continue to apply.

## Scope and limits

This is a restoration-stage fix. Compression-request admission (#9455 / #15936) and subsequent request accounting (#15486) remain separate. The local token estimate is approximate; these limits do not promise exact admission for every provider or make an oversized summary fit. Existing empty-summary, truncated-output, and inflated-count failure handling remains in place.

## Validation

- Reproduce a successful candidate exceeding a 16K window using five real files and a completed mock summary.
- Verify that 16K and 32K windows retain only the file contents that fit, keeping other files as references.
- Verify unchanged restoration for 128K and 200K windows and the 50K ceiling with a 1M window and an increased file-count limit.
- Cover zero remaining file-content budget.
- Cover server-reported total ceilings, input-only ceilings, and route mismatches.
- Verify partial restoration with a 40K window and with low configured auto thresholds.
- Verify CJK content consumes the text-token budget and preserves references when it does not fit.
- Include a pending tool result in the overflow decision and retain a substantial summary in the reported count.
- Compare configured and default auto thresholds and check the attachment-removal debug log.
- With and without summary usage metadata, force restored files and images above the auto threshold; verify their removal, retained non-visible accounting, reminders, and pending tool-call pairing.
- Run the existing compression, attachment, and token-estimation suites. Service tests isolate this stage from compression-request admission and do not represent live-provider E2E evidence.
