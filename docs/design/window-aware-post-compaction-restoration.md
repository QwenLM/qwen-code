# Window-aware post-compaction restoration

[English](window-aware-post-compaction-restoration.md) | [简体中文](window-aware-post-compaction-restoration.zh-CN.md)

## Problem

After a successful summary, restoring recently accessed files can put the next conversation back over a small context window (#15487). The existing 50,000-token file-content budget is independent of the window. Image restoration has a count limit, but no aggregate token budget. Checking only that the candidate is smaller than the original does not prevent this overflow.

## Behavior

The compression service gives restored file contents a budget of `min(50_000, floor(effectiveWindow / 4), floor(autoThreshold / 2))` tokens. The effective window incorporates a smaller server-reported input or total ceiling when the rejected request route matches the active main route, including when a separate model generates the summary. The summary generation output budget retains its own route and ceiling rules. The auto threshold includes the user's configured percentage. Reserving half that threshold for the summary and other context allows partial restoration at low thresholds, including the default 40K-window threshold.

The composer reserves the configured per-image token cost for the images it actually restores, then gives the remaining budget to file contents. File contents and restoration-size estimates use the same CJK character ranges and multiplier as summary estimation. Other scripts retain the character-based estimate. The per-file reader's character-size cap and the file-count limit still apply. Files that exceed the content budget remain available as path references, with the most recently accessed files considered first. Direct restoration callers that omit a budget use the 50,000-token default.

The overflow check includes the summary, restored content, existing non-visible context, and pending tool result. The existing published count already carries the pending tool result on automatic compaction. The gate adds CJK corrections for locally estimated text, including the summary and acknowledgement when summary usage is unavailable or cache-sharing accounting applies. Provider-reported summary output remains authoritative. Both the character estimate and CJK correction use the same Part traversal, which excludes media and wrapper reserves from text correction.

The restoration target is `min(autoThreshold, max(0, effectiveWindow - 3_000))`, reserving the existing hard buffer for request overhead. At 16K, the default target is 13,000 tokens. When embedded file bodies or images were restored and the corrected candidate reaches this target, the history is composed again with all restored file blocks, path references, and images removed. References-only and reminder-only histories retain their first composition. Published counts and the inflation guard retain their existing character-based visible-history delta, anchored to the original total. Attachment removal subtracts the delta on that same basis, preserving summary and non-visible system/tool accounting. A debug log records the number of removed blocks, the target, CJK corrections, and counts before and after attachment removal.

This second composition preserves plan-mode reminders, running background-agent reminders, and the trailing tool call needed to pair with a pending result. It does not issue another summary request or fire another compaction hook. Existing payload-overflow and hosted-file-restoration exclusions continue to apply.

## Scope and limits

This is a restoration-stage fix. Compression-request admission (#9455 / #15936) and subsequent request accounting (#15486) remain separate. The local token estimate is approximate; these limits do not promise exact admission for every provider or make an oversized summary fit. Existing empty-summary, truncated-output, and inflated-count failure handling remains in place.

## Validation

- Use five real files and a completed mock summary to verify the 16K restoration budget and composed-history size. A candidate between the 13,000 restoration target and 13,600 auto threshold must drop embedded bodies.
- Verify that 16K and 32K windows retain only the file contents that fit, keeping other files as references.
- Verify the window-quarter bound below 200K. At 128K, the 32K budget embeds six of eight 20,000-character files and retains two paths. At 200K, the 50K budget embeds all eight. Verify the 50K ceiling with a 1M window and an increased file-count limit.
- Cover zero remaining file-content budget and preserve references-only histories above the restoration target.
- Cover server-reported total ceilings, input-only ceilings, separate summary models, and route mismatches.
- Verify partial restoration with a 40K window and with low configured auto thresholds.
- Verify CJK content consumes the text-token budget, non-CJK scripts retain their existing estimate, and shrinking CJK histories compact successfully with missing usage metadata.
- Verify actual restored images reserve their configured token cost before file contents are allocated.
- Verify ASCII pending tool results are counted once, CJK pending results receive a correction, and a substantial summary survives attachment removal in the reported count.
- Compare configured and default auto thresholds and check the attachment-removal debug log. Verify usage-less CJK summaries trigger removal while provider-reported summary usage receives no additional correction.
- With and without summary usage metadata, force restored files and images above the restoration target; verify their removal, retained non-visible accounting, reminders, and pending tool-call pairing.
- Run the existing compression, attachment, and token-estimation suites. Service tests isolate this stage from compression-request admission and do not represent live-provider E2E evidence.
