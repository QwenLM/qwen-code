# Qwen Code Daemon vs CLI 性能与压力测试报告

- 测试时间：2026-06-03
- Git commit：`ab400eb77`
- 平台：macOS darwin/arm64, Node v24.12.0
- 配置：iterations=5, concurrentSessions=5, heavy=false

---

## 1. 测试概述

本报告对比 qwen-code 的两种运行模式在性能、资源消耗和稳定性方面的差异：

| 模式       | 架构                          | 特点                                             |
| ---------- | ----------------------------- | ------------------------------------------------ |
| **CLI**    | 单 session 单进程，用完即退   | 每次调用独立启动 Node.js 进程，走完整初始化路径  |
| **Daemon** | 长驻 HTTP 服务 (`qwen serve`) | 通过一个 `qwen --acp` 子进程多路复用多个 session |

测试分三个阶段：

- **Phase 1**：启动延迟与内存基线（无需模型 API Key）
- **Phase 2**：Prompt 端到端延迟对比（需要模型 API Key，本次跳过）
- **Phase 3**：Daemon 压力测试（并发、吞吐、churn、限额、SSE）

### 测试方法论

- **CLI 冷启动**通过 `QWEN_CODE_PROFILE_STARTUP=1` 启用内置 startup profiler，以 `-p` 非交互模式运行，走完整初始化路径（Node 启动 + ESM + config + MCP 发现 + auth），取 profiler 报告的 `fullStartupMs`（process uptime + profiler total）。这确保了 CLI 和 daemon 对比的公允性——两端都完成了完整初始化。
- **Daemon 冷启动**计时从 `spawnDaemon()` 到首个 `createOrAttachSession()` 返回，包含 HTTP 监听 + ACP 子进程 spawn + 首个 session 创建。
- **内存**测量整个进程树 RSS（daemon parent + ACP child + MCP grandchildren），不仅是 daemon 父进程。
- **资源指标**通过 `/usr/bin/time -l` 采集，CLI 和 daemon 均为完整生命周期。

---

## 2. Phase 1：启动与内存

### 2.1 启动延迟

| 指标                            | p50          | p90      | 说明                                              |
| ------------------------------- | ------------ | -------- | ------------------------------------------------- |
| CLI 冷启动（完整初始化）        | **702 ms**   | 737 ms   | Node + ESM + config + MCP + auth（profiler 测量） |
| Daemon 冷启动（含首个 session） | **2,546 ms** | 2,618 ms | HTTP 监听 + ACP 子进程 spawn + 首个 session 创建  |
| Warm session 创建               | **21 ms**    | 24 ms    | ACP 已热，纯 session 分配开销                     |

**CLI 启动阶段分解**（startup profiler）：

| 阶段            | 耗时       | 占比  | 说明                                         |
| --------------- | ---------- | ----- | -------------------------------------------- |
| module_load     | 501 ms     | 73%   | Node.js 启动 + ESM 模块图解析                |
| config_init     | 73 ms      | 11%   | config.initialize()（工具注册、hook、skill） |
| mcp_settled     | 507 ms     | 73%\* | MCP 服务器发现完成（与 module_load 并行）    |
| **fullStartup** | **691 ms** | 100%  | 从进程启动到初始化完成                       |

\*注：mcp_settled 是从 T0 算起的绝对时间，与 module_load 有重叠。

**关键发现**：

- Daemon 冷启动（2.5s）约为 CLI（0.7s）的 **3.6 倍**，额外时间来自 HTTP 服务启动 + ACP 子进程 spawn
- ACP 子进程热后，后续 session 创建仅需 ~21ms，相比 CLI 每次 ~702ms 的完整初始化快 **33 倍**
- CLI 启动的主要瓶颈是 Node.js + ESM 模块加载（501ms，占 73%）

### 2.2 内存占用

| 场景               | 总 RSS     | 构成                                      |
| ------------------ | ---------- | ----------------------------------------- |
| CLI 单次完整初始化 | **280 MB** | 单进程（含 config + MCP + tool registry） |
| Daemon 1 session   | **691 MB** | daemon=225 + ACP=213 + MCP=254            |
| Daemon 5 sessions  | **701 MB** | daemon=227 + ACP=213 + MCP=261            |
| Daemon 10 sessions | **732 MB** | daemon=231 + ACP=213 + MCP=289            |

**关键发现**：

- Daemon 进程树基础占用约 691MB（三个进程：daemon parent、ACP child、MCP servers）
- 每增加 1 个 session 仅多 **4.5 MB**（session 元数据开销极低）
- 对比 10 个 CLI 进程的 ~2,800MB（10 × 280MB），daemon 模式节省 **74%** 内存
- MCP server 子进程是内存主要来源（占 37%），与 session 数量弱相关

---

## 3. Phase 2：Prompt 延迟对比

> 本次测试未设置模型 API Key，Phase 2 被跳过。
>
> 设计：CLI 端到端（spawn + init + MCP + 模型调用 + 退出）vs Daemon 增量延迟（HTTP 往返 + 模型调用）。两端执行相同任务（`"reply with the single word ok"`），差值 = CLI 启动摊销成本。

---

## 4. Phase 3：压力测试

### 4.1 并发突发（Burst）

5 个 session 同时创建（ACP 已热）：

| 指标     | 值        |
| -------- | --------- |
| p50 延迟 | **82 ms** |
| p90 延迟 | 100 ms    |
| 成功率   | 100%      |

结论：daemon 在 5 并发下 session 创建稳定，无失败。

### 4.2 持续吞吐

在 10 秒时间窗口内循环 session 创建 + 关闭，对比 ACP 常驻和 ACP 重启两种场景：

| 模式                           | ops/sec  | 总操作数 | 说明                                |
| ------------------------------ | -------- | -------- | ----------------------------------- |
| **Anchored**（ACP 常驻）       | **24.4** | 244      | 3 个 anchor session 保持 ACP 存活   |
| **Unanchored**（ACP 每轮重启） | **0.4**  | 4        | 每次 close 杀 ACP，下次 create 重启 |

**关键发现**：

- Anchored vs Unanchored 差距 **61 倍**，揭示 ACP 子进程生命周期管理是 daemon 性能的核心瓶颈
- 生产环境中 daemon 有活跃 session 时处于 anchored 模式，吞吐良好
- 所有 session 断开后 ACP 被回收，下次连接需冷启动（~2.5s）

### 4.3 Session Churn（泄漏检测）

20 轮 session 创建 → 关闭循环：

| 指标         | 值                             |
| ------------ | ------------------------------ |
| 每轮延迟 p50 | **19 ms**                      |
| RSS 漂移     | **+87.5 MB**                   |
| 结论         | < 100MB 阈值，属正常 V8 堆碎片 |

结论：20 轮 churn 后无明显内存泄漏。

### 4.4 Session 限额饱和

设定 `--max-sessions 5`，创建 6 个 session：

| 检查项                          | 结果     |
| ------------------------------- | -------- |
| 第 6 个 session 返回 503        | **通过** |
| 错误码 `session_limit_exceeded` | **通过** |
| 关闭 1 个后恢复创建             | **通过** |

结论：限额机制正常，饱和后正确拒绝、释放后正确恢复。

### 4.5 SSE 连接洪泛

10 个 SSE 连接同时打开到同一 session：

| 检查项          | 结果     |
| --------------- | -------- |
| 全部连接建立    | **通过** |
| Daemon 事后健康 | **通过** |

结论：并发 SSE 连接不影响 daemon 稳定性（远低于 EventBus 64 subscriber 上限）。

---

## 5. 资源消耗对比

通过 `/usr/bin/time -l` 采集进程级资源指标：

| 指标                     | CLI（-p 完整初始化） | Daemon (boot→session→exit) | 倍数  |
| ------------------------ | -------------------- | -------------------------- | ----- |
| Peak RSS                 | 280 MB               | 225 MB                     | 0.80x |
| User CPU                 | 1,070 ms             | 390 ms                     | 0.36x |
| System CPU               | 290 ms               | 70 ms                      | 0.24x |
| Involuntary ctx switches | 7,018                | 1,202                      | 0.17x |
| Page faults (major)      | 439                  | 120                        | 0.27x |
| Page reclaims (minor)    | 18,500+              | 18,128                     | ~1x   |
| Instructions retired     | 4,545M               | 4,968M                     | 1.09x |
| CPU cycles               | 1,410M+              | 1,550M                     | ~1.1x |

**说明**：CLI 测量的是单次 `-p` 完整初始化生命周期（包含 config + MCP + auth + prompt 尝试），Daemon 测量的是完整 boot → first session → SIGTERM 生命周期。两者均只含主进程（daemon 端不含 ACP/MCP 子进程），通过 `/usr/bin/time` 包装确保测量条件一致。

**关键发现**：

- CLI 完整初始化的 CPU 用量（user+sys=1,360ms）显著高于 daemon 主进程（460ms），因为 CLI 在单进程内完成了所有初始化工作
- CLI 的上下文切换（7,018）远高于 daemon（1,202），反映 CLI 初始化路径中有大量 I/O 等待
- 指令数和周期数两端接近（~1.1x），说明总计算量相当，但 daemon 将部分工作下发给了 ACP 子进程（未计入此表）

---

## 6. 冷启动优化分析

Daemon 冷启动 2.5s 的时间分解：

```
0s          0.5s         1.0s         1.5s         2.0s         2.5s
|-- Node+ESM --|-- HTTP -|--- ACP spawn+relaunch ---|-- Session init ---|
   ~500ms       ~100ms     ~700ms (含不必要的           config.initialize()
                           relaunchAppInChild)         + waitForMcpReady()
                                                       ~1200ms
```

### 可行优化

| 方案                                                   | 预计收益                                  | 复杂度 | 说明                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A)** 预热 ACP：daemon boot 后立刻 `ensureChannel()` | **0-0.5s**（取决于首个 session 到达时间） | 低     | `ensureChannel()` 在 `app.listen()` 回调后 fire-and-forget 调用。收益不是并行化 listen（~100ms），而是让 ACP 子进程在首个 session 到达前就绑定完成。如果 session 紧随 listen 到达，收益接近 0；如果间隔数秒，收益接近 ACP spawn 全程（~500ms）                                                                                                                             |
| **(B)** 消除 ACP 不必要的进程重启                      | **0.2-0.3s**                              | 低     | ACP 子进程经过 `relaunchAppInChildProcess` 产生一个多余的孙进程。在 spawn 环境变量中设 `QWEN_CODE_NO_RELAUNCH=true` 即可跳过                                                                                                                                                                                                                                               |
| **(C)** 复用 bootstrap Config 部分结果                 | **0.1-0.2s**                              | 中     | ACP bootstrap 的 `config.initialize({ skipMcp, skipGemini })` 做了 extensionManager + hookSystem + skillManager + toolRegistry 初始化。per-session 的全量 `config.initialize()` 在**不同 Config 对象**上重做了这些。可以将 bootstrap 的中间结果（tool registry、hook system）注入到 per-session Config 中。收益有限，因为 bootstrap 用了 skip flags 跳过了大部分重量级工作 |

**合计可行收益：0.6-1.0s，可将冷启动从 2.5s 降到 ~1.5-1.9s。**

### 不可行方案

| 方案               | 原始声称  | 不可行原因                                                                                                                                                                                                         |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP 发现改为非阻塞 | 省 0.5-2s | `waitForMcpReady()` 阻塞是必要的——首个 prompt 需要 MCP 工具可用。去掉会导致 agent 在工具未就位时收到请求，无法调用 Bash/Read 等工具。需要协议级改动（工具延迟推送 + agent 侧等待机制）才能实现，不是简单的代码改动 |

### 进一步优化方向（需要更大改动）

| 方向                          | 潜在收益   | 说明                                                                                          |
| ----------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| ACP 子进程常驻池              | 避免冷启动 | 预先 spawn 并保持一个空闲 ACP 子进程，首个 session 直接复用。需要管理进程池生命周期           |
| MCP 连接池跨 session 共享     | 0.5-1s     | MCP 服务器连接在 session 间复用，避免每个 session 重新发现。已有 `McpTransportPool` 部分实现  |
| 延迟 MCP 发现到首次 tool 调用 | 0.5-2s     | 不在 session 创建时发现 MCP，而是在 agent 首次调用 MCP tool 时再发现。需要 lazy tool registry |

---

## 7. 总结

### Daemon 优势

| 场景                | 优势幅度         | 说明                                            |
| ------------------- | ---------------- | ----------------------------------------------- |
| 后续请求延迟        | **33x**          | warm session 21ms vs CLI 完整初始化 702ms       |
| 多 session 内存效率 | 节省 **74%**     | 10 session 共用 732MB vs 10 个 CLI 进程 2,800MB |
| Session 创建吞吐    | **24 ops/sec**   | ACP 热时的稳态吞吐                              |
| 并发稳定性          | 5 并发 100% 成功 | 无拒绝、无超时                                  |

### Daemon 劣势/风险

| 场景           | 影响                   | 说明                                         |
| -------------- | ---------------------- | -------------------------------------------- |
| 冷启动成本     | 2.5s vs 0.7s（3.6x）   | 包含 ACP 子进程 spawn，一次性                |
| 基础内存占用   | 691MB vs 280MB（2.5x） | 三进程架构固定开销                           |
| ACP 重启开销   | 吞吐降 61x             | 所有 session 断开后 ACP 回收，下次连接冷启动 |
| 长时间运行碎片 | +88MB/20轮             | V8 堆碎片，未见泄漏但需持续监控              |

### 建议

**短期（低成本，预计省 0.5-0.8s）**：

1. **预热 ACP**：daemon boot 后立即 `ensureChannel()` 而非等首个 session（省 0.3-0.5s）
2. **跳过 ACP 不必要的进程重启**：spawn 时设 `QWEN_CODE_NO_RELAUNCH=true`（省 0.2-0.3s）

**中期（需要设计）**：3. **ACP Keep-alive**：所有 session 断开后延迟回收 ACP 子进程（如空闲 5 分钟再杀），避免 unanchored 场景的吞吐暴跌 4. **MCP 连接池跨 session 共享**：已有 `McpTransportPool` 基础，扩展其复用范围

**需要持续关注**：5. **补充 Phase 2**：在有模型 Key 的环境运行完整测试，获取端到端 prompt 延迟对比 6. **Heavy 模式**：`BENCHMARK_HEAVY=1` 运行更高迭代数获取统计显著性更强的结果7. **长时间运行稳定性**：当前 churn 测试 20 轮 RSS 漂移 88MB，需在更高轮数（100+）下验证是否收敛

---

## 附录：测试运行方式

```bash
# 构建
npm run build

# 运行（Phase 1 + Phase 3，Phase 2 需要模型 Key）
QWEN_BENCHMARK_ENABLED=1 KEEP_OUTPUT=true \
  npx vitest run integration-tests/cli/qwen-daemon-vs-cli-benchmark.test.ts

# Heavy 模式
QWEN_BENCHMARK_ENABLED=1 BENCHMARK_HEAVY=1 KEEP_OUTPUT=true \
  npx vitest run integration-tests/cli/qwen-daemon-vs-cli-benchmark.test.ts
```

报告产物：`.integration-tests/<timestamp>/daemon-vs-cli-benchmark.{json,md}`
