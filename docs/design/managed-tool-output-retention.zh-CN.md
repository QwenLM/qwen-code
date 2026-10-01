# 以 Session 为根的工具输出保留（O4）

[English](managed-tool-output-retention.md) | [简体中文](managed-tool-output-retention.zh-CN.md)

## 问题与基线

O2 将前台 Shell 的 stdout/stderr、manifest、pages 和原始 outcome 保存到 SQL 与私有 OSS；O3 将其投影为公共 Tool Result 和 Artifact。当前两者尚未证明读写停止后才能删除字节。实现基于 main `93efe3558`，包含已合入的 O3 `6310dd38d` 及 publication 恢复修复。退役保护使用 V27 迁移，接在已有 V26 投影迁移之后。

## 契约与范围

Session 是保留根。close、archive、Runtime 排空、ACK 和事件过期后仍保留输出。删除完成永久退役私有 journal 及恢复引用；原 operation、退役 generation 和时间不能重置。再等待 24 小时，且独立证明读写闭合，才可回收。回收的是原始 payload，历史中已有的模型消息和公共预览不在此擦除范围。

只覆盖前台 Shell O2 publication。后台流、MCP、媒体 adapter、共享输出和通用历史清理另行交付。未完成、blocked、隔离输出、未完成 operation、恢复保护和缺少写入证据的历史数据保持占额。过期前驱通过已有 O2 显式恢复路径推进；退役不会将未完成操作标为成功。

## 保护与退役

新增独立生命周期 `PINNED → RETIRING → DELETING → COLLECTED`，不改写 execution、capture、delivery 和 producer phase。删除按 tenant → 私有 journal head → publication → 公共 Session 加锁，在同一事务复核 writer 并完成公共删除；即使从未建立私有 head，也保留永久 Session 墓碑。拒绝新 acquisition、恢复、publication 修改和投影。回填跳过退役 head，待处理投影被抑制。

数据库读租约覆盖整个 Session 输出闭包，包括元数据解析。固定两分钟预算不能续期；每次读取和返回字节前检查数据库时间、租约身份和退役 generation。公共下载继续保留 O3 授权与总预算检查。私有资源及 projector 扫描使用相同保护。过期进程恢复后不能继续输出。

每次物理 PUT 在网络请求之前独立持久登记 attempt。确定成功只闭合该 attempt；异常或进程死亡保留 unknown/outstanding，直到外部处置前阻止自动清理。后续重试成功不能闭合前驱。禁用 OSS SDK 隐式重试，现有显式重试创建新 attempt。纯 inline publication 也有新协议证据，历史行默认缺失证据。

## 清理与配额

默认关闭自动删除，先观察候选。持锁重新检查候选：Session 永久退役、宽限期到期、完整 committed 且已接纳的 publication、无活跃读租约、无未结束或未知 PUT、无 candidate 对象、未完成 operation、隔离或恢复保护，并具备升级后的写入证据。持久 claim generation 和游标支持重启及多实例竞争；每实例仅一个调度清理器。

SQL 标记 `DELETING` 后，在事务外每页最多删除 100 个 catalog 精确 key，再在原 claim 下确认。幂等 `deleteIfPresent` 处理不存在对象和应答丢失；异常保留待重试页，不按前缀扫删。旧清理器不能推进新 claim 或释放配额。退役和 `DELETING` 关闭接纳，阻止新读者和 PUT 重新创建已删对象。

最后一页确认后，SQL 清除 publication inline 副本及对应 Session resource 副本，保留身份、digest、长度、receipt 指针和审计时间，置为 `COLLECTED`，一次性清零 held/used 记账。部分成功仍保留全部占额。原 journal 及公共预览/历史遵循各自已有保留策略。

## 配置与上线

只新增 `qwen.managed-agent.tool-publication.gc-enabled`（默认 false）及 `deletion-grace`（默认 24h）。启用 publication 后进行候选观察。启用 GC 前升级全部 Java writer；迁移将历史证据默认为 false。落地前按最新 main 重编号前向迁移。O4-3 的数据库、进程故障、隔离 OSS 和大闭包门禁全部通过后才允许部署启用 GC。

## 涉及层与交付

O4-1 在 Session/publication store、生命周期完成及 projector/Artifact 读取中加入退役、租约、物理 PUT 证据及候选观察。O4-2 加入对象删除、claim/游标清理及配额回收。O4-3 加入故障与部署验证及运维说明。不增加公共接口、Web Shell 流程、活跃 Session TTL 或新的公开 410。私有退役输出明确报错，不重跑工具。

## 验收与待补部署证据

测试 seal/close/archive 后保留；删除与 acquisition/receipt/projection/download 竞争；租约到期与 generation 不匹配；重试后未知旧 PUT；删除应答丢失；分页中途/进程崩溃；SQL 确认失败和双 worker 接管；保守占额；partial/隔离/历史证据保护。必须用真实 MySQL/MariaDB 提供锁竞争证据。真实 OSS 使用完全隔离的测试桶和前缀。验证 100 MiB/1 GiB 闭包记账及分页边界。报告记录准确 revision、运行时、数据库及存储 profile，区分已执行与不可用门禁。O2/O3 合并基线已对齐；可选部署门禁仍依赖隔离 OSS 凭证。
