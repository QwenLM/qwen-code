# Daemon extension Skill 目录

[English](daemon-extension-skill-catalog.md) | [简体中文](daemon-extension-skill-catalog.zh-CN.md)

本设计实现 #11274 的第 2 阶段。此前 daemon 本地 workspace Skill provider
提供空的 active extension 列表，因此没有 child 快照时，首次响应缺少已安装
extension 的 Skill。

为选定 workspace 使用不绑定运行时 Config 的 `ExtensionManager`，通过现有
store 一致性读取加载扩展。将 active extension 交给 `SkillManager`，保留
project > user > extension > bundled 优先级。将 inactive extension 的 Skill
作为管理条目追加，使用既有 `inactive_extension` 状态，保留身份和元数据。
设置、extension Skill 默认值与覆盖沿用现有解析器。settings 显式启用不会启用
inactive 父扩展。

每个 extension 的 Skill 默认值来自其自身 manifest；workspace Skill 覆盖来自
加载扩展时使用的同一份 store 一致性快照。按已加载 extension 对象和归一化
Skill 名称缓存布尔结果，避免通过冲突 ID 再次选错 owner。这不新增身份命名空间，
也不修改 store 策略。显式启用与 settings 硬禁用保持原有优先级。

每次响应通过现有语言设置和 locale helper 解析本地化扩展名，不修改 daemon
进程语言，也不因单独的语言变化重建目录缓存。

保持轻量 Config 接口：不构造运行时 Config、不启动 child、不初始化 MCP、
不执行 hooks、不安装 watcher。遵守 safe mode、发现层级禁用及 workspace 信任
规则；未信任目录的静态盘点不加载 workspace 设置或 extension 运行时上下文。
目录读取失败继续返回未初始化错误状态。

实现与相邻回归测试位于 daemon 本地 provider。测试覆盖真实 manifest、
active/inactive 状态、来源冲突、持久化 Skill 设置、safe/untrusted 上下文及
显式缓存失效。E2E 使用隔离 home 和无 child 会话的 daemon。

本阶段 facade 仍优先使用 child 快照。替换来源、修改开关或刷新语义、增加配置
状态字段及修改 Web Shell 投影属于后续 PR。不修改公共响应 schema。

发现层级禁用通过 `SkillManager` 隐藏 active extension Skill；与 child producer
一致，仍追加 inactive extension 管理条目。safe mode 和未信任上下文不加载扩展。

extensions 根目录不存在代表空目录，不创建 extension store。根目录存在时，
通过共享 store 协调读取：缺失或发生漂移的 store 在独占锁内初始化，写入
`extension-store/state.json`、生成 `state.previous.json` 回滚副本，并写入旧格式
`extension-enablement.json` 投影。命中缓存时复用已加载 manager；后续重建仍会
获取锁，即使策略未变也可能维护目录与权限。

不可读根目录和共享 store/loader 抛出的错误返回 `initialized: false` 及明确
错误。该失败有意影响整份目录：例如一个悬空 extension 目录条目会使 project、
user 和 bundled Skill 一同不可用，直到制品被修复。单个制品的处理仍由共享
loader 决定：损坏 manifest 被跳过并记录其诊断，悬空条目则向外抛错。本阶段不
增加逐制品诊断或逐层降级，不修改 loader 失败策略。

现有 facade 缓存、来源优先级及失效行为不变；跟踪 issue 将缓存生命周期和并发
改造安排在第 4 阶段。

**评审中记录、明确不在本阶段实现的后续事项：**

- 相邻 `/workspace/extensions` 路由调用 `loadSettings` 时未设置
  `skipLoadEnvironment`，workspace `.env` 的 `QWEN_CODE_LANG` 可能使其语言
  解析与本 provider 不同。
- inactive 条目追加及排序与 child producer（`acpAgent.ts`）存在重复。这里按
  extension 分别对 Skill 名去重，与字符串 `level:extensionName:name` key
  提供相同的来源区分，并未使用该字符串 key。
- extension 变更没有失效本阶段填充的 config-catalog provider，因此安装、更新、
  启停或卸载提交后，skills config 路由可能保留旧状态，直到无关 Skill 变更、
  workspace 移除或重启。失效接线与 `refreshCacheIfSourcesChanged` 重新验证
  属于第 4 阶段。
- active Skill 的 `enabled` 判断沿用 `Config.isSkillEnabled` 的规则，尚未共享
  判定实现。
- 共享 store/API 的重复 extension ID 处理另行跟进。本 provider 从各自 manifest
  保留默认值，不通过歧义 ID 查询 owner；workspace 覆盖仍使用 store 的 ID key。
