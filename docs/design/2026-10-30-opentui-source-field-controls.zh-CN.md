# Source 字段 Ctrl+C 对等

[English](2026-10-30-opentui-source-field-controls.md)

状态：已安装 Ink 的完整公开 Source 基线通过，包含 Ctrl+C 空字段与全局退出提示、Undo、安装和冷启动状态。未修改的严格 OpenTUI 候选在空字段断言失败：Ctrl+C 后字段仍保留 RbZ。组件整文件 RED 共注册 17 项：四项预期 clear/Undo 用例失败，13 项通过，包含两个 Shift+Ctrl+C 对照及全部 11 项原有用例。显式 owner 分支已通过全部 17 项组件测试、正常 build、typecheck 和 lint。Node+Ink、Bun+Ink、strict Bun+OpenTUI 各通过完整 Source 场景及两个 Permissions 回归：共九次执行、三个不同场景、十二次记录在案的自然退出，model HTTP 为零。结果范围是提交前源码树及绑定的分块 bundle，不代表提交后安装包或最终 main 安装验收。

Ink SourcesTab 的 Add Marketplace 与 Install Extension 都使用共享 TextInput。TextInput 通过 Command.CLEAR_INPUT 清空非空文本。OpenTUI ExtensionSourcesTab 在相同两个视图使用同一个 useLineEdit，修复前直接交给 line.handleKey，没有 Ctrl+C 的字段所有者处理。已有 Auth 与 Permissions 字段则显式调用 line.clear()。

以一个完整 Source 字段修复处理两个视图：在共享输入处理器增加显式 Command.CLEAR_INPUT 分支，调用现有 line.clear()。保留 current-owner、active、可见、非 busy、非 settled 门槛，以及 Escape、提交的原有所有权。不要把 Ctrl+C 加入共享 line-edit 默认行为：Discover 搜索、敏感 acquisition/密码字段、AskUserQuestion 合同不同。本批无需 Core、flag、schema 或通用 reducer 修改。

匹配器明确要求 shift:false。局部处理不得 stopPropagation 或 preventDefault 阻断全局广播：第一次 Ctrl+C 在清字段时仍按原合同武装全局退出；第二次仍交给现有全局退出合同。局部单测不能证明全局仲裁，不能据此宣称 Shift+Ctrl+C、Ctrl+D 或所有修饰键已对等。

既有 ExtensionSourcesTab 整文件内，为两个真实视图各增加三项行为测试：同一同步 read 中清空后 Enter 不得提交旧文本，随后替换值按原 cwd/user scope 恰好提交一次；清空、再次空清空、Undo 恢复完整 Unicode 值并提交；Shift+Ctrl+C 不清空。复用既有 catalog 与公开组件回调，不新建 driver，不注入私有状态。第二项验证空清空是 history 无操作，不多消耗一次 Undo。

公开测试计划：复用既有 Source editor 场景、owned source/store/settings 与零模型 fixture。Add Marketplace 编辑阶段在原编辑状态之后发送 Ctrl+C，检查精确空字段及首次退出提示，再发送 Undo，检查精确恢复 RbZ。之后保留原有取消和真实 consent/catalog 安装路径。断言原 fixture 的持久化真值、来源 fixture 未变、冷热状态、零 model HTTP 及 CLI 自然退出。替换值提交由组件用例独立验证。另行观察首次武装/二次退出：字段清空不等于全局退出对等。已安装 Ink 基线与严格 OpenTUI 复现已完成，原失败保留实际范围。直接安装共用同一生产输入 owner，并由单独的精确回调单测覆盖。

公开差异已复现，先在 packages/cli 执行既有组件整文件，owner 分支已实施；验证该整文件、已有共享 clear/history/全局退出回归、build/typecheck/lint，以及适用 renderer 的公开场景。本机验证串行执行，避免并发应用或构建进程。异步提交所有权不变：settled 或 busy 后迟到的 clear/paste/Enter 不得改变或重复提交值。已有 busy/stale-owner 用例仍是必要回归覆盖，不新增并发框架。
