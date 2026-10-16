# 原 settled owner application cut：库存附录

[English](2026-10-11-k2-settled-application-cut-inventory.md) | [简体中文](2026-10-11-k2-settled-application-cut-inventory.zh-CN.md)

本附录属于[应用退役设计](2026-10-11-k2-settled-application-cut.zh-CN.md)。当前实现使用主干标准结构；[结构适配](k2-canonical-schema-port.zh-CN.md)定义兼容边界。先前 61/62 表验收和旧 hash namespace 仍是其原始二进制的历史证据，不能资格化本候选、改写保留基线或证明物理释放。

## 原身份和键 namespace

T/S 是准确的原 tenant/私有 Session，W/D 是其保存的 Workspace/storage，Q 是完整原 managed-context 请求键，I 是不可变退役 ID。A 是 CSI 别名，F 是 backend/driver/volume 物理键。全部原始身份及保存关联必须一致。

标准会话 scope J 为 `ManagedSchemaKeys.key(T,S)`，资源键 RK 为 `key(J,resourceId)`。CSI 退役操作键为 `key("CSI_RETIREMENT",T,I)`，不同于通用操作辅助方法。会话记录归属使用真实领域键和版本；日志引用使用 `JOURNAL`、真实日志 owner 键/版本及 RK。不能恢复原先以 NUL 分隔的会话 scope、publication scope 或 extension 键算法。

Broker scope/request/execution 散列、CSI alias/physical 散列和 token 散列保留实际生产者的独立编码。必须从完整保存请求和原始身份计算；散列相等本身不能授予归属。身份 VARBINARY 字段严格按 UTF-8 解码；不透明 actor 键保持字节。

## 独立发现与关联

发现使用覆盖全部状态的独立 OR 条件，然后扩展原始引用集合至固定点。范围包含原始 Session、parent/root 谱系、request/binding/runtime ID、物理与别名身份、实际 resource/ref 归属、reader ID、schedule 及类型化 JSON 引用。每次扫描按下表声明的主键排序。不能用仅活动状态的过滤或父对象 join 隐藏候选。

`ma_operation`、`ma_operation_work`、`ma_request_receipt`、`ma_delivery`、`ma_artifact`、`ma_runtime_binding`、`ma_tool_execution` 和 `ma_output_capture` 需要有界完整表发现，因为关联可能是间接关系或存在于结构化 payload。其他声明使用真实 Session/Workspace/tenant/hash/physical 条件。未知关联、孤立父对象、原始/散列身份不匹配、不支持的领域或错误 payload 均保持 BLOCKED。未直接写出原 Session 的行不能自动归为 OTHER。

无关 owner 必须由真实父对象和领域链证明。共享 tenant guard、Workspace/access、storage alias 和 mode 回执先检查原始引用，再赋予明确上下文角色。原 TASK/公共活动、旧 action/extension、capture/publication、automation、channel 和恢复/迁移在第一条原生文件路径中仍不支持。原生文件历史仅通过真实 journal/resource/嵌入投影链接受。

## 标准结构明确清单（33 表、745 列）

应用清单为 `qwen-csi-application-inventory/2`，组件 checkpoint 为 `qwen-csi-retirement-inventory/2`，拒绝版本 1。准确字段名、顺序、JDBC 类型和主键由 `WorkspaceCsiApplicationInventory` 声明；全新 DDL 为 `packages/managed-agent-server/src/main/resources/db/managed-schema/`（V1–V6）。目录验证和检查使用同一真实 JDBC Connection，不添加兼容视图、别名或旧数据回填。

| 表                       | 字段数 | 主键 / keyset 顺序                                                       |
| ------------------------ | ------ | ------------------------------------------------------------------------ |
| `ma_agent_definition`    | 6      | `tenant_id, agent_id, revision`                                          |
| `ma_artifact`            | 9      | `artifact_id`                                                            |
| `ma_channel_binding`     | 9      | `tenant_id, channel_id, route_id`                                        |
| `ma_channel_instance`    | 12     | `tenant_id, channel_id`                                                  |
| `ma_csi_source`          | 19     | `binding_id`                                                             |
| `ma_delivery`            | 32     | `delivery_key`                                                           |
| `ma_event_stream`        | 15     | `tenant_id, session_id, stream_kind, stream_id`                          |
| `ma_message`             | 18     | `tenant_id, session_id, item_id`                                         |
| `ma_operation`           | 71     | `operation_key`                                                          |
| `ma_operation_work`      | 16     | `operation_key, work_kind, target_key`                                   |
| `ma_output_capture`      | 44     | `scope_key, publication_id`                                              |
| `ma_public_event`        | 26     | `tenant_id, session_id, stream_kind, stream_id, sequence_id`             |
| `ma_read_lease`          | 5      | `lease_id`                                                               |
| `ma_request_receipt`     | 31     | `receipt_key`                                                            |
| `ma_resource`            | 32     | `resource_key`                                                           |
| `ma_resource_ref`        | 11     | `session_scope_key, owner_kind, owner_key, owner_revision, resource_key` |
| `ma_runtime_binding`     | 40     | `binding_id`                                                             |
| `ma_runtime_session`     | 15     | `scope_key, runtime_session_id`                                          |
| `ma_runtime_slot`        | 12     | `request_key`                                                            |
| `ma_schedule`            | 25     | `tenant_id, schedule_id`                                                 |
| `ma_schedule_occurrence` | 16     | `tenant_id, schedule_id, occurrence_key`                                 |
| `ma_session`             | 45     | `tenant_id, session_id`                                                  |
| `ma_session_head`        | 36     | `tenant_key, harness_key`                                                |
| `ma_session_journal_tx`  | 25     | `tenant_id, session_id, journal_revision`                                |
| `ma_session_record`      | 33     | `session_scope_key, record_key`                                          |
| `ma_snapshot`            | 13     | `tenant_id, session_id, snapshot_id`                                     |
| `ma_storage`             | 14     | `alias_key`                                                              |
| `ma_storage_owner`       | 27     | `storage_key`                                                            |
| `ma_tenant_guard`        | 3      | `tenant_key, guard_domain`                                               |
| `ma_tool_execution`      | 28     | `execution_call_id_hash`                                                 |
| `ma_turn`                | 24     | `tenant_id, session_id, turn_id`                                         |
| `ma_workspace`           | 29     | `tenant_id, workspace_id`                                                |
| `ma_workspace_access`    | 4      | `tenant_id, workspace_id, actor_id`                                      |

`ma_csi_physical` 是独立六字段伴随表，主键为 `retirement_id`。完整全新结构因此包含 34 表、751 列。其类型化读端在应用闭包后使用同一 Connection 执行，不能向应用基线添加物理权限。

## 必要 prefix 与生产者 gate

应用所需 prefix 为 broker tenant placement P、输出保留 tenant R、slot/binding、当前私有固定值/上下文、registration、holder、不可变 intent 和同 intent 的 progress；随后核对完整原生 head/journal/resource/ref、逻辑 Runtime Session、execution 及剩余清单。通用写入使用由 profile 或保留请求固定值生成的持久私有谓词。原生写入验证准确原请求/进度，并保留各自协议 gate。

每个消费者接收同一活动 Connection 和已验证权限。同 DataSource 不足以满足要求。cut 事务中不能嵌套事务、延迟获取祖先锁、调用 RPC 或执行物理 IO。规划和 finalize RPC 在 SQL 锁外发生，随后比较完整像。总读取预算为十秒、4096 行和 32 MiB。metadata 探测和重复不变行不伪造额外库存；变化的重复行会被拒绝。

FROZEN 关闭普通原生 writer。唯一终止例外只消费一次准确持久冻结请求及前驱。CUT 仅新增声明的终止 transaction/resource/ref 行及 head 差异。DRAINED 再释放准确的原逻辑 Runtime Session。重试比较保存字节和版本，不 acquire 或 renew 现场权限。采集在分页前排除私有 Session，并在 claim 中复核；私有回调拒绝回滚全部暂定写入，包括 tenant guard。

## 剩余资格验证

当前结构、二进制键、清单、checkpoint、私有边界及查询预算回归提供有界本地证据，不能把历史 RC/RR、应用 E2E 或 Linux/CSI 资格转移给本合并候选。完整候选仍须在允许执行的范围内完成真实成员、回滚/重试/期限及 writer 竞争验收，以及两次完整差异的干净自审和评审。

实际 worker task、timer、renewal promise、executor operation、native history、保留文件、FD 和 backup 必须双向匹配。SQL 空集、过期、已完成 promise、旧 worker ACK 或合成 kernel observation 不能证明物理停止或卸载。原子物理释放、旧凭据验证、单调复用及公开选择仍是后续 K2 工作。
