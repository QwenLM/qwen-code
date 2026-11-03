# 压缩会话回放的实时工具结果显示

[English](compact-live-tool-result-replay.md) | [简体中文](compact-live-tool-result-replay.zh-CN.md)

状态：已实现（对应 issue #16171 的 PR）

## 问题

在 Web Shell 里打开某个会话可能要几十秒，而其他会话秒开。`POST /session/:id/load`
响应内嵌 daemon 的回放快照；事故会话上实测为 **39.6 MB**，尽管磁盘 transcript 只有
4.3 MB。

膨胀集中在 `liveJournal`：一个后台子代理编辑了一个约 870 KB 的文件 9 次，每个编辑结果
事件都携带完整的新旧文件内容各一份——diff content 的 `oldText`/`newText` 一份，
`rawOutput` 又一份——单事件约 3.6 MB，9 个事件共 27.5 MB。journal 的默认上限
（8 MiB / 10,000 事件）被突破后，自适应增长不断翻倍上限，每次打开都要重新下载、解析
并重放整个快照。

## 现状

- 录制路径（`packages/core/src/services/chatRecordingService.ts` 的
  `sanitizeToolCallResultForRecording`）在落盘前已经截断文件 diff 显示：每个内容字段
  16,000 字符、diff 本身 50,000、合计 100,000。这正是 transcript 保持很小的原因。
- 交互式 TUI 的历史显示通过 `compactToolResultDisplayForHistory`
  （`packages/core/src/utils/toolResultDisplayCompaction.ts`）压缩显示，在
  `coreToolScheduler` 里以 `config.isInteractive()` 为闸门。
- ACP 实时工具结果路径两者都不做：`ToolCallEmitter.emitResult` 把原始
  `resultDisplay` 交给 `createTranscriptToolCallResultUpdate`
  （`packages/acp-bridge/src/transcript-replay.ts`），后者把它作为 diff content 和
  `rawOutput` 嵌入 wire update。因此 daemon（非交互）会话的 journal 携带完整文件
  内容，热回放与冷回放也不一致——冷回放从已净化的 transcript 重建，本来就显示截断
  预览。

## 目标

- 让工具结果的单事件回放 payload 有界，与所编辑文件的大小无关。
- 让热回放（live journal / compacted replay）显示与重启后冷回放一致的显示。
- 小 diff 保持逐字节不变。

## 非目标

- permission_request 的 payload 保留完整 diff：审批界面需要完整变更，且它是一次性
  交互，不是这里观察到的持续 journal 压力。
- 不新增配置开关；复用已有的录制限额。
- 工具调用开始的 `rawInput`（模型提供的参数）不变。

## 方案

在 `createTranscriptToolCallResultUpdate` 内部压缩显示——这是 `resultDisplay` 变成
wire content 与 `rawOutput` 的唯一咽喉点——使用已有的
`compactToolResultDisplayForRecording` 工具：

- 文件 diff：内容字段按 `MAX_RETAINED_FILE_CONTENT_CHARS`（16,000）封顶，diff 按
  `MAX_RETAINED_FILE_DIFF_CHARS`（50,000）封顶；超限显示降级为冷回放已经在渲染的
  同一段文本预览，`rawOutput` 收缩为 `{ fileName, fileDiff }`（diff 本身超限时直接
  丢弃）——完全沿用已有的截断显示处理逻辑。
- 其他显示类型（shell、ANSI、agent、todo、plan、findings、MCP app 等）套用与录制
  路径相同的逐字段限额。
- 该调用是幂等的：冷回放把已净化的显示再次传入同一个构建器，限额内的字段原样通过。

由于 transcript 记录可能携带比实时生产者更精简的显示（blocked spawn 没有 task
prompt；旧版本录制的字段更少），压缩工具被加固为全函数：非字符串字段原样通过，列表
用 `Array.isArray` 守卫，列表元素在展开前先守卫。任何输入都不得抛异常。

## 设计决策

1. **在 wire 构建器处压缩，而不是在发射器或 journal 处。** 构建器一处覆盖所有调用方
   （实时执行、子代理跟踪、重复调用、历史回放），而且截断显示的处理
   （`extractDiffContent`、`getReplayRawOutput`）本来就在这里。只在 journal 压缩会
   留下 SSE 广播与热 compacted replay 仍然无界，还会在 acp-bridge 里重复一套截断
   规则。
2. **复用 recording 用途的工具，而不是新设限额。** 热回放因此与录制落盘的内容一致，
   限额也只有一套。该工具模块是 Node-free 的（唯一的运行时导入是纯函数
   `shell-result` helper），保持了 `transcript-replay.ts` 的浏览器回放 bundle 约束。
3. **加固工具本身，而不是在调用点兜底。** try/catch 兜底会让畸形显示静默保留超大
   payload；工具的其他分支本来就是防御式的，把带标签的显示分支统一到同一契约。

## 约束与风险

- 大文件编辑的实时观看者现在看到的是截断预览而非完整 diff。这与冷回放和 TUI 历史
  已经显示的完全一致；完整变更仍可从文件本身与 file history 获得。小 diff（常见
  情形）不受影响。
- 旧 daemon 已经记入 journal 的超大事件会保留到 turn 边界把它们折进有上限的
  compacted replay 为止；修复作用于升级后发出的事件。
- 压缩工具与录制、TUI 历史路径共享；加固只是为此前会抛异常的输入增加原样通过，
  良构显示的压缩行为与之前完全一致（由现有 50 个测试的套件覆盖）。

## 验证

- 单测：`packages/acp-bridge/src/transcript-replay.test.ts` —— 大编辑有界（序列化
  <10 KB）、小 diff 不变、已净化显示与冷回放等价、超大 diff 丢弃 `rawOutput`、
  非 diff 显示有界。
- 单测：`packages/core/src/utils/toolResultDisplayCompaction.test.ts` ——
  不完整/畸形显示永不抛异常；存在的字段仍被压缩。
- 探针（构建产物，无需模型）：9 次约 870 KB 文件的编辑加流式 chunk，经过带 daemon
  式自适应增长的 `TurnBoundaryCompactionEngine` —— 回放快照
  **31,746,417 字节 → 65,562 字节（约 484 倍）**；修复臂从不突破默认 8 MiB journal
  上限。
- 真实 daemon A/B（分支 dist 对已发布 0.26.5，隔离 daemon，真实模型 turn 编辑约
  870 KB 文件，2026-11-03）：turn 运行中会话打开峰值
  **61,955,300 → 185,373 字节**；浏览器级 `/load`
  **72,830,493 字节 / 1,474 ms → 217,480 字节 / 99 ms**；首个工具卡片渲染
  **2,931 → 821 ms**。重启 daemon 后，18 个热回放与 18 个冷回放编辑结果事件在
  content、rawOutput、status 上完全一致；每臂 4 轮 turn 零错误。
- 套件：acp-bridge 2,866 通过；core 压缩 58 通过；core chatRecordingService 187
  通过；cli tool-call-emitter 72 通过。
- 浏览器回放 bundle：`packages/web-templates/src/export-html/build.mjs` 退出码
  0，无禁止输入。文档 renderer 在改动前后逐字节一致（1,978,365 字节，硬上限
  2,053,000）：`transcript-replay` 从文档入口不可达，新导入不会给它增加任何字节。
  对确实导入该模块的浏览器消费者（如 SDK 的 `chat-record-transcript`），
  Node-free 约束依然成立。1,970,000 字节的警告阈值在基线树上已被超过。

## 验收标准

- 大文件编辑结果 update 的序列化 payload 有界，与文件大小无关，diff content 与
  `rawOutput` 两侧都是。
- 同一次编辑的热回放与冷回放渲染一致的显示。
- 压缩对任何 transcript 形态的显示都不抛异常。
- 已有的小 diff 与录制行为不变。
