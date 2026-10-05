# Omni 策略工具扩展与 memory 条件命名空间

## 状态

- 状态：Implemented(omni-experiment 分支)
- 范围:Qwen Code 实验分支 omni harness 的策略工具集与条件编排能力
- 前置设计:
  [Omni 多模态数据处理 Policy 编排架构设计](./2026-07-29-omni-multimodal-policy-orchestration.md)、
  [Omni 多模态 Memory 架构设计](./2026-07-29-omni-multimodal-memory.md)
- 需求来源:`omni-harness-gap-analysis.md`(2026-08-17,对照 omni harness 设计文档
  与 Qwen-MM-Plugins 插件集的差距分析)
- 基线:`omni-experiment`,S1–S6 已合入(`e2e6541f01`)

## 1. 背景

差距分析对照 omni harness 设计文档(11 个工具)与 Qwen-MM-Plugins 插件集,
确认 6 个设计文档工具已实现、6 个未实现,另有编排层与计费杠杆两类差距。
本文档对应差距分析的优先级 1–5(❶–❼ + ❿⓫),即:

| #   | 差距                                                | 本文对应 |
| --- | --------------------------------------------------- | -------- |
| ❶   | `omni_clip_image` 策略形态图片裁剪                  | §3.1     |
| ❷   | `omni_caption_image` VL 图片描述                    | §3.2     |
| ❸   | `omni_ocr_image` 图片 OCR                           | §3.2     |
| ❹   | `omni_clip_audio` 音频时间裁剪                      | §3.1     |
| ❺   | `omni_caption_audio` 音频语义描述                   | §3.2     |
| ❻   | `omni_understand_video_segments` 长视频分段并行理解 | §3.3     |
| ❼   | `memory.*` 条件命名空间                             | §4       |
| ❿   | patch-grid 对齐 smart_resize + token 预算档位       | §5       |
| ⓫   | 动态 FPS 均匀采样 + 并行 seek 抽帧                  | §5       |

优先级 6–7(grounding/segmentation、非 PDF 文档 visualize、video-memory 内容图、
视频/语音生成、image_search、OSS 远程读取)按差距分析"视产品定位排期"不纳入
本次范围。

## 2. 设计决策

### D1 模型调用类工具共用一个请求辅助模块

`omni_caption_image` / `omni_ocr_image` / `omni_caption_audio` /
`omni_understand_video_segments` 四个工具的远端调用同构:OpenAI 兼容
chat.completions、媒体 content part(image_url / video_url / input_audio
data URI)+ 指令文本、SSE 流式组装。该公共面收敛为
`omni/policy/tools/omni-chat-request.ts` 的 `requestOmniChatCompletion`,
复用 transcribe-audio 的 `parseSseTranscript` SSE 解析;非 2xx 一律只回报
`HTTP <status>`,上游 body 永不进入模型可见内容(与 transcribe-audio 一致)。

`omni_transcribe_audio` 自身的请求 helper 保留不动:它是纯音频 + 分片语义,
迁到共享模块只会增加耦合。

### D2 文本产物沿用转写协议,memory role 用预留枚举

四个文本产出工具的产物结构与 §6.2 转写协议一致:严格 UTF-8 text/plain 文件
产物 + `metadata.omniRole` 标注 + 强制披露。role 取值直接使用 memory 类型
枚举中已预留的 `'caption'` / `'ocr'` / `'summary'`
(`services/media-memory/types.ts` 的 `KnownMediaMemoryRole`),无需改动
memory 的 channel/coverage 推导:`ocr → onscreen_text`、`caption/summary`
按源模态落 `visual`/`acoustic`,coverage 默认为 `complete`。

### D3 裁剪工具的"反 no-op"与"角色标注"

`omni_clip_image` / `omni_clip_audio` 与 `omni_clip_video` 保持同一语义族:

- 时间/空间裁剪是**切取而非降质**:clip_audio 采样率/声道不动,clip_image
  输出 PNG(幸存像素不再被有损重编码二次伤害);
- 全覆盖 no-op(整图/全时长"裁剪")在参数层或执行早期拒绝——否则只是
  白跑一次有损重编码,披露还会谎称丢弃了范围外内容;
- 产物标 `omniRole: 'clip'`,memory 据此映射 `partial` coverage。

`omni_clip_image` 与模型直调的 `zoom_image` 是互补而非重复:zoom_image 用
归一化坐标、不走 policy 管线;clip_image 用像素坐标、可被 fixedPolicies
编排、产物入 memory 谱系。

### D4 长视频理解的分段规格

`omni_understand_video_segments` 按设计文档 §3.3 锁定两个上限:
`maxParallelSegments` ≤ 8(并发上限)、`maxSegmentBytes` 默认 10MiB(inline
上限)。分段重编码目标(360p / 450kbps 视频 + 32kbps 单声道 AAC)使 60s
上限分段约 3.6MB,远低于 inline 天花板;仍超限的分段内联标注失败而不是
发出必然失败的请求。时长不可探测时 fail-closed(无法规划分段);容器声称
时长超 512 段上限时同样 fail-closed(与 transcribe-audio 同一理由:
时长是攻击者可影响的元数据)。

### D5 memory.\* 命名空间的语义与求值时机

条件 DSL 新增第四命名空间 `memory.*`,六个 0/1 字段:
`hasTranscript` / `hasOcr` / `hasCaption` / `hasSummary` / `hasKeyframes` /
`hasClip`,语义为"该 item 版本的 memory 子图中已存在对应 role 的产物"。

关键设计点:

- **子图而非同版本**:`MediaMemoryService.collectVersionOutputRoles` 沿
  DERIVED_FROM 子图(root 有界,M §8)收集 role。§4.1 链条"视频 → 抽音轨 →
  转写"中,转写产物挂在派生音频版本下;只查本版本永远看不到它。
- **三值语义不破**:memory 未开启、item 无绑定、存储不可读时整个命名空间
  缺失,`memory.*` 条件求值为 `unavailable`(由 `onConditionUnavailable`
  决定 skip/run),绝不静默当假——否则"无转写才转写"在记忆不可读时会
  退化成"永远转写"。
- **惰性求值**:orchestrator 仅在某条 policy 的 `when` 引用 `memory.*`
  时(新增的 `conditionUsesNamespace` 判定)才做一次存储读取;不引用
  memory 的既有配置零开销。
- **与执行级复用的分工**:`findReusableOutputs`(同文件+同指纹跳过重复
  执行)管"幂等",`memory.*` 管"按记忆状态走分支"。两者可叠加:条件
  no_match 时连复用记账都不发生。

### D6 patch-grid 对齐与 token 预算档位

新模块 `omni/smart-resize.ts`(移植插件 `shared/image.py` 的
`smart_resize` / `budget_to_pixels`):

- 网格因子 28(Qwen-VL 族:14px patch × 2×2 merge),一个视觉 token 覆盖
  28² = 784 像素;与 `estimation.ts` raw-resource-v1 的 2048 px/token
  保守估计刻意不同——估计器宁多算保安全,预算器对准计量网格。
- 档位:图片 small/normal/large = 256/1024/2048 tokens,视频逐帧
  80/256/1024;最小档同时作为 minPixels(小图上采样到网格,避免不足一个
  cell 的零碎计费)。
- 接入点:`omni_downsample_image` 新增 `tokenBudget` 参数(设置后覆盖
  `maxDimension`,按显示尺寸——EXIF orientation ≥ 5 换轴——精确缩放到
  网格);`omni_extract_keyframes` 新增 `frameTokenBudget`(逐帧网格尺寸)。

### D7 动态 FPS 均匀采样

`omni_extract_keyframes` 新增 `strategy: 'uniform'`(默认 `scene` 不变,
完全向后兼容):帧数 `clamp(窗口时长 × fps, 1, maxFrames)`,长视频自动
降采样率;每个时间戳独立 `-ss` 精确寻址、并行 4 路抽取(插件
`extract_frames_by_seeking` 形态);`startSec`/`endSec` 提供裁剪+采样一体。
时长未知时回退既有 scene 路径。这是"480p/10fps 降不了计费 token"实测结论
的直接对策:计量单位是 帧数×像素,fps 与逐帧像素预算才是有效杠杆。

## 3. 工具规格

### 3.1 裁剪

- `omni_clip_image`(image → PNG):`x`/`y`/`width`/`height` 像素坐标必填;
  EXIF 方向先于裁剪烘焙,坐标即用户所见;动图双闸拒绝(与 downsample/convert
  一致);role `clip`。
- `omni_clip_audio`(audio → WAV/MP3/M4A):`startMs` ≥ 0、`durationMs` ≥
  1000(设计文档下限),默认到结尾;输入侧 `-ss`/`-t` + 重编码保证采样级
  精确;role `clip`。

### 3.2 模型理解(文本产物)

- `omni_caption_image`(image → 文本,role `caption`):`prompt` 可配
  (默认整体详细描述),`maxInputBytes` 默认 10MiB。
- `omni_ocr_image`(image → 文本,role `ocr`):`language` 可选提示
  (默认自动检测),`prompt` 可覆盖默认 OCR 指令;解锁设计文档 §4.5 的
  文档/文字图片 OCR fixedPolicy。
- `omni_caption_audio`(audio → 文本,role `caption`):与 transcribe-audio
  同构(分片并发 3、共享时间预算、退化检测、单段失败内联标注),prompt
  由参数/settings 提供,默认描述语音大意/音色/事件/情绪;与转写的分工是
  "理解 vs 逐字"。

三者共有运维参数 `model` / `baseUrl` / `apiKeyEnv`,均列入
`operatorOnlyParams`(与 transcribe-audio 同一安全理由:端点与凭据选择
必须运维控制)。

### 3.3 长视频理解

`omni_understand_video_segments`(video → 文本,role `summary`):
`segmentSeconds` 默认 30(5–60)、`maxParallelSegments` 默认 8(上限 8)、
`maxSegmentBytes` 默认 10MiB;逐段 `[MM:SS-MM:SS]` 标注拼装,单段失败内联
标注,全段失败才整体报错。

## 4. 条件 DSL 扩展

`conditions.ts`:`MEMORY_CONDITION_FIELDS` + `memory` 上下文命名空间 +
`conditionUsesNamespace`;`orchestrator.ts` 在 pass 起始快照中按 item 求值
memory 命名空间;`service.ts` 新增 `collectVersionOutputRoles`(存储不可读
返回 undefined → `unavailable`)。

## 5. 验证

- 单元/集成测试:每个新工具独立测试文件(descriptor 声明、参数校验、
  请求形态、披露文本、失败路径);`smart-resize` 网格/档位数学;conditions
  的 memory 三值语义;service 的子图 role 收集(含 §4.1 派生链);
  orchestrator 端到端:memory 门控 policy 首轮执行、次轮零调用。
- 全量回归:`src/omni` + `src/services/media-memory` 45 文件 1017 测试通过;
  eslint 零告警;tsc 无新增错误。
