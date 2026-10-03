# W1c：Workspace 存储离线迁移

[English](workspace-storage-migration.md) | [简体中文](workspace-storage-migration.zh-CN.md)

## 状态与范围

已完成本地实现并整合主干 `5130c1a73`，包括 W1b、可靠 Session close、持久进程默认设置和输出回收；生产 Linux 验收仍待完成。首版限定同一可信 Linux 主机、原存储可访问、已结算的 `hosted-workspace-files/1` Session，以及保持不变的绝对 `QWEN_HOME`/file-history 卷。只移动 Workspace root。排除 Shell/O2、MCP/Hook、外部 Memory root、不透明绝对路径、跨主机和源丢失恢复。所有保留成员参与，包括关闭、归档和删除记录；不支持或无法证明的成员阻止整个操作。

逻辑 storage、全部 ContextBinding 字段、私有 Session Store key、原创建回执、journal、消息和资源引用保持不可变。迁移不关闭公共 Session，也不重新开放关闭的 Session。

## 维护协议

私有 Java 命令为 `retire`、`prepare`、`promote`、`inspect`、`abort`。版本化请求固定迁移 UUID/摘要、tenant/storage、预期 mount revision、源与目标部署路径、W1a fence UUID、W1b capture UUID 和保留历史卷。同 UUID 改参数冲突。状态为 `RETIRING -> RETIRED -> PREPARING -> PREPARED -> COMPLETED`；漂移进入 `INVALIDATED`，明确取消进入 `ABORTED`。临时 I/O 保留检查点；完成重试返回原回执。

运维关闭 Session 创建、输入准入和派发，结算已接受工作，停止 Harness/journal writer 并防止重启。`retire` 在现有 tenant placement 锁域安装持久 storage 准入 fence，释放精确原 Runtime Session，证明物理 Worker 退役并检查未结算执行/holder。复用可靠 close 的停止回执和有界 claim，不安装永久 Harness close fence。旧 FAILED/LOST/RELEASED 记录需要正向停写证据；终态和租约过期不足为证。已有 loss recovery 必须按原协议完成。

退役后运维进入 W1a 维护 fence，使用外部准备的 Workspace 副本捕获 W1b 证据。`prepare` 验证固定 capture、当前来源、目标副本、迁移资格和历史卷。`promote` 使用新的运行重复验证；旧成功回执不能授权当前转换。维护期间不获取 Runtime。

## 证据与原子提升

复用 W1b 有界 Session 水位、资源闭包、历史解析器和流式树校验。检查全部保留备份；原本不存在、未捕获和缺失备份保持不同含义。Hosted 相对历史键基于新 effective directory 解析；保存的备份名称和字节保持不变。

目标树唯一例外是根 `.qwen-managed-storage.json`：只能匹配封存源 marker 或本操作固定目标 marker。通过目标文件系统内本操作专有的临时文件、原子替换和目标目录同步发布。重试校验前，先确认该路径不属于封存 capture，再只清除精确名称、普通单链接且有界字节匹配固定 marker 前缀的临时文件。冲突对象拒绝，完整目标清单不忽略任何条目。不得排除其他 `.qwen*` 文件，也不修改原 bundle/源 marker。

最终 SQL 事务检查操作所有权、旧 revision/fence、完整来源水位和旧 placement 停写证据，安装目标 root/身份/新 registration UUID，revision 增加一次，持久化完成并清除迁移准入。提交前失败保持旧 fenced 登记；SQL 前 marker 发布可续办。abort 保留退役事实和 W1a fence，不删除目标或重开服务。反向迁移需要新操作/capture 和更高 revision。

长文件扫描不持数据库锁；最终条件读取遵循已有锁顺序并执行新的锁内权威检查。只增加 Flyway 迁移，保留 V31 W1b、V32 close 和 V33–V34 定义/回收迁移字节，W1c 新增 V35。

## 部署与 Runtime 路由

运维在完成后更新部署挂载并重启 Broker/Harness。配置与 SQL 身份不一致时拒绝执行。私有 Node 探针使用现有 Storage 解析器和继承环境，固定真实绝对 QWEN_HOME/历史卷身份，位于源、目标和 bundle 之外。新准入/provisioning 检查环境与目录身份，每 Turn 不扫描备份；无需扩展 Worker boot/attestation 协议。

新文件 Turn 和 undo 获取新的 placement/context/attestation/activation 回执。旧 status/cancel/release 保留保存的 binding/generation/scope。历史 Runtime Session 查找使用精确 tenant/Harness/Runtime 身份，拒绝歧义，不依赖当前挂载 scope。不改写旧 cwd、持久 handle、执行 ID 或 attestation。

## 验证与验收

覆盖共享 storage 多 Workspace/Session、保留生命周期状态、旧 undo/新历史、延迟 warm/startup、release/stop 回执丢失、旧 Broker 回调、每个文件/SQL 边界中断、并发 promote/abort/W1a restore、成员/model/writer/close 漂移、root/history 替换、marker 冲突、不支持 profile 与路径。回归 W1a 冷加载、W1b 回执、close 和历史清理。大文件流式读取，清单分页。

真实验收使用生产 Linux 主机/挂载身份、MySQL 8、打包 Harness/Worker 和 Java Broker，执行停止—退役—捕获—准备—提升—重启—写入—undo。完成 build/typecheck/bundle、定向 TS/Java、MySQL 并发、两轮连续干净自审和独立审查。macOS/H2、注入身份、逻辑崩溃模拟和真实物理中断分别报告；未执行场景不能声称通过。

## 实现区域与决策

Runtime Broker 准入/仓库/退役和精确历史查询；Managed Agent 迁移 store/私有 main/Storage guard；共享 TypeScript 恢复闭包/树验证；加法 SQL 和同目录测试。不增加公共 API、在线 drain、热挂载 resolver、通用编排框架或目录复制实现。范围决策均已确定。
