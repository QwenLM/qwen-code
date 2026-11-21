# OpenTUI footer 可点击的 reasoning effort

[English](2026-11-19-opentui-footer-effort-picker.md) | [简体中文](2026-11-19-opentui-footer-effort-picker.zh-CN.md)

- 状态：已实现，等待审查
- 日期：2026-11-19
- 范围：仅 OpenTUI 交互式 renderer；Ink 不变

## 问题

OpenTUI footer 已经会在模型名称旁显示当前 reasoning tier（`<model> <effort>`），但 tier 只是纯文本。切换仍需要记住 `/effort` 指令并手动输入，即使同样的 effort picker 在其他桌面 UI 只差一次点击。

第二个问题出现在 provider entry 带有静态 effort knob 的模型（`generationConfig.extra_body.reasoning_effort` 或 `generationConfig.samplingParams.reasoning_effort`，可能是 flat 或 nested）。这些 raw request 值最后才合并，优先级高于 `model.reasoningEffort`。本 PR 不改变这个 escape-hatch 语义：它只让 footer tier 可点，并复用 Ink `/effort` 的持久化路径，使两个 renderer 行为一致；override 反馈仍由既有 `formatEffortChangeMessage` 负责。

## 目标

- 只让 status line 中的 tier run 可点；模型名称与其他 status-line 内容保持不可点。
- 打开既有 effort picker，并预选 footer 当前显示的 tier。
- 通过 Ink `/effort` 相同的 `useEffortCommand` 路径套用与持久化：`applyReasoningEffort` 加 `settings.setValue(getPersistScopeForModelSelection(settings), ...)`。
- 与选择自动复制共存：在 footer 拖拽选择文字不可打开 picker。
- Ink 行为保持不变。

## 非目标

- 不新增 effort picker UI；复用既有对话框。
- 不清理 static effort knob，也不新增 override 侦测或额外警告；provider/global 的 flat 与 nested knob 仍是明确 escape hatch。
- 不把 provider 专属 budget knob（`thinking_budget`、`budget_tokens`、`thinkingLevel`）映射到 canonical ladder。
- 不写入 operator 所有的 System/SystemDefaults 设置。
- 不处理 provider model switch 逻辑。

## 设计

### 点击目标

`useStatusLineState` 只在 status line preset 包含 `model-with-reasoning`、显示中的 reasoning 有 tier，且该 tier 属于模型提供的档位列表时返回 `reasoningSegment`。Footer 在已换行的 status line 中定位该精确 segment，仅把 tier 子字符串包进可点击 box。

含有 ANSI escape 的行，或换行把 model segment 拆开的行，保持不可点。这避免切断 escape sequence 或猜测列位置。

### 点击与拖拽

OpenTUI 在可选中文字上按左键会先启动选择并在派送 `onMouseDown` 前返回，因此无法用 mousedown 锚点区分点击与拖拽。Footer 在 `mouseUp` 时检查 renderer 当前的选择是否包含文字：

- 空选择：视为点击，打开 picker
- 非空选择：可能是拖拽自动复制，不打开

这也兼容 PR 16799 的选择自动复制行为。

### Footer 打开的 picker

Footer 以 `openedFromFooter: true` 打开 effort 对话框。对话框：

- 以显示路径报告的 tier 预选，让高亮行与 footer 一致（即使该 tier 来自 static provider knob）；
- 立即套用 tier；
- 把结果写入 transcript，但不记录成用户输入的 `/effort` 指令。

直接 `/effort` 保持原有的预选与记录行为。

### 持久化

选择完全复用 Ink `/effort` 的路径：`applyReasoningEffort` 先把 tier 套用到 live config，再用 `getPersistScopeForModelSelection(settings)` 持久化 `model.reasoningEffort`。这与 Ink 写入同一个 scope，两个 renderer 不会分歧；不会改写或删除其他设置。

因此 static provider/global knob 会原样保留。它们存在时仍可能压过持久化 tier，与 Ink `/effort` 完全一致；既有 `formatEffortChangeMessage` 是 override 的反馈路径。footer picker 不额外增加警告，也不走 settings 改写。

### 模型覆盖范围

此入口适用于有 effort tier 的模型：内置 GPT、DeepSeek、tiered Qwen 家族，以及任何声明 `capabilities.reasoning.efforts` 的模型。Toggle-only 模型、显示中的 reasoning 没有 tier，以及显示 tier 不在模型档位列表内的情况，都不显示可点目标。未声明 reasoning capability 的模型会 fallback 到完整 ladder（由 provider 再 clamp），因此只要显示 tier 就仍可点。

## 限制与已知问题

- Static provider/global effort knob 会保留。它们仍可能压过持久化 tier，与 Ink `/effort` 完全一致；当 config 暴露 override 时，既有 `formatEffortChangeMessage` 会报告。
- 对于档位来自 `capabilities.reasoning.efforts`、但没有 profile 的模型，footer 显示会跟随刚选的 tier，而保留的 static provider/global knob 仍可能在请求时胜出。Override 侦测不覆盖这种情况，只会套用通用的「requested; the effective tier depends on the active provider/model」提示。
- System/SystemDefaults 设置由 operator 拥有，此 picker 不会写入。
- Provider 专属 budget knob 不会映射到 canonical ladder。
- Status line 为了点击目标拆成三个 text run；rebase 到 selection-clipboard PR 后需要做一次视觉确认。
- 原始持久化错误以技术文字显示，未翻译。

## 验证

- 单元测试覆盖 segment 暴露、toggle-only 不可点、tier membership、footer 预选、点击与拖拽选择、与 Ink 相同 scope 与调用路径的持久化、static provider/global knob 保留、Workspace/User scope ownership，以及失败通知。
- PTY 端到端测试仍是手动检查：点击 footer tier、选择不同 tier、重新启动 CLI，并读回新 tier。
- `prettier`、`eslint` 与 CLI TypeScript build 通过。

## 验收标准

- 点击 tier 会打开 picker；点击其他 status-line 内容不会。
- 拖拽选择后在 tier 上放开不会打开 picker。
- 选择 tier 后会把 `model.reasoningEffort` 持久化到与 Ink 相同的 scope。Footer 会依显示路径重新渲染；当 static knob 在请求时仍胜出，它可能显示刚选的 tier，而请求会保留配置的 static 值。
- 重启后选择的 tier 仍生效，除非用户配置的 static knob 压过它，行为与 Ink `/effort` 一致。
- Provider/global static knob 与 provider array 保持逐字节不变。
- Ink 输出与交互不变。

## 后续工作

- 若需要清理 static override 或增加额外警告，应在单独的、经 maintainer 批准的变更中同时修改两个 renderer 的 `/effort`。
- Selection-clipboard PR 合并后，重新检查 footer 选择复制。
