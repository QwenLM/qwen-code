# QQ Bot inbound media (images, videos, files, and voice)

[English](2026-09-27-qqbot-inbound-media.md) | [简体中文](2026-09-27-qqbot-inbound-media.zh-CN.md)

- Status: proposed
- Date: 2026-09-27
- Scope: `packages/channels/qqbot` (adapter only)

## Problem

The QQ Bot channel is the only channel that cannot receive media. A user who
sends a screenshot, a video, a document, or a voice message to the bot gets no
response at all: a media-only message is dropped before an envelope is built,
and a media message that carries a caption still loses its attachment, so the
agent answers as if the media had never been sent.

The repository documents this as a known gap
(`docs/users/features/channels/overview.md:452`): "QQ Bot does not process
incoming media — image and sticker messages are ignored, so it has no
media-handling row above."

## Current state

- `QQMessageEvent` (`packages/channels/qqbot/src/types.ts:24-41`) carries only
  `id`, `author`, and `content`. There is no `attachments` field, so the
  platform's attachment array is discarded by the type before any code sees it.
- C2C messages are dropped at `packages/channels/qqbot/src/QQChannel.ts:2580`
  (`if (!event.content?.trim()) return;`). Group messages are dropped at
  `packages/channels/qqbot/src/QQChannel.ts:2486` (`if (!cleanText) return
null;`). Neither site logs anything.
- The QQ platform does deliver the attachment metadata
  (`attachments[]` on `C2C_MESSAGE_CREATE` and `GROUP_AT_MESSAGE_CREATE`), so
  the information is available and simply unused.

The shared channel layer already supports inbound media, so no change is needed
outside the adapter:

- `Attachment { type: 'image' | 'file' | 'audio' | 'video'; data?; filePath?;
mimeType; fileName? }` (`packages/channels/base/src/types.ts:97-108`).
- `Envelope.attachments`, `imageBase64`, `imageMimeType`, and `syntheticText`
  (`packages/channels/base/src/types.ts:121-155`).
- `ChannelBase` resolves attachments into the bridge prompt
  (`packages/channels/base/src/ChannelBase.ts:6980-7020`): an image's base64
  `data` is added to the prompt's `images` array (vision input), and an
  attachment with `filePath` is appended to the prompt text as
  `User sent a <label> "<name>". It has been saved to: <path>`.

Four channels already implement this pattern (feishu, wecom, telegram, and
weixin). WeCom is the closest reference: images become base64 attachments, and
other media are written under `tmpdir()/channel-files/<uuid>` with mode `0600`.

## Goals

1. An image sent to the bot — in C2C or in a group — reaches the model as
   image input in the same prompt, with the message's caption kept as the
   prompt text when present.
2. A video sent to the bot is downloaded to a temporary path and the agent is
   told that path, so it can open the file with its own tools.
3. A file sent to the bot is downloaded to a temporary path and the agent is
   told that path, with the sender's own extension preserved so the read tool
   classifies the document instead of treating it as opaque binary.
4. A voice message sent to the bot is downloaded to a temporary path and the
   agent is told that path, preferring the platform's SILK-to-WAV conversion
   over the original SILK audio when the platform offers one.
5. A media-only message (no text) starts a turn instead of being dropped.
6. Text-only behaviour is unchanged, including slash commands and group
   mention handling.

## Non-goals

- Outbound media. Sending an image or video back requires a separate upload
  call to obtain `file_info` and a `msg_type: 7` send, and QQ only allows it as
  a passive reply to a recent message. That is a separate change.
- Passing video content to the model. The base contract has no video content
  part; a video is only a file path.
- Passing audio content to the model. A voice message is only a file path too;
  the platform's ASR text (`asr_refer_text`) is not used.
- Media in proactive or scheduled (cron) messages.

## Proposed solution

1. **Types** (`packages/channels/qqbot/src/types.ts`). Add
   `QQMessageAttachment { url; content_type?; voice_wav_url?; filename?; size?;
width?; height? }` and `attachments?: QQMessageAttachment[]` on
   `QQMessageEvent`. `QQGroupMessageEvent` extends `QQMessageEvent`, so it
   inherits the field. `voice_wav_url` is the SILK-converted WAV URL QQ sends
   on a `content_type: voice` attachment.

2. **New download helper** (`packages/channels/qqbot/src/media.ts`).
   - `classifyQQAttachment(contentType)` maps `image/jpeg`, `image/png`,
     `image/gif` to `image`, `video/mp4` to `video`, `file` to `file`, and
     `voice` to `voice`, and returns `undefined` for everything else.
   - `downloadQQAttachment(url, maxBytes)` fetches the attachment and returns
     `{ buffer, mimeType }`, enforcing a host allowlist, a 30-second timeout,
     and the byte cap on both the declared `Content-Length` and the streamed
     total (the pattern used by `packages/channels/feishu/src/media.ts:50-93`).
   - Limits: images at most 8 MiB, videos, files, and voice messages at most
     20 MiB, at most 5 attachments handled per message. Anything over a limit is
     skipped with one `stderr` line naming the reason. The image cap bounds the
     inline part added to the request — base64 inflates the bytes by about a
     third, and the bridge caps inline images at 8 MB — and the video, file, and
     voice caps match WeCom's 20 MB
     (`packages/channels/wecom/src/WeComAdapter.ts:81`) and QQ's own 20 MB voice
     soft limit, far below QQ's 200 MB hard limit.

3. **Adapter** (`packages/channels/qqbot/src/QQChannel.ts`).
   - A shared private `attachInboundMedia` downloads the supported attachments.
     An image is delivered twice: `{ type: 'image', data: <base64>, mimeType,
fileName }`, so an image-capable model sees the picture in the same prompt,
     and `{ type: 'file', filePath, mimeType, fileName }` for the same bytes
     written to `tmpdir()/channel-files/<uuid>/<name>`, so the prompt also
     carries the base layer's `saved to:` line and a model that cannot take
     images still has a path to work with. A video is written to the same place
     and delivered as `{ type: 'video', filePath, mimeType, fileName }`. A file
     is written to the same place and delivered once as `{ type: 'file',
filePath, mimeType, fileName }` — no inline entry, because QQ sends it as
     `content_type: file` with no MIME type and the base contract has no generic
     file content part. A voice message is downloaded from `voice_wav_url` when
     the platform sends one and from `url` otherwise, written to the same place,
     and delivered once as `{ type: 'audio', filePath, mimeType, fileName }` —
     again no inline entry, because the base contract has no audio content part.
     Its MIME type follows the URL that was fetched (`audio/wav` for the
     conversion, `audio/silk` for the original) rather than the download
     helper's result, which cannot classify a body declared as the literal
     `voice`. The channel layer has no capability gate, so it cannot pick
     between the two and serves both.
   - The two drop sites (`:2486`, `:2580`) are relaxed to "no text **and** no
     supported attachment". The decision needs only the presence of
     `event.attachments`, so no download is required to make it.
   - The envelope is built as it is today (with the placeholder text when the
     user sent no text) and handed to the base through
     `prepareThenHandleInbound(envelope, prepare)`
     (`packages/channels/base/src/ChannelBase.ts:6389`, the pattern Telegram
     uses), so routing and dedup happen before the download and the prepare
     callback sets `envelope.attachments` once the media is downloaded.
   - The on-disk name carries the extension implied by the sniffed MIME
     (`.jpg`, `.png`, `.gif`, `.mp4`), because the agent's read tool classifies
     media by extension; a sender-supplied name that is missing or misleading
     would otherwise deliver the file as opaque binary. A `file` is the one
     exception: QQ's `content_type` is `file`, not a MIME type, so there is
     nothing to map from and the sender's own extension is preserved instead —
     restricted to `[A-Za-z0-9]{1,10}`, falling back to `.bin` — because that
     extension is the only classifier the read tool has. A voice message is the
     other: it has no filename at all, so the stem falls back to the existing
     `qq_<kind>` default and the extension follows the URL that was fetched
     (`.wav` for the conversion, `.silk` for the original).
   - Nothing is reclaimed. A downloaded file stays under the OS temporary
     directory, which the system clears on its own schedule, and the adapter
     keeps no tracking state, no prompt hooks and no disconnect sweep for it.
   - When the user's text is empty, the prompt text becomes `(image)`,
     `(video)`, `(file)`, or `(voice)` and the envelope sets `syntheticText:
true`, so the placeholder is never recorded as quoted group history.
   - If media was present but nothing could be attached, the text becomes
     `(User sent media but download failed)` and the turn still runs, so the
     user is not silently ignored (the pattern at
     `packages/channels/wecom/src/WeComAdapter.ts:488-494`).

4. **Documentation.** Add a QQ row to the media matrix in
   `docs/users/features/channels/overview.md` and remove the "QQ Bot does not
   process incoming media" note; expand the "Images, Videos, and Files" section
   of `docs/users/features/channels/qqbot.md` to cover the file type, the 20 MB
   cap, the on-disk path, voice (the `content_type: voice` type, the preference
   for the converted WAV, its 20 MB cap, and its on-disk path), and the fact
   that no text is needed to start a turn.

## Design decisions and rationale

- **An image is delivered twice, inline and on disk.** Inline
  (`attachments[type=image].data`) is what an image-capable model actually sees:
  the base layer collects it into the bridge's `images` array
  (`packages/channels/base/src/ChannelBase.ts:6987-6995`), so the picture arrives
  with the prompt and needs no tool call. The same bytes are also written to disk
  and attached as a file so the prompt carries
  `User sent a file "<name>". It has been saved to: <path>`
  (`packages/channels/base/src/ChannelBase.ts:6996-7014`): for a model that
  cannot take images the inline part becomes an unsupported-image note, and the
  path is then the only handle the agent has — it can still be processed with
  other tools. The channel cannot pick between the two because it has no
  capability gate, so it serves both.
- **The adapter sends images unconditionally, but the client can still textify
  them.** The channel layer has no capability gate — `grep -rn
"modalities\|supportsImages\|imageSupport" packages/channels` matches no
  production file — and `ChannelBase` adds `images` to the bridge prompt
  unconditionally (`packages/channels/base/src/ChannelBase.ts:7390-7392`). So
  the adapter needs no vision detection. Downstream, the OpenAI-compatible wire
  replaces an image with a text placeholder when the selected model declares no
  image modality: `createMediaContentPart` returns
  `unsupportedModalityPlaceholder('image', ...)`
  (`packages/core/src/core/openaiContentGenerator/converter.ts:973-979`), and
  the modalities come from `defaultModalities(model)`
  (`packages/core/src/core/modalityDefaults.ts:119`), which is text-only for an
  unknown model id. The Gemini wire has no such gate for images — it textifies
  only `audio/` and `video/`
  (`packages/core/src/core/llm-content-generator/llm-content-generator.ts:428-440`).
  A vision bridge can also describe the image before the model call when the
  primary model is not image-capable and an image-capable model is available
  (`shouldRunVisionBridge`, applied to prompt parts at
  `packages/cli/src/acp-integration/session/Session.ts:16130`).
- **Videos become a file path, not base64.** QQ allows videos up to 200 MiB and
  the base contract has no video content part, so the path is the only thing the
  agent can act on.
- **Voice becomes a file path too, preferring the platform's WAV.** QQ sends
  `content_type: voice` with both `url` (SILK) and `voice_wav_url` (the same
  audio converted to WAV); the conversion is preferred because it needs no
  decoding to be read, and the original is the fallback. The attachment is
  delivered once, by path, as `{ type: 'audio', ... }`, because the base
  contract has no audio content part — the `voice_wav_url` field is read here
  and nowhere else. The platform's ASR text (`asr_refer_text`) is deliberately
  not used: surfacing a transcript instead of the audio is a separate product
  decision.
- **Downloaded media is not reclaimed.** An earlier revision deleted the
  directory when the turn ended and it broke the obvious follow-up: the agent
  asks whether it should read the picture, the user answers in the next turn,
  and the file is already gone. The files stay under the OS temporary directory
  instead, which the system clears on its own schedule. That also removes the
  need for any lifetime bookkeeping — no per-message directory map, no prompt
  hooks, no disconnect sweep — and with it a class of defects that the earlier
  design's cleanup rules kept producing.
- **A file keeps the sender's extension; images and videos keep the sniffed
  MIME's; voice follows the fetched URL's.** The read tool classifies by
  extension, so for an image or a video a sender-supplied extension must never
  win — the resolved MIME decides. A file is the opposite case: QQ reports
  `content_type: file` with no MIME type, so there is nothing to derive an
  extension from and the sender's own is the only classifier available. It is
  kept after a safe-alphabet filter (`[A-Za-z0-9]{1,10}`, else `.bin`), so a
  `.docx` does not arrive as opaque binary while a crafted name cannot inject
  path characters. A voice message is the third case: it has no filename and its
  body is not sniffable, so the extension follows the URL that was fetched —
  `.wav` for the converted WAV, `.silk` for the original — and the missing stem
  falls back to the existing `qq_voice` default.

## Platform constraints

- Inbound events carry `attachments: MessageAttachment[]` with
  `{ url, filename, width, height, size, content_type }`, where `content_type`
  is one of `voice`, `image/jpeg`, `image/png`, `image/gif`, `video/mp4`,
  `file`.
- A `content_type: voice` attachment also carries `voice_wav_url`, the
  SILK-converted WAV URL. QQ's voice soft limit is 20 MB (hard limit 200 MB).
- Attachment URLs are not documented as durable, so they are downloaded
  immediately rather than stored.
- The bot receives media only for the message types it already subscribes to
  (C2C, group `@`, and group all-messages).

## Model capability prerequisite

With the file-path route, the image reaches the model only when the agent's read
tool returns it as image data, which requires the session's model to be treated
as image-capable. That holds when either:

- the model name is recognised by `defaultModalities`
  (`packages/core/src/core/modalityDefaults.ts:24-110`) — Gemini, GPT, Claude,
  `qwen*-vl`, `qwen3.5-plus` and similar, or
- the capability is declared in settings, which takes precedence over the
  name-based fallback (`packages/core/src/models/modelConfigResolver.ts:417-431`):

  ```json
  {
    "model": {
      "name": "deepseek-v4.1-flash",
      "generationConfig": {
        "modalities": { "image": true }
      }
    }
  }
  ```

The declaration matters for a model that is genuinely multimodal but not
recognised by name: `^deepseek` matches the text-only fallback
(`packages/core/src/core/modalityDefaults.ts:73-74`), so `deepseek-v4.1-flash`
is treated as text-only even though it accepts images.

When the model is treated as text-only and no bridge applies, the read tool
answers with an unsupported-image note instead of the picture. The vision bridge
(`shouldRunVisionBridge`,
`packages/core/src/services/visionBridge/vision-bridge-service.ts:176`) is
deliberately not part of this design: it has a second model describe the image,
which is the conversion this change avoids. This is a deployment prerequisite,
not a code change in the adapter.

## Risks

- **URL host change.** If the platform serves attachments from a host outside
  the allowlist, media is skipped and logged rather than fetched. The allowlist
  is the SSRF guard, so it fails closed.
- **Prompt size.** The inline image is base64, so it inflates the bytes by about
  a third; the 8 MiB image cap bounds the added request size.
- **Caption shape.** For an image-only message QQ may send an empty `content` or
  the file name. Any non-empty content is treated as the caption, and an empty
  one is replaced by the placeholder.
- **Downloaded media accumulates.** Nothing removes a downloaded file, so a bot
  that receives a lot of video keeps those bytes until the OS clears its
  temporary directory. The trade is deliberate: the turn-end deletion this
  replaces lost the file for the follow-up turn, and every attempt to reclaim it
  safely needed bookkeeping that produced defects of its own.
- **A text-only model still cannot see the picture.** It receives the
  unsupported-image note plus the file path; anything further depends on the
  agent having another tool to process the file.
- **File type detection is the sender's word.** QQ's `content_type: file`
  carries no MIME type, so the on-disk extension comes from the sender's
  filename. A sender who mislabels a file gets that extension on disk; the
  agent still has the bytes and can inspect them.
- **Voice is an audio file, not a transcript.** The base contract has no audio
  content part, so the agent receives a path to a `.wav` (or `.silk`) file and
  can act on it only through its own tools; the platform's ASR text is ignored.
  A `.silk` file is also not playable by common tooling, which is why the
  converted WAV is preferred whenever QQ offers one.

## Validation plan

- Unit tests in `packages/channels/qqbot/src/events.test.ts` and a new
  `packages/channels/qqbot/src/media.test.ts`: image-only C2C; image-only group;
  caption plus image; an image produces both an inline attachment (base64 data,
  sniffed MIME, no path) and an on-disk file attachment; a video lands on disk
  and survives the end of the prompt; a file with a caption lands on disk once,
  as `{ type: 'file', filePath }` with no inline entry, and keeps its `.docx`
  extension; a file-only message starts a turn in C2C and in a group with the
  `(file)` placeholder; a file over the 20 MB cap is skipped with one `stderr`
  line; a voice message with `voice_wav_url` fetches that URL (not `url`), lands
  on disk as `qq_voice.wav` with `mimeType: audio/wav` and one `{ type: 'audio',
filePath }` attachment, and the file bytes and `0600` mode match; a voice
  message without `voice_wav_url` falls back to `url`, `.silk`, and
  `audio/silk`; a voice-only message starts a turn in C2C and in a group with
  the `(voice)` placeholder; a voice message over the 20 MB cap is skipped with
  one `stderr` line; a failed download produces the placeholder text;
  `syntheticText` is set; existing text-only tests stay green. The contract side
  is already pinned by `ChannelBase.test.ts:13934` (inline image attachments are
  forwarded in order) and `:13848` (file paths appended to the prompt), and the
  adapter side by `WeComAdapter.test.ts:1519` and `:1675`, so the QQ tests mirror
  those assertions rather than inventing a new shape.
- Static checks in the package: `tsc --build`, ESLint, and Prettier.
- Live check: build the CLI from source, point the local qqbot service at that
  build, send an image with a caption, a video, a document, and a voice message
  to the bot, and confirm the agent describes the image without reading a file,
  can open the video path, reads the document by its `.docx` path, and can open
  the `.wav` path of the voice message.

## Acceptance criteria

1. An image sent to the bot, with or without a caption, reaches an image-capable
   model as image input in the same prompt — no tool call needed to see it — and
   the same bytes are also left on disk with their path in the prompt.
2. A video sent to the bot produces a turn whose prompt names the downloaded
   path, and the file is still there afterwards.
3. A file sent to the bot produces a turn whose prompt names the downloaded
   path, the sender's extension is preserved on disk, and the turn runs even
   when the message carries no text.
4. A voice message sent to the bot produces a turn whose prompt names the
   downloaded path: the converted WAV is fetched when the platform offers one
   (`.wav`, `audio/wav`), the original SILK URL is the fallback (`.silk`,
   `audio/silk`), the attachment is delivered once as an audio entry, and the
   turn runs with the `(voice)` placeholder when the message carries no text.
5. With a text-only model, the inline part degrades to the documented
   unsupported-image note while the path stays usable, instead of the media being
   silently dropped.
6. A text-only message behaves exactly as it does today.
7. Downloaded media is never removed by the adapter.
8. The channel documentation no longer states that QQ ignores inbound media, no
   longer says QQ does not support files, and no longer implies QQ ignores voice
   messages.

## Open questions

- The exact lifetime of `attachments[].url` is undocumented; the design assumes
  it must be fetched immediately.
- Whether production QQ sends the file name in `content` for image-only
  messages, or leaves it empty.
- Whether the platform's ASR transcription (`asr_refer_text`) should be surfaced
  to the model in a later change.
