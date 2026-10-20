# Hosted 清理欠账保护原 Runtime

[English](2026-10-20-hosted-cleanup-retention.md) | [简体中文](2026-10-20-hosted-cleanup-retention.zh-CN.md)

## 问题

Issue #13992 记录了启用 Runtime 历史留存清理前的条件。原 Runtime 已经释放后，
已提交的 `hosted.cleanup` descriptor 仍可能欠确认。删除其 binding 或 Runtime
Session，会使原始释放返回 `runtime_session_conflict`，导致欠账无法确认。
不能把 binding 缺失安全地解释成释放成功。

## 决策与范围

通过权威清理欠账投影保留原 binding，不引入具有任意有效期的释放成功 tombstone。
投影与原生 journal 事件在同一事务内写入。在所有欠账确认前，保护完整的原 binding
家族。Retention 继续默认关闭，不放宽任何释放授权。

## 投影

每条 owed cleanup 在 `ma_resource_ref` 中增加一个 `HOSTED_CLEANUP` owner。
owner key 标识所属 Session 中的 cleanup，owner revision 为原 Runtime generation，
resource key 指向不可变 descriptor。带索引的 `runtime_binding_key` 标识 tenant、
Workspace 和 binding，同时检查已有的原始 tenant、Workspace 字段。在投影变更前，
descriptor 已根据 journal 的精确 Session 范围和引用清单完成校验。

同一笔尚未确认欠账的重复 owed cleanup 必须保留同一 descriptor 和原始身份。confirmed 事件只删除
自己的 cleanup owner；其他 cleanup、Session 或 generation 继续受保护。
descriptor 原有的 journal 引用独立于新增 owner，继续保护其字节。

## 兼容性

Schema V13 为引用增加 owner 和 binding 索引，并在原生 journal head 增加可空的
`cleanup_head_revision` 水位。新 head 从零开始。普通提交将当前水位与 journal、
cleanup owner 原子推进。缺失或过时的水位，不会因为后续事务没有 cleanup 事件
就被重新认证为当前。

冻结的 CSI 终局路径只接受一条 `activation.changed` 释放事件及其 boundary
resource，不能携带 `hosted.cleanup` 事件。该路径不推进 cleanup 水位，因此即使是
新 head 经过此路径后也会变为未验证，其 binding 家族继续受到保护，直到 journal
永久回收。将水位覆盖扩展到该路径留待后续处理；当前行为是保守地过度保留，而不会
丢失 cleanup 欠账。

既有 head 有意保持未验证。在 journal 仍可恢复期间，retention 保留其 binding
家族，避免不安全的部分回填，也不把缺失历史当作释放证明。只有永久删除的 Session
已经回收 journal owner 和事务后，才能解除此保护。所有 Java catalog 读写者须一起
升级；V13 之后，旧二进制不再是兼容的回滚版本。

继续遵循现有部署切换策略：使用新数据库，停止旧准入，结清进行中的工作，并保留
旧环境供历史读取。V13 读取器不能恢复 V12 已冻结、切割或排空的 CSI 退役清单。
原生 V12 到 V13 测试只验证隔离 catalog 中普通 head/reference 的保留，不证明
进行中的 CSI 退役可重放，也不构成生产数据库原地升级的验收。

## 寿命与并发

Owed 欠账不过期。任意晚的恢复仍须能访问它的原 owner。确认会删除该欠账的附加
引用。永久 Session 回收只有在原生 journal 不再可读后才删除剩余 cleanup 引用，
使 descriptor 无法通过保留的 journal 再次变得可达。这保留的是未完成工作，不会
为每次已完成释放积累永久成功 marker。

Runtime collector 在删除任何家族成员前，通过自己的事务连接检查投影，保留
placement、binding 的锁顺序。普通 journal 路径只修改 Session 范围的 journal 和
引用状态，不在持有 journal head 时获取 Runtime binding 锁。不确定或不可读的
证据会保留历史，不会确认一个无法证明的释放。

## 涉及组件

原生 journal 提交、schema 初始化与校验、Runtime retention guard，以及永久退休
Session 的引用回收。公共 API、Hosted descriptor 格式、Runtime release 路由和
部署开关默认值保持兼容。

## 验证与验收

- 提交 owed cleanup，释放原家族并使其过龄，然后 sweep：精确 binding、Runtime
  Session 保留，原始释放仍成功。
- 重开存储后重复释放；从未存在、外来身份及 generation 不匹配的对照继续拒绝。
- 仍有另一笔欠账时，只确认一笔不能解除回收保护；所有原 owner 欠账确认后才可回收。
- 回滚 journal 事务，确认投影也整体回滚。
- 保留旧 head 或水位过时的 journal，只在永久 journal 回收后解除保护。
- 在 H2、MySQL 8.4 验证 fresh、forward schema 初始化，以及 standalone/Flyway
  清单一致性。Runtime retention 继续关闭。

## 待定问题

本次有界实现没有待定问题。回填仍在使用的旧 head 可以作为后续优化，不是安全启用
retention 的必要条件。
