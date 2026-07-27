# DingTalk Interactive Cards: Latest Main Alignment

## Status

Approved for implementation on 2026-07-28. This document narrows the existing
interactive-card design to the work required to rebase PR #6930 onto
`origin/main` at `17408f102`.

## Goal

Preserve the shared Channel interaction contract and the DingTalk status and
question card behavior while incorporating the latest main changes, including
DingTalk outbound image delivery.

## Scope

The implementation will:

- rebase the existing Draft PR branch onto `origin/main`;
- retain the shared `runId`, `segmentId`, `requestId`, owner, target,
  settlement, and exact-run cancellation contracts;
- retain both the latest main DingTalk image instructions and the PR's
  `interactiveCards` configuration;
- prevent local image paths from appearing in streamed status-card content;
- replace complete outbound image markers before the status card's final
  projection;
- preserve the existing non-card image delivery behavior;
- rerun shared Channel, DingTalk, daemon Channel, and real-device verification.

The implementation will not:

- change the AskUserQuestion event or tool schema;
- add workspace identifiers to card callback payloads;
- move DingTalk image handling into ChannelBase;
- add restart recovery for in-memory card registries;
- fix the pre-existing duplicate daemon cancellation request in this PR;
- mark the PR ready for review.

## Current Merge Assessment

The PR head is `444cd6549`, its merge base with latest main is `cb9810214`,
and latest main is `17408f102`. A three-way merge reports content conflicts
only in:

- `packages/channels/dingtalk/src/DingtalkAdapter.ts`;
- `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`.

The shared Channel files auto-merge. Main's relevant shared change adds
thread-targeted delivery for polling channels; it does not change
`ChannelAgentBridge` or `DaemonChannelBridge`.

## Architecture Decision

### Keep shared interaction semantics unchanged

ChannelBase remains the owner of prompt runs, output segments, input requests,
owners, targets, settlements, and cancellation. DingTalk remains a projection
consumer. Other IM adapters continue to use the default unsupported presenter
hook and require no direct changes.

### Combine both constructor behaviors

The rebased DingTalk constructor will:

1. append the latest main outbound-image instructions without replacing custom
   instructions;
2. parse the PR's `interactiveCards` configuration;
3. initialize status and question controllers exactly as before.

Neither behavior replaces the other.

### Process outbound images inside the DingTalk projection

Status-card streaming and normal DingTalk replies currently use different
delivery paths. Normal replies pass through `prepareOutgoingText`, which
validates and uploads `[IMAGE: /absolute/path]` markers. Status-card chunks do
not.

The DingTalk card path will use two representations:

- raw accumulated response content, retained for final image processing;
- safe streaming content, used for intermediate card snapshots.

Intermediate snapshots will replace complete image markers with a neutral
placeholder and suppress a trailing partial marker. This prevents an absolute
local path from being projected while a marker is split across chunks.

At response completion, the adapter will run the full response through the
existing `prepareOutgoingText` method before giving it to the status-card
finalizer. The final card therefore receives the same validated
`![image](mediaId)` replacement or failure placeholder as a normal DingTalk
reply.

Image parsing, validation, token refresh, upload, and error redaction remain in
the existing DingTalk outbound-image implementation. ChannelBase and the
generic presenter contract stay unaware of image markers.

## Alternatives Considered

### Bypass status cards for image responses

Rejected because the adapter cannot know at run start whether a later chunk
will contain an image marker. Switching after partial streaming would either
duplicate preceding text or leave an inconsistent terminal card.

### Move image transformation into ChannelBase

Rejected because `[IMAGE: ...]`, DingTalk media IDs, and Card markdown are
transport-specific. Adding them to ChannelBase would make other IM adapters
depend on DingTalk delivery semantics.

### Transform only the final card content

Rejected because an intermediate stream update could expose the absolute local
path before finalization. Streaming snapshots need a small, deterministic
sanitization step as well.

## Interaction Behavior

Text-only behavior remains unchanged:

```text
text chunks -> status card Running -> same card Completed
```

An output containing an image marker behaves as:

```text
raw chunks
  -> safe streaming snapshots with an image placeholder
  -> validate and upload the complete marker at terminal time
  -> same status card Completed with ![image](mediaId)
```

AskUserQuestion behavior remains:

```text
close preceding output segment
  -> present question card
  -> submit/cancel/expire the same card
  -> create a new output segment if the Agent continues
```

## Failure Behavior

- Invalid image paths use the existing redacted failure placeholder.
- A media authentication failure retains the existing one-time token refresh
  and retry.
- Card creation or finalization failures retain the existing text fallback.
- Question-card creation failures retain the existing cancellation and visible
  fallback.
- Duplicate or stale callbacks remain ACKed and have no second state effect.

## Test Requirements

The implementation must add failing tests before production changes for:

- combining custom instructions, image instructions, and interactive-card
  configuration;
- sanitizing complete and chunk-split image markers in streaming snapshots;
- finalizing a status card with the uploaded media-ID markdown rather than the
  raw local path;
- preserving ordinary webhook image delivery;
- preserving direct and sequential AskUserQuestion card behavior.

After focused tests pass, verification must include:

- full `packages/channels/dingtalk` tests;
- full `ChannelBase.test.ts` and `SessionRouter.test.ts`;
- workspace typecheck, focused ESLint, build, bundle, and `git diff --check`;
- daemon-managed DingTalk worker startup and restart on latest main;
- real DingTalk text streaming, AskUserQuestion, Stop, and image projection.

## Acceptance Criteria

- The branch is based on latest main with no merge conflicts.
- No streamed or final status-card payload contains a raw absolute image path.
- Valid images retain main's media upload and token-refresh behavior.
- Text-only status cards and question cards retain their current lifecycle.
- Shared Channel and other IM adapters require no new implementation.
- The PR remains Draft after the updated branch is pushed.
