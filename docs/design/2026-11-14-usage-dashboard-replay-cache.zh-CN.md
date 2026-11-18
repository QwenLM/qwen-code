# 用量面板回放缓存

[English](2026-11-14-usage-dashboard-replay-cache.md) | [简体中文](2026-11-14-usage-dashboard-replay-cache.zh-CN.md)

状态：已实现（PR #17239）。

## 问题

Web Shell 的 Daemon 状态「用量」tab 经 `GET /usage/dashboard` 加载，调用
`loadUsageHistoryWithLive()`。daemon / Web Shell 会话从不写入持久化的
`usage_record.jsonl`（只有 TUI `/clear` 路径会持久化用量），因此面板靠回放会话
transcript 来重建它们。原回放读取尾随 35 天窗口内的每个 transcript，并对每一行做
`JSON.parse`，包括对用量毫无贡献的多 MB `tool_result` 载荷。在较重的历史
（约 3000 个 transcript、约 5.4 GB）上单次加载约 80 秒，且路由 60 秒缓存过期后
每次刷新都要再付一遍。

## 目标

- 让常驻 daemon 上的重复 / 刷新 / 切换周期加载降到亚秒。
- 降低 daemon 重启后的一次性冷加载。
- 保持面板只读：打开它绝不写入 `~/.qwen`。
- 保持聚合数字（总量、按模型占比、热力图、每日图表）与既有去重顺序完全一致。

## 范围边界

- 范围内：`packages/core/src/services/usageHistoryService.ts`（回放 + 缓存）、
  `usage-stats` 路由测试、Web Shell `DaemonStatusDialog` 预取。
- 范围外：会话结束时持久化 daemon 会话用量；daemon 启动时后台预热；改动本地
  `today` 窗口语义。

## 方案

1. **选择性流式扫描。** `summarizeTranscriptFile` 流式读取 transcript，仅对首条记录、
   可能携带 telemetry 的行（`"ui_telemetry"` 是每条此类记录的必要子串）以及小的尾行
   做 `JSON.parse`。跳过大的工具结果载荷。
2. **按 transcript 的回放缓存。** 进程内 `Map` 以 transcript 路径为键存
   `{ mtimeMs, size, summarized }`。每次加载时，`mtimeMs`/`size` 与缓存条目一致的
   候选直接命中缓存；只有变化的文件才重扫。transcript 为追加写，任何增长都会改变
   size 并使条目失效。每次加载整体替换该 Map，剔除老化出窗口或被删除的 transcript。
3. **有界并发。** 冷扫描最多跑 `REBUILD_CONCURRENCY = 8` 个 worker。摘要按路径为键；
   另有一个顺序 pass 按目录顺序对 `sessionId` 去重，因此结果与顺序扫描逐字节同序。
4. **尾行时间戳提取。** 结束时间戳来自尾行记录。小尾行
   （<= `MAX_TRAILING_PARSE_CHARS = 64 * 1024`）会被解析以廉价恢复 `}{` 粘连。更大的
   尾行绝不做 `JSON.parse`；`extractLastTopLevelTimestamp` 用花括号/字符串/转义状态机
   遍历它，只接受最后一个顶层片段深度 1 的 `timestamp`，因此载荷内嵌套的 `timestamp`
   无法劫持记录自身的结束时间。
5. **对话框预取。** `DaemonStatusDialog` 在打开时（daemon 可用且非仅连接模式）发一个
   fire-and-forget 的 `loadUsageDashboard({ range: 'today' })`，使首次点「用量」tab
   就是热的。路由会把它与 tab 自身加载合并；rejection 被吞掉。

## 设计决策与理由

- **进程内缓存，不落盘。** 保持「打开面板绝不写 `~/.qwen`」不变量。daemon 常驻，缓存在
  进程生命周期内是热的；仅在重启后是冷的。
- **仅缓存只读 live merge。** `useCache = !persist`；一次性持久化迁移与删除前抢救始终
  从磁盘重建。
- **读取错误抛出。** 扫描失败（EMFILE/EACCES/EIO/EBUSY）会被抛出，而不是收敛成「无
  telemetry」返回的 `null`，于是 worker 的 catch 跳过写缓存、下次加载重试。合法空结果
  （无 telemetry / 空 transcript）仍缓存。
- **深度感知的尾行时间戳。** 原始首/末匹配不感知结构：载荷里嵌套的 `timestamp` 排在
  记录自身之后会胜出。深度 1 状态机只接受顶层时间戳，且绝不解析大尾行。

## 约束

- 只读：面板路径不写 `~/.qwen`。
- 绝不 `JSON.parse` 大于 64 KiB 的尾行（由用例钉住：最大 `JSON.parse` 入参 < 10 000 字符）。
- 保持去重顺序（目录顺序首现者胜）与持久化优先的冲突解决。

## 风险

- daemon 重启后缓存是冷的；首次加载仍会把窗口扫描一遍（参考历史上约 37 秒，低于约 80 秒）。
- 打开时预取即使操作者从不打开「用量」tab 也会付首次冷回放；它是 fire-and-forget 且被
  合并，之后每次打开都便宜。（作为延后权衡记录。）

## 验证计划

- 单元测试：缓存命中/失效/剔除、选择性扫描、粘连/损坏/大尾行、嵌套载荷时间戳、并发上限、
  读错恢复，以及真实路由回放（多时区，含本地零点后的头几秒）。每个守卫都有变异见证。
- 真实环境 E2E：真实 express 路由 + 真实临时文件系统 + 真实 HTTP；冷/热/增长/只读，以及
  大粘连/嵌套尾行。

## 验收标准

- 热 daemon 上重复 / 刷新 / 切换周期加载为亚秒。
- 在冻结历史上聚合数字与旧全量解析回放逐字节一致。
- 面板路径不写 `~/.qwen`；瞬时读错在下次加载恢复。

## 开放问题

- 是否在会话结束时持久化 daemon 会话用量（消除大部分回放），或在 daemon 启动时预热缓存
  （消除冷首次加载）——两者均超出范围。
