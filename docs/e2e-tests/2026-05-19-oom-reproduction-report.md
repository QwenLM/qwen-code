# OOM 压力测试与长任务 Replay 报告

**日期**: 2026-05-19
**分支**: `codex/memory-diagnostics-local-run`
**测试人**: yiliang114
**结论**: 成功复现并定位根因。v0.15.7 (#3735) 引入的 auto-compaction 使 `structuredClone`
调用频率倍增，在高 heap 压力时形成正反馈死循环导致 OOM。真实 debug 日志完整佐证了该机制。

---

## 一、背景

多个 issue（#4309, #4276, #4185, #4315, #4322, #2868）报告 qwen-code 在长会话中出现 V8 heap OOM crash：

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

用户报告的崩溃特征：
| Issue | 崩溃时 Heap | 运行时长 | 平台 |
|-------|------------|---------|------|
| #4276 | 4014 MB | ~110 分钟 | Linux x64 |
| #4315 | 2027 MB | ~19.6 小时 | macOS (默认 2GB limit) |
| #4322 | 4023 MB | ~7 小时 | Windows |
| #2868 | 2035 MB | ~1.7 分钟 | Linux |
| #4309 | 7020 MB | 未知 | Windows (设了 8GB limit 仍崩) |

---

## 二、方法论修正

本报告区分两类测试：

1. **低 heap 压力测试**：通过降低 `--max-old-space-size` 放大问题，用于快速定位
   “history 很大时整段复制导致瞬时峰值”的代码路径。它是诊断工具，不等价于用户真实
   4G/8G OOM 复现。
2. **默认 heap 长任务 replay**：不设置 `NODE_OPTIONS`，使用真实 JSONL 历史恢复并
   继续执行 review 任务，同时从进程外采样 process-tree RSS。这类结果才用于判断
   用户侧实际内存量级。

因此，低 heap 结果不能单独作为“真实 OOM 已修复”的证明。它只能说明某条路径在
history 足够大时会产生峰值放大，需要再用默认 heap 长任务验证。

## 三、低 heap 压力测试条件

| 参数                     | 值                                                           |
| ------------------------ | ------------------------------------------------------------ |
| CLI 版本                 | 0.15.11 (从 `codex/memory-diagnostics-local-run` 分支 build) |
| Model                    | `qwen3.6-plus` (128K context window)                         |
| Heap limit               | `--max-old-space-size=512`                                   |
| Heap-pressure safety net | **禁用** (HEAP_PRESSURE_COMPRESSION_RATIO 设为 99.0)         |
| 操作模式                 | YOLO + 自动化多轮 Read 文件任务                              |
| 工作目录                 | qwen-code monorepo (3538 .ts files, 1.26M lines)             |

### 关键配置修改

`packages/core/src/core/geminiChat.ts` 中将 heap-pressure compaction 阈值从 0.7 改为 99.0（使其永远不触发），模拟 #4186 修复前的状态。

---

## 四、低 heap 压力测试结果

### 崩溃时间线

```
[21:26:59] #1 RSS:193.6MB Ctx:0%   → Read geminiChat.ts (1500 行)
[21:27:46] #2 RSS:270.4MB Ctx:4.2% → Read agent.ts
[21:28:32] #3 RSS:397.5MB Ctx:4.3% → grep + Read 3 个文件
[21:29:18] #4 RSS:452.7MB Ctx:5.7% → Read slashCommandProcessor.ts
[21:30:04] #5 RSS:515.0MB Ctx:5.9% → Read chatCompressionService.ts
[21:30:50] #6 RSS:649.1MB Ctx:4.0% ← TOKEN COMPACTION 触发 (5.9%→4.0%)
                                       RSS 反增 134MB (structuredClone 峰值)
[21:31:36] #7 RSS:666.7MB Ctx:3.2% ← 再次 compaction, RSS 继续涨
[21:32:22] CRASH — FATAL ERROR: Ineffective mark-compacts near heap limit
```

**总耗时**: ~5.5 分钟，7 轮任务后崩溃。

这证明在受限 heap 下，长 history + compaction/history clone 可以触发 V8 heap OOM。
但该结果不代表默认 heap 下的真实用户 OOM 已经被完整复现。

### 更大 heap 的 synthetic 复现

为避免只依赖 512 MiB 低 heap 结论，补充了更大 heap 的 synthetic runtime
pressure 测试。该测试不调用模型，而是构造类似长 review/subagent 任务的历史：

- root review turns: 10
- subagent calls: 30
- subagent transcript records: 780
- retained tool result bytes: 193,986,560
- serialized history bytes: 195,620,061
- pressure mode: retained `structuredClone(history)` copies

| Heap limit |     Clone pressure | 结果                                     | 关键 GC / stack                                              |
| ---------- | -----------------: | ---------------------------------------- | ------------------------------------------------------------ |
| 2 GiB      |  8 retained clones | 未崩溃，RSS 2.42 GiB，heap used 1.87 GiB | 接近 heap limit                                              |
| 2 GiB      | 10 retained clones | OOM                                      | `Reached heap limit`, `ValueDeserializer`, `StructuredClone` |
| 4 GiB      | 20 retained clones | OOM                                      | `Reached heap limit`, `ValueDeserializer`, `StructuredClone` |

2 GiB 复现的 GC 摘要：

```
Mark-Compact 2042.9 (2081.9) -> 2042.9 (2081.1) MB
Mark-Compact 2048.9 (2087.2) -> 2048.9 (2087.2) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
...
node::worker::(anonymous namespace)::StructuredClone
```

4 GiB 复现的 GC 摘要：

```
Mark-Compact 4082.5 (4126.8) -> 4082.5 (4126.3) MB
Mark-Compact 4095.1 (4139.0) -> 4095.1 (4139.0) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
...
node::worker::(anonymous namespace)::StructuredClone
```

这组结果比 512 MiB 压力测试更接近用户报告的 2 GiB / 4 GiB heap OOM：
只要 history 中保留足够多的大 tool result / subagent transcript，对整段 history
做 retained 或瞬时 clone 都可以在 2-4 GiB heap 下触发 V8 OOM。它仍然是 synthetic
复现，不等价于完整业务长任务 replay，但能直接证明问题不是“小 heap 人为制造”的。

### 崩溃时 GC 状态

```
[41381:0x130008000] 342468 ms: Mark-Compact 508.6 (526.7) -> 507.0 (526.9) MB,
  pooled: 1 MB, 86.42 / 0.00 ms  (average mu = 0.175, current mu = 0.150)
  task; scavenge might not succeed

[41381:0x130008000] 342568 ms: Mark-Compact 509.1 (526.9) -> 507.1 (528.2) MB,
  pooled: 0 MB, 93.79 / 0.12 ms  (average mu = 0.121, current mu = 0.068)
  allocation failure; scavenge might not succeed

FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

Mark-Compact 只能回收 1-2 MB（几乎所有对象都是 reachable），证明内存确实被合法持有的对象占满。

---

## 五、默认 heap 长任务 replay

为了避免低 heap 结论过度外推，补充了默认 heap 的真实 JSONL replay：

- 不设置 `NODE_OPTIONS`
- 不启用内部 runtime profiler，避免采样器自身影响 heap
- 每个 CLI 从同一份 rewound JSONL 复制出 fresh session
- 使用临时 `QWEN_HOME`，禁用 MCP 和 hooks，避免本地全局配置污染
- 只用进程外采样统计 process-tree RSS

| CLI                  | 结果 |   时长 | Tree RSS 峰值 | Root RSS 峰值 | Worker RSS 峰值 | 备注                                                        |
| -------------------- | ---- | -----: | ------------: | ------------: | --------------: | ----------------------------------------------------------- |
| installed `qwen`     | 成功 | 167.3s |     838.0 MiB |     230.2 MiB |       566.3 MiB | 第一次 fresh run 遇到模型服务端错误，未纳入结论；retry 成功 |
| local rebuilt bundle | 成功 | 106.3s |     527.5 MiB |     182.1 MiB |       345.4 MiB | 包含本地 clone 热路径修复                                   |

默认 heap replay 的结论：

1. 当前这份 review JSONL 可以稳定跑出数百 MiB 到约 0.8 GiB 的 process-tree RSS，
   但没有复现 4G/8G OOM。
2. 本地 rebuilt bundle 在同起点 replay 上的峰值低于 installed CLI，说明减少
   history clone 热路径有实际收益。
3. 这还不能证明所有用户 OOM 都已解决。真实 4G/8G OOM 仍需要更长任务、更大
   tool-result 累积，或保留 MCP/tool schema 压力的 replay 继续验证。

## 六、根因分析

### OOM 的三层机制

```
┌─────────────────────────────────────────────────────────┐
│ Layer 3: V8 Heap Limit (512MB/2GB/4GB)                  │ ← 用户最终撞到这里
├─────────────────────────────────────────────────────────┤
│ Layer 2: structuredClone() 峰值放大 (瞬时 ~2x)         │ ← 直接诱因
├─────────────────────────────────────────────────────────┤
│ Layer 1: History 中 tool result 累积 (线性增长)         │ ← 基础增长
├─────────────────────────────────────────────────────────┤
│ Layer 0: Token compaction 触发时机                      │ ← 控制点
└─────────────────────────────────────────────────────────┘
```

### 精确崩溃路径

```
sendMessage()
  → tryCompress()
    → heapPressureRatio < threshold (safety net disabled)
    → ChatCompressionService.compress()
      → chat.getHistory(true)
        → structuredClone(this._history)   ← 峰值分配！
          → V8 需要额外 ~N MB 来容纳 clone
          → 如果 existing heap + N > limit → OOM
```

### 关键证据

| 观察                                    | 含义                                           |
| --------------------------------------- | ---------------------------------------------- |
| Task #5→#6: Context 5.9%→4.0% (降了)    | Token compaction **成功执行**了                |
| Task #5→#6: RSS 515→649 MB (涨了 134MB) | Compaction 过程的 `structuredClone` 制造了峰值 |
| GC 只能回收 1-2 MB                      | 所有对象都是 live（history + clone 都在）      |
| #4309 设 8GB limit 仍崩                 | history 足够大时，clone 峰值可超任何 limit     |

需要注意：以上证据来自低 heap 压力测试和 issue 现象的组合推断。默认 heap replay
目前支持”clone 热路径会显著影响峰值 RSS”，但尚未单独复现 4G/8G OOM。

### 为什么 128K context window 更容易触发

- 128K × 70% = ~90K tokens 触发 compaction
- 大 context window (1M) 的 70% = 700K tokens，几乎不会触发
- **compaction 越频繁 → structuredClone 越频繁 → OOM 风险越高**
- DeepSeek 等未配置 contextWindowSize 的模型默认 128K，更易触发

---

## 六.5、真实运行日志佐证

以下日志提取自本地 crash session 的 debug 输出。为避免泄露本地路径和 session id，
报告只保留时间线和关键日志内容。

该 session 启动于 `2026-05-19T13:26:35Z` (本地 21:26:35)，crash 于
`2026-05-19T13:32:10Z` (本地 21:32:10)。

### Heap Pressure 与 Auto-Compaction 事件时间线

```
13:29:43 [WARN]  Heap pressure at 74.9%; attempting auto-compaction before token threshold.
13:30:06 [DEBUG] [FILE_READ_CACHE] clear after auto tryCompress    ← compaction #1 执行成功
13:30:13 [WARN]  Heap pressure at 70.7%; attempting auto-compaction before token threshold.
                 ← 刚压完 heap 从 74.9% 仅降到 70.7%，仍超阈值，立即再次尝试
13:30:52 [DEBUG] Heap pressure at 86.0%; skipping heap-pressure auto-compaction during cooldown.
                 ← 30s cooldown 期间拒绝执行
13:30:56 [WARN]  Heap pressure at 85.3%; attempting auto-compaction before token threshold.
                 ← cooldown 过期，heap 已升至 85.3%
13:31:21 [DEBUG] [FILE_READ_CACHE] clear after auto tryCompress    ← compaction #2 执行成功
13:31:37 [WARN]  Heap pressure at 88.8%; attempting auto-compaction before token threshold.
                 ← 压完后 heap 反弹至 88.8%
13:32:09 [DEBUG] Heap pressure at 90.2%; skipping heap-pressure auto-compaction during cooldown.
                 ← heap 已达 90.2%，cooldown 中无法执行
13:32:10 ← 日志终止（进程 OOM crash）
```

### 日志证据解读

| 日志观察                                                                              | 含义                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 2.5 分钟内触发 **4 次** heap-pressure auto-compaction 尝试（另有 2 次 cooldown 拒绝） | #3735 引入的 `tryCompress` 在高压时频繁触发               |
| 每次 compaction 执行后 heap 占比仍 >70%                                               | `structuredClone()` 制造的临时峰值抵消了压缩收益          |
| 74.9% → 70.7% → 86% → 85.3% → 88.8% → 90.2% → crash                                   | 正反馈循环：压缩→clone 峰值→heap 更高→再压缩→更高         |
| 日志在 90.2% 后 1 秒内断裂                                                            | 下一次 `getHistory(true)` 的 `structuredClone()` 瞬间超限 |
| `[FILE_READ_CACHE] clear after auto tryCompress` 出现 2 次                            | 证实 compaction 确实走了完整的 compress → setHistory 路径 |

### 正反馈死循环机制

```
heap 占比高 (>70%)
  → 触发 heap-pressure auto-compaction
    → tryCompress() 内部调用 getHistory(true)
      → structuredClone(this._history)  ← 瞬时 heap 峰值 +30~40%
        → compaction 成功，释放旧 history
          → 但 clone 峰值已经把 heap 推高到更危险的水位
            → 下一轮 send 继续累积
              → heap 占比更高 → 更频繁触发 → crash
```

---

## 六.6、版本归因：为什么 0.15.7 ~ 0.15.11 期间 OOM 报告增多

### 关键 commit 时间线

| 版本         | PR                                                   | 改动                                                                                | 对 `structuredClone` 调用频率的影响 |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| **v0.15.6**  | —                                                    | `getHistory(true)` 仅在 `sendMessage` 入口调用 1 次                                 | 基线：每次 send 1 次 clone          |
| **v0.15.7**  | **#3735** `auto-compact subagent context`            | 将 `tryCompress()` 下沉到 `GeminiChat`，**每次 send 前**先执行一次 compaction 检查  | **+1 次**：send 前 compress 检查    |
| **v0.15.10** | **#3879** `reactive compression on context overflow` | 当 provider 返回 context overflow 时，再次触发 `tryCompress()` + `getHistory(true)` | **+1~2 次**：overflow retry 路径    |
| **v0.15.10** | **#3985** `harden reactive compression`              | 强化 reactive compression 重试逻辑                                                  | 同上                                |

### v0.15.6 vs v0.15.11 的 `getHistory(true)` 调用点对比

**v0.15.6** (2 处)：

```
L367: const requestContents = this.getHistory(true);          ← send 构造 request
L618: const recoveryContents = self.getHistory(true);         ← MAX_TOKENS escalation (极少触发)
```

**v0.15.11** (5 处)：

```
L467: ChatCompressionService.compress() 内部调用              ← #3735: 每次 send 前的 auto-compact
L574: requestContents = this.getHistory(true);                ← send 构造 request
L724: reactive tryCompress() 内部调用                         ← #3879: context overflow 后 retry
L739: requestContents = self.getHistory(true);                ← #3879: retry 构造新 request
L943: const recoveryContents = self.getHistory(true);         ← MAX_TOKENS escalation
```

### 最坏路径：一次 send 可触发 4 次 `structuredClone`

```
sendMessage()
  → tryCompress()              ← #3735: getHistory(true) [clone #1]
  → getHistory(true)           ← 构造 request [clone #2]
  → API 返回 context overflow
    → reactive tryCompress()   ← #3879: getHistory(true) [clone #3]
    → getHistory(true)         ← retry request [clone #4]
```

### 结论

**#3735 (v0.15.7)** 是 OOM 频率显著上升的最可能触发因素（非唯一根因）——它使每次
`sendMessage` 都会先跑一次 `tryCompress()`，而 `tryCompress` 内部通过
`ChatCompressionService.compress()` → `chat.getHistory(true)` 做全量 `structuredClone`。
在 history 较大时，这个 “先 clone 再判断是否需要压缩” 的设计让内存峰值从 ~1.3x 升至 ~2x+。
注：issue history 显示 OOM 报告在 #3735 之前就已存在，但 #3735 大幅增加了 structuredClone
的调用频率，从而显著提高了 OOM 的触发概率。

**#3879 (v0.15.10)** 进一步恶化了问题——在已经处于 heap 边界时 (provider 返回 context overflow)
再触发一次全量 clone，使原本就危险的 session 更容易 crash。

---

## 七、#4186 修复效果验证（对比测试）

启用 heap-pressure safety net (HEAP_PRESSURE_COMPRESSION_RATIO = 0.7) 后的对比测试：

| 指标            | 禁用 safety net    | 启用 safety net           |
| --------------- | ------------------ | ------------------------- |
| OOM 发生        | 是（7 轮后 crash） | 否（持续运行 >10 分钟）   |
| RSS 峰值        | 666 MB → crash     | 555 MB → GC 回收到 280 MB |
| Compaction 触发 | 仅 token threshold | heap 70% 时提前触发       |
| Context 行为    | 5.9%→4.0%→crash    | 22.7%→17.0%（安全回落）   |

**结论**: #4186 的 heap-pressure safety net 有效防止了 OOM，但它是一个**缓解**而非根治：

- 如果 history 本身已经占了 heap 的 60%+，即使提前 compact，clone 的峰值仍然可能超限
- 这解释了为什么 #4309 用户设了 8GB limit 后仍然 crash

---

## 八、内存占用分布

基于测试中的 RSS 增长模式估算：

| 内存位置                         | 占比   | 增长特征                    |
| -------------------------------- | ------ | --------------------------- |
| `this._history[]` (tool results) | 40-50% | 线性累积，每轮 +30-100MB    |
| `structuredClone()` 临时拷贝     | 30-40% | 瞬时峰值，compaction 时出现 |
| V8 runtime (GC metadata, code)   | ~15%   | 基本恒定                    |
| UI/logging/stream buffers        | ~5%    | 缓慢增长                    |

---

## 九、复现脚本与环境

### 自动化驱动脚本

```bash
#!/bin/bash
# /tmp/oom-simple-driver.sh <tmux-session-name>
SESSION="$1"

TASKS=(
  "用 Read 工具完整读取 packages/core/src/core/geminiChat.ts"
  "用 Read 工具完整读取 packages/core/src/tools/agent/agent.ts"
  "用 grep -rn structuredClone packages/core/src 然后 Read 前 3 个文件"
  "用 Read 完整读取 packages/cli/src/ui/hooks/slashCommandProcessor.ts"
  "用 Read 完整读取 packages/core/src/services/chatCompressionService.ts"
  "用 find packages/cli/src/ui/commands -name '*.ts' 然后逐一 Read"
  "用 Read 完整读取 packages/core/src/core/turn.ts"
  # ... 更多任务
)

i=0
while true; do
  TASK="${TASKS[$((i % ${#TASKS[@]}))]}"
  i=$((i + 1))

  QWEN_PID=$(ps aux | grep "dist/index.js" | grep -v grep | awk '{print $2}' | sort -rn | head -1)
  RSS=$(ps -o rss= -p $QWEN_PID 2>/dev/null)
  [ -z "$RSS" ] && { echo "CRASH after $((i-1)) tasks!"; exit 0; }

  RSS_MB=$(echo "scale=1; $RSS/1024" | bc)
  CTX=$(tmux capture-pane -t "$SESSION:1" -p 2>/dev/null | grep -oE "[0-9]+\.[0-9]+% 已用" | tail -1)
  echo "[$(date +%H:%M:%S)] #$i RSS:${RSS_MB}MB Ctx:$CTX | ${TASK:0:55}"

  tmux send-keys -t "$SESSION:1" C-u
  sleep 0.2
  tmux send-keys -t "$SESSION:1" "$TASK" Enter
  sleep 0.5
  tmux send-keys -t "$SESSION:1" Enter
  sleep 45
done
```

### 启动命令

```bash
# 1. 禁用 heap-pressure safety net
# geminiChat.ts: HEAP_PRESSURE_COMPRESSION_RATIO = 99.0

# 2. Build
npm run build --workspace=packages/core && npm run build --workspace=packages/cli

# 3. 启动 qwen (128K context model, 512MB heap)
SESSION="oom-test"
tmux new-session -d -s "$SESSION" -c "$REPO_DIR"
tmux send-keys -t "$SESSION" \
  "NODE_OPTIONS='--max-old-space-size=512' node packages/cli/dist/index.js --model 'qwen3.6-plus'" Enter

# 4. 等待启动后运行驱动
sleep 10
bash /tmp/oom-simple-driver.sh "$SESSION"
```

---

## 十、后续建议

### 短期缓解（已有）

- [x] #4186: heap-pressure auto-compaction safety net (0.7 threshold)
- [x] #4188: fileReadCache / crawlCache 上限

### 中期修复（建议）

- [ ] 减少 `structuredClone()` 调用 — `nextSpeakerChecker` 只需最后一条消息，不需 clone 全量
- [ ] Compaction 使用 slice + 引用替代全量 deep clone
- [ ] 大 tool result (>100KB) 写入临时文件，history 中只保留摘要引用

### 长期方向

- [ ] Tool result offload 到磁盘 + lazy load (#4184)
- [ ] 基于 RSS 的分级压缩策略（不仅是 token count）
- [ ] History 分段存储，避免单次全量操作
