# ACP Extension watcher：首会话测量

[English](acp-extension-watcher.md)

本次修改让 ACP 进程跳过交互终端使用的 Extension 文件 watcher。daemon 已管理资源刷新生命周期，交互终端仍会构造该 watcher。这是首会话优化的第一阶段，**不能证明首个新会话已经低于 500 ms**。

## 修改与制品来源

baseline 为 main 提交 `2985fef4e9b9393601141c16031b2ba039181158`；实际测量的 candidate 为仅修改 watcher 的提交 `2aadc4b127ec24074e0e5ddfd402e978a0c43f5d`。生产代码只增加一个 ACP 模式判断。单元测试覆盖 `--acp`、`--experimental-acp`，以及交互模式仍构造 watcher 的对照。本 PR 不包含 Core 初始化、资源选择、提示词、鉴权、MCP 策略或预热实现修改。

两套 bundle 的 CLI 版本均为 0.27.2。发起请求的 TypeScript 包为 `@qwen-code/sdk` **0.1.32**。每次运行前后记录 SDK 包版本及入口 hash，并在整个测量队列前后校验 baseline、candidate、编译后 SDK 的完整文件树摘要。candidate 在独立 worktree 中使用锁定的 pnpm 11.24.0 安装，完成全量 build、typecheck 和 bundle。

## 工作负载与计时边界

私有实际安装清单包含 31 个资源：14 个 Extension 套件及 17 个独立 Skill，共 90 个自定义 Skill、3,944 个文件、81,931,741 字节。每个样本都在区分大小写的本地文件系统中完整复制同一资源清单。资源名、源文件、业务内容、清单、本地路径、标识符及原始日志均保留在本地；本文只公开聚合数量和时延。

执行配置保留 hooks，将 MCP allowlist 设为空列表，不发送 prompt、模型请求或业务工具调用，也不连接配置中的外部 MCP 服务。安装后的原生激活状态在不计时的 fixture 准备阶段播种。因此本次测量代表**已经安装并激活**的资源、新进程及新会话状态，不能声称所有资源派生缓存都为空。fixture 创建、文件复制、原生激活播种、bundle 构建和 SDK 模块导入均在两种时钟开始前完成。

每个样本使用独立 HOME、runtime 目录、TMPDIR、持久化会话目录，以及初始为空的 Node compile-cache 目录。daemon 经真实的嵌入式 HTTP-bridge 入口启动，明确设置 `preheatBridge: false`。驱动等待 `runtimeReady`，在首次 SDK 调用之前确认业务会话数为零、ACP channel 不存在；此前没有 HTTP readiness 或 capabilities 请求。每次以全新 UUID 创建 thread，响应必须回显 UUID 且 `attached: false`。随后另外两个全新 UUID 调用验证后续新会话行为。

就绪请求边界在构造 SDK client、生成调用方 UUID 之前记录，这两项不计入主 create 时钟。

主时钟包住完整的 `await client.createOrAttachSession(...)`，包括能力发现、session POST、响应 JSON 解析及 SDK 身份校验。首个 HTTP 请求是 `GET /capabilities`，它自身的耗时**不是**新会话耗时。三个调用都保存实际 HTTP 顺序，不能假定后续调用省略能力检查。

报告同时给出 session POST、daemon 进程 spawn 到 daemon-ready 请求边界、daemon spawn 到首个 SDK 结果的完整时钟。等待 daemon 就绪不会创建 ACP 进程：每个观测到的 ACP spawn 都必须晚于 SDK 调用开始及首个 HTTP 请求，daemon 状态必须显示 preheat `not_scheduled`。正式样本没有 CPU profiler、主动 compile-cache flush、禁用子进程 compile cache、人为 sleep 或启动诊断探针。

## 正式结果

**首个完整 SDK create 中位数从 1096.1 ms 降至 772.9 ms，减少 323.2 ms / 29.48%。candidate 每个样本仍高于 500 ms。**

下表单位均为毫秒，以中位数（最小值–最大值）表示，每组八个独立首会话。两组均完成 8/8 次尝试，各创建 24/24 个新会话，没有排除任何正式样本。

| 时钟                           |               baseline |           watcher-only |
| ------------------------------ | ---------------------: | ---------------------: |
| 首个完整 SDK create（主指标）  | 1096.1 (1078.3–1129.3) |    772.9 (758.4–824.1) |
| 首个 session POST + JSON       | 1075.7 (1058.8–1109.2) |    754.1 (739.3–798.5) |
| daemon spawn → 观察到 listener |    336.7 (322.5–341.5) |    329.2 (323.1–358.5) |
| daemon spawn → 就绪请求边界    |    630.6 (618.7–644.5) |    605.3 (591.8–621.0) |
| daemon spawn → 首个 SDK 结果   | 1731.0 (1709.6–1748.0) | 1384.5 (1355.5–1427.0) |
| 首个 capabilities GET + JSON   |       18.7 (17.7–28.1) |       18.3 (18.1–25.1) |
| 首个 HTTP → ACP spawn          |       14.2 (13.9–22.3) |       14.2 (14.1–24.6) |
| 第二个完整 SDK create          |       71.1 (65.1–79.6) |       74.0 (65.2–80.0) |
| 第三个完整 SDK create          |       56.9 (53.7–63.7) |       54.4 (53.4–56.6) |

按成对轮次列出的首个完整 SDK create 样本：

| 轮次 | baseline | watcher-only |
| ---- | -------: | -----------: |
| 1    |   1098.5 |        758.4 |
| 2    |   1078.3 |        771.1 |
| 3    |   1129.3 |        807.8 |
| 4    |   1110.2 |        760.1 |
| 5    |   1082.6 |        767.9 |
| 6    |   1089.2 |        774.8 |
| 7    |   1093.7 |        789.0 |
| 8    |   1110.5 |        824.1 |

[公开数字摘要](acp-extension-watcher-results.json) 包含全部正式样本、平均数、中位数、范围、compile/build 文件树摘要及成败计数。它按显式字段白名单生成，不包含私有资源清单、源内容、本地路径、UUID、token 或原始日志。

此前六次尝试因临时 fixture 卷空间耗尽而中止，其中五次完成、一次会话初始化失败；失败日志包含创建 runtime 目录时的 `ENOSPC`。六组进程全部正常关闭，整个队列连同已完成时延全部排除。随后使用独立、更大的区分大小写卷，重新准备十六份完整新 fixture，再开始正式队列。失败证据保留在本地，没有通过静默重试混入结果。

八轮成对实验串行运行，按 A/B、B/A 交替顺序。全部 fixture 在独占测量窗口开始前准备完毕。本任务在窗口内没有并发 build、fixture 复制、其他 benchmark 或测试。没有清空操作系统文件缓存；这是单机上新进程、新会话的测量，不是冷磁盘测量。每组八个样本不足以形成生产尾延迟保证。

主机为 macOS 26.6.2、arm64，Node.js v26.7.0。这是基于私有预发实际安装清单的本地隔离重建，不是生产或真实预发实例的线上延迟。500 ms 目标针对首个完整 SDK create，本 PR 之后仍需继续优化。

## 功能验证与边界

独立功能验证使用冻结的 baseline 与 watcher-only bundle，以及同一套完整安装资源。部分验证之前有 health/helper 调用，因此不纳入正式性能队列。

- 两组均通过 41/41 项外部变更断言和 18/18 项激活、生命周期断言。
- 在 fixture 路径和 UUID 对应后，八份 helper 快照、helper 后八份已有会话菜单、八份新建会话菜单，以及十一份生命周期快照全部相同。
- 普通读取保留观测到的传播差异：完整 workspace-Skill envelope 为 29/32 相同，Skill 内容为 31/32，已有会话 commands 为 31/32。一次 atomic replace 的某个观察点 candidate 更早出现新内容，一次文件重建则 baseline 更早出现；后续采样或 normal helper 后收敛。Extension Skill 编辑、恢复在两组三秒观察窗口内都仍显示旧内容，helper 后正确。
- 两边均发出八个公开 SSE 事件，类型、阶段顺序相同；前七个对应 payload 相同，最后一个 reload payload 刷新同一组九个会话，但完成顺序不同。相等检查保留原数组顺序。
- 新会话响应自然包含不同 UUID、创建时间和 client 身份，其余响应字段相同。真正新建语义另外通过 UUID 回显和 `attached: false` 断言。

只统一 fixture/bundle 根、由这些根派生的 workspace 标识，以及 UUID 对应关系。另行报告的 workspace-Skill 业务比较排除观测时间和 age，原始 envelope 保持完整。没有删除缓存 stale/refreshing、激活状态、generation、Skill/command 任意字段或数组原顺序来制造一致。因此不能据此宣称传播时延完全相同，也不能宣称普通读取逐字节相同。

全部功能验证组均收到正常 close acknowledgement，以 code zero、无 signal 退出，且没有强制 fallback；最后的限定范围 OS 观察未发现匹配 benchmark 进程。正式性能样本另行逐个强制校验正常 close acknowledgement、零退出码、无强制 fallback，以及所有已记录 ACP 子进程 PID 消失。

CLI 目标单元测试 **129/129** 通过，全量 build、typecheck、bundle、改动文件 ESLint 及 Prettier 检查通过。交互模式仍创建 watcher 由单元测试对照覆盖；交互终端 UI 的端到端运行、Windows、Linux、模型执行、prompt 触发 hooks，以及外部 MCP 行为不在本次验证范围内。

## 使用公开合成资源复现

公开生成器自行编写通用资源，不读取或导出私有安装内容。它包含 14 套件、17 独立 Skill、90 个 Skill manifest，但字节数、目录形态、独立 Skill 放置位置、hook 定义及激活准备与私有负载不同。它可以复现测量流程、观察规模影响，不能复现或替代上方私有负载数字。

分别从对应提交执行 `corepack pnpm install --frozen-lockfile`、`npm run build`、`npm run bundle`，得到冻结的 baseline 和 candidate；公开复现已使用 Node.js v26.7.0 验证。固定 SDK 构建，测量前停止 build 和资源复制，串行交替运行两套 bundle。从本 checkout 执行，每个样本使用新的输出目录：

```sh
node scripts/benchmarks/acp-first-session/fixture.mjs /tmp/acp-synthetic-a /absolute/frozen-baseline/dist
node scripts/benchmarks/acp-first-session/fixture.mjs /tmp/acp-synthetic-b /absolute/frozen-candidate/dist

node scripts/benchmarks/acp-first-session/run.mjs /tmp/acp-synthetic-a/fixture.json
node scripts/benchmarks/acp-first-session/run.mjs /tmp/acp-synthetic-b/fixture.json
```

在测量队列开始前准备全部新 fixture。一份全新合成 smoke 完成三个 create 及无预热、身份、close、子进程退出、已记录输入 hash 检查；它用于验证流程，不向私有结果贡献任何性能样本。每次运行输出不含路径、仅包含数字和布尔值的摘要，在指定输出位置保留详细本地证据。合成资源没有 SessionStart hook；由于不发送 prompt，编写的 UserPromptSubmit hook 不执行。至少运行八组交错成对样本，保留失败，逐一检查 preheat、session、spawn、close 断言，并报告全部时钟。不要提交本地生成的 fixture 树或原始结果。

如果 shutdown 后记录的 ACP PID 仍存在，公开驱动会将结果标为失败，记录 cleanup error 供人工检查。操作系统可能复用 PID，无法据此证明进程身份，因此自动终止只针对驱动自己持有句柄的 wrapper 进程。

后续低于 500 ms 的工作必须减少首次 SDK 调用之后的初始化，并维持相同的无预热边界及功能验证。它与本次仅增加一行的 watcher 修改分开推进。
