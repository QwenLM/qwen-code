# 可信 CSI worker 身份与持久回执 ACK

[English](2026-10-03-csi-durable-worker-ack.md) | [简体中文](2026-10-03-csi-durable-worker-ack.zh-CN.md)

状态：IMPLEMENTED，最终整合 PR 源码的受控 ACK 云上验收八组通过。专属测试对象、
云盘、bucket 与凭据目录已回收；后续只读 ECS 查询确认自动扩容实例已不存在。
等待 maintainer 整合审查。本文继续 [ACK-1](2026-10-03-csi-original-worker-ack.zh-CN.md)，与 K1
及此前 CSI 阶段一起纳入草稿 PR #13289。

## 问题与范围

ACK-1 在 worker 内存中确认一条原始回执。在 ACK-1 基线时，CSI adapter 不能
创建 worker，也无法提供可信、已持久化的预期 Pod。现在私有 adapter 把 API 观测
的身份保存到现有持久 binding handle；原 publication 与 receipt 权威再次通过
校验后，才追加一条 ACK 证据。

本操作只证明单 publication 的回执 ACK，不宣布 DRAINED、不释放 holder、不清除
生命周期 blocker、不删除资源、不认证全部 MCP 历史，也不证明 CSI NodeUnpublish。
云上验证覆盖本操作的完整链路，不覆盖聚合物理退休。公共 Hosted CSI 选择保持
关闭，现有 K1 与 LOCAL 行为保持兼容。

## 可信放置

显式配置可信 Kubernetes API、cluster domain、digest 固定的 worker image/command、
registration 与资源保护身份。私有 adapter 在 API 变更之前预约原物理 holder，
检查现有 resource guard，然后创建一个 immutable boot Secret 和一个受限的、
restartPolicy Never、PVC 支撑的 Pod。worker 不携带 Kubernetes 凭据；downward API
提供 Pod UID、namespace 和 node name。

固定 base image 未包含打包 CLI 时，可信部署可提供最多 48 个 immutable ConfigMap
artifact chunks。固定只读投射的每个 chunk，其 API UID 与 SHA-256 均保存到 handle，
每次观察重新校验。可信 command 验证压缩 bundle，在 tmp 解压后启动 worker。
这是固定 artifact mount，不允许任意 Pod template 注入；ConfigMap 读取不增加
worker 权限。

null handle 仅允许在两个对象均不存在、且创建得到明确成功回复时创建。已有对象、
409、丢失创建回复或 handle 持久化之前的崩溃均属不确定状态，拒绝继续。不能从
annotation、worker 返回的身份或匹配的 boot 字节推断原 Pod。失败不自动删除资源，
也不允许创建第二个 Pod。

返回 handle 前，通过 API 观察同一创建的 Pod 与 Secret，核对 node UID、运行中
container ID、immutable image ID、零重启、受限 spec 和原 PVC/保护 pins。完整的
封闭身份通过 Broker 的 claim fencing CAS 写入现有 binding resource handle，不
保存凭据字节。READY 还要求原 managed-context 与 CSI mount attestation。已有
handle 仅允许观察、精确认证原对象，禁止创建。

现有 retirement immutable identity JSON 捕获此 handle。ACK coordinator 从已保存
handle、registration 与加密 provision seed 推导预期 Pod 及原 boot/storage。
旧 null 或 K1 handle 不具备资格。不增加 provenance 表或调用方提供证明的接口。
handle 持久化之前失败会保留 reservation，需要后续 operator 处理；不承诺自动
崩溃恢复。

## ACK 权威与持久化

提供私有 coordinator 和真实命令，只接受 retirement 与 tenant/workspace/Session/
publication selectors。使用同一 DataSource 的原生 repositories，拒绝 ambient
transaction。读取原 DRAINING binding、active slot、物理 holder、immutable
retirement、READY Runtime Session、seal 前已授权的 SETTLED deferred-v3 execution
及完整 publication binding。命令输入不接受 endpoint、token、Pod、response JSON
或成功标志。

准备 immutable plan，包含原 terminal/finish operation、已验证 admission outcome
与 manifest、精确 committed tool.receipt 和实际 capture identity。复用现有
publication resource 校验，在最终事务外执行；该校验可能更新验证或 quarantine
状态。发往原 lease 的 ACK-1 RPC 之前，结束所有 SQL 事务。

精确的正向确认后开始新的短事务。复用现有锁序：placement domain 与 active
binding、registration 与物理 holder/retirement、native Runtime Session、execution、tenant 与原 Session
head、publication、receipt/finish/resource 权威，最后 ACK key。等待后使用 current
locking read，再次检查全部原 pins 和当前 writer、activation、quarantine 及
referenced-resource 状态。最终事务不进行 worker RPC 或外部 object I/O。迟到
冲突或提交失败均不安装行。不存在已保存行时，重试重新请求同一原 worker。

使用当前 main 尚未占用的下一迁移编号，增加一张 append-only 表
`managed_workspace_csi_worker_ack`，以 retirement ID 和精确 execution ID 的 SHA-256
为键。保存原 ID、有界封闭 evidence JSON、字节 digest 与数据库 epoch-microsecond
观测时间。回读并严格验证完整首行。语义相同重试保留首次字节/时间；同键冲突或
损坏文档拒绝继续。重启后的历史读取不认证 worker 存活，也不授权释放 storage。
不从 REFERENCED publication 回填。

证据 schema 与 wire 16 KiB、保存文档 32 KiB 上限沿用 ACK-1 的 ACK-2 设计。
SQL revisions 使用 canonical decimal strings，原 receipt sequence 使用精确 safe
integer。完整 Broker result 使用既有数值语义比较，不丢弃其他字段。

## 文件与验证

扩展私有 CSI provisioner 并增加封闭 handle validator。增加 coordinator/command
和一条 migration；仅在最终 locking 校验需要内部复用时扩展既有 publication
authorities。保留聚焦源码测试，同步更新 ACK 双语设计。

E2E 计划区分 global CLI baseline、fake API 放置边界、native worker HTTP、生产
publication/receipt 链、H2 持久化、真实 MySQL repeatable-read 锁等待和真实 ACK
集群资格验证。持久化正向验收必须从 Kubernetes API 获得身份，通过生产 API 获得
receipt/capture/publication，不能用 SQL 写入成功状态或 canned ACK 替代。验证精确
重试/重载、丢失回复、并发插入、回滚、迟到 expiry/quarantine 与错误原身份。记录
source/bundle/class hashes、实际断言、时区检查和所创建资源的清理。

## 云上验收与未决约束

使用唯一专属 namespace、一次性 RWOP disk、既有 restricted Pod profile 和固定
公共镜像，保留无关集群资源。当前 profile `data-governmance` 与目标 cn-beijing
集群有效；API endpoint 为内网，本机直接连接超时。既有 OAuth profile 可以通过
ECS 云助手在集群节点执行本次专属临时验证命令。通过私有临时 OSS bucket 暂存
校验 checksum 的工具，短期 kubeconfig 仅保留在专属目录的 mode-0600 文件中，
验收后清理二者。无需开放公网 API endpoint 或永久修改宿主机配置。

2026-10-03 16:34:48–16:35:16 UTC，最终整合 PR 源码在实际阿里云 ACK
运行八组全部通过：实际 adapter 的 API-origin 放置和
native publication/receipt；响应丢失后零行；原生插入后提交前失败导致回滚；
两个并发真实 ACK 只安装一行；错误 retirement 拒绝；精确原 manifest quarantine
拒绝；保留 DRAINING ownership 的原始不可变重试；以及生产命令在第二 JVM 的
历史回读。实际 ACK 后 worker status 保留精确原 seal 身份，仍为
DRAINING/BLOCKED，capture、publication 与 shell 生命周期 blocker 均保留。

publication service 使用真实 HTTPS，临时私有 CA 由两个专属 native 进程信任。
测试使用同一 Pod 内跨 JVM 的 file H2 和 inline publication，不认证 MySQL 正向
并发、Pod/PV 重启恢复、外部 OSS publication objects 或公共 Hosted CSI。另行
执行的真实 MySQL repeatable-read resource-reference 与 manifest 锁等待，在迟到
writer expiry 和 quarantine 后拒绝安装 ACK，保持零行。原生数据库 epoch-
microsecond 表达式在 UTC 与 +08:00 共检查 128 次采样。真实 MySQL V34→V38
升级保留原迁移历史、LOCAL/Hook 数据与旧 PREPARED 记录；新增授权列保持 null，
没有回填 ACK。本地或历史结果不能替代本次云上运行。

此前失败的测试部署及其数据库分别保留。验收运行必须保存原始证据与精确的
source/class/bundle hashes。专属 namespace/PVC/PV/VolumeAttachment、临时云盘、保护/RBAC 对象、临时 OSS
对象/bucket 以及节点和本机凭据目录已删除并验证不存在。两个原节点保留原 UID 与
Ready 状态。16:45:29 UTC 自动扩容节点仍存在；17:02:41 UTC 的另一次只读 ECS
查询返回零个匹配实例。没有手动删除节点，也不宣称最终计费已结清。仍需
maintainer 整合审查；聚合 drain/release/NodeUnpublish
保持在本操作范围之外。

10 月 4 日主线整合因 main 已占用 V35–V39，将四个未合入 CSI migration 顺延为 V40–V43。10 月 5 日整合保留 main 新增的 V40 Session creator migration，将 SQL 内容不变的 CSI 链顺延为 V41–V44。上述 V34→V38 MySQL 结果及此前任何 V39→V43 结果均属于原编号和提交，不能作为当前 V40→V44 升级的验证。已应用的私有历史须显式核对或使用新数据库，不自动执行 Flyway repair。
