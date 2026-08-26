# Omni 媒体策略编排

> 实验特性:仅在 omni 实验分支可用。媒体临时上传仍使用 DashScope 通道;推理既可使用 DashScope OpenAI 兼容模式,也可通过独立上传配置接入自部署的 OpenAI 兼容 Omni 模型。配置格式可能随实验推进调整,不承诺向后兼容。

当你把图片、音频、视频交给多模态模型时,原始文件往往过大(一部 1080p 电影约 1GB)或过长(81 分钟的音轨),直接投递要么超出上传通道限制,要么烧掉整个上下文窗口。**媒体策略编排**让你用配置声明"什么媒体、满足什么条件时、用哪个工具、降质成什么样再投递",整条流水线是:

```
识别媒体 → 匹配固定策略 → 派生降质产物(staging) → 内容寻址入库(objects) → 携带披露投递给模型
```

三条铁律贯穿全程:

1. **有损必披露**——任何降质产物送达模型时,紧邻的文本部件必须携带 `【媒体降质】`(或 `【媒体省略】`/`【媒体转写】`)标记,说明丢了什么;
2. **配置错误启动即失败**——策略引用不存在的工具、条件写错字段、矛盾的组合,一律在启动时报 `OmniPolicyConfigError`,绝不静默降级;
3. **条件不可判定不等于假**——探测不到的元数据字段产生 `unavailable` 三值结果,按策略声明的 `onConditionUnavailable` 处理,永不悄悄当作 `false`。

---

## 快速开始

在项目 `.qwen/settings.json`(或用户级 `~/.qwen/settings.json`)中:

```json
{
  "omni": {
    "enabled": true,
    "processing": {
      "fixedPolicies": {
        "big-image-downsample": {
          "mediaTypes": ["image"],
          "when": [">", ["field", "resource.width"], 3000],
          "toolName": "omni_downsample_image",
          "arguments": { "maxDimension": 1568, "quality": 75 }
        }
      }
    }
  }
}
```

之后任何一张宽度超过 3000px 的图片(来自 `@` 引用、工具结果或 URL 摄取)都会先被降采样,再连同一条 `【媒体降质】原 4096×3072/8.2MB → 1568×1176/…` 披露投递给模型;宽度不超标的图片则原样直达。

零配置时 `fixedPolicies` 为空,预处理完全不运行——只有强制的传输守卫(见下文)在媒体超出上传通道限制时兜底。

### 自定义推理与 DashScope 上传解耦

当 Omni 推理走自部署地址、媒体仍需上传到 DashScope 时,配置独立上传通道:

```json
{
  "omni": {
    "enabled": true,
    "delivery": {
      "upload": {
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKeyEnv": "DASHSCOPE_API_KEY",
        "model": "qwen3.5-omni-plus"
      }
    }
  }
}
```

`apiKeyEnv` 填环境变量名,不填明文 key;启动 Qwen Code 前需确保该变量已有值。三个字段必须同时设置,否则启动失败。上传 endpoint/key/model 只用于 `getPolicy`、文件上传和上传缓存;自部署推理的 endpoint/key 仍按原有模型配置使用,两套凭据不会交叉发送。

如果三个字段都不设置,则保留旧行为:当前推理配置本身必须是带静态 API key 的 DashScope 兼容配置,并同时作为上传配置。

---

## 配置总览

```
omni.enabled                                     总开关
omni.processing.fixedPolicies.<id>               预处理策略(本文主角)
omni.processing.transportGuard.policies.<id>     传输守卫策略(有系统默认,可覆盖不可删除)
omni.processing.transportGuard.maxUploadFileBytes  单文件上传上限(≤ 1GiB)
omni.processing.policyTools.<toolName>           工具级设置 / 超时 / 模型可见性
omni.processing.limits                           每根资源的派生预算
omni.delivery.upload.baseUrl                     DashScope 上传 endpoint
omni.delivery.upload.apiKeyEnv                   上传 key 的环境变量名
omni.delivery.upload.model                       获取上传 policy 使用的模型
omni.delivery.upload.urlTtlHours                 上传 URL 缓存时长(≤ 48)
```

---

## fixedPolicies:固定策略

每条策略是 `策略 id → 配置对象` 的一个键值对。id 需匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`;值为 `null` 可删除(墓碑)更低作用域配置合并进来的同名策略。**未知键一律报错**,不会被忽略。

| 键                       | 类型 / 取值                     | 默认                 | 说明                                                                                                                     |
| ------------------------ | ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `priority`               | 有限数字                        | `0`                  | 执行顺序:priority 降序,同分按 id 升序。                                                                                  |
| `mediaTypes`             | `("image"\|"video"\|"audio")[]` | 必填                 | 策略适用的媒体模态,非空。                                                                                                |
| `origins`                | `("user"\|"tool"\|"policy")[]`  | `["user","tool"]`    | 接受哪些来源的媒体:用户 `@` 引用 / 工具结果 / 其他策略的派生物。                                                         |
| `when`                   | 条件表达式数组                  | 不设(总是匹配)       | 见下节 DSL。                                                                                                             |
| `onConditionUnavailable` | `"skip"` \| `"run"`             | `"skip"`             | 条件字段探测不到时跳过还是照跑(`"abortTurn"` 为设计保留值,当前配置会被拒绝)。                                            |
| `toolName`               | 字符串                          | 必填                 | 必须是已注册的媒体策略工具(见工具一览);被 `tools.disabled` 排除的工具视为未注册。                                        |
| `arguments`              | 对象                            | `{}`                 | 传给工具的固定参数,按工具的 `settingsSchema` 校验;`inputPath`/`outputDir`/`resourceId` 由编排器逐次注入,配置它们会报错。 |
| `maxRunsPerLineage`      | 正整数                          | `1`                  | 同一资源谱系上该策略最多执行几次,防循环。                                                                                |
| `onFailure`              | `"continue"` \| `"abort"`       | `"continue"`         | 工具失败后继续匹配后续策略,还是中止本根资源的处理。                                                                      |
| `output.reprocessMedia`  | 布尔                            | `false`              | 派生物以 `policy` 来源重新进入策略匹配(策略链)。                                                                         |
| `output.source`          | `"keep"` \| `"omit"`            | `"omit"`             | 源媒体是保留在投递集中,还是被派生物替代。                                                                                |
| `output.artifacts`       | 选择器映射                      | `{ "*": "include" }` | 多产物工具的分流:`include` 进投递集,`retain` 只入库不投递。                                                              |

### output.artifacts 选择器

选择器有三种形态,匹配优先级 `role:` > `kind:` > `*`;配置了映射但没有任何选择器命中的产物按 `retain` 处理:

```json
"output": {
  "artifacts": {
    "role:transcript": "include",
    "kind:image": "retain",
    "*": "include"
  }
}
```

- `kind:<image|video|audio|file>` —— 按产物类别;
- `role:<token>` —— 按工具声明的产物角色(如转写工具的 `transcript`);
- `*` —— 兜底。

启动校验会核对每个选择器确实是该工具能产出的类别/角色——永远匹配不到的选择器是配置错误,不是静默空操作。

---

## when 条件 DSL

条件是 Mapbox 风格的表达式数组:`[操作符, ...操作数]`。

```json
[
  "all",
  [">", ["field", "resource.durationMs"], 1200000],
  ["!", ["<", ["field", "resource.sizeBytes"], 1048576]]
]
```

- **比较**:`>` `>=` `<` `<=` `==` `!=`,恰好两个操作数,各为 `["field", "<命名空间.字段>"]` 引用或字面量(数字/字符串/布尔);排序类操作符要求数字。
- **组合**:`["all", …]`(与)、`["any", …]`(或)、`["!", <expr>]`(非),可任意嵌套。
- 不支持任意代码、JSONPath 或嵌套取值子表达式。

### 可用字段

| 命名空间    | 字段                        | 含义                                                                           |
| ----------- | --------------------------- | ------------------------------------------------------------------------------ |
| `resource.` | `sizeBytes`                 | 文件字节数                                                                     |
|             | `durationMs`                | 时长(毫秒,音/视频)                                                             |
|             | `width` / `height`          | 像素宽高                                                                       |
|             | `maxWidth` / `maxHeight`    | `width` / `height` 的同值别名                                                  |
|             | `frameRate` / `frameCount`  | 帧率 / 总帧数                                                                  |
|             | `bitRate`                   | 比特率                                                                         |
|             | `sampleRateHz` / `channels` | 采样率 / 声道数                                                                |
|             | `estimatedTokenCount`       | 该资源的预估 token 消耗                                                        |
| `request.`  | `totalEstimatedMediaTokens` | 当前调度 pass 中该资源及其派生物的预估 token 总量(按资源逐个计算,非跨资源合计) |
| `session.`  | `contextWindowTokens`       | 模型上下文窗口                                                                 |
|             | `promptTokenCount`          | 当前 prompt 已占 token                                                         |
|             | `reservedOutputTokens`      | 预留输出 token                                                                 |
|             | `availableContextTokens`    | 剩余可用上下文                                                                 |
| `memory.`   | `hasTranscript`             | 该文件 memory 子图中已有转写产物(1/0)                                          |
|             | `hasOcr`                    | 已有 OCR 产物(1/0)                                                             |
|             | `hasCaption` / `hasSummary` | 已有 caption / 汇总产物(1/0)                                                   |
|             | `hasKeyframes` / `hasClip`  | 已有关键帧 / 裁剪片段产物(1/0)                                                 |

`memory.*` 字段回答"这个文件的媒体记忆里**已经处理过什么**"(按产物 role 统计,覆盖派生链——如"抽音轨→转写"的转写产物挂在派生音频版本下,查询视频版本同样可见)。典型用法是 §4.1/4.4 的"memory 中无完整 ASR 结果才转写":`["==", ["field", "memory.hasTranscript"], 0]`。记忆未开启、资源无记忆绑定或存储不可读时,整个命名空间为 `unavailable`(不会静默当假),由 `onConditionUnavailable` 决定行为。

### 三值语义

字段探测不到(图片没有 `durationMs`、探针失败等)时,比较结果是 `unavailable` 而非 `false`。组合器用强 Kleene 逻辑传播:`all` 里只要有确定的假就是假,`any` 里只要有确定的真就是真,否则 `unavailable` 上浮,最终由该策略的 `onConditionUnavailable` 决定跳过(默认)还是执行,运行记录会写明缺失字段。

---

## 策略链:reprocessMedia + origins

`output.reprocessMedia: true` 让派生物带着 `policy` 来源重新进入匹配,由声明了 `origins: ["policy", …]` 的下游策略接力。典型形态(电影音轨三级流水线):

```
extract-audio (origins:[user],  reprocessMedia:true, source:keep)
      └─▶ audio-downsample (origins:[policy], when: >100MB, reprocessMedia:true, source:omit)
                └─▶ transcribe (origins:[policy], when: ≤100MB, source:omit)
```

启动校验会拒绝"惰性 reprocessMedia":某策略声明了 `reprocessMedia`,但同一集合里没有任何策略接受 `policy` 来源——派生物将永远无处可去,这是矛盾配置。

防失控的多重护栏:`maxRunsPerLineage`(单策略单谱系次数)、`limits.maxLineageDepth`(谱系深度)、`limits.maxPolicyRunsPerRoot`(单根总次数)。

---

## policyTools:工具级设置与模型可见性

```json
"policyTools": {
  "omni_transcribe_audio": {
    "settings": { "maxInputBytes": 33554432, "chunkSeconds": 300 },
    "runtime": { "timeoutMs": 1800000 },
    "modelAccess": {
      "enabled": true,
      "defaultArguments": { "chunkSeconds": 180 },
      "lockedArguments": {}
    }
  }
}
```

- **`settings`** —— 该工具的默认可调参数,按工具 `settingsSchema` 校验(如转写的 `maxInputBytes`、关键帧的 `sceneThreshold`)。
- **`runtime.timeoutMs`** —— 单次调用的墙钟超时。必须小于 staging 清扫宽限窗(3600000ms = 1 小时),否则崩溃恢复清扫可能删掉仍在运行的调用的暂存目录,启动时直接报错。
- **`modelAccess`** —— 默认所有策略工具**对模型不可见**,只能由固定策略驱动。逐工具打开:
  - `enabled: true` —— 工具进入模型的工具列表,同时被写进系统提示的媒体引导小节(见"披露与渐进式理解");
  - `defaultArguments` —— 注入每次调用的默认参数,模型可覆盖;
  - `lockedArguments` —— 锁定参数:从模型可见 schema 中剥除,模型执意传入会被硬性拒绝(可重试错误),执行时由 harness 注入。同一键出现在 defaults 和 locked 中是矛盾配置;
  - `parameterSchema` —— 可选的可见 schema 投影,只允许收窄原生 schema,不能引入新属性。
  - 运维专用参数(`baseUrl`、`apiKeyEnv` 等)永远不会出现在模型可见 schema 中。

---

## 策略工具一览

十四个内置媒体策略工具(前八个基于 ffmpeg/sharp,后六个含模型调用),产物均携带强制披露:

| 工具                             | 输入 → 输出              | 关键参数(默认)                                                                                                                        | 典型用途                                                                                                                                                           |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omni_downsample_image`          | image → JPEG             | `maxDimension` 1568、`quality` 75、`tokenBudget`(256/1024/2048 tokens 档位,吸附 28px patch 网格)                                      | 超大截图降采样;`tokenBudget` 直接按计费 token 说话                                                                                                                 |
| `omni_convert_image`             | image → JPEG/PNG/WebP    | `format` "jpeg"、`quality` 90                                                                                                         | 冷门格式转通用格式                                                                                                                                                 |
| `omni_clip_image`                | image → PNG 区域         | `x`/`y`/`width`/`height`(像素,必填)                                                                                                   | 裁剪指定矩形区域(policy 形态,区别于模型直调的 `zoom_image`)                                                                                                        |
| `omni_caption_image`             | image → 文本描述         | `prompt`(默认整体描述);运维专用:`model`、`baseUrl`、`apiKeyEnv`                                                                       | VL 模型把视觉内容转成文本进上下文(role: caption)                                                                                                                   |
| `omni_ocr_image`                 | image → 文本             | `language`(默认自动)、`prompt`(默认提取全部可见文字);运维专用:`model` 等                                                              | OCR 提取图片文字(role: ocr),解锁"文档/文字图片 OCR"固定策略                                                                                                        |
| `omni_downscale_video`           | video → MP4              | `maxHeight` 480、`fps` 10、`crf` 28                                                                                                   | 分辨率/帧率双降                                                                                                                                                    |
| `omni_clip_video`                | video → MP4 片段         | `startSec` 0、`durationSec`(默认到结尾)、`crf` 23                                                                                     | 截取时间区间                                                                                                                                                       |
| `omni_extract_keyframes`         | video → 多张 JPEG        | `maxFrames` 8、`sceneThreshold` 0.2、`maxDimension` 768、`strategy` "scene"/"uniform"、"fps"、"startSec"/`endSec`、`frameTokenBudget` | **全片分桶采样**(默认);`uniform` 为时长自适应动态帧率均匀采样(并行 seek 抽帧),长视频自动降采样率                                                                   |
| `omni_understand_video_segments` | video → 文本理解         | `segmentSeconds` 30(5–60)、`maxParallelSegments` 8、`maxSegmentBytes` 10MiB、`prompt`;运维专用:`model` 等                             | **长视频分段并行理解**:固定时长切片重编码(≤10MB)→ 并行 Omni 逐段 caption → 汇总 `[MM:SS-MM:SS]` 文本(role: summary)                                                |
| `omni_extract_audio`             | video → WAV/MP3/M4A      | `format` "wav"、`sampleRateHz` 16000、`channels` 1                                                                                    | 抽出音轨供转写                                                                                                                                                     |
| `omni_downsample_audio`          | audio → M4A              | `bitrateKbps` 64、`sampleRateHz` 16000、`channels` 1                                                                                  | 压音频体积                                                                                                                                                         |
| `omni_clip_audio`                | audio → WAV/MP3/M4A 片段 | `startMs`、`durationMs`(≥1000,默认到结尾)、`format` "m4a"                                                                             | 音频时间裁剪,与视频裁剪对称                                                                                                                                        |
| `omni_transcribe_audio`          | audio → 文本转写         | `chunkSeconds` 180、`maxInputBytes` 10MiB;运维专用:`model`、`baseUrl`、`apiKeyEnv`                                                    | **长音频分段转写**:超过 `chunkSeconds` 自动切段(并发 3、共享时间预算),按 `[MM:SS-MM:SS]`/`[H:MM:SS-…]` 拼装;单段失败内联标注不整体失败;自动检测并截断 ASR 重复退化 |
| `omni_caption_audio`             | audio → 文本描述         | `prompt`(默认语义描述)、`chunkSeconds` 180;运维专用:`model` 等                                                                        | Omni 模型理解音频:语音大意、音色、事件、情绪(非逐字转写;长音频同样分段)(role: caption)                                                                             |

多产物工具(关键帧)在一次调用事务里逐帧提升为独立产物;转写/caption/OCR/汇总产物走文本通道(`【媒体转写】` 形态)而非媒体通道,memory role 分别为 `transcript`/`caption`/`ocr`/`summary`。

模型直接调用这些工具时,成功结果会列出每个产物的绝对路径,模型可立即用 `read_file` 读取剪辑、音频、关键帧或转写结果。

---

## transportGuard:传输守卫

预处理是纯实验语义,守卫是**强制安全网**:当最终投递集仍超出传输限制(如 DashScope 单文件 100MB/1GiB 上限)时,守卫策略对超限媒体执行降质重试,并在披露中标注 `(服务端输入超限,第 N 次降质重试)`,最多 `limits.maxTransportPasses` 轮;仍不达标则以 `【媒体省略】` 通知替代媒体本身。

系统默认三条守卫(可整条覆盖、**不可删除**):

```json
"transportGuard": {
  "policies": {
    "image-downsample": { "mediaTypes": ["image"], "toolName": "omni_downsample_image" },
    "video-downscale":  { "mediaTypes": ["video"], "toolName": "omni_downscale_video" },
    "audio-downsample": { "mediaTypes": ["audio"], "toolName": "omni_downsample_audio" }
  }
}
```

守卫策略的三条特殊约束(启动校验强制):合并后的守卫集必须覆盖 image/video/audio 三模态;不得声明 `when`(触发时机就是"超限"本身);`output.source` 必须为 `"omit"`(超限源不能留在投递集里)。

---

## limits:派生预算

| 键                       | 默认  | 说明                                      |
| ------------------------ | ----- | ----------------------------------------- |
| `maxConcurrentResources` | 1     | 并发处理的根资源数                        |
| `reservedOutputTokens`   | 8192  | 为模型输出预留的 token(唯一允许为 0 的键) |
| `maxLineageDepth`        | 8     | 策略链最大深度                            |
| `maxPolicyRunsPerRoot`   | 64    | 单根资源的策略执行总次数上限              |
| `maxArtifactsPerRoot`    | 256   | 单根资源的产物总数上限                    |
| `maxDerivedBytesPerRoot` | 1 GiB | 单根资源派生字节预算(电影场景建议调大)    |
| `maxTransportPasses`     | 3     | 传输守卫降质重试轮数                      |

已提交的投递不受预算追溯影响;预算耗尽只阻止新的派生。

---

## 披露与渐进式理解

投递给模型的每个降质产物都紧邻一条披露文本,三种标记:

- `【媒体降质】<文件>:原 … → …,<丢失说明>` —— 有损派生物(截取、降采样、抽帧、降码率);
- `【媒体转写】<文件>:[时间段] 文本…` —— 以文本替代媒体本体的转写;
- `【媒体省略】<文件>:…` —— 完全无法投递时的占位通知。

同时,系统提示会注入 **Media Delivery (Progressive Understanding)** 小节,向模型说明:降质投递是"概览而非全部内容"、禁止在未获取证据的时间段上外推结论,并列出恰好那些 `modelAccess.enabled` 的工具,引导模型在需要更高保真证据时**主动调用工具取证**(裁剪某个片段、对某区间重新抽帧、转写某段音频)。没有任何工具开放时,该小节改为要求模型明确说明证据缺口。

## 缓存与存储

- **内容寻址库** `.qwen/omni/objects/sha256/<xx>/<hash>.<ext>` —— 所有派生产物按内容哈希入库,同输入同策略永不重复派生(降质缓存键 = 源哈希 + 策略身份);
- **上传缓存** —— DashScope 临时上传的 `oss://` URL 按文件哈希、上传模型、上传 endpoint/key 隔离,并在 `urlTtlHours`(≤ 48h)内复用;只修改推理地址不会导致重复上传;
- **隔离区** `quarantine/<invocationId>/` —— 失败派生的暂存残留连同 `reason.json` 移入隔离区,按保留天数和体积预算惰性清扫;崩溃留下的未提交 staging 超过 1 小时宽限窗后被回收。

---

## 完整案例:81 分钟电影拉片

目标:给 Qwen Code 一部 1080p 电影(《Breaking Surface》2020,81 分钟,986MB MKV)和一句"制作拉片网页"的 prompt,让模型在**从未看过全片**的情况下产出覆盖全片的交互式分析页面。

### 策略设计

一部电影拆成三路证据,全部在预处理阶段自动完成:

1. **听觉全覆盖** —— 抽音轨 → 体积超 100MB 就先压码率 → 分段转写成带时间戳的全文台词;
2. **视觉全覆盖(稀疏)** —— 16 张关键帧按全片分桶采样,每帧披露带绝对时间戳;
3. **视觉细节(稠密,仅开头)** —— 截取前 10 分钟片段,给模型一段"高保真样本"感受影片质感。

### 工作区 `.qwen/settings.json`

```json
{
  "omni": {
    "enabled": true,
    "processing": {
      "fixedPolicies": {
        "movie-extract-audio": {
          "priority": 100,
          "mediaTypes": ["video"],
          "origins": ["user"],
          "toolName": "omni_extract_audio",
          "arguments": {
            "format": "wav",
            "sampleRateHz": 16000,
            "channels": 1
          },
          "output": { "reprocessMedia": true, "source": "keep" }
        },
        "movie-audio-downsample": {
          "priority": 90,
          "mediaTypes": ["audio"],
          "origins": ["policy"],
          "when": [">", ["field", "resource.sizeBytes"], 104857600],
          "toolName": "omni_downsample_audio",
          "arguments": {
            "bitrateKbps": 24,
            "sampleRateHz": 16000,
            "channels": 1
          },
          "output": { "reprocessMedia": true, "source": "omit" }
        },
        "movie-transcribe": {
          "priority": 80,
          "mediaTypes": ["audio"],
          "origins": ["policy"],
          "when": ["<=", ["field", "resource.sizeBytes"], 104857600],
          "toolName": "omni_transcribe_audio",
          "output": { "source": "omit" }
        },
        "movie-clip-opening": {
          "priority": 70,
          "mediaTypes": ["video"],
          "origins": ["user"],
          "when": [">", ["field", "resource.durationMs"], 1200000],
          "toolName": "omni_clip_video",
          "arguments": { "startSec": 0, "durationSec": 600 },
          "output": { "source": "omit" }
        },
        "movie-keyframes": {
          "priority": 60,
          "mediaTypes": ["video"],
          "origins": ["user"],
          "toolName": "omni_extract_keyframes",
          "arguments": { "maxFrames": 16, "maxDimension": 960 },
          "output": { "source": "keep" }
        }
      },
      "policyTools": {
        "omni_extract_audio": {
          "modelAccess": { "enabled": true },
          "runtime": { "timeoutMs": 1800000 }
        },
        "omni_downsample_audio": { "runtime": { "timeoutMs": 1800000 } },
        "omni_transcribe_audio": {
          "settings": { "maxInputBytes": 33554432 },
          "modelAccess": { "enabled": true },
          "runtime": { "timeoutMs": 1800000 }
        },
        "omni_clip_video": {
          "modelAccess": { "enabled": true },
          "runtime": { "timeoutMs": 1800000 }
        },
        "omni_extract_keyframes": {
          "modelAccess": { "enabled": true },
          "runtime": { "timeoutMs": 1800000 }
        },
        "omni_downscale_video": {
          "modelAccess": { "enabled": true },
          "runtime": { "timeoutMs": 1800000 }
        }
      },
      "limits": { "maxDerivedBytesPerRoot": 4294967296 }
    }
  }
}
```

配置要点逐条对应前文机制:

- **优先级排布**(100→60)保证抽音轨先于抽帧,音频链按"抽出→压缩→转写"接力;
- **策略链**:`movie-extract-audio` 的 WAV 音轨(约 150MB)带 `policy` 来源重新匹配——超 100MB 命中 `movie-audio-downsample` 压成 24kbps M4A(约 14MB),再次匹配命中 `movie-transcribe`;
- **`source` 取舍**:音轨和中间产物全部 `omit`(模型不需要听原始音频),关键帧 `keep` 源视频让开头片段与关键帧共存;
- **`when` 双向分流**:`>100MB` 与 `≤100MB` 互斥,压缩前后各走一条路,不会重复转写;
- **`modelAccess` 全开 + 引导小节**:模型可以对任意区间自行 clip/keyframes/transcribe 补证据;
- **预算调大**:986MB 源片的派生总量(WAV 音轨 + 片段 + 帧)远超默认 1GiB,`maxDerivedBytesPerRoot` 提到 4GiB;
- **转写 `maxInputBytes` 提到 32MiB**:容纳压缩后 14MB 的 M4A。

### 运行

```bash
qwen "请对 @tt10081762_1080p.mkv 做一次完整拉片,产出 lapian.html:电影简介、海报、主角剪影 SVG、可交互时间轴、关键事件列表及截图……" \
  --approval-mode yolo
```

### 实测结果(qwen3.5-omni-plus,真实 DashScope API)

预处理阶段(首轮几分钟,之后全部缓存命中秒回):

- 音频链:4882s 视频 → WAV → 24kbps M4A → **28 段转写、17725 字、0 段失败**,时间戳从 `[0:00:00-0:02:54]` 连续覆盖到 `[1:18:28-1:21:22]`;
- 16 张关键帧时间戳 `@ 152.6s → @ 4729.5s`,均匀铺满全片;
- 开头 600s 片段一段。

首个模型请求实际送达:1 段视频 + 16 张图 + 19 条披露 + 内联全文转写,披露样例:

```
【媒体降质】tt10081762_1080p.mkv:原 4882s → 片段 [0s–600s] 600s,片段外内容全部丢弃
【媒体降质】tt10081762_1080p.mkv:原视频 4882s/1920×808 → 关键帧 7/16 @ 1830.8s,静态抽帧(全片分桶采样),时间连续性丢失
【媒体降质】tt10081762_1080p.mkv:原 4882s 音频 → 分 28 段转写文本 17725 字,语气/音色/非语音信息丢失,识别可能有误
【媒体转写】tt10081762_1080p.mkv:[0:00:00-0:02:54] Nej! Kom hit! …
```

传输守卫也被真实触发:600s 片段(128.8MB)遭服务端拒收后自动两级降质重试(`480p/24.1MB → 360p/13MB`),披露追加 `(服务端输入超限,第 N 次降质重试)`。

模型侧行为印证了渐进式理解引导:基于转写和关键帧建立全片骨架后,模型**主动发起了 18 次媒体工具调用**(7 次 clip、5 次 extract_audio、4 次 keyframes、2 次 transcribe,零错误)对关键场景补充取证,最终产出的 `lapian.html` 时间轴覆盖 `00:00 → 81:22` 全片。

### 已知边界

- 大体量投递对上传通道和 API 速率敏感:上传超时会以 `【媒体省略】`/失败通知降级(模型可靠工具自救),连续多个大请求可能触发 DashScope 速率保护——重试即可,预处理与上传缓存保证重跑近乎零成本;
- 转写基于 ASR,专有名词与多语言混杂段落可能有误,披露文本已固定声明"识别可能有误";
- 关键帧是稀疏采样,单帧之间的动态信息永久丢失——这正是给模型开放 `omni_clip_video` 的意义。
