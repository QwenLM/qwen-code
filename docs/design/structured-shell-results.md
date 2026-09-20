# Structured Shell results

[English](structured-shell-results.md) | [简体中文](structured-shell-results.zh-CN.md)

## Scope

Replace the Web Shell completed-result text parser with a versioned structured Shell result. Keep model-facing llmContent unchanged and keep the existing human display text for terminal consumers. Legacy records render verbatim. Background launch acknowledgments are not completed process results and retain their existing format. No streaming transport changes.

## Contract and flow

Core produces a shell_result version 1 returnDisplay containing text, output (combined stdout/stderr), directory, exitCode, signal, pid, error, outcome, notices, truncated, and outputFiles. Outcome distinguishes completed, failed, cancelled and timed_out. Empty output is an empty string, without sentinels. Notices never become stdout. The scheduler and recording/replay retain the existing resultDisplay path; ACP exposes it as rawOutput. Web Shell validates the discriminator and fields, never parses text. Terminal and text-only consumers use text.

## Bounds and compatibility

Keep producer display text intact through PostToolUse; apply existing display compaction to all result text fields at history/recording boundaries; preserve numeric/status fields and mark truncation. ACP projection also bounds the serialized structured result, preserving valid JSON and metadata. SDK safe previews retain a bounded structured variant; export collection carries the result; the version 1 HTML document schema uses its sanitized text fallback without introducing a new document variant. Unknown versions use their string text fallback without interpreting metadata, or full JSON when text is absent. Legacy strings retain original text. Model output, existing output-file persistence, approvals and execution ownership are unchanged.

## Validation

Check real producer success, nonzero exit, empty/literal output, timeout/cancellation, long-run notices, truncation, saved record replay, ACP byte bounds, terminal text, SDK preview/export and Web Shell rendering. Run scoped tests/build/typecheck and review the full diff. Existing repository build failures are reported separately.

Shell outcome follows the existing exit-error policy: exit 1 from grep/rg/diff/test is a completed negative result, not an execution failure. Web Shell trusts the structured outcome and retains the numeric exit code in details. PostToolUse and PostToolBatch hooks keep string display fields through shared normalization; UI/history retain structured data. Running elapsed time is visible beside the status.

Exported version 1 documents without structured metadata render the complete text fallback without the live categorized card. The directory field is the resolved execution directory. Signal termination, cancellation and timeout do not display a potentially synthetic exit code. Container cleanup failures append a notice to compatible text and structured notices, leaving command output intact.
