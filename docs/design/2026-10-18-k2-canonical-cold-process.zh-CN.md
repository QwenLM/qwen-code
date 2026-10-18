# K2 当前规范版本冷进程验收

[English](2026-10-18-k2-canonical-cold-process.md) | [简体中文](2026-10-18-k2-canonical-cold-process.zh-CN.md)

## 状态与问题

本文记录当前规范 schema 的有界本地验收及其计划，不增加恢复权限。在合入主干 `46bf492d05f4520bfd918c62e104d45f433da493` 的版本 `6717ce88820dc99982b14350ae777669a42b2907`，生产代码已允许后继跳过一个过期但未安装 activation 的 writer claim。现有 C6 进程结果早于当前规范 schema 和模块组合。当前 RC/RR 竞争结果把 producer 停在回调内，不能证明操作系统进程死亡后的恢复。

全新通过的 C6 场景使用当前规范 schema：最后一个工具 receipt 提交后杀死原 text Main 和 Hosted 进程，第二对进程提交 writer claim 但响应尚未交付时再次杀死，再由第三对进程恢复原 prompt。场景复现了下述 usage 元数据缺陷；本增量包含修正及重新运行的进程验证。

版本 `594032afdc42e0c5a3f130c05208187c0232a5ab` 上的第二次全新进程实测已运行到真实的第一次模型输出，并在工具执行前复现了这一类缺陷：当前 Hosted 在 usage snapshot 中加入 `contextWindowSize`，当时 native 校验把 snapshot 限定为五个 token 计数，因此拒绝了合法的新字段。本次修正接受可选的正 safe-integer context-window 元数据，包括 JavaScript safe-integer 的完整上界，同时保留旧五计数字段形状，并拒绝非法值或无关字段。它保留原 usage 字节与 digest 绑定，不改变 ownership、activation、lease 或恢复权限。合并后的验证现已覆盖全部 28 项定向 proof 测试、未过滤的同工作树 SDK/Server 检查及全新的完整 C6 进程链。原始失败进程产物继续保留为失败。

## 组合与边界

| 组件             | 执行方式与存活范围                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库           | 独占的一次性 MySQL 8.4 实例和 schema，通过当前迁移初始化；保留全部 35 张表的类型化原像。                                                                                                                               |
| 持久 fixture JVM | 当前生产 provisioner、加密 binding、Runtime Broker service/server 和 Session Store 操作；使用当前私有 Session CREATE fixture 生成原 Workspace 和 Session。这是测试组合，不是 `RuntimeMain serve` 入口或已部署 Server。 |
| File worker      | 独立进程使用构建后的生产 worker，持有真实文件、描述符和 inode；两次 owner 崩溃期间持续存活。                                                                                                                           |
| Text owner       | 三对独立的真实打包 `WorkspaceCsiRuntimeMain text` 与打包 Hosted CLI 进程，使用不同 home、boot ID，并登记进程身份。                                                                                                     |
| 故障观察器       | 外部透明 Store 代理捕获原请求和上游响应；只截留真实已提交响应，不生成 writer grant、journal 行或 native receipt。                                                                                                      |
| 模型             | 本地确定性 OpenAI SSE 服务：第一个响应请求有限的 Read/Write 批次，第二个响应产生最终文本。第三次请求视为错误。                                                                                                         |

Kubernetes API、placement 和 mount 来源仍是明确声明的本地 fixture。小型 fixture 副本在 Pod 创建前选择一个已存在、可达的本机非 loopback IPv4，使生产 placement 和 handle 生成始终保留同一地址。严格的一次性 worker listen facade 只把原 `43190/0.0.0.0` 监听改为所选地址，并立即恢复该方法。不变的 ready envelope 只作为启动信号；实际连接使用生产 placement 派生的 endpoint。不得修改 alias、route、hosts、firewall、生产 IP 校验或认证。

沿用的 Darwin 平台、mount 观察和 proc-FD 映射把实际文件操作委托给独占的真实文件。它们不能证明 native CSI mount、Kubernetes admission、内核约束、actor 闭包、物理退役或复用。Broker 到 worker 使用默认生产 HTTP transport，不重映射目的地址。生产 Hosted writer 和 activation lease 时长保持 60 秒；两者都以数据库时间自然到期，不更新 SQL、不注入时钟，也不执行 seal 或 release。

本地 API fixture 在独立 worker 真正开始监听前返回 Pending，随后让生产 provisioner 正常轮询并执行 attestation。原组件 fixture 在重映射 transport 内等待就绪；把它提前报告的 Ready 状态与无等待门的默认 transport 组合会引入启动竞态，因此不沿用。独立地址探测实测发现，此 macOS JDK 选择既有的 `127.0.0.1:7897` HTTP 代理；在服务已监听后，所选地址的 Java 与 Node 请求均实际命中服务。保留这条默认网络路径并明确其环境边界，不能从本场景推导直连 socket 路径或 native 集群网络。

## 场景与证据

1. 启动前冻结源码、构建产物、helper 输入与 Java/Node 依赖文件，记录真实路径和哈希，执行后再对照。加载了冻结依赖集合外的模块就不能通过验收；前后哈希本身不证明 native 不可变性。
2. 通过现有私有 producer 创建原 Session，预热真实 provisioner 并启动独立 worker。第一代真实 owner 运行原 prompt 和两个工具。最后一个成功 receipt 在 SQL 提交后、交付前被截留。确认两个 execution 都已 settled、receipt 完整，修复 message/resolve 尚不存在；向登记的两个 owner 进程发送 SIGKILL 并确认退出。
3. 保留 worker、数据库和文件。观察数据库时间，直到原 writer 与 activation lease 都自然到期。将全部数据库和文件原像与崩溃后原像对比。
4. 启动第二对真实进程。其 writer-acquire 200 已提交、但尚未交付和安装 activation 时截留响应。确认 generation 2、activation epoch 仍为 1、writer credential hash 不变；只有 head 的 writer ID、generation、lease 和修改时间可以变化。杀死该进程对、确认退出，再次等待自然到期，不写入数据。
5. 使用完全相同的原 prompt ID 和文本启动第三对进程。必须取得 generation 3、安装 activation epoch 2、修复原工具 message 与 resolve、实际发起第二次模型请求、消费并结算原 turn，最终可接收下一回合。不得出现 generation-2 journal、重复 native execution 或第三次模型调用。
6. 捕获原 HTTP envelope、数据库时钟样本、进程身份和死亡回读、完整类型化数据库原像、文件字节/inode、模型请求、journal/resource 字节和最终 Main 输出。Resource 验证时间变化必须对应捕获到的同 scope 成功 resource GET；保留其余所有单元格，并明确核实新增的读 receipt。
7. 只停止独占进程，删除独占数据库和 worker 临时目录，回读确认监听关闭、进程退出以及数据库/存储已移除。保留证据与失败尝试。

## 文件与验证

可复用行为契约仍位于 [K2 主设计](2026-10-09-k2-native-history-integration.zh-CN.md)。本文的中英文配对文档描述本次当前版本的有限验收。一次性可运行 helper 和详细 E2E 计划放在被忽略的 `.qwen/` 下；成功结果可以同步更新两种语言的主设计。不要为这一个场景引入受版本控制的通用验收框架。

独立 test engineer 先记录全局安装 CLI 的基线，以及本地地址 bind/self-connect 检查。已发布 CLI 不一定含有该私有 CSI 接口；记录这一限制，并为场景使用声明过的当前构建 fallback。随后由 test engineer 执行并审计冻结的当前版本进程场景。已有且未改变的完整 Java/TypeScript 结果保留其精确版本范围；仅文档新增需要格式与引用检查。若修改生产代码，必须运行受影响的复现、模块检查，并重新运行进程场景。

## 当前规范版本的实测结果

2026-10-19，全新自有 scope `canonical-c6-ef44po6w`在父提交 `6717ce88820dc99982b14350ae777669a42b2907` 加已记录的五文件源码补丁（SHA-256 `bc2a53e3debd17ed258e3eb333a41f0c69d8d659e6ed11cf698239da4480b035`）上，完成了真实进程场景。生产修正接受原始 `contextWindowSize`，不改写 usage 字节。原始与未安装 activation 的 claimant 两组 Main/Hosted 均实际因 SIGKILL 退出。数据库时钟采样观察到两次未经修改的 60 秒 lease 自然过期。中间 claim 恰好只改约定的四个 head 字段，已安装 epoch 仍为 1，没有 generation-2 journal。后继取得 generation 3、安装 epoch 2、修复原始结果，实际发起第二次模型请求，并完成一次 consume/settle 链，在 revision 28/sequence 30 返回 `before_model`。原始两项 execution 与工作文件、备份完全保持，没有第三次模型请求。

独立原始镜像审计核对全部 35 张表以及每个新增行的真实 producer。30 张表完全不变；仅 head、journal、resource/reference 和 resource-read receipt 表发生已核准变化。捕获的 33 个成功 resource GET 均关联 33 个 RETURNED receipt，原 scope/token 和实际数据库时间范围一致；没有未结束的 read lease。生产契约要求嵌入的 `ended_at <= gmt_modified`，不要求它等于另一次单独采样的数据库时间。切点前已存在且整行不变的资源，不需要后续 GET 来解释其原始验证时间。

前后检查覆盖 128,634 个文件和 187 个 symlink，未发现漂移。coordinator、worker 与三代 Hosted 实际加载的文件全部位于该固定闭包内。七份 helper 源码与归档的启动前字节一致。独立清理回读确认 13 个登记进程缺席、9 个端点关闭、12 个运行路径删除，没有自有 orphan；自有数据库和用户已删除，MySQL 正常关闭且 data/socket 移除。仅 coordinator 的 PASS 不能赋予资格。

先前的 readiness、上下文窗口、隐式 classpath 根目录、非法 prompt UUID 及 stdout framing 尝试均单独保留。一轮较早的进程链已完成业务结果，但观察器把包含两条诊断日志的整个 stdout 当作 JSON 解析；该 runner 继续记失败。全新通过的运行使用严格 framing：保留这两种已知诊断，只允许一个 session/prompt 匹配的 completed `turn_result`，未知输出或额外 JSON 均拒绝；不会将较早的失败运行改记为通过。

## 验收与剩余工作

通过要求包括两个截点的真实进程死亡、真实已提交且未安装 activation 的 generation-2 claim、lease 自然到期、generation-3/epoch-2 恢复、原批次/result 身份完全一致、恰好两次模型请求、原 turn 已结算，以及清理回读通过。停住的 promise、合成 generation、手工追加 journal、回放模型输出或缩短 lease 都不满足此计划。

原子完整输出提交后的独立全新 C8 结果已记录于[规范完整输出验收](2026-10-18-k2-canonical-complete-output.zh-CN.md)。完整 native actor 约束、云端安装、物理清理和复用仍未完成，不能从本地测试推导。如果现有本机地址都不能 bind 并自连接，应记录默认 transport 基线不可用；重映射 transport 的实验范围更窄，不能替代该基线。本增量没有其他未决设计问题。
