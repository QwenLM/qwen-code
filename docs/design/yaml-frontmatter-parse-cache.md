# Repeated YAML frontmatter parsing

[English](yaml-frontmatter-parse-cache.md) | [简体中文](yaml-frontmatter-parse-cache.zh-CN.md)

## Problem and goal

Resource discovery parses the same frontmatter more than once during ACP initialization and subsequent refreshes. Before this change, the shared YAML wrapper always parsed and converted the text again. Reduce this repeated work while preserving fresh results, diagnostics and all resource validation. Separate component and integrated latency evidence is reported below without treating them as one cohort.

## Proposed change

Keep a private process-local FIFO cache in `packages/core/src/utils/yaml-parser.ts`, keyed by the exact input text. Admit at most 256 successful raw object results with inputs no longer than 16,384 UTF-16 code units. These fixed bounds limit retention; they are not a precise heap bound or a new setting. Do not persist the cache or share it across processes.

Reuse the existing schema and tag options. A normal miss parses a document and admits it only when it has no errors or warnings and every mapping key is null or a scalar with a primitive value. Collection keys, alias keys and object-valued scalar keys use the original parser so its conversion-time warnings remain visible. Conversion and the existing sanitization must both succeed before admission. Invalid, non-object, oversized and fallback results are not cached.

Every return, including a hit, runs the existing recursive sanitizer on the private raw result. Returned nested objects and arrays must remain independent, null properties remain stripped, explicit typed values retain existing coercion, and mappings retain null prototypes. Never return the cached raw object or a previous sanitized result.

When `LOG_TOKENS` or `LOG_STREAM` is truthy, bypass both cache lookup and document preflight and run the original parser once. This preserves the library's debug output, including for the string `"0"`. Warning and error inputs otherwise retain the original parser and fallback behavior on every call. An ineligible miss may pay for a preflight and a second parse; measure that cost rather than hiding it.

## Scope and consumers

Within this cache component, only the shared `parse` implementation and its collocated tests change. `stringify`, direct AST readers and resource discovery remain unchanged. The ten in-repository reader files cover Skills, subagents, commands, rules, output styles, structured memory and extension conversion. The Core public reexport also exposes this contract to external callers; the optimization cannot assume a particular resource type or caller ownership.

File reads, edits, deletion, activation, workspace scope, validators, hooks, authorization, cancellation, tools and readiness run normally. The cache holds only parsed text, not a resource decision or session object. It adds bounded retention of potentially sensitive frontmatter until eviction or process exit.

## Validation and acceptance

Use the global CLI for the baseline dry-run, then the local bundled CLI for verification. Check resource loading, edits/deletion and isolation without a model request. Use a direct test-script fallback for internal mutation ownership and YAML diagnostics that the CLI does not expose reliably.

Focused tests must verify independent nested results, null prototypes, aliases and typed values; unchanged parser warnings, errors and fallback on repeated calls; debug flags toggled around a populated entry; exact-text keys, eviction and oversized bypass. Build, typecheck and affected consumer tests must pass. Re-audit conversion warning paths when upgrading the YAML library.

Run a new interleaved full-SDK benchmark against an otherwise identical published artifact. Keep fresh process/runtime/session state and complete resources, retain every sample and report first-session and total startup clocks separately. Parsing microbenchmarks do not establish the 500 ms goal. Do not ship this cache unless measured gains justify its admission logic and retention cost.

## Status and open questions

The local cache implementation and its focused tests are complete. The installed YAML library is 2.9.0; its warning/conversion paths and debug environment readers were inspected. Baseline global-CLI and direct-parser checks, repeated values/prototypes/warnings/debug comparisons, and integrated build/typecheck/consumer tests establish the covered semantics. The public Core export and external callers still require normal maintainer contract review.

A separate otherwise-matched four-arm component cohort isolates YAML on an earlier source: empty-cache SDK medians are 773.850 to 730.584 ms, while installed-cache/resolver medians are 560.817 to 521.601 ms. The latter candidate is slower in two pairs and its total mean is 941.971 ms versus 941.672 ms for control. All four pairs remain; neither condition proves a stable 500 ms result or tail bound.

The final same-main source combination, which also includes initialization and lazy-command changes, measures 815.994 to 706.277 ms median and 833.257 to 719.861 ms mean over eight pairs. This is not a YAML-only attribution. Final integration E2E passes 59 checks per side but retains ordinary stale-view timing differences. The cache is unpublished, and the full 500 ms goal remains incomplete; see the [evaluation](../performance/acp-initialization-evaluation.md). The fixed limits may be reduced if justified by the actual corpus; adding configuration is outside scope.
