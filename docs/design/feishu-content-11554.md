# Feishu rich content and references (#11554)

[English](feishu-content-11554.md) | [简体中文](feishu-content-11554.zh-CN.md)

## Problem and scope

Current Feishu post parsing drops images, link targets, code and video descriptors. Reply lookup duplicates this parser and omits file/image references. [Issue #11554](https://github.com/QwenLM/qwen-code/issues/11554) is the acceptance source. This bounded repair uses the existing Channel attachment contract, without adding routes or changing shared interfaces.

## Design

A package-local content parser returns readable text, whether text is user-authored, and an ordered deduplicated list of resource descriptors. Prefer nonempty content_v2 for rendering, with content fallback. Preserve Markdown, code blocks and links. Recognize the direct receive shape by field names before considering locale wrappers. Media-only posts receive a synthetic placeholder, so they are not discarded as empty, and the placeholder is never recorded into group history as something a member typed.

Direct messages and fetched references share parsing. Each downloadable resource retains its source message ID. After existing preflight authorization, download images to base64 attachments and files to temporary paths using the existing size limit and download helper. At most 8 resources are harvested per message (in document order, tail dropped with one summary line); each image is bounded at 8 MiB raw (the bridge's per-image upload admission, CHANNEL_IMAGE_MAX_UPLOAD_BYTES, compared against decoded bytes) and file downloads share a 100 MiB aggregate budget; the adapter carries no aggregate image budget because the enabled daemon path uploads each image separately with no aggregate cap, and the inline fallback's aggregate base64 bound is enforced by the bridge itself. Failed downloads keep explicit unavailability context, with failures past the first four collapsed into a single omission line and the wording distinguishing download failure, budget omission, and bot credential failure. Quoted content remains wrapped as untrusted context; files/images from the parent are delivered via existing attachments with a `[引用附件 message_id=…]` provenance line; a failed parent lookup prepends a `[Quoted message unavailable: …]` marker, while a successful lookup of an unrenderable type prepends a factual line naming the type. A media-only parent yields an adapter placeholder rather than user prose, so it is not wrapped as a quote, and a quoted parent authored by the bot gets a bot-specific banner. A reply carrying a locally handled command (`/approve`, `/clear`, `/btw`, …) is handled as a command turn: no quote wrapper, no parent resource download, and no media placeholder lines. Preserve original filenames in metadata while sanitizing and length-bounding filesystem paths. Keep card quote extraction unchanged and do not download card or merged-forward resources.

Private-chat quotes retain their parent message for context and resource lookup but do not create a Channel thread. Permission replies therefore share the private-chat scope. Group messages continue to use root_id for thread isolation.

## Boundaries and risks

No outbound upload, arbitrary reference recursion, cloud document fetch, new credential, or larger size limit. Structured media order is retained; duplicate resource keys in one message are downloaded once. Markdown URLs are not fetched. Shared collect buffering and temporary-file lifetime are deferred: the current collect drain clears image attachments, and the adapter still uses a fixed 60-second cleanup timer. The timer risk needs full queue-lifecycle verification and a shared ownership design. Merged-forward expansion and explicit unsupported-type handling also remain follow-up work in #11554; this PR does not close the issue. Rich content supports transport of video/audio as local files, not a promise that every model decodes them.

## Validation and acceptance

First add failing tests for documented post shapes, content_v2, code, links, multiple images and quoted files/images. Adapter-level tests must observe bridge input and resource request IDs with mocked platform HTTP. Check blocked messages do not download resources, partial failures remain visible, and existing mention and card behavior remains intact. Run build, typecheck, bundle, focused tests and two clean self-audit passes. A live Feishu E2E remains separate from mocked integration evidence; record platform access limitations explicitly.
