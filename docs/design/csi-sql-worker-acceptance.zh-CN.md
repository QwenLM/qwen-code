# CSI SQL 到 worker 验收

[English](csi-sql-worker-acceptance.md) | [简体中文](csi-sql-worker-acceptance.zh-CN.md)

## 问题与当前状态

私有 READY 原 owner CSI 合同已有 SQL 准入、认证 native 回读、有限文件工具和
retained history。现有组件测试使用捕获的 native prefix 或 worker 回复，尚未证明
SQL 从实时 native 记录生成的 grant 能到达认证 worker，并在同一原 activation
上经过 retained history 完成续接。

## 测试方案

新增显式调用的 MySQL 集成测试与 Node producer/worker fixture。建立新的
canonical V1/V2 catalog，通过生产创建和 reservation API 建立原私有 Session。
真实 Core managed authority 与 HTTP store adapter 连接生产 JDBC store，使用
真实 Broker service、HTTP server 和 `WorkspaceCsiRuntimeAccess.readNative`。
worker 使用生产认证、native fetch、composer、文件工具和 retained-history
实现。SQL grant 必须来自 dispatch；fixture 不得插入
`native_authorization_json`，也不得伪造成功路径的 native journal marker。

在一个 writer 与 activation 下顺序执行 write、edit、read 批次。通过 authority
提交实际观察的 history 和工具回执，消费 runtime 结果后继续下一次输入。核对
原始 preimage、后续 retained backup 与最终工作文件字节。准确的 allocation/start
重试必须保持 grant 与文件效果。错误凭据、owner/context 或未授权 execution
必须在文件效果之前拒绝。

## Fixture 边界

数据库、listener、worker 进程与工作目录均由测试拥有，在 `finally` 清理。
placement/protection descriptor 是显式 fixture，不是 Kubernetes 观察。仅在测试
中将固定 fixture Pod endpoint 映射到自有 loopback worker；header、body、lease
与 incarnation 保持不变。在所有平台上都明确标记 mount/proc-fd 映射，底层仍使用
真实 inode 和文件 handle，因此文件 backend 不依赖宿主是否暴露 `/proc/self/fd`；
mount 来源仍是 fixture。不 stub worker 结果、native 回读、SQL 授权、文件工具或
history composer。验收证明这些边界下的 SQL/HTTP/文件链路，不证明原生 CSI mount
或 Kubernetes 部署。

## 文件与范围

实时复现发现 HTTP adapter 遗漏私有 file-history preparation 内的 input、声明和
intent 引用。仅对 schemaVersion 2 / `csi-files-retirement/1` 收集这些引用；不重新
纳入 predecessor 元数据引用，它已由原 journal 事务拥有。这保留 SQL 准确的
同事务 candidate 校验。collector 的 commit、resource-read 和只读 snapshot
消费者共享该规则；普通 file-history snapshot 的既有行为保持不变。

改动限于这个 Core collector 与回归测试、managed-agent-server MySQL 测试、
测试资源及这对双语设计。既有 `mysql-integration` profile 会发现新增 IT。
已发布 V1/V2 与 32 张业务表保持不变。不增加
公开 selector、Hosted 私有执行、替代 writer、冷恢复、DRAINING continuation、
terminal/finalization、退役、release、reuse 或部署功能。若发现生产正确性缺陷，
必须先复现，再在既有 READY 原 owner 边界内单独修复。

## 验证与验收

使用隔离 MySQL 数据库、已构建 Node 模块和新编译 Java 类，记录源码、依赖、
commit 与清理绑定。全局 CLI 没有这个内部 fixture 的 operator 入口，使用显式
test-script fallback。验证成功路径的 SQL grant/回读/worker/续接和拒绝用例，
再执行 build、typecheck、bundle、受影响测试与 Java 静态检查。完整 diff 完成
两轮无问题自审，并独立评审。证据必须区分 H2、真实 MySQL、macOS 平台映射与
Linux CI。维护者架构复审要求继续保留。

## 待确认事项

范围无待确认事项。原生 Linux CSI 与部署验收属于后续工作，不能由本集成 fixture
推导。
