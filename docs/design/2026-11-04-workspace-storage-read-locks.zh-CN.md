# Workspace 读取使用存储快照校验

[English](2026-11-04-workspace-storage-read-locks.md) | [简体中文](2026-11-04-workspace-storage-read-locks.zh-CN.md)

## 问题与范围

[Workspace 读取与准入拆分](2026-11-04-workspace-admission-locks.zh-CN.md)
已移除浏览和预检的元数据锁。两个 LOCAL 读路径仍在短 REPEATABLE READ
事务中获取存储排他锁：Session worktree 文件 scope 和 worktree 源目录预检。
存储校验只要发现当前有事务，就会隐式锁住迁移 fence、alias 和物理 owner；
worktree 存储身份读取也会显式锁住 alias 和 owner，因此共享存储的请求仍可能串行。

本次只处理这两个路径及其内部存储校验，不改变公共契约、schema、Session
创建 placement、退役、迁移或恢复协议。

## 设计

提供明确的 LOCAL 根目录和文件根目录快照校验入口。逻辑 fence、alias、物理
owner 和注册信息查询使用调用方新建的 REPEATABLE READ 快照中的普通 SELECT。
复用现有物理身份、规范目录、存储 marker 和迁移历史检查。现有校验入口继续为
准入和恢复保留加锁行为。

文件 scope 在读取时选择快照校验，在持久化准入时选择现有校验。文件交换流程
继续在 I/O 前后的独立快照中校验权限和 scope revision，并比较物理根目录身份。
上传预检复用读取 scope；最终准入仍在同一加锁事务内完成授权、存储保护和操作插入。

Worktree 源目录预检以无锁方式读取存储身份。返回前在第二个新快照中重新解析和
校验来源，比较完整 resolved binding、根目录和存储身份。撤权或新的 fence 会
拒绝结果，绑定或注册变化会使结果失效。这也覆盖文件系统校验期间的变化。
最终 worktree 准入继续在持久化操作前，将计划与当前加锁的存储身份进行比较。

快照入口沿用上一轮约束，拒绝外层事务。内部快照 helper 仅继承这些入口创建的
短事务。事务模板继续允许写入，因为无效 worktree 可能持久化现有 BLOCKED
诊断状态转换。

## 一致性与限制

读取期间可以看到尚未提交的存储变更之前的已提交版本。后置检查在新快照中观察
已提交变化；文件系统身份检查继续拒绝被替换或不安全的目录。这些检查不会为
未来操作预留权限或存储。Worktree Git options/preflight 在来源解析后仍属
建议性结果，最终创建会独立校验计划。

正常读取应不获取存储行锁。文件系统无效时，现有 BLOCKED 诊断更新仍可能写
worktree 行。未经测量，不声称整个请求完全无锁或吞吐量已提升。CSI/SSH 存储
准入和共享 journal fence 不变。

## 验证与验收

通过真实 MySQL 8.4 上的文件 query/read 和 worktree source API 复现竞争，
让另一连接持有 alias 或物理 owner 的共享锁。观察 InnoDB 等待，释放阻塞者后
确认业务结果成功。修改后，相同读取应能在共享阻塞锁仍被持有时完成。
再持有不改变已提交值的排他行锁进行验证，确认这些读取也不会请求共享锁。

覆盖读校验期间的撤权、存储 fence／注册变化和文件系统身份变化，验证拒绝外层
旧快照。验证上传／worktree 持久化准入仍与存储变更有序互斥并拒绝过期计划。
若修改的 helper 影响相关消费者，用定向回归覆盖 LOCAL 恢复、共享 journal
准入及 SQL ownership 契约。

遵循 Managed Agent 本地验证预算，记录选中的确切用例、失败、跳过和锁证据。
完整 Java/MySQL/Hosted/fault profile 仍由 CI 验收。H2 不能证明 InnoDB
锁行为；mock 文件 worker 不能证明真实 worker／进程集成。
