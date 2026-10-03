# 并行扩展加载

[English](parallel-extension-loading.md) | [简体中文](parallel-extension-loading.zh-CN.md)

## 问题陈述

扩展加载此前是串行的：逐个扫描每个扩展，再逐个扫描每个扩展的
commands/skills/agents 目录。在安装了较多扩展的机器上，这主导了启动前后的
延迟：进程内基准（`packages/core/scripts/bench-extension-load.ts`）测得
一次完整加载的中位数在本次改动前约为 ~565 ms，改动后约为 ~228 ms。

## 当前状态

加载在三个层级并行，由 `packages/core/src/skills/skill-load.ts` 统一协调：

- **扩展目录扫描** —— `loadExtensionsFromExtensionsDir`
  （extensionManager.ts）通过 `scheduleWithConcurrency` 以
  `EXTENSION_SCAN_CONCURRENCY = 8` 将各扩展并发调度。该层自身不打开任何
  描述符，只负责调度各扩展的加载。
- **每个扩展的子资源** —— 每个扩展内部的 commands（递归 `readdir`）、
  skills、agents 与 workflows 并发加载。skill/agent/plugin 的清单读取器经由
  `mapWithConcurrency`，每次单文件读取都要先从一个模块级信号量
  （`SKILL_LOAD_CONCURRENCY = 8`）取得许可，因此无论各层如何嵌套，
  在途清单读取的预算都由所有受控加载器共享。8 相对 64 实测无墙钟损失
  —— 默认 4 线程的 libuv 线程池本来就是真正的瓶颈。
- **settle 契约** —— 两个辅助函数都把每批条目跑在
  `Promise.allSettled` 上，待整批 settle 后再重抛第一个原始拒绝原因，
  因此单个条目失败不会在兄弟条目执行途中将其抛弃，且重抛的错误保留其
  `code`，供下文的 fail-closed 分类使用。结果按索引槽位写回，因此无论
  完成顺序如何，各加载器都按 `readdir` 顺序返回条目（扩展 agent 会喂给
  一个按未限定名 first-wins 的去重逻辑，所以顺序是可观测的）。

### 不叠加规则

任何层级都不得在持有 gate 许可的同时嵌套获取其他受控工作的许可：一旦
某个兄弟条目失败，被遗弃的许可持有者会不断堆叠，直至耗尽模块级池，
后续所有加载永久挂起（wedge）。这正是扩展目录扫描使用不取许可的
`scheduleWithConcurrency`、而只有叶子级清单读取获取许可的原因。回归
测试用反复失败的扫描（扩展根目录下的悬空符号链接）验证池在此之后
仍能接纳新工作。

### 资源耗尽时 fail-closed

在较低的 `RLIMIT_NOFILE` 下（持有管道/套接字的常驻守护进程、容器、
系统级 ENFILE），读取会在扫描中途以 `EMFILE`/`ENFILE`/`EAGAIN`/
`ENOMEM`（`isResourceExhaustion`）失败。这些 errno 会被重抛——而不是
像解析失败一样被吞掉——在每个曾经吞掉它们的入口：各单条目加载器、
每个加载器的目录枚举（含 commands 枚举）、每扩展 manifest config
读取、hooks sidecar 读取、扩展根目录的 `readdirSync`、
install-metadata sidecar 读取、`loadExtensionWorkflows`（含其候选路径与
逐文件 stat 分支）、Agent Plugins 的 `mcp.json`
读取、加载路径上的存在性检查（manifest、上下文文件、hooks、按名加载的
扩展根目录检查——`fs.existsSync` 会把所有 errno 折叠成 `false`，因此这些
地方改用一个基于 `accessSync`、会对资源耗尽重抛的变体），以及
`loadExtension` 的兜底 catch。refresh 随之拒绝，既有缓存与指纹基线保持不动，下一次
`refreshCacheIfSourcesChanged` 会重试——而不是把一个被截断（或为空）的
扩展集提交并盖上"已是最新"的戳。

`Config.initialize` 在启动前段和后段各刷新一次扩展，均通过辅助方法处理：资源
耗尽先重试一次，仍失败则使用先前完整的缓存（冷启动时为空）继续，而不是
中止初始化。若首次刷新放弃、最终启动刷新成功，继续初始化前会重新同步
hooks 和 skills；同步失败则初始化失败。启动之后的 refresh 仍保持上述
fail-closed 语义。

Executor refusal 与已提交的运行时缓存分开保存。声明了无效
`executor`/`executionBackend` 的文件会在 `extension.agentExecutorRefusals`
中记录拒绝；加载器在抛出错误之前按 `readdir` 顺序合并记录。每次 refresh
还使用独立的尝试记录表。扫描或 store 初始化失败时，拒绝回调在持有
store 锁期间，将选中扩展的记录合并到管理器的 pending map 中。按名刷新会
等待所有在途兄弟任务结束后再合并，并排除未请求扩展的记录。

失败的 refresh 不发布任何新的运行时条目，包括已经成功加载的兄弟扩展。
原缓存保持不变；不再生成会被命令加载器、激活操作或其他消费者误认为
已加载扩展的失败扫描 tombstone。`SubagentManager` 通过已有回调读取
pending refusal，即使冷缓存也会拒绝按名回退。回调会过滤已提交且未激活
条目的记录，使禁用扩展不再阻止内置 agent；没有缓存条目的记录仍然拒绝
分派。重新启用条目时，保留的记录会再次生效。拒绝路径不需要读取激活快照。

成功的 refresh 保留被跳过扩展和不完整 agent 扫描的拒绝记录。完整且已提交
的 agent 扫描只取代该扩展的 pending 记录，按名刷新和安装/更新后的重新
加载也遵循此规则。卸载删除该名称的记录；完整刷新还会删除安装目录已确认
不存在的记录。目录不可读和 `ENOTDIR` 不代表扩展已移除。Pending 状态不跨
进程重启持久化。

只有显式的运行时刷新才会初始化运行时缓存，即使首次扫描失败、缓存仍为空。
安装/更新可以替换该缓存中的条目，但不会初始化它。因此，主动跳过扩展加载的
模式在安装后仍保持隔离；目录查询也不会修改运行时缓存。普通运行时仍可在
首次扫描失败后，通过安装完整扩展恢复并取代对应拒绝记录。

Commands 遍历按当前路径的祖先链记录符号链接目标：指向同一目录的不同
别名都会被列出，同一路径上的重复目标则终止循环。Plugin manifest 的路径
解析与文件读取一样传播资源耗尽错误。

### 描述符预算之外

gate 只约束清单回调的准入数。commands 的递归 `readdir`（单次 libuv
线程池遍历，无 worker 调节项）、同步的 config/hooks 读取、
`loadExtensionWorkflows`，以及受管技能加载器
`SkillManager.loadSkillsFromDir`（skill-manager.ts）都在其外。

## 约束与风险

- `mapWithConcurrency`/`scheduleWithConcurrency` 按批 settle，因此一次
  拒绝要等待在途最慢的兄弟条目（队头阻塞）。滑动窗口 worker 池是已知
  的改进方向，留作后续。
- 受管的 `SkillManager.loadSkillsFromDir` 仍是无界 `Promise.all`；将其
  纳入 gate 不在本次改动范围内。

## 验证

- Gate 上限：40 个扩展 × 24 个技能跑完整 refresh；gate 准入峰值 ≤
  `SKILL_LOAD_CONCURRENCY` 且 > 1，无截断。
- Wedge：反复失败的扫描（悬空符号链接）之后池仍能接纳工作；恢复后
  每个条目的内容都被完整加载。
- Fail-closed：在每个入口注入 EMFILE（skill 读取、agent 读取、
  plugin-skill 读取、plugin `readdir`/`statSync`、扩展根目录
  `readdirSync`、install-metadata sidecar、workflow 读取/列目录）都会
  使 refresh 拒绝、保留既有缓存，并在故障清除后重试成功；"部分幸存"
  fixture 钉住：即使有兄弟条目幸存，加载也不会以被截断的结果成功返回。
- 顺序/refusal：完成顺序倒置的 fixture 钉住按 `readdir` 顺序返回的结果，
  以及确定的"readdir 顺序靠后者胜出"的 refusal 归属。
- 基准：中位数 ~228 ms（基线处为 ~565 ms）。

## 验收标准

- 完整加载中位数保持在 ~228 ms 基准数字或更低。
- 资源耗尽时没有任何加载会提交被截断或为空的扩展集；每个 fail-closed
  入口都有一个回归测试，在移除其重抛时变红。
- Executor refusal 在 refresh 失败期间仍然拦截分派，包括冷启动，且不发布
  部分加载的运行时条目。
- 失败尝试只合并被请求名称的记录。完整且已提交的重新扫描及明确移除会
  撤销旧记录；被跳过或不可读的扫描保留记录。Store 初始化失败遵循相同的
  拒绝保证。
- 命令别名仍然可见，符号链接循环能够终止。

## 待决问题

- 用滑动窗口 worker 池替换按批屏障（见"约束与风险"）。
- 暴露可重置的 gate 峰值，使上限测试能断言 gate 确实被打满，而非仅仅
  不超上限。
- 将受管的 `SkillManager.loadSkillsFromDir` 纳入共享 gate。
