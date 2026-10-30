# Pending prompt drafts

[中文](pending-prompt-drafts.zh-CN.md)

A queue summary is not sufficient to reconstruct a prompt after refresh: display text and media omit business context. The live-session-owner scoped pending-prompts route accepts `includeDraft=true` and returns an optional `queueDraft` containing the admitted prompt blocks and business `_meta.context`, plus `restoreComplete=true`. The default response stays unchanged. Admission captures a separate copy; every response returns another copy.

Only context metadata is supported. Unknown metadata, trusted model-prompt overrides, channel display overrides and promoted mid-turn prompts do not produce a complete draft. Identity, routing and internal metadata are never echoed as a draft. Context retains its existing caller-owned semantics and authorization boundary; it is not a new authentication channel. Hosts must validate supported context schemas and content before restoring. A complete draft does not grant permission to convert resource blocks or contextual prompts into mid-turn text.

Validation covers immutable capture/readback, explicit route opt-in, foreign-client rejection and unsupported metadata. Acceptance must queue text and contextual prompts, refresh, restore supported drafts and retain refusal for unsupported ones. Older daemons and pre-existing entries without a draft remain non-restorable. No durable queue or daemon-restart recovery is added.

## Rewind identity

File snapshots may cover only the resumed suffix of a conversation. Their array positions are not persisted user-turn ordinals. Native rewind resolves a unique persisted user record and its API-history prompt marker, returns its global ordinal and `sourceRecordId`, and keeps the file snapshot index separate. `expectedRecordId` is checked again inside the history mutation lock. Missing, duplicated or compacted mappings are refused before mutation. Tests cover snapshots 25–35 against 35 persisted turns and mismatched identity. Hosts must refuse snapshots without the persistent identity; safe refusal on older runtimes is intentional.
