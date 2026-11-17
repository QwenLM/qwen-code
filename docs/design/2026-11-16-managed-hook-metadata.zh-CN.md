# Managed hook 展示元数据

[English](2026-11-16-managed-hook-metadata.md) | [简体中文](2026-11-16-managed-hook-metadata.zh-CN.md)

状态：本变更中实现。对应
[#17381](https://github.com/QwenLM/qwen-code/issues/17381)。

## 问题

Managed 扩展准备会拒绝带有标准字符串 `description` 或 `statusMessage` 的
hook。`stageManagedExtensionManifests()` 把每条 contribution hook 抄进
catalog，只丢掉 `once` 和 `async`，然后由 `ManagedHookRuntime` 解析整个
catalog。`parseManifest()` 用封闭键列表检查每份 config。四份列表都没有这两个
字段，因此 `closed()` 在 hook 运行前抛出 `managed_hook_invalid`。一条这样的
hook 会使整个 `extension-prepare` 失败。

本变更之前的白名单是：

- command：`type`、`name`、`command`、`timeout`、`env`、`shell`
- http：`type`、`name`、`url`、`headers`、`allowedEnvVars`、`timeout`
- prompt：`type`、`name`、`prompt`、`model`、`timeout`
- function：`type`、`name`、`timeout`

## 不变的契约

`CommandHookConfig`、`HttpHookConfig`、`PromptHookConfig` 和
`FunctionHookConfig` 都声明了 `description?: string` 与
`statusMessage?: string`。设置 schema 也把它们声明为可选字符串。用户文档在
command 和 prompt hook 中列出了这两个字段，在 HTTP hook 中列出了
`statusMessage`。交互式运行时的列表和 hook 进度已经读取它们。

非字符串的 `name` 对应 `managed_hook_manifest_invalid`。未知键对应
`managed_hook_invalid`。Catalog descriptor 把 command、HTTP、function 的
config 收成 `{ type, name? }`。Prompt descriptor 透传整份
`PromptHookConfig`。`getHookKey()` 使用 name 加上 command、url、prompt 或
function id。扩展 catalog 的 digest 来自原始 package contributions。对外
catalog 的上限是 60 KiB。

扩展 staging 只产生 command、HTTP 和 prompt hook。Function config 来自
workspace 基线 manifest。

## 决策

四份白名单都按与 `name` 相同的规则接受这两个可选字符串。出现的非字符串值为
`managed_hook_manifest_invalid`。其余未知键仍为 `managed_hook_invalid`。空字符串
允许。不新增按字段的长度上限；现有 60 KiB catalog 上限仍是出站限制。

Command、HTTP、function 的 descriptor 保持 `{ type, name? }`。这两个字符串留在
已存储的 manifest 上，使准备能够成功，并且不会随这三类 catalog 离开 worker。
Prompt descriptor 本来就会转发 `PromptHookConfig`，因此 prompt catalog 现在会
连同 `prompt`、`model`、`timeout` 一起带上这两个字符串。

`ManagedHookDefinition` 的 function 分支补上同样的两个可选字符串。Staging 不改：
它已经会复制除 `once` 和 `async` 以外的每个键。Planner key 和 definition
digest 不增加新的输入。

HTTP 白名单还按同一规则接受可选字符串 `if`。`HttpHookConfig` 与 serve hook
契约早已声明它，交互式运行时也会转发它，因此带条件的扩展 HTTP hook 会以同样
的 `managed_hook_invalid` 让准备失败——只差一个键。条件留在已存储的 manifest
上，不会随收窄后的 HTTP catalog 离开 worker。从 core 类型派生白名单留作后续
工作；白名单保持封闭、手写。

## 范围之外

Managed command 执行不新增 `statusMessage` 的进度通道。用户指南的 HTTP 小节保持
原样。Issue #13133 是另一项 managed hooks 后续工作。

## 验证

- `packages/cli/src/serve/managed-extension-manifests.test.ts` 暂存报告中的
  command hook，以及 HTTP 和 prompt hook：不带这两个字段、分别只带其中一个字段，
  以及两个字段同时存在，并期望这些字符串留在暂存后的 config 上。它还暂存带
  `if` 条件的 HTTP hook，并期望条件留在暂存后的 config 上。
- `packages/cli/src/serve/managed-hook-runtime.test.ts` 在四种类型上接受这些
  字符串，并期望解析后的 catalog pin 仍保留它们。它期望 command、HTTP、function
  catalog 只暴露 `{ type, name? }`，期望 prompt catalog 包含这些字符串，数字值以
  `managed_hook_manifest_invalid` 拒绝，未知键以 `managed_hook_invalid` 拒绝。
  它接受 HTTP `if` 条件，期望条件不出现在对外 HTTP catalog 中，非字符串 `if` 以
  `managed_hook_manifest_invalid` 拒绝。

## 验收

- 报告中带 `description` 的 `PostToolUse` command hook 可以暂存。
- command、HTTP、prompt hook 的 `statusMessage` 以同样方式暂存。
- 非字符串值为 `managed_hook_manifest_invalid`。
- 未知 config 键为 `managed_hook_invalid`。
- command、HTTP 或 function catalog 不包含这段元数据文本。
- prompt catalog 包含这段元数据文本，并仍受 60 KiB catalog 上限约束。
- 带 `if` 条件的 HTTP hook 可以暂存并解析。
- 非字符串 `if` 为 `managed_hook_manifest_invalid`。
- HTTP catalog 不包含条件文本。

## 待定问题

无。
