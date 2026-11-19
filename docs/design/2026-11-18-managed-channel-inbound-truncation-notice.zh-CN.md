# 托管渠道入站截断提示语

- **状态：** 提议中
- **日期：** 2026-11-18
- **范围：** `packages/channels/base`、`packages/channels/{wecom,dingtalk,github,email}`
- **相关：** PR #17441 评审发现 R1-20（刻意延后的跨提供方后续）；[英文版](2026-11-18-managed-channel-inbound-truncation-notice.md)

## 问题

托管适配器对超长入站消息做钳制，使其按截断准入，而不是撞上确定性服务端拒绝被
整条丢弃。钳制（`fitInboundText`）截成**纯前缀，没有省略标记**。一条关键约束落在
切点之后的消息——开头描述重构、末尾写「只改 `src/`，不要跑迁移」——会按其前缀
准入，于是智能体执行了尾部明确禁止的另一半。智能体与运维都无法得知输入被截断。
字节路径下 CJK 消息被拦腰截断也是同样情况。

运行时其他所有截断都会自我标注：出站回复钳制追加 `CHANNEL_TRUNCATION_NOTICE`，
compaction 追加 `SLIM_TEXT_TRUNCATION_MARKER`。入站钳制是唯一不自我标注的截断。

## 现状

`fitInboundText` 在四个托管适配器中重复：

- `wecom`、`dingtalk`、`github` 携带**逐字相同**的副本：切到
  `MAX_WIRE_TEXT_CHARS`（32,000 UTF-16 单元）并回退尾部高代理，然后若 JSON 转义
  长度超过 `ENVELOPE_BYTE_LIMIT − TEXT_ENVELOPE_OVERHEAD_BYTES`（64 KiB − 4 KiB），
  按码点二分搜索最大可容纳前缀。常量本地镜像，以使 channel 包不 import `core`。
- `email` 携带**变体**：`boundedText(text, min(maxTextLength,
MAX_WIRE_TEXT_CHARS))` 后按原始 UTF-8 字节做码点切（非 JSON 转义）。

钳制是本地副本出于早先的刻意决策：提升到 `channel-base`「会触碰已发布包与
DingTalk 适配器，却没有行为收益」。加入自我标注的提示语**正是**行为收益，而共享
实现正是让标记在各提供方间保持一致、而非让某个适配器单独领先的关键。

`CHANNEL_TRUNCATION_NOTICE` 位于 `core`（`managed-channel-operations.ts`）；
`channel-base` 不 import `core`（依赖方向是 `core → channel-base`），且出站提示语
措辞（"Reply truncated … segment size limit"）是回复专用的。因此入站钳制需要在
`channel-base` 中有自己的提示语常量，而非复用出站那个。

## 提议改动

### `channel-base` 中的共享 helper 与提示语

在 `packages/channels/base/src/managed-channel.ts`（现有共享托管渠道常量旁）加入：

- `CHANNEL_INBOUND_TRUNCATION_NOTICE` —— 入站专用提示语：
  `"\n\n[Message truncated because it exceeded the channel input size limit.]"`。
- `fitInboundText(text)` —— 当前在 `wecom`/`dingtalk`/`github` 重复的 JSON 转义
  钳制，逐字移入此处并扩展为：在钳制实际缩短文本时预留提示语空间并追加。

常量 `MAX_WIRE_TEXT_CHARS`、`ENVELOPE_BYTE_LIMIT`、
`TEXT_ENVELOPE_OVERHEAD_BYTES` 移入 helper 所在模块（它们是 helper 强制的线上与
信封上限）；适配器不再镜像它们。

### 预留提示语的算法

提示语必须容纳在**两个**服务端上限内，故在切核心前从预算中扣除其字符数与转义
字节数：

1. 若整段文本在两个上限内原样容纳（长度 ≤ 字符上限且 JSON 转义长度 ≤ 字节预算，
   无需代理回退），原样返回——**未截断则无提示语**。
2. 否则从字符上限预留 `notice.length` 个 UTF-16 单元、从字节预算预留提示语的
   JSON 转义字节长度；把核心切到缩减后的字符上限（同样回退尾部高代理），若仍超
   缩减后的字节预算则按码点二分搜索最大可容纳核心；追加提示语。

结果以提示语结尾且仍满足两个服务端上限。提示语除前导换行外为 ASCII，其转义长度
用钳制已有的同一个 `encodedBytes` 函数计算——无需单独的原始字节核算。

### 适配器迁移

- `wecom`、`dingtalk`、`github`：从 `@qwen-code/channel-base` import
  `fitInboundText`（测试也 import 提示语）；删除本地副本与镜像常量。行为除「被缩短
  的帧现在以提示语结尾」外完全一致。
- `email` **不在本次范围**（见范围边界）：其 `boundedText` helper 把尺寸钳制与
  引用回复/签名剥离混在一起，故在那里加提示语需要区分两者的独立设计。

### 测试

- 新增 `channel-base` 同位套件钉住 helper：容纳帧无提示语；字符上限切、CJK 字节
  切、astral 半对切、转义密集切均追加提示语；带标记结果满足两个上限；核心最大
  （再多一个码点即超缩减预算）；移除提示语预留即红上限断言。
- `wecom`/`dingtalk`/`github` 既有钳制测试加断言：被缩短帧的提交文本**以提示语
  结尾**，并按提示语预留重算精确前缀期望（核心现在短了提示语的预算）。移除提示语
  即红「以提示语结尾」断言，而重算后的精确长度断言保持绿。容纳帧仍原样提交（无
  提示语）。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts` —— 加提示语常量与共享
  `fitInboundText`；导出两者。
- `packages/channels/base/src/managed-channel.test.ts`（新增或扩展）—— helper 见证。
- `packages/channels/wecom/src/managed-wecom-adapter.ts`（+ 测试）—— import helper、
  删本地副本/常量、更新钳制测试。
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts`（+ 测试）—— 同上。
- `packages/channels/github/src/managed-github-adapter.ts`（+ 测试）—— 同上。
- 本设计文档及其中文版。

## 范围边界

- GitHub **subject** 钳制（`fitSubject`，200 单位上限）不变：它是独立字段上限，
  非 R1-20 所指的入站文本钳制。
- 出站提示语（`CHANNEL_TRUNCATION_NOTICE`、`CHANNEL_CAPACITY_NOTICE`）与
  `truncateChannelTextUtf8` 不变。
- **email** 钳制本次不变。其 `boundedText` helper 除切到字符上限外，还剥离引用
  回复与签名（`>`、"On … wrote:"、`-- `、"Original Message"）并规范化换行，把内容
  处理与尺寸钳制混在一起。在那里追加截断提示语需要区分尺寸切与引用剥离——独立
  设计，延后。本次迁移的三个适配器共享逐字相同的纯尺寸 JSON 转义钳制。
- 无控制面（Java）改动：提示语在既有 text 字段内、既有上限内传输。
- 钳制预算本身不变（32,000 单元 / 64 KiB − 4 KiB）；提示语在其内预留。

## 开放问题

- 提示语确切措辞：定为上述入站专用句；它平行于出站提示语的形状，但不声称是回复。
