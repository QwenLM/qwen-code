# 原生 OpenTUI 内存管理器

[English](2026-11-14-opentui-memory-manager.md) | [简体中文](2026-11-14-opentui-memory-manager.zh-CN.md)

## 状态与问题

Memory 控制项及文件/目录操作已完成本地限定验证；这是 CLI 增量，不是整体迁移验收。双基线、分阶段资格验证和公开结果独审记录在下文，所有 producer 均由 Root 执行。实际 main6f 的 `/memory` 返回 memory 请求，并以真实 Config/settings 挂载 `OpenTuiMemoryDialog`。该组件只处理 Escape，打印 user/project 上下文文件路径及三个 on/off 状态。实际 Ink `MemoryDialog` 有四个控制项、可选用户/项目目标、真实文件/目录打开与错误处理。这是已挂载能力缺口，不是缺少导出。所有 build/test/application producer 均由 Root 单独执行。

## 范围与已有行为

恢复全部四项：`memory.enableManagedAutoMemory`、`memory.enableManagedAutoDream`、`memory.enableAutoSkill`、`memory.autoSkillConfirm`。初值来自实时 merged settings，默认开启，并保留已有 bare/safe 显示关闭语义。保持 Ink 导航：初始焦点在用户/项目列表；第一项 Up 依次进入确认、auto-skill、dream、memory；Down 反向返回；Enter 切换或打开；数字快捷键打开目标；Escape 关闭。每次明确切换立即写入 `SettingScope.Workspace`，保留无关 workspace 字段及全部 user/system 配置。重开读取 merged settings；未激活操作的 Escape 不写入。

auto-skill 配置成功写入后，对同一个选中 Config 调用已有公开 `Config.setAutoSkillEnabled(newValue)`。其 getter 仍受 sandbox/bare/safe/provisional-workspace 政策约束。已有读取者包括 Config 启动 curator gate、Core client 的 skill-review 调度器及 Ink AppContainer 的待审入口；已有 SkillReviewDialog 也会关闭同一 flag。不修改这些消费者/写入者，也不宣称 Native skill-review 展示已对齐。其余控制在 Ink 中只有持久化和本地显示变化；特别是 `getAutoSkillConfirmEnabled()` 是启动快照，没有对应公开 setter。保留该行为并验证冷启动重建，不能承诺确认政策即时生效或新增 Core setter。

目标种类跟随 `config.isManagedMemoryAvailable()`，与 Ink 一致。热切换 auto-memory 不改写该启动 Config 快照；后续冷启动才可能改变目标种类。托管内存可用时，用户/项目项解析已有托管根目录，并显示已有 dream 元数据和相对时间。否则按配置的内存文件名顺序选择首个可访问文件，均不存在则用首个名称或 `QWEN.md`。使用真实选中 working/project 根及公开内存路径函数，不能硬编码 `memory.md` 或 primary cwd。

## 真实目标操作与错误

只有明确选择目标后，才允许创建缺少的目录/文件。普通模式打开实际选中的上下文文件。托管模式先创建目标根，再在 macOS/Windows 或有图形环境的 Linux 调用目录打开程序；无图形 Linux 则确保并编辑其中的 `MEMORY.md` 索引。首选编辑器、平台默认程序、argv 与 shell 政策保持已有 CLI 规则。目录打开程序的公共合同是成功 spawn，不是 GUI 已打开或进程零退出。编辑器 spawn、非零退出、signal 错误应可见，面板仍可操作。打开失败前可能已创建请求的空目标，不承诺 Ink 本来也没有的回滚。

Native 不能直接挂载消费 Ink stdin/settings context 的 `useLaunchEditor`。应复用已有 Native renderer suspend/resume 和恢复模式，接入小型真实文件 launcher，成功和失败都恢复 raw-mode/program status。`editTextInExternalEditor` 编辑并删除临时草稿 buffer，不是 Memory 目标 launcher，不能暗中替代真实文件操作。如果现有 CLI launcher 确实能服务两处，可做最小共享；不造通用 opener 框架。不额外触发内存刷新、模型 turn、dream 或技能生成。

## 所有权与边界

mount 显式提供选中 Config/settings/host 和 Native renderer 所有权。捕获 Config/settings/host 身份、session、实际 working/project 根、实际 Workspace 配置路径、相关 user/runtime 内存根及每代 active guard。在写配置、创建目标、启动外部进程、发布错误、关闭前，以及每次异步路径/元数据读取后重新核对。host 必须与 Config/settings 一致。未知或已替换的 owner、runtime 不匹配应明确失败；目标授权继续由既有 writer/trust/sandbox 政策决定，不能回退 primary runtime 或 ambient cwd。

关闭、卸载或观测到替换后永久撤销该代，包括 A→B→A。旧 completion 不能关闭、向新代报错、修改或污染真正的新代。一次只挂起一个明确动作；同一 read 中的导航/Enter 跟随实际已推进焦点，不能重复启动 pending 动作。列表焦点下，已知编号目录快捷键 1/2 保留 Ink 的立即激活语义，即使 viewport 已滚动；零高度或过窄不可用区域不激活目标。授权配置变化不能撤销自身 owner：不能把整个 merged settings 或内存语料指纹当身份。已有 writer/trust 和 sandbox 政策继续生效。guard 无法撤回已完成的同步写入或已启动进程，不宣称外部文件系统原子性。

## 最小分层与实现输入

仅 CLI：用同目录原生组件和测试替换静态 Memory body；通过实际 mount 传递必要的 owner/renderer 输入；命令路由和 Core API 不变。复用原生 key map、有界 frame/layout、终端文本清理和真实文件外部进程 handoff。真实换行滚动内容在布局后显露当前焦点；原生滚轮可以查看长路径/错误，不再单行截断。覆盖窄/短与 resize，不能隐藏当前选中控制或显示实际上无法操作的提示。

已完整读取 `ui/components/MemoryDialog.tsx`、`ui/hooks/useLaunchEditor.ts`、`ui/utils/external-editor.ts`、Native `input-prompt.tsx` 的编辑器挂起逻辑、命令和实际 mount，以及公开 Core 内存路径、Config flag getter/setter、client 调度器和 AppContainer 消费者。已有 Ink whole tests 覆盖四项焦点/顺序/持久化、托管目录、无图形索引回退、普通文件名和错误。Native frame-only 测试当前只描述静态不收缩 body，不能借作交互验收。

## 验证与验收

先对实际 global wrapper 验证完整公共计划，不更新安装并保留旧版本差异。再用当前 NodeInk 作完整参考、strict Native 作实际缺口。只验证确认开关的 dry run 可确定初始输入路径，不能证明四项或完整 Memory parity。完整可移植场景见 [tui-memory-manager.test.ts](../../integration-tests/interactive/tui-memory-manager.test.ts)；工作 E2E 计划保存在 `.qwen/e2e-tests/`。

实现后执行正常 build/typecheck、相关 whole CLI 和 workflow meta tests、零 warning lint、format、bundle、真实原生窄/短/resize，并在同一冻结候选上运行 NodeInk/BunInk/strictNative 全公共分组。保持 12s observation、120s case、retry0 和自然退出/model0 合同。使用 owned settings/memory/editor/opener 夹具及精确前后 map；真实外部可执行夹具证明实际 spawn/argv/文件效果，不冒真实桌面 GUI 程序资格。最后两轮完整 diff clean 自审和独审。保留所有原始失败，Trust、Skills 和旧候选通过不能当 Memory 证据。

## 限制与待定事项

不修改 Core memory/scheduler/provider，不加存储或 API，不切默认、不移除 Ink，不宣称 installed/final-main 或未测平台批准。证明既有公开 setter 调用，与实际 auto-skill 调度分开。原生自动 SkillReview 审批对话框仍是未实现的后续工作：这些控制不证明生成技能审批，也不会静默接受待审技能。必须验证冷启动确认状态，live policy 保留既有快照限制。global 版本缺口、可移植的真实公共写入失败夹具、Native 文件 launcher 的共享方式、支持的 sandbox/runtime handoff 仍须以明确验证或维护者/平台证据确定；不确定的政策修改交维护者。桌面 GUI、设备权限、Linux/Windows 资格均需独立证据。

## 当前实施检查点

Root 已完成 global72789 四组 PASS（72.0528 秒，实际工具终态0）；随后 strict Native98903 在真实只读三状态面板的原 A 观察断言失败（39.533 秒，实际工具终态1；清理信号9及错误保留；B/C/D 未运行）。global27028 观察器失败保留：完整标签在物理行换行，v3 仅识别同一行或紧邻下一物理行的编号标签。仅 CLI 范围实现在这组双基线之后进行；Core 与 Ink 生产代码保持不变。

验证由限定范围的合格阶段组成，并非一次流水线全绿。normal v6 通过完整仓库 build、新 Memory 单测整文件（18通过、1项仅 Linux 测试跳过）、另外7个 CLI 整文件（340通过）及两个 workflow meta 整文件（202通过、4跳过），随后在公开 harness 的环境变量类型上未通过 integration typecheck。v7 仅修正该夹具类型并通过 typecheck，随后零 warning lint 在合并声明处失败。v8 保持最终源码，但直接 workspace build 耗尽默认堆。v9 改用仓库标准构建命令的 `--cli-only` 及仓库6 GB配置，在 d05ff3fa 源上通过所选 CLI build、全范围零 warning lint、格式检查和 bundle。更早的 build/mock/类型/lint/堆失败均原样保留。

文档本次跟进之前冻结的 6f754be6+d05ff3fa 候选和 entry5428965d，在 Node/Ink、Bun/Ink、strict Bun/OpenTUI 下均通过全部四个公开整组：四个唯一分组共12次执行、57个受保护保存阶段、15次 exit0/signal0 自然退出、15个真实 owned 编辑器/目录打开夹具进程、模型请求0。三种配置的保存结果均已独审。测试保持原12秒观察、120秒 case、零重试；这些结果证明限定控制、持久化、真实目标分派与编辑器失败行为，不证明真实桌面 GUI 或调度器审批。

另外10个原生布局案通过：文件和托管两模式，尺寸120×40、80×18、40×18、20×15、40×12。这些源码 renderer 检查使用确定性配置错误 seam，不启动外部进程；它们证明布局/导航/可见性，不证明真实磁盘写入失败、政策或 GUI 完成。所有旧原生/观察器及中间几何失败保留；真实 writer/平台剩余证据和原生 SkillReview 展示继续明确列为后续工作。
