# Settings 服务

`src/settings` 与 `src/resource` 平级，共用 Resource 包。CLI 的 MCP、plugins、skills、hooks 子命令通过 SettingsService 获取独立配置；包括 agents/skills list；会话与命令统一取得 LoadedSettings。

- `SettingsService` 负责文件读取、兼容处理、校验、默认值、合并、项目可信度及环境变量处理；不得反向依赖 CLI/Core，不注入 SettingsLoader。
- 产品可以通过构造参数 `{ schema, validation }` 提供既有的字段定义和 Zod schema。这是共享的规则数据，不是加载器；完整字段定义与 Settings/MergedSettings 类型在本目录 settingsSchema.ts 中统一维护，CLI 仅注入品牌、模型等宿主默认值。未配置产品 schema 时仅提供基础字段默认值，不承诺完整字段校验。
- `createSettingsSchema` 的 `SettingsSchemaDefaults` 由宿主传入模型请求默认总尝试次数 `DEFAULT_CHAT_MODEL_MAX_ATTEMPTS`；schema 默认值及重试说明使用该参数，不在 Resource 包重复定义产品预算。
- 宿主通过 `configureDefaults` 提供 defaults 与校验器工厂。服务调用可覆写的 `getSchema(defaults)` 组装缺省规则。`getDefinition()` 返回实际采用的 schema 与 validator，供宿主的其他校验入口使用。
- `SettingsService` 私有持有 SettingsSourceStore；文件源、持久化、写事件和相关测试均在 `src/settings/`，不再归 ResourceService/UserResource/ProjectResource/ResourceWatchBridge 管理。user 在进程宿主持有的 Service 内一份，project/local 按实际文件路径成组复用，不按 trust、来源或 workspace context 分叉。
- `initialize({ userConfigDir, projectConfigDirName? })` 首次经 UserSettingsSource 读取 `<userConfigDir>/settings.json`，只保存 source 和独立初始化 metadata，不复制 ReadResult 内容。项目配置目录名默认为 `.qwen`。同目录重复初始化不重读，切换任一目录报错；raw API 已绑定不等于已 initialize。configureDefaults(definition, context) 独立补齐缺少的产品规则，构造时及已有规则优先；目录初始化前后均可调用。initialize 用 userSettingsPath 保留宿主已绑定的完整用户文件路径；isInitialized 只表示目录已固定，不能据此跳过 CLI 规则装配。
- `resolve({ projectPath, sources?, flagSettings? })` 返回独立的 LoadedSettings，包含 user/project/local/flag/merged/errors/isTrusted；forScope(user/project/local) 返回对应文件层，兼容旧 CLI 的 User/Project/Local 名称，不合并、不重读文件。
- projectPath 是项目根目录；Service 根据初始化时固定的配置目录名推导 settings.json/settings.local.json，缺失时不回退 `.qwen`。CLI 从 Storage 的有效配置目录计算相对目录名，以兼容目录覆盖。
- sources 默认 user/project/local，空数组排除三个磁盘层，未知 source 忽略。命令的 project/local 每次 invalidate 后经 source.read 重读；会话由 refreshProjectSources: false 保留文件源 TTL，user 每次解析共享 source.read 的文本（10 秒 TTL），随 watch、显式失效及写事件更新，不再永久冻结初始化内容。flagSettings 统一接收配置对象或文件路径（相对路径基于 projectPath），读取保持独立，不受 sources 和项目 trust 限制。
- headless/environment/homeDir 放在构造函数第二个参数中（headless 可为读取当前启动模式的函数），作为实例级运行上下文；不添加进程级全局状态，也不为尚未迁移的会话预先增加覆盖接口。homeDir 默认使用 OS HOME，CLI 初始化入口传入产品生效的 HOME，兼容 CLI_HOME 覆盖。
- 支持 JSONC/BOM。普通配置读取问题返回 warning，显式请求的 flag 文件读取/最终校验失败抛错。校验跳过无效 MCP 条目、恢复可忽略的字段，保留其他合法配置。
- 信任只由 user 配置及 host 传入的 headless 状态确定；项目不能通过自身设置授权自己。未信任时不合并 project/local，显式 flag 仍生效。Service 负责 HOME 目录来源保护，比较实际目录身份（含符号链接及平台大小写），HOME 下的普通子项目仍正常加载。
- 合并顺序为 schema 默认值 < user < 可信 project < 可信 local < flag，采用 schema 的字段合并规则。返回对象相互隔离，不写回兼容修正。
- Settings 中环境变量在读取 `.env` 前展开，hooks 保持原始占位符。仅当传入 environment 时才加载 `.env` 到该对象；仅在 project/local 至少启用一个、非 HOME 且 isTrusted 时考虑项目配置目录 `.env`，用户配置目录 `.env` 为唯一回退（包括 sources 为空时），不遍历父目录或普通项目 `.env`。已有环境变量优先，完全跳过不可信项目 `.env`，禁止注入产品归因字段；flag 不得提升环境加载的项目可信度。dispose 不撤销宿主环境变更，独立命令由进程退出清理；多会话调用应传独立环境对象。
- 返回对象支持按 user/project/local scope 执行 mutateScope、setValue、deleteValue、updateValue。复用本目录既有带锁重读和原子写入；写后仅更新本次触碰的运行时字段，再计算 merged。写事件更新共享 source 原始文本（无变化事务也更新），实际写盘变化才扇出通知及触发 onSettingsPersisted，其他已返回对象保持独立。写后 originalSettings 仍保留规范化形状，不改变磁盘旧格式；重算 merged 时同步重新计算 user 配置决定的 isTrusted。无变化操作仍返回成功。
- 被 sources 排除或 HOME 保护的只读层，沿用旧实现的仅内存修改行为，不落盘。flag 不提供写入 scope。写入错误返回 false，并通过宿主 onWriteError 回调反馈；实际运行时值变化通过 onSettingsChanged 回调交给宿主。
- raw API 可在 initialize 前使用：getUserSettingsSource(path) 固定用户根；getCompatibleUserSettingsSource(path) 首次绑定，根不同返回 undefined；peekUserSettingsSource(path?) 不绑定，可选路径不匹配返回 undefined；getProjectSettingsSources(projectPath, localPath) 取得共享文件源。watchFiles(paths, listener)、takeWatchUnavailableWarning()、invalidateAll() 均委托私有 store，不暴露 store 实例。
- requestDispose(): Promise<void> | undefined 立即拒绝新获取/resolve，有活动订阅时延迟 store 清理至最后一份订阅退出；dispose(): Promise<void> 直接关闭 store。已返回快照仍可按既有契约写入。文件源和写观察者全局注册表使用 WeakRef；无 watch 的独立命令实例不持有活动句柄，无需显式 dispose 即可 GC。有 watch 的宿主须释放订阅并管理关闭；不在 Service 共享会话 context 或采用状态。

CLI 的 `createCliSettingsService` 组装共享 schema、运行上下文和目录并初始化 user 快照；`resolveCommandSettings` 在其上处理独立子命令的来源和兼容约定。已有只读命令也可显式传项目路径、来源及 flag 给 resolve。这些命令创建 Service 前用 restoreLoadedEnvironment 撤销命令发现阶段的旧 .env 注入，防止绕过来源/信任筛选；宿主已有值保持不变。

迁移新子命令时补充其行为测试，不能将当前验证范围当作旧 LoadedSettings 全部方法的替代。Windows/Linux 未实测时须说明。

`LoadedSettings` 是唯一解析结果类，拥有分层状态、快照、实例订阅、写事务与 watcher 候选采用流程。SettingsService 构造它，并为首次解析、写后重算及 reload 提供共享校验与文件读取规则。resolve 不自动开启 watcher；显式 reload 保留 flag，绕过 ConfigChange Hook，watcher 仍走宿主候选采用流程。

`reload({ rejectInvalid: true })` 在任一磁盘层读取被拒绝时抛错，并保留全部旧层和快照；用于需要保留上次有效运行时配置的显式刷新。默认 reload 的警告恢复行为保持不变。

CLI 的同一个 createCliSettingsService 工厂供 Framework、独立命令与独立 ThreadManager 使用。CLI 只传入完整 schema、兼容规则和事件/日志副作用，不传入文件加载器。会话保留原有 merge、主题转换、弃用字段迁移、信任采用与进程 .env 策略；命令保留原有来源/信任限制的 .env 策略及写后信任重算。agents/skills list 采用会话兼容投影，但仍使用命令 .env 策略。差异通过初始化上下文表达，不维护第二条文件解析链。

CLI 负责把启动/会话 sources 和 flag 默认值解析为显式 resolve 参数；Service 不访问 CLI 全局 argv。createLoadedSettings 仅保留已有预加载对象/测试装配用途，不读磁盘。不存在 ResolvedSettings、snapshot 转换或独立的 settingsMutation 实现。

Settings 的嵌套配置字段仅描述数据结构；Core 的领域类型、模型传输、MCP runtime 与 OAuth 等实现不迁入 Resource。

CLI 工厂记录每个实例的环境/投影策略；同策略可重复使用，command/session 等策略不匹配时须在修改规则前拒绝，不能通过 configureDefaults 混用。写后恢复校验保留合法的已修改字段并上报警告，不能因无关字段超过恢复上限而将整个运行时层清空；初次读取和 reload 的坏文件拒绝策略不变。
