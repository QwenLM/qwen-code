# Window-aware post-compaction restoration

[English](window-aware-post-compaction-restoration.md) | [简体中文](window-aware-post-compaction-restoration.zh-CN.md)

## Problem

After a successful summary, restoring recently accessed files can put the next conversation back over a small context window (#15487). The existing 50,000-token file-content budget is independent of the window. Image restoration has a count limit, but no aggregate token budget. Checking only that the candidate is smaller than the original does not prevent this overflow.

## Behavior

The compression service gives restored file contents a budget of `min(50_000, floor(contextWindow / 4))` tokens. Existing per-file and file-count limits still apply. Files that do not fit remain available as path references, with the most recently accessed files considered first. Direct restoration callers that do not supply a budget retain the existing 50,000-token default.

After accounting for the summary, restored content, and existing non-visible context, a candidate at or above the configured auto-compaction threshold is composed again without restored files or images. The service subtracts only the local history-size difference from its existing token count; it retains the accounting for the summary and non-visible system/tool context.

This second composition preserves plan-mode reminders, running background-agent reminders, and the trailing tool call needed to pair with a pending result. It does not issue another summary request or fire another compaction hook. Existing payload-overflow and hosted-file-restoration exclusions continue to apply.

## Scope and limits

This is a restoration-stage fix. Compression-request admission (#9455 / #15936) and subsequent request accounting (#15486) remain separate. The local token estimate is approximate; these limits do not promise exact admission for every provider or make an oversized summary fit. Existing empty-summary, truncated-output, and inflated-count failure handling remains in place.

## Validation

- Reproduce a successful candidate exceeding a 16K window using five real files and a completed mock summary.
- Verify that 16K and 32K windows retain only the file contents that fit, keeping other files as references.
- Verify unchanged restoration for 128K and 200K windows and the 50K ceiling with a 1M window and an increased file-count limit.
- Cover zero remaining file-content budget.
- With and without summary usage metadata, force restored files and images above the auto threshold; verify their removal, retained non-visible accounting, reminders, and pending tool-call pairing.
- Run the existing compression, attachment, and token-estimation suites. Service tests isolate this stage from compression-request admission and do not represent live-provider E2E evidence.
