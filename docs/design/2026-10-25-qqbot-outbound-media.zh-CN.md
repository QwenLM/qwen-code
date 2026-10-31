# QQ 机器人出站媒体（图片、视频、语音）

[English](2026-10-25-qqbot-outbound-media.md) | [简体中文](2026-10-25-qqbot-outbound-media.zh-CN.md)

- 状态：提案
- 日期：2026-10-25
- 范围：`packages/channels/qqbot`（仅适配器）

## 问题

QQ Bot 通道目前只能发送一种富媒体：文件。`qq_send_file` 工具通过分片富媒体路径上传本地字节，并以 `msg_type: 7` 携带 `file_info` 投递，这条路径把 `file_type` 写死为 `4`——可下载的文件卡（`packages/channels/qqbot/src/api.ts:194`、`:263`、`:367`）。

平台在同一套上传与发送契约下还支持另外三种富媒体类型：图片（`file_type: 1`）、视频（`2`）、语音（`3`）。适配器一种都没实现。被要求发回生成的图表、短视频或语音条的机器人，只能投递一张不透明的文件卡，用户拿到的是下载链接，而平台本可以渲染成图片、可播放视频或语音条。

现有的上传/发送机制已经承载了三种新类型所需的一切：预签名分片上传、`md5_10m`、可重试的平台错误码、TTL 处理、被动回复锚点、`msg_seq` 记账、主动消息回退，以及“绝不静默降级为文本”的失败规则。缺的只有文件类型、本地校验和工具接口。

## 现状

- `QQ_FILE_TYPE_FILE = 4` 是模块常量，同时用于 `upload_prepare` 请求体（`api.ts:263`）与合并请求体（`api.ts:367`）；`api.ts:192` 的注释记录了当初只选类型 4 的原因（“唯一接受任意格式的类型”）。
- `uploadQQRichMedia`（`api.ts:247`）拥有整套分片流程并返回 `{ fileInfo, ttl }`。它没有文件类型入参。
- `qq_send_file`（`file-tools.ts:61`）是唯一的出站媒体工具。schema 接受 `path` 与可选的 `file_name`；`readOutboundFile`（`file-tools.ts:155`）执行边界校验：绝对路径、realpath 位于会话工作区或 `tmpdir()` 内、普通文件、单一硬链接、最终组件非符号链接、非空、不超过 `QQ_OUTBOUND_FILE_MAX_BYTES`（20 MiB，`file-tools.ts:34`），且两次 `fstat` 之间 size/mtime 不变。
- `QQFileToolDeps`（`file-tools.ts:46`）注入 `sendFile({sessionId, chatId, fileName, bytes})`；适配器在 `registerFileTools`（`QQChannel.ts:5067`）中提供该实现，而该函数在通道未设置 `fileTools: true` 时是空操作。
- `sendQQFile`（`QQChannel.ts:5098`）解析路由、取会话回复锚点、上传、发送 `{msg_type: 7, media: {file_info}}`、失败时回滚 `msg_seq`、拒绝重试 `429`、在 `304080` 时重新上传，并在锚定发送被拒时回退为一次主动发送。
- 失败辅助函数把工具名写死：`describeUploadFailure`（`QQChannel.ts:350`）与 `describeMediaSendFailure`（`QQChannel.ts:370`）。
- 入站大小限制位于 `media.ts:8-11`（`image` 8 MiB，`video` / `file` / `voice` 20 MiB）。这些是入站附件上限，不可复用作出站上限；`sniffImageMime`（`media.ts:113`）只识别 PNG、GIF、JPEG。

## 目标

1. `qq_send_image` 把本地 PNG 或 JPEG 作为 QQ 图片消息发送。
2. `qq_send_video` 把本地 MP4 作为 QQ 视频消息发送。
3. `qq_send_voice` 把本地 SILK、MP3、WAV 或 OGG 文件作为 QQ 语音消息发送。
4. `qq_send_file` 保持当前行为逐字节不变：文件卡、可选 `file_name`、20 MiB 上限、相同的失败文案。
5. 每个工具在上传前做本地格式与大小校验，失败时向模型报告而不是降级消息，与现有“无法发送的文件必须报告”的规则一致（`QQChannel.ts:5098` 的文档注释）。
6. 四个工具共用现有 `fileTools: true` 开关；不新增配置键。

## 非目标

- URL 上传（使用 `url` 而非分片会话的 `POST /v2/{scope}/{id}/files`）。适配器只持有本地字节，URL 路径需要公网可访问的源。
- `srv_send_msg: true` 一次调用上传并发送。适配器需要在上传与发送之间完成回复锚点与 `msg_seq` 记账。
- 转码。非 SILK 语音文件按原样上传；没有 SILK 编码器，也没有 WAV 转 SILK 的步骤。
- 上传超过平台硬限制（200 MB）的文件，或把内存读取上限提高到各类型软限制之上。
- 入站媒体，由 `2026-09-27-qqbot-inbound-media.md` 覆盖。
- 主动或定时（cron）消息中的媒体。三个新工具沿用 `qq_send_file` 已在使用的回复锚点 + 主动回退路径；开辟新的主动消息路径属于独立工作。
- 在 `qq_send_file` 内部做自动类型探测（见决策部分）。

## 方案

### 1. 上传层 —— `packages/channels/qqbot/src/api.ts`

- 用完整映射替换单常量：

  ```ts
  export const QQ_FILE_TYPE = {
    image: 1,
    video: 2,
    voice: 3,
    file: 4,
  } as const;
  export type QQFileType = (typeof QQ_FILE_TYPE)[keyof typeof QQ_FILE_TYPE];
  ```

- `QQRichMediaUploadInput` 增加必填的 `fileType: QQFileType`。`upload_prepare` 请求体与合并请求体都使用它。该参数设为必填而非默认值，是为了避免任何调用方悄悄把所有类型都当文件卡上传；生产环境唯一的调用方是适配器的 `sendQQMedia`。
- 流程其余部分不变：`block_size`、累积偏移、前 10002432 字节的 `md5_10m`、三次重试、来自 `upload_config` 的 `retry_delay`，以及返回的 `{fileInfo, ttl}` 均保持原样。

### 2. 校验层 —— `packages/channels/qqbot/src/file-tools.ts`

`readOutboundFile(path, workspaceDir)` 变为 `readOutboundFile(path, workspaceDir, kind)`，其中 `kind: 'file' | 'image' | 'video' | 'voice'`。现有边界检查先原样执行（绝对路径、realpath 位于根目录内、普通文件、单一硬链接、最终组件非符号链接、非空、两次 `fstat` 之间不变）。然后：

- 按 kind 选择字节上限：`image` 20 MB、`video` 30 MB、`voice` 20 MB、`file` 20 MiB（不变）。三个新上限是平台软限制的十进制值，而不是二进制 MiB：超过软限制一个字节的上传会被降级为文件卡，因此若用 20 MiB（20.97 MB）作上限，就会放过一种平台随后渲染为文件卡的大小。现有文件上限保持 20 MiB，因为它早于本次改动，且远低于 200 MB 的文件软限制。
- 格式由从同一已打开描述符读出的 magic bytes 决定，而非文件名：

  | kind    | 接受                | 探测                                                                            |
  | ------- | ------------------- | ------------------------------------------------------------------------------- |
  | `image` | PNG、JPEG           | `89 50 4E 47`、`FF D8 FF`                                                       |
  | `video` | MP4                 | 偏移 4 处的 `ftyp` box                                                          |
  | `voice` | SILK、MP3、WAV、OGG | `#!SILK_V3` / `\x02#!SILK_V3`、`ID3` 或 `FF Ex/Fx` 帧同步、`RIFF….WAVE`、`OggS` |
  | `file`  | 任意                | 无                                                                              |

- 被拒绝的类型产生模型可见的消息，说明接受的格式并指向 `qq_send_file` 作为兜底，例如
  `qq_send_image: only PNG and JPEG are sent as images; use qq_send_file to send this file as a file card.`
  不会自动降级。

按类型的公开上限被导出（`QQ_OUTBOUND_IMAGE_MAX_BYTES`、`QQ_OUTBOUND_VIDEO_MAX_BYTES`、`QQ_OUTBOUND_VOICE_MAX_BYTES`），使测试与工具描述共用同一个事实来源。`QQ_OUTBOUND_FILE_MAX_BYTES` 保持现有名称与数值。

### 3. 工具层 —— `packages/channels/qqbot/src/file-tools.ts`

- `QQFileToolDeps.sendFile` 改为 `sendMedia({ sessionId, chatId, kind, fileName, bytes })`，其中 `kind` 是同一个四值联合类型。
- `buildFileTools` 返回四个定义。三个新工具只有 `path` 属性；`file_name` 仍为 `qq_send_file` 独占，因为图片、视频、语音消息不展示名称。上传的 `file_name` 字段使用解析后的 basename。
- 每个描述都说明接受的格式、大小上限，以及文件必须位于会话工作区或系统临时目录内，与当前 `qq_send_file` 的描述（`file-tools.ts:61-82`）一致。
- 各 handler 共用一段实现：解析会话、按 kind 读取并校验、推导显示名、调用 `sendMedia`、失败时记录日志、成功时返回 `Image sent (<name>).` / `Video sent (<name>).` / `Voice sent (<name>).`。

### 4. 适配器 —— `packages/channels/qqbot/src/QQChannel.ts`

- `sendQQFile` 改为 `sendQQMedia(input & {kind})`。路由解析、回复锚点、`takeMsgSeq` / `beginMsgSeqSend` / `rollbackMsgSeq`、`429` 拒绝、`304080` 重新上传规则、主动重试以及 `finally` 记账均不改动。有三处随 kind 变化：
  1. 传给 `uploadQQRichMedia` 的 `fileType: QQ_FILE_TYPE[kind]`；
  2. 所有日志与失败消息中使用的工具名（通过 `toolName` 参数传入 `describeUploadFailure` 与 `describeMediaSendFailure`）；
  3. 上传的大小/格式校验，现在发生在调用之前的工具层，因此适配器自身的限制不变。
- `registerFileTools` 传入 `sendMedia: (input) => this.sendQQMedia(input)`，并保留 `fileTools !== true` 的判断。

新类型选用的失败文案是现有文案替换工具名（`qq_send_image: the platform rejected the file as too large (850031).`、`qq_send_voice: the platform does not support this file format (850019).` 等），这样已经通过 `qq_send_file` 失败学习过的模型看到的是同一种形状。

### 5. 文档

- 在 `docs/users/features/channels/qqbot.md` 增加出站媒体一节：四个工具、它们的格式与上限，以及需要 `fileTools: true`。
- 仅当 `docs/users/features/channels/overview.md` 的现有出站行不完整时，才在其中补充 `file_type` 映射；否则不改动范围。

## 设计决策与理由

- **三个工具而不是一个带 `kind` 参数的工具。** 选定的接口贴合调用方：“把这件东西当图片发”和“当文件发”是不同意图，模型不应从一个有效性取决于文件 magic bytes 的枚举里挑类型。分开的描述还能让每个工具自带格式清单；一条覆盖四种类型的共享描述会把约束埋掉。上传与发送代码是共享的，所以这只是在 schema 层变宽，实现层没有变宽。
- **`file_type` 是必填的上传参数。** 给默认值会让将来新增的第五个调用方忘记传参，从而悄悄把图片当文件卡上传。生产环境只有一个调用点，改动的成本很小。
- **图片格式是 PNG 与 JPEG，不是概览页的更宽列表。** 平台自身的页面互相矛盾：“支持的消息类型”一节说图片可以是 `jpg/png/gif/webp/bmp`、语音可以是 `silk/mp3/wav/ogg`，而“文件类型与限制”表只列了图片 `png/jpg`、语音 `silk`。表格是 API 参数契约，也是上传端点校验的依据，因此图片以表格为准。语音则采用更宽的列表（见下一条决定）。所以 GIF 或 WEBP 会被 `qq_send_image` 拒绝，并提示改用 `qq_send_file`；文件仍以文件卡的形式到达用户。
- **语音接受更宽的列表。** 只接受 SILK 的语音消息在实践中没有用——本地音频几乎总是 WAV 或 MP3，而适配器没有编码器。概览页记载语音消息支持 SILK/MP3/WAV/OGG，被平台拒绝的格式会以正常错误返回（不支持的格式为 850019），模型能看到并改用 `qq_send_file` 重试。这是两处平台文档冲突中唯一偏向宽列表的地方，理由是：被拒绝的格式会退化为清晰的错误，而拒绝一个合法格式会静默移除一项有文档记载的能力。
- **软限制在本地执行，而不是留给平台。** 平台会把超限的图片、视频或语音上传静默降级为文件卡。在模型以 `qq_send_image` 发起的调用里这么做，就等于对一种不同的可见结果返回成功。本地拒绝让工具契约保持诚实，并明确告诉模型下一步该做什么。
- **格式由 magic bytes 决定，而非扩展名。** 出站路径没有理由信任模型提供的文件名，而且适配器入站时已经在嗅探图片 MIME（`media.ts:113`）；出站方向不应更弱。读取来自已经打开且经 `fstat` 校验的描述符，因此被嗅探的字节就是被上传的字节。
- **不新增配置开关。** `fileTools: true` 的语义已经是“允许模型以机器人自身身份把本地文件交给平台”（`QQChannel.ts:5063-5067`）。发送图片是同一类出站动作、同样的暴露面；第二个开关只会让两个接口面逐渐漂移。

## 平台约束

- 富媒体先上传后发送：`upload_prepare` → 每个分片预签名 `PUT` → 每个分片 `upload_part_finish` → 以 `srv_send_msg: false` 合并 `POST /v2/{users|groups}/{openid}/files` → `file_info`，然后 `POST .../messages` 携带 `{msg_type: 7, media: {file_info}}`。
- `file_type`：`1` 图片（`png`/`jpg`，软限 20 MB，硬限 200 MB）、`2` 视频（`mp4`，软限 30 MB，硬限 200 MB）、`3` 语音（`silk`，软限 20 MB，硬限 200 MB）、`4` 文件（任意格式，软限 200 MB，硬限 200 MB）。超过软限制时平台降级为文件卡；超过硬限制时报错。
- 上传端点按场景隔离：单聊用 `/v2/users/{user_openid}/…`，群聊用 `/v2/groups/{group_openid}/…`，包括预上传与分片完成端点。现有的 `QQRichMediaScope` 选择已处理这一点。
- `file_info` 有 TTL（`ttl`，`0` 表示不过期）；`304080` 表示句柄在发送前过期，现有路径会在下次尝试时重新上传。
- 平台只接受富媒体消息作为对近期消息的被动回复，因此现有代码总是先尝试回复锚点，再回退为一次主动发送。
- 官方参考：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>。

## 测试

单元测试，位于现有文件：

- `api.test.ts`：`uploadQQRichMedia` 在 `upload_prepare` 与合并请求体中都发送请求的 `file_type`（每种类型一个用例），且现有流程断言（分片、`md5_10m`、重试、`ttl`）在加入新的必填参数后仍然成立。
- `file-tools.test.ts`：四个工具定义及其 schema（`qq_send_file` 保留 `file_name`；新的三个只有 `path`）；每种 kind 的 magic bytes 接受与拒绝；每个媒体字节上限各测一个超过上限的用例（文件上限保留现有的恰在上限与超过上限用例）；拒绝消息说明接受的格式并指向 `qq_send_file`；现有路径边界与 TOCTOU 测试在新的 `kind` 参数下仍然通过；每个 handler 把正确的 `kind` 传给 `sendMedia` 并渲染正确的成功行。
- `QQChannel.test.ts`：四个工具只在 `fileTools: true` 时注册；`sendQQMedia` 把每种 `kind` 映射到正确的 `file_type`；上传/发送失败带正确的工具名前缀；锚定发送回退与 `msg_seq` 回滚的行为与 `qq_send_file` 一致。

测试不发起新的平台调用；上传与消息端点像现在一样被桩接。三种类型的真机验证保持手动，设计会记录这一空白，而不是暗示格式清单已对线上 API 验证过。

## 验收

1. 在 `fileTools: true` 下，被要求生成 PNG 图表的 agent 调用 `qq_send_image`，用户收到渲染的图片消息，且没有文件卡出现。
2. MP4 作为可播放的视频消息发出；SILK/MP3/WAV/OGG 作为语音条发出。
3. 21 MB 的 PNG 在上传前被拒绝，消息说明接受的格式与 `qq_send_file` 兜底；25 MB 的 MP4 被接受（在 30 MB 视频上限内）。
4. 传给 `qq_send_image` 的 GIF 或 WEBP 被拒绝并给出同样的兜底指引，`qq_send_file` 可将其作为文件卡发送。
5. `qq_send_file` 的输出、限制与失败文案不变。
6. 群聊发送与单聊发送都选择正确的上传场景；过期句柄在重试调用时仍然重新上传；被拒绝的锚定发送仍然回退为一次主动发送。
