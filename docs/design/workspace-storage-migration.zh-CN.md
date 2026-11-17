# W1c：Workspace 存储离线迁移

[English](workspace-storage-migration.md) | [简体中文](workspace-storage-migration.zh-CN.md)

## 状态与范围

已完成本地实现并整合主干 `4bffa678b`，包括 W1b、可靠 Session close、持久进程默认设置、输出回收、持久化 Session 工具 profile、W2 cwd 变更、搜索 profile 恢复和 H5 channel 持久化；生产 Linux 验收仍待完成。首版限定同一可信 Linux 主机、原存储可访问、已结算的 `hosted-workspace-files/1` Session，以及保持不变的绝对 `QWEN_HOME`/file-history 卷。只移动 Workspace root。排除 Shell/O2、MCP/Hook、外部 Memory root、不透明绝对路径、跨主机和源丢失恢复。所有保留成员参与，包括关闭、归档和删除记录；不支持或无法证明的成员阻止整个操作。

逻辑 storage、全部 ContextBinding 字段、私有 Session Store key、原创建回执、journal、消息和资源引用保持不可变。迁移不关闭公共 Session，也不重新开放关闭的 Session。

## 维护协议

私有 Java 命令为 `retire`、`prepare`、`promote`、`inspect`、`abort`。版本化请求固定迁移 UUID/摘要、tenant/storage、预期 mount revision、源与目标部署路径、W1a fence UUID、W1b capture UUID 和保留历史卷。同 UUID 改参数冲突。状态为 `RETIRING -> RETIRED -> PREPARING -> PREPARED -> COMPLETED`；漂移进入 `INVALIDATED`，明确取消进入 `ABORTED`。临时 I/O 保留检查点；完成重试返回原回执。对 PREPARED 重试 `prepare` 也返回保存的回执，不重新扫描；只有新的提升尝试执行当前校验。

运维关闭 Session 创建、输入准入和派发，结算已接受工作，停止 Harness/journal writer 并防止重启。`retire` 在现有 tenant placement 锁域安装持久 storage 准入 fence，释放精确原 Runtime Session，证明物理 Worker 退役并检查未结算执行/holder。复用可靠 close 的停止回执和有界 claim，不安装永久 Harness close fence。准入和最终元数据检查保留现有 tenant 级 placement 锁：同 tenant 的其他 storage 可能等待这些元数据事务完成；文件扫描和物理退役在锁外运行。未绑定的旧 Session 没有 storage 所有权，不受此 storage fence 约束。旧 FAILED/LOST/RELEASED 记录需要正向停写证据；终态和租约过期不足为证。已有 loss recovery 必须按原协议完成。

W2 cwd 准入在第一次读取前获取相同的 tenant placement 锁，随后拒绝 fenced storage 上的新操作；有权限的 fence 前回执仍可重放。结算在该锁下重新检查 fence，并以 `workspace_unavailable` 持久化失败，不改动绑定。cwd 探测执行与正常获取相同的 LOCAL storage、migration fence 和已完成迁移的 QWEN_HOME/历史身份门禁，保留已有临时 I/O 分类。

创建新迁移操作或 admission fence 之前，检查原 Runtime 状态目录和保留历史目录均为存在的规范目录，并使用未变更的 W1a 读取器证明历史目录身份。 对已有 Runtime 状态目录复用 durable provider 按 UID 确定属主及 POSIX 权限恰为 `0700` 的检查；维护进程以原服务用户运行。前置校验不创建目录，也不修改权限或属主。不满足条件时在退役任何 placement 之前返回 `migration_state_unavailable` 或 `migration_history_unverified`。有歧义的 birth time 仍不支持。已有操作的查看/回执重放不重复这些前置检查；目标身份仍在外部复制完成后的 prepare 阶段检查。

退役后运维进入 W1a 维护 fence，使用外部准备的 Workspace 副本捕获 W1b 证据。`prepare` 验证固定 capture、当前来源、目标副本、迁移资格和历史卷。`promote` 使用新的运行重复验证；旧成功回执不能授权当前转换。维护期间不获取 Runtime。

## 证据与原子提升

复用 W1b 有界 Session 水位、资源闭包、历史解析器和流式树校验。检查全部保留备份；原本不存在、未捕获和缺失备份保持不同含义。Hosted 相对历史键基于新 effective directory 解析；保存的备份名称和字节保持不变。

目标树唯一例外是根 `.qwen-managed-storage.json`：只能匹配封存源 marker 或本操作固定目标 marker。通过目标文件系统内本操作专有的临时文件、原子替换和目标目录同步发布。重试校验前，先确认该路径不属于封存 capture，再只清除精确名称、普通单链接且有界字节匹配固定 marker 前缀的临时文件。冲突对象拒绝，完整目标清单不忽略任何条目。不得排除其他 `.qwen*` 文件，也不修改原 bundle/源 marker。

最终 SQL 事务检查操作所有权、旧 revision/fence、完整来源水位和旧 placement 停写证据，安装目标 root/身份/新 registration UUID，revision 增加一次，持久化完成并清除迁移准入。提交前失败保持旧 fenced 登记；SQL 前 marker 发布可由同一操作续办。abort 保留退役事实和 W1a fence，不删除目标或重开服务。若已取消或失效的操作留下 marker 或临时文件，新操作必须通过外部流程重新准备与新 capture 匹配的目标副本，不接受或删除其他操作的产物。反向迁移需要新操作/capture 和更高 revision。

长文件扫描不持数据库锁；最终条件读取遵循已有锁顺序并执行新的锁内权威检查。只增加 Flyway 迁移，逐字节保留已发布主干到 V47 的全部迁移；W1c 新增 V48 保存迁移状态与 fence，V49 为历史 Session 和已完成迁移查询增加索引，V50 修正二进制身份比较。这些 W1c 编号在合入前分配，避开已发布的 V36–V47 activation、事件、快照、journal 索引、Session 创建者、CSI、task-journal、cwd 操作及 H5 channel 持久迁移。升级测试从主干 V47 开始，保留原 Flyway 已应用记录。使用早期未合入 W1c 版本的开发数据库需要重建一次性 fixture，不能修补或改写已应用的生产迁移历史。

V50 将两个迁移表的身份比较修正为二进制 utf8mb4，兼容默认不区分大小写的数据库，不修改 V48/V49 SQL 字节。MySQL 专属字符集转换不由 H2 模拟。加锁来源清查先无锁检查 journal head 是否存在，再锁住已有 head；保留的租户权威锁阻止新 writer，同时避免缺失键的 InnoDB gap 锁阻塞其他租户。

## 部署与 Runtime 路由

运维在完成后更新部署挂载并重启 Broker/Harness。配置与 SQL 身份不一致时拒绝执行。私有维护进程必须继承与部署相同的规范绝对 QWEN_HOME，路径不能包含符号链接，fileHistoryRoot 必须等于其规范 file-history 目录。重复分隔符和尾部分隔符按 Java Path 的写法放行；dot/parent 组件与符号链接别名仍被拒绝。私有 Node 探针使用现有 Storage 解析器和该继承环境，固定历史卷身份，位于源、目标和 bundle 之外。新准入/provisioning 检查环境与目录身份，每 Turn 不扫描备份；无需扩展 Worker boot/attestation 协议。

新文件 Turn 和 undo 获取新的 placement/context/attestation/activation 回执。旧 status/cancel/release 保留保存的 binding/generation/scope。历史 Runtime Session 查找使用精确 tenant/Harness/Runtime 身份，拒绝歧义，不依赖当前挂载 scope。 歧义返回不可重试的 `409 runtime_session_ambiguous`，不选择或释放任何候选。非唯一 Runtime Session ID 索引先定位候选，再检查完整 tenant/Harness 身份和歧义；单列 VARCHAR(512) 在 utf8mb4 下仅需 2048 字节，不新增摘要字段或回填。独立 Broker 初始化同步 schema，并为已有表补齐索引。不改写旧 cwd、持久 handle、执行 ID 或 attestation。

## 验证与验收

覆盖共享 storage 多 Workspace/Session、保留生命周期状态、旧 undo/新历史、延迟 warm/startup、release/stop 回执丢失、旧 Broker 回调、每个文件/SQL 边界中断、并发 promote/abort/W1a restore、成员/model/writer/close 漂移、root/history 替换、marker 冲突、不支持 profile 与路径。回归 W1a 冷加载、W1b 回执、close 和历史清理。大文件流式读取，清单分页。

真实验收使用生产 Linux 主机/挂载身份、MySQL 8、打包 Harness/Worker 和 Java Broker，执行停止—退役—捕获—准备—提升—重启—写入—undo。完成 build/typecheck/bundle、定向 TS/Java、MySQL 并发、两轮连续干净自审和独立审查。macOS/H2、注入身份、逻辑崩溃模拟和真实物理中断分别报告；未执行场景不能声称通过。

## 实现区域与决策

Runtime Broker 准入/仓库/退役和精确历史查询；Managed Agent 迁移 store/私有 main/Storage guard；共享 TypeScript 恢复闭包/树验证；加法 SQL 和同目录测试。现有公共错误契约声明 Broker 拒绝响应携带的可选 retryable 布尔字段；Managed Agent 的迁移准入 fence 返回 workspace_unavailable，workspace_migrating 属于 Broker binding repository。不增加公共路由、在线 drain、热挂载 resolver、通用编排框架或目录复制实现。范围决策均已确定。
