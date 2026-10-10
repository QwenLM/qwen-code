# 持久化 Hosted Session 的工具 profile

[English](2026-10-03-hosted-session-tool-profile.md) | [简体中文](2026-10-03-hosted-session-tool-profile.zh-CN.md)

## 范围与当前行为

这是 #13271 的第一阶段实现。公开 REST 与 WebShell 的 Workspace 创建共用
`ManagedAgentStore.insertSession`。Hosted connector 当前每次创建、加载和恢复时，
都根据是否绑定 Workspace 推导 `hosted-workspace-files/1`，没有持久保存这一选择。

本次持久化现有选择，不启用 Shell 或 `/2` profile。公开响应、capability、请求校验
与审批行为保持不变。后台 Shell、Monitor 和 Shell 接管继续不在范围内。

## 存储与附着

新增可空列 `managed_agent_session.tool_profile`，SQL 默认值为
`hosted-workspace-files/1`。已有绑定会话获得该值；已有未绑定会话清空该值。
新建会话在写入绑定的同一条 INSERT 中，明确为绑定会话写入文件 profile，
为未绑定会话写入 null。

保留 SQL 默认值，使旧版程序在迁移后仍可创建绑定会话。旧版程序新建未绑定会话时
也可能写入默认值；connector 对未绑定会话忽略此列，不发送 profile。
迁移不修改已有审批模式或 journal 快照。

在 `StoreModels.SessionRecord` 中读取此列。connector 的创建与加载都通过现有
共用方法读取它。恢复、创建冲突和创建响应丢失后的回退共用同一加载路径。
绑定会话的 profile 缺失或为空白时，在请求 Harness 前拒绝；省略字段会让 Harness
从 journal 推断 profile。加载绑定会话时绝不根据当前部署设置推导 profile。

创建重试直接返回原会话，不重写 profile。本阶段不新增 profile 修改 API 或部署
配置。后续准入只修改创建时的服务端选择。旧 connector 仍假定 files/1，因此必须
等所有参与的控制面都支持持久化字段后，才能准入其他 profile。

## 实现约定

- 请求不能选择 profile；保留现有 `unsupported_feature` 拒绝。数据库和服务端
  准入逻辑是可信来源。
- 公开入口和 WebShell 共用事务 INSERT。connector 创建、冷加载和恢复都读取
  同一个存储值。
- 未绑定会话仍不具备 Workspace 工具。绑定会话缺少 profile 时拒绝，不回退到
  权限更大的 profile。
- 复用 JDBC、Flyway 和现有 connector 方法，不新增 profile 注册器、解析器、
  配置框架或公开 schema 字段。
- 回归验证：迁移新增列之前的绑定会话，随后以持久化的 profile 创建、加载和恢复；
  移除持久化或恢复 connector 常量时，相应断言必须失败。

生产改动涉及 `StoreModels`、`ManagedAgentStore`、`QwenHostedHarnessConnector`
和一个 Flyway 迁移。迁移暂定 V35；编号在合入前只是占位，需对照 main 再确认。

## 验证与验收

复用现有 Java 公开入口/WebShell 准入测试及 connector 请求捕获测试。验证文件
profile 创建后持久保存、幂等重放、旧数据迁移、旧版 INSERT 默认值、缺失 profile
拒绝，以及创建、加载和恢复传递同一 profile。保留未绑定会话无工具的对照与请求
指定 profile 的拒绝。执行 Java 编译、定向测试和 Checkstyle；数据库或完整链路
验证无法运行时明确记录。本次没有新增 UI 状态需要截图。

## 后续 Shell 准入

启用 Shell 前，#13271 仍需独立且默认关闭的开关、强制询问的审批模式，以及按会话
更新 capability 和契约。Shell 创建与附着必须拒绝 `yolo`、null 和空白的持久化
审批模式，包括 Java 当前的默认回退。已有文件会话（包括 `yolo` 会话）在部署配置
变化后仍保持原 profile。

#13160 必须让审批人看到命令。G3 第一步（#13174）让执行中的 Shell 和等待中的
审批在 Harness 崩溃后得到有类型的阻塞结果；不会恢复审批或重新执行 Shell。
运维恢复（#12977）只有在确认写入者全部停止后才能释放结果不确定的 Workspace。
`await_action` 的自动取消和释放属于 G3 第三步，本阶段不承诺。
启用开关还要求 #12904 和 #13010 解决、公开路径 FG6f 通过，以及
`HostedPublicWorkspaceIT` 覆盖 Shell 审批。持久化字段也供 #13166 后续 `/2`
准入使用。
