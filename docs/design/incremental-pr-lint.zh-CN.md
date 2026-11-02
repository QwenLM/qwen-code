# PR 增量 lint 与静态检查构建复用

[English](incremental-pr-lint.md) | [简体中文](incremental-pr-lint.zh-CN.md)

## 问题与范围

目前 PR lint 扫描整个仓库。静态检查任务安装依赖时还会通过 prepare 钩子构建、打包全部 workspace，随后 bundle 闭包检查又会清理并重新构建 CLI 的依赖闭包。在运行 39977456043 中，包含生命周期脚本的依赖安装用了 563 秒；这个数字不能区分下载与构建分别用了多久。

本次修改针对文件级 lint 和重复构建。跨包依赖检查、生成产物检查、运行时依赖审计及辅助脚本测试继续执行。不调整 runner 并发或必需检查策略。

## 设计

只有 PR 设置 `LINT_BASE_SHA`。有界 fetch 获取 base/head 各 100 个提交的历史；祖先缺失，或唯一共同祖先之上仍有浅边界时，才按固定上限逐次 deepen。共同祖先有歧义时立即停止 deepen，因为更多历史不能使其变得唯一。该循环回退时，都明确报告原因（达到上限、deepen fetch 中止或共同祖先有歧义）、成功完成的 deepen 次数与达到的 base 历史深度。按本仓库的合并速率，固定窗口约一天就会过期，长寿命 PR 会因此静默走全量；该步骤排在对 base ref 或共同祖先做浅取的两步之后，因为对 base tip 的深度 1 fetch 会把范围所指向的那个提交本身 graft 掉，之后 `merge-base` 失败回退全量，而这些 PR 会在毫无提示的情况下付出全量扫描的代价——现在历史原因的回退会以 workflow warning 和 step summary 的形式明确报告，与常规的配置回退区分开。该 fetch 不取 blob（`--filter=blob:none`），因为范围选择只读取 commit 与 tree，而未加过滤的 fetch 可能在与更早的 blobless 步骤留下的缺失 blob 做 delta 解析时失败。lint 范围辅助脚本使用可证明的共同祖先与 NUL 分隔的 Git 文件列表。历史不可用或有歧义时回退全量。删除路径参与配置失效判断，但不传给文件检查器。重命名文件按新路径检查。选择是按文件进行的，这只有在每条启用的 import 规则都只评估单个文件时才成立（`import/no-internal-modules`、`import/no-relative-packages`、`import/no-extraneous-dependencies`、`no-restricted-imports`）；若启用 `import/no-cycle` 这类跨文件图规则，需要重新审视此处的选择范围。

ESLint、Prettier 和 YAML 检查选择变更的完整文件。Prettier 从最近的、带有 Prettier 配置或忽略文件的祖先目录运行，因此没有嵌套配置的 diff 只需一次进程启动，而不是每个目录一次（启动开销有限但真实：实测每次冷启动约 0.24 秒，相对 37 秒的全仓运行，约 154 个变更目录才打平；近期 diff 远低于这个量级——#15524 统计中位数 3、最大 39——所以常见收益约半秒，而宽范围扫动不再按目录逐个付启动开销）。Shell 相关变更调用现有全量 ShellCheck，以保留被 source 脚本的覆盖；无关变更跳过。旧输出管道会吞掉检查器失败状态，因此严格执行 ShellCheck 失败需单独清理历史基线。workflow/action 变更保留全量 actionlint，因为可复用工作流存在跨文件契约。lint 规则、配置、忽略文件、依赖或 lint 实现变化时恢复全量检查。非 PR 事件继续全量。没有相关变更文件时明确记录跳过；diff 失败绝不能当作空列表成功通过。

lint 安装步骤单独设置 `QWEN_SKIP_PREPARE=1` 和 `QWEN_SKIP_NOTICE_GENERATION=1`。保留依赖生命周期脚本与 patch-package。已有的干净 CLI 构建及 bundle 闭包检查移到文件 lint 之后、i18n、schema 和 notice 检查之前，产物供后续检查使用。测试任务保留正常 prepare。两个主要 hosted 任务复用已有 pnpm store 缓存 action；self-hosted store 继续使用现有路径。

## 验证与验收

使用真实临时 Git 仓库验证普通修改、重命名、删除、特殊文件名、配置失效和不完整历史，验证命令失败能够向上传播。在跳过 prepare 安装的独立 checkout 中运行真实 lint 与静态检查流程，避免旧产物掩盖构建依赖缺失。确认生成的 schema 和 notices 没有变化，并运行受影响的工作流与脚本测试。

上线后在同类 runner 上对比耗时。本地耗时与历史 563 秒安装时间不构成 CI 提速承诺。main 上的全仓检查继续为增量选择范围之外的跨文件影响兜底。
