# OpenTUI 对话框编辑与 Permissions 表单

[English](2026-10-30-opentui-dialog-editing.md) | [简体中文](2026-10-30-opentui-dialog-editing.zh-CN.md)

## 状态与问题

本分支已实现 Ctrl+K/U、词编辑、Permissions 规则/路径编辑与目录补全、撤销/重做、数字输入历史处理，以及空光标分段的布局修正。本文说明该批次的决策与验证方法，不表示最终迁移或平台验收完成；整体迁移仍未完成。本地源码验证已通过 build、typecheck、lint、bundle、受影响单元测试，以及下述两个公开场景的 Node+Ink、Bun+Ink、strict Bun+OpenTUI 三种组合。具体候选结果记入随附的 PR 验证报告；这些源码结果不代表安装包或其他平台合格。

本改动前，OpenTUI 中对应 TextInput 的对话框字段缺少词移动、向右删词和撤销/重做。Permissions 的规则与工作区目录表单手工追加文本并按 UTF16 单元删除；Ink 两个表单都使用 TextInput。OpenTUI 此前提示支持目录补全，但没有实际实现。

## 范围与所有权

共享编辑模型与 Permissions 表单位于 `line-edit.ts` 和 `dialogs-permissions.tsx`。数字输入归一化及其专用 Space 行为位于 `dialogs-auth.tsx`。测试与源码相邻。空分段的显示修正覆盖 Sources、Discover、Acquisition、认证、确认与 Permissions 字段。不修改 Core、不增加配置或可选参数、不切默认、不发布、不移除 Ink。

不把 Discover 手写搜索/标签导航合同或 Acquisition 密码整值清空合同改造成 TextInput。共享 hook 的变化必须保留这些例外。既有失败与结果保持原件。

## 共享词编辑

复用 Ink buffer 模块已导出的 `offsetToLogicalPos`、`getWordMovePosition`、`applyWordDeletion`。将扁平码点光标映射为逻辑行列，执行原操作，再将返回光标展平。同时报告 Meta 时，仍保留 Ctrl+B/F 单字符移动的优先级。

绑定包括 Ctrl/Alt+Left/Right、Alt+B/F、Alt+D、Ctrl/Alt+Delete。标点、CJK 分词、补充字符和换行语义均由原 helper 决定，不新增第二套分词算法。纯 `LineState` 仍只有 `text` 与 `cursor`。

## Permissions 表单与补全

规则/路径编辑与 bracketed paste 使用 `useLineEdit`。保留原规则解析、工作区验证和变更回调。通过 `windowLineAtCaret` 绘制光标所在逻辑行，清理终端文本并限制到输入框实际宽度。空输入或无效提交保持可编辑。成功提交先 settle 再切视图。目录提交只有在同步保存回调成功返回后才 settle；回调抛错时必须保留编辑和 Escape。

复用已有 batch-safe 视图状态。旧绘制视图的 handler 不能编辑或提交后继视图。Esc settle 离开的字段。Tab 补全在当前 stdin read 剩余期间 settle 旧字段，下一次渲染按补全路径重新挂载；同一 read 的 Tab+Enter 不能提交补全前的路径。

对齐 Ink 补全：展开 `~`，保留相对路径，检查目录项，排除文件和隐藏名称，按前缀匹配，保留文件系统枚举顺序中的前 6 项，显示候选，Up/Down 选择，Tab 应用并补 `/`。文本编辑后重置选择。候选行按实际可用高度计费，不能选择隐藏行。保留现有 realpath、存在性与覆盖关系验证。

## 撤销/重做与真实 owner 合同

撤销/重做已按以下 owner 合同实现。在 `useLineEdit` 内保存私有文本/光标快照栈，与 Ink 一样限制为100条。复用当前受控镜像，不引入完整 TextBufferState 的 viewport/layout/selection 机制。不增加公开历史字段、可配置 normalizer 或新可选参数。Ctrl+Z/Shift+Ctrl+Z 读取实际 `shift` 属性；纯 reducer/密码路径保留既有所有权。

已核查每个生产 owner。Sources 传原样 `setInput`；Discover 传原样 `setQuery`。Base URL/API-key onChange 原样存值；API key trim 仅在成功提交、字段 settle 时发生。自定义 model 字段先原样保存 custom text，再单独归一化 model IDs。Model search 原样存值。Ask-user 自定义答案原样存文本、另更新选中标记。Permissions 字段原样存值、提交时才验证。

唯一实际过滤 onChange 是 context-window size：`useProviderSetupFlow.ts` 中的 `changeContextWindowSize` 删除非数字，初始化及 start/reset 只写空值。在两个真实 `ctxField.insert` 调用前按同一 `/[^0-9]/g` 规则归一化键入/paste 文本，保留 flow 过滤作为幂等后盾。非法输入变为 no-op，不改变历史；混合 paste 把接受的数字记为一次编辑。非空 paste 即使过滤结果为空仍应消费。专用 Space 分支也必须消费 Space，但 context-window 行不调用 insert；其他行保留切换行为。Space 不能创建被拒绝的历史记录。不修改 auth-flow 模块或通用回调 API。

已有 auth 测试明确记录受控字段与 Ink 的差异：Ink 内部 buffer 可能保留被拒绝字母，而父值已过滤；OpenTUI 保持接受后的数字与光标。保留这个已测试的 OpenTUI 数字合同。对比归一化后已接受编辑序列与最终持久化 contextWindowSize，不能声称非法原始输入的内部状态完全一致。

## 历史事务与可观测性

改变文本的 commit 保存此前文本/码点光标并清空 redo。光标移动和 no-op 不记录编辑。一次 paste 算一次编辑。Undo/Redo 先同步恢复文本与光标，再通知已有 owner。Undo 后新编辑使 redo 失效，移动光标则不影响。settled 字段忽略编辑和历史键；mountKey 改变/卸载表示新字段历史。

私有已确认检查点保存上次渲染接受的 LineState 及不可变 undo/redo 数组引用。正常原样接受时保留当前每次逐键操作，包括同一 stdin read 的 edit → Undo → Redo。检测到拒绝时，恢复检查点两栈和接受状态，仅撤销未确认提案。若 owner 给出的可检测过滤值既不同于提案也不同于检查点，则保留检查点更早的 undo，并把接受替换记为从此前接受状态开始的一次编辑；像普通新编辑一样清空 redo。同一字段外部替换采用这个明确的 replace-edit 规则。真实字段重新挂载才重置历史。

只有 void onChange 与最终渲染值，无法重建任意有状态回调在同一 read 中对中间提案作出的裁决。检查点不能补出缺失 acknowledgement。不声称通用重建，也不为假想回调引入 acknowledgement API。真实数字 owner 已在创建提案前归一化，其余当前 onChange 原样接受文本，因此所验收生产路径的歧义已被移除。以后新增有条件拒绝的 owner，必须先明确真实归一化/acknowledgement 才能继承保证。

必须覆盖反例：接受1 → 12 → 123后拒绝x，仍可Undo到12、Redo到123；混合 paste `1,024` 保留更早接受历史；纯无效 paste 保留 redo；同一 read 的 edit → 非法数字输入 → Undo → Redo；接受12 → 编辑3 → Space → Undo → Enter 应提交12，owner trace 只有数字；同一 read 两次接受编辑加历史键；Undo/Redo 间移动光标；Undo 后新编辑；可检测过滤替换；外部替换；mount reset；settled 后跟随 paste/历史键；100条上限。既测试真实 Ink reducer 的接受编辑序列，也测试实际数字对话框路径。这些反例仍是已实现历史行为的验收要求，不能豁免。

## 原生光标分段布局

OpenTUI 0.5.10 的空独立 text 节点仍可能占一列。只有消毒后的显示字符串非空时，才挂载 before/after 分段。Sources、Discover、Acquisition、认证、确认与 Permissions 字段统一遵守此规则。保留光标单元、inactive 字符、密码遮罩、placeholder、`caretInside` 条件及裁剪语义。精确输入行断言与原生空/非空转换构成布局回归，不能归一化空格来隐藏多余列。原生几何检查补充公开 CLI 场景，本身不独立证明完整 CLI 合格。

## 验证

记录实际候选、runtime 与 renderer。使用有记录的全局 CLI Ink 运行作为比较基线，记录所观察版本、runtime 与执行日期；无法取得的产品来源明确记为 unknown。本迁移目标使用 Bun 1.4.4 与 OpenTUI 0.5.10。

从仓库根目录执行 `npm run build && npm run typecheck`、`npm run lint` 及修改文件的格式检查。从 `packages/cli` 运行受影响的完整单元文件，包括共享编辑/历史模型和全部六个显示消费方：

```sh
cd packages/cli
npx vitest run src/ui/opentui/line-edit.test.ts src/ui/opentui/line-edit-history.test.ts src/ui/opentui/ExtensionSourcesTab.test.tsx src/ui/opentui/ExtensionDiscoverTab.test.tsx src/ui/opentui/ExtensionAcquisition.test.tsx src/ui/opentui/ExtensionAcquisition.widgets.test.tsx src/ui/opentui/dialogs-auth.test.tsx src/ui/opentui/dialogs-confirm.test.tsx src/ui/opentui/dialogs-permissions.test.ts src/ui/opentui/dialogs-permissions.test.tsx src/ui/opentui/dialogs-permissions.burst.test.tsx
```

交互集成测试前运行 `npm run build && npm run bundle` 构建 bundle。从 `integration-tests` 执行以下聚焦运行时检查。每个组合使用空的独立 harness home/runtime/temp，避免继承宿主配置，并串行执行文件：

```sh
dialog_test_root=$(mktemp -d)
failed=0
for leg in node:ink bun:ink bun:opentui; do
  dialog_leg_root="$dialog_test_root/${leg%%:*}-${leg#*:}"
  mkdir -p "$dialog_leg_root/home" "$dialog_leg_root/runtime" "$dialog_leg_root/tmp"
  QWEN_HOME="$dialog_leg_root/home" QWEN_RUNTIME_DIR="$dialog_leg_root/runtime" \
    TMPDIR="$dialog_leg_root/tmp" TMP="$dialog_leg_root/tmp" TEMP="$dialog_leg_root/tmp" \
    QWEN_E2E_RUNTIME="${leg%%:*}" QWEN_E2E_RENDERER="${leg#*:}" QWEN_SANDBOX=false \
    npx vitest run interactive/tui-editor-parity.test.ts interactive/tui-extension-acquisition.test.ts \
      --testNamePattern='^(permissions-edits-and-completes-without-model|acquires a real source through Discover and cold reload on .*)$' \
      --retry=0 --fileParallelism=false --maxWorkers=1 --minWorkers=1 \
      --dangerouslyIgnoreUnhandledErrors=false || failed=1
done
exit "$failed"
```

这两个场景通过现有测试文件接入 `.github/workflows/tui-parity.yml`：Permissions 编辑/paste、规则持久化、可见目录补全与取消；Source 编辑/撤销/重做后实际获取及冷启动重载。renderer matrix 要求 strict Bun+OpenTUI，并与 Node+Ink、Bun+Ink 区分。逐项记录各运行组合；某一组合仍待完成或原生微型测试成功，都不表示三个组合全部通过。受控 fixture 不需要外部模型账号或设备权限。

单元测试覆盖同一 read 的按键/paste、被拒提交、保存回调失败、低高度/窄宽度所有权、数字过滤及历史。原生检查还必须覆盖空 → 非空 → 空光标分段与精确行几何；mock 的文本展平无法证明终端列布局。

## 验收与剩余工作

词编辑结果必须与真实 Ink reducer 一致，包括 Ctrl+Meta 优先级和跨换行的码点偏移。Permissions 两个表单应支持编辑/paste 且不改变提交意图；目录 footer 必须对应实际可用、可见的补全。不能选择隐藏候选。无效输入保持可编辑，视图切换阻止旧 handler 修改状态。

当前批次已实现，验证结论仍须限定到实际候选、命令和记录的运行时结果。对话框后续工作包括 Ctrl+C 字段清空与全局退出所有权、Ctrl+X 外部编辑器生命周期。IME/a11y、完整平台/安装资格（包括 Windows PowerShell 及受支持的原生/runtime 组合）仍是迁移要求。本批次不授权切默认或移除 Ink，也不把历史失败提升为通过。
