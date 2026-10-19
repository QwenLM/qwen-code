# Writer 丢失后的 Hosted wake 恢复

[English](2026-10-18-hosted-wake-recovery.md) | [简体中文](2026-10-18-hosted-wake-recovery.zh-CN.md)

状态：为 [#14116](https://github.com/QwenLM/qwen-code/issues/14116) 实现修复，已在 macOS/MySQL 8.4 本地验证。真实 MQ 开启、Linux/Windows 及部署后的 provider 验收仍未验证。

## 问题

已提交的 wake 输入可能比 Harness 存活得更久。替代进程没有加载任何 Session，各来源 relay 的投递结束边界不同，而 writer 租约仍有效时被确认的 MQ 通知，不会在租约到期后再次到达。发现这些持久化工作不应依赖新的用户输入。

## 恢复归属

控制面独立于 EventTransport 扫描 SQL，恢复符合条件的 Session；现有 Harness wake pump 负责输入执行与崩溃后结算。扫描器和消息代理都不判断执行结果，不重新发送来源操作，也不重放工具效果。

支持的来源为 `monitor`（包括后台 Shell）、`channel`、`child_agent`、`workflow`、`automation` 和 `session_message`。相同 turn 标识的 `turn.settled` 表示输入已消费，无论结果是什么。公共前台输入仍由 dispatcher 负责。

## 发现与隔离

追加 V11 迁移扩展现有 Session head，不改变 32 表基线或已发布的迁移资源。日志提交同时维护 `wake_pending` 提示与 `wake_head_revision` 版本戳。生成列 `wake_scan_pending` 同时包含提示有工作的 head 和版本戳未知或过期的 head；索引按持久化 `wake_retry_at` 和有作用域的 head 键排列候选。

每轮先读取已有工作提示的候选，剩余名额才用于过期版本戳回填。新 head 将已证明的空前缀标记为 revision 0；既有 head 仍保留未知版本戳。

新 wake 准入设置提示。其他提交只推进仍然有效的版本戳，不清除提示。扫描器重放已提交日志前缀，证明消费之后，按日志版本比较并清除提示，不会清掉并发准入。旧 head 的版本戳初始为未知，不维护版本戳的旧二进制继续写入时也会使其过期。因此，同一扫描可惰性回填，不会虚构投递或消费状态。

候选必须是 Workspace 匹配、`ACTIVE` 且未退役的公共 Session，其日志为 writer 租约已到期的 `ACTIVE` 或 `SEALED`。租约按数据库时间判断。私有 CSI authority 不参与。Workspace 准入、授权、物理挂载验证和 Harness writer generation 获取仍是最终隔离。关闭中、已关闭、已删除和已退役的 Session 不会在此恢复。已有停止请求或已经终态的 child run 留给停止/关闭 relay；扫描器在已证明的日志版本清除其提示，避免重启已取消工作或反复加载等待关闭的终态任务。

获取 writer 时会锁定并检查公共 Session 的状态，包括未绑定 Workspace 的 Session。因此，在发现候选之后抢先完成的关闭仍会阻止 load；先获取到 writer 的一方仍受已有关闭围栏约束。

认领在同一事务中先锁公共 Session，再锁其 journal head，与普通准入和生命周期的顺序一致。持久化重试时间在日志重放或 Harness HTTP 之前提交，不持有数据库锁执行 load。这避免了包含 Session 子查询的 head 更新导致锁顺序倒置。

扫描器每页读取一个日志事务（存储的记录字节最多 8 MiB），校验作用域、字节摘要与连续的已提交前缀，根据输入准入和 Turn 结算推导待消费集合。发现、认领和证明版本戳更新均排除已经压缩的 head，因为其完整证明材料已永久不可用。前缀缺失或损坏时拒绝并记录日志，绝不解释为没有待处理工作。Harness 在运行之前还会独立验证恢复数据。

每次证明最多读取 32 个事务，长历史会让出调度器，使其他候选继续处理。缓存最多保留 128 个以完整、不可变候选前缀为键的条目：包含日志版本、事件序列及待处理/已结算 Turn 集合的部分证明，或已完成的正向证明备忘录。部分结果不更新 head 版本戳，也不请求 load；持久化重试间隔到期后的认领从缓存的严格前缀续算。只有完整遍历且末尾序列与候选精确匹配时，才能得出没有待处理输入的结论。完整负向结果不缓存；日志增加版本或进程重启时从零重新证明，不会清除持久化提示。不会为了准入新工作而逐出有效的部分证明：优先回收已完成备忘录，缓存满时轮转一次精确作用域的资格校验，回收已失去资格的持有者。没有空槽的新长证明让出时不保留部分状态，短证明仍可完成；已准入证明完成或失去资格后，等待中的长证明即可保留进度。同 Session 的新候选会替换旧缓存前缀。

## 重新附着与策略

恢复强制执行 passive load，不信任 connector 的附着缓存。generation 不匹配时沿用已有的 connector 代际接管，后续扫描使用新 boot 重试。这也覆盖没有保存公共 Turn boot 绑定的 channel Session。Passive takeover 不驱动无关的停放前台 Turn；那仍是 dispatcher 的职责。

connector 在缓存槽内按当前服务的 boot 验证 passive 响应。先发布附着，再仅在缓存仍持有同一 ref 时更新恢复标记。迟到的旧响应不能替换当前附着或删除其标记，代际接管也不会把尚未发布的 ref 的标记误当作孤儿清除。标记阶段在发布后再次校验 boot，若接管跳过了先前未发布的缓存槽，就删除失效 ref。这些缓存操作内不执行 HTTP，也不持有 connector 监视器。

Harness 的 pump 选择、阻塞恢复和新 prompt 的 park 守卫共享相同的六来源分类。channel Turn 的崩溃结算复用自身 interruption funnel，包括 Runtime 结算和文件历史清理，不使用通用 wake 的错误结果。恢复必须先证明曾经尝试执行，保留尚未尝试的排队输入，并让等待中的审批继续可处理。暂时故障或无法证明可恢复时，输入继续等待后续扫描。

不新增按输入年龄取消的策略。尚未尝试的 wake 在长时间故障后仍保留原标识，通过普通准入运行。已经尝试的 wake 沿用各来源现有的崩溃结算：不重放已提交效果，不掩盖未知结果，无法证明可恢复时保持阻塞。生命周期和已提交取消仍按原有优先级处理。

扫描使用独立的单线程调度器、有上限的候选页和持久化重试间隔。失败的 Session 排到其他到期候选之后。对已提交输入的发现没有永久尝试上限。来源 relay 的放弃状态不变：扫描不会重新准入从未提交的输入，也不会把未知的来源回执升级为成功。每次失败都在服务端日志中标明 tenant 和 Session。

日志增加新版本或进程重启后，证明仍需分多次有界调用读取完整历史。总成本随历史长度增长，部分证明保留 Turn 标识，缓存满时会延迟新长证明的准入。单次事务数上限不等于数据库查询超时，也不限制续算状态保留的总字节。候选过滤可能遍历活 writer、HARNESS、已关闭、已退役和 CSI 历史 head，这些索引条目不保证收敛消失。候选页只限制返回行数，不限制索引遍历，因此大目录和长历史仍会延迟恢复。持久化增量证明和目录清理仍是容量改进。生命周期清理也不能为日后可能重新符合条件的状态认证未检查的历史。

MQ 继续加速首次发现。其 `wake_covered_sequence` 仅用于通知去重；通知得到 `OWNED`、重复、失败或丢弃，都不会使 SQL 中待处理的工作对扫描不可见。

## 验证与验收

1. 使用真实 Harness、控制面和一次性 MySQL 8.4 复现 writer 丢失，记录已提交输入、租约到期、boot 变化，以及替代进程没有收到 load。之后显式 load 作为正向对照。
2. 修复后重启且不再发送输入。旧 writer 租约到期且到期扫描成功后，各支持来源的待处理输入应自动加载。夹具模型提供确定性的请求与结算。
3. 覆盖 EventTransport 关闭和开启，包括通知在租约到期前被消费，以及通知已认领但 load 失败。所有情况下都以日志为事实来源。
4. 覆盖已结算、多输入、旧或过期提示、回滚、并发准入和认领、tenant/Workspace 隔离、活 writer、生命周期、私有 CSI、已停止 child、过期附着和暂时故障。长日志必须让出扫描、保留两个 Turn 集合和序列连续性、续算至完整，并在重启或 head 改变时保留提示；已压缩 head 必须被排除且不能被认证为已消费。
5. 运行受影响的 Java 测试、完整 Maven 验证，以及匹配的 MySQL 和 Hosted 恢复 profile。使用夹具生产来源事件，或未完成的 provider/平台验收，均明确报告。

正常单 Session 恢复延迟为 writer 剩余租期，加上重试间隔及扫描/load 耗时。积压、Harness 不可用、授权被撤销、日志不可读或 Runtime 被阻塞，都可能延长该时间；这些条件仍存在时，不宣称恢复结果成功。

## 初始实现的本地验证

评审修复前，完整 Java 单测执行 4,670 项，失败和错误为零，18 项按预设条件跳过。11 个隔离 MySQL 测试覆盖发现、精确结算、版本竞态、持久化认领及先 Session 后 head 的锁顺序。Checkstyle、SpotBugs、最新主干根目录 build/bundle 和 Markdown 格式、引用检查均通过。

后续评审修复的验证记录见 [PR #14603](https://github.com/QwenLM/qwen-code/pull/14603)。下方初始实现的结果不证明后续修改已验证。

真实 Spring/MySQL/Harness 进程探针复现了缺少自动 load 的问题，并验证 monitor、实际 Automation define/fire 和实际 channel 输入无需新输入即可恢复。最终 Automation 构建产物探针在 34,807 毫秒恢复，旧 boot 的 409 后自动获得新 boot 的 200，再观察 35 秒，输入、模型和结算仍各一次。被中断的已尝试 Automation 按 `outcome_unknown` 结算，不重复模型请求。在认领后完成公共关闭，现在会以 `managed_session_not_writable` 拒绝普通 writer 获取，head 和模型计数不推进。

匹配的 Hosted/MySQL 和进程崩溃 profile 均通过，覆盖协调器重启，以及 Harness prepare/start/result、Spring 终止、worker 终止和暂停六处物理故障注入。冷恢复保持 blocked，不重放工具。故障夹具在已有支持的 Linux 和 macOS 上都注册原生存储，身份验证保持启用。

这些 wake 探针中的 monitor 输入生产使用夹具。通用日志测试覆盖六个来源名称，但不证明物理后台 Shell 生产、child/workflow/message 关系验收、外部 channel 投递或真实 MQ 开启行为。它们及部署、跨平台验收仍需独立验证。
