# TUI parity CI 效率优化

[English](2026-10-24-tui-parity-ci-efficiency.md) | [简体中文](2026-10-24-tui-parity-ci-efficiency.zh-CN.md)

## 问题与范围

原有源码 TUI 工作流几乎为所有 package 改动运行两个重型 job。排除纯 Java 服务和 Companion 源码修改可以减少一部分无关失败，但没有区分组件修改与运行时基础改动。同时，夜间调度只运行安装验收，不运行源码 parity 和 no-flicker 套件。

此次修改将组件检查、按机制选择的交互专项和全量验收分开。只改变 CI 选择，不改变产品行为或测试断言。保留原有源码检查名称、runner 信任边界、CLI-only 构建、运行时/渲染器组合和安装分发矩阵。在观察实际 CI 运行之前不承诺提速幅度。

## 设计决策

### 调度与升级

- PR 保留仓库现有单测、类型与构建检查。TUI 工作流根据 diff 选择组件检查与受影响的交互组，而不是为每个 package 改动自动执行全部交互。独立的 `ci.yml` no-AK 集成通道仍在 PR 上运行部分输入/编辑器/状态栏测试；本次不删除这些覆盖，也不声称所有 TUI 集成测试都移出 PR。
- 每天北京时间 03:17（UTC cron 为 `17 19 * * *`）运行全部源码 TUI 套件，以及已有安装验收和分发矩阵。GitHub 调度可能延迟，这不是准点启动保证。
- `workflow_dispatch` 在所选 ref 上执行相同的全量选择。维护者应在发布候选版本或跨多个机制的 TUI 改动交付前手动运行。本次不增加发布工作流依赖、分支保护要求或标签驱动的特权执行入口。
- 已知的渲染器/运行时基础层、共享构建与测试设施改动，在 PR 阶段保守选择源码全量验收。普通 package 或 core 改动本身不等于全量。
- 依赖影响未知不代表没有 TUI 影响。未分类改动保守保留组件检查，明确记录选择原因，并允许维护者手动升级全量。夜间全量覆盖有意从 PR 阶段延后的部分。

### 影响分类

通过分页 GitHub PR-files API 判定，不在分类器中检出 PR 代码。重命名同时检查当前与旧路径，合并所有选中的组，不依赖文件顺序。映射保持少量显式规则；它是影响选择策略，不是完整静态依赖图。

| 分组        | 保护的行为                                                            |
| ----------- | --------------------------------------------------------------------- |
| Component   | 已有 Ink/OpenTUI 组件一致性检查；仅组件选择不打包产品、不运行交互矩阵 |
| Render      | 产品迁移、viewport 测试设施和状态栏行为，以及 no-flicker 门禁         |
| Input       | 输入归属、编辑器/取消行为和剪贴板来源                                 |
| Integration | 前台 shell/PTY 归属与取消、扩展获取和双输出                           |
| Recovery    | 持久会话恢复和冷启动 checkpoint 恢复                                  |

Core 的 turn 调度、取消、shell 执行、会话持久化和遥测即使不在 UI 目录下，也是这些行为的输入。已知共享机制可以同时选择多个组。每个选中的产品专项保留已有 `node:ink`、`bun:ink`、`bun:opentui` 三腿、整文件测试、零重试与严格未处理异常策略。Viewport 测试属于集成测试设施检查，不是快速产品单测。

无关路径排除覆盖文档、Java 服务、Companion 源码，以及 TUI 构建/测试闭包之外的全部包目录：Web Shell、Chrome 扩展、mobile-mcp、qwen-live、external-context、external-context-mem0、test-failure-explorer，pnpm workspace 本身就排除的 desktop、live-host 和 mobile-shell，完全不带 workspace 清单、因而不在清单审计视野里的 Java、Python 与 Zed SDK 目录，以及进入 CLI 闭包的唯一路径是 `node-repl` 运行时 import、`--cli-only` 过滤器不会跟随的 CUA driver 目录。闭包按 workspace 清单对照 `--cli-only` 构建过滤器及根目录依赖审计得出，不带清单的目录因此是手工补入的，而 `esbuild.config.js` 里硬编码的入口与 `scripts/copy_bundle_assets.js` 的拷贝是这份审计看不见的输入。Web Shell 是唯一刻意超出纯闭包成员资格的排除：`web-templates` 的 transcript 打包会构建它，但没有任何 TUI 套件渲染该打包产物，且 ci.yml 负责 Web Shell 的构建与 E2E 健康。`external-context` 同样仍会被构建：`npm run bundle` 的硬编码 esbuild 入口会把它编进 `dist/mem0`，凡走打包的 lane 都会执行，但没有任何 TUI 套件运行该产物。Companion 清单、打包配置和 scripts 仍不在 Companion 排除范围内。被排除的清单文件不损失独有覆盖：仅改清单导致共享 frozen-lockfile 安装失败时，每个工作流的安装步骤都会失败；伴随根 lockfile 变更仍会选择全量验收。工作流级路径过滤继续覆盖共享构建输入和全部 package；纯文档 PR 可以完全不启动该工作流。

### 失败与证据契约

- 文件数量缺失或不一致、达到 API 的 3,000 文件上限、API 读取错误，都必须显式让影响判定失败，不能静默输出跳过或绿色选择。除非取消，下游源码 job 保守回退到全量；分类失败本身仍然可见。
- 在 job summary 中记录所选分组和升级原因。不把 PR 可控文件名插入 shell 命令。产品测试名称来自固定脚本列表。
- 保留按运行尝试区分的现有产品产物和 fixture 隔离。仅在产品交互或 checkpoint 测试实际需要时打包。
- 夜间失败继续走已有 `Main CI Failure Issue` 上报：`main` 上 `tui-parity` 的 schedule 失败可创建或复用 issue。相同失败签名复用跟踪单；首次纯基础设施失败可先重跑。该上报器不为 PR 和手动 TUI 失败自动建单。本次无需新增写权限。
- 只取消同一 PR 的过期运行。夜间和手动运行继续使用唯一 run ID 并发组，不会被后续 PR 更新取消。

## 约束与后续工作

本次不并行三组产品运行，也不增加 runner job。集成测试 setup 共享生命周期状态，ECS 池也可能同时运行多个 job；并行化需要先实现 home/cache/setup 独立隔离并取得争用场景实测证据。跨 job 共享构建产物仍暂缓，因为原生依赖兼容性会扩大修改范围。

Companion 排除范围仍保持保守：Web Shell 构建会调用 `vscode-ide-companion/scripts/generate-notices.js`，共享的 frozen-lockfile 安装也会读取 Companion 清单。相反，`copy-bundled-cli.js` 消费已经构建好的 CLI，不是 CLI 构建输入。保留非源码 Companion 路径参与分类，不代表每个这样的文件都会影响门禁。README、资源或扩展专用构建文件的进一步排除仍留待后续。

针对新增分类器、逐 step 选择条件和专项运行脚本，按工作流实测字节数更新其自身大小基线。分类器保留内嵌，以便只读 job 不需要检出代码或新增执行权限；不提高全局增长额度或绝对上限。

路径选择可能遗漏新引入的跨模块依赖。新增共享 TUI 机制时需要更新映射和代表性契约测试。夜间覆盖和维护者手动全量可以缓解风险，但不能使 PR 专项等同全量验收。分支保护与发布自动化仍是独立维护决策；在某个 ref 上手动运行不会自动成为 PR 的必需检查。

## 验证与验收

- 执行工作流中的真实分类器，覆盖无关、仅组件、每个机制组、混合组和基础层改动。包括真实受跟踪路径、双向重命名、与顺序无关的并集和分页列表。
- 用不含 PR payload 的 schedule 和 dispatch 验证所有源码分组与安装验收运行。注入不完整数量与 API 失败：分类器必须报告失败并保留全量回退。
- 验证输出到 job、输出到 step 的条件，而不只检查分类器布尔值。仅组件 PR 不得打包或运行交互；仅恢复选择必须运行 checkpoint 恢复而不运行 no-flicker；全量模式必须在原所属通道保留每个原有套件。
- 保留严格失败处理、运行时矩阵、串行执行、检查名称、CLI-only 构建、取消和产物契约。已有安装验收与失败上报测试继续通过。
- 运行聚焦脚本测试、YAML/actionlint、格式与 ESLint 检查。前置条件允许时执行产品构建/类型检查，并区分环境失败与调度回归。本地选择测试不是托管 Actions 执行，也不能证明 runner 耗时下降。

UI 验收不适用：不修改产品源码或交互。托管 job 跳过、排队耗时、定时执行和真实 issue 发布需要提交后的运行观测，不能从本地测试推断已完成。
