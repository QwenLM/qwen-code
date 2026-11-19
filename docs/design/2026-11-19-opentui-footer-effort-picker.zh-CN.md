# OpenTUI footer 可点击的 reasoning effort

[English](2026-11-19-opentui-footer-effort-picker.md) | [简体中文](2026-11-19-opentui-footer-effort-picker.zh-CN.md)

- 状态：已实现，等待审查
- 日期：2026-11-19
- 范围：仅 OpenTUI 交互式 renderer；Ink 不变

## 问题

OpenTUI footer 已经会在模型名称旁显示当前 reasoning tier（`<model> <effort>`），但 tier 只是纯文本。切换仍需要记住 `/effort` 指令并手动输入，即使同样的 effort picker 在其他桌面 UI 只差一次点击。

第二个问题出现在 provider entry 带有静态 effort knob 的模型（`generationConfig.extra_body.reasoning_effort` 或 `generationConfig.samplingParams.reasoning_effort`，可能是 flat 或 nested）。这些 raw request 值最后才合并，优先级高于 `model.reasoningEffort`。只写 global 设置的 picker 可能报告成功，但实际 wire 与重启后仍是静态 tier。

## 目标

- 只让 status line 中的 tier run 可点；模型名称与其他 status-line 内容保持不可点。
- 打开既有 effort picker，并预选 footer 当前显示的 tier。
- 选择结果跨 session 持久化。
- 选择后留下单一权威：移除作用中 provider entry 的静态 effort key，避免重启后被 global tier 覆盖。
- 与选择自动复制共存：在 footer 拖拽选择文字不可打开 picker。
- Ink 行为保持不变。

## 非目标

- 不新增 effort picker UI；复用既有对话框。
- 不改 provider 专属 budget knob（`thinking_budget`、`budget_tokens`、`thinkingLevel`）；它们仍是明确的 escape hatch。
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

- 以显示路径报告的 tier 预选，让高亮行与 footer 一致；
- 立即套用 tier；
- 把结果写入 transcript，但不记录成用户输入的 `/effort` 指令。

直接 `/effort` 保持原有的预选与记录行为。

### 持久化

选择会把 `model.reasoningEffort` 写入拥有 `modelProviders` 的 scope，并清除优先级更高、且带有同名 key 的 writable scope；低优先级的 scope 不会被删除，因此 Workspace 的选择不会抹掉 User 的全局偏好。

作用中的 provider entry 以 protocol + model id 定位，先比对 live base URL，再比对持久化的 `model.baseUrl`。若无法唯一识别，就跳过静态改写，避免动到 sibling provider。

对识别出的 entry，从 `extra_body` 与 `samplingParams` 移除静态 effort key。Nested `reasoning` 对象会被视为一个整体删除，因为 OpenAI pipeline 只要看到该对象存在就可能跳过 configured tier；若该对象还有 `budget_tokens` 等兄弟键，这些键会一并移除，并在 UI 中提示。Flat `reasoning_effort` 则单独删除。`model.generationConfig` 的全局 fallback 以同样方式处理。

移除动作以逐路径 `undefined` 写入，让 JSONC writer 产生 delete operation；整包对象写入会被深度合并，旧 key 会留下。

Provider array 写入沿用 provider-install adapter 的 placeholder 保留逻辑：写档前还原原始 `${VAR}`，避免把 env 展开后的密钥写进 `settings.json`。写入使用 `throwOnWriteFailure`；持久化失败时对话框报告错误，而不是成功消息。

Live 与 registry 副本也会在当前 session 清理，避免同模型 sub-agent 在重启前继承旧静态 knob。

### 模型覆盖范围

此入口适用于有 effort tier 的模型：内置 GPT、DeepSeek、tiered Qwen 家族，以及任何声明 `capabilities.reasoning.efforts` 的模型。Toggle-only 模型、没有 reasoning 能力的模型，以及显示 tier 不在模型档位列表内的情况，都不显示可点目标。

## 限制与已知问题

- System/SystemDefaults 设置由 operator 拥有；其中的静态 effort key 仍优先于持久化 tier，picker 无法改写。
- Provider 专属 budget knob 不会映射到 canonical ladder。
- 含 `.` 的 provider id 无法用 settings dot path 定位；其静态 key 移除会跳过，避免破坏设置树。
- 改写 `modelProviders.<key>` 是整包 array 写入；若载入到保存之间有同一个 provider array 的并行修改，可能被覆盖。
- Status line 为了点击目标拆成三个 text run；rebase 到 selection-clipboard PR 后需要做一次视觉确认。
- 原始持久化错误以技术文字显示，未翻译。

## 验证

- 目标单元测试覆盖 segment 暴露、toggle-only 不可点、tier membership、footer 预选、点击与拖拽选择、provider entry 定位（自定义 key、live/persisted base URL、sibling 不动）、flat/nested 静态移除、nested 兄弟键移除提示、全局 `model.generationConfig` 移除、workspace/User scope 行为、placeholder 路径形状，以及失败通知。
- 真实临时 settings 档测试覆盖逐路径 JSONC 删除、nested 整包移除、兄弟键保留，以及 `${VAR}` placeholder 保留且不写入展开后的密钥。
- PTY 端到端测试会点击 footer tier、选择不同 tier、确认 `model.reasoningEffort` 与 provider 静态 knob 已移除、重新启动 CLI，并读回新 tier。
- `prettier`、`eslint` 与 CLI TypeScript build 通过。

## 验收标准

- 点击 tier 会打开 picker；点击其他 status-line 内容不会。
- 拖拽选择后在 tier 上放开不会打开 picker。
- 选择 tier 后 footer 与实际 request 设置都会更新。
- 重启后选择的 tier 仍生效，且在 writable scope 中没有更高优先级的 provider 静态 knob 覆盖它。
- Ink 输出与交互不变。

## 后续工作

- 决定 System 所有的静态 knob 是否要显示用户可见警告。
- Selection-clipboard PR 合并后，重新检查 footer 选择复制。
