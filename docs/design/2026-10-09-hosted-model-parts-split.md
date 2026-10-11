# Hosted no-tool model Parts preservation

[English](2026-10-09-hosted-model-parts-split.md) | [简体中文](2026-10-09-hosted-model-parts-split.zh-CN.md)

## Scope and provenance

This extracts the completed Hosted model boundary fix from Draft PR #13526
(head `e8f11063463f846ab807764ede8e9aad272204f2`) onto main
`f829ee98c74`. It includes the no-tool Parts change originally committed in
`4f82b9d597bd` and the source head's thought-only history guard. It uses the
existing Hosted tool interface; the later CSI turn abstraction is unnecessary.

This independently reviewable slice changes ordinary Hosted no-tool turns.
Private CSI attachment, authorization, file execution, SQL migrations, cold
recovery and physical retirement remain in the original Draft.

## Behavior and consumers

The no-tool caller currently returns accumulated display text and a model name.
Its assistant consumers rebuild one text Part, losing other provider Parts.
Return a deep clone of the complete final model history instead, preserving
order, reasoning, thought signatures and inline data. Continue to return the
existing display text separately. Missing final model history is an error,
as it already is for tool-enabled turns.

Both fresh-turn and recovery assistant consumers in
`hosted-harness-session.ts` already prefer `result.parts` over the text fallback.
No consumer or public interface needs a new field, switch or route. Subsequent
model turns reuse the saved Parts through the existing history path.

A `MessageDisplay` suppression returns empty text and empty Parts in either
branch. Retry, fallback and Stop handling still choose the final accepted
model history. A hook-generated stop reason keeps its explicit text Part.

A thought-only historical assistant does not answer its user prompt. Omit that
pair from no-tool history, just as an empty or missing assistant is omitted.
Keep complete Parts in pairs that contain a visible text answer. The existing
tool-enabled history and function-call identity checks stay unchanged.

## Verification

Compare the original main baseline with this candidate. Check full ordered
Parts and deep cloning, unavailable history, suppression with and without tools,
retry/fallback output and thought-only versus visibly answered history pairs.
Run the Hosted model, real local-provider integration and session consumer
suites, plus repository build and typecheck. Use an owned loopback SSE provider
to inspect returned Parts and the next request without external model access.
Record independent reproduction and verification in the PR's separate report;
previous #13526 evidence does not qualify this extracted revision.

## Risks and remaining review slices

Ordinary Hosted no-tool transcripts now retain all provider Parts instead of
only display text. Existing resource-size limits and provider-specific history
conversion still apply. This does not qualify a private CSI producer or worker.

After this slice merges, synchronize the original Draft with main before
extracting the next part. Candidate boundaries are complete retained file
reads/history, original CSI identity and admission, then native batch/history
execution. Their exact scope must follow dependency checks on the refreshed
main; cold recovery and physical retirement remain separate acceptance gates.
