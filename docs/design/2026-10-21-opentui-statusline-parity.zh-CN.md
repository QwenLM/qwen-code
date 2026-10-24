# OpenTUI 状态栏配置与显示

[English](2026-10-21-opentui-statusline-parity.md) |
[简体中文](2026-10-21-opentui-statusline-parity.zh-CN.md)

当前交付（2026-10-21）：本工作与输入所有权、编辑和状态栏统一整合到
[#14964](https://github.com/QwenLM/qwen-code/pull/14964)。下文原分批边界、代码基线、
验证结果及 stacked PR 转正式步骤均为历史记录；当前推进顺序以
[交付计划](2026-10-20-opentui-migration-delivery.zh-CN.md)为准。
统一验收仍待完成，必须以整合提交的新结果为依据。

## 状态与代码基准

2026-10-21 已实现。本机作者验证通过：build/typecheck、325 项定向测试、
11 项 native 场景、7 项 PTY 驱动测试，以及 Node+Ink、Bun+Ink、
Bun+strict-OpenTUI 共六项产品测试。独立 macOS 验收也已通过：八项候选产品
场景、11 项 native 场景与两项冻结 Ink 生命周期对照；慢命令、非零输出、
移除设置和活跃命令清理均有实际观察，无重跑。Linux CI 与 Windows 验证仍待完成。

准备分支基于 U1
`69ffa32d46a1283fb1f1dc224e105275c1ebe493`（#14933）。再次查询远端 main
为 `82bd240ad0d31fd1d3a83dd803625118019ba35d`。相关 Ink `Footer`、
`StatusLineDialog`、`useStatusLine`、`statusLinePresets` 及 OpenTUI
footer/status dialog 在这两个版本中的 blob 一致。

## 问题与完整交付边界

Ink 支持 preset 和用户命令状态栏、实时数据刷新、既有颜色和上下文显示策略，
并可通过 `/statusline` 选择、预览和保存。OpenTUI 目前拼接固定 footer 字符串；
状态栏对话框只列出 preset 名称，不能编辑或保存，footer 也明确未显示用户状态栏。

将配置、持久化、显示和回归证据放进一个约 3k 行的 PR。保持 OpenTUI 0.5.10、
Bun 1.3.14、现有设置格式和 shell 命令执行器。

本批不关闭整个 footer 清单：语音、workflow、后台 shell 焦点、全局 transcript
控制和完整 Vim 编辑仍由各自批次负责。Vim 状态字段必须接到 U2C 的真实模式 owner
才能验收；硬编码模式或仅存在设置值不能证明编辑器正在使用 Vim。

## 实现方案

### 复用既有执行生命周期

将 Ink 当前 `useStatusLine` 的 context 包装保留在 `use-ink-status-line`，
以 `useStatusLineState` 暴露现有执行器。只为同一实现提取窄的显式状态
hook 入口，让 OpenTUI 传入真实 settings、config、会话指标、模型、流式状态、
branch/worktree、终端宽度和可用 Vim 状态。不构造虚假的完整 `UIState`，
也不复制命令执行器。

保留既有 300ms 状态变化 debounce、5s 命令超时、10KiB buffer 上限、两行输出
上限、周期刷新最小间隔及避免慢命令饥饿的行为、过期结果 generation 校验、子进程
清理、stdin JSON 和 shell sandbox 禁止策略。保留转为 idle 时的设置重载及
现有 preset/GitHub 查询行为。

每个新增传递值都必须有真实 producer 和读取点。通过既有 `SessionStatsProvider`
取得指标，避免渲染时读取仅由 ref getter 提供的滞后数据。复用
`useWorktreeSession` 和 `useGitBranchName`，保持与 Ink 相同的会话及工作区
语义。验证会话切换和模型变化，不假设 config 原地变更必然触发渲染。
会话模型订阅 `config.onModelChange`，避免临时 subagent 模型覆盖在无关重绘时
替换它。会话 ID 变化时两个 renderer 都刷新命令输入，即使指标相同；worktree
读取和 watcher 跟随会话 ID，并忽略前一会话的晚返回结果。

### 配置并持久化相同 preset

复用现有 preset 归一化、条目顺序、数据构造和行构造。两个 renderer 都需要的
少量对话框数据操作可以共享；布局和按键处理继续由各 renderer 自己负责。

OpenTUI 对话框需提供选择、主题颜色切换、高度允许时的过滤、预览、确认和 Escape
取消。匹配 Ink 生效设置层级：System、受信 Workspace、User。保存时保留既有
`hideContextIndicator`，产生相同反馈和录制事件。取消对话框不能写入设置。

使用 U1 的受限高度对话框布局及 native 选择组件。短屏下仍须可访问每一选项，
且能确认和取消。不增加独立设置缓存或持久化机制。

### 按相同策略显示结果

仅将 OpenTUI footer 中固定状态栏部分换为共享结果，保留 approval、shell、
queue、退出提示的优先级。匹配两行裁切、窄屏换行、主题颜色、用户 ANSI 颜色策略、
上下文指示器隐藏与回退。直接声明 Ink 已锁定的 `@alcalzone/ansi-tokenize`
0.3.0，使用其公开 API 将样式片段映射为 native `StyledText`，保留 RGB、索引
颜色、属性、重置和 OSC8 链接，丢弃光标控制序列。不依赖 Ink 私有 renderer，
不增加 parser 框架。上下文回退采用 Ink 的仅百分比文案和 secondary 颜色，
超限时切换 error 颜色。

命令失败和输出不变时保持 Ink 行为。不新增错误面板、公开设置、子进程框架或
运行时升级。

## Producer 与 consumer

| 数据或操作                | Producer → consumer                                             |
| ------------------------- | --------------------------------------------------------------- |
| 状态栏设置及已保存覆盖值  | 既有 settings/dialog save → 共享 hook → 两个 footer             |
| 会话指标及身份            | 既有 stats provider → 共享状态数据与对话框预览                  |
| 模型/reasoning 和流式状态 | 会话模型订阅、当前 reasoning 与 live turn → 状态 payload/preset |
| branch 与活动 worktree    | 既有工作区 hooks → 状态 payload/preset                          |
| Vim 状态                  | U2C 真实模式 owner → 状态 payload；接通前保持待验收             |
| 命令输出及清理            | 既有共享执行 hook → renderer 的受限文本区域                     |
| 保存反馈                  | 既有 history/recording 接口 → 可见 transcript 及会话记录        |

改动涉及 `useStatusLine`、两个 footer、status dialog/model helpers、OpenTUI
app/dialog 接线、定向测试及现有 TUI 验收 workflow。不计划改动 core/provider/
service 实现。

## 基线与回归方案

先对已安装全局 CLI dry-run 测试协议，记录真实版本和可执行文件，再对同一冻结
源码 bundle 执行 Node+Ink、Bun+Ink、Bun+strict-OpenTUI 对比。使用隔离 HOME、
workspace、settings 和本地确定性模型服务。

已安装 standalone 0.22.0 / 私有 Node 22.23.2，以及冻结 U2A bundle
`269600799782a5c507d62f3ae0db011c768be234` 的 Node 24.19.0 + Ink，
分别通过两项基线。strict Bun 1.3.14 + OpenTUI 两例失败：未执行命令，
preset 仅有静态列表而无配置交互；后续 usage、save、restart 断言未到达。
原始失败及夹具修正与候选验收分别保留。

| 能力        | 必需观察                                                            |
| ----------- | ------------------------------------------------------------------- |
| Preset 选择 | 相同选择及顺序、预览、保存层级和值、重新打开和重启                  |
| 取消及信任  | Escape 不写入；未受信 workspace 不能成为保存层级                    |
| 命令执行    | 真实自有命令接收准确 JSON，输出可识别的文本和颜色                   |
| 实时变化    | 模型/reasoning、usage、streaming/idle、resize、设置重载使用当前数据 |
| 刷新及失败  | 慢命令、非零退出、缺失命令、删除命令、过期输出及卸载清理            |
| 几何及颜色  | 窄屏/短屏、两行上限、中日韩文字/emoji、ANSI 单元格颜色、上下文回退  |
| 集成        | approval/shell/queue/退出优先级及既有 Ink hook/dialog 测试保持正确  |

命令和显示验证使用真实 executable fixture 与 PTY，捕获 ANSI、单元格属性、
命令输入输出、设置前后内容、进程身份及清理情况。仅 mock 执行器或字符串快照
不能证明真实执行、ANSI 策略或进程回收。
三组 RGB 对比均声明 `COLORTERM=truecolor`。首次 OpenTUI 运行未声明此能力，
将夹具的 RGB 输出显示为索引色 161；该观察继续保留，准确 RGB 断言没有放宽。

执行 build/typecheck、定向 CLI 测试、native 高度约束检查及相同三条产品路径。
提交的 statusline PTY 套件加入既有 TUI workflow，使用与基线相同的确定性
命令、颜色、保存、取消及重启判据；native 测试覆盖几何、样式及真实 settings
层级写入。POSIX PTY 夹具明确跳过 Windows，这不代表 Windows 行为通过。
保留首次失败，区分协议错误与产品差异。独立验证聚焦保存层级、命令生命周期和
终端几何，不重复全部单元断言。

## 验收与集成门槛

配置到显示的完整链路必须在精确候选上通过，不使用虚构状态，不复制设置逻辑，
不改变 Ink 行为。每个声称已支持的字段均需 producer/consumer 和运行证据。
未执行的 Vim、非本机平台、IME 及其他 footer 能力继续在迁移清单中标为未完成。

本批依赖 U1 的对话框边界，与 npm runtime 分支没有依赖关系。真实前置依赖审查时
保持 stacked Draft；基底合并后 rebase/retarget，复验受影响测试和精确 head CI。
本方案不代表批准合并、切换默认或删除 Ink。
