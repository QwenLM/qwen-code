# TUI 优化方案总览

> 本文档是 qwen-code TUI 优化的整体方案概览，详细设计分别见三个子文档。

## 1. 背景与动机

qwen-code 的 TUI 层基于 **Ink 6.2.3 + React 19** 构建，当前面临三个系统性挑战。下列问题需要先用源码口径校准后再实施，避免优化目标与真实瓶颈错位：

1. **启动性能**：启动流程包含多段串行初始化；交互式模式下 `config.initialize()` 在 UI 首次渲染后执行，配置 MCP Server 时工具声明和实际可用性仍会被慢 Server、工具注册刷新和 Gemini tools 更新路径影响
2. **屏幕闪烁**：Ink 的全量重绘机制导致流式输出时严重闪烁，在 tmux/SSH 环境下尤为突出（社区报告高达 4,000-6,700 次/秒的滚动事件）
3. **渲染能力与可扩展性**：自定义正则 Markdown 解析器功能受限，缺少 LaTeX 数学公式、终端超链接等支持；主题系统默认 hex 主题可能影响透明背景终端

这些问题在 GitHub Issues 中被大量报告（qwen-code#1778, #2748, #2877; claude-code#9935, #37283, #14641 等），是当前最主要的用户体验痛点。

**重要校准**：当前启动分析器只覆盖 UI render 之前的 checkpoint，尚未覆盖交互式 `config.initialize()`、MCP 首个工具注册、全部 MCP 发现完成、Gemini tools 声明刷新等阶段。因此本文档的实施顺序必须先补观测，再用真实数据确认优先级。

## 2. 现状分析

### 2.1 当前架构

```
Entry (gemini.tsx)
  -> Ink render() 挂载 React 组件树
    -> AppContainer (状态管理中枢, ~2400行)
      -> DefaultAppLayout
        -> MainContent (Static/Dynamic 分离)
          -> MarkdownDisplay (自定义正则解析器)
          -> CodeColorizer (lowlight 语法高亮)
          -> TableRenderer (Markdown 表格)
        -> Composer (输入区)
```

| 模块     | 技术方案                          | 关键文件                                               |
| -------- | --------------------------------- | ------------------------------------------------------ |
| 渲染框架 | Ink 6.2.3 (npm 库) + React 19     | `packages/cli/src/gemini.tsx`                          |
| Markdown | 逐行正则解析器                    | `packages/cli/src/ui/utils/MarkdownDisplay.tsx`        |
| 代码高亮 | lowlight (基于 highlight.js)      | `packages/cli/src/ui/utils/CodeColorizer.tsx`          |
| 防闪烁   | stdout 拦截器，折叠重复 ANSI 序列 | `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts` |
| 主题     | ThemeManager 单例，15+ 内置主题   | `packages/cli/src/ui/themes/theme-manager.ts`          |
| MCP      | 跨 Server 并行发现；整体仍等待全部完成，默认 10 分钟超时；工具注册和 Gemini tools 刷新需要拆开设计 | `packages/core/src/tools/mcp-client-manager.ts`        |
| 启动分析 | 环境变量开启的 checkpoint 记录器；当前主要覆盖 render 前阶段 | `packages/cli/src/utils/startupProfiler.ts`            |

### 2.2 竞品分析：Claude Code

Claude Code 使用**自研的 Ink 深度定制版本**（非 npm 库），包含以下关键优化：

| 能力     | Claude Code 实现                      | qwen-code 现状     |
| -------- | ------------------------------------- | ------------------ |
| 渲染缓冲 | 前后双缓冲 + diff patch               | 无，每帧全量输出   |
| 同步输出 | CSI BSU/ESU 原子帧更新                | 无                 |
| 硬件滚动 | DECSTBM 滚动区域                      | 无                 |
| 布局检测 | 布局稳定时窄范围 diff，变化时全量重绘 | 无 diff，始终全量  |
| 样式池化 | StylePool 整数 ID 内化 + 转换缓存     | 无，每次重新计算   |
| Markdown | marked 库 + LRU 令牌缓存（500条）     | 自定义正则，无缓存 |
| MCP 启动 | 提前并行启动 + Promise.race 超时      | UI 渲染后初始化，跨 Server 并行但整体等待 |

### 2.3 社区反馈汇总

| 问题类别   | 代表性 Issues                                   | 严重程度 |
| ---------- | ----------------------------------------------- | -------- |
| 屏幕闪烁   | qwen-code#1778, #2748; claude-code#9935, #37283 | 高       |
| 启动慢     | qwen-code#2748; claude-code#5653, #29201        | 高       |
| 表格渲染   | claude-code#14641, #22311；qwen-code 当前已有 ANSI/CJK 回归测试，需以可复现缺陷为准 | 中       |
| 主题/颜色  | qwen-code#2877; claude-code#34702, #15771       | 中       |
| 窄屏问题   | claude-code#13504, #18493, #5408                | 中       |
| LaTeX 支持 | claude-code#21433                               | 低       |

## 3. 三大工作流概览

| 工作流         | 核心问题                               | 关键指标                       | 依赖关系                   |
| -------------- | -------------------------------------- | ------------------------------ | -------------------------- |
| **观测基线**   | 现有 profile 不覆盖 render 后初始化和输出层 | first paint、TTI、MCP 首工具、stdout writes/sec | 所有优化的前置条件 |
| **启动性能**   | 串行启动流程；MCP 工具声明刷新不完整       | first paint、input enabled、首个 MCP 工具可被模型使用 | 依赖观测基线             |
| **屏幕闪烁**   | Ink 全量重绘；无同步输出               | 闪烁事件/秒，stdout writes/sec、clearTerminal 次数 | 依赖输出层观测   |
| **渲染与扩展** | 正则解析器脆弱；缺少格式支持；主题限制 | 格式覆盖率，parse/highlight 耗时，可配置性 | 依赖稳定输出层 |

**执行顺序**：观测基线 -> 屏幕闪烁低风险治理 -> 启动/MCP 渐进可用 -> 渲染缓存与扩展。MCP 与渲染可并行推进，但必须共享同一套指标口径。

## 4. 分阶段实施计划

### Phase 0：观测基线（第 1 周）

| 变更 | 工作流 | 风险 | 预期收益 |
| ---- | ------ | ---- | -------- |
| 扩展 startup profiler：first paint、input enabled、`config.initialize()`、首个/全部 MCP 工具、Gemini tools 刷新 | 性能 | 低 | 避免用 render 前指标误判启动瓶颈 |
| 为 stdout 输出层增加 counters：writes/sec、bytes/sec、`clearTerminal` 次数、eraseLines 优化次数、BSU/ESU 平衡 | 闪烁 | 低 | 后续防闪烁方案可量化验收 |

### Phase 1：快速见效（第 2-5 周）

| 周次 | 变更                                                        | 工作流 | 风险 | 预期收益                          |
| ---- | ----------------------------------------------------------- | ------ | ---- | --------------------------------- |
| 2    | 同步输出 DECSET 2026（先 instrumentation，再默认开启或特性开关） | 闪烁   | 中   | 消除大部分可见帧撕裂              |
| 2    | 流式更新节流（content + thought；结束/取消/工具调用时立即 flush） | 闪烁   | 低   | stdout.write 从 50+/秒降至 <20/秒 |
| 3    | Markdown token/block 缓存（不缓存 ReactNode）               | 渲染   | 低   | 缓存命中时解析耗时显著下降        |
| 3    | 代码高亮缓存 + `highlightAuto` 限制/预热策略                | 渲染   | 中   | 重复渲染消除，降低大块代码成本    |
| 4    | `loadSettingsAsync` 渐进引入，保留同步 wrapper              | 性能   | 中   | 配置加载耗时降低，避免大范围破坏  |
| 5    | 并行化 UI 前初始化（i18n 与 config 并行 + auth 与其他并行） | 性能   | 低   | 启动时间减少 200-400ms            |
| 5    | ANSI 16 色默认主题检测                                      | 渲染   | 中   | 改善透明终端兼容性                |

### Phase 2：架构改进（第 5-10 周）

| 周次 | 变更                                 | 工作流 | 风险 |
| ---- | ------------------------------------ | ------ | ---- |
| 6-7  | 渐进式 MCP 可用性 + Gemini tools debounce 刷新 | 性能   | 中   |
| 7    | 动态内容高度阈值优化 + 现有渐进提升增强 | 闪烁   | 中   |
| 7-8  | 切换到 marked 解析器（特性开关）     | 渲染   | 中   |
| 8-9  | 智能 refreshStatic()（定向更新）     | 闪烁   | 中   |
| 9-10 | OSC 8 终端超链接                     | 渲染   | 低   |
| 10   | 产物体积优化                         | 性能   | 中   |

### Phase 3：深度结构性改造（第 11-16 周）

| 周次  | 变更                            | 工作流 | 风险   |
| ----- | ------------------------------- | ------ | ------ |
| 11-13 | 双缓冲 + diff patch（Ink 扩展） | 闪烁   | 高     |
| 13-15 | 消息历史虚拟滚动                | 渲染   | 高     |
| 15-16 | LaTeX/数学公式渲染              | 渲染   | 中     |
| 远期  | Web 渲染探索（混合架构）        | 渲染   | 探索性 |

## 5. 向后兼容策略

- **环境变量**：`QWEN_CODE_LEGACY_RENDERING=1` 可整体关闭所有渲染优化
- **已有兼容**：`QWEN_CODE_LEGACY_ERASE_LINES=1` 保留用于擦除行优化的回退
- **主题**：仅默认选择变更，所有 hex 颜色主题保留可用
- **解析器**：特性开关控制，旧解析器作为过渡期回退
- **MCP**：所有 Server 快速响应时行为等价；慢 Server 不再阻塞快 Server，但工具声明只保证从下一次模型请求开始生效

## 6. 验证策略

1. **自动化基准测试**：启动分段耗时、渲染时间、stdout writes/sec、stdout 字节/帧
2. **多终端视觉测试**：iTerm2、Terminal.app、WezTerm、kitty、Windows Terminal、tmux
3. **回归检测**：滚动启动 profile 对比；MCP 首工具/全工具可用时间对比
4. **边界场景**：窄终端 (< 40 列)、超长输出 (5000+ 行)、CJK 内容、tmux/SSH
5. **特性开关**：Phase 2+ 所有变更可安全回滚

## 7. 子文档索引

| 文档                                                             | 说明                        |
| ---------------------------------------------------------------- | --------------------------- |
| [01-performance.md](./01-performance.md)                         | 启动性能与 MCP 优化详细设计 |
| [02-screen-flickering.md](./02-screen-flickering.md)             | 屏幕闪烁问题分析与解决方案  |
| [03-rendering-extensibility.md](./03-rendering-extensibility.md) | 渲染性能与可扩展性设计      |
