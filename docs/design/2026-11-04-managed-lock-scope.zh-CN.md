# 缩小 Managed Session 的锁范围

[English](2026-11-04-managed-lock-scope.md) | [简体中文](2026-11-04-managed-lock-scope.zh-CN.md)

下文关于普通 journal 提交和内联/发布结果的存储锁顺序已由 [2026-11-05 设计](2026-11-05-managed-publication-storage-sharing.zh-CN.md)取代。这些路径在现有离线维护约定下使用无锁物理状态检查；其他准入与生命周期锁仍按下文保留。

## 问题

普通 journal commit 已经在本 Session 上排队，但相邻路径仍有租户级 guard，
只读存储检查也使用排他锁。无关的 placement 可能延迟已响应操作的记录、inline
工具输出和生命周期续租；共享存储的 Session 仅检查存储可用性时也会互相等待。

## 范围与决策

按以下顺序用独立提交交付：

1. 移除 `markOperationAnswered` 的 placement guard。它的条件更新只修改一条
   operation 的重试预算水位，保留 owner、generation、数据库实时租约和私有 CSI
   排除检查。
2. 普通 inline `publishToolResult` 在任何一致性读前先取得 Session root，随后
   检查 storage、锁 head。生命周期 authority 和已绑定 CSI 的路径保留 guard。
   resource 缺行时采用非锁探测，存在时锁行，插入由唯一键仲裁。重复写必须匹配
   原始作用域与内容；已回收资源不得复活。
3. 区分只读存储准入与存储修改。只有后续不会修改被检查 alias/owner 的调用者才在
   MySQL 使用共享锁定读。H2 使用其支持的排他锁兼容路径。注册、membership、
   maintenance、recovery 和 migration 的写入方保留排他锁。内部身份和状态检查
   也必须使用选定的锁模式，避免隐含的排他重锁或 S 到 X 的锁升级。
4. 生命周期 claim、续租、retry、block 和 failure 先在本 Session 排队，再修改
   operation 与 head claim 镜像。镜像仍在同一事务内更新，等待后使用数据库时间，
   并保留旧 owner 拒绝语义。生命周期准入、完成及 CSI authority 不泛化为这条
   无租户 guard 的路径。带 lifecycle authority 的 Broker 准入必须读取最新
   head claim，并在事务结束前持有共享锁（H2 使用排他锁）。租户 placement guard
   已无法单独保护镜像免受 claim 更新；旧 RR 快照不能授权已撤销的 claim。
   普通准入保持既有语义。

只移除已持锁事务中证实重复的获取，以及完整共享状态修改已被内部同步覆盖的外围
monitor。保留首次获取的位置与身份校验，不增加通用持锁缓存，不修改公开 API。
物理准入只读取 alias 和 owner 各一次，将 LOCAL/SSH 路径从四次查询降为两次。
LOCAL 身份查询仍允许恢复路径读取已 fenced 的 owner，准入则要求 READY；SSH
保留更严格的身份、注册和 fence 检查。逻辑 migration fence 查询仍独立验证业务键。

## 不变量

- Session 生命周期变化与普通写入共享 Session/root 锁；writer generation、
  journal sequence 和生命周期 claim 仍由 head 协调。
- 存储读者持有共享 fence 直至事务结束；migration/fence 写入方不能越过它们而
  准入不兼容的工作。
- 共享准入不会在同一事务的后续阶段修改同一存储行。
- 等锁后的授权不能依赖过期的 RR 快照。
- operation 条件更新与 head 镜像共同提交或回滚；失效或过期 claim 不得通过重试
  重新取得权威。
- publication 配额预留、Runtime placement/retention 协议、物理目录 membership
  和 CSI 原始资源证明保持完整。

## 风险与排除范围

移除租户串行会暴露原先被其遮蔽的缺行 gap lock、反向锁序和过期快照。测试必须使用
独立 MySQL 连接，不能仅依赖 H2 或 SQL 记录。现有 CSI 路径存在 root 到 guard 与
guard 到 root 两种顺序，通过具名可重试错误处理死锁；本次不能无意扩大这些路径。

Hosted cleanup 引用需要另行建立原 binding 存在性和 generation 校验协议。本次
不会在未解决与 retention 锁序之前，直接在 head 后增加 binding 锁。Runtime
provider 启动锁、read lease 重构和租户配额记账也不属于本次增量。

## 验证与验收

- 在未修改基线上复现目标等待，再验证真实 store 入口在无关租户 guard 持有期间
  仍可完成。
- 验证不同 Session 可同时取得存储共享准入，排他 fence 必须等待；安装 fence 后
  新准入必须失败。
- 覆盖并发新增 inline resource、精确重放、冲突重放、回收 tombstone、writer
  接管和生命周期、物理存储 fence。
- 覆盖生命周期 claim 接管、过期 owner 拒绝、镜像更新、不存在的 Session、回滚
  和同 Session 顺序。验证 Broker authority 检查拒绝 RR 快照建立后已撤销的
  claim，且 claim 撤销必须等待已准入的 Broker 事务。
- 执行受影响的锁契约、生命周期、publication、storage 测试及 Checkstyle。
  真实 MySQL 验证行锁和 gap lock；完整 Java、MySQL 及相关 Hosted/fault profile
  仍作为 CI 门禁。

本地 Java 环境准备、编译与测试共享模块规定的十分钟预算，分别记录基线和修改后的
结果。必要 CI 门禁通过前不能宣布验收完成；未经测量不承诺吞吐收益。
