# K2 与 main Workspace lifecycle 的同步

[English](2026-10-08-k2-lifecycle-main-sync.md) | [简体中文](2026-10-08-k2-lifecycle-main-sync.zh-CN.md)

## 问题与基线

私有 CSI foundation `4f82b9d597bdc8e2c2bcba1942a344e4273c599b` 与加入
Workspace lifecycle L3 的 main `fe4d4e345` 冲突。两边均修改 managed journal、
原 Runtime admission 和 publication 锁。main 还占用了 V51，与未发布 CSI
migration 碰撞。仅完成文本合并不能证明行为兼容。

## 决策与范围

保留 main 的 lifecycle claim、authorization、settlement 和原 Hook recovery
检查，同时保留私有 CSI 原 writer、journal admission、publication 身份和
retirement 检查。Lifecycle authorization 不能替代 CSI 权威，普通 release
不能成为 CSI finalize 的充分条件。在 apply journal 前执行 lifecycle
派发与收尾检查；原 CSI Session 继续使用既有 CSI 专属 apply 与 activation
验证。拒绝仍由外层事务完整回滚。

保留两个 Runtime replacement 拒绝：lifecycle recovery 不能替换原 Runtime，
原私有 CSI request 不能创建替换 generation。保留双方完整测试组及 schema
字段。Publication admission 在 CSI/retention 锁之前取得 placement，遵守
既有 placement 先于 retention 的锁序。main 现在也要求旧 DELETE 等待
journal commit，入口必须先取得 placement 再锁 Session，保留 main 的两次
已提交 revision。私有 CSI CLOSE/DELETE 在持久化 profile 准入和能力展示中
继续不可用，不能先写 lifecycle operation 或 fence。

main V48–V51 字节不变。仅将本 Draft 未发布的 request pin 与首次 activation
migration 从 V51/V52 重命名为 V52/V53，保持 SQL 字节与顺序。这不是已经应用
未发布旧编号的共享数据库升级路径；此前本地资格验证 schema 均自有且已清理。
不能改写已应用历史，也不回填 request/activation 权威。

涉及 Java managed Session/lifecycle store、publication admission、JDBC
Runtime binding/schema 及相关测试。不添加公开 selector、CSI retirement
coordinator、物理 stop 证明或卷复用。Hosted Parts 报告继续绑定原提交；同步
main 必须执行新检查，不能把旧报告扩展为新构建的证明。

## 验证与验收

重编号前验证真实 Flyway 拒绝重复 V51。重编号后验证 fresh migration、
main V51 和仅 request 的 V52 升级：保持原 migration checksum/history、
legacy 行字段，新权威 pin 保持 NULL。所有 migration 版本必须唯一。

针对新编译 class 运行相关 Runtime Broker、managed Session/lifecycle 测试，
覆盖原 CSI writer/finalize 拒绝、普通 lifecycle claim/settlement 和原 Hook
recovery。Draining 期间不得开放新 admission，普通 Workspace 删除不能授予
CSI 提前 release。保留失败，区分隔离重跑通过与已经证实的原因。

对同步后的 TypeScript tree 执行 build、typecheck、bundle，运行相关 Hosted、
HTTP journal、tool-turn 与环境隔离测试。自审冲突解决以及交叉边界的自动合并。
保留 Draft 与 maintainer review 门禁。Native review 不可用时明确记录，不用
替代 reviewer verdict。CI、本地 store 与旧云上运行不能证明完整 K2 验收。

## 剩余工作

原生 conversation admission 与私有 producer 集成、原子 batch reservation/
recovery、聚合 DRAINED/RELEASED、物理 writer 与 CSI NodeUnpublish、安全卷
复用、公开接线及新一轮完整验收矩阵仍属于独立 K2 工作，在 issue 13395 追踪。
