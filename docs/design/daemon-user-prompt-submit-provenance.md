# Daemon UserPromptSubmit provenance

[English](daemon-user-prompt-submit-provenance.md) | [简体中文](daemon-user-prompt-submit-provenance.zh-CN.md)

## Problem and evidence

A normal daemon prompt on main `1919ff97f5` runs the configured UserPromptSubmit hook but omits `submitted_prompt`, so Mem0 Auto Recall returns `{}` without searching. The initial fix inferred provenance from request text on fresh non-channel ACP turns. Review at `2b4f46a` and a failing Session/Hook probe showed that scheduled tasks, sub-session spawns, and Live task dispatches also satisfy that condition. Their machine-composed text must not acquire provenance by default.

## Scope and ownership

Preserve the owning session's configuration, message bus, cwd, registration, and environment. Add explicit submission propagation across the existing client, daemon admission, bridge, and ACP child boundaries. Do not change legacy hook invocation, recording, provider configuration, credentials, default extension registration, or managed memory recall.

REST prompt admission is live-session-owner scoped; it uses the already-resolved owner bridge and runtime. ACP HTTP/WebSocket admission uses its bound session and bridge. No new route or primary-runtime fallback is introduced.

## Design

A supported client declares the original submitted text in `_meta["qwen.submittedPrompt"]`. Web Shell captures its composer text before host `prepareSubmit`, slash-command rewriting, and attachment expansion. Ordinary queues store this original declaration independently of the prepared payload. Generic actions, manual scheduled runs, retries, and server-restored queues do not create declarations. Re-submitting restored content from the editor is a new Web Shell submission; this change does not add core TUI-style editor provenance tracking. The existing core TUI producer is unchanged. Both ordinary and queued Web Shell submissions retain their existing admission behavior. Clients must omit the declaration for machine-generated input. This is an explicit per-request contract, not proof of human authorship, authentication, or DLP.

The REST and ACP transport routes read the declaration and pass it as `submittedPrompt` in the bridge context. REST channel-worker requests, including requests whose worker authorization is no longer valid, do not gain provenance through that route. The bridge strips both public and private submission keys from the request and re-injects only context-declared text as `qwen.daemon.submittedPrompt`; channel and promoted mid-turn dispatches omit it. Internal scheduled, sub-session, Live task, and other automated dispatchers provide no declaration. Realtime voice handoffs also omit the declaration: their request text comes from model-generated tool arguments rather than an independently verified user transcript.

At ACP process admission, a trusted parent can supply the private key; a direct ACP client can opt in with the public declaration but cannot forge the private key. The public key is consumed at admission and does not pass through to Session. A trusted parent cannot use a public key as a fallback when the private declaration is missing.

Session emits `submitted_prompt` only for fresh non-channel turns with a nonblank string declaration. Missing, invalid, empty, or whitespace-only values omit the field without falling back to request text or `promptDisplayText`. Preserve the declared whitespace. Display projections retain their existing recording consumers but no longer establish submission provenance. Channel markers cover both automated events and human messages; both remain excluded in this version.

Keep `isFreshUserTurn` and managed memory recall unchanged. Retry can still invoke legacy hooks but omits submission provenance; continue, restored-question, and runtime-goal turns retain their existing hook exclusions. Tool-result and other internal re-entry loops do not create a declaration. Local-only slash commands that return before model execution remain outside this hook path.

The initial ACP `prompt` remains the request's pre-expansion text-block join, not the complete expanded model input. TUI-specific Vim, paste, history, undo, and rewind rules do not automatically apply to ACP clients; each client owns the provenance of its declared text.

## Consumers and compatibility

The hook pipeline preserves `submitted_prompt` while adding session/cwd metadata. Auto Recall uses it as the search query; every configured hook can receive it. The default Mem0 extension remains MCP-only and Auto Recall still requires explicit v3 configuration and registration.

Web Shell supplies declarations for user submissions. Other ACP and daemon SDK clients must opt in per eligible request; existing clients without declarations continue invoking legacy hooks but do not trigger provenance-gated retrieval. Do not add a declaration globally to an SDK transport or automated dispatcher. Older daemon versions may ignore this optional metadata, so absence must remain normal for consumers. This changes eligibility from the earlier unmerged implementation, not the released default MCP behavior.

Newly eligible ACP/daemon payloads include `submitted_prompt`. Administrators whose hooks reject unknown fields, for example through `additionalProperties: false`, must test the deployed hook against the new payload before rollout because rejection can fail open or closed. See [UserPromptSubmit](../users/features/hooks.md#userpromptsubmit) for current semantics and the predecessor design's [Compatibility and migration](submitted-prompt-provenance.md#compatibility-and-migration) for the strict-decoder note only. Its producer table predates headless and ACP support and is not the current eligibility list.

The Direct Profile's managed launcher remains TTY-only; broader field producers do not expand that deployment contract. A Mem0 v3 profile remains bound to one canonical repository root and scope. Other workspaces skip retrieval; no per-workspace profile routing is added. Sanitization, bounded timeouts, fail-open output, and untrusted context wrapping are unchanged.

## Validation and acceptance

- Reproduce the undeclared non-channel failure before editing and preserve the failing assertion.
- Test explicit, missing, invalid, empty, whitespace-only, retry, channel, and model-only cases at Session. Remove the new declaration gate and confirm omission cases fail.
- Test spoofed private keys and public opt-in at admission; verify bridge requests without trusted context cannot acquire provenance. Preserve the raw original text through attachment expansion; model-only content must not replace the declaration.
- Run a real local daemon with an observing hook and controlled model. Explicit ordinary submissions must publish the declared text; marker-less machine submissions must not. Validate the rebuilt bundle, not an older installed binary.
- Run affected package tests, build, bundle, typecheck, formatting, lint, and two full self-audit passes. Record evidence without credentials under `.qwen/e2e-tests/`.

## Status

The original implementation at `4fb7d2f0a9` passed 869 Session tests and four local plus four real Holo scenarios. Those results predate the explicit-declaration correction and must not be presented as validation of it. Both synthetic Holo records were removed. Records were seeded/deleted directly through Holo, the model was controlled locally, and workspace B tested exclusion rather than a second profile. The review correction's reproduction and verification are tracked separately in `.qwen/issues/pr-11455-provenance.md`.
