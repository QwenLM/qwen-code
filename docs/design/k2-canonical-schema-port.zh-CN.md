# K2 标准数据库结构适配

[English](k2-canonical-schema-port.md) | [简体中文](k2-canonical-schema-port.zh-CN.md)

## 状态与问题

实现和兼容验证正在进行。本文描述 K2 对主干全新标准托管数据库结构的适配，
不授予应用退役、物理释放或安全卷复用资格。

主干将旧表合并为 32 张 `ma_*` 表、707 个字段。K2 的旧表名、行归属规则、
日志键和组件快照格式不能通过别名保留。全新初始化器拒绝旧数据库；本次变更
新增 K2 迁移不提供旧结构回填或兼容视图。

## 数据库结构与行身份

保留当前主干 V1–V9 的原始字节。V1 为 32 表 707 列，包含新增重试预算字段；V2 增加四个私有 CSI 权限字段，V3 调整列表索引，V4 扩展 Workspace 创建 receipt namespace，V5 增加四个模型选择字段，V6 增加四个审批选择字段。V7 增加 SSH storage 索引并扩展 operation kinds，V8 增加 input/cancel operation kinds，均不新增表或列。V9 增加 runtime Session 的 harness 索引，不新增表或列。未发布的 K2 退役增量以不变 SQL 字节顺延为 V10，增加十一个应用进度字段、`ma_csi_source`（19 列）和 `ma_csi_physical`（6 列）。有效结构为 34 表 755 列，应用清单为 33 表 749 列，物理伴随表单独检查。`ma_session.csi_guard` 由私有工具 profile 或持久 runtime request pin 生成。

十一个主干新增字段均进入原始 typed whole-row 比较，包括 Session 模型 `(NULL,0)`、Turn 模型双 NULL、三项重试预算字段与四项审批选择字段。私有 Session 仅支持审批覆盖 `(NULL,0)`；非默认覆盖阻塞，普通审批选择保留主干行为，Turn 审批字段保留实际 nullable 快照。`model_id` 使用严格 UTF-8 identity 解码，但不成为新的强引用根。私有首条路径保持固定 native 模型策略，只支持实际 Session 默认 `(NULL,0)`；非默认选择完整进入清单并阻塞退役，普通公开模型选择保持不变。旧 inventory/2 baseline 缺列时仍被拒绝，不补默认值、不改 header/hash 或已存 bytes。旧未发布 K2 V4/V6/V7 不伪装为已发布主干迁移，不修改 Flyway 历史。缺少已发布 SSH 索引或 operation check 的旧私有预览 catalog 在迁移前拒绝；历史访问保留原构建，本候选使用全新临时 catalog。

原生资源读取证据使用现有 `ma_request_receipt`，namespace 为 `SESSION_COMMAND`，
operation 为 `CSI_RESOURCE_READ`，真实主键为 `key("csi-read", readId)`。
JSON 入场时有明确的 23 字段，完成时有 25 字段。库存核对完整外层 row、初始
request digest，以及原 resource/journal/writer 关联。OPEN 和 UNKNOWN 回执
阻断应用退役。不存在独立原生读取表或拼造的兼容 row。

身份使用标准 VARBINARY 字段并严格按 UTF-8 解码。不透明 actor 键保持为字节。
散列和主键遵循实际生产者：会话范围为 `ManagedSchemaKeys.key(tenant, session)`，
资源身份为 `key(scope, resourceId)`，CSI 退役操作身份为
`key("CSI_RETIREMENT", tenant, retirementId)`。最后一个身份不同于输出操作
使用的通用操作键辅助方法。

退役使用真实 `ma_operation` 行，其中请求 JSON 不可变，结果使用带版本的封装。
解码器核对完整原始身份、目标、请求摘要、范围、种类、代数及结果数据。
进度 CAS 更新以真实操作键和种类限定。日志资源引用必须匹配实际 owner 种类、
owner 键、owner 版本、资源键及原始身份元组。会话记录引用保留其领域版本语义。

## 清单与历史

应用清单使用 `qwen-csi-application-inventory/2`；组件 checkpoint 快照使用
`qwen-csi-retirement-inventory/2`。版本 1 的表和归属语义不同，因此拒绝接受。
读端和夹具必须一起迁移；仅修改格式头不足以完成适配。

现场检查和保留历史都在同一 JDBC Connection 上验证标准目录，并共享既有的
十秒查询预算、4096 行和 32 MiB 完整行上限。历史 owner 查找使用 tenant 和
实际操作主键。重复读取只计算一次完整行，并拒绝变化的重复行。

归属依据实际父对象和领域关系判断。未直接写出原会话的行不能自动归为无关行。
共享 tenant guard、根工作空间状态、存储别名及 mode 回执具有明确的上下文角色；
赋予这些角色前先检查其对原始谱系的强引用。不支持的原始活动阻止退役。
预期像保留全部行值，仅允许已声明的阶段差异。

## 运行时与写入边界

适配保留主干的会话创建、事件流、工作空间操作、capture 及资源生产者。
原生 writer 准入在创建会话根或日志头之前检查原始 CSI 边界。普通 action、
extension、dispatch 及输出写入路径保留私有会话保护。采集在分页前排除私有
会话，并在认领事务中再次检查存储的真实目标。

原生资源读取、授权、终止提交和原运行时会话完成使用标准表及键。
应用进度仍为 SETTLING/1、FROZEN/2、CUT/3 和 DRAINED/4。物理 RELEASED
是独立里程碑，不能从 DRAINED 推断。

## 涉及组件与验证

涉及 runtime-broker 标准结构及 JDBC 仓库、managed-agent 存储与清单/像/历史
读端，以及 TypeScript checkpoint 消费者。测试必须初始化全新结构，并尽可能
通过实际生产者创建行。故障注入必须观察当前 SQL 边界，不能依赖已过时的语句写法。

验收要求两种初始化路径结构一致、普通行为回归、私有积压隔离、原生及
checkpoint 协议检查、精确应用像和回滚/重试行为、同步读端、build/typecheck，
以及两次完整差异的干净自审。纯 H2/数据检查不能证明 Linux、CSI 或节点来源
资格。受限验收继续记录为未完成。

## 范围与后续工作

本适配不安装 collector 或创建付费节点。来源安装与约束资格化、原子物理释放、
历史旧凭据验证、单调安全复用及公开选择仍是独立的 K2 工作。剩余标准 artifact 和 secondary domain 的被动归属支持尚未完成，未知行继续阻塞。在这些前置条件
通过所需检查前，公开选择保持关闭。

## 主干新增普通写入隔离

生命周期失败结算必须在任何 operation/head DML 之前核对实际 private fence。模型用量的普通界面投影仅接受 `csi_guard=FALSE`；私有 journal 的原模型事件与原资源不变，不额外生成 `hosted_context_usage` domain/ref。Action 扫描及已结束 action 的恢复结算都在 LIMIT 前排除 private Session，claim/结算事务内再核；工具结果采集保留方法级 private 早退。新 approvalMode 创建重载仍核对 resident 注册或 LOCAL storage。

普通 H2 数据组件控制验证这些边界，不证明 MySQL 锁、原生 producer、物理停止或卷复用。

## Workspace 创建回执的被动归属

全局回执扫描还会遇到普通公开 Workspace 创建。已完成的 `WORKSPACE_CREATE` 回执可以属于原 tenant 内另一个 Workspace；把这类行一概视为未知 owner，会阻塞无关退役。本次仅支持这个已完成的 producer 形状。PENDING、孤儿、未知和冲突回执继续阻塞。

核对实际回执键、tenant/scope/idempotency 摘要、actor scope、`CREATE_WORKSPACE` 操作、完成状态及全部未使用领域列。Result 仅接受原准确四字段，或当前准确七字段且 sourceWorkspaceId/sourceGeneration/cwdRelative 全部显式 null 的形状，继续校验 producer 名称/摘要及 canonical registration UUID；部分扩展、非 null 目录选择及未知字段继续拒绝。Workspace/storage ID 必须由实际 receipt key 派生。在原 Connection 读取真实 ROOT Workspace 与已注册 LOCAL alias，核对精确身份和注册关联，拒绝原 Workspace、storage、physical key 或任意原强引用。保留完整行和原聚合上限。这只证明被动归属，不进行文件系统或 runtime I/O，不改变 owner，也不把原 Workspace 创建活动纳入支持的退役工作。

普通 H2 测试使用真实公开 Workspace 创建 producer，保留回执与原行完整字节，覆盖损坏的摘要/result、缺失或变化的父对象/alias、原引用及 PENDING 状态。它们不证明 MySQL 锁序或物理资格。Artifact 与 delivery 仍须独立验证其 producer 链，不能把未知行直接分类为无关。

本次仅增加 live 清单归属，不扩展历史 carrier 解码器，也不资格化任意并发 foreign 活动；已保存 OTHER 完整行仍参与全像比较。

## 主干 fbc698a651 兼容

合并逐字保留已发布 V1–V9 资源，仅将不变的私有退役 DDL 追加为 V10。显式初始化与 Flyway 均须识别并保留全部已发布前序、普通行和已安装历史。标准 DDL 组合器同时支持主干完整 check 替换和 K2 表/列/unique-index 增量；live 清单与保留历史使用的同 Connection 验证重载保持必需。旧私有 V7 catalog 不是已发布 V7 前序，必须拒绝，不 repair 或部分迁移。

主干 V7/V8/V9 不增表或列，因此现有 typed 清单保持33表749列，另有6列的物理伴随表。新 SSH 和命令操作活动仍经过既有归属及支持活动规则，不能悄悄归为无关。普通取消在操作准入前保留私有 Session 守卫。仅前台 SSH 工具声明保留无 monitor/无 background 形状，同时共享既有 Write/Edit 描述。私有第6版 boot 与非容器及 publisher 模式一样拒绝 SSH runtime 注入。

定向 H2/mock、仓库构建与临时 MySQL 8.4 V9 至 V10 迁移检查覆盖此次兼容增量；私有 Main/F2、Hosted/原生故障组，以及物理/复用资格均不在这些检查范围内。
