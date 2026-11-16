# Release runner 槽位

[English](2026-10-28-release-queue-optimization.md) | [简体中文](2026-10-28-release-queue-optimization.zh-CN.md)

## 目标

把能用现有 ECS 执行的发布任务移出 GitHub hosted 排队。本改动直接面向 main，不依赖 #15854 的音频缓存优化。

## 调度

三个现有 runner 进程使用 `ecs-qwen-release-host`：hz1-17、hz1-18（ARM64），hk4-31（x64）。只从这三个进程移除普通 CI 标签；同机其他进程和用途保持不变，无需重装或独占机器。

Linux 音频构建选择对应架构，在 `node:22-bookworm` 中编译，避免较新的主机 glibc 提高产物兼容性要求。macOS、Windows 音频构建保持原 runner。音频收集可使用任一 release 槽位，始终消费当前运行为选定发布提交生成的产物。

CLI 在 ECS 准备版本提交、bundle、workspace 和 standalone 产物，再将确切提交及产物交给 hosted npm 发布方。SDK 同样交接经过测试的包。保留可执行权限并校验导入的提交；构建失败或意外跳过必须阻止发布。

VSCode universal/准备/发布、Desktop 发布、Chrome 扩展、发布收尾及 GHCR 任务使用同一组槽位。npm 最终发布为满足 trusted publishing/provenance 保留 hosted。VSCode/Desktop 原生构建、OSS 同步、managed-runtime 和其他 SDK/Live Host 发布在本改动中保持原路径。失败报告保留 hosted，以便 ECS 故障时仍可报告。

## 持久 runner 准备

预检从 workflow 固定提交运行，在 checkout 前清空受限路径内的工作区，检查 Node 22 和磁盘空间，隔离 Git/npm/Docker/gh 状态及 npm 安装前缀。标签只预留调度容量，不能隔离共享主机上的其他进程。部署接受现有共享主机信任边界并保留 environment 保护。

## 启用和验证

构建/发布拆分进入 main 前保持 `ECS_RELEASE_HOST_RUNNER_ENABLED` 未设置，否则旧流程会把 npm 发布一并迁到 ECS。合入后开启变量；取消设置即可回退 hosted 路径。

验证开关两种路由、Linux 两种架构的音频构建和原生模块加载、同次运行 Git/产物交接、SDK 包一致性、失败传播及 workflow 语法。随后在预留 runner 上执行不发布的 Actions 验收，记录 runner 名称及排队/启动时间。主发布 dry-run 不产生 release 事件，下游需要单独验收。观察首次真实发布后才算启用完成。本改动不涉及 UI 或 tmux 验证。
