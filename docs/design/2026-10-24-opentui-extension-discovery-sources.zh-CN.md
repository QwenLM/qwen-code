# OpenTUI 扩展发现与来源管理

[English](2026-10-24-opentui-extension-discovery-sources.md) | [简体中文](2026-10-24-opentui-extension-discovery-sources.zh-CN.md)

实现、验收证据及其范围和未决问题统一记录在 [PR #15671](https://github.com/QwenLM/qwen-code/pull/15671)。下述 E1–E10 仍是最终验收门槛。

## 问题与现有行为

本批之前，OpenTUI 已有 Installed/Discover/Sources 导航，后两项诚实显示不可用占位。Installed 已支持详情、启用、收藏、scope、更新、卸载，应保留。Ink 已通过现有 ExtensionManager、SourceRegistryStore、本地 marketplace 解析、marketplaces.json 持久化、scope 安装和能力确认实现两个缺失 tab。只画 tab 内容仍无法闭合来源配置、权限与磁盘状态。

本批之前的 native dialog mount 仅提供 Installed rows/actions。Ink AppContainer 设置了 consent、setting、marketplace-choice handler；审计未确认 native 获取扩展路径有等价接线。Core 默认 consent callback 直接 resolve，因此新增路径不能把该默认行为当作交互授权。

## 目标与边界

完整交付来源到安装流程：配置/浏览 marketplace，发现/过滤/选择插件，选择 user/project scope，查看真实能力和必需设置，取消或安装，报告已提交警告，刷新三 tab，并重新打开持久状态。包含来源详情/更新/移除和直接扩展来源安装。键盘与真实结果参照 Ink；保留现有 Installed 和共享安装、安全、持久化行为。

不新增 registry、后端 installer、依赖升级、marketplace 框架、全局可变 dialog callback 或自动批准；不拆 tab 半功能 PR。没有 signal 的 source fetch 不声称物理取消网络。既有 npm/standalone/runtime 验收另列。

## 复用服务与 UI

| 层          | 现有入口与职责                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源目录    | ExtensionManager.getSources/addSource/removeSource/markSourceUpdated/loadSource/discoverPlugins；SourceRegistryStore 持久 marketplaces.json 并使既有 discover cache 失效  |
| 来源解析    | extension/marketplace.ts 的 parseInstallSource、loadMarketplaceConfigFromSource；sourceRegistry.ts 构造合法安装来源、清理显示元数据                                       |
| 安装        | ExtensionManager.installExtension(metadata, consent, setting, cwd, previousConfig, activation, signal)，真实 prepare/commit、symlink/trust/network policy、已提交警告身份 |
| 权限 UI     | commands/extensions/consent.ts requestConsentOrFail 加既有 action-modal signal/isCurrent；native 文本/秘密设置及 marketplace-choice 必须完整接线                          |
| Native 外框 | dialogs-extensions 既有 tab、列表窗口、详情、scope primitives；dialog mount 拥有异步状态并复用 Installed rows 重建                                                        |
| Ink 参照    | DiscoverTab/SourcesTab 与 ExtensionsManagerDialog 定义搜索、批量/详情重试、过滤、锁定视图、状态和 footer                                                                  |

Core 值从定义模块直接导入，适当使用 type-only import。不把 Ink Box/Text 或组件树导入 OpenTUI；只有确实减少重复时才共享小型纯函数。

## 用户流程与持久化

Sources 列出直接安装、添加 marketplace 和已配置来源。添加必须是真实 marketplace；单扩展使用既有提示引导直接安装。列表保留每个来源的类型，仅将路径缩短到所在列。详情加载配置与已安装预览，并在有界滚动区域折行显示完整脱敏路径；PageUp/PageDown 访问溢出内容，同时为动作保留空间。Browse 通过已清理的 marketplace filter 打开 Discover。R 键仅重新读取来源视图，不更改 lastUpdatedAt；显式 Update 动作只有在真实非 null 加载后才更新它。移除需要确认，只移除来源，不删除已安装产物。持久化错误显示为错误，不能使 TUI 崩溃。

Discover 提供查询/过滤、光标/窗口、未安装项多选、详情和 user/project scope。Discover 的可输入 j/k 按 Ink 保留为搜索字符，Sources 则用来导航。批量部分失败保留每个真实结果，按 Ink 清除 selection 并回到列表；重试需要明确重新选择，不能自动重试旧项。主页仅允许安全 http(s)。Tab 先清除当前 marketplace filter，再切换。

Discover 安装使用真实 user/project scope picker；Sources 直接安装保持 Ink 默认 user scope。安装显式传每次操作的 consent/settings callback、目标目录与 activation。User 使用 {scope:'user'}；project 使用 {scope:'workspace',workspacePath:capturedTarget}。Consent 通过既有 helper 展示真实 commands、skills、agents、workflows 及变化。设置保留 sensitive 与取消拒绝；marketplace choice 返回实际插件或取消，并保留 Ink 即时 1–9 快捷键，包括更大的列表。不提供空默认值，不绕过 trust，不执行替代 installer。Manager 没有 operation-local plugin-choice 参数：真实 Claude marketplace 解析返回 marketplaceConfig 且缺 pluginName 时，当前 owned CLI choice 必须选中并验证一个真实唯一插件，然后在安装前填现有 metadata.pluginName。Installer 仍重新加载并验证最终来源，并对实际内容请求 consent；预览不能授权安装变更后的内容。不覆盖共享 manager choice handler，也不新增 core callback 端口。

提交后区分成功、已提交但带警告、真正失败。随后 scope 偏好保存或 reload 失败，不能把已提交产物标为不存在。刷新 loaded extensions、现有 Installed rows、Discover installed 标记、来源预览与既有 refresh-required 状态。重开从持久事实重建；服务要求 reload 时不能承诺命令已立即激活。

## 所有权与取消合同

在现有局部 owner 中捕获 dialog request 身份、当前 Config/manager、session 身份、目标目录和一个操作 controller。每次 UI 发布和确认返回都检查 owner。关闭、session 更换、后继操作使其失效。共享刷新沿现有 state 的单调 revision 收尾，UI owner 失效仍能结束自己的事务，却不能结束后继刷新。命令加载发布前复核捕获的 Config/session/target；已销毁 shell 不发布旧命令列表，挂起的启动请求在派发新加载命令前重新检查所有权。不把共享 manager callback 替换成将销毁 dialog 的闭包。

| 实际调用路径                     | 取消与完成语义                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| discoverPlugins / loadSource     | 当前无 caller AbortSignal。忽略过期 UI 完成；不声称网络已取消或回滚已返回 cache 更新        |
| addSource                        | Fetch 后真实 registry write；无 signal。关闭抑制过期 UI，但已提交来源可保留磁盘，重开须可见 |
| removeSource / markSourceUpdated | 同步持久化；调用前确认，写失败报告错误。写后不声称取消/回滚                                 |
| parseInstallSource               | 无 signal 入口。await 后、安装前重查 owner；不声称物理取消 parse/fetch                      |
| consent / setting / choice       | 操作局部 UI request；abort/owner 变化返回拒绝或 reject，移除自己的 modal，不批准旧操作      |
| installExtension                 | 传真实 signal，尊重服务支持的准备/abort 边界。提交后保留真实已提交结果/警告，不假称回滚     |
| refreshCache / tab reload        | 重建真实状态，只向当前 owner 发布；不新增 reload registry，不让旧状态覆盖替换 dialog        |

按 Ink 在安装 pending 时锁定外层 tab/关闭操作；嵌套 consent、setting、plugin-choice 仍可取消并结束本次操作。Session/request 替换或组件卸载仍中止 owned 工作。Pending 时锁定重复动作。UI owner 后期变化不能自动重试已完成变更。所有资源和 modal 有有限收尾；测试在强制清理前观察 CLI 自然退出。

## 计划改动与规模

预计改动 native Discover/Sources 内容、现有 dialog mount/status/owner、操作局部 confirmation/settings/choice，小型共享纯 helper 仅在必要时提取；加入邻接测试、一个有限 integration fixture/计划与本成对设计。不重写 Installed。捕获目标目录的要求需要窄改现有来源解析：给既有 parser/loader 和 catalog 操作传显式 cwd，manager 绑定解析转发其真实 policy，新本地来源持久化稳定绝对路径，既有 discovery cache 按 cwd 复用。Native caller 传捕获目录；未传 cwd 的旧 caller 保持原行为。旧相对来源按当前捕获目录解释，因为持久 schema 未记录原目录。本批连同真实消费者和测试完整交付，不新增 parser、registry 或通用基础设施 PR。物理取消无 signal 的 fetch 不在本次改动内。

原1950–3100行估计已被完整 UI、生命周期回归和永久三腿获取测试超出。每个交付 PR 按实际 base 计算新增行加删除行，包含测试及双语设计，不得超过6000行；发布或扩展前核对格式化后的最终 diff。保留所有独有控制，不拆端口与真实 caller，不删测试或搬入无关范围凑数。

## 验证与验收

遵循配套 E2E 计划。先在 owned HOME 下记录当前 global 身份和有限真实行为；旧 release 不是当前 Ink 权威。之后用真实 B NodeInk/BunInk 作正控，strict OpenTUI 在实现前证明缺失流程。测试不读真实用户凭证、不改 global 配置；优先合法 owned 本地 marketplace/extension，不绕过网络策略。

验收 E1–E10：E1 来源添加/详情/移除持久化；E2 discover/filter/search/multi-select 与安全显示；E3 捕获目标下 user/project activation；E4 真实 consent/settings/choice 的 deny/cancel/approve；E5 实际安装与已提交警告；E6 失败重试不伪改 updatedAt/成功；E7 关闭/替换 owner 不批准或发布旧状态；E8 三 tab loaded/persisted 事实与 reload-required；E9 Installed 原控不变；E10 三 renderer 相同有限 fixture、raw 证据、自然退出和清理。当前全部 pending。

交付前完成 own build/type/bundle、受影响 wholefiles、lint/format、真实产品三腿、双语审计、两轮连续 clean full-diff 审计。Mock manager 测试绿不能当实际安装证据；PR/E2E 报告明确平台与安装限制。

## 未决事项与风险

扩展专属 consent、setting 和 marketplace choice 应在保持挂载的 dialog 内容内展示。当前 shell 用 action modal 替换 dialog，会卸载后者；若 mount 拥有操作却通过该 modal 确认，会使自己的 owner 失效并丢失 tab/batch 状态。获取后复用已有命令 reload 的完整消费链，不新增全局 handler 或 registry。Global 变更前用实际服务确认合法本地 marketplace 语法。显式 cwd 路径使用既有私有来源拆分器，不更改 process.cwd，不复制 URL/port/drive/plugin 语法。用不同真实本地字节验证 ambient A 与 captured B、相对来源持久化/重开和 discovery cache 身份。预览解析还须遵守真实 core network policy。当前 CLI Config 创建 manager 时未设置 networkPolicy，因此默认 parser policy 与该 caller 一致；不能推广为显式私有 policy 的 manager 也同样安全，更不能提供宽松 override。这些已形成源码接线合同，真实安装及 native 行为仍须有验收证据。关闭时不可中止的来源持久化，应定义为重开可见已提交结果而非假取消。选定的安装 pending 关闭锁定策略须在 UI/footer/tests 一致，不能为 fixture 通过而改 core trust policy。
