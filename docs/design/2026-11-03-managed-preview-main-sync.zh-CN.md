# Managed 私有预览与主线同步

[English](2026-11-03-managed-preview-main-sync.md) | [简体中文](2026-11-03-managed-preview-main-sync.zh-CN.md)

## 范围与状态

这是私有预览集成候选，尚待编译、聚焦测试、完整 CI、制品校验及预发验收。将既有 `7e79b000ef1f1013a9c14ce15a81d8499ac1b0b5` 预览与上游 `cb6df9d90170ec00d6563f07280bd617d8c466d3` 同步，保留 Session 归属与外部 Workspace 契约。本次不授权生产发布或数据库迁移。

本轮刷新主线后，Java SDK 新增 Session 模型配置 digest 和能力协商，不能继续复用旧 SDK payload。Server 与 SDK 从同一精确源码提交构建并分别冻结唯一私有版本；Java Maven 版本与 CLI 包版本保持区分。

## 集成决策

保留主线的 Store 拆分：公开 facade 保持事务入口，admissions 在创建事务中写入 Session 归属，commands 校验不可变身份与回执授权，queries 按同一身份落实可见性。各组件复用既有归属权威。保留迁移准入锁、Session-before-Turn 顺序、原生 journal 事务和拒绝旧归属行的行为。

保留主线的可选运行时模块与 provider registry。外部 provider 负责配置校验及 acquisition/terminal/recovery 证明。contracts 中的 `ExternalWorkspaceProvider` SPI 将这三项操作交给服务端装配，服务端不编译依赖可选的外部实现。既有 recovery gateway 仍将持久恢复委托给 Broker，其他 provider 不因此获得外部能力。

保留预览版本中已验证 payload 的并发派发修复，以及失败/取消终态不阻塞回收的修复。保留 tenant/user/actor 身份、精确注册、原 worker 证明、Session 关闭隔离及失败关闭的恢复语义。不增加工具、Shell 支持、隐式就绪或启动 DDL。

既有预览错误地只允许 SSH 确认已持久化的工具结果。将结构完整的外部 Workspace 请求接入同一确认路径，保留终态结果、原生 reference、持久 Session 成员关系和 binding generation 检查。只有共享隔离的外部 Workspace 可以省去单 Harness isolation key 条件。当前瞬态 lifecycle authority 仅投影到传输用 Session，不写入持久状态。回归证据须覆盖两个共享成员各自收到确认、释放一个时保留另一个，以及既有丢失 ACK、claim 到期与原 worker 停止顺序场景。

保持缺失身份的拒绝方式和授权顺序。模型操作使用已校验的 actor 与已授权 Session 的租户；任务视图通过既有分页投影传递该租户，不在授权后解引用可空 principal。

## 制品与结构契约

构建新的唯一私有 Server 版本，在真实消费 POM 中保留第三方依赖。用户已授权本轮使用 macOS JDK 21 隔离编译；共享本地预算耗尽后，剩余检查与打包转到 CI。仅聚合生产模块；`META-INF/services` 条目须合并去重，不能覆盖其他 provider。冻结源码、源码提交、许可证、校验和与验证证据。不修改旧制品字节，不发布 verification 模块。

共享 V1 基线保留 `ma_session_principal`、外部注册回执和 shared dispatch 分类，并同步上游三个模型配置字段及全空或全非空 CHECK。Session 创建在同一事务写入归属与加密模型配置，重放保持在当前能力与模型端点校验之前。开发/预发库必须与最终制品精确匹配。继续拒绝旧库、残缺库和混用业务库；不进行 Flyway repair、结构版本递增、自动迁移或业务混库。

## 验证与验收

选择 Session 身份归属、外部 materialization/ownership、恢复/回收、外部 drain、shared dispatch、runtime dispatch、provider 装配与 schema 测试。共享十分钟本地 Java 预算内无法运行的 MySQL 8.4 与真实进程恢复证据必须明确保留缺口。完整测试集、Checkstyle 和 SpotBugs 由 CI 执行。

消费方验收还须完成 DataAgent 编译及 Java/MySQL 门禁、最终包结构与 provider 资源校验、部署源码/制品/数据库身份核对、两个只读 Session 共享同一 Worker 并发、取消后继续及关闭一个 Session 不影响另一个。部署和 E2E 状态与源码集成分别报告；失败或无法执行的门禁不代表通过验收。

## 完整测试集的契约核对

既有私有 preview 要求 Session 入口携带可信 principal，并拒绝缺少不可变归属记录的非 Workspace 行。上游测试关于非 Workspace 会话可在租户内匿名访问的假设不代表这份私有契约。成功 fixture 应显式提供已验证用户，保留 Workspace 的 reader/operator 授权；同时断言缺身份 401、外来私有 owner 404，以及真实 owner 的读取和变更成功。不得为满足旧 fixture 恢复历史归属兜底或修改生产鉴权顺序。

完整原生测试还发现一处真实 MCP 回归：生成命令操作身份时把可空的业务主体放入 List.of。使用允许空值的 JDK 列表保留六字段身份元组，无业务主体时仍编码 JSON null；验证普通用户和不同业务主体、相同请求重放，以及 reader 在任何 Harness 提交前收到 403。

资格断言纳入精确新增的 facade 重载、39 张原生表和单独保留的 Flyway 历史表。principal 表属于新增原生能力，不伪造为 63 个历史实体的迁移落点。CI 的 Git 2.39.3 不满足既有 Child Workspace 最低要求，应在 CI 工作目录构建固定版本且核对校验和的 Git 工具，不放宽版本门禁。Node 子进程保持既有截止时间，并在超时诊断中保留子进程输出。完整测试、真实 MySQL 与 Hosted 验收仍分别取证。

Workspace 的 rename key 保持租户范围：operator 对自己可操作的绑定会话使用另一绑定会话已占用的 key，收到 409 idempotency_conflict，不重放、不变更。此情形与非 Workspace 私有 receipt 的归属隔离分开，后者仍向外来 principal 返回 404；同一会话的待完成 rename 仍要求原记录者身份。

## CI 证据驱动的进程回收修正

CI85959174 确认先杀 Git 父进程会使原子进程在 PID1 下成为僵尸。先停止已观测叶子，保留其父进程回收机会，持续补查根与已知存活父进程，并将原 ProcessHandle 全部纳入最终停止证明。子进程回收与根进程停止共用一个两秒截止时间，run 的 finally 不再开启第二轮停止预算。清理尽力发送全部已知停止信号，即使失败仍恢复线程中断位；无法证明停止继续返回 STOP_UNVERIFIED 并保留维护 holder。新增多层子进程中断回归，要求原 PID 全部消失、中断位保留；中断 checkout fixture 保留部分文件及拒绝收养断言。

两例原生 CSI fixture 已完成生成，却未在30s内退出。collector 先停止接收新连接，再关闭现有连接，之后等待关闭回调；清理阶段及资源类型日志区分 collector 等待与导入资源残留。保留幂等 store 清理、30s/exit0 门禁及全部字节和投影断言。本增量已实现、等待 CI，不引入数据库、鉴权、归属或超时例外。

## 最新上游同步（2026-11-04）

用户要求再次更新 Managed Agent Server。固定 canonical main da42e5714ad0238c4d49bc31e3ede99314397083，包含结构规范化、Workspace 执行脱离租户锁和并发上传。Java SDK 源码树仍为 e8e54635e6f70bcc85d71ff52ad05341b138350d。保留私有 principal 归属、外部 Workspace 回执及 shared dispatch，不替换为另一份旧 preview。

合并后的基线严格等于上游38表 DDL 加 ma_session_principal、EXTERNAL_WORKSPACE 回执准入及 shared_dispatch_class 三项扩展。共39个自增行标识、76条 CHECK，无物理外键。按上游要求，ma_session 和 ma_tenant_guard 保留业务主键；其余表（含私有 principal 表）以 id 为主键，单独保留业务唯一键。id 均为最后一个物理列。Inventory 暴露818个业务列，排除39个 id，共857个物理列；二进制业务身份及大小写语义保持。独立预发库必须再次核对结构后才能部署此修订，先前21ed基线不代表当前验收。DDL 前检查行数、严格 SQL mode 及负数、布尔和转换条件，保留 Flyway 历史与全部既有数据。

失去 claim 的稳定子进程 fixture 保留原有存储释放断言，并核对父子均停止；显式注入停止未证实错误时保留 holder。CSI 模型 fixture 仅关闭既有后台使用统计，原生 usage 资源及投影检查保留。Hosted 公共 SSE observer 转发与 JSON 请求相同的可信 actor，帧、崩溃、重放及单终态断言不变。本增量须由 CI 验证，不重新开启本地原生验证预算。
