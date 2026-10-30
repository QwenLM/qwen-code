# 私有 CSI 文件 worker、保留历史与本地进程隔离

[English](2026-10-11-csi-file-worker-block.md) | [简体中文](2026-10-11-csi-file-worker-block.zh-CN.md)

## 目的和基线

本改动从 PR #13526 的 `edef0d54c246eeb554727564e50b3dab200a5cf5` 拆出
worker 侧特性，基于主干 `fce50611b665989494df5fbd8bc91b4cad7b723c`。
主干已有 CSI mount 身份、保留读取 source 和普通 managed worker，但没有
私有文件 worker。本 PR 提供从已有 container boot 入口到描述符
Read/Write/Edit 和保留文件历史的完整 worker 侧调用链，并纳入原 PR #13893
的 Java 本地进程拒绝边界，以 Draft 提交架构评审。

Java 与 Node 使用完全相同的私有能力 manifest 和摘要。Java 嵌入式 API
可以构造预留的 Session 隔离请求，但本地进程 provisioner 在解析存储、产生
进程效果或持久注册之前拒绝。主干没有选择该能力的普通生产调用者。这属于
前置特性工作，不是修复主干已有 CSI 生产路径。将边界和专用 worker 合并
并不会新增 native authority producer。

Java native SQL issuer 和 Hosted Session 编排仍是独立特性。本 worker
要求它们提供远程 authority 契约；主干普通生产 Session 路径尚不能产生该
authority。合成 authority 响应可以验证组件契约，但不证明 SQL 准入、完整
Hosted turn 或 Kubernetes 部署。

## 包含的调用链

已有 managed runtime CLI 读取 container boot 文档，将版本 4、5 分派给
专用文件 worker。旧 stdin/context worker 拒绝精确私有能力。版本 4 仅提供
构造、attestation 和 context 安装；版本 5 还固定 authority origin，在其
提供有效证据时支持文件执行。

| 层                        | 职责                                                                      | 消费者                                             |
| ------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Java profile 和本地拒绝   | 规范 Session 请求身份；在所有本地进程生命周期效果前拒绝                   | 嵌入式 Broker 请求、持久 reconciliation 和运维观察 |
| File boot 和 wire 契约    | 封闭 JSON、精确身份、lease、incarnation、Pod/storage/mount attestation    | Container worker 启动和私有 HTTP 路由              |
| Native readback 客户端    | 认证当前 bind/prepare/execute 证据，封闭 grant/resource 校验              | 文件历史绑定、准备和 native tool 执行              |
| Composer 和描述符 backend | 单一原始 Session、验证 root、no-follow 遍历、原始观察和写入、保留备份认证 | 实际 Core Read/Write/Edit 工具                     |
| 保留历史                  | Snapshot/preimage 准备和认证备份观察，无通用 rewind 或删除                | 同一 composer 和 executor history 实例             |
| Core mutation 契约        | 可选 scoped 观察和修改，不回退到环境中的 pathname                         | 提供给实际工具 Config 的描述符 backend             |

绑定在构造工具前认证当前安装的 context 和 authority。准备在保留 preimage
前验证完整接受成员及原始输入。执行认证精确 grant、安装 Session 和准备历史，
随后使用同一组工具和 history。Backend 始终使用原始 root 和保留描述符。
重试保留身份，不替换成无关的 history 实例。

## 决策和约束

能力 manifest 和协议 fixture 保留 PR #13526 的字节。新的 scoped mutation
及 retained storage 参数在 composer 中有实际生产 setter，在工具、history
和 executor 中有实际 read site。普通 worker 不选择该 backend，保留已有行为。

私有 team-memory secret 检查以 composer 提供的已验证 Session 工作目录为根，
具体保护其 `.qwen/team-memory` 子树。即使工作目录位于仓库根目录之下，也不向上
查找 Git 根目录。普通工具保留最近 Git 根目录和 realpath 的分类规则。这是有意的
差异：私有工具不能发现准入描述符根目录之外的宿主仓库；backend 拒绝根目录之外
的路径及 symlink 遍历。

文件历史保持原始 Session 和目录。同一 Session 重新安装不同的 context digest
会冲突，mount 身份变化会拒绝准入。绑定、准备和 snapshot 已要求当前工具目录与
history 一致；执行在文件效果前重复同一检查。改变 cwd 必须为新 Session 安装
context，不能复用其他目录的历史。

Boot 5 在记录前验证 native installation 契约：operation id 由原始 Session
派生，context revision 为 1。非规范重装键和不支持的首次 revision 会被拒绝，
不替换已有记录；规范身份的精确重放保留原绑定。Composition 或 preimage 准备
之前的 authority 失败可以重试。Preparation 失败后，若验证 history 和 retained
storage 完全未变也可重试；效果变化或无法验证时会封闭执行，
返回 `managed_csi_history_retirement_required`，已排队的 snapshot 也适用。
保留 pins，不静默重新复制同一 preparation。

Preparation 在 retained 观测和失败检查结束前排除执行。若已有 executor invocation
进行中，准备在 authority readback 或 preimage 效果之前拒绝；准备进行时，新执行
及之前已开始 native readback 的执行均在 executor 准入前拒绝。此类时序拒绝保留
可用 Session，当前操作结束后可以重试；不会退役 history，也不无限等待后端空闲。
Snapshot 保留已有的后端空闲要求。

History 准备在复制前投影下一 snapshot、文件记录和 retained pins 的最大形状，
为 authority envelope 预留 1 KiB，执行 100 个 snapshot 及 64 KiB 历史回包预算。
保守容量拒绝返回 `managed_csi_history_capacity_exceeded`，保留之前的 snapshot
和可用 Session；它可能比精确考虑备份复用的预算更早拒绝。Settled 执行回包
允许 executor 已有的 1 MiB 结果预算及有界 16 KiB 请求 envelope，避免仅因
UTF-8 字节数超过 64 KiB 而拒绝 Read 结果。

Write 和 Edit 在 signal 已取消时重抛外层 mutation wrapper 捕获的错误，保留
Core 工具 API 的取消传播。未取消的 wrapper 错误仍返回带类型的工具失败。这不改变
scheduler 已有的取消分类或工具的内层 catch。
Write 仅在 scoped `textFileIo` 路径使用该外层 catch；普通路径直接委托已有逻辑，
保留写入前的抛错行为，例如父路径是普通文件时，无论是否取消均拒绝。

Scoped writer 保留写入前的精确字节，在部分写入失败时恢复原文件，同时保持
原 inode 和 mode；新文件写入失败会删除自己创建的 leaf。Rollback 验证原始
描述符和命名项身份、备份 alias fence，且不再使用已取消的 signal。仅在成功
恢复且错误正是 signal 的取消 reason 时恢复可用性；存储故障
（包括 ENOSPC）和 rollback 失败即使恢复了原字节也仍关闭 backend。Worker 报告
execution unavailable，并要求退役，不把字节恢复当作存储恢复。不存在的文件及
首次输入的非文件路径形状只拒绝该请求；mount、
inode、device、备份 pin 或 inventory 变化仍是致命失败。这是观测到写入错误后的
恢复，不是 crash 原子性或持续设备故障恢复的资格证明。Retained readiness 对
跨 snapshot 的 working path 去重，同时保留每个 failed backup 和当前存储验证。
完整 inventory 检查仍保留，不声称 pin 增长时整体成本为线性。

Scoped backend 新建工作文件和目录分别请求 `0600` 和 `0700` 权限，process umask
可以进一步收紧。在 umask `022` 下，这与普通 Write 默认的 `0644` 和 `0755` 不同。
已有文件更新保留原始 mode；与其他 UID 共享卷的调用方须考虑这些新建权限。

Java 请求沿用 Broker 编码，保留规范 Session UUID 隔离、Workspace generation
和存储身份、根相对工作目录及规范绝对 mount root。拒绝根据精确能力摘要，
不依赖 provisioner kind 或隔离类型，覆盖请求创建、两个 provision 重载、
资源创建/接管、reconciliation、confirmation、运维注册/停止观察及 release。
Session 和 Workspace 两类隔离均返回不可重试的 HTTP 409
`runtime_provision_failed`；异步操作返回失败的 completion stage。其他格式
合法的未知摘要保留主干行为。拒绝不授予 native 执行、退役或释放权限。

拆分还补齐依赖评审中发现的三处 worker 侧缺口。Retained executor 使用词法
containment，并让原始描述符 backend 负责 no-follow 准入，不再观察环境中的
realpath。准备阶段在保留 preimage 前核对声明的 request digest 与原始 payload
字节。Execute readback 要求封闭 input wrapper 的 harness 和 runtime Session
均属于同一所有者，并验证 payload digest，包括没有 preparation 的只读调用。

保留主干特殊文件准入、零长度处理及 `O_NOCTTY` 读取、当前 mount root 生命周期
检查、兄弟所有权 fence 和 worker 聚合清理。仅从旧 source 文件抽取新 worker
dispatch 和文件契约，不用 PR #13526 的版本覆盖主干。

路由由不可变 boot 指定的单一存活 worker Session 所有，使用精确
lease/token/incarnation 和安装 context。Native readback 由另行配置的
authority origin 和当前持久 Session 所有；worker 不能自行生成 SQL 授权。
缺失、格式错误、冲突、过期或不可用证据在文件效果前拒绝。不回退到普通 worker、
其他 Session 或替换 mount。

Backend 失败关闭准入。清理等待在途操作并保留错误。保留 snapshot 不授予
rewind、备份删除、退役或复用权限。Drain 仍是拒绝边界，报告
`DRAINING`/`BLOCKED`；此增量不证明 `QUIESCENT`、物理终止、CSI unpublish
或卷释放。

## 文件和排除范围

生产范围是 `packages/cli/src/serve` 下新增的 `managed-csi-file-*` 和
`managed-csi-native-readback` 模块、container 入口及 context/executor/history
接线，以及 Core 文件 mutation、保留 history 和 workspace memory guard
消费者，以及 Java profile 身份和本地进程 provisioner 拒绝。各层包含测试
和共享 wire fixture。

不包含 Java SQL issuer、migration、Hosted runner、Session activation/recovery、
原始 checkpoint proof、application finalize、物理释放或公开 profile 选择。
PR #13893 已纳入此组件并由其替代。Publication 锁顺序 PR #13894 仍独立，
因为它修复普通 SQL publication 路径，不依赖此 worker。

## 验证和验收

先执行全局 CLI baseline，确认当前主干或安装 worker 不能选择新 boot 契约。
无法进入 CSI 执行是特性缺失基线，不是已有生产 bug。

通过 Java 嵌入式 API 注入预定摘要，确认在 resolver 调用、子进程 marker、
持久目录变更或运维效果前拒绝。覆盖两类隔离及所有生命周期入口，包括合成
handle 和注册；这些 fixture 不证明存在历史私有注册。检查规范 profile
身份及 Java/Node 摘要一致性。使用同一份新构建的候选 Node bundle，确认
已有普通和持久 Java worker 可用，覆盖 context 安装、attestation、confirmation
及重新打开 Broker 后的接管。

在候选验证 boot 4/5 解析、实际 container 入口分派、旧路径拒绝、context 和
attestation 授权及封闭路由处理。执行契约使用真实 HTTP authority fixture
以及实际 worker、composer、executor、Core 工具和 retained storage，观察完整
bind/prepare/Read/Write/Edit/history-snapshot 序列、原始 preimage 和结果字节。
篡改身份、grant、resource，错误所有权、不可用 authority 和封闭准入应无新文件效果。

还需验证非法 context 安装不替换已接受身份，文件效果前的 authority 失败可重试，
效果后的准备失败让已排队 snapshot 返回明确退役码，容量拒绝发生在复制之前。
将准备分别与新执行、进行中的 native readback、已有 executor invocation 重叠：
时序拒绝须发生在文件效果之前，之后相同请求和后续 snapshot 应成功，Session 不退役。
取消或部分写入失败后比较完整原字节、inode 和 mode，真实完整性失败仍须关闭准入。
通过真实 HTTP worker 验证超过 64 KiB 的中文 Read 结果及精确重试。

Fixture 传输证据与真实 SQL issuer 证据分开记录。非 Linux 主机上的任何 Linux
mount 或描述符映射都必须明确标注；未修改的生产启动仍应拒绝不支持的 mount。
这类探针不证明 Linux CSI 或目标集群生命周期行为。

此 Draft 验收要求根目录 build/typecheck/bundle、Core 和 CLI 定向回归测试、
范围内格式和 lint、独立 test-engineer 报告及两次干净的完整 diff 自审，
同时要求定向 Java 测试、Checkstyle、SpotBugs 和打包。
评审需一起判断跨包契约和必要远程 authority。部署和完整 native 验收是后续 gate。

## 风险和后续

这是涉及 Core、CLI 和 Java 的较大 feature，触发仓库生产行数 advisory，需要
maintainer 架构评审。主干尚无 worker authority producer；普通私有 Session
使用该组件前必须另行接入。

后续 PR 应提供持久 Session/native SQL authority、Hosted 执行/receipt/consumption
调用链、冷恢复和完整退役资格。开放设计问题是 worker 侧模块及严格远程契约是否
应先合入，还是与 producer 一起交付。
