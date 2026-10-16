# K2 私有原 Runtime 装配

[English](2026-10-08-k2-private-runtime-composition.md) | [简体中文](2026-10-08-k2-private-runtime-composition.zh-CN.md)

状态：operator/context 前置能力已实现并通过有界本地软件验证。关联 #12380、
#13395 和 Draft PR #13526。连接私有 Hosted attachment、原生文件执行和完整
退休仍未完成。

## 问题与当前状态

离线私有 CREATE 提交原 Session 和 request pin，CSI provisioner 可以保留并证明
原 Pod；本入口实现前，没有生产调用者装配该 provisioner。普通内嵌 Broker 拒绝
Kubernetes，并通过 LOCAL 别名解析 Workspace Session。其 Workspace transport
安装旧 context 并激活旧 workspace 门禁；让私有 profile 经过这条路径会取得错误
authority。仅使用 `HttpRuntimeTransport` 也不足：其 acquire 是 no-op，不能安装
私有 context。

私有入口服务一个明确选择、已经提交的私有原 Session。它不创建替代 Session，
不登记存储、不安装集群保护，也不产生第二个 placement pin。

## 装配

私有命令 `WorkspaceCsiRuntimeMain serve <reviewed-runtime-json> <port>` 构造
既有 JDBC repositories、CSI reservation store、原 CSI provisioner、Runtime
Broker service 和经过认证的 loopback HTTP server。JSON 指定 registration、原
Session UUID 及私有 CREATE 返回的 `runtimeRequestKey`、digest 固定的镜像、
command、不可变 worker artifacts 及已安装的
protection identity。凭证保留在环境配置和 Kubernetes token/CA 文件中；请求
JSON 和输出均不含凭证。配置解析限制大小，拒绝重复、未知及尾随 JSON 字段。
命令使用 `K2_JDBC_URL`、`K2_JDBC_USER`、`K2_JDBC_PASSWORD`、
`K2_AGENT_REVISION`、`K2_CLUSTER_DOMAIN`、`K2_KUBERNETES_API_URL`、
`K2_KUBERNETES_TOKEN_FILE`、`K2_KUBERNETES_CA_FILE`、
`K2_RUNTIME_BROKER_TOKEN`、`K2_RUNTIME_BROKER_ORIGIN` 和既有
`QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID` /
`QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY` 配置。只监听 loopback，端口须明确
选择在 1024 至 65535 之间。既有 Maven 打包另外生成本命令的 `csi-runtime`
可执行 JAR。

authority 传播依赖现在要求规范的部署 origin，生成私有 boot5/handle3。HTTPS 可以
作为自有 loopback listener 的前端；HTTP 必须精确指向该 listener。原 authority
被纳入不可变 Secret 和 boot/handle digest，重启时保留原值，即使进程配置已经
改变。Boot4/handle2 保持构造兼容。该依赖正在验证，不增加原生读回、文件历史、
dispatch grant 或公开 selector。完整方案见
[历史集成设计](2026-10-09-k2-native-history-integration.zh-CN.md)。

resolver 在原 datasource connection 的全新有界事务中通过
`requireCsiRequest` 读取已提交的 Session，先锁 placement domain，再锁既有
retention tenant 行，并验证已登记存储。tenant 锁可能初始化其既有锁行，但不会
创建另一 Session 或 placement pin。resolver 只接受配置中的 Session 及预期 `runtimeRequestKey`，并拒绝 lifecycle
authority。返回 scope 来自
该读回；调用者的 Workspace 标识、已保存的 receipt 和 journal head 不授予
authority。

私有 transport 获取原 bootstrap Runtime Session，要求
`runtimeSessionId == harnessSessionId == 原 Session UUID`。context RPC 前，
它在同一个物理事务连接上锁原 placement domain，读取原 Session pin、binding、
reservation 和持久化的 ACQUIRING/READY Runtime Session。要求 binding 为
READY 且未 draining，request/seed/lease/resource handle 为原记录，物理身份仍
reserved，CSI 身份已经 attested，context descriptor 属于原 Session 且 revision
为 1。共享的原连接 single-Session guard 也拒绝额外或外来 Runtime Session 行；
让本 transport 可以调用既有 guard 不会放宽其 predicate。随后在
事务之外调用既有 CSI protocol 2 `installContext`，响应后再次执行权威读回并
比较 binding、Runtime Session 的 version，才接受响应。既有原 repository 的
READY CAS 仍是最后准入门禁。网络 I/O 期间不持有 SQL 行锁。

install 响应不是执行授权。这个前置 transport 拒绝 tool control/execute/cancel
及普通 release。原生文件 bind、preparation 和 dispatch 需要各自的原 journal
准入。停止 operator 进程只关闭本地 executor 和 HTTP listener，不退休原 Pod，
也不释放 reserved storage。

## 失败与竞争语义

错误的 Session、profile、registration、pin、scope、owner、generation、lease、
reservation 或 state 在 worker RPC 前拒绝。seal 在 RPC 前获胜则拒绝安装；
响应等待期间发生 seal 或 identity/version 改变，则响应后拒绝准入，并保留原
reservation 和不确定的安装。超时、transport 失败和重启均不授权替换或普通
release。当前读回和原 CAS 必须同时成功；先前通过的本地 fixture 不能替代它们。

Pod 创建和恢复仍遵循既有 provisioning/startup reconciliation 规则。命令不放宽
API provenance、digest/UID 校验、歧义 blocker 或具体 backend 的 registration
guard。尤其当前 disk guard 仍是既有 ACK 特定实现，本变更不声明通用 CSI
backend 验收。

## Hosted attachment 边界

后续内部 Hosted 入口必须使用经过认证的原 `/session` 协议和当前 boot identity。
其 Session Store URL 必须来自可信的私有启动配置，而非调用者 descriptor。它
必须将原 Broker acquire 返回的私有 capability/scope 与原 SQL Store 对齐，使用
其 scope writer credential，仅创建精确的私有 definition。公开 create/load 的
profile 选择保持关闭。

同一 boot 的 attachment 可以重放缓存 owner。cold load 不得悄悄安装新 activation：
原 writer generation 和 activation epoch 固定为 1，当前 SQL 准入拒绝替换。
初始化失败必须保留不确定 authority；detach/delete 不得调用普通 writer seal 或
runtime release。本装配自身尚不实现 attachment。

## 文件与消费者

| 区域                                                            | 变更及消费者                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `managed-agent-server/.../store/WorkspaceCsiRuntimeMain.java`   | 私有可执行 operator 与既有 Broker HTTP server 装配。                                                               |
| `managed-agent-server/.../store/WorkspaceCsiRuntimeAccess.java` | 原 Session resolver 与 context acquire guard，由该 operator 消费。                                                 |
| `managed-agent-server/pom.xml`                                  | 独立 `csi-runtime` 可执行打包；普通 Spring 入口保持不变。                                                          |
| `runtime-broker/.../JdbcCsiFilesRetirementGuard.java`           | 暴露既有 single-Session guard 供私有 transport 调用；原 binding、session 和 tool repositories 保持相同 predicate。 |
| 同目录 Java 测试                                                | 原 CREATE/JDBC 准入、错误身份、seal 竞争和 RPC 拒绝。                                                              |
| 本双语设计                                                      | 生产入口、信任边界及验收限制。                                                                                     |

不增加公开 Spring provisioner 选择、Hosted profile 白名单、wire schema、数据库
migration 或第二个 placement authority。

## 验证与验收

先检查全局 `qwen` CLI 并记录能力限制，再用明确的独立 JDBC/HTTP fallback 调用
既有生产类，展示缺失的装配/context 路径。实现后，以原 CREATE、repositories 和
经过认证的 Broker HTTP 执行实际新装配。覆盖正确 acquire/replay、错误凭证 /
Session/profile/pin/reservation、context 身份、RPC 前及等待期间 seal、sealed 或
改变的准入、关闭的 tool/release 操作及自有资源清理。保存原始请求和 SQL
前后状态。

独立验证通过 Spring Boot PropertiesLauncher 及自有外置 H2 driver 运行
classifier JAR。实际 Main HTTP 验证鉴权、warm、原 ACQUIRING 到 READY 的
acquire 及只读重试。直接原 JDBC/HTTP 探针保存 install 请求，确认 RPC 期间
没有 SQL 事务、重试身份稳定，并比较完整 53 表；另一事务 seal 或版本改变后，
迟到响应被拒绝。resolver 可以初始化一个既有 tenant 锁行，该行为与只读 acquire
分开记录。合法 history control 和普通 release 仍拒绝，Main 停止保留 RESERVED
存储。全局 CLI 限制、初始探针失败、执行来源及清理另载于独立 E2E 报告。

build/typecheck/bundle、相关 Java 测试和静态检查在独立窗口前已通过。私有 CREATE
setup 使用原生产类，但 Kubernetes API/attestation 是合成 seam，context HTTP
receiver 也为自有探针；没有运行物理 CSI worker 或生产 Hosted Session。H2 fixture 或模拟
Kubernetes observation 只证明其测试的软件边界，不是 MySQL 锁、物理 CSI 或
完整 K2 证据。当前提交的 MySQL RC/warmed RR、可信生产 Hosted attachment、
read/write/edit、原生 file history、publication/receipt/checkpoint 闭合、聚合
DRAINED/RELEASED、物理 writer 终止、NodeUnpublish 和安全复用仍需各自的完整
连接验收。

## 开放决策

入口有意消费现有 registration 和私有 CREATE。私有部署提供经过审阅的凭证和
集群保护，自动发现或公开配置不在本变更范围。可信 Hosted 启动配置和原生文件
dispatch 的具体装配由下一项依赖实现处理，不将 context receipt 当作授权。
