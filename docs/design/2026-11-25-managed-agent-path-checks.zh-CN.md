# 按变更路径选择 Managed Agent 检查

[English](2026-11-25-managed-agent-path-checks.md) | [简体中文](2026-11-25-managed-agent-path-checks.zh-CN.md)

## 问题

[原门禁设计](2026-10-16-managed-agent-gate.zh-CN.md)对所有命中路径的改动
同时运行 Java 和 daemon 快检。#18281 修改了旧版 GitHub channel，触发了两组
检查。PR 在作为参考项的门禁结束前合入。#18307 中，main 上的 Java daemon
测试在创建会话时全部出错，因为 daemon 在 runner 负载过高时拒绝了新会话。

## 分流

每个指向 main 的 PR、main push 和 merge group 都会报告
`Managed Agent gate`。工作流内部按变更路径选择检查。

| 改动                                                                               | 快检           | 维护者批准后运行全量套件 |
| ---------------------------------------------------------------------------------- | -------------- | ------------------------ |
| SDK 或 Managed Agent Server Java 包、Java CI 脚本                                  | Java           | 是                       |
| Daemon 代码、CLI serve 入口、managed runtime 或 daemon E2E 测试夹具                | Daemon         | 是                       |
| Java daemon SDK 客户端、共用门禁或 SDK Java 工作流，或同时涉及 Java 和 daemon 路径 | Java 和 daemon | 是                       |
| Managed channel 适配器或 Hosted 集成测试夹具                                       | 无             | 是                       |
| 文档及无关路径，包括旧版 GitHub 适配器                                             | 无             | 否                       |

Java 快检使用 Linux Java 21 跑 SDK 单测，编译到 Server 的 verification 模块，
并检查类大小约束、SDK 与 Server 的 Checkstyle 以及 Flyway 迁移版本。全量套件
保留完整的 Server 和 Hosted 覆盖。Daemon 快检使用 Java 11 客户端连接真实
daemon，模型由测试服务模拟。测试夹具关闭宿主机负载准入，让共享 CI runner
处于高负载时仍能验证会话契约。生产环境的负载准入由专门的测试覆盖。

符合条件的 head 仍在首次收到维护者批准时启动全量套件，结果报告为
`Managed Agent full suite`。夜间、手动和发布检查保留全量覆盖。
未启动全量套件的评审使用独立的检查名，避免后续评审覆盖全量结果。

## 上线与验收

- 验证文档或旧版 GitHub 适配器改动会报告门禁，并跳过 SDK Java 工作流。
- 验证纯 Java、纯 daemon 和两者同时改动的 PR 分别运行对应快检，失败时由
  `Managed Agent gate` 报告。
- 验证符合条件的 PR 首次收到维护者批准后单独报告后台结果，重复批准不会覆盖它。
- 在 GitHub Actions 上观察有代表性的快检，稳定后再将 `Managed Agent gate`
  加入 main ruleset 的必需项。路径判断失败或取消时门禁必须失败。路径范围外的
  依赖改动由夜间检查兜底。
