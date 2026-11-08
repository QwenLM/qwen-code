# W1b：离线 Workspace 恢复 Bundle

[English](2026-10-01-managed-workspace-w1b-bundle.md) | [简体中文](2026-10-01-managed-workspace-w1b-bundle.zh-CN.md)

状态：已实现，本地验证通过，部署验收待完成。已整合 main `d5c22d33`，包含已合并的
文件历史依赖 [#13110](https://github.com/QwenLM/qwen-code/pull/13110) `e083d6a6b`。
保留其最终的准备失败回滚修复及恢复测试。
属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)。完成
[W1 恢复设计](2026-09-29-managed-workspace-w1-recovery.zh-CN.md) 的 W1b 切片，
不实现 W1c 挂载提升。

## 1. 问题与范围

W1a 校验仍存活的存储身份和私有 Session 历史，但不证明备份包含同一恢复点的
完整共享 Workspace、Worker 文件历史备份、权威 journal 和私有资源。公开
transcript、目录名称、已释放的 holder 或对象名列表均不足以提供这些证据。

实现可信单机 Linux 部署的私有离线维护流程，覆盖同一 tenant/storage 的全部
绑定 Session，包括保留的归档、关闭和删除记录；Hosted files 与 Shell profile；
O2 已接受结果；以及 #13110 使用的实际备份字节。不支持的 profile 或无法解释的
引用阻止整个 storage 获得兼容恢复点。无绑定 Session 保持原有行为。
普通 Hosted 模型轮次包含其原始 `managed-hosted-model-route` 和
`managed-hosted-model-usage` 资源。Hosted Hooks 和 MCP Session 仍不支持，
会阻止所在共享 storage 的整体捕获。

首个 provider 为 `local-workspace-bundle/1`。运维在全部活动根之外准备 Workspace
和保留的 Worker 备份目录副本。维护流程对比已停写的源数据，导出私有权威资源，
并封存版本化清单。SQL 持久回执中的清单摘要是信任起点；chmod 和 bundle
自报 hash 均不证明内容不可变，后续每次读取都校验已固定的字节。

W1b 不覆盖活动文件，不获取 Session writer，不重放副作用，不改写历史或
ContextBinding，不创建 Runtime，不解除 fence。SQL/VM 回滚、恶意同 UID writer、
在线快照、跨主机 placement、主机镜像及 W1c 激活均不属于本次验收。

## 2. 维护边界与固定恢复点

捕获前，运维关闭 Session 创建、输入准入和后台派发；结算或取消全部已接受工作；
停止 Harness、Session Store writer、Worker 和外部文件 writer，并防止重启；
释放或等待 writer 租约过期。精确的 storage holder 清空后才能建立 W1a fence，
并在捕获期间保持进程停止。维护入口要求显式离线确认并检查可观测条件。fence
或租约过期本身不证明进程停止：当前创建与纯模型 journal 路径不会读取该 fence。

恢复操作 UUID 与 fence 操作 UUID 分开。请求固定 fence 操作及预期 mount revision。
同一恢复 UUID 携带不同请求字节时冲突。已完成请求重放原回执；检查当前兼容性
必须使用新的验证操作。

按原 `workspace_storage_id` 和稳定 Session ID 分页枚举，不使用公开列表的 ACL、
状态或 updated-at 过滤。保存每个原创建回执与请求摘要、精确七字段 ContextBinding、
冻结配置引用、公共 Session version/事件水位/已接受工作状态，以及真实私有
Session Store key。其 workspace ID 不能替换为产品 Workspace ID。固定私有
writer 身份和状态、journal revision、committed sequence、last commit digest、
activation epoch、checkpoint、compaction 和 recovery 状态。缺失 head 记为未初始化，
不能创建历史。已有 head 但尚无已提交 genesis 时拒绝捕获。活动工作、未完成生命周期操作、存活 writer 租约、不支持的
compaction 和 blocked recovery 拒绝捕获。

主干永久删除会清空私有 checkpoint 指针，但保留 journal 和资源字节。固定原始
退役 owner、operation、generation、数据库时间和恢复保护，要求匹配的已确认、
已完成 DELETE 及公共删除墓碑。只有这些证据允许 DELETED head 没有 writer 或
checkpoint 指针；仍校验全部原始 journal 水位、checkpoint 和资源，并要求工作
已结算。没有退役证据的历史删除记录仍严格核对指针。退役变化使固定恢复点失效。
这不恢复 Session 或重开 writer；公共 Workspace-bound DELETE 准入仍不可用。

每次提交派生记录前复查 Session；封存或记录兼容性前复查完整成员集合与来源摘要。
新 Session、纯模型提交、绑定变化、writer 续租及新增已接受工作使旧恢复点失效。
任何重试均不能静默推进水位。

私有 head 的租约指纹将数据库 DATETIME(6) 墙上时间保存为 ISO 本地日期时间
字符串，保留小数秒，不依赖维护进程时区转换成 epoch。真实租约到期仍在同一
连接中与数据库时间比较。早期未发布版本的 epoch 毫秒指纹不自动改写：旧封存
内容仍可校验，但当前权威比较不能认证采用旧指纹的 head。全部维护二进制升级
后应启动新的捕获。

## 3. 持久流程与私有入口

三类加法表保存恢复操作、固定 Session 来源及 asset/reference 工作。它们只保存
派生元数据，原创建回执、journal、resource 和 resource-ref 行不修改。使用下一个
未占用 Flyway 迁移号，不修复旧迁移历史。

操作阶段为 `CAPTURING`、`SEALED`、`VERIFYING`、`VERIFIED` 和 `INVALIDATED`。
I/O 中断保留阶段和进度，来源漂移使操作失效。运维调查后在仍持有的 fence 下
使用新恢复 UUID；任何操作不能接管其他 fence。
完成提交只更新预期的可写阶段，陈旧的完成请求不能覆盖另一个进程已提交的失效。

此前未固定的不支持源条目以 `unsupported_source_entry` 拒绝捕获并使该恢复 UUID
失效，仅在运维 stderr 输出类型和相对源根父目录的路径。路径按 JSON 转义，特殊
文件名不能伪造诊断行。修正离线源并准备新的匹配副本后，使用新的恢复 UUID。
已固定条目的不支持替换及最终目录树变化仍为 `source_drift`；已观察到的源路径丢失
仍使操作失效，不可读取仍为读取失败。候选副本中的不支持条目保留副本校验错误。

Java 私有 main 支持 `capture`、`verify`、`inspect`，读取运维拥有的 JSON 请求，
写操作要求 `--offline-confirmed`。请求包含 tenant/storage、恢复 UUID、fence UUID、
预期 mount revision、规范 source/bundle 根、原 Worker file-history 根、Node
可执行文件和匹配的已打包 CLI 入口。验证另指定已封存捕获操作。JDBC 凭证和
可选 O2 对象存储凭证只通过环境传入，不新增 HTTP 维护路由。

Java 负责 JDBC、作用域校验、来源快照、分页、冲突检查和条件完成。匹配的 CLI
子进程执行只读 TypeScript 文件系统/协议校验，通过管道逐个交换带关联 ID 的
JSON 请求和响应，record/object 大小沿用已有协议限制。子进程失败或异常响应
不能封存操作；不创建公开 writer token 或生产 Harness。

npm wrapper 在导入普通 CLI 模块图前分派私有 Worker；打包可执行文件直接进入
CLI bootstrap，因此保留自己的分派。私有 flag 用于 Java 的 stdio 子进程，不属于
公开 help 命令。Wrapper 导入或启动失败会输出诊断并非零退出，不依赖 Node 的
未处理 rejection 策略。

单线程 Java 私有进程拥有一条物理 JDBC 连接，并在完成、检查、回执重放及失败时
关闭。既有事务仍分别提交或回滚，逐记录的 fence、来源和所有权检查保留；不引入
连接池，不改变在线服务行为。

按文件系统条目数和字节数一起估算离线窗口。
[独立 Linux 报告](https://github.com/QwenLM/qwen-code/pull/13138#issuecomment-5933639978)
在 4 vCPU/8 GiB VM 上测得复用连接前，20,916 条目、77 Session 的捕获耗时
829 秒、验证 765 秒。其单独测试的单连接候选将 20,500 条目的捕获从 806 秒降至
221 秒，验证从 378 秒降至 136 秒。这是评审者指定工作负载的测量，不是本修订的
延迟保证。守卫读取和派生元数据写入仍按条目产生开销。每次捕获和验证均保留自己的
操作、Session 和 asset 行，用于续办和回执审计；W1b 不自动清理这些记录。多次
操作需预留数据库空间；批量写入及垃圾回收需后续设计，保持维护和回执边界。

打包后的维护制品为 `qwen-managed-agent-server-0.1.0-alpha-workspace-bundle.jar`。
运行 `java -jar <artifact> capture <request.json> --offline-confirmed`、
`java -jar <artifact> verify <request.json> --offline-confirmed` 或
`java -jar <artifact> inspect <request.json>`。先通过正常升级部署 schema，维护
可执行文件不运行迁移、不启动 Broker。设置 `W1_JDBC_URL`、`W1_JDBC_USER` 和
`W1_JDBC_PASSWORD`。可选外部 O2 读取使用 `W1_OSS_ENDPOINT`、`W1_OSS_REGION`、
`W1_OSS_BUCKET` 及现有 OSS 环境凭证 provider。Node 子进程环境删除这些凭证，
不需要公共模型服务。

捕获请求包含 `version: 1`、`operationId`、`tenantId`、`storageId`、
`fenceOperationId`、`mountRevision`、`sourceRoot`、`bundleRoot`、`fileHistoryRoot`、
`nodeExecutable` 和 `cliEntry`。路径为绝对路径，根必须规范且彼此分离；
`cliEntry` 指向匹配的已打包 `dist/cli.js`。验证使用新的 `operationId`，增加
`captureOperationId`，保留原 scope、fence、revision 和 roots。Inspect 只需要版本、
operation/tenant/storage ID，可选 `afterSessionId`，每页 32 个固定 Session 来源，
返回 `nextSessionId`、队列/完成计数、登记、稳定 `lastErrorCode` 和原回执，
不获取 writer。原本不存在或 `not_captured` 历史无需不存在的未使用 Worker 备份
目录；有引用的备份缺失始终失败。

实现消费者是私有 Java main/store/reader，以及匹配的 CLI worker、本地 provider
和 Session 校验器。共享生产代码只增加纯 Session Store 解析器导出和类型化只读
W1a guard 查询，以及 npm 入口和打包 CLI bootstrap 的精确私有 flag 分派；分派先于
普通 CLI/model 或继承的更新启动。现有 HTTP Session 读写、Hosted Turn 路由和 Runtime Worker 派发
继续使用既有路径。V31 派生队列索引支持 asset key 分页及 Session/state 引用选择。

Session 分页和引用队列持久保存并限制批次大小，每次读取一个 journal 事务或
资源，复用协议解析和摘要链校验，不累积整个 Session log。文件按 1 MiB 块计算
摘要。临时文件独占创建、同步并原子发布后才提交派生进度。重试复用相同字节，
拒绝已有冲突字节。文件路径和不透明对象 key 不能直接成为未校验的输出路径。

## 4. Bundle 格式与完整闭包

运维准备的 bundle 包含 `workspace/` 和已保留的 `file-history/<Session ID>/`。
维护添加 `authority/objects/<SHA-256>` blob 与保留的 `.w1-recovery/` 目录，
后者包含 `manifest.json`、`sessions.ndjson` 和 `assets.ndjson`。索引为版本化、稳定顺序的流式 NDJSON。顶层记录 provider/version、
tenant/storage、登记、原 mount revision/fence/capture ID、固定来源摘要、索引
数量和摘要，以及显式不激活结论。SQL 保存最终清单摘要和原完成回执。

捕获将完整候选 Workspace 树与已停写的登记源逐项比较，记录规范相对名称、
类型、基本 POSIX mode、长度和内容摘要。支持普通文件和目录；相对符号链接必须
完整解析到自身根内，枚举不遍历符号链接目录。绝对、越界、循环或悬空链接、
多硬链接普通文件和特殊文件拒绝。不宣称 ACL/xattr 或完整主机镜像恢复。
候选多余或缺失条目拒绝，provider 元数据和私有 blob 同样检测未声明文件。
源根和候选根不得互为别名或重叠。
部分清单的续办即使尚无完整 tree marker，也必须复查已持久保存的原始条目。
原文件、Workspace 根或 Session 备份目录丢失会使旧捕获失效，不能接受替换字节。
已固定的 Workspace 根或备份根被替换为符号链接或非目录时同样失效；尚无捕获
证据的非法根仍直接拒绝。
首次正向或反向清单遍历期间已观察到的来源丢失同样使捕获失效。副本缺少条目
或包含未固定的额外条目时返回 `snapshot_source_mismatch`，允许修正副本后以同
一操作续办。完整清单建立前，尚未观察的来源路径没有对应副本，只能证明不一致，
不能证明路径何时创建。已持久保存的条目和完成后的树成员集合仍须复查漂移。

捕获初始化只清理三个精确元数据名称后附 `.partial-<当前操作 ID>` 的中断发布
文件，且必须是普通单链接文件。其他操作 ID、未知名称、链接和特殊条目仍由
严格枚举拒绝。验证操作不删除这些文件，也不覆盖字节冲突的最终文件。

私有导出保留精确 journal 事务字节及来源摘要。校验 genesis 身份、revision/sequence
连续性、commit marker 和最终固定 head。遍历 header 引用、类型化事件引用、
checkpoint 各组及历史 domain 前驱链，复用 record/checkpoint/message/file-history/
tool-result 解析器。检查 owner、kind、schema、长度和摘要；资源 ID 元数据冲突
和未知 domain 拒绝。持久队列与去重保持闭包内存有界，循环资源链不能无限运行。

Shell 校验原已接受 publication/receipt、所有权和 journal 位置、结果 manifest、
全部 page、content/segment 和 seal，包括完整输出长度/摘要及空流。导出精确 O2
对象字节，不替换 publication，不以对象存在代替校验。维护 reader 不续租
publication/writer token，不 quarantine 生产权威记录。不完整或未知结果不是
已结算恢复点。

要求初始或已完成 Turn 的结算点，不能只要求 checkpoint 可运行。等待批准、
Runtime 工作、模型 continuation、pending file history/undo 和未解决的已接受输入
拒绝兼容捕获。校验读侧消息，但不改写消息内容和 cwd 字符串。

## 5. 文件历史证据

使用 #13110 保存的历史记录及 owner/path 校验器，遍历全部保留记录及其前驱，
不只取最新快照。通过显式提供的原 Worker history 卷，在拥有者 Harness Session ID
下定位备份，并与运维复制卷的字节比较。引用备份缺失/损坏、失败捕获记录、
所有权冲突或 pending history/undo 拒绝，不能使用当前 Workspace 内容替代。

Hosted 记录复用运行时 reader 的纯记录解析器，包括 schema、pending message/turn
一致性及 #13144 的完整 undo 回执协议。校验回执精确字段、UUID、保留 prompt、
唯一 request 和已跟踪的变更路径；conflict 回执不能宣称文件已改变。旧版没有回执的
记录仍有效。全部保留记录都接受这些检查，不获取 writer，不修改原资源。

记录中的 null backup filename 表示原本不存在；缺失非 null 备份属于损坏。
没有 history domain 时记为 `not_captured`，不制造 undo 可用性。已有历史备份
元数据没有原始内容摘要：W1b 在本次捕获时建立保留字节摘要，只保证从该点开始
的一致性，不证明捕获前的 preimage 从未损坏。保留原历史和 undo 冲突语义。

## 6. 结论、兼容性与上线

分开保存 `contentVerified`、`authorityCompatible` 和 `activation`。
`VERIFIED` 标识已核验 bundle，`activation` 始终为 false。兼容性要求完整当前
storage 成员、绑定、已接受状态和 journal 水位精确匹配，并具有有效匹配的维护
边界。任一 Session 不兼容即阻止整个共享 storage 兼容。源根丢失仍可校验已固定
bundle 的内容，不授权登记修复、挂载提升或解 fence。旧回执不是当前授权，未来
W1c 消费者必须在自己的转换前复查恢复点和预期 mount revision。

临时 I/O 失败保留进度支持同 ID 重试；摘要/作用域冲突报告且不覆盖 artifact；
来源漂移使操作失效。提供私有稳定诊断，输出不得含凭证。inspect 只读；W1a
日常冷加载不在每个 Turn 前扫描备份树。

离线部署匹配 Java/CLI bundle 和加法 schema。旧二进制忽略新元数据/fence 假设，
必须保持停止。用一个指向 main 的 Draft PR，在 #13110 合并且完整整合前明确
标注依赖。真实 Linux/MySQL 验收前不转 Ready。

## 7. 验证与验收

工作计划保存在 `.qwen/e2e-tests/managed-workspace-w1b-bundle.md`。先 dry-run 全局
`qwen`，如实记录私有入口缺失；使用维护进程测试脚本回退，不用虚假的模型成功。

- 捕获两个 Workspace、多 files/Shell Session 共享 storage，包含归档记录、
  O2 输出和独立 history 卷。
- 在每批、blob 发布、SQL 进度和最终回执边界中断。同 ID 重试得到相同索引/
  摘要，不修改权威记录或产生重复引用。
- 注入晚到创建、纯模型提交、writer 续租、绑定变化及已接受输入。拒绝旧恢复点，
  保留 fence 与活动树。
- 删除/破坏 checkpoint、消息、domain 前驱、备份字节、O2 page/segment/seal
  和 manifest；空流缺少 seal 同样拒绝。
- 覆盖根重叠、越界/循环链接、特殊文件、未声明条目、跨 Session 引用、prototype
  命名文件和快照来源不匹配。
- 区分原本不存在、未捕获历史、缺失备份、pending undo 和部分恢复。源丢失允许
  内容校验；后续权威工作拒绝兼容性。
- 验证大量成员分页、大文件/输出流式处理，以及 W1a 原回执和冷加载回归。

要求 build、typecheck、bundle、相关包定向测试和 Java Checkstyle。物理与持久化
门槛使用已打包 Harness/Worker、Java Broker 和 Linux/MySQL 8。H2/macOS 结果
单列，不替代 Linux 验收。完成两轮连续干净自审和独立审查，在单一 PR 附实际
E2E 报告。provider/范围没有未定选择，其余验收证据在实际测量前记录为待完成。

2026-10-01 实测：build/typecheck/bundle、63 个 W1b 单元测试、CLI bootstrap
测试、相关 core/history 测试及定向 Java 测试/Checkstyle 通过。独立维护进程
测试脚本回退在 macOS 使用实际已打包 CLI 子进程、Java 制品中的类、MySQL
8.4.11 和替代存储身份读取器，捕获两个 Workspace 的 35 个 Session、106 个
asset 和 56 个文件系统条目；同 ID 完成重试保持回执与全部制品摘要一致。
新验证分别报告当前兼容内容与源丢失后的仅内容通过。中断续办及处理中来源漂移
均保持 `INVALIDATED/source_drift`，不封存、不写原权威数据。原 O2 协议 fixture
也在真实 MySQL 配合内存对象存储通过。独立审查发现并发完成/失效竞态及部分清单的
来源丢失路径；修复保留持久失效并复查固定来源。定向已打包 Java/H2 和 Node 回归
探针与此前完整 MySQL 测试分别记录。这些作者执行的 fixture 不证明实时
Harness/Worker/Broker 或外部 OSS 部署验收。
[wenshao 的独立部署证据](https://github.com/wenshao/qwen-code/tree/511e05b89edf0197a0e632b19248b9b7c0a0d636/pr13138)
另在 Ubuntu/ext4、MySQL 8.4.11 上测试 `989baf220`，包含已部署的
Broker/Harness/Worker、真实阿里云 OSS、四个物理 kill 时点及 20,916 条目/
77 Session。评审者还比较了 `8bd11d5a` 的 bundle，只有内嵌提交常量不同。
这些已测场景属于对应制品的独立证据，不是作者对后续评审修复的实测，也不覆盖
所有中断边界。归档/关闭/删除成员仍只有合成数据覆盖。
[第二轮部署证据](https://github.com/wenshao/qwen-code/tree/d6194156339afff14968c881c8355e547eb2b858/pr13138/r2)
另在相同 Linux 装置验证了 `0919b9d8`，包括四项评审修复、五个物理中断窗口和真实 OSS
拒绝对照。它覆盖该版本，不覆盖后续主干整合。维护者架构签核及整合版本的支持平台
验收仍待完成；CI 绿灯和 Ready 状态不能替代这些门槛。
#13110 已合入主干。本次整合 main `d5c22d33`，保留其 V26 工具结果投影、
V27 Hosted Hooks 记录、V28 准入索引、V29 准入回填及 V30 Session-owned
工具输出保留；仅将尚未合入的 W1b 恢复元数据移到 V31，SQL 字节不变，
不改写主干迁移历史。另包含 #13144 文件历史/undo 校验、#13172 Hosted smoke
门槛及 #12965 迁移唯一性检查。
[第三轮部署报告](https://github.com/QwenLM/qwen-code/pull/13138#issuecomment-5944274897)
确认 `e50e2c37` 的 V28 有效，但发现普通 Hosted 模型 route/usage 支持缺失；
其成功的 Linux runbook 和中断检查使用该版本加候选白名单修复。本次纳入这两种
资源，并测试由实际模型 activation 生成的 journal，包括资源缺失/损坏及未结算工作。
外部候选证据不认证后续制品。H2 Hook domain、Hook 专用模型资源及 MCP profile
仍不在 W1b 支持的闭包内，会拒绝 capture；本次不认证或激活 Hook 恢复。

普通模型资源修复 `258c57ed` 推送后，与更新主干的合并 CI 因两个 V28 迁移拒绝。
修改前，独立打包 Flyway/H2 探针已复现冲突，`e3055f49` 将 W1b 移到 V30。
随后主干整合 #13084，用 V30 保存工具输出保留状态；另一独立打包 Flyway/H2
探针在修改前复现此次冲突。V31 保留新的主干历史，新库及 main-V30 升级
需要新的制品检查。保留端口分配修复 `1d55ed37`；其通过的 Hosted 故障切换
CI 使用旧主干，不认证此次整合。应用过分支专用 W1b V27、V28 或 V30 的
预发布数据库不属于支持的主干升级路径：这些编号对应不同主干迁移，校验必须拒绝
不匹配的历史。不执行自动历史修补、回滚或数据库重建。旧 Linux/OSS 证据继续
归属原提交，不作为此次后续整合的验收。
