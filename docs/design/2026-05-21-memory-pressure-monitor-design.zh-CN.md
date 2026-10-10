---
title: '内存压力监控器'
date: '2026-05-21'
status: 'implemented'
---

# 内存压力监控器

[English](2026-05-21-memory-pressure-monitor-design.md) | [简体中文](2026-05-21-memory-pressure-monitor-design.zh-CN.md)

## 问题

长时间运行的 Qwen Code 会话会通过大型工具结果、重复的文件读取、聊天历史和原生／外部分配不断累积内存。在此改动之前，core 包已有诊断能力和会话重置清理，但在正常工具执行过程中内存压力升高时没有任何运行时响应。

缓存层面价值最高的缺口是 `FileReadCache`：它已有有界的 FIFO 容量，但没有基于时间的淘汰路径。这意味着即使进程正处于内存压力之下，会话仍会保留已不再活跃的文件读取元数据，直到触达硬的条目上限。

## 目标

- 在工具执行之后增加一个低开销的内存压力检查。
- 优先做外科手术式的清理，再考虑破坏性清理。
- 在 cgroup v2 或 cgroup v1 内存上限文件可用时，尊重容器内存上限。
- 在内存充足的宿主机上，于 JavaScript 堆 OOM 之前就对 V8 堆压力做出反应。
- 让子 agent／作用域内的 `Config` 实例与父会话清理保持隔离。
- 通过环境变量让行为可配置，而不新增面向用户的设置入口。

## 非目标

- 不新增后台轮询循环。
- 不在 `critical` 级别之外请求显式 GC。只有在 Node 以 `--expose-gc` 启动时 `global.gc()` 才存在；没有它时该步骤只记录日志、不做任何事，`QWEN_MEMORY_ENABLE_GC=0` 可将它关闭。
- 不改变先前读取（prior-read）的强制语义。缓存淘汰可以移除旧元数据，但不得削弱对保留条目的陈旧文件检查。

## 设计

`Config.initialize()` 为每个完成初始化的 `Config` 创建一个 `MemoryPressureMonitor`。`getMemoryPressureMonitor()` 沿用既有的 `getFileReadCache()` 的 `Object.create` 隔离模式：当子 config 通过原型委托创建时，该 getter 会惰性地安装一个绑定到该子 config 的自身监控器。

`CoreToolScheduler.executeSingleToolCall()` 在结束工具 span 后的 `finally` 块中调用 `scheduleCheck()`。`scheduleCheck()` 用 `queueMicrotask` 合并同一事件循环轮次内的多次调用，因此并发的读取类工具批次不会为每个工具结果各跑一次内存检查。

监控器取两个压力信号中更强的那个：

- RSS 除以有效的进程内存上限。优先使用 cgroup v2 的 `/sys/fs/cgroup/memory.max`（当其取值为有限正数时）；否则回退到 cgroup v1 的 `/sys/fs/cgroup/memory/memory.limit_in_bytes`，再回退到 `os.totalmem()`。cgroup v1 表示“无限制”的超大哨兵值会被忽略。
- V8 `heapUsed` 除以 `getHeapStatistics().heap_size_limit`。

同时使用两个信号很重要：容器通常因 RSS 触达 cgroup 上限而死，而本地大内存机器可能在 RSS 仅占系统总内存很小比例时就撞上 V8 堆 OOM。

默认阈值刻意定得足够保守，以便在操作系统或容器的 OOM killer 之前做出反应：

- `softPressureRatio = 0.50`
- `hardPressureRatio = 0.65`
- `criticalRatio = 0.80`
- `cleanupCooldownMs = 5000`
- `enableExplicitGC = true`

`enableExplicitGC` 只有在 Node 暴露 `global.gc` 时才有效。生产入口 scripts/cli-entry.js 出于这一原因会以 `--expose-gc` 重新启动交互式 CLI（其启动快速路径不带该参数），scripts/start.js 和 scripts/dev.js 也会传入该参数，`qwen review` 则会把该参数继续传给它派生的子进程。

环境变量覆盖：

- `QWEN_MEMORY_PRESSURE_SOFT`
- `QWEN_MEMORY_PRESSURE_HARD`
- `QWEN_MEMORY_PRESSURE_CRITICAL`
- `QWEN_MEMORY_ENABLE_GC` — 设为 `0`、`false`、`off` 或 `no` 可关闭显式 GC；其他任何取值（包括 `1`）都保持开启。

合法比例必须满足 `soft < hard < critical`，soft 下界为 `0.3`，critical 上界为 `0.98`。比例类环境变量用 `Number()` 严格解析，因此 `0.8extra` 这类取值会被拒绝，而不会被部分接受。非法的内存压力环境变量配置会丢弃整个覆盖集——三个比例全部回退到 `DEFAULT_PRESSURE_CONFIG`，而不只是出错的那一个——并向 stderr 和 debug 日志写入一条可见的告警。

## 清理策略

压力级别对应逐步加强的清理：

- `soft`（`light`）：淘汰 60 分钟内未被访问的 `FileReadCache` 条目。
- `hard`（`moderate`）：淘汰 30 分钟内未被访问的缓存条目，对旧的工具结果和媒体执行 microcompaction，然后清空文件读取缓存。
- `critical`（`aggressive`）：执行 `hard` 的步骤，并在 `enableExplicitGC` 开启时调用 `global.gc()`。

监控器不触发由模型参与的摘要式压缩。那种压缩会调用模型后端并重写活跃的聊天状态，因此只应由能够与对话循环安全协调的调用点触发。监控器实际执行的 `compact_history` 步骤是无模型调用的确定性 microcompaction，只作用于工具结果和媒体，详见[托管内存 microcompaction 计划](../plans/2026-07-11-managed-memory-microcompaction.md)。

清理由调度器以 fire-and-forget 方式发起，但监控器用 `cleanupInProgress` 和冷却时间戳来约束清理步骤。更高压力的清理可以绕过冷却，排队在正在进行的较低压力清理之后，因此 `soft` 清理尚未结束时不会丢掉一次 `critical` 检查。清理成功后它会在 `setImmediate()` 上记录 RSS 变化量，但 RSS 变动只作诊断之用：即使 JavaScript 对象已可回收，V8 和 libc 也可能保留已释放的页。连续失败统计的是清理步骤抛出的异常，而不是 RSS 未变化，且计数器会在新会话时重置。若连续三次成功的清理释放的 RSS 都不到 1%，监控器会发出 `memory-cleanup-ineffective` 作为诊断信号，而不把清理步骤本身视为失败。

## 测试覆盖

实现由以下测试覆盖：

- 阈值校验测试；
- 环境变量配置解析、回退、可见告警和显式 GC 测试；
- 使用被 mock 的 `process.memoryUsage()` 的压力分级测试；
- cgroup v2 `memory.max` 和 cgroup v1 `memory.limit_in_bytes` 行为；
- V8 堆上限行为；
- `scheduleCheck()` 合并；
- 工具执行后调用 `scheduleCheck()` 的调度器集成；
- soft 与 critical 清理动作；
- 清理步骤抛异常时的失败统计；
- 清理监听器异常隔离与低效清理诊断；
- 通过 `Object.create` 实现的子 `Config` 监控器隔离；
- `FileReadCache.evictNotAccessedSince()` 行为。

## 风险与权衡

- 清理之后 RSS 可能保持不变，因为 V8 或 libc 可能保留已释放的内存。RSS 变化量会被记录，但 RSS 未变化不计为清理失败。
- 基于时间的文件读取缓存淘汰可能降低旧文件的快路径命中率，但它会保留最近活跃的条目，且只在内存压力下运行。
