# 移除默认 Workspace 准入中的重复读取

[English](2026-11-04-workspace-admission-locks.md) | [简体中文](2026-11-04-workspace-admission-locks.zh-CN.md)

## 范围与审计

在修改锁模式前，审计 Workspace Session 创建路径，保持权限、注册身份、默认选择、
退役和重放语义。创建解析器同时服务文件作用域、来源目录选择、worktree 准备和私有
CSI 创建；并非每个调用者都持有租户 placement 锁。

在主线 `4d5e30e6f0529f11c62a853d67c0f5a237cc6ffe` 上，真实 MySQL 8.4 测试观察到
默认解析进行了两次 Workspace 锁定读取。当该事务持有 placement 和选中 Workspace
时，修改未选中 Workspace 的事务发生等待。MySQL 锁表显示两个 Workspace 记录上
都有排他锁，确认锁范围超出了选中的默认值。

| 保护                              | 现有职责                                                                                     | 决策                             |
| --------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| 租户 placement                    | 将普通/内部 Session 创建和私有 CSI 创建与跨表迁移、退役排序                                  | 保留；移除需要独立的准入协议     |
| 选中的 Workspace 行               | 读取当前 generation/storage/configuration/state，并在准入期间固定它们，包括管理员 SQL 修改   | 保留第一次锁定读取               |
| Actor 权限行                      | 将授权修改、撤权与已准入事务排序；管理员 SQL 不必获取 placement                              | 保留                             |
| 默认 Workspace 查询后再查询选中行 | 为取得 ID 和完整 binding，重复锁定同一 Workspace                                             | 通过已有默认唯一键一次读取完整行 |
| Storage 和 resident 检查          | 检查独立的物理围栏、注册和活跃 Session/Runtime 状态；锁定读取同时避免 REPEATABLE READ 旧快照 | 保留                             |

普通创建和内部 team-lead 创建在解析 Workspace 前获取 placement。私有 CSI 创建
在外层所属事务中获取 placement；worktree 来源解析也如此。文件作用域和来源目录
选择可以不持 placement 调用解析器。这些事实都不能保证管理员修改 Workspace 或
权限行时参与 placement 协议，因此不能仅凭外层锁删除所有行锁。

## 改动

省略 selection 时，对 `default_tenant` 做一次锁定查询，同时取得 ID 和完整
Workspace 记录。该生成列已受 `uk_ma_workspace_default` 唯一约束保护。显式选择
继续使用精确的 tenant 与 Workspace 业务键。随后，两条路径均按原顺序锁定并验证
actor 权限、检查 SSH 节点访问，再验证 Workspace 为 ACTIVE。

这会消除对同一默认 Workspace 的第二次加锁/查询，并使用已声明的唯一选择键，
无需按 `is_default` 筛选租户的 Workspace 行。不需要修改索引或 schema。默认值
变更仍与选中默认行及其索引锁互斥，直到准入事务提交或回滚。当前读仍须保留锁定
读取：已有的 REPEATABLE READ 旧快照不能选中旧默认值或过期的注册信息。

## 兼容性与限制

- 显式选择不会回退到默认值。Workspace 缺失、不可读、权限不足、非 ACTIVE 时，
  保持原错误码和优先级。省略选择且默认值不可用时，仍返回 `workspace_required`。
- 注册和权限修改仍等待已准入事务；修改提交后，新的解析能看到当前值。
- 创建幂等、原绑定重放、resident 单 Session 准入和私有 CSI 所有权保持不变。
- 不增加共享锁模式、锁缓存或新的授权语义。使用租户 placement 的创建路径仍然
  串行；本次不宣称同租户 Session 创建可以并行。
- 剩余行检查仍需要已有同步。若单独评估共享读，需要审计后续写入/锁升级，并证明
  在外层 guard 之外确实能减少有意义的竞争。

## 验证与验收

测量修改前后的默认解析 SQL 和真实 MySQL 锁范围。验证选中默认值的事务仍在持有
期间，无关 Workspace 元数据可以继续修改。覆盖默认值切换、注册修改、权限撤销、
已建立的 REPEATABLE READ 快照、显式选择和错误行为，并验证真实创建/退役边界及
相关解析器调用方。

遵循 Managed Agent 模块共享本地验证预算，执行定向 H2/MySQL 测试和 Checkstyle。
查询和锁范围证据与延迟或吞吐量结论分开记录。完整 Java/MySQL/Hosted/fault 验收
仍由 CI 完成；本地定向结果不代表这些门禁已经通过。
