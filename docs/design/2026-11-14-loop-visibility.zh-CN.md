# Loop 可见性（B 块，切片 3）

[English](2026-11-14-loop-visibility.md) | [简体中文](2026-11-14-loop-visibility.zh-CN.md)

- **状态**：实现中。
- **跟踪**：#17045 B 块切片 3。由 `2026-11-12-loop-rollout-switches.md`（切片 3）规定；切片 1–2 已合入（#17050、#17055），切片 4 已由 #17172 交付。
- **核对提交**：upstream `0de9ca2d91`（2026-11-14）。

## 问题

按入口开关（切片 2）决定某入口跑哪条 loop，但一次运行并不说明自己走了哪条 loop，操作者也看不到解析结果：

1. **没有统一的路径标记。**共享 loop 各入口记的是临时标记（`runModelRound on the shared agent loop`、`[ACP] model round …`、`[AgentCore] subagent …`），内核记 `[EVENT_BUS] runAgentLoopOnBus started`，而 **legacy 路径什么都不记**。各入口措辞不一，无法从 debug 日志统一证明一次运行的路径。
2. **`/about` 与 `/bug` 不报 loop。**两者都不说明当前入口解析到哪条 loop，操作者提 bug 时无法判断会话跑的是 legacy、shared 还是 kernel。

## 拟议改动

### Core：一份路径解析、一个标记

- `Config.getAgentLoopPath(surface): 'legacy' | 'shared' | 'kernel'` 从入口所用的**同一对** getter 推导路径：`!isUnifiedAgentLoopEnabled(surface)` → `legacy`；否则 `isEventBusAgentLoopEnabled(surface)` → `kernel`；否则 `shared`。不复制第二份 env/设置/默认值规则。
- `logAgentLoopEntry(config, surface)` helper（core，走内核 `[EVENT_BUS]` 同款 `debugLogger` 通道）记一行，写明入口与解析路径，如 `[LOOP] headless legacy`。每个入口在读取 loop 开关处（其 loop 入口）调用，含 legacy 路径。

### `/about` 与 `/bug`：一行共享

- `ExtendedSystemInfo` 增加 `agentLoop?: string`（如 `headless: legacy`）。
- `getExtendedSystemInfo` 由**当前入口**计算：执行模式决定——`non_interactive` → `headless`、`acp` → `acp`、`interactive` → 实际渲染器（`selectTuiRenderer` → `ink`/`opentui`）。`SystemInfoContext` 增加可选 `executionMode`，设置对话框（无执行模式）则省略该行。
- `getSystemInfoFields` 增加「Agent Loop」字段，`/bug` 与交互式 `/about`（AboutBox）自动获得；非交互 `/about` 的行也加上。

## 关键设计决策

| 决策                                          | 理由                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| 路径由既有 getter 推导，不复制新规则          | 设计要求该行用入口所用的同一解析；第二份副本会漂移。         |
| 标记在 loop 决策点、含 legacy                 | 使每个入口的路径可证明；legacy 目前什么都不记。              |
| 当前入口由执行模式 + 实际渲染器判定           | `/about`/`/bug` 在某模式下运行；交互入口即实际服务的渲染器。 |
| `executionMode` 在 `SystemInfoContext` 上可选 | 设置对话框只传 config+settings；省略该行而非臆测入口。       |

## 涉及文件

- `packages/core/src/config/config.ts` — `getAgentLoopPath`。
- `packages/core/src/config/agent-loop-rollout.ts`（或一个小的 core util）— 标记 helper。
- 各入口 loop entry：`nonInteractiveCli.ts`、`use-llm-stream.ts`、`live-session.ts`、`Session.ts`、`agent-core.ts`、`speculation.ts`。
- `packages/cli/src/ui/systemInfo.ts`、`systemInfoFields.ts`、`commands/aboutCommand.ts`、`components/AboutBox.tsx`（经 fields）。

## 范围边界

- 不改开关解析规则或默认值（切片 2，已合入）。
- 不加新设置；该行是只读诊断。
- 标记仅 debug 日志（除该行外无用户可见输出变化）。

## 已解问题

- 标记粒度：在各入口读取 loop 开关处记录。真实环境已证 headless 与 agent-core 每轮次一次（debug 日志计数 = 1/轮次）；ink 每模型轮读取开关，故其标记为每轮一次。`[LOOP]` 措辞与对拍套件所计数的标记不同，其计数不受影响（已在 shared 臂 debug 日志核对）。
