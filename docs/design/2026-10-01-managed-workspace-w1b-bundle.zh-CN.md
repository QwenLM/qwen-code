# W1b：离线 Workspace 恢复 Bundle

[English](2026-10-01-managed-workspace-w1b-bundle.md) | [简体中文](2026-10-01-managed-workspace-w1b-bundle.zh-CN.md)

状态：实现中。基于 main `937ed13a1`，直接整合文件历史依赖
[#13110](https://github.com/QwenLM/qwen-code/pull/13110) 的原提交 `fee8f8763`。
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
不能创建历史。活动工作、未完成生命周期操作、存活 writer 租约、不支持的
compaction 和 blocked recovery 拒绝捕获。

每次提交派生记录前复查 Session；封存或记录兼容性前复查完整成员集合与来源摘要。
新 Session、纯模型提交、绑定变化、writer 续租及新增已接受工作使旧恢复点失效。
任何重试均不能静默推进水位。

## 3. 持久流程与私有入口

三类加法表保存恢复操作、固定 Session 来源及 asset/reference 工作。它们只保存
派生元数据，原创建回执、journal、resource 和 resource-ref 行不修改。使用下一个
未占用 Flyway 迁移号，不修复旧迁移历史。

操作阶段为 `CAPTURING`、`SEALED`、`VERIFYING`、`VERIFIED` 和 `INVALIDATED`。
I/O 中断保留阶段和进度，来源漂移使操作失效。运维调查后在仍持有的 fence 下
使用新恢复 UUID；任何操作不能接管其他 fence。

Java 私有 main 支持 `capture`、`verify`、`inspect`，读取运维拥有的 JSON 请求，
写操作要求 `--offline-confirmed`。请求包含 tenant/storage、恢复 UUID、fence UUID、
预期 mount revision、规范 source/bundle 根、原 Worker file-history 根、Node
可执行文件和匹配的已打包 CLI 入口。验证另指定已封存捕获操作。JDBC 凭证和
可选 O2 对象存储凭证只通过环境传入，不新增 HTTP 维护路由。

Java 负责 JDBC、作用域校验、来源快照、分页、冲突检查和条件完成。匹配的 CLI
子进程执行只读 TypeScript 文件系统/协议校验，通过管道逐个交换带关联 ID 的
JSON 请求和响应，record/object 大小沿用已有协议限制。子进程失败或异常响应
不能封存操作；不创建公开 writer token 或生产 Harness。

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
W1a guard 查询；现有 HTTP Session 读写、Hosted Turn 路由和 Runtime Worker 派发
继续使用既有路径。V26 派生队列索引支持 asset key 分页及 Session/state 引用选择。

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
