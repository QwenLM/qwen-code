# Web Shell 会话定时任务

[English version](./session-scheduled-tasks.md)

- 日期：2026-11-23
- 状态：实现中
- 范围：由本地 daemon 支撑的 Web Shell 会话及其定时任务界面。

## 1. 问题与范围

用户需要在同一个会话中看到并控制持久 cron 工作与会话级 cron/loop 工作。会话头部的数量、输入框附近的任务 chip、Environment 条目、任务编辑详情，以及创建任务那一轮的卡片，必须使用相同的身份和生命周期事实。本功能不引入新的持久化后端，也不替代主工作区/全局定时任务页面。

不能只因为内存任务不再出现在实时列表中，就推断其进入了取消或已删除等终态。实时控制、用户明确确认和历史快照是三类不同的证据。

## 2. 协议与兼容

会话快照只公开本会话内存中的 cron/wakeup 元数据，不包含持久任务库。支持此功能的快照始终带 `scheduledTasks`，包括空数组；旧 daemon 缺少这个可选字段表示能力未知，不表示权威空列表。

`enabled: false` 表示会话调度器已禁用，存活的 cron 不能再触发，不等于整个 cron 功能不可用。这些任务仍可被明确停止，可以继续存在于控件中，但不计入活跃数量，也不决定下一次活跃任务的倒计时。scheduler 停用时将清除的 wakeup，不显示为“仍然待执行的 disabled wakeup”。

cron 的取消是会话级的。拿到持久任务 ID 后绝不能回退去删除全局/持久任务。较旧的 daemon 可能完全不支持新取消 kind；缺少能力不能按取消成功处理。

## 3. owner 与 workspace 路由

每次读取或变更都必须有 owner session，以及由核验过的注册记录选出的路由：

- **受信任的** primary 可使用未限定 scheduled-task 路由，参数为 `undefined`。这只是 URL 形式，不是免信任的例外：服务端仍执行运行时 workspace trust 守卫。
- secondary 必须有精确且受信任的注册匹配，使用其注册 ID 走 qualified 路由。
- 未注册、歧义、不受信任或已移除的注册记录禁止 durable 读取，绝不通过 primary 重试，也不能把未受信任的 primary 当作受信任primary来放行。撤销信任后同样受服务端 `untrusted_workspace` 拒绝约束。

非空 workspace 注册表必须有恰好一个 cwd 匹配，且 workspace ID 无歧义；`primary` 标记必须与 daemon 实际 primary cwd 一致。重复 cwd 或 ID，以及错误标成 primary 的 secondary，都会禁用 durable 读取且绝不回落 primary。只有 workspace 注册字段缺失且 cwd 精确等于实际 primary cwd 的旧 legacy 情形才使用上面的兼容规则。显式为空的 `workspaces: []` 不会被静默解释为 primary。

tab 的 owner ID 和 primary 的路由参数是两组不同事实。调度详情守卫只为核验过的 primary owner 接受空路由；secondary 丢失身份仍需 fail closed。当前读取与历史恢复共用同一个路由解析器。旧 primary owner ID 会在 live 查询、更新匹配和删除身份归一为未限定路由，但不会替代 secondary 的注册路由。

PATCH、DELETE 和 Run 都用 `expectedSessionId` 声明预期的任务 owner，空值表示未绑定任务。服务端在任务文件写锁内，只接受恰好一条 ID 与 owner 相符的记录；未指定 owner 的旧 mutation 遇到重复 ID 时返回 409，绝不修改第一条记录。每个创建路径都拒绝生成 ID 冲突。owner 选择失败或 ID 歧义的请求，不得获得对原 owner 的恢复否决权。已绑定 owner 的 tombstone 使用 `[sessionId, taskId]`：即使返回 404，因为任务已被消费，同 owner 的 pending delete 仍否决恢复；删除另一个 owner 的 sibling 则不能阻断它。失败恢复和 per-run 结果归属都使用原 mutation 选择的 owner，而不是同 ID 的第一条记录。独立地，per-run dispatch 进行中删除 parent session 仍然否决恢复，保护既有绑定子会话生命周期语义。手工运行也只有在 fresh read 中找到恰好一条 ID 与 session 相符的记录后，才能入队该任务的 prompt；已确认的删除会使该任务仍在飞行的 fresh read 在 prompt 入队或登记前失效，但不能撤回已被接纳的 prompt。
每个在飞行中的手工 per-run 结果都绑定自己的运行标识，同一毫秒内的两次运行不能覆盖彼此的子会话结果。自然派发归属还要匹配触发任务的 owner，包括显式未绑定 owner；没有该标识的旧运行记录为兼容仍按时间戳匹配。自然 one-shot 的消费与失败恢复也选择原始 ID+owner，而不是同 ID 的第一条记录。恢复代际同时观察 legacy 裸 ID 与触发 owner 的复合 tombstone；按 owner 删除 sibling 不推进裸 legacy 代际，parent session 删除仍是独立否决条件。

同一 cwd 更换注册 ID 时，live 恢复将 tab 的 owner 归一为当前合法注册，并通过这个新 owner 执行操作；不能让控件继续绑定不可用的旧 owner。primary 的路由仍只在自己的校验通过后保持未限定。

前端生命周期代次和 durable 读取代次必须同时生效。owner 切换使相关请求失效。durable 被禁用后，其代次增加，清除 durable UI 状态和待运行锁，并拒绝撤销前的读取及 mutation 回调，即使设置后来重新启用也一样。重新启用后新的合法读取与这些被拒绝的操作相互独立，仍可得到权威空快照。

## 4. 跨面板状态与变更

规范化的 owner 范围视图同时供应 Environment 列表和已经打开的详情。详情只消费 source session、任务 ID 和 workspace 全部匹配的 live durable 记录，或身份相同的已确认删除记录。即使历史回退已经恢复了原始创建记录，同 ID 绑定到另一个 session 的任务也不能作为可编辑替代对象。读取和 mutation 回执还会比较请求 owner 与当前任务 scope。

详情只通过这个受保护的投影接入 live 字段，不会为每次更新额外发起一次列表请求。详情确认删除后，通过共享确认函数立即移除 Environment 行、记录带 workspace 的 tombstone，并淘汰旧读取，而不是依赖下一轮旧数据刷新来收敛。删除确认属于任务/session scope，而不是易变的 provider 对象身份。后续被接纳的列表响应也会应用 tombstone，旧响应或重复记录不能复活已确认删除的行。
全页任务管理器共享当前会话同步更新的确认谓词，并为自己直接确认删除的任务记录 workspace+session+id tombstone。两条路径都拦截尚未验证的 Manual Run 旧读取。共享刷新回调在 React 发起替代读取前淘汰旧列表响应，已确认保存的详情不能被更早接纳的旧投影回写；更新的读取仍可正常更新详情。

服务端已确认的 session 停止也存入 Environment 使用的同一 owner 状态，并以只读取消 ID 集合提供给详情。当前详情以及同一 owner 下之后创建的详情实例，都必须显示已确认停止的快照，不能把它与自然过期或 live 状态未知混为一谈；其他 source session 不能借用这份确认。详情内的直接停止可以把焦点还给稳定的 detail group，而 Environment 的停止是独立的焦点事务，不能被详情的本地 effect 覆盖。

外部启用、停用、改名、prompt 更新或重新读取同一任务，都不能覆盖用户正在编辑的草稿。关闭编辑器后，已确认的保存结果也不能被旧 live 任务覆盖。明确删除会让编辑操作失效。来自 Environment 和来自详情自身的删除遵循同一确认规则。比这些新事实更早的请求结果必须丢弃。

owner 匹配且支持此能力的 durable 快照不再包含已加载的任务时，旧 live 对象失效并退休其操作控件，但不能据此宣称它被明确删除。较旧 daemon 没有这种快照时，这不构成权威缺席，不能按同样方式清理已有历史视图。

只有某个 ID 出现在列表中时，才有 live 状态。自然消费、过期、其他 daemon 的状态以及不支持能力都可能造成缺席，因此不能根据缺席宣告取消或删除。缺少实时状态时保留创建快照；session 任务的停止文案需要服务端确认取消，durable 已删除状态需要已确认的变更证据。

## 5. 键盘与焦点不变量

用户确认删除后，有后续幸存任务则把焦点移给该任务；否则交给分区标题或稳定的 Environment 容器。在详情中停止会话任务后，焦点留在该详情，不落到文档主体。失败或被用户取消的操作不抢走焦点。

待恢复焦点属于发起操作的会话和工作区。owner 改变时丢弃旧的焦点意图和缓存任务按钮引用，避免把焦点带到替代会话里的对应控件。

每个删除/停止意图都带请求序号。请求失败、服务端明确返回未确认取消，或 Promise 被拒绝时，只撤销对应这一次 intent。后续如果任务自然离开快照，旧的失败 intent 绝不能把焦点从用户新位置抢走。已确认移除仍使用原来的恢复链。详情本地的 Stop 聚焦只用于这次直接操作，不用于通过共享状态送达的 Environment 停止。同样的结算规则沿用旧式 `Promise<void>` resolve-only handler：它只能在完成后确认；显式 `false` 或 Promise 被拒绝始终不能恢复焦点。在结算到来之前自然消失，不能被当作已确认移除。

## 6. 手工运行与刷新

绑定会话的 recurring 任务手工运行遵循：fresh read → 共享 controller 接收 prompt → 写入运行记录。per-run 仍由 daemon 派发，不再向 controller 重复塞同一 prompt。一次性任务被消费后，如果无法再获得 admission，界面必须明确说明“已消费但未能运行”，不能声称 exactly-once，也不能吞掉这次执行机会。

普通会话不会因为新增 UI 而开启常态快照探测。调度发现由真实 cron/loop 活动、专用定时会话或明确用户操作驱动。待执行调度使用有界的“请求完成后重试”读取；即使发生临时错误或快照不变，到期后仍继续读取。

## 7. 历史恢复与展示

恢复优先使用持久化的任务 ID、scope、源会话和 workspace 身份，再参考同一 owner 的原始创建记录；旧 tool-call ID 只在该 owner 内保留兼容回退。live 中找不到可以回退到原始创建记录，不能借用别的会话或 primary workspace。如果 durable 创建记录缺少路由字段，只能从这个已核验的 durable tab owner 补齐。

只有 owner 匹配的 live 记录支持时，创建卡片展示 `active` 或 `paused`，不凭空生成历史 `cancelled` 徽章。详情区分明确停止/删除与缺少 live 状态，同时保留创建 prompt 和其它原始字段。即使任务已被明确删除，也保留这些原始字段供读取；失效的是操作控件，不是历史内容。

prompt 按 Unicode code point 截断。焦点样式与局部布局继续使用 CSS Modules，不能改写其它 section 的标题行。Environment 状态、公开字段、取消失败及历史快照说明都有英文、简体中文、繁体中文和俄语版本；数量复数使用既有俄语复数规则。

## 8. 验证策略

回归测试驱动真实组件接线，不止检查新增 prop 或类型断言。覆盖 owner 身份、secondary 历史、trusted/untrusted primary 边界、禁用后的显式刷新抑制、异步竞争、重复请求防护，以及真实 DOM 移除后的焦点。明确操作和自然消失必须分开断言。

承重行为具有负向控制。例如，对真实源码副本中的 durable hook 先确认 22 项用例通过，再移除禁用闸门，新增用例就会失败。新的历史详情 DOM 测试在旧实现上先失败，再验证修复。涉及两个面板的用户操作还需要完整 App 集成回归。

最终集成门使用真实 daemon、真实 ACP/HTTP、隔离 workspace 和文件系统、真实 Chromium。只有模型端点由可控 loopback fake 提供。记录 transcript 中的标记次数、手工运行历史、停止任务、重启/reload 恢复、窄屏宽度、浏览器控制台错误和服务关闭结果。未实测的外部 provider、原生 mobile WebKit，以及域范围的 exactly-once 不得伪造保证。

## 9. 约束与非目标

- durable 请求、session 取消及 workspace 操作均不得回退到无关 primary owner。
- 不能将 UI 中的缺席悄悄认定为已取消或已删除。
- 失败操作不能悄悄破坏其它操作，也不能隐藏一次性任务已经消费但未运行的损失。
- 不为崩溃、network partition 或 owner 竞态承诺 exactly-once；这些情况需要明确报告结果。
- 本机未独立验证的 native mobile WebKit 和真实外部 provider streaming 不宣称已经验证。mock daemon 浏览器和本机 fake-model rig 不能代替这些证明。
- 文档与验证证据必须标明真实源码 head，旧 head 的结果不能为新候选背书。

后续审计必须按当时实际源码逐项重新核对这些决策，不得把早已移除的旧问题重新报告成阻断项。
