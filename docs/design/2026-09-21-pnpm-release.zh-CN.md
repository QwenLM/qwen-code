# pnpm 原生发布操作

[English](2026-09-21-pnpm-release.md) | [简体中文](2026-09-21-pnpm-release.zh-CN.md)

## 范围与决策

用仓库锁定的 pnpm 替换主发布流程中手写的 workspace 发布循环和逐包改版本命令。
保留独立发布、版本冲突保护、OIDC/provenance、可选包开关和 CLI 产物打包逻辑。
本改动不触发或合并一次发布。

内部源码包声明 `private: true`。SDK、Mobile MCP、Node REPL 和 Qwen Live
继续公开发布并独立管理版本。GitLab channel 标记为 private，因为现有发布流程不发布它。
生成的 CLI manifest 继续可发布；仓库根包和 CLI 源码包都不直接发布。

从 workspace manifests 推导发布包名，排除 private 包和独立发版包。
递归发布和版本冲突检查使用同一份选择结果。即使可选包发布开关关闭，保护检查仍查询它们，
维持原来的保守行为。在 workflow SHA 检出选择辅助脚本及 manifests，
防止 release-ref 检出内容替换推送保护使用的包清单。

运行 `pnpm -r publish`，明确传入包过滤器、provenance、access 和 tag。
由 pnpm 处理依赖顺序并跳过 registry 上已有的版本。
`--force` 仅与 `--dry-run` 一起使用，保证已有版本也执行打包和生命周期检查。
workspace 发布完成后单独发布生成的 CLI，保留其现有版本跳过检查。
workspace 发布失败就停止，不继续发布 CLI；多包发布不具备原子性。

先解析一次根包版本，再递归对齐所有跟随主版本的 workspace，包括 private 包。
保留扩展元数据、sandbox 镜像 tag 和 channel-base 精确依赖版本的同步。
pnpm version 不会改写这些精确依赖版本。删除旧的 npm reify 遗留 node_modules 清理。

## 验证与验收

- 实际发布集合等于现有集合加上 #12387 恢复的 Web Shell；继续排除独立发版包。
- 测试覆盖可选包开关、workflow-pinned manifests、CLI 已有版本、tag/provenance 参数、
  dry-run 参数和失败传播。
- 用本地 registry 验证原生 pnpm：首次/部分/完整发布、依赖顺序、private 排除、
  dry-run 零写入和 registry 错误。保留可信保护检查：pnpm 的存在性探测本身不会在
  registry 报错时拒绝继续。
- 在临时 manifests 上运行真实改版本流程，比较打包产物并验证可安装性。
  运行定向测试、构建和类型检查。
- 验证不包括真实 npm 发布。GitHub-hosted runner 上的 OIDC 交换及 provenance
  需要后续单独授权的真实发布才能验证；本地 dry-run 不能证明它们正常。

## 风险与后续

新增非 private、非独立发版的 workspace 会自动进入主发布流程。
合并前需要检查它的 npm 权限和 trusted publisher。
`private` 阻止发布，不会修改已发布包的访问权限。
CLI 仍需要生成 manifest 和 bundle，因此这是有边界的简化，不是重写整个发布工作流。
