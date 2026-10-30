# OpenTUI 手动创建 subagent

[English](2026-10-30-opentui-manual-subagent-creation.md) | [简体中文](2026-10-30-opentui-manual-subagent-creation.zh-CN.md)

## 问题与证据

公开 `/agents create` 在 Ink 中打开真实八步手动 wizard，但 OpenTUI 此前只显示说明与 Escape。隔离的全局 Ink 运行完成取消、手动创建、精确 Markdown 验证、热冷详情读取、两次自然退出和零模型请求。早期基线观察器因在列表中寻找描述、没有打开详情而失败；原失败保留。候选 strict OpenTUI 随后在首个位置页失败，显示占位说明而非 wizard。这些是不同观测，全局二进制源码身份未知。

## 范围与设计

新增原生手动 wizard，不修改 Core、manager 详情 UI、默认 renderer 或 Ctrl+C owner。既有 mount 将实际 config 传入新组件。复用 Ink 中不依赖 renderer 的 wizard reducer、八步映射、颜色选项和 registry 工具类别。流程是 project/user 位置、明确选择 Manual Creation、名称、system prompt、描述、工具、颜色、确认。唯一提供的生成方式确实已实现：手动创建不请求模型。不把引导生成和外部保存编辑显示为可用操作，这些仍为独立工作。

文本字段复用共享行编辑器，包括 caret 移动、paste、词编辑、kill/undo/redo 和已接受值历史。空输入不能前进。返回保留草稿，首步 Escape 取消且不保存。步骤切换 settle 原字段 owner，handler 拒绝同一次 input read 中属于旧步骤的后续事件。显示内容经过终端安全清理，caret 前后的空原生 text 不挂载。

工具使用真实 registry displayName，按现有 Kind 分类。All Tools 仍为空数组，由既有序列化器省略 tools 字段。Blue 等显式颜色保持，自动颜色为 `auto`。确认页在允许保存前通过现有 manager 检查名称冲突，显示同级覆盖或跨级优先级警告。冲突检查失败时不允许保存，用户返回后可重新检查。

保存只使用既有公开 manager 和 `{level, overwrite: true, assertCanCommit}`，传入完整 subagent config。不引入自定义文件路径或直接写 agent 文件。manager 负责验证、选择 project `.qwen/agents` 或配置的用户 agent 目录、序列化、写入及刷新缓存。同步 pending ref 拒绝重复提交。错误保留表单；成功先显示确认再关闭，unmount 清理关闭 timer。

Escape 可以关闭正在保存的视图。关闭/unmount 撤销 owner，由既有 `assertCanCommit` 在建目录及写文件前检查。这不能回滚已开始或已提交的写入。迟到的 Promise 不能重新打开或更新已关闭 wizard。不新增 Core API 或虚构取消保证。

## 验证与验收

新增行为单测覆盖八步 payload、真实 registry 分类值、user 级选择、空值验证、文本历史、返回、同 read Enter burst、保存错误、单飞提交、pending owner 撤销、名称冲突顺序及缺少 config。React host 是测试替身，不代表原生终端绘制或磁盘保存通过。

既有交互用例必须针对构建后的候选执行：取消时 project/user store 不变；手动创建唯一 project agent；验证完整 summary 和保存前无文件；保存精确 Markdown；user store 不变；在同一进程及真实重启后读取新 agent，包括 Ink 和 OpenTUI 详情；两次自然退出且模型请求为零。实际结果记录对应候选/runtime 身份。此前 OpenTUI 仅检查列表的观察，已由独立复现并修复的只读管理路径接续。

执行受影响 CLI 文件整案单测、完整 build/typecheck/lint、格式，以及 Node Ink、Bun Ink、strict Bun OpenTUI 的聚焦交互用例。修复后完整 diff 两遍审查并独审。既有基线失败保留。user 级磁盘 E2E、真实覆盖、引导生成、外部编辑器、agent 执行/工具权限及其他平台不在本次 project 创建证明范围。本地旧 base 候选不代表最终已合入 main 的验收。

## 实施期间的真实验证状态

首轮新 wizard 单测实际为 2P/10F：每次 render 新建的空 items 列表触发共享选择 hook 的 render 期更新循环，Ctrl+C 断言尚未到达。只在 caller 按 kind/toolCategories memoize 列表后，第二轮真实为 11P/1F，唯一失败是 manual name 按 Ctrl+C 后仍保留原文字。两轮失败及先前静审漏项均保留，不倒称早已通过。

Ink 的真实 TextEntryStep 复用 shared TextInput 的 CLEAR_INPUT 合同。新字段现通过既有 `keyMatchers[Command.CLEAR_INPUT]` 调用行编辑器的 `clear()`：清空是一个可撤销编辑，空字段不增加无意义历史；不调用 preventDefault/stopPropagation，不改变全局 Ctrl+C owner，Ctrl+Shift+C 不清空、普通 Shift+C 仍可输入。修后四文件整案单测真实为 94P（新 wizard 12、mount 40、history 13、line edit 29），格式检查成功；这些不代表 native 通过。

首轮修后 strict Bun OpenTUI 实际运行仍在 `create-location-cancel` 失败。此时真实 frame 已有 `Step 1: Choose Location`，但行显示 `project`、`user`，不是既有 Ink 的位置说明。原因是共享 DialogSelect 未提供 renderLabel 时默认绘制 value，新 caller 虽填 label 却未传绘制回调。原 94P 和这次 native 失败均保留，后续步骤未到达。最小修复在 caller 显式绘制清理后的 label：位置保留 Project/User Level 和路径，生成方式显示 Manual Creation，工具显示真实类别名，颜色显示 Blue 等显示名；提交 value 不变。原 E2E oracle、单次输入及预算均不改，当时修后 native 结果仍待真实验证。

标签修复随后通过四个整文件单测共 95 例，以及正常 build、typecheck、lint、bundle。Node+Ink、Bun+Ink、strict Bun+OpenTUI 手动创建 case 均已真实通过，包括精确 Markdown、热/冷观察、零模型请求与自然退出。这些证据仅适用于后续管理器详情改动之前的本地手动创建候选，不代表已合入 main 或整体迁移验收。

最终本地组合候选仍是当前依赖基础上的未提交改动。PascalCase 修正后，六个 CLI 整文件单测共 111P，随后正常 build、typecheck、lint、bundle 均通过。Node+Ink、Bun+Ink、strict Bun+OpenTUI 各通过两项 Permissions、Source 获取和包含热/冷管理详情的手动创建 case：共执行 12 次、四个唯一 case，观察到 18 次自然会话退出，模型请求为零。manual case 证明取消不写入、八步 project 创建、精确 Markdown、user store 保持及热/冷只读导航；未在原生运行中执行 manual Ctrl+C、user 级磁盘创建、可选详情字段或长滚动。单测覆盖 manual Ctrl+C、user 级 payload 选择、可选详情字段及基本滚动调用；不代表 user 级磁盘创建或长滚动 E2E。bundle 入口摘要与独立的 1,378 个生成文件有限身份快照分开，两者均不代表完整依赖图或安装证明。所有旧失败保留；这不是合入 main 或整体迁移验收。

## 规范持久化颜色

颜色选项保持既有显示名，但现在把小写 option id 提交给公开 manager。`blue`/`green` 能通过既有 Core 解析，`auto` 仍在序列化时省略。选择器兼读规范 id 与历史显示名，不暗自重写文件。此前精确 `color: Blue` 创建证据不证明 Core 重载后保留颜色。修正后的公开创建整案要求 `color: blue` 及冷热详情颜色。当前规范颜色批次已通过八个 CLI 整文件共 146 项测试、正常完整 build、typecheck、原生布局/resize 和 bundle。Node+Ink、Bun+Ink 与 strict Bun+OpenTUI 已各针对同一本地源码 bundle 通过包含本创建场景和新增编辑/删除场景的完整五项公开 case：15 次执行、五个唯一 case、24 次自然会话退出及零模型请求。独立保存结果审查已确认三个 profile 和 58 个有限输入 pins；最终 typecheck 已通过，最终 lint 也已通过。此前大写颜色的结果保留历史范围，不代表安装后的修改行为、其他平台或最终合入 main 的验收。

## 原生创建器几何修正

对已提交原创建器的后续真实 native probe 发现独立的窄区回归：11列、12行对话区域中，手动创建前三页实际长到37/36/35行并绘制到区域外，生成方式选项不可见；100列、30行 probe 到达全部三页。此前常规宽度公开运行和 mock 单测保留原范围。

现在 caller 按实际内容宽度测量完整步骤标题与精确 footer，使用普通 footer 并计入五行固定 chrome，正文明确限高。容不下 chrome 时隐藏标题/footer、纵向 padding 和 border，保留横向 padding。紧凑选项不画数字，并按扣除选择箭头后的剩余宽度截断清理后的标签；数字键选择语义不变。现有真实 native 几何脚本加入同样前三个手动页的11x12及100x30检查，并增加标签单测。本修正只涉及布局，不改手动步骤、保存或 owner 守卫，不添加引导生成。

修正后的工作树候选已通过八个 CLI 整文件共 148 项测试，以及正常完整 build、typecheck、lint 和 bundle。永久 native 整案保留原 132 项并通过新增六个创建器观察，第三页还实际证明姓名字段接收输入；未改动的原 probe 另行通过同样的窄区/常规几何检查。受影响的完整 manual 创建 case 随后在 Node+Ink、Bun+Ink、strict Bun+OpenTUI 各通过一次：三次执行、一个唯一 case、六次无 signal 的自然退出、模型请求为零。这些新 manual-only 运行与此前 0a34 的五 case/15 次执行/24 次退出证据分开；其余四个公开 case 未改，也不为本修正重跑。本证据对应提交前源码 bundle，不代表提交后打包、安装态创建、窄区全部八页、其他平台或最终合入 main 的验收。原 37/36/35 行失败保留。
