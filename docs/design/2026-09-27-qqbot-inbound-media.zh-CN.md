# QQ Bot 入站媒体（图像、视频、文件与语音）

[English](2026-09-27-qqbot-inbound-media.md) | [简体中文](2026-09-27-qqbot-inbound-media.zh-CN.md)

- 状态：提案
- 日期：2026-09-27
- 范围：`packages/channels/qqbot`（仅适配器）

## 问题

QQ Bot 渠道是唯一无法接收媒体的渠道。用户向 bot 发送截图、视频、文档或语音消息时
得不到任何响应：只有媒体、没有文字的消息在构造 envelope 之前就被丢弃；即使带文字
说明，附件依然被忽略，于是 agent 的回答就像那条媒体从未发送过一样。

仓库已把这一点记录为已知缺口
（`docs/users/features/channels/overview.md:452`）："QQ Bot does not process
incoming media — image and sticker messages are ignored, so it has no
media-handling row above."

## 现状

- `QQMessageEvent`（`packages/channels/qqbot/src/types.ts:24-41`）只有 `id`、
  `author`、`content`，没有 `attachments` 字段，因此平台的附件数组在任何代码
  看到它之前就被类型丢掉了。
- C2C 消息在 `packages/channels/qqbot/src/QQChannel.ts:2580` 被丢弃
  （`if (!event.content?.trim()) return;`）。群消息在
  `packages/channels/qqbot/src/QQChannel.ts:2486` 被丢弃
  （`if (!cleanText) return null;`）。两处都没有日志。
- QQ 平台确实会下发附件元数据（`C2C_MESSAGE_CREATE` 与
  `GROUP_AT_MESSAGE_CREATE` 上的 `attachments[]`），信息是现成的，只是没被使用。

共享渠道层已经支持入站媒体，因此适配器之外无需任何改动：

- `Attachment { type: 'image' | 'file' | 'audio' | 'video'; data?; filePath?;
mimeType; fileName? }`（`packages/channels/base/src/types.ts:97-108`）。
- `Envelope.attachments`、`imageBase64`、`imageMimeType`、`syntheticText`
  （`packages/channels/base/src/types.ts:121-155`）。
- `ChannelBase` 会把附件解析进 bridge 的 prompt
  （`packages/channels/base/src/ChannelBase.ts:6980-7020`）：图片的 base64
  `data` 被加入 prompt 的 `images` 数组（视觉输入）；带 `filePath` 的附件以
  `User sent a <label> "<name>". It has been saved to: <path>` 追加到 prompt
  文本。

已有四个渠道实现了这套模式（feishu、wecom、telegram、weixin）。WeCom 是最接近
的参照：图片转成 base64 附件，其他媒体写入 `tmpdir()/channel-files/<uuid>`，
权限 `0600`。

## 目标

1. 用户发给 bot 的图片——无论是 C2C 还是群聊——在**同一个 prompt** 中作为图像输入
   到达模型，消息中带的文字作为 caption 保留。
2. 用户发给 bot 的视频被下载到临时路径，并把该路径告知 agent，使其能用自己的工具
   打开文件。
3. 用户发给 bot 的文件被下载到临时路径，并把该路径告知 agent；发送方的原始扩展名
   被保留，使读取工具按文档分类，而不是当作不透明二进制处理。
4. 用户发给 bot 的语音消息被下载到临时路径，并把该路径告知 agent；平台提供
   SILK 转 WAV 的结果时优先使用它，而不是原始 SILK 音频。
5. 只有媒体、没有文字的消息不再被丢弃，而是开启一个回合。
6. 纯文本行为不变，包括斜杠命令与群 @ 处理。

## 非目标

- 出站媒体。把图片或视频发回去需要另行调用上传接口取得 `file_info`，再以
  `msg_type: 7` 发送，且 QQ 只允许它作为对近期消息的被动回复。这属于另一次改动。
- 把视频内容交给模型。base 契约没有视频内容部件，视频只是一个文件路径。
- 把音频内容交给模型。语音消息同样只是一个文件路径；平台的 ASR 文本
  （`asr_refer_text`）不使用。
- 主动消息或定时（cron）消息中的媒体。

## 方案

1. **类型**（`packages/channels/qqbot/src/types.ts`）。新增
   `QQMessageAttachment { url; content_type?; voice_wav_url?; filename?; size?;
width?; height? }`，并在 `QQMessageEvent` 上加
   `attachments?: QQMessageAttachment[]`。`QQGroupMessageEvent` 继承
   `QQMessageEvent`，因此自动获得该字段。`voice_wav_url` 是 QQ 在
   `content_type: voice` 附件上给出的 SILK 转 WAV 后的 URL。

2. **新增下载助手**（`packages/channels/qqbot/src/media.ts`）。
   - `classifyQQAttachment(contentType)` 把 `image/jpeg`、`image/png`、
     `image/gif` 映射为 `image`，把 `video/mp4` 映射为 `video`，把 `file`
     映射为 `file`，把 `voice` 映射为 `voice`，其余返回 `undefined`。
   - `downloadQQAttachment(url, maxBytes)` 拉取附件并返回
     `{ buffer, mimeType }`，实施主机白名单、30 秒超时，以及对声明的
     `Content-Length` 和实际流式总量双重字节上限（沿用
     `packages/channels/feishu/src/media.ts:50-93` 的做法）。
   - 限额：图片至多 8 MiB，视频、文件与语音至多 20 MiB，每条消息至多处理 5 个
     附件。超出限额的附件被跳过，并输出一行说明原因的 `stderr` 日志。图片上限
     用于界定加入请求的内联数据规模（base64 约膨胀三分之一，且 bridge 对内联图片
     的上限为 8 MB）；视频、文件与语音上限沿用 WeCom 的 20 MB
     （`packages/channels/wecom/src/WeComAdapter.ts:81`），也与 QQ 自身 20 MB 的
     语音软上限一致，远低于 QQ 的 200 MB 硬上限。

3. **适配器**（`packages/channels/qqbot/src/QQChannel.ts`）。
   - 新增共享私有方法 `attachInboundMedia`，下载受支持的附件。图片会**投递两次**：
     `{ type: 'image', data: <base64>, mimeType, fileName }` 让具备图像能力的模型
     在同一 prompt 中看到画面；以及同一份字节写入
     `tmpdir()/channel-files/<uuid>/<name>` 后的
     `{ type: 'file', filePath, mimeType, fileName }`，使 prompt 同时带上基类渲染的
     `saved to:` 行，让不能接收图片的模型仍有可用的路径。视频写入同一位置并以
     `{ type: 'video', filePath, mimeType, fileName }` 投递。文件写入同一位置，
     只投递一次 `{ type: 'file', filePath, mimeType, fileName }`——不产生内联条目，
     因为 QQ 以 `content_type: file` 下发且不带 MIME 类型，而 base 契约没有通用的
     文件内容部件。语音消息在平台给出 `voice_wav_url` 时从该 URL 下载，否则回落到
     `url`；字节写入同一位置，只投递一次
     `{ type: 'audio', filePath, mimeType, fileName }`——同样不产生内联条目，因为
     base 契约没有音频内容部件。其 MIME 由实际拉取的 URL 决定（转换结果用
     `audio/wav`，原始 SILK 用 `audio/silk`），而不是下载助手的返回值——后者无法
     为声明为字面量 `voice` 的响应体归类。渠道层没有能力判定，无法在两者间二选一，
     因此两条都提供。
   - 两处丢弃点（`:2486`、`:2580`）放宽为"既无文字、也无受支持附件"。该判断只
     需要 `event.attachments` 是否存在，无需先下载。
   - envelope 照今天的做法构造（用户没发文字时用占位文本），再通过
     `prepareThenHandleInbound(envelope, prepare)` 交给基类
     （`packages/channels/base/src/ChannelBase.ts:6389`，Telegram 采用的就是这个
     模式），使路由与去重发生在下载之前；prepare 回调在媒体下载完成后设置
     `envelope.attachments`。
   - 落盘文件名带上有嗅探 MIME 推出的扩展名（`.jpg`、`.png`、`.gif`、`.mp4`）：
     agent 的读取工具按扩展名判定媒体类型，若发送方给的名字缺失或误导，文件就会
     以不透明二进制形式交付。`file` 是唯一的例外：QQ 的 `content_type` 是 `file`
     而不是 MIME 类型，没有可映射的来源，于是改为保留发送方自己的扩展名——经
     `[A-Za-z0-9]{1,10}` 安全过滤，否则回落 `.bin`——因为这个扩展名是读取工具
     唯一的分类依据。语音消息是另一种情况：它根本没有文件名，词干回落到既有的
     `qq_<kind>` 默认值，扩展名由实际拉取的 URL 决定（转换结果 `.wav`，原始 SILK
     为 `.silk`）。
   - 不做任何回收。下载的文件留在系统临时目录中，由系统按自己的周期清理；适配器
     不为它保留跟踪状态、不挂钩子、也不做断连清扫。
   - 用户文字为空时，prompt 文本变为 `(image)`、`(video)`、`(file)` 或
     `(voice)`，并在 envelope 上设置 `syntheticText: true`，使占位文本不会被记入
     群引用历史。
   - 若确实存在媒体但一个附件都没能落地，文本变为
     `(User sent media but download failed)`，回合照常进行，避免静默忽略用户
     （沿用 `packages/channels/wecom/src/WeComAdapter.ts:488-494` 的做法）。

4. **文档。** 在 `docs/users/features/channels/overview.md` 的媒体矩阵中加入 QQ
   一行并删除"QQ Bot does not process incoming media"那条注记；把
   `docs/users/features/channels/qqbot.md` 的"Images, Videos, and Files"一节扩展为
   包含文件（文件类型、20 MB 上限、落盘路径）、语音（`content_type: voice` 类型、
   优先使用转换后的 WAV、20 MB 上限、落盘路径），以及无需文字即可开启回合。

## 设计决策与理由

- **图片投递两次：内联 + 落盘。** 内联（`attachments[type=image].data`）才是
  具备图像能力的模型真正看到的东西：基类把它收进 bridge 的 `images` 数组
  （`packages/channels/base/src/ChannelBase.ts:6987-6995`），因此画面随 prompt
  一起到达，不需要任何工具调用。同一份字节也会写入磁盘并以 file 类型附加，使
  prompt 带上 `User sent a file "<name>". It has been saved to: <path>`
  （`packages/channels/base/src/ChannelBase.ts:6996-7014`）：对不能接收图片的
  模型，内联部分会退化为"不支持图像"的说明，此时路径就是 agent 唯一的把手——
  它仍可用其他工具处理该文件。渠道层没有能力判定，无法二选一，因此两条都提供。
- **适配器无条件下发图片，但客户端仍可能把图片文本化。** 渠道层没有能力判定
  ——`grep -rn "modalities\|supportsImages\|imageSupport" packages/channels`
  在生产文件中零命中——并且 `ChannelBase` 无条件把 `images` 加入 bridge
  prompt（`packages/channels/base/src/ChannelBase.ts:7390-7392`），所以适配器
  不需要做视觉能力检测。但在下游，当所选模型未声明图像模态时，OpenAI 兼容
  线格式会把图片替换为文本占位：`createMediaContentPart` 返回
  `unsupportedModalityPlaceholder('image', ...)`
  （`packages/core/src/core/openaiContentGenerator/converter.ts:973-979`），
  而模态来自 `defaultModalities(model)`
  （`packages/core/src/core/modalityDefaults.ts:119`）——未知模型 id 判定为纯文本。
  Gemini 线格式对图片没有这道闸门，它只把 `audio/` 与 `video/` 文本化
  （`packages/core/src/core/llm-content-generator/llm-content-generator.ts:428-440`）。
  当主模型不具备图像能力、但存在可用的图像能力模型时，vision bridge 也可以在
  调用模型前先描述图片（`shouldRunVisionBridge`，作用于 prompt 部件的位置是
  `packages/cli/src/acp-integration/session/Session.ts:16130`）。
- **视频落盘为文件路径，不走 base64。** QQ 允许视频最大 200 MiB，而 base 契约
  没有视频内容部件，路径是 agent 唯一能操作的东西。
- **语音同样落盘为文件路径，并优先使用平台转换出的 WAV。** QQ 在
  `content_type: voice` 上同时给出 `url`（SILK）与 `voice_wav_url`（同一段音频
  转成 WAV）；优先用转换结果，因为读取它不需要额外解码，原始 SILK 作为回落。附件
  只投递一次，以路径形式给出 `{ type: 'audio', ... }`，因为 base 契约没有音频
  内容部件——`voice_wav_url` 字段只在这里被读取。平台的 ASR 文本
  （`asr_refer_text`）刻意不使用：把转写而不是音频交给模型属于单独的产品决策。
- **下载的媒体不做回收。** 早期版本在回合结束时删除目录，结果破坏了一个再自然
  不过的后续：agent 问"要我读一下图吗"，用户在下一个回合回答，而文件已经没了。
  文件改为留在系统临时目录中，由系统按自己的周期清理。这也让生命周期记账彻底
  消失——没有按消息的目录映射、没有 prompt 钩子、没有断连清扫——随之消失的还有
  早期回收规则反复制造的那一类缺陷。
- **文件保留发送方的扩展名，图像与视频以嗅探 MIME 为准，语音以实际拉取的 URL
  为准。** 读取工具按扩展名分类，因此对图像或视频，发送方给的扩展名绝不能
  获胜——由解析出的 MIME 决定。文件恰好相反：QQ 以 `content_type: file` 下发且
  不带 MIME 类型，没有可推导扩展名的来源，发送方自己的扩展名是唯一可用的分类
  依据。它经安全字母表过滤后保留（`[A-Za-z0-9]{1,10}`，否则 `.bin`），使 `.docx`
  不会以不透明二进制到达，同时构造过的文件名也无法注入路径字符。语音是第三种
  情况：它没有文件名，响应体也无法嗅探，因此扩展名由实际拉取的 URL 决定——
  转换结果为 `.wav`，原始 SILK 为 `.silk`——缺失的词干回落到既有的 `qq_voice`
  默认值。

## 平台约束

- 入站事件带 `attachments: MessageAttachment[]`，字段为
  `{ url, filename, width, height, size, content_type }`，其中 `content_type`
  取值 `voice`、`image/jpeg`、`image/png`、`image/gif`、`video/mp4`、`file`。
- `content_type: voice` 的附件还会带 `voice_wav_url`，即 SILK 转 WAV 后的 URL。
  QQ 语音的软上限为 20 MB（硬上限 200 MB）。
- 附件 URL 未在文档中声明为长期有效，因此立即下载而不是保存 URL。
- bot 只在其已订阅的消息类型上收到媒体（C2C、群 `@`、群全量），这三者已经订阅。

## 模型能力前提

走文件路径路线时，图片只有在 agent 的读取工具把它作为图像数据返回时才会到达
模型，而这要求会话所用模型被判定为具备图像能力。满足以下任一条件即可：

- 模型名被 `defaultModalities` 识别
  （`packages/core/src/core/modalityDefaults.ts:24-110`）——Gemini、GPT、Claude、
  `qwen*-vl`、`qwen3.5-plus` 等，或
- 在 settings 中显式声明该能力，其优先级高于按名字回退的判断
  （`packages/core/src/models/modelConfigResolver.ts:417-431`）：

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

对"确实多模态但名字不被识别"的模型，这个声明是必要的：`^deepseek` 命中纯文本
回退分支（`packages/core/src/core/modalityDefaults.ts:73-74`），因此
`deepseek-v4.1-flash` 虽然接受图片，却被当作纯文本模型。

当模型被当作纯文本且没有 bridge 生效时，读取工具返回的是"不支持图像"的提示而
不是图片本身。vision bridge（`shouldRunVisionBridge`，
`packages/core/src/services/visionBridge/vision-bridge-service.ts:176`）刻意不在
本设计之内：它让另一个模型去描述图片，而这正是本次改动要避开的转换。这是部署
前提，不是适配器的代码改动。

## 风险

- **URL 主机变更。** 若平台改从白名单之外的主机下发附件，媒体会被跳过并记日志，
  而不是去拉取。白名单即 SSRF 防线，因此按失败关闭处理。
- **Prompt 体积。** 内联图片是 base64，会让字节膨胀约三分之一；8 MiB 的图片上限
  界定了新增请求体的规模。
- **caption 形态。** 对纯图片消息，QQ 可能下发空 `content`，也可能下发文件名。
  任何非空内容都当作 caption 处理，为空则用占位文本替换。
- **下载的媒体会累积。** 没有任何东西删除已下载的文件，因此视频量大的 bot 会一直
  保留这些字节，直到系统清理临时目录。这个取舍是刻意的：被它取代的"回合结束即删"
  会让后续回合失去文件，而任何想安全回收它的做法都需要记账，而那些记账本身又
  不断制造缺陷。
- **纯文本模型仍然看不到画面。** 它拿到的是"不支持图像"的说明加文件路径；再往下
  取决于 agent 是否有别的工具能处理该文件。
- **文件类型只能听发送方的。** QQ 的 `content_type: file` 不带 MIME 类型，因此
  落盘扩展名来自发送方的文件名。谎报类型的发送方会让该扩展名落到磁盘上；agent
  仍然拿得到字节，可以自行检查。
- **语音是一段音频文件，而不是转写文本。** base 契约没有音频内容部件，因此 agent
  拿到的是 `.wav`（或 `.silk`）文件的路径，只能靠自己的工具去处理；平台附带的 ASR
  文本被忽略。此外 `.silk` 无法被常见工具播放，这也是只要 QQ 给出转换结果就优先
  使用 WAV 的原因。

## 验证计划

- 单元测试，位于 `packages/channels/qqbot/src/events.test.ts` 与新增的
  `packages/channels/qqbot/src/media.test.ts`：纯图片 C2C；纯图片群消息；caption
  加图片；图片同时产生内联附件（base64 数据、嗅探 MIME、无路径）与落盘的 file
  附件；视频落盘且在 prompt 结束后仍然存在；带 caption 的文件落盘一次，形如
  `{ type: 'file', filePath }` 且无内联条目，并保留 `.docx` 扩展名；纯文件消息在
  C2C 与群聊中都能开启回合，占位文本为 `(file)`；超过 20 MB 上限的文件被跳过并
  输出一行 `stderr`；带 `voice_wav_url` 的语音消息拉取的是该 URL（而不是 `url`），
  落盘为 `qq_voice.wav`、`mimeType: audio/wav`，只产生一条
  `{ type: 'audio', filePath }` 附件，且文件字节与 `0600` 权限相符；不带
  `voice_wav_url` 的语音消息回落到 `url`、`.silk` 与 `audio/silk`；纯语音消息在
  C2C 与群聊中都能开启回合，占位文本为 `(voice)`；超过 20 MB 上限的语音被跳过并
  输出一行 `stderr`；下载失败产生占位文本；`syntheticText` 被设置；既有纯文本测试
  保持绿色。契约侧已有测试钉住：`ChannelBase.test.ts:13934`（内联图片附件按序
  转发）与 `:13848`（文件路径被追加到 prompt）；适配器侧为
  `WeComAdapter.test.ts:1519` 与 `:1675`。QQ 的测试镜像这些断言，而不是另造一套
  形态。
- 包内静态检查：`tsc --build`、ESLint、Prettier。
- 实机验证：从源码构建 CLI，把本机 qqbot 服务指向该构建，向 bot 发送一张带
  caption 的图片、一段视频、一份文档和一条语音消息，确认 agent 无需读取文件即可
  描述图片、能打开视频路径、能按 `.docx` 路径读取文档，并能打开语音消息的 `.wav`
  路径。

## 验收标准

1. 向 bot 发送图片（带或不带 caption）时，具备图像能力的模型在同一 prompt 中
   以图像输入收到它——无需任何工具调用即可看到；同一份字节同时留在磁盘上，且
   路径出现在 prompt 中。
2. 向 bot 发送视频会产生一个回合，其 prompt 给出已下载的路径，且此后该文件仍在。
3. 向 bot 发送文件会产生一个回合，其 prompt 给出已下载的路径，磁盘上保留发送方的
   扩展名，且消息不带文字时回合照常进行。
4. 向 bot 发送语音消息会产生一个回合，其 prompt 给出已下载的路径：平台提供转换
   结果时拉取 WAV（`.wav`、`audio/wav`），否则回落到原始 SILK URL（`.silk`、
   `audio/silk`），附件只以音频条目投递一次，且消息不带文字时回合照常进行，
   占位文本为 `(voice)`。
5. 若模型为纯文本，内联部分退化为文档化的"不支持图像"说明，而路径仍然可用，
   而不是媒体被静默丢弃。
6. 纯文本消息的行为与今天完全一致。
7. 适配器从不删除已下载的媒体。
8. 渠道文档不再声称 QQ 忽略入站媒体，也不再声称 QQ 不支持文件，也不再暗示 QQ
   忽略语音消息。

## 待解问题

- `attachments[].url` 的确切有效期未见于文档；本设计假定必须立即拉取。
- 生产环境中，纯图片消息的 `content` 是文件名还是空字符串。
- 平台的 ASR 转写（`asr_refer_text`）是否作为后续改动交给模型。
