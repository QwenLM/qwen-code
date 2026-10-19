# 私有 CSI 节点证据与受控创建

[English](2026-10-20-private-csi-node-evidence.md) | [简体中文](2026-10-20-private-csi-node-evidence.zh-CN.md)

## 状态与问题

这是累计 Draft #13526 的第三个功能切片，从
`af312254483a350d5655a40c84591c9e5512aaa9` 提取到 main
`06efd789b`。完整私有冷恢复已通过 #14695 合入；原始 owner 的应用退役也已通过
#14698 合入。本切片不继承累计分支的测试结果或原生部署资格。

私有文件 Runtime 已能构造并恢复执行 owner，但这不能证明原节点、runtime、
容器创建、publication 和保留来源观察属于同一条连续链路。本切片补齐该证据边界，
不增加物理释放协调器，也不开放公开 CSI 入口。

## 范围与组件

| 层次                 | 包含行为                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Go source 与 gateway | 认证且有界的原 task 观察、持久 hash 链 journal、描述符 custody 和 CSI frontend 证据                       |
| 受控创建             | 专用 shim、sandbox/container 配对的首次执行前出生记录、保留的 OCI 输入身份以及有效 CRI/NRI/service 检查   |
| 安装协议             | source 所需的严格 installed-byte 与 cold-bootstrap 数据 reader，不授予安装权限                            |
| Java transport       | 精确解码 Go journal、独立 durable head 验证、creation contract 与 installed-byte 校验、认证 source client |
| Java 持久化          | 原 binding/reservation 关联及单调的 ARMED、BOUND、PUBLISHED 证据                                          |
| 私有 provisioner     | 显式 serve-evidence operator、已审阅 node/runtime 检查、scheduling gate 与精确原 Pod 身份                 |

source journal 保留 stop 和 unpublish 事件语法，因为这些记录延伸同一条原始证据链。
本 PR 不增加 coordinator、持久物理计划、Pod 删除操作或物理进度数据库。

## 创建与所有权

显式私有 operator 读取独立审阅的 node、image、birth 和 installed-artifact 输入，
在 ARM 前验证精确 Node UID、boot ID、Ready 状态和专用 RuntimeClass。
认证 source 保存 ARM prefix，SQL 在任何 Pod CREATE 前保存它。
Pod 使用 scheduling gate、只允许该节点的 required affinity、专用 worker account、
固定 AppArmor profile 和显式 tolerations。

CREATE 后，gateway 登记精确原 Pod UID。source BIND 要求 target 不存在且 task
尚未创建。SQL 在 JSON patch 打开 gate 前保存 BOUND prefix；patch 依次 test
原 UID、resourceVersion 和完整 gated spec，再移除唯一 gate。
publication 要求原 container/image、配对 births、custody 与 CSI publication
匹配，在接受 resource handle 前将延伸的 prefix 保存为 PUBLISHED。

source 与 gateway HTTP route 属于 node-source scope；provisioner 操作属于原
binding/reservation scope。请求不回退选择其他 Workspace 或 primary runtime。
未知身份、替换的进程/描述符、改变的输入、不完整 journal 和不确定持久化都拒绝推进。

## 拆分决策

保留 installed-artifact 格式与必需的 cold-bootstrap 图。即使 artifact 生成、
policy 编译、打包、initrd 和实际 PID1 交接留给下一切片，reader 仍是共享协议前置条件。
测试必须明确标注合成的 compilation、service、runtime 和 mount 数据。

使用 source 专用的 closed JSON 解析，在本地保留既有十秒整事务 SQL deadline。
两项工具均不依赖应用退役类。保持在同一个 Connection 上依次获取共同 binding-control、
原 binding、storage alias 和 holder 锁。

追加仅包含 ma_csi_source 及其 physical-key index 的 V13，保留已发布 V1–V12 原字节。
schema-version 识别分别验证旧表集合与新表集合，不 repair 或接纳 foreign catalog。
V12 保持为 #14698 的应用退役迁移。

保留已发布的 32 表 application-inventory/2 编码，包括已保存的 frozen baseline
与 retained history。原 binding 及物理卷没有 node-source 关联时，既有链路继续工作。
任何相关 source 行都在封存 binding 前拒绝退役、阻断实时库存，并拒绝原 owner
或 foreign owner 的历史读取。实时检查使用持锁的同一 Connection；历史检查使用
只读 repeatable-read 快照。新证据链路的退役需要后续显式组合；本切片不能静默
遗漏证据，也不能改变旧编码。

普通 serve、Spring 配置、公开 selector、worker boot/handle 版本和既有恢复行为
保持原协议。

## 文件与边界

实现位于 packages/k2-node-evidence、Java transport source 协议、source
持久化/operator 类、既有 CSI provisioner 与 Kubernetes client，以及 canonical
managed-schema 初始化/验证。测试覆盖 canonical Go 编码 journal fixture、Java
source/store、provisioner 与 schema migration 控制。

不包含：应用 freeze/cut/finalization、物理退役协调、Pod 删除、RELEASED、释放后历史、
卷复用、部署 policy 生成/编译、artifact 打包、原生冷启动与公开 CSI 选择。
不需要新的 TypeScript consumer 或公开 API。

## 验证与验收

先记录全局 qwen 基线。私有 Java operator 不是公开 CLI 命令，因此实际协议需要
test-script/组件 fallback。验证提取后的候选，不沿用历史分支结果：

- 构建并 typecheck 仓库，为既有 JavaScript interoperability 准备产物。
- 运行 focused Java source client/journal、creation contract、installed bytes、
  source 持久化、node/runtime 检查、Kubernetes patch 与 schema 测试。
- 完整执行 Java module verify，包括 Checkstyle 与 SpotBugs。
- 对临时 MySQL 8.4 验证 source association 与迁移；H2 不足以证明事务/catalog 行为。
- 运行 portable Go 测试、module verify，以及 amd64/arm64 Linux command 构建。
  原生 Linux Go 测试与交叉编译分别报告。
- 验证 store 重启后原 prefix 字节不变、拒绝不改变状态、保存 BOUND 早于打开 gate、
  普通创建保持兼容。对改变的 identity、journal、installed graph、source incarnation
  和有效 runtime/service 状态保留严格负例。
- 验证相关 source 行在改变 READY owner 或 reserved holder 前拒绝退役，普通应用
  库存保留精确原编码；在合入后的基线上执行旧应用退役链路。

软件验收不证明原生描述符 mediation、kernel confinement、实际 ACK 安装、连续
actor/CSI 排他、物理释放或复用。不可用的门禁与 skip 必须明确记录。

## 风险与后续

source、shim 与专用 daemon 属于可信实现。artifact hash 认证字节，不能证明
已审阅可运行的 host policy 或 containment。原生资格、已审阅 compiler/host 输入和
实际 cold-boot 执行仍待完成。证据链路的应用退役明确不可用；恢复 owner 退役和最终
原子物理释放仍是独立工作。新的跨语言协议与私有 provisioning 路径需要维护者架构评审。
