# Daemon UserPromptSubmit provenance

[English](daemon-user-prompt-submit-provenance.md) | [简体中文](daemon-user-prompt-submit-provenance.zh-CN.md)

## Problem and evidence

A normal daemon prompt on main `1919ff97f5` runs the administrator-installed UserPromptSubmit hook, but the ACP input includes only `prompt`. The Mem0 Auto Recall hook requires `submitted_prompt`; the real daemon probe therefore returned `{}`, made zero provider requests, and injected no memory. Explicit MCP search/write/delete already passed the independent Holo regression.

## Scope and ownership

This change supplies the existing optional hook field in the ACP session execution path. The owning session's configuration, message bus, cwd, hook registration, and environment remain authoritative. No daemon route, wire field, provider configuration, credential handling, or default extension registration changes. The change applies to ACP hosts using this session path, including daemon, rather than to daemon alone.

## Design

Capture the submission text before slash-command, resource, and model-only prompt expansion. Use the existing trusted `promptDisplayText` projection when present; otherwise use the text blocks in the ACP request joined with a space, matching the headless text projection. Preserve the original whitespace. An explicitly empty display projection does not fall back to internal channel instructions.

Add `submitted_prompt` only when the existing `isFreshUserTurn` classification is true, the turn is not channel-classified, and the captured text is nonblank. A channel turn (`qwen.channel.prompt`) is a machine-relayed delivery — a loop job, webhook task, or adapter-synthesized event such as an issue assignment — so its display projection is a label rather than a submission, and its composed wrapper text is internal channel instructions rather than user text; because the field's presence alone gates Auto Recall's outbound provider search, channel turns omit it even when a projection is present. Human channel messages share the same transport marker, so they are excluded with the class in this version rather than distinguished by a display-projection heuristic. Keep the legacy `prompt` value and existing hook execution policy unchanged. Retries may still run legacy hooks but must omit submission provenance; continue, restored question, and runtime goal turns retain their existing hook exclusions. Tool-result, Stop-hook, and background re-entry loops do not create another submitted prompt. Local-only slash commands that return before model execution remain outside this hook path.

Do not project resource bodies, image/audio contents, model-only delegation, expanded slash-command content, or earlier hook output into the new field. An ACP text block is the host's submitted text, not proof of human authorship; this field is not an authentication or DLP boundary. The trusted display projection is already filtered at the daemon/bridge/ACP admission boundaries; this patch adds no caller-controlled metadata override.

## Consumers and compatibility

The existing hook pipeline preserves this field while adding session/cwd metadata. Mem0 Auto Recall consumes it as the search-query source. Configured hooks may also read it. The default Mem0 extension remains MCP-only; administrators must explicitly register Auto Recall and provide its v3 configuration. An already opted-in daemon launcher will start performing eligible searches after this fix, so its existing credential and repository binding must be intentional.

This change makes `submitted_prompt` appear in `UserPromptSubmit` payloads on ACP, daemon and `serve` hosts that previously never carried it. Administrators whose hooks reject unknown fields (for example a JSON Schema with `additionalProperties: false`, or any strict decoder) must re-test the deployed hook against the new payload before rollout, because strict-decoder failure can change whether an invocation fails open or closed. See `docs/users/features/hooks.md` and `docs/design/submitted-prompt-provenance.md` (Compatibility).

A single v3 Auto Recall profile stays bound to one canonical repository root and one scope. A second workspace outside that root must skip retrieval; this fix does not add per-workspace profile routing. Existing sanitization, bounded timeout, fail-open output, and untrusted context wrapping remain unchanged.

## Validation and acceptance

- Reproduce with a real daemon and an observing wrapper that passes the hook JSON unchanged to the shipped Auto Recall bundle; no fabricated submission field.
- Unit tests pin ordinary/multiple text blocks, non-text attachments, trusted model-only content, display projections including empty text, blank input, retry, and channel-turn exclusion.
- After rebuilding, a normal daemon question must reach a loopback provider once and inject its synthetic memory into the actual model input without a search MCP tool. Tool continuation must not trigger a second search. A workspace outside the configured repository must inject no memory.
- Use isolated Holo records to verify fresh-session automatic recall, workspace exclusion, then deletion followed by a fresh session with no deleted record and a retained control. Delete only the synthetic records created for this run and verify cleanup.
- Run the changed package tests, build, typecheck, and focused lint; audit the complete diff. Record observed results under `.qwen/e2e-tests/` without credentials.

## Status

Implemented and verified on 2026-09-09 against `1919ff97f5` plus this working-tree change. The global CLI and pre-fix daemon probes reproduced the missing-field failure. All 871 session tests passed, as did build, bundle, typecheck, lint and formatting. Local and real Holo acceptance each passed all four scenarios using fresh sessions and actual model-input assertions. Both synthetic Holo records were removed and confirmed absent.

The model was controlled locally; daemon, hook and Holo searches were real. Records were seeded and deleted directly through Holo for this hook-specific test; explicit MCP write/delete were verified separately. Local provider request counts were measured; cloud validation records one hook invocation per turn but does not independently count the hook subprocess HTTP requests. Workspace B was excluded by the configured repository binding, not routed to a second profile. Evidence is recorded in `.qwen/e2e-tests/holo-auto-recall-fix-20260909-report.md`.
