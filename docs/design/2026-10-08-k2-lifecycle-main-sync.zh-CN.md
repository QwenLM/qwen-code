# K2 与 main Workspace lifecycle 的对齐

[English](2026-10-08-k2-lifecycle-main-sync.md) | [简体中文](2026-10-08-k2-lifecycle-main-sync.zh-CN.md)

## 问题与基线

首次同步将私有 CSI foundation `4f82b9d597bdc8e2c2bcba1942a344e4273c599b`
与 Workspace lifecycle L3 之后的 main `fe4d4e345` 集成。双方都改变了 managed
journal、原 Runtime admission 与 publication locking；main V51 与未发布的 CSI
migration 冲突。

后续同步将私有 Hosted attachment 与 main `bb213cd05` 集成。main 增加 mutation
attempt sequence V52 和普通 Hosted resident recovery。V52 再次与本 Draft
未发布的 request-pin migration 冲突。仅解决文本冲突不能证明行为兼容。

## 决策与范围

保留 main 的 lifecycle claim、授权、settlement 和原 Hook recovery 检查。保留
私有 CSI 的原 writer、journal admission、publication identity 和 retirement
检查。Lifecycle 授权不能代替 CSI authority，也不能让普通 release 满足 CSI
finalization。先执行 lifecycle dispatch/settlement 检查，再对原 CSI Session
应用专有 journal 与 activation 校验。拒绝继续回滚整个事务。

保留两类 Runtime replacement 拒绝：lifecycle recovery 不替换原 Runtime，私有
CSI 原请求不创建 replacement generation。保留两组测试与两组 schema 字段。
Publication admission 先取 placement，再取 CSI/retention 锁。Legacy DELETE
等待 journal commit，先取 placement 再取 Session。私有 CSI CLOSE/DELETE 在
persisted-profile admission 和 capability projection 拒绝，早于写入
lifecycle operation 或 fence。

后续集成保留 main 的 creator/bound-registry 检查、已记录 mutation replay
边界和 resident recovery。私有 Hosted registrar 仍位于普通路由之前；大小写
无关的 owner gate 同时检查普通 sessions 与 opening sessions。普通 recovery
不能接管已保留的私有 owner。

已发布的 main V48–V52 保持字节不变。首次同步将未发布 CSI V51/V52 改名为
V52/V53；后续同步仅将这两份 Draft migration 改为 V53/V54，保持 SQL 字节与
顺序。这不是已经应用未发布编号的共享数据库升级路径。此前本地资格 schema
均自有且已清理。不改写已应用历史，不回填 request/activation authority。

影响 Java managed Session/lifecycle store、publication admission、JDBC
binding/schema 与测试，以及普通 Hosted owner/recovery 边界。不增加公开
selector、retirement coordinator、物理停止证明或卷复用。既有报告仍绑定原输入；
同步 main 后需要新检查，不能给旧报告重新标注资格。

## 验证与验收

首次同步已复现重复 V51。后续同步在不可变 merge preview 上使用真实 Flyway
复现重复 V52：在创建任何 PUBLIC 表前拒绝两份 V52 资源。保留失败证据。

改名后验证 fresh migration，以及从已发布 main V52、仅 request 的 V53 和此前
受支持基线升级。保留旧 migration checksum/history、legacy 行值与新 authority
pin 的 NULL。验证 migration 版本唯一、已发布 main 和改名 CSI SQL 字节相等。

使用新编译 classes 运行相关 Runtime Broker 与 managed Session/lifecycle
测试。覆盖原 CSI writer/finalization 拒绝、普通 claim/settlement/replay、
creator/grant 检查及 Hook recovery。Draining 仍拒绝新 admission；普通删除
不授权提前 CSI release。保留失败，区分孤立重试与已证实原因。

对集成后的 TypeScript 树运行 build、typecheck、bundle 和 focused Hosted、
HTTP journal、tool-turn、环境隔离测试。独立地运行实际 Java 私有 text 入口、
集成 Hosted bundle 和原 SQL Store，明确 synthetic/H2/provider seam。审查手工
冲突解决和自动合并。保持 Draft 与 maintainer review；如 native review 不可用，
报告限制而不替代 verdict。CI、本地 Store 和旧云上运行不构成完整 K2 验收。

## 未完成工作

私有文本 attachment 已实现。Native 文件 intent/definition admission、原子
batch reservation/recovery、文件 grant 执行、聚合 DRAINED/RELEASED、物理
writers、CSI NodeUnpublish、安全卷复用、公开接线及新的完整验收矩阵仍由
issue 13395 跟踪。
