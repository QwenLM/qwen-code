# QQ Bot outbound media (image, video, and voice)

[English](2026-10-25-qqbot-outbound-media.md) | [简体中文](2026-10-25-qqbot-outbound-media.zh-CN.md)

- Status: proposed
- Date: 2026-10-25
- Scope: `packages/channels/qqbot` (adapter only)

## Problem

The QQ Bot channel can send exactly one kind of rich media: a file. The
`qq_send_file` tool uploads local bytes through the chunked rich-media path and
delivers them as `msg_type: 7` with a `file_info` handle, and that path hard-codes
`file_type: 4` — the downloadable file card
(`packages/channels/qqbot/src/api.ts:194`, `:263`, `:367`).

The platform supports three more rich-media types behind the same upload and
send contract: image (`file_type: 1`), video (`2`), and voice (`3`). The
adapter implements none of them. A bot asked to send back a generated chart, a
short clip, or a voice note can only deliver an opaque file card, so the user
gets a download link where the platform would have rendered the picture, the
playable video, or the voice bar.

The existing upload/send machinery already carries everything the three new
types need: presigned chunk upload, `md5_10m`, retryable platform codes, TTL
handling, the passive-reply anchor, `msg_seq` bookkeeping, the active-message
fallback, and the "never silently downgrade to text" failure rule. Only the
file type, the local validation, and the tool surface are missing.

## Current state

- `QQ_FILE_TYPE_FILE = 4` is a module constant applied in both the
  `upload_prepare` body (`api.ts:263`) and the merge body (`api.ts:367`); the
  comment at `api.ts:192` records why only type 4 was chosen ("the only type
  that accepts any format").
- `uploadQQRichMedia` (`api.ts:247`) owns the whole chunked flow and returns
  `{ fileInfo, ttl }`. It has no file-type input.
- `qq_send_file` (`file-tools.ts:61`) is the only outbound media tool. Its
  schema takes `path` and an optional `file_name`; `readOutboundFile`
  (`file-tools.ts:155`) enforces the boundary: absolute path, realpath inside
  the session workspace or `tmpdir()`, regular file, single hard link, no
  final-component symlink, non-empty, at most `QQ_OUTBOUND_FILE_MAX_BYTES`
  (20 MiB, `file-tools.ts:34`), and an unchanged size/mtime between the two
  `fstat` calls.
- `QQFileToolDeps` (`file-tools.ts:46`) injects `sendFile({sessionId, chatId,
fileName, bytes})`; the adapter supplies it from `registerFileTools`
  (`QQChannel.ts:5067`), which is a no-op unless the channel sets
  `fileTools: true`.
- `sendQQFile` (`QQChannel.ts:5098`) resolves the route, takes the session's
  reply anchor, uploads, sends `{msg_type: 7, media: {file_info}}`, rolls back
  the `msg_seq` on failure, refuses to retry `429`, re-uploads on `304080`, and
  falls back to one active send when the anchored send is rejected.
- The failure helpers hard-code the tool name: `describeUploadFailure`
  (`QQChannel.ts:350`) and `describeMediaSendFailure` (`QQChannel.ts:370`).
- Inbound size limits live in `media.ts:8-11` (`image` 8 MiB, `video` / `file`
  / `voice` 20 MiB). These are inbound attachment caps and must not be reused
  as outbound limits; `sniffImageMime` (`media.ts:113`) recognizes only PNG,
  GIF, and JPEG.

## Goals

1. `qq_send_image` sends a local PNG or JPEG as a QQ image message.
2. `qq_send_video` sends a local MP4 as a QQ video message.
3. `qq_send_voice` sends a local SILK, MP3, WAV, or OGG file as a QQ voice
   message.
4. `qq_send_file` keeps its current behaviour byte for byte: file card,
   optional `file_name`, 20 MiB cap, same failure text.
5. Each tool validates format and size locally before uploading, and reports a
   failure to the model instead of downgrading the message, matching the
   existing "a file that cannot be sent is reported" rule
   (`QQChannel.ts:5098` doc comment).
6. All four tools are gated by the existing `fileTools: true` switch; no new
   configuration key.

## Non-goals

- URL upload (`POST /v2/{scope}/{id}/files` with a `url` instead of a chunked
  session). The adapter only ever holds local bytes, and the URL path requires
  a public origin.
- `srv_send_msg: true` upload-and-send in one call. The adapter needs the
  reply anchor and `msg_seq` bookkeeping between upload and send.
- Transcoding. A non-SILK voice file is uploaded as-is; there is no SILK
  encoder and no WAV-to-SILK step.
- Uploading over the platform's hard limit (200 MB) or raising the in-memory
  read cap beyond the per-type soft limits.
- Inbound media, which is covered by
  `2026-09-27-qqbot-inbound-media.md`.
- Media in proactive or scheduled (cron) messages. The three new tools use the
  same reply-anchor + active-fallback path `qq_send_file` already uses; opening
  a new active-message path is separate work.
- Automatic type detection inside `qq_send_file` (see the decisions section).

## Proposed solution

### 1. Upload layer — `packages/channels/qqbot/src/api.ts`

- Replace the single constant with a total map:

  ```ts
  export const QQ_FILE_TYPE = {
    image: 1,
    video: 2,
    voice: 3,
    file: 4,
  } as const;
  export type QQFileType = (typeof QQ_FILE_TYPE)[keyof typeof QQ_FILE_TYPE];
  ```

- `QQRichMediaUploadInput` gains a required `fileType: QQFileType`. Both the
  `upload_prepare` body and the merge body use it. The parameter is required
  rather than defaulted so no caller can silently keep uploading every kind as
  a file card; the only production caller is the adapter's `sendQQMedia`.
- Nothing else in the flow changes: `block_size`, cumulative offsets,
  `md5_10m` over the first 10002432 bytes, the three retry attempts, the
  `retry_delay` from `upload_config`, and the returned `{fileInfo, ttl}` stay as
  they are.

### 2. Validation layer — `packages/channels/qqbot/src/file-tools.ts`

`readOutboundFile(path, workspaceDir)` becomes
`readOutboundFile(path, workspaceDir, kind)` where
`kind: 'file' | 'image' | 'video' | 'voice'`. The existing boundary checks run
unchanged first (absolute, realpath inside a root, regular file, single hard
link, no final-component symlink, non-empty, unchanged between the two
`fstat` calls). Then:

- The byte cap is chosen per kind: `image` 20 MB, `video` 30 MB, `voice`
  20 MB, `file` 20 MiB (unchanged). The three new caps are the platform's
  decimal soft limits, not binary mebibytes: an upload one byte over the soft
  limit is downgraded to a file card, so a 20 MiB (20.97 MB) cap would let
  through a size the platform then renders as a card. The existing file cap
  stays at 20 MiB because it predates this change and is far below the 200 MB
  file soft limit.
- The format is decided by magic bytes read from the same open descriptor, not
  by the file name:

  | kind    | accepted            | sniff                                                                               |
  | ------- | ------------------- | ----------------------------------------------------------------------------------- |
  | `image` | PNG, JPEG           | `89 50 4E 47`, `FF D8 FF`                                                           |
  | `video` | MP4                 | `ftyp` box at offset 4                                                              |
  | `voice` | SILK, MP3, WAV, OGG | `#!SILK_V3` / `\x02#!SILK_V3`, `ID3` or `FF Ex/Fx` frame sync, `RIFF….WAVE`, `OggS` |
  | `file`  | anything            | none                                                                                |

- A rejected kind produces a model-visible message that names the accepted
  formats and points at `qq_send_file` as the fallback, e.g.
  `qq_send_image: only PNG and JPEG are sent as images; use qq_send_file to send this file as a file card.`
  Nothing is downgraded automatically.

Public per-kind caps are exported (`QQ_OUTBOUND_IMAGE_MAX_BYTES`,
`QQ_OUTBOUND_VIDEO_MAX_BYTES`, `QQ_OUTBOUND_VOICE_MAX_BYTES`) so tests and the
tool descriptions share one source of truth. `QQ_OUTBOUND_FILE_MAX_BYTES`
keeps its current name and value.

### 3. Tool layer — `packages/channels/qqbot/src/file-tools.ts`

- `QQFileToolDeps.sendFile` becomes
  `sendMedia({ sessionId, chatId, kind, fileName, bytes })`, where `kind` is
  the same four-value union.
- `buildFileTools` returns four definitions. The three new ones have a `path`
  property only; `file_name` stays exclusive to `qq_send_file` because an image,
  video, or voice message does not display a name. The upload's `file_name`
  field is the resolved basename.
- Each description states the accepted formats, the size cap, and that the
  file must be inside the session workspace or the system temporary directory,
  mirroring the current `qq_send_file` description
  (`file-tools.ts:61-82`).
- Handlers share one body: resolve chat, read + validate with the kind, derive
  the display name, call `sendMedia`, log on failure, return `Image sent
(<name>).` / `Video sent (<name>).` / `Voice sent (<name>).` on success.

### 4. Adapter — `packages/channels/qqbot/src/QQChannel.ts`

- `sendQQFile` becomes `sendQQMedia(input & {kind})`. The route resolution,
  reply anchor, `takeMsgSeq` / `beginMsgSeqSend` / `rollbackMsgSeq`, the `429`
  refusal, the `304080` re-upload rule, the active retry, and the `finally`
  bookkeeping are untouched. Three things become kind-dependent:
  1. `fileType: QQ_FILE_TYPE[kind]` passed to `uploadQQRichMedia`;
  2. the tool name used in every log line and failure message (a `toolName`
     parameter threaded into `describeUploadFailure` and
     `describeMediaSendFailure`);
  3. the upload size/format checks, which now happen in the tool layer before
     the call, so the adapter's own limits do not change.
- `registerFileTools` passes `sendMedia: (input) => this.sendQQMedia(input)`
  and keeps the `fileTools !== true` guard.

The chosen failure texts for the new kinds are the existing ones with the tool
name swapped (`qq_send_image: the platform rejected the file as too large
(850031).`, `qq_send_voice: the platform does not support this file format
(850019).`, …), so a model that already learned from `qq_send_file` failures
sees the same shape.

### 5. Documentation

- Add an outbound media row to `docs/users/features/channels/qqbot.md`:
  the four tools, their formats and caps, and that they need `fileTools: true`.
- Note the `file_type` mapping in `docs/users/features/channels/overview.md`
  only if the existing outbound row is incomplete; no scope change otherwise.

## Design decisions and rationale

- **Three tools instead of one `kind` parameter.** The chosen surface matches
  the caller: "send this as a picture" and "send this as a file" are different
  intents, and the model should not have to pick a type out of an enum whose
  validity depends on the file's magic bytes. Separate descriptions also let
  each tool state its own format list; one shared description covering four
  types would bury the constraints. The upload and send code is shared, so this
  is a wider schema without a wider implementation.
- **`file_type` is a required upload parameter.** A defaulted value would make
  it possible to add a fifth caller that forgets it and silently uploads an
  image as a file card. The single production call site makes the change small.
- **Image formats are PNG and JPEG, not the wider list in the overview page.**
  The platform's own pages disagree: the "supported message types" section says
  images may be `jpg/png/gif/webp/bmp` and voice may be `silk/mp3/wav/ogg`,
  while the "file type and limits" table lists only `png/jpg` for image and only
  `silk` for voice. The table is the API parameter contract and is what the
  upload endpoint validates against, so it wins for images. Voice follows the
  wider list instead (see next decision). A GIF or WEBP is therefore rejected by
  `qq_send_image` with a message that points at `qq_send_file`; the file still
  reaches the user, as a file card.
- **Voice accepts the wider list.** A voice message that only accepts SILK
  would be useless in practice — local audio is almost always WAV or MP3 and
  the adapter has no encoder. The overview page documents SILK/MP3/WAV/OGG for
  voice messages, and a format the platform rejects comes back as its normal
  error (850019 for an unsupported format), which the model sees and can retry
  with `qq_send_file`. This is the one place where the two platform documents
  are resolved toward the broader list, on the ground that a rejected format
  degrades to a clear error while a rejected-valid format would silently remove
  a documented capability.
- **The soft limits are enforced locally, not left to the platform.** The
  platform silently downgrades an over-limit image, video, or voice upload to a
  file card. Doing that inside a call the model made as `qq_send_image` would
  report success for a different visible outcome. Rejecting locally keeps the
  tool's contract honest and tells the model exactly what to do next.
- **Format is decided by magic bytes, not the extension.** The outbound path
  has no reason to trust a model-supplied name, and the adapter already
  sniffs image MIME inbound (`media.ts:113`); the outbound direction should not
  be weaker. The read is taken from the descriptor that was already opened and
  `fstat`-checked, so the bytes that were sniffed are the bytes that are
  uploaded.
- **No new configuration switch.** `fileTools: true` already means "let the
  model hand a local file to the platform under the bot's own identity"
  (`QQChannel.ts:5063-5067`). Sending an image is the same outbound action and
  the same exposure; a second switch would only let the two surfaces drift.

## Platform constraints

- Rich media is uploaded first and sent second: `upload_prepare` →
  presigned `PUT` per part → `upload_part_finish` per part → merge `POST
/v2/{users|groups}/{openid}/files` with `srv_send_msg: false` → `file_info`,
  then `POST .../messages` with `{msg_type: 7, media: {file_info}}`.
- `file_type`: `1` image (`png`/`jpg`, 20 MB soft, 200 MB hard), `2` video
  (`mp4`, 30 MB soft, 200 MB hard), `3` voice (`silk`, 20 MB soft, 200 MB
  hard), `4` file (any format, 200 MB soft, 200 MB hard). Above the soft limit
  the platform downgrades to a file card; above the hard limit it errors.
- Upload endpoints are isolated per scene: `/v2/users/{user_openid}/…` for C2C
  and `/v2/groups/{group_openid}/…` for groups, including the prepare and
  part-finish endpoints. The existing `QQRichMediaScope` selection already
  handles this.
- `file_info` has a TTL (`ttl`, `0` meaning no expiry); `304080` means the
  handle expired before the send, and the existing path re-uploads on the next
  attempt.
- The platform only accepts a rich-media send as a passive reply to a recent
  message, which is why the existing code always tries the reply anchor first
  and falls back to one active send.
- Official reference: <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>.

## Testing

Unit tests, in the existing files:

- `api.test.ts`: `uploadQQRichMedia` sends the requested `file_type` in both
  the `upload_prepare` and merge bodies (one case per type), and the existing
  flow assertions (parts, `md5_10m`, retries, `ttl`) still hold with the new
  required parameter.
- `file-tools.test.ts`: the four tool definitions and their schemas
  (`qq_send_file` keeps `file_name`; the new three take `path` only); magic-byte
  acceptance and rejection per kind; each media byte cap tested over the limit
  (the file cap keeps its existing at-cap and over-cap tests); the rejection
  message names the accepted formats and
  `qq_send_file`; the existing path-boundary and TOCTOU tests still pass with
  the new `kind` argument; each handler forwards the right `kind` to
  `sendMedia` and renders the right success line.
- `QQChannel.test.ts`: the four tools are registered only with
  `fileTools: true`; `sendQQMedia` maps each `kind` to the right `file_type`;
  upload/send failures are prefixed with the right tool name; the
  anchored-send fallback and `msg_seq` rollback still behave as they do for
  `qq_send_file`.

No new platform calls are made by tests; the upload and message endpoints are
stubbed as they are today. Live verification of the three types stays manual,
and the design records that gap rather than implying the format lists were
verified against the live API.

## Acceptance

1. With `fileTools: true`, an agent asked for a PNG chart calls
   `qq_send_image`, the user receives a rendered image message, and no file card
   appears.
2. An MP4 goes out as a playable video message; a SILK/MP3/WAV/OGG goes out as
   a voice bar.
3. A 21 MB PNG is rejected before upload with the accepted formats and the
   `qq_send_file` fallback named; a 25 MB MP4 is accepted (under the 30 MB
   video cap).
4. A GIF or WEBP passed to `qq_send_image` is rejected with the same fallback
   guidance, and `qq_send_file` sends it as a file card.
5. `qq_send_file` output, limits, and failure text are unchanged.
6. A group send and a C2C send both pick the right upload scene; an expired
   handle still re-uploads on the retried call; a rejected anchored send still
   falls back to one active send.
