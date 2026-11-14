# ACP first-session startup

[English](acp-first-session-startup.md) | [简体中文](acp-first-session-startup.zh-CN.md)

## Problem and goals

Before the watcher change, an ACP child started the CLI's recursive extension file watcher before entering the protocol loop. Its refresh state is consumed by the interactive UI, which ACP never starts. Large extension trees therefore added work without providing an ACP refresh consumer.

The goal is to remove that work, then reduce the remaining initialization cost until the first new session completes within 500 ms without channel preheating. The target includes spawning and initializing a previously absent ACP child during the session request. Separate measurements must report daemon process startup and first-prompt work; returning a session before its required initialization is complete does not satisfy the goal.

## Proposed changes and decisions

Skip construction of the interactive extension watcher for both `--acp` and `--experimental-acp`. Retain its existing safe-mode, bare-mode and execution-sandbox conditions for other invocations. Preserve settings hot reload, SkillManager subscriptions, extension parsing, hooks and session lifecycle behavior.

Profile the remaining cold path on the current main-branch baseline. Make further changes only after their cost and consumers are identified. Session identifiers, recording and writer ownership, authorization, workspace trust, runtime overlays, hooks, tools and resource discovery must remain correct. Do not share mutable session Config objects or suppress initialization errors.

ACP Config initialization also starts the existing ripgrep health check after binding the session execution engine and overlaps it with resource loading. The original tool-registration decision awaits the same result, preserving backend selection and fallback diagnostics. This applies only to local ACP configurations that use ripgrep; managed execution, delegated execution, shell sandboxes and bare mode keep their existing paths. Safe mode retains its existing ripgrep selection.

An initialization-owned abort controller combines with the caller and execution-shutdown signals. Initialization always cancels and drains its probe on exit, including resource-load failures. A later registry rebuild performs a fresh normal check after failure; no failed promise is cached across configurations or inherited by a derived subagent configuration.

Affected implementation paths are CLI startup, Core Config initialization, the ripgrep health-check helper and their collocated tests. The optional registry promise is supplied only by initialization; direct registry callers retain the existing behavior.

Command registration keeps attach and export metadata synchronous while loading daemon client constructors only when attach starts, and export collection, normalization and formatters only after a valid session is selected. Attach retains its existing abort and exit deadline and refuses to connect if shutdown occurred during module loading. Export retains path revalidation, file modes and workspace artifacts. The existing pure filename helper stays eagerly available. Scheduled-task source identifiers use the existing leaf export instead of loading the entire ACP bridge.

Within each Qwen extension, command/context, Skill, agent and workflow discovery run concurrently after its manifest head is loaded. Any enclosing store read lock remains held until all four reads settle; direct callers do not acquire a new lock through this join. Result arrays, discovery-error metadata and original rejection priority remain unchanged; warnings and filesystem reads from different resource categories may interleave, including reads that the old sequential path would not reach after an earlier failure. Cross-extension batches and the second complete scan remain in place.

### Lazy CLI command registration

The local command-registration implementation keeps the existing CLI parser and complete ACP startup chain. The baseline configuration module imports 15 top-level command implementations even when the default ACP command is selected. Their registration metadata is needed eagerly, while their builders, handlers and subcommand dependencies are needed only for a selected command. A dedicated ACP parser or a copy of the startup initializer is unnecessary.

Use one pure registration metadata table as the source for the original command objects and lazy registrations. Preserve the actual command syntax, aliases, descriptions and registration order; the existing `TOP_LEVEL_COMMANDS` help-display table remains unchanged because its display labels are not equivalent to parser syntax. Original command objects reuse the shared metadata. Two explicit localization cases retain their current behavior: auth evaluates `t(...)` eagerly when its metadata object is constructed, and update retains a `describe` getter. The shared table can hold their English message keys, but spreading an evaluated getter must not turn update's description into a fixed string.

A small auth metadata leaf is shared by the registry and original auth module. It preserves the early translation snapshot when command implementation loading is delayed, while importing only the pure table does not capture auth's language early. The lazy update descriptor forwards its getter instead of copying its evaluated value.

Before parsing, conservatively load the original command objects whose names or aliases occur anywhere in a raw argument. This includes yargs forms such as `--_=update`; a false positive in an option value or path only loads an extra implementation. Register metadata for the remaining commands and let the existing yargs parser choose the command. Selected commands keep their original synchronous builders and handler references, nested commands, options, defaults, validation, middleware and awaited handler completion. Keep the original default-command builder, strict parsing, failure handling, deprecation and argument post-processing. No new configuration switch or ACP-specific argument interpretation is introduced; settings, authentication, trust, capability handling, runtime initialization and session readiness stay on their existing paths.

The installed yargs version accepts asynchronous builders, but a validation error following one can bypass its synchronous failure-rendering path. Its default completion path also calls a builder without awaiting its Promise. Retain synchronous builders for normal parsing and eagerly load all original command objects when a raw token contains the reserved `get-yargs-completions` marker. A false positive restores the existing eager behavior and still runs all parsing and validation.

Keep this change within CLI registration, the pure metadata table and small metadata reuse edits to the original command objects. Avoid Core import sweeps, tool first-use deferral and removal of startup checks. The final same-main combined source has now been measured; its result does not isolate command registration. Static reachability or byte counts alone do not establish a timing improvement.

## Scope and constraints

No pre-created business sessions, background channel preheat, empty resource substitutions or disabled security checks may contribute to the acceptance result. Process-cold tests may have warm filesystem pages; reports must state this and must not describe them as physical-disk-cold measurements. External model and MCP latency are separate from local initialization.

Public documentation and performance evidence must contain no credentials, user or tenant identifiers, internal hostnames, private resource contents, internal artifact URLs or absolute personal paths. Use a reproducible synthetic workload for public reproduction and publish only aggregate statistics from private workloads.

## Validation and acceptance

- Verify that ACP does not construct the interactive watcher and that interactive startup still does.
- Compare full Skill rows and menus, out-of-band file changes, reloads, session isolation, authorization and trust changes, runtime overlays and shutdown against the baseline.
- Disable automatic preheat explicitly in the benchmark and prove that no channel exists immediately before the timed first request. Include child spawn, ACP initialization and fresh session creation in the timer.
- Use repeated, interleaved baseline and candidate runs with fresh process and state. Report all samples, median, maximum and the limits of the sample size. Keep diagnostic profiling separate from acceptance timing.
- Run build, typecheck, focused unit tests, functional verification and two clean self-audit passes before submitting the PR.
- Verify interruption during attach module loading preserves exit code 130 without connecting, and all four export formats, invalid paths, missing sessions, file permissions and ACP artifacts retain their behavior.
- Before implementing lazy command registration, capture the original 15 command registrations and baseline global CLI command/help/completion behavior and the exact published control artifact. Compare real command syntax, aliases, localization and property descriptors against that snapshot; preserve auth's eager translation and update's getter across language changes.
- Verify top-level and nested help, completion, defaults, coercion, invalid arguments, deprecated options, handler completion and exit/output behavior. Include missing option values, `--_=command`, conservative name matches in option values and reserved-completion-marker false positives; retain the existing fast-help/full-parser differences.
- Rebuild and inspect the actual ACP cold graph, then repeat complete settings/auth/trust/session/shutdown checks and controlled SDK/total measurements. Do not reuse code caches from an older chunk graph or combine the new candidate with unrelated performance changes during qualification.
- A verified first-request result below 500 ms is required for the complete performance goal; a partial improvement must be labeled incomplete.

## Status and open questions

The watcher change merged separately in PR #17177. The final local integration is based on main 6f754be6548903e545e6ff0ed43a34927fe3bfb9 and combines the conservative initialization changes, [bounded repeated YAML parsing](yaml-frontmatter-parse-cache.md) and lazy CLI registration. The measured snapshot of 25 production and 11 test files passes build, typecheck and bundle; the PR subsequently corrects another managed-initialization test for the optional parameter without changing production files. CLI focused tests pass 1,110/1,110; Core passes 2,090/2,091, with the sole pre-existing assertion also reproduced on exact clean main. Independent functional E2E passes 59 checks per side, while retaining ordinary stale-catalog timing differences. These validations do not replace normal Core/maintainer review.

Eight interleaved source-only pairs against the same main give a complete first-SDK median of 815.994 to 706.277 ms and mean of 833.257 to 719.861 ms. Pair 7 is slower on the candidate and is retained; both sides have 0/8 results below 500 ms. The combined result does not isolate individual source changes. The full [evaluation](../performance/acp-initialization-evaluation.md) retains every row and the separate earlier cohorts, including the older 799.173 to 723.808 ms component experiment and its 1,310.803 ms observation. These results must not be joined to the original 1,662 ms observation or each other as one control.

A separate earlier YAML/cache four-arm cohort retains original parent flags and no flush. Its installed-cache condition has a 521.601 ms median, two of four creates below 500 ms and a total mean slightly higher than its control. It is not the final integration or a default result. Earlier GC/flush, resolver and AOT diagnostics remain separate too.

Final-build native diagnostics observe 414/397 generated ESM targets in the control parent/child and 420/369 in the candidate over three sessions. An initial trace-free qualification using all 787 candidate main-build outputs reaches a standard pre-evaluation link barrier and independently proves cache writes; that trial has no consumer or runtime timing conclusion. A later separate eight-pair installed-cache/resolver cohort has a 559.677 ms candidate first-SDK median and 0/8 results below 500 ms, with its own producer/consumer and native-consumption proofs in the evaluation. Installation and owned-launcher integration remain unimplemented. The source candidate is unpublished and contains no experimental resolver, installed cache or launcher/GC policy. The complete 500 ms goal remains incomplete; the local Node26.7 result does not qualify a downstream Node22.23.4 image or live deployment.
