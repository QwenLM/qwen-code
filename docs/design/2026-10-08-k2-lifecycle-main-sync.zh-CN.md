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

私有文本 attachment 和有界有限原生文件执行已实现。真正 cold takeover、全部
writer 收口、聚合 DRAINED/RELEASED、物理 writers、CSI NodeUnpublish、安全
卷复用、公开接线及新的完整验收矩阵仍由 issue 13395 跟踪。

## 与 actor role 和 child Session 集成，2026-10-09

原生执行增量 `f252ada3e` 与 main 集成。main 已发布 V53
Workspace role、V54 child lineage 和 V55 channel instance binding。全部已发布
migration 字节保持不变；只把本 Draft 的 request、first-activation 和
native-authorization SQL 从 V55/V56/V57 改为 V56/V57/V58，SQL 字节与顺序不变。
已经应用更早未发布编号的数据库不是自动升级对象，不修复其历史，不回填原始
authority。此前升级检查包含 main V53/V54/V55、仅 request 的 V56 和
activation V57，保留旧行、checksum 和 native grant 的 NULL。

后续与 main `e6e2c9efd` 合并包含已发布的 V55 channel instance migration。
已编译 Flyway schema test 在修复前复现 V55 重复。保留该已发布 migration，
只把三个未发布 CSI migration 顺延为 V56/V57/V58，SQL 字节与顺序不变。
构建前清理旧 target resource，验证完整 source/packaged inventory 及截至
V58 的升级序列。更早未发布编号的数据库仍需独立明确迁移方案，本次不回填。

最终交付还合入 main `5b1c701400c949a6e943909db6fcbcb2273dc721`，包含已发布的 operation actor-key migration V56，并在 bound Session 上同时校验 caller role 与原 creator execution facts。源码 inventory 检查在修复前复现 V56 冲突。已发布 V1–V56 字节全部保持，只将三个仍未发布的 CSI 文件顺延为 request V57、activation V58、native authorization V59，SQL 字节/顺序不变。升级测试覆盖已发布 V56、仅 request 的 V57、仅 activation 的 V58；完整序列止于 V59。私有创建保留 creator/owner key 与 request pin，child/close/delete 门禁保持关闭。合并后须在新推送提交运行检查，不能把原进程断点验收转移到新 head；更早未发布编号仍需独立明确迁移方案。

本次交付还合入 main `1f4484d34aec85eeba4a3fcf0937efe97cb5362c`，其发布 H6b/H6c automation ledger V57 与 child Workspace capability V60，跳过 V58/V59。merge-tree 预演在修复前复现已发布 automation 与未发布 CSI request pin 的 V57 冲突。已发布 V1–V60 字节全部保持，只将三个仍未发布的 CSI 文件顺延为 request V61、activation V62、native authorization V63，SQL 字节/顺序不变；完整序列止于 V63。同一合并把 H6b/H6c 基于 journal 的未应答 prompt 排除带入共享 Hosted turn runner，普通与 tool-profile turn 都从模型 history 过滤已定落的 error/cancelled prompt；recovered Runtime turn 路径保留其既有过滤。更早未发布编号仍需独立明确迁移方案。

Root Session 创建同时用 main 的同一原始 actor 字节写 creator 与 owner key，
私有构造时另写 CSI request pin。当前 CSI fixture 使用 main 的
OPERATOR/READER role 语义；历史 migration fixture 保留旧 schema 字段。
新的公开 child admission 必须在 Service 的 child/harness 操作前拒绝私有
CSI parent，并在 Store 锁住原 parent 后、重放或插入前再次拒绝。只复制 profile
而没有原始 request、Pod 和 reservation 不能构造合法 child。普通 child admission
及其既有测试保持完整。

保留共享 Hosted turn runner，把 main 的 child funnel 与 queued consumption
传入普通 tool turn；turn-result 写入成功后，只对 completed turn 刷新 consumed
child ID。每个 queued ID 只在其 durable consumption 成功后删除。拒绝刷新时
仅记日志并保留剩余 owed ID，不改变已落定 turn 的结果。私有 CSI 调用者不提供
child callback。保留普通 child redrive、wake consumption、所选 runtime
ownership 和全部既有 CSI 拒绝边界。

对精确集成提交验证 build/typecheck/bundle、相关 Hosted/child/HTTP Store
测试、Broker 与 Agent 测试、fresh/upgrade Flyway、格式和质量检查。独立地先复现
migration 重号与 private-parent child admission，再验证修复后的拒绝和原 SQL
守恒。在新的自有 MySQL mixed/export 运行前，让两个 Agent package 内嵌实际
Broker 字节。此前 f252 producer 结果与五组更早负向运行保留各自源码/产物
版本，不重新标成集成提交行为。原生 review 仍不可用，保持 Draft/maintainer
审查要求。

## 最新主线 V62 resource 后续同步

最新 main `83d422d251bd1aed957c3d1aff085bec093c0a3a` 发布 `V62__managed_task_cancel_operation.sql`。本后续增量逐字节导入该已发布 resource，不合入无关 H4f 生产改动。止于62的59个 migration 与该 main 前缀完全相同。四个仍未发布的 CSI migration 整体从61–64移至63–66，保持 SQL 字节与依赖顺序；只移动 activation 会把 request61 留在已经应用的 main62 之前。上文编号和验收属于历史记录。保留正常 validation，不使用 repair 或 outOfOrder 绕过。已经应用旧未发布 CSI 序列的开发数据库需单独明确策略。候选验收保留 target47 升级，增加真实 main62→66、旧 history 全行不变、旧业务列值保留及 native pin 仍为 NULL 的验证。文件名检查不能证明数据库升级，也不能转移旧产物验收。

独立封存候选通过两个原 MySQL 升级调用和全部15个原 H2 schema 对照。独立真实
main62→66 probe 校验全部59条旧 history 与全部旧业务列值，仅追加63–66，
native pin 保持 NULL、普通 CSI guard 保持 FALSE，实测62表 / 828列。原
filename guard 报告63个唯一 migration。全部7948项 record/input/origin/cleanup
谓词通过，自有资源已释放。Observer setup、序列化、query 与 audit 失败保留原
非零退出码；没有为了修 observer 重跑17个已经通过的原测试。
报告 SHA256：`cf7d2e6fa154754a8de74d76b95eb5ab971b06a6407540b3ea0a85dfcda6cade`；
freeze SHA256：`9b3c2f183845fa7c5dae7f4ce0ccb3a3903e92bd9b513195deaaf0b55fd48dc3`。
Resource/test source 与该候选准确一致。此迁移报告不验收之后 producer-wrapper
变化。本地 MariaDB、新 head CI、native review 与完整 K2 仍分别待做。
