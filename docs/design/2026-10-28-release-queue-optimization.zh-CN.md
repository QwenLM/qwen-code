# 缩短发布 runner 排队时间

[English](2026-10-28-release-queue-optimization.md) | [简体中文](2026-10-28-release-queue-optimization.zh-CN.md)

v0.26.3 的 Linux x64 音频预构建排队 74 分钟，执行仅 50 秒；产物汇总又排队
十分钟。发布验证已经使用 ECS，但原生构建仍在每次发布时重复执行，最终发布
任务也仍然在 GitHub-hosted runner 上重新构建整个应用。

## 复用音频预构建

该机制在[音频预构建复用](./2026-10-29-audio-prebuild-reuse.zh-CN.md)中单独描述，
本改动基于它：指纹、来源与保留期规则、选择与消费的分段，以及未命中时的回退，
都在那份文档里。下面的ECS 构建任务消费该机制选中的产物。

## 可选的ECS 构建交接

最终 npm 发布保留在 GitHub-hosted runner：npm OIDC trusted publishing 和
provenance 不支持普通 self-hosted runner。当
`ECS_RELEASE_HOST_RUNNER_ENABLED` 为 true 时，独立任务使用不限定架构的
`ecs-qwen-release-host` 标签，准备版本提交、构建 bundle 和工作区输出，并
构建及验证 standalone 压缩包。

该任务只有仓库只读权限，不持有发布凭据。通过同一次运行的 artifact 传递原始
版本提交与构建输出，使用 tar 保留可执行权限。hosted 发布方导入该提交、安装
依赖，并保留现有 pnpm/npm 发布逻辑和包生命周期校验。不能在发布方重新创建
版本提交，因为 bundle 内嵌了构建时的提交 SHA。

开关未设置时跳过新增任务，继续使用现有 hosted 构建路径，避免基础设施就绪前
增加一次 hosted 排队。保留生产环境保护、按发布 tag 串行执行的限制、禁止覆盖
已发布版本的检查、固定到 workflow 提交的辅助脚本、dry-run 语义，以及使用
PAT 创建 release 事件来触发下游 workflow 的机制。构建与音频预构建失败都要
进入现有失败报告流程。

## 范围与启用条件

在现有 ECS 机器上预留少量 runner 进程用于 release 调度。先使用 hz1-17 和
hz1-18，保留 `ecs-qwen-release-host`，移除 `ecs-qwen`，避免普通共享池任务
占用这两个槽位。同机其他 runner 继续使用；选定部署方式不要求重装或独占整机。

label 和工作区清理不是机器级安全边界。同机其他 runner 执行的 PR 代码仍可能
影响主机、发布产物和凭据。这是共享主机部署接受的信任取舍，不能表述成整机隔离。
npm 发布保留 hosted，现有 workflow/environment 保护和产物校验继续保留。

构建与发布拆分进入 main、runner 标签和工具验证完成，并核对正在运行的发布后，
再启用开关。主流程与下游分别执行 dry-run。参见[下游设计](./2026-10-29-downstream-release-runners.zh-CN.md)
及 #15461、#15465。

改动覆盖两个发布 workflow、固定到 workflow 提交的辅助脚本、相关 workflow
和打包测试，以及 workflow 大小基线。公开 CLI 行为和发布产物名称保持兼容。

## 验证

验证指纹失效、不可信来源运行的拒绝、完整及不完整产物、查询或下载未命中、
精确 ref 传递，以及五目标完整性检查。使用真实临时 Git 仓库和 tar 压缩包验证
ECS 构建交接，包括版本未变化时的提交处理和可执行权限。验证开关启用与关闭、
dry-run、跳过测试的限制、同一次运行重试、发布凭据范围和失败报告。运行相关
发布测试、build、typecheck 和 bundle。真实 Actions dry-run 与一次实际 npm
发布仍是启用时的验收检查；本地测试无法证明 hosted 调度容量或真实 npm OIDC
交换可用。
