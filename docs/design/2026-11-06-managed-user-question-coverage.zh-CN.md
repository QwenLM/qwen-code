# Managed 子会话问答与等待期间释放执行成员占用

[English](2026-11-06-managed-user-question-coverage.md) | [简体中文](2026-11-06-managed-user-question-coverage.zh-CN.md)

状态：已接受的实现设计，尚非运行验收证据。调研基于 `ee1a9b1e`，实现从 `478c2f87ab61c12f0548041af1e65e054bea549d` 开始。扩展[现有问题协议](2026-11-06-managed-user-questions.zh-CN.md)。

## 问题与范围

普通本地 Workspace 已允许多个执行成员，共享目录不天然使兄弟会话串行。实际缺口是 public child 问题准入、WebShell 自动选中单个 Action，以及等待期间不必要的执行成员占用。

支持普通本地 files/Shell 根会话和 depth 1 内置 public child，多个问题可同时待答，用户任选先答。后台命令不禁止提问；保留真实占用而不停止后台工作。SSH、resident、MCP、Hooks、Team 成员、workflow、snapshot、扩展定义及更深层 child 仍排除。

保留每工具批一个问题、profile 白名单、绝对过期时间／Turn deadline、depth 1、4 个活跃 child 和生命周期 64 次 launch。等待计入活跃额度，根 Plan 保持原准入。问题、答案和结果属于原 Session；父页面聚合，父模型不能代答。

## 执行与恢复

正常 acquire，核实实际 `local-process` binding，要求此前结果已知且本 Session 文件历史操作已结清。持久化原输入、native continuation 和最终清理责任，Shell 也不例外。先提交问题 Action，再用捕获的 mount claim 归还成员。

归还后 Runtime 保持 READY、原安装、身份和续期。后台／控制操作繁忙时保持实际占用，问题仍可答。响应丢失视为未知并重试同一 claim。复用 1/3/5/10/30/60 秒退避，上限 60 秒，首次最多等待两秒。回答、取消、过期、writer 丢失和关闭停止重试。迟到响应只有在捕获的 claim 仍为当前值时才能更新内存。

答案持久化后 expected acquire 复核 binding、Runtime generation、Workspace generation 和 provider，才生成原结果并继续。刷新 Workspace 指令，不重置文件历史指纹或覆盖兄弟修改。重新 acquire 替换旧 claim。

新合格问题冷恢复时，在等待前恢复原 owner／claim 并尝试归还。ToolTurn 复用 Broker，跳过可能创建其他 binding 的普通 warm。跟随最新 checkpoint，复用持久化答案／结果，不重放先前工具或过时模型 attempt。原 owner 变化／缺失、writer 未证明则继续阻塞。取消／过期不为终止本身重新 acquire。

## 契约与兼容性

内部 warm/acquire 响应提供实际 binding 的 `runtime.provisionerKind`。与 Broker 三字段 runtime 身份分开保存，显式组装持久化记录；capability digest 与 foregroundOnly 不能证明 provider。

新合格单问题 native continuation 可包含 `runtime.provisionerKind: "local-process"`。TS 和 Java 严格读取器校验并拒绝其他调用或不支持组合。旧记录缺字段时沿用原等待／恢复顺序。保持 schema version 1、question options v4、answer v2、公共 HTTP API 和数据库表不变。

先部署读取器再写入；新记录写入后的回滚保留兼容读取器。该字段不授予所有权，expected acquire 仍校验实际身份。声明和执行共享持久化 public-child v1、depth 1、内置身份及 provider 准入，不能仅凭深度。

## 清理与后台保留

归还成员不解除最终清理责任，保留 owed 到 confirmed 的持久化语义。仅当原 owner 普通 release 返回精确 `409 runtime_session_held` 且匹配持久化 Shell/Monitor 证据时，reconciliation 额外分类为合法后台保留。其责任仍 owed 并交给 Session 后台管理，实际释放后才写 confirmed。

匹配 cleanup descriptor、binding/generation，并通过执行的持久化 tool-input 封套证明 Runtime Session，不能仅靠 command 参数。未知／blocked 仍阻塞。纯读 status 重新核对逐项分类和 committed sequence，不执行 release/acquire。历史 active-holds 清单仅恢复 drain 责任，冷 load 经清理 reconciliation 取得新分类。

普通清理、重试、原 owner 恢复和 held-runtime release 均消费分类；cleanup 后登记保留责任。关闭可对已证明保留推进至 drain，但必须实际释放并 reconciliation 后才能完成。保留未终态 Turn 的既有 detach／replacement 交接语义：其清理责任仍为 owed，直到恢复流程结算原 Turn。最终 drain 即使面对其他未结算输入，也逐项清理已终态 owner，传播真实释放失败，不会确认延期的非终态欠账。纯恢复状态查询继续因该欠账阻塞。

## WebShell 交互

单张表单上方紧凑列出全部待处理问题和权限请求，显示根／子会话来源、标题、类型和到期状态。默认最早待处理，以 Session/Action 稳定排序。新项和轮询不抢选择，仅在选中项结束时切换。

提交完整目标 Session/Action 身份及当前 revisions。草稿、提交状态和错误按页面归属、目标及 revisions 隔离。切换保留草稿，终态／revision／归属变化时清除。草稿仅存页面内存；刷新恢复问题和已接受答案，不恢复未提交文字。A 失败不禁用 B。

父选择器为唯一回答入口，child transcript 保持只读。保留逐 child 授权，区分答案已接受和执行已恢复。

## 验证与交付

验证真实 A/B 同时问题、先答 B、兄弟文件工具、成员数量、后台工作保留、响应丢失／迟到、取消／过期竞态、Harness/Java 重启切点、答案后结果前崩溃、owner 变化拒绝及文件指纹冲突。UI 覆盖稳定选择、独立草稿／错误、分页、复合目标和账号／根切换。保留准入负例和 child 限额。合成 Action 仅证明 UI／路由。

依次实现兼容契约／读取器和清理分类、Runtime 准入／归还／恢复、UI 和真实进程验证。执行受影响包测试及根 build/typecheck/bundle。本增量开始时 Java 共享预算总 600 秒、已用 539.576、剩余 60.424；后续消耗记入 E2E 证据，新提交和评审轮次不重置。完整 Maven/SpotBugs/MySQL/Hosted/fault 依赖 CI。记录缺口并完成两轮无发现自审。E2E 证据放在 `.qwen/e2e-tests/managed-user-question-coverage.md`。SSH/resident 和 MCP/Hooks 需独立验收。
