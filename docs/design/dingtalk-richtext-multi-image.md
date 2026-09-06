# DingTalk rich-text multi-image delivery

Issue: [#9878](https://github.com/QwenLM/qwen-code/issues/9878)

## Problem

A DingTalk message can contain several `picture` parts in one
`content.richText` array. The DingTalk adapter extracts every part into
`downloadCodes[]`, but the processing path calls `attachMedia` only for
`downloadCodes[0]`. Consequently the model and daemon-backed Web Shell receive
only the first image.

This design covers multiple images in one DingTalk callback. It does not change
how separate messages received during an active turn are steered or collected.

## Design

Extend `ChannelAgentBridgePromptOptions` with an ordered `images` collection
whose entries contain base64 data and MIME type. Keep the existing
`imageBase64` and `imageMimeType` fields as compatibility inputs for adapters
and bridge callers that still send one image.

`ChannelBase` will normalize the legacy image fields and every data-backed
image attachment into one ordered collection. It will pass that collection to
the bridge once per inbound turn. File-backed non-image attachments retain the
existing prompt-path behavior.

The DingTalk adapter will call `attachMedia` for every download code extracted
from a rich-text callback. Image media from the same callback will remain
data-backed so that `ChannelBase` can pass every image as a native vision
input, rather than degrading later images into file-path instructions.

`AcpBridge` will emit one ACP image content block per normalized image before
the text block. `DaemonChannelBridge` will upload each image to the owning
session and place every returned attachment reference before the text block.
This lets the daemon persist all references and lets Web Shell render every
image in the transcript.

## Compatibility

- Existing adapters using `imageBase64` and `imageMimeType` continue to work.
- Existing one-image callers keep their current ordering and behavior.
- An invalid partial legacy pair is ignored as it is today.
- No new configuration or dependency is introduced.

## Failure behavior

DingTalk media downloads remain sequential and preserve callback order. A
failed download keeps the existing per-media warning behavior and does not
prevent successfully downloaded images from reaching the turn. Daemon upload
failure keeps the current prompt failure semantics; the turn is not submitted
with a silently incomplete image set.

## Tests

1. DingTalk adapter: one `richText` callback with multiple picture parts
   downloads every code and produces ordered image attachments.
2. ChannelBase: legacy and structured image inputs normalize into an ordered
   bridge image collection without dropping later attachments.
3. ACP bridge: every image becomes an ACP image content block before text.
4. Daemon bridge: every image is uploaded, referenced in the prompt, and
   therefore available to session persistence and Web Shell replay.
5. Existing single-image tests remain green to prove compatibility.

## Acceptance criteria

Sending five images together in one DingTalk message produces five attachment
references in the daemon session turn, displays five images in Web Shell, and
provides all five images to the selected multimodal model in the original
order.
