# P1：可配置的工作区注册容量

[English](workspace-capacity-p1.md) | [简体中文](workspace-capacity-p1.zh-CN.md)

状态：已在本地实现，2026-09-09；验证结果记录在 `.qwen/e2e-tests/workspace-capacity-p1.md`。实现基线：`d8c505bf423d6adf68c77a603202cd7b0578be56`。
源码基线：`dd4cd4a08bf416f88d9e357045f6ff45aa557d2e`，即合并
[#11428](https://github.com/QwenLM/qwen-code/pull/11428) 的 main 提交。
关联 [#11386](https://github.com/QwenLM/qwen-code/issues/11386)，以及配置诉求
[#9304](https://github.com/QwenLM/qwen-code/issues/9304) 和
[#9316](https://github.com/QwenLM/qwen-code/issues/9316)。

## 1. 建议与范围

新增一个由运营方控制的环境变量 `QWEN_SERVE_MAX_WORKSPACES`，默认 256，
支持范围 1–256。按最新要求将默认值设为 256；部署可显式选择 25，以保留原来的
注册上限和 session 默认行为。这更新了最初默认 25 的提议及
[此前调研](workspace-lru-eviction.md) 中的 P1 扩容阶段，不改变历史证据，也不代表
256 个活跃工作区的资源保证。

P1 同时需要明确全局 session 策略、约束 channel 事务，以及确保持久化注册可读。
仅替换常量无法满足这些要求。保留 daemon runtime 的即时构建和 ACP child 的
既有懒启动。Dormant 状态、LRU、实际 child 内存强制准入、channel 超时协商和
异步 channel 操作 API 均不属于 P1。P0 的三项独立策略继续保持独立。

## 2. 已核实的基线行为

以下结论已对照源码基线核查，包括原 P0 diff 之外的消费者。

| 关注点         | 当前行为与源码                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册           | [workspace-inputs.ts](../../packages/cli/src/serve/workspace-inputs.ts) 定义 25；[run-qwen-serve.ts](../../packages/cli/src/serve/run-qwen-serve.ts) 的启动检查和持久化合并读取该值。                                                                 |
| Runtime 准入   | [workspace-management.ts](../../packages/cli/src/serve/routes/workspace-management.ts) 统计受管理的用户 runtime、待完成添加和 scratch reservation。内部 Live Conversation runtime 豁免；用户 scratch runtime 计数。                                   |
| Session        | [deriveDefaultMaxTotalSessions](../../packages/cli/src/serve/run-qwen-serve.ts) 在只有一个启动工作区时不设总上限，否则用每工作区上限乘启动数量；每工作区默认 32。动态注册不会重算。                                                                   |
| 强制准入所有者 | [total-session-admission.ts](../../packages/cli/src/serve/total-session-admission.ts) 检查存活 session 加 reservation；[run-qwen-serve.ts](../../packages/cli/src/serve/run-qwen-serve.ts) 在所创建的 bridge 间共享该控制器，包括动态和内部 runtime。 |
| Store          | [workspace-registration-store.ts](../../packages/cli/src/serve/workspace-registration-store.ts) 最多读取 24 条 secondary、256 KiB。更新会在锁内重读，但原子写入前没有序列化字节检查。                                                                 |
| 启动溢出       | [持久化合并](../../packages/cli/src/serve/run-qwen-serve.ts) 跳过无效、保留路径、嵌套路径以及容量满后的额外条目。Store 读取错误回退到只启动显式工作区。                                                                                               |
| Channel 分组   | [channel-workspace-grouping.ts](../../packages/cli/src/serve/channel-workspace-grouping.ts) 按选中 channel 的唯一 owner 分组。`all` 只选择 primary；空注册工作区不会各自创建 channel worker。                                                         |
| Channel 事务   | [channel-worker-group.ts](../../packages/cli/src/serve/channel-worker-group.ts) 顺序停止、启动和回滚；回滚清理失败可能同时保留新旧 owner，目前没有独立的 owner 数量守卫。                                                                             |
| 超时客户端     | [DaemonClient.ts](../../packages/sdk-typescript/src/daemon/DaemonClient.ts) 的 legacy 和 qualified 写操作采用固定 2,130,000 ms channel 默认值。Web Shell 调用这些 SDK 方法；Java 当前没有 channel 控制方法，并保留原始 capability map。               |
| 配置来源       | [fast-path-settings.ts](../../packages/cli/src/serve/fast-path-settings.ts) 可能在 daemon 构造前加载项目环境值；运营方专属 key 在 [shared-env-keys.ts](../../packages/cli/src/config/shared-env-keys.ts) 中排除。                                     |

[2026-09-08 的测量](workspace-capacity-baseline-2026-09-08.md) 在一台 macOS
主机上发现：空的启动工作区从 25 增至 256，daemon GC 后堆增加约 20.6 MiB；
同时存在 watcher/FD 成本，默认 session 总上限从 800 增至 8192。这些历史观测
支持继续调查显式扩容，不代表 256 个工作区在所有环境都具有资源保证。

## 3. 配置与注册契约

### 3.1 每个 daemon 只解析一次策略

为嵌入调用者增加 `ServeOptions.maxRegisteredWorkspaces`，并增加上述唯一环境变量。
优先级是显式选项、启动环境、默认 256。P1 不增加 CLI flag、settings schema 属性、
运行时 setter、child model 环境变量或 channel 容量环境变量。

环境值先去掉首尾空白，再要求十进制数字且为 1–256 的整数。空串、纯空白、0、
负数、小数、指数或十六进制写法、NaN、Infinity，以及大于 256 的值均使启动失败。
嵌入调用的数值选项必须是同范围的安全整数。有效的显式选项会绕过优先级更低的
无效环境值。

在 `workspace-inputs.ts` 附近使用小型纯解析函数。`runQwenServe` 从既有冻结的
`daemonRuntimeBaseEnv` 中解析，在准入和发布监听器之前完成，然后把数值传入
server、路由和 store 写入。直接调用 `createServeApp` 时，如果没有传入已解析的
选项，则使用既有启动环境快照和相同解析函数。不修改模块常量或 `process.env`；
同进程的两个嵌入 daemon 必须保持独立。

将该 key 加入 `PROJECT_ENV_HARDCODED_EXCLUSIONS`，同时测试项目 `.env` 和项目
`settings.env`。运营方的启动环境或既有可信 home 环境机制可以提供该值。
Secondary overlay、trust 变化和后续环境修改都不能调整正在运行的 daemon 容量。

### 3.2 所有准入消费者

复用既有身份检查和 reservation 计数。将解析值传入显式启动校验、完整持久化合并、
两处 owned-runtime 准入、scratch 创建、普通动态注册、transient-to-persisted
promotion，以及 store 锁内 add 检查。Primary 和用户 scratch runtime 均计数。
保留内部 Live Conversation 豁免及其独立的资源统计。

Store 添加必须显式接收解析后的上限，包括注入的 store；store 不得读取环境或
静默使用不同上限。Read、remove、rename 使用结构上限，不受该准入值限制。
独立 store 添加默认支持含 primary 在内的 256 个注册；每条生产路由仍必须
传入该 daemon 的解析值。

直接 `createServeApp` 调用必须按相同的非内部身份计数，拒绝初始注册表已超过
所声明上限的注入情况，不能静默删除条目。幂等重新添加不消耗新名额。
正在构建或移除的名额仍遵循既有 reservation/drain 规则，不能忽略未完成工作
而放入另一个 runtime。

## 4. 全局 session 策略

注册容量不等于按比例增加运行 session 的许可。生产入口 `runQwenServe` 采用：

| 解析后的注册上限 | 显式 `maxTotalSessions` | 提议的总 session 上限                                                                |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| 1–25             | 未提供                  | 保留当前行为：一个启动工作区时不限制；多个工作区沿用每工作区上限的乘法及无限值语义。 |
| 26–256           | 未提供                  | 默认固定为 **800**，不随启动数量或后续注册变化。                                     |
| 任意             | 已提供                  | 尊重显式值；0 和 Infinity 仍禁用总上限。                                             |

默认注册容量 256 会选择固定 800 个 session 的策略，即使只有一个启动工作区。
历史阈值 25 必须独立于注册默认值。

800 将旧 25×32 默认总量保留为独立的扩容默认值，不由新的注册上限或 child model
推导。显式每工作区上限仍控制各 bridge，但不再放大新的默认总量；即使每工作区
显式设为无限，扩容默认总量仍为 800，除非另外明确禁用总准入。
运营方可使用既有 `--max-total-sessions` 设置适合部署的更低上限。
800 是兼容性上界，不是实测证明内存安全的并发目标。

在启动合并后、共享准入控制器构建前解析一次。`runQwenServe` 创建的所有 primary、
secondary、scratch 和内部 Live Conversation bridge 均保留该 admission callback。
不新建第二套控制器，不在注册时重新计算上限。

底层 `createServeApp` 保留既有注入 bridge 契约：嵌入方提供匹配的 bridge 准入和
`maxTotalSessions`。它无法为外部已经构造的 bridge 补装准入。
只有 `runQwenServe` 推导生产默认值；底层嵌入不能仅因注册配置大于 25 就宣告 800。
文档须说明该区别并测试显式提供的上限，不能把数值选项当作注入 bridge 已经
执行强制准入的证据。

## 5. Store 格式、启动与降级

### 5.1 结构上限与原子写入

保留 schema version 1。结构读取上限提高为 255 条 secondary，字节上限提高为
**8 MiB**，均独立于配置的准入上限。路径最长仍为 4096 个 UTF-16 units，display
name 最长 256。JSON 转义可能使每个 unit 占六字节；仅增加条目数、保留 256 KiB
会导致文件写入成功后下次启动却无法读取。

只读序列化探针使用 256 条最大长度路径与 255 个最大长度的转义 display name，
得到 6,687,308 bytes。这验证 8 MiB 的格式容量依据，不代表文件系统支持这些路径。
原子写入前只序列化一次，并按相同上限检查 UTF-8 字节长度。保留有界读取、
no-follow 身份检查、权限、进程内锁/文件锁、锁所有权和 committed-error 行为。

锁内 add 在添加新记录前，要求已保存 secondary 数小于
`maxRegisteredWorkspaces - 1`；重复添加保持幂等。失效或别名记录在被 forget
之前仍占存储名额，即使实际激活的 runtime 身份更少。已有且符合结构限制的快照，
即使超过当前运行准入上限，也必须仍能读取、移除和重命名。

### 5.2 完整合并后再拒绝溢出

继续 canonicalize 显式路径，拒绝显式重复和嵌套。恢复有效保存路径时保留既有的
保留路径、缺失路径、嵌套路径跳过规则。合并 canonical 别名，并按现有优先级保留
全部 registration ID 和 display name。完整有效合并后再检查容量，不在第一个
满额位置截断。

合并数量超过配置时，在 runtime/监听器发布前失败，报出数量、上限，以及恢复
旧上限后减少注册的操作方法。Store 字节不变。检查应放在既有宽泛 store-read
catch 外，或使用独立容量错误并重抛，否则仍会落入旧的 explicit-only 回退。

这有意改变此前“跳过额外有效保存记录”的溢出行为，包括运营方显式选择 25 的情况。无关的损坏格式/身份错误处理维持现状，失败的 mutation 不能覆盖
无法读取的 store。

数量上限错误统一映射为 `409 workspace_limit_reached`，包括临时 runtime
构造后的持久化失败。失败时 dispose 临时 runtime 并释放 reservation。
字节上限使用独立的 `409 workspace_registration_store_too_large`，保持文件不变；
不能误报为 runtime 名额已满。

### 5.3 降低配置与回退版本

降低上限前，用新版本和旧上限运行，remove/forget 足够多的注册，并按需减少显式
`--workspace` 参数或嵌入 workspace 数组，再按较低上限重启。Forget 保存记录不能
移除显式启动工作区。如果降低配置后已经无法启动，临时恢复之前的值即可处理。读取器独立于
准入上限，因此缺失/嵌套的历史记录仍能列出并 forget。不需要新增离线清理工具。

降级到 P1 之前的版本前，备份 store，用新版本将其缩减为
**最多 24 条 secondary 且最多 256 KiB**，停止 daemon，再启动旧版本验证恢复。
长路径或含转义字符的路径不能仅检查数量。移除注册不得删除工作区文件或 transcript。

旧版本读取扩容文件时会告警并仅启动显式工作区；其锁内 mutation 会重读并在覆盖
文件之前失败。这也会阻塞注册 list/forget/persist，且 runtime 删除会访问 store，
因此连 transient runtime 的删除都可能被阻塞。恢复方法是重启新版本，不能把部分
恢复当作降级成功。提升 schema 版本也不能让旧读取器理解额外记录。

## 6. 保留有界的 channel 事务

保留现有 SDK 默认 2,130,000 ms 及 worker 启停 deadline。新增独立的 channel
控制工作区守卫 25，使用 channel 自身用于计算超时的同一个常量。
若跨包共享需要 export，则导出这项 channel 专属策略，绝不复用已 deprecated、
注册语义不明确的 `MAX_DAEMON_WORKSPACES`。

初始分组最多包含 25 个唯一 owner。Reconcile 时，当前 entries、为恢复保留的
group 和有效候选 owner 的并集最多为 25。存在构造重叠时计入 pending ownership；
在既有串行 manager/group 生命周期内、创建 supervisor 或停止 worker 前检查。
`forceWorkspaceCwd` 使用实际的局部替换拓扑，并包含保留的其他 owner。

仅检查目标数量不够。正常的不重叠 old25→new25 替换仍符合旧事务公式：两轮
25×(12s 停止 + 30s 启动)，加 30s 客户端余量。但清理失败会在 group Map 内
同时保留新旧 entries，下一次事务可能超过 25。并集守卫阻止这条扩容后新可达的
累积路径。

Owner 集合满额时，迁移到新 owner 之前，必须先成功执行从 selection/recovery
移除旧 owner 的操作，或成功 stop-all 再设置新 selection。暂时 drain、仍保留
恢复能力的 owner 继续占名额。不自动停止无关 worker 腾出容量。
Stop、remove 和 shutdown 始终可用于清理。Reconcile/stop 失败后，仍保留在现有
entries/recovery map 中的 owner 继续计数。保留既有 permanent-removal 和 force-kill
语义：它们可能在清理报错时仍解除 ownership。该守卫限制受跟踪的控制/恢复 owner，
不能证明 OS 进程已经退出。不引入第二套容量 registry，也不把失败的移除操作作为
推荐的迁移方法。

覆盖启动预检与 runtime 分组、initial start、set、enable、reload、qualified
reload、注册/trust refresh 和 restore。扫描全部注册工作区来判断 owner、歧义
与 trust，不能只看前 25 个。在 lease/supervisor/生命周期副作用前拒绝容量扩张。
具体而言，仅在 named 启动选择且注册工作区超过 25 个时，将 owner-count 预检放在
boot lease reservation 之前。更小集合不可能超出 owner 上限，保留既有校验/清理时机，
并为所有启动路径保留后续 runtime/trust 校验。Manager selection 在解析完成后、`reserve()`
之前检查初始 owner 数。仅在 group constructor 检查太晚，因为 manager 已先 reserve。
已有 group 在 `reconcile` 内、`createEntry` 循环前计算有效并集；restore 同样在
`createEntry` 前检查。

让 `channel_control_workspace_limit_reached` 保持独立错误，穿过 manager 的
`classifyFailure` 和 group-constructor 错误包装，再由两套路由映射为 409。
在普通 start/stop 分类前识别该特定容量错误，不改变无关错误映射。

该守卫限制 channel 控制与恢复 owner 集合，不限制 ACP child 数或物理进程内存。
既有请求队列等待仍无有限保证：旧超时对应单次事务预算，不能承诺任意并发调用
都在各自 deadline 前完成。

不将 channel settings 改成跨工作区事务。离线配置和启动选择仍可持久化。
当前 active upsert 先保存再 reload，reload 失败可能记录 diagnostic 而保存仍成功。
Runtime-added refresh 同样可能在注册成功之后失败。保持并测试这些区别：
保存或注册成功不能证明 channel 已成功启动。

## 7. API 所有权与兼容性

| 接口                                                              | 所有权与 P1 改动                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /capabilities`、`GET /daemon/status`                         | Process-global。增加 `limits.maxRegisteredWorkspaces`；标准 `runQwenServe` 在 bootstrap 和完整运行期间均声明 `maxChannelControlWorkspaces=25`，不依赖 worker 是否已启动；自定义嵌入仅在 control/management callback 确实执行同一守卫时声明，boot/full status 保持一致。 |
| Capabilities 中的 session limits                                  | Process-global。扩容模式即使只有一个工作区也声明提供的 `maxTotalSessions`，不等待第二个注册项。                                                                                                                                                                         |
| `POST /workspaces`、scratch/owned publication                     | Process-global 注册准入；canonical identity、trust、runtime 环境和 reservation 保持。                                                                                                                                                                                   |
| `/workspace-registrations` list/forget                            | Persisted-workspace scope；结构读取上限独立于活动 runtime 数。                                                                                                                                                                                                          |
| Workspace runtime delete 和 display-name 修改                     | Selected-runtime 及其关联的持久化 registration ID；保留 drain、rollback 和 committed-write 规则。                                                                                                                                                                       |
| `PUT/DELETE /workspace/channel`、`POST /workspace/channel/reload` | 路径虽形似 legacy，但为 process-global；在生命周期代码中执行 channel owner 守卫。                                                                                                                                                                                       |
| `/workspace/channels/:name/...`                                   | Legacy-primary management；保留 primary 所有权。                                                                                                                                                                                                                        |
| `/workspaces/:workspace/channels/:name/...`                       | Selected-runtime management；精确 owner、trust 和环境检查继续必需，不能回退 primary。                                                                                                                                                                                   |

以 additive 方式扩展 daemon 和 TypeScript SDK 的 capability/status 类型，
不提高协议版本。旧客户端忽略新字段，新客户端将字段缺失视为未知，使用服务端
准入响应。Java 原始 capability map 保持兼容。不需要新增 UI 控件或超时协商。
既有 SDK 显式 deadline 和 `timeoutMs: 0` 保持原义。

## 8. 交付拆分与影响范围

分为三个可评审增量，只有最后一个开放扩容：

1. **Channel 边界：** group/manager 守卫、启动预检和错误映射、additive capability，
   以及 rollback/degraded 状态测试。验证完整的 25-owner 转换后，才能继续依赖
   不变的 SDK 超时。
2. **Store 准备：** 结构数量/字节上限、写前字节校验、完整启动合并/溢出失败、
   降低配置/降级文档与测试。此增量期间注册准入仍为 25。
3. **注册扩容：** 默认 256、resolver、运营方环境处理、嵌入显式选项、所有准入/store
   消费者、扩容默认 session 总量、capabilities/status、文档和目标主机 E2E。

这些可以是 commits 或独立 PR，但扩容必须依赖前两个增量。默认 256 是本次要求的
策略；部署资源限制仍需要真实负载证据。如果要支持不先释放旧 owner 的不重叠 channel 迁移，需要另行设计
degraded recovery，不能简单放宽并集守卫。

预计生产改动涉及 `workspace-inputs.ts`、`run-qwen-serve.ts`、`server.ts`、
`types.ts`、`daemon-status.ts`、registration store/routes、
`config/shared-env-keys.ts`、channel group/manager 及路由映射、channel timeout
policy，以及 SDK capability/status 类型。同步 daemon 协议/配置文档和相邻测试。
现有 session admission 机制应无需新增算法。

## 9. 验证与尚缺的部署证据

可执行计划和全局 dry-run 结果单独记录在
`.qwen/e2e-tests/workspace-capacity-p1.md`。本次 dry-run 展示实现前的缺口，
不验证提议行为，也不把历史测量变成当前生产 benchmark。2026-09-09 对全局有效
CLI 0.23.0 执行五组隔离运行，确认提议变量会被忽略：2 仍允许注册第三个，256
仍拒绝第 26 个，abc 仍正常启动。未设置变量时，启动两个工作区声明总 session
上限 64，动态增加第二个则声明 null。五个 daemon 均正常退出并释放端口/进程组。
这个较旧的全局 binary 与 main 源码基线不同，仅证明实现前的缺口。本地 0.23.1
实现已通过七组 E2E，覆盖 256/257 注册、255 条命名持久化记录及重启、降低上限时
拒绝启动且文件不变、旧读取器 mutation 保护、无效配置、项目环境隔离、scratch
及最后名额竞态、显式 session 上限覆盖。Channel 生命周期与回滚边界使用 fake
supervisor 单测验证；真实 provider channel 运行仍属于独立的部署验证。

验收必须覆盖配置来源/优先级、全部准入入口、最后名额竞态、256/257 边界、
带别名/名称的持久化 round-trip、拒绝时文件 hash 不变、新旧读取器降级、
全部 owned bridge 类型的 session reservation，以及前述 channel 恢复场景。
单测在各 package 内运行；测试改动后的本地 binary 前完成 build/typecheck/bundle。

部署验证另需覆盖 Linux/容器限制、真实 Git 仓库、FD/watcher、启动及列表/Git
延迟、完整默认 10 分钟 keepalive 周期、重复注册 churn、启用的 cron/channel，
以及 Web Shell/SSE/terminal 行为。注册 runtime 成本与固定活动 child 负载分开统计。
全局 800 session 默认值不提供内存强制限制。

仍需证据才能决定的是各部署资源阈值，以及实测 runtime 成本是否值得引入 LRU。
P1 契约明确选择：一个环境变量、默认值与上界均为 256、注册容量大于 25 时默认
session 总量 800、启动溢出明确失败、有界 channel ownership，以及有文档说明的
降级流程。默认值变更在 `.qwen/e2e-tests/workspace-capacity-default256.md` 中单独验证；
此前默认 25 的结果保留为历史证据。
