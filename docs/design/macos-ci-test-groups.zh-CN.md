# 在有界任务内完成 macOS 全量 CI

[English](./macos-ci-test-groups.md)

## 问题

工作流 40885875352 的 macOS Node 任务两次超过 60 分钟限制。第二次安装约耗时 13 分钟，测试一直推进到被取消。CLI 套件尚未结束，后续 workspace 和脚本套件没有执行。另有一项 hook 超时；分组不代表这个独立问题已修复。

## 决策

保留 60 分钟限制和全部原有断言。CLI 使用三个 Vitest 分片，core 使用两个，其余 workspace 套件合为一组，standalone/runtime 与根目录脚本测试合为一组。关闭矩阵 fail-fast，避免一个分组失败取消其他组。原有 portable process smoke 在脚本组执行一次。

其余 workspace 组从 npm 的 workspace 元数据中读取全部已声明的 `test:ci`，只排除 CLI 和 core。因此新增 workspace 测试会自动纳入。大套件按路径选择 workspace，避免将 CLI 与同名根包混淆。各组均不使用测试过滤、`--if-present` 或 `--passWithNoTests`。

## 失败处理

保留原检查名 `Test (macos-latest, Node 22.x)` 作为汇总检查。只有整个矩阵成功才通过；失败、跳过或取消都不能产生绿色汇总。脚本组执行 standalone 和 helper 两套测试，并保留任一失败。workspace 发现失败或其余分组为空时直接失败。

## 验证与限制

CI 契约检查约束完整分片、自动纳入新 workspace、失败传递和汇总结果。未运行本地测试或构建。需要完整工作流证明所有分组在原有限制内结束；此前的 hook 超时若再次出现，仍须继续排查。七次安装会增加 runner 总耗时，以重复准备换取完整执行和独立失败报告。原有触发条件、权限和 checkout 规则保持不变。
