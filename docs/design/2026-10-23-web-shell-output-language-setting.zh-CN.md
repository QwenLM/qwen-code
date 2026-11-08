# Web Shell 设置面板中的模型输出语言

[English](2026-10-23-web-shell-output-language-setting.md) | [简体中文](2026-10-23-web-shell-output-language-setting.zh-CN.md)

日期：2026-10-23

## 背景

Web Shell 设置面板通过 `general.language` 暴露界面语言，用 `en` / `zh-CN`
下拉渲染，并通过 `/language ui <lang> [--project]` 生效。模型输出语言
（`general.outputLanguage`，schema 中的 label 为 "Language: Model"）完全没有
对应的行，宿主既看不到也无法在面板中修改，尽管 TUI 设置对话框和
`/language output` 命令都支持它。

这个缺口在 daemon 侧是有意为之：`general.outputLanguage` 被列在
`TUI_ONLY_SETTINGS`（`packages/cli/src/serve/routes/workspace-settings.ts`）里，
因此 `GET /workspace/settings` 不下发它的 descriptor。原因是走
`POST /workspace/settings` 持久化该 key 只会改写 `settings.json`，不会重写
`~/.qwen/output-language.md`，也不会刷新运行中的会话。这正是
[User-Level Language Sync for the Daemon](2026-08-29-user-level-language-sync.md)
中记录的“持久化不等于同步”规则。

## 目标

- 在 Web Shell 设置面板中显示模型输出语言的实际生效值。
- 允许用户从面板修改，语义与 TUI 一致：留空表示 `auto`（跟随用户输入语言），
  修改立即作用于当前会话。
- 保持 `/language output` 是唯一写入路径，使 `output-language.md` 与会话系统
  提示始终一致。

## 非目标

- 不提供工作区级输出语言：命令固定写用户作用域并写全局规则文件，因此面板不
  提供工作区行。
- 不新增路由，也不修改 `POST` 请求 schema。
- 不修改 TUI 设置对话框，也不改变 `initializeLlmOutputLanguage()` 的保留行为。

## 设计

### 读路径：只读 descriptor

`GET /workspace/settings` 现在通过新增的 `READ_ONLY_SETTINGS` 集合下发
`general.outputLanguage`。该集合只并入 GET 的 key 列表；`getAllowedKeys()` 与
`POST /workspace/settings` 的校验保持不变，因此写入仍返回
`400 disallowed_key`。这样既保留了 TUI-only 的写入限制，又让宿主能拿到生效值
（用户作用域与默认值合并后的结果），并保留 `values.user` /
`values.workspace` 供通用作用域提示使用。

descriptor 同时携带 `options`：来自 `SUPPORTED_LANGUAGES` 的语言名，形如
`{ value: fullName, label: "nativeName (fullName)" }`。它们只是建议，不是白名单；
该设置仍然接受任意语言名。

旧版 daemon 不下发该 descriptor，面板相应地不渲染这一行，属于优雅降级。

### 写路径：language 命令

Web Shell 用 combobox 而不是固定下拉渲染这一行。该值是自由文本（`中文`、
`English`、`日本語` 或 `auto` 等语言名），因此输入框仍接受手输；弹出列表展示
daemon 下发的建议以提升可发现性。输入为空或选择第一项表示 `auto`（跟随用户
输入语言）。

提交后，通过与 `/language ui` 相同的会话命令通道发送
`/language output <value>`（空值发送 `auto`）。daemon 侧命令会写入当前会话实际
读取的 `output-language.md`（存在项目文件时为项目文件，否则为
`~/.qwen/output-language.md`），在用户作用域持久化 `general.outputLanguage`，
刷新分层记忆并重建当前系统提示。随后面板重新加载 `/workspace/settings`，让该
行反映已持久化的值。

面板对该 key 跳过通用的 `POST /workspace/settings` 写入，因此不会出现
`requiresRestart` 提示：命令在下一轮就生效，无需重启。

### 作用域

输出语言是用户级设置。该行只在“用户”作用域标签页渲染：命令没有工作区目标，
放在“工作区”标签页会暗示一个写入路径无法兑现的覆盖值。项目内的
`.qwen/output-language.md` 仍按项目覆盖全局文件，与这一行相互独立。

## 失败矩阵

| 场景                           | 行为                                        |
| ------------------------------ | ------------------------------------------- |
| daemon 未下发只读 descriptor   | 不渲染该行                                  |
| 流式生成中或存在活动提示时提交 | 由共享会话门禁阻止命令                      |
| `/language output` 失败        | 上报错误；已存储值与输入框保持不变          |
| 输入为空                       | `/language output auto`（跟随用户输入语言） |
| 工作区标签页                   | 按设计隐藏该行                              |

## 兼容性

两侧都是增量改动。daemon 在既有路由上多下发一个 descriptor；忽略未知 key 的宿主
不受影响。Web Shell 也能容忍不下发该 key 的 daemon。

## 改动面

| 层        | 位置                                                                | 改动                                              |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Daemon    | `packages/cli/src/serve/routes/workspace-settings.ts`               | `READ_ONLY_SETTINGS` 并入两个 GET 的 key 列表     |
| Web Shell | `packages/web-shell/client/settings.ts`                             | 新增 `setting:output-language` 别名               |
| Web Shell | `packages/web-shell/client/components/messages/SettingsMessage.tsx` | combobox（语言建议 + 自由输入）、仅用户作用域渲染 |
| Web Shell | `packages/web-shell/client/App.tsx`                                 | 分发 `/language output` 并重新加载设置            |
| Web Shell | `packages/web-shell/client/constants/localCommands.ts`              | 补全 `output` 子命令                              |
| 测试      | daemon 路由与设置面板测试                                           | 只读 descriptor、拒绝写入、控件行为               |

## 验证计划

- `workspace-settings.test.ts`：descriptor 以生效值下发，且 `POST` 以
  `disallowed_key` 拒绝该 key。
- `SettingsMessage.dom.test.tsx`：工作区标签页没有该行；用户标签页中 `auto` 渲染
  为空输入，固定值原样显示，提交调用 language 回调而不是通用设置写入。
- `settings.test.ts`：公开别名映射包含新别名。
- 手工验证：会话进行中在面板修改该值，确认下一轮回复使用新语言且无需重启。

## 验收标准

1. Web Shell 设置面板的“用户”标签页显示模型输出语言的生效值，并允许修改。
2. 修改会写入 `output-language.md` 并刷新运行中的会话。
3. `POST /workspace/settings` 仍然拒绝 `general.outputLanguage`。
4. 未下发只读 descriptor 的 daemon 不渲染该行。
