# Per-response output tokens for model cost estimates

[English](2026-10-25-model-cost-output.md) | [简体中文](2026-10-25-model-cost-output.zh-CN.md)

## Problem and scope

PR #15464 fixes included reasoning being charged twice, but inferring billable output after aggregation loses which requests omitted total tokens. A disjoint response with prompt 100000, candidates 50000, thoughts 120000 and total 270000 followed by a response with prompt 20000, candidates 10000 and no total should bill 180000 output tokens. The aggregate subtraction instead returns 150000. Missing-total OpenAI responses also retain the original double count.

The goal is consistent output cost on Ink, OpenTUI and non-interactive model stats. Preserve raw token counters, pricing, managed usage serialization, and history/dashboard accounting.

## Design

Compute billable output before each API response is accumulated. Accept reported total minus prompt only inside the response's candidates-to-candidates-plus-thoughts range. Otherwise use candidates for `openai`, `openai-responses` and `qwen-oauth`, whose output includes reasoning; use candidates plus thoughts for disjoint usage. Sum these per-response results by model and source in an optional sibling of the raw model metrics.

The sibling map keeps the closed managed usage schema intact. Updating raw totals would change unrelated consumers; adding fields to raw model/token records would break managed record validation. State copies, equality checks, replay rollback and reset must carry the billing map alongside the existing metrics. Prototype-sensitive model/source keys must be handled like other telemetry dictionaries.

Cost renderers prefer the authoritative per-response sum, including zero. Existing snapshots or manually supplied metrics without that sum retain the existing aggregate fallback. Raw-only managed restores cannot reconstruct provider provenance; later responses must not cause a future-only sum to masquerade as the full historical total. That legacy limitation is explicit rather than inventing missing history.

## Verification and acceptance

- Complete OpenAI usage bills 150000 rather than 270000; complete disjoint usage remains 170000.
- Missing-total OpenAI usage bills candidates once, while disjoint usage retains reasoning.
- The mixed same-source sequence bills 180000 in either event order, and splitting sources preserves the sum.
- Raw counters and managed model JSON retain their original values and shape.
- Billing survives UI state copies and replay rollback; reset clears it; raw-only restore does not publish partial historical totals as exact.
- All cost surfaces use the authoritative count and preserve zero-cost and missing-price behavior.

Use real telemetry accumulation in focused regression tests, render numeric cost evidence, and run build, typecheck and affected package tests. Compatibility fixtures prove the accepted missing-metadata path, not captured live provider behavior. No new provider requests or pricing rules are required.
