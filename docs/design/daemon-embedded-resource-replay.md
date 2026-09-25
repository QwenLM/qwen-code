# Durable ACP Embedded Text Resources

[English](daemon-embedded-resource-replay.md) | [简体中文](daemon-embedded-resource-replay.zh-CN.md)

## Status

Proposed fix for [#12538](https://github.com/QwenLM/qwen-code/issues/12538). Build, test, and runtime evidence belong in the PR.

## Problem

ACP `session/prompt` accepts an embedded `resource` block and supplies its inline content to the model. The durable user record retains prompt text and `resource_link` references but not the original typed `resource`, so transcript replay and SDK offline projection lose the resource after refresh or restart. This is distinct from daemon-native `attachmentReferences` and the `resource_link` fix in #12088.

## Persistence and Replay

Snapshot original embedded text-resource blocks from the submitted ACP prompt and store them in the owning user record's optional `systemPayload.embeddedResources`. The capture occurs before model-input expansion, so trusted model-only instructions cannot replace the user's original resource. Resource-only prompts still create a payload. The daemon marks which output positions came from expanding native attachment references; exclude only those positions before applying the inline size budget. A direct resource with the same URI remains independently replayable. For older daemon metadata without positions, only unambiguous native URIs are excluded as a best-effort compatibility fallback; ambiguous same-URI blocks are retained rather than silently dropped and remain subject to the inline size budget. Keep the native reference as its own preview source without adding a duplicate embedded-resource card.

The replay machine validates and emits each saved text-resource block as `user_message_chunk`, preserving URI, MIME type, text, ACP metadata, prompt ID, source record ID, and branch identity. It does not dereference the URI or fabricate an `attachmentId`. Records created before this change cannot regain missing blocks. Rewind and active-branch selection continue to use the existing transcript record graph.

## SDK Contract and Retention

The daemon UI SDK exposes `user.resource.delta` with a typed `DaemonEmbeddedResource` and stores resources in `DaemonTextTranscriptBlock.embeddedResources`. Normalization keeps the raw ACP block distinct from `resource_link` and native file events; the reducer attaches it to its owning user turn and counts it against transcript retention. An identical block echo in the same turn is deduplicated, but the same URI in another turn remains separate.

Only text resources are retained. The serialized direct embedded text-resource blocks in one ACP prompt may total at most 256 KiB; a larger direct text prompt is rejected by the daemon before the live peer echo and is also checked by the child before turn recording. Native text attachments identified by current position metadata are not subject to this inline replay limit; ambiguous legacy blocks remain subject to it. Blob resources retain their existing model-input behavior but are not persisted by this contract; large inline blob retention requires a separate storage policy. Client-provided URI and metadata are preserved, not fetched. Existing journal and transcript access controls still govern this newly retained user-supplied content.

## Validation and Acceptance

Cover text plus resource, resource-only prompts, multiple resources, a subsequent prompt without a resource, native-attachment coexistence (including a native attachment over 256 KiB and a direct resource with the same URI), pre-echo oversized direct text rejection, malformed persisted resources, prompt/source identity, active-branch reconstruction, rewind, SDK normalization/reduction, and replay after a daemon restart. The package tests establish code behavior; a running ACP session plus saved-record and `session/load` readback establishes runtime behavior. A downstream product page refresh is a separate deployment acceptance step.
