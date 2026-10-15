# Durable User Resource Links

[English](daemon-user-resource-links.md) | [简体中文](daemon-user-resource-links.zh-CN.md)

## Status

Implemented in the proposed fix for [#11178](https://github.com/QwenLM/qwen-code/issues/11178), pending maintainer review and release. Verification results belong in the PR.

## Problem

ACP user prompts can contain `resource_link` content with a URI and display metadata. Live clients may seed attachment cards locally, but that does not persist them. The ACP session records only user text and daemon-native attachment references; URI links disappear before transcript replay. The SDK also discards these links during normalization.

[PR #11194](https://github.com/QwenLM/qwen-code/pull/11194) addresses SDK projection but assumes local-file model input is the durable user record. Original references must be saved separately from model-input expansion.

## Persistence and Replay

Keep the original ACP `resource_link` blocks in the existing user record's optional `systemPayload.resourceLinks` collection. Capture them from the public prompt, including attachment-only prompts and prompts whose model input is replaced by trusted context. Snapshot the references before passing them to the recorder.

The existing replay machine emits those saved blocks as `user_message_chunk` content, with the record's source, segment, prompt, and branch identity. Preserve URI, name, MIME type, size, description, title, annotations, and `_meta`, including valid nullable ACP fields. Native `attachmentReferences` retain their existing hydration contract.

Do not infer original links from `fileData`, generated `@uri` text, or model-expanded file contents. Those forms are lossy and may describe normal remote media rather than an ACP attachment. Older records without saved references cannot recover their missing cards.

## SDK Contract

Add the typed event `user.resource_link.delta` carrying `resourceLink: DaemonResourceLink`. The reference preserves the ACP content discriminator `type: 'resource_link'`. ACP update metadata remains in the event's separate `meta` field.

User transcript blocks expose optional `resourceLinks: DaemonResourceLink[]`. Deduplicate by URI within the owning user block, filling missing metadata on repeated echoes. Preserve different URIs with the same name and the same URI in separate turns. Use the existing reducer ownership, copy-on-write, retention budget, reset, rewind, and branch reconstruction rules.

This is an additive public SDK contract requiring maintainer review. Exhaustive event consumers need a case for the new event; clients projecting transcript links must use the published content shape.

## Scope and Constraints

Store references only. This change performs no URI fetch, upload, preview, or download and creates no `attachmentId`. It does not change model capability, local-file trust checks, native attachment storage, or the frontend renderer. The separate mid-turn ACP content admission policy is unchanged.

## Validation and Acceptance

Cover original prompt recording, recorder output, replay, SDK normalization/reduction, and offline reconstruction. Include text with two same-name/different-URI links, attachment-only messages, repeated echo, the same URI across turns, metadata, trusted model-only input, and URI preservation for `transit://`, `https://`, and `file://`.

Verify that reset/rewind removes erased references and reconstruction selects the active branch. Confirm reference-only handling without network requests. Daemon acceptance should inspect saved JSONL and reconstruct history after reconnect or restart. Package tests and daemon acceptance remain separate from a deployed downstream browser refresh check.
