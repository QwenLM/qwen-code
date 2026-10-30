# Hosted approval input: Harness and card wiring

[English](2026-10-05-hosted-approval-input-wiring.md) | [简体中文](2026-10-05-hosted-approval-input-wiring.zh-CN.md)

## Problem and scope

#13160 requires an approver to see the input of the exact call being approved. The Java reader in #13400 accepts version 2 Action options and returns a bounded preview, but the Harness still writes version 1 and the managed WebShell provider drops the preview. This change completes that producer/card path. It depends on deploying the [Java reader](2026-10-04-hosted-action-input-preview.md) first and does not enable public Shell admission in #13271.

## Harness and resource commits

Keep version 1 options unchanged. Version 2 adds a required `inputRef`, with the existing durable-reference metadata and resource schema version 1. Emit version 2 only for `read_file`, `write_file`, `edit` and `run_shell_command`, matching the Java reader. MCP and unsupported tools retain version 1; internal grants are not exposed. Action envelopes, approval policy, decision bytes and digests remain unchanged.

Use the captured reference passed to the current `ask` call. The same reference already becomes the current checkpoint's `approval.invocationRef` and supplies the approved native invocation. Do not reconstruct input, search by tool name or use `attempt.routeRef`: a later approval can retain a previous attempt while its invocation changes. When PreToolUse rewrites arguments, the existing recapture/reapproval path must put the new reference in the new Action and retain the earlier Action's reference.

The first Action commit precedes its await-action checkpoint. Publishing a resource only stages its bytes, so waiting for checkpoint traversal to upload input is too late for Java's ingestion guard. Extend the HTTP store's existing resource closure to follow references inside staged `managed-action-options`, using its existing reference collection, metadata equality and deduplication. This includes the input with the first Action commit without uploading unrelated staged resources. No new store API or CLI dependency in core is needed.

## WebShell presentation

Carry the API's optional `inputPreview` through the managed provider. Preserve matching transcript arguments as the first choice. If those arguments are absent, pass the exact preview text as a text content block with `contentIsInput`; leave `rawInput` absent. Truncated text can be invalid JSON and must not be parsed, trimmed or reformatted.

The shared approval card already renders that content literally in a React `<pre>`, including Shell payloads; it needs no change. The managed page replaces its unavailable warning with a localized full-byte-length notice and, when applicable, a truncation notice. Reuse the existing accessible description ID so the notice belongs to the current approval dialog. With neither source available, keep the existing unavailable warning. Do not copy previews into transcript rows or match calls by tool name.

## Affected files

| Layer                                      | Files                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Options and current-call binding           | `packages/cli/src/serve/hosted-tool-approval.ts`, `hosted-workspace-tool-turn.ts`                                                 |
| First-commit resource closure              | `packages/core/src/managed-runtime/http-managed-session-store.ts`                                                                 |
| Managed API mapping and permission content | `packages/web-shell/client/components/managed/managed-agent-provider.ts`, `java-managed-agent-provider.ts`, `managed-approval.ts` |
| Notice and translations                    | `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`, `packages/web-shell/client/i18n.tsx`                      |

Extend the existing focused tests for these paths. Java, generated API types, shared approval rendering, Harness authority and factory behavior are unchanged.

## Compatibility and limits

Deploy the Java reader before the new Harness writer: old Java rejects version 2 transactions. There is no new negotiation or deployment switch. A CLI inspector from before this commit cannot verify a snapshot written after it: the captured input is committed in the Action transaction and re-listed by the await-action checkpoint's closure, so it carries two referenced revisions, and an inspector without the options→input edge reaches it only through the checkpoint and fails the revision-set check. `managed-csi-checkpoint-evidence` then exits 1 with `Managed Session Store: snapshot resource reference revisions conflict.` for a Session that raised a native approval, although nothing is corrupt. Readers of this build are fine; a rollback or a mixed fleet during a rolling deploy is not, as for the journal change recorded in `2026-09-30-hosted-turn-failover-e2e.md`. Historical version 1 Actions remain usable, old previews remain optional, and public Shell remains disabled. The reader's 8192-byte UTF-8 limit and existing Session read/creator-answer permissions are unchanged. This does not add secret redaction, MCP previews, restart recovery or Shell takeover.

## Validation and acceptance

Complete production wiring before adding the small regression set and running one consolidated verification pass. Compare the baseline and local implementation in that final pass rather than starting a runtime during coding.

- Verify two calls to the same native tool have distinct request IDs, function-call IDs and input references. Each options reference must equal the current approval invocation reference and contain only that call's parameters.
- Verify an argument rewrite creates a new Action/ref, while MCP remains version 1.
- Verify the first Action HTTP commit contains options and its referenced input before any checkpoint, and excludes unrelated staged input.
- Verify provider preservation, transcript precedence, exact truncated text, unavailable fallback, complete/truncated size notices and mounted accessible descriptions.
- Run a controlled-provider native approval flow: the card shows each call's input; allowing executes the first call once, denying the second executes nothing. Preserve actual file effects, HTTP data, tmux captures and final browser screenshots. Label the controlled model and any fixture boundaries.
- A successful final pass closes the producer/card acceptance gap in #13160; #13271 still requires its independent admission, crash and enablement gates. Public Shell is not enabled by this change.
