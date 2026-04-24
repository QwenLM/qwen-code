# 闪屏治理：Issue 驱动的 4-PR 实施方案

> 目标：把闪屏优化从“围绕某个大 PR 拆补丁”改成“围绕真实用户问题逐类关闭 issue”，同时把当前 8 条过细的 PR 计划压缩成 4 条主 PR，并补齐下一步可以直接进入编码的执行边界。
> 校准时间点：2026-04-24
> 使用方式：`09-pr-3013-gap-analysis.md` 只用于参考 `#3013` 里哪些 patch 被证明有价值；真正的实施排期、PR 粒度和验证矩阵以本文档为准。
> 口径约束：如果 [00-overview.md](./00-overview.md)、[02-screen-flickering.md](./02-screen-flickering.md)、[08-execution-plan-and-test-matrix.md](./08-execution-plan-and-test-matrix.md) 中的技术阶段表或切片表与本文档的 PR 粒度看起来不同，以本文档为准；那些文档承担的是“技术演进顺序”和“文件/测试切片”视角。

## 1. 为什么从 8 条收成 4 条

8 条方案在“研究和拆因”层面是对的，但落到真实开发节奏上会有两个问题：

1. PR 太碎，review 和回归成本偏高
2. 太多前后依赖会让排期看起来像 8 次独立发布，执行上反而拖慢

但我也不建议再继续压到 2-3 条。原因是下面两类问题必须保持隔离：

- **窄屏 / interactive shell 问题**：这是 shell serializer 和 viewport 语义问题，不能再混回主 UI PR
- **终端协议层问题**：synchronized output / frame coalescing 需要按终端家族灰度，也不应和应用层修复绑死

因此，这一版把原来的 8 条收成 4 条主 PR，作为执行层的平衡点。

## 2. 证据边界

本文档只使用四类证据：

1. **当前 qwen-code 源码**
2. **真实用户 issue**
3. **Gemini CLI / Claude Code 的可借鉴实现**
4. **`#3013` 中已被证明有价值的 patch**

其中第 4 类只做交叉印证，不作为拆 PR 的主轴。按 2026-04-24 复核，`#3013` 仍是 `OPEN + CHANGES_REQUESTED`，最近更新时间仍为 2026-04-22T11:28:48Z。

## 3. 4 条主 PR 总览

| 主 PR | 关闭的问题类 | 覆盖旧拆分 | 代表 issue | 主要范围 | 明确不带 |
| --- | --- | --- | --- | --- | --- |
| `PR-1` | 主屏闪烁基础修复 | `PR-Prep` + `PR-A1` + `PR-B1` 的安全子集 | `#1184` `#1491` `#3007` `#938` `#1861` `#2924`，以及 `#2748` 的 flicker 子问题 | counters、回归 harness、content/thought throttle、已清屏路径重复 clear 削减 | 不带 narrow-shell、不带 synchronized output、不带大输出详情重构 |
| `PR-2` | 大输出与详情展开稳定性 | `PR-D1` + `PR-E1` | `#1479` `#2424` `#2624`，以及 `#1491` `#1861` `#2924` 的展开子问题 | pre-slicing、stable height、bounded detail panel、update cadence decoupling | 不带 synchronized output、不带 shell serializer、不带 `refreshStatic()` 主链改造、不带 core budgeting |
| `PR-3` | 窄屏 / interactive shell 专项 | `PR-C1` | `#2912` `#2972` `#1591` `#1778` | shell serializer、live viewport vs transcript、interactive prompt 回归 | 不带 tool budgeting、不带 detail panel、不带终端协议层优化 |
| `PR-4` | 终端协议层残余闪烁收尾 | `PR-A2` | `#3144`，以及主屏闪烁在特定终端中的残余问题 | synchronized output、frame write 合并、runtime probe、allowlist | 不带主 UI 语义改造、不带 shell serializer、不带大输出重构 |

**非 flicker 主线 follow-up**：

- `Follow-up-F1`：通用 tool budgeting 与 summary/detail 语义，主要对应 `#2818` `#1008` `#355`
- `Follow-up-F2`：markdown-heavy 大输出的 parser/block 级降峰，属于渲染层 follow-up，不纳入当前 4 条 flicker 主 PR

## 4. 推荐顺序

推荐按下面顺序推进：

1. `PR-1`
2. `PR-2`
3. `PR-3`
4. `PR-4`

排序理由：

- `PR-1` 先解决主路径上的“普通流式闪烁 + 整屏 clear”
- `PR-2` 再解决“大输出 / 展开详情导致的布局风暴和不可读”
- `PR-3` 继续单独收敛最复杂的窄屏 shell 问题
- `PR-4` 最后上终端协议层，是为了避免应用层问题没收敛前就引入终端家族灰度复杂度

## 5. `PR-1`：主屏闪烁基础修复

### 5.1 关闭的问题类

主屏路径上最常见的两类闪烁：

1. 普通 assistant 流式输出时的高频抖动
2. `refreshStatic()` 导致的整屏 clear + redraw

**Issue 边界**：

- `#2748` 在这条 PR 中只作为 startup/view-switch flicker 样本，不代表这条 PR 会关闭其 slow startup 或 verbose output 全部诉求

### 5.2 合并后的范围

- 输出层 counters 与固定回归场景
- `useGeminiStream.ts` 的 content/thought throttle
- 强制 flush 语义
- `refreshStatic()` 的安全子集拆分：
  - 已清屏路径使用 `remountStaticHistory()`
  - 替换旧 static output 的路径继续保留 clear，等待后续 renderer 策略
- slash clear / `/clear` 重复清屏削减

### 5.3 为什么这几块适合并在一起

它们都属于**主屏主路径的基础修复**：

- 验证场景高度重合
- 同一组 counters 能同时衡量收益
- 都不依赖 shell serializer 或终端协议层 rollout

### 5.4 明确不带

- synchronized output
- narrow-shell / interactive shell 修复
- 大工具输出 pre-slicing
- stable height / bounded detail panel

### 5.5 固定验证场景

1. 长 assistant 回答（至少 500 token）
2. thought + content 混合流
3. 冷启动（无 MCP）
4. 冷启动（含 1 个慢 MCP server）
5. `/settings` 上下切换
6. compact mode merge
7. active view switch
8. 终端宽高 resize
9. `/clear`

### 5.6 Done 定义

- `stdout.write` 频率显著下降
- `clear_terminal_count` 明显下降
- 结束 / cancel 不丢尾部内容
- 非致命布局变化不再默认清屏

## 6. `PR-2`：大输出与详情展开稳定性

### 6.1 关闭的问题类

这一条主 PR 负责解决“只要输出很大、或者一展开详情，界面就开始抖和变得不可读”的 UI 问题簇，包括：

1. 大工具输出导致的全量 layout
2. 工具 / 子 agent 展开导致的高度暴涨
3. detail surface 缺乏边界，导致主流式区域和详情区域互相拖累

### 6.2 合并后的范围

- plain text / ANSI pre-render slicing
- `MaxSizedBox` 降级成 safety net
- `useStableHeight`
- bounded detail panel
- assistant / tool progress / subagent progress 的刷新节奏解耦

### 6.3 为什么这几块适合并在一起

从用户视角，它们其实是同一个问题类：

- “大结果一出来就闪”
- “展开详情就抖”
- “结果太长时既难读又浪费上下文”

这些问题共用同一组回归样例，也都围绕 tool/subagent detail surface。

### 6.4 明确不带

- synchronized output
- shell serializer 改造
- `refreshStatic()` 主链改造
- 全量虚拟滚动
- scheduler 层统一 budgeting
- `llmContent` / 模型可见预算语义变更
- 以 markdown 降级替代真正的 parser/block 降峰

**Issue 边界**：

- `#2818` `#1008` `#355` 不在这条 flicker 主 PR 的 closure 范围内，它们属于 `Follow-up-F1`
- markdown-heavy 大输出不应被这条 PR 宣称“已彻底解决”；它只需要保证不因本 PR 退化，并为后续 parser/block 降峰留下接口

### 6.5 固定验证场景

1. `npm install`
2. `git log --oneline`
3. 5000 行纯文本
4. ANSI 彩色输出
5. `ctrl+e`
6. `ctrl+f`
7. subagent 执行中展开
8. markdown-heavy 工具结果（仅验证“不退化”和“不会错误 claim 已解决”）

### 6.6 Done 定义

- 大工具输出不再每次 layout 全量内容
- 展开详情不再造成明显闪屏
- hidden lines 统计可解释
- 不引入 `llmContent` 语义变化

## 7. `PR-3`：窄屏 / interactive shell 专项

### 7.1 关闭的问题类

窄终端、多 pane tmux、interactive shell 场景下的：

- 重复打印
- 顶部 / 底部来回跳
- 无限滚动

### 7.2 范围

- `shellExecutionService.ts`
- `terminalSerializer.ts`
- live viewport / transcript archival 语义拆分
- interactive / integration 回归

### 7.3 为什么必须单独保留

这不是普通的“主屏闪烁”问题，而是 shell viewport 序列化和滚动语义问题。继续把它混进主 UI PR，会同时拖慢验证和误伤其他路径。

### 7.4 明确不带

- synchronized output
- tool budgeting
- bounded detail panel
- `refreshStatic()` 语义改造

### 7.5 固定验证场景

1. 40 列以下窄终端
2. tmux 多 pane
3. 宽度缩小后继续输出
4. `git commit`
5. interactive shell prompt / pager
6. `showColor=true` 的彩色 shell 输出
7. `showColor=true` + tmux / 窄终端 组合路径

### 7.6 Done 定义

- 不再重复刷旧 viewport
- 顶 / 底往返滚动停止
- 文档与实现中不再把 `#1778` 的 one-line fix 当作现状根因

## 8. `PR-4`：终端协议层残余闪烁收尾

### 8.1 关闭的问题类

在主 UI 路径已经收敛后，特定终端中仍残留的帧撕裂和可见中间帧问题。

**Issue 边界**：

- `#2903` 在这条 PR 中是必须显式验证的 JetBrains 环境样本，不是默认的 closure target
- 只有当 JetBrains 被明确纳入 support matrix / allowlist / probe 成功路径时，才应把它提升为“修复目标”

### 8.2 范围

- synchronized output wrapper
- frame 内 write 合并
- runtime probe / allowlist
- fallback / rollback

### 8.3 为什么必须最后做

这条 PR 的收益很大，但风险也最高：

- 依赖终端家族差异
- 涉及 stdout monkeypatch 和 callback / Buffer 语义
- 如果应用层问题没先收敛，协议层 patch 的收益很难验证

### 8.4 明确不带

- 主屏语义改造
- shell serializer
- 大输出和 detail panel 重构

### 8.5 固定验证场景

1. WezTerm
2. kitty
3. JetBrains 终端
4. tmux / SSH
5. Terminal.app 或未命中 allowlist 的终端

### 8.6 Done 定义

- 已支持终端的可见帧撕裂下降
- 未纳入 allowlist 的终端不出现退化
- Buffer / callback 语义不变
- JetBrains 若未进入 allowlist/probe 成功路径，则至少验证“不退化”，不宣称已修复

## 9. 为什么不再继续往下合

压到 4 条以后，我不建议再继续合并：

1. **不要把 `PR-3` 合进其他 PR**
   窄屏 / shell 问题的验证方法完全不同。
2. **不要把 `PR-4` 合进其他 PR**
   终端协议层需要单独灰度和单独回滚。
3. **不要把 `PR-1` 和 `PR-2` 合并**
   合起来就会重新变成一个“主屏语义 + 大输出表面 + detail panel + budgeting”的超大 PR，review 会再次失焦。

## 10. 统一 PR 模板

每条主 PR 都建议强制使用同一模板：

1. **Problem Class**
   - 本 PR 关闭哪一类用户问题
2. **Linked Issues**
   - 只链接与这一类问题直接相关的 issue
3. **Scope**
   - 明确文件和模块
4. **Non-goals**
   - 明确故意不带什么
5. **Reference**
   - 若借鉴 `#3013` / Gemini CLI / Claude Code，写清楚借鉴点
6. **Validation**
   - 固定复现场景
7. **Rollback**
   - 开关或失败信号

## 11. 最终建议

如果现在就要进入真实实施，我建议按下面的 4 条主 PR 推进：

1. `PR-1`：主屏闪烁基础修复
2. `PR-2`：大输出与详情展开稳定性
3. `PR-3`：窄屏 / interactive shell 专项
4. `PR-4`：终端协议层残余闪烁收尾

在这 4 条之后，再进入两个 follow-up：

5. `Follow-up-F1`：通用 tool budgeting
6. `Follow-up-F2`：markdown-heavy 输出降峰与 parser/block 层优化

这样数量比 8 条明显更可执行，但还没有退回到“一个巨大 PR 试图一口吃掉所有闪屏问题”的老路。

如果下一步准备直接进入实现，请按顺序使用：

1. [11-pr1-implementation-checklist.md](./11-pr1-implementation-checklist.md)
2. [12-pr2-implementation-checklist.md](./12-pr2-implementation-checklist.md)
3. [13-pr3-implementation-checklist.md](./13-pr3-implementation-checklist.md)
4. [14-pr4-implementation-checklist.md](./14-pr4-implementation-checklist.md)
