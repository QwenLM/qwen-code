# 分离 Workspace 读取与持久化准入

[English](2026-11-04-workspace-admission-locks.md) | [简体中文](2026-11-04-workspace-admission-locks.zh-CN.md)

## 范围与审计

在修改锁模式前，审计 Workspace Session 创建路径，保持权限、注册身份、默认选择、
退役和重放语义。创建解析器同时服务文件作用域、来源目录选择、worktree 准备和私有
CSI 创建；并非每个调用者都持有租户 placement 锁。

在主线 `4d5e30e6f0529f11c62a853d67c0f5a237cc6ffe` 上，真实 MySQL 8.4 测试观察到
默认解析进行了两次 Workspace 锁定读取。当该事务持有 placement 和选中 Workspace
时，修改未选中 Workspace 的事务发生等待。MySQL 锁表显示两个 Workspace 记录上
都有排他锁，确认锁范围超出了选中的默认值。

| 保护                              | 现有职责                                                                                         | 决策                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 租户 placement                    | 将普通/内部 Session 创建和私有 CSI 创建与跨表迁移、退役排序                                      | 保留；移除需要独立的准入协议        |
| 选中的 Workspace 行               | 读取当前 generation/storage/configuration/state，并在持久化准入期间固定它们，包括管理员 SQL 修改 | 写入保留；浏览和预检使用快照        |
| Actor 权限行                      | 将授权修改、撤权与已准入事务排序；管理员 SQL 不必获取 placement                                  | 写入保留；读取前后复核快照授权      |
| 默认 Workspace 查询后再查询选中行 | 为取得 ID 和完整 binding，重复锁定同一 Workspace                                                 | 保留租户/默认值条件，一次读取完整行 |
| Storage 和 resident 检查          | 检查独立的物理围栏、注册和活跃 Session/Runtime 状态；锁定读取同时避免 REPEATABLE READ 旧快照     | 保留                                |

本次改动前，普通创建和内部 team-lead 创建在解析 Workspace 前获取 placement。私有 CSI 创建
在外层所属事务中获取 placement；worktree 来源解析也如此。文件作用域和来源目录
选择可以不持 placement 调用解析器。这些事实都不能保证管理员修改 Workspace 或
权限行时参与 placement 协议，因此不能仅凭外层锁删除所有行锁。反过来，并非所有
解析调用方都执行持久化准入。正常创建在获取 placement 后才建立首个快照，仅创建
与退役之间的竞争不足以证明还需要 Workspace 锁。文件或预检结果的有效期与已提交
的 Session、派生 Workspace 不同。

## 改动

持久化准入省略 selection 时，保留 `tenant_id = ? AND is_default = TRUE` 条件，
做一次锁定查询，同时取得 ID 和完整 Workspace 记录。显式选择
继续使用精确的 tenant 与 Workspace 业务键。随后，两条路径均按原顺序锁定并验证
actor 权限、检查 SSH 节点访问，再验证 Workspace 为 ACTIVE。

这会消除对同一默认 Workspace 的第二次加锁/查询，同时保留原查询的锁顺序和
较宽的租户锁范围。不需要修改索引或 schema。默认值变更仍与准入事务互斥，
直到该事务提交或回滚。当前读仍须保留锁定
读取：已有的 REPEATABLE READ 旧快照不能选中旧默认值或过期的注册信息。

真实 MySQL 回归探针证明，通过 `default_tenant` 唯一选择键准入会引入问题，
因此不采用该方案。这种查询先锁 `uk_ma_workspace_default` 再锁聚簇行，而管理员
先更新元数据再修改 `is_default` 时顺序相反，导致原查询只需等待的交错发生死锁
（1213 / SQLState 40001）。保留原条件可以避免这个新增的锁反转，无需要求管理员
遵守额外锁约定，也不增加自动准入重试。收窄默认准入的租户锁范围留作独立改动；
本次不宣称准入完全不会死锁。

## 读取与预检路径

在现有准入解析器之外提供命名明确的读取入口，复用 actor、tenant、role、ACTIVE、
SSH 访问与错误码检查。读取解析在新的 REPEATABLE READ 事务中使用普通 SELECT；
准入解析保留锁定读取。目录的 OWNER 和 ROOT 判断直接使用本次解析得到的 role
和 kind，避免锁定读取之后再次查权限时误用更早的快照。

| 调用方              | 读取阶段                                                   | 持久化阶段                                                  |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 文件查询/读取       | I/O 前后读取 scope，比较版本与物理身份                     | 无                                                          |
| 文件上传            | 消费请求体前读取 scope                                     | 原 scope、授权、围栏和操作插入仍在同一加锁事务中            |
| 目录浏览            | 遍历前读取 OWNER/ROOT 与绑定，遍历后重新读取并比较完整绑定 | 无                                                          |
| worktree 选项/预检  | 不获取租户 placement，读取来源并保留物理存储验证           | 创建重新解析，并检查 plan 的绑定、根目录与 storage identity |
| 派生 Workspace 创建 | 保持现有来源选择和回执准备                                 | 最终来源授权、新 Workspace/grant 和完成回执保留原锁         |

读取 scope 使用独立的短事务模板，隔离级别为 REPEATABLE READ。命名读取入口拒绝
继承外层事务，避免沿用其旧快照，也避免挂起可能已持有所需 storage 锁的事务。
每次 I/O 后检查因此都会建立新快照。原写入 scope 仍加入上传准入事务。读取模板
不设置 SQL read-only，因为 worktree 身份检查可能持久化已有的 BLOCKED 诊断状态。

文件读取 scope 移除显式 Session、Workspace、grant 和 storage 行锁；写入 scope
保留这些锁。物理存储、迁移和身份 guard 不变，仍可能获取自身的锁。目录浏览和
worktree 预检移除 Workspace/grant 锁，worktree 预检也移除 placement 获取。
本次不宣称整个读取请求完全无锁。

实现限于 registry、文件 scope/上传预检、目录浏览和 worktree 来源 store。
不改变公共 API、schema 或持久化写入的隔离配置，也不引入通用锁框架。

## 兼容性与限制

- 显式选择不会回退到默认值。Workspace 缺失、不可读、权限不足、非 ACTIVE 时，
  保持原错误码和优先级。省略选择且默认值不可用时，仍返回 `workspace_required`。
- 通过 registry 进行的持久化准入保留 Workspace 和权限锁，与其冲突的修改仍等待
  该事务；修改提交后，新的准入解析能看到当前值。
- 创建幂等、原绑定重放、resident 单 Session 准入和私有 CSI 所有权保持不变。
- 不增加共享锁模式、锁缓存或新的授权语义。使用租户 placement 的创建路径仍然
  串行；本次不宣称同租户 Session 创建可以并行。
- 文件与目录浏览在 I/O 后用新快照复核。Worktree 选项/预检仅供参考，结果可能
  过期；最终创建在准入前独立重新验证计划。这些读取不为未来写入保留授权，也
  不需要共享元数据锁。
- 本轮不改变最终准入与管理员 SQL、撤权之间的排序；要删除这些保护，需要先让
  所有相关写入方采用统一协议。

## 验证与验收

测量修改前后的默认解析 SQL 和真实 MySQL 锁范围。验证显式选择时，无关 Workspace
元数据可以继续修改。验证准入等待期间，管理员可以先更新默认值的元数据，再切换
默认值；随后准入返回新默认值，不触发唯一选择键的死锁。覆盖默认值切换、注册修改、权限撤销、
已建立的 REPEATABLE READ 快照、显式选择和错误行为，并验证真实创建/退役边界及
相关解析器调用方。

在真实 MySQL 上验证：另一连接持有 Workspace 或 grant 更新时，浏览/预检仍能
完成；撤权、OWNER 降级、generation 和 fence 改变会阻止返回过期文件/目录结果；
读取入口拒绝继承外层旧快照，上传与派生发布仍保留最终事务保护。除查询/锁轨迹
之外，测试还要断言业务结果；仅要求写入等待的测试，不能证明所有读取都需要锁。

遵循 Managed Agent 模块共享本地验证预算，执行定向 H2/MySQL 测试和 Checkstyle。
查询和锁范围证据与延迟或吞吐量结论分开记录。完整 Java/MySQL/Hosted/fault 验收
仍由 CI 完成；本地定向结果不代表这些门禁已经通过。
