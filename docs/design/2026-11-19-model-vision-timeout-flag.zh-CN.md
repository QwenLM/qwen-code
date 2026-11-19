# `/model --vision --timeout`

[English](2026-11-19-model-vision-timeout-flag.md) | [简体中文](2026-11-19-model-vision-timeout-flag.zh-CN.md)

## 问题

vision bridge 为每次转写尝试设置超时，超时的尝试会以新的超时预算重试一次。超时值是 `visionBridgeTimeoutMs`（内置 30s）。慢速或经过代理的视觉端点需要更大的值。目前只能编辑 `settings.json` 并重启才能修改，因为 `Config` 只在构造时读取一次，没有 setter。`/model --vision` 已经能选择 bridge 模型，但不能修改超时。

## 目标

- `/model --vision --timeout <value>` 持久化指定的超时值，并立即将生效值应用到当前 CLI 会话。
- `--timeout` 也可以和模型 id 一起传，一条命令同时设置模型和超时。
- 不在范围内：配置重试次数，超时后仍固定重试一次。

## 设计

**语法。** 值是整数秒（`60`），也接受 `s` 后缀（`60s`）和 `ms` 后缀（`90000ms`）。命令把值换算成毫秒，设置项仍是以毫秒为单位的 `visionBridgeTimeoutMs`。换算后的值必须是正整数毫秒，且不超过 2147483647，即 `AbortSignal.timeout` 能接受的最大延迟。小数、其他单位、零和负数会报错，且不写入任何内容。

**用法。**

| 命令                                                | 效果                                               |
| --------------------------------------------------- | -------------------------------------------------- |
| `/model --vision --timeout 60`                      | 只设置超时。交互模式下不打开选择器。               |
| `/model --vision qwen-vl-max --timeout 60`          | 同时设置模型和超时。模型被拒绝时，超时也不写入。   |
| `/model --vision`（非交互）                         | 回显中同时显示当前超时，未设置时标注 `(default)`。 |
| `/model --timeout 60`、`/model --fast --timeout 60` | 报错：`--timeout` 只适用于 `--vision`。            |

`--timeout` 可以出现在各个 flag 之间的任意位置。`--project` 和 `--global` 选择 settings 作用域，与 vision 模型现有行为一致。不受信任工作区的检查和 daemon 的 `persistModelSelection` 限制保持不变。

**内联 prompt。** `/model <model-id> <prompt>` 会原样发送 prompt。只有剩余参数构成 `--vision` 调用时才提取 `--timeout`，所以包含 `--timeout` 的 prompt 不会被改动。

**运行时。** 保存成功后，CLI 通过 `Config.setVisionBridgeTimeoutMs` 应用合并后的超时值。如果更高优先级的作用域覆盖了写入值，命令会同时报告已保存的值和生效值。setter 与构造函数共用校验逻辑，无效值回退到内置默认值。bridge 每次调用都读取生效值。

**Web Shell。** Web Shell 在客户端处理 `/model --vision`：它通过 daemon 写 workspace settings，而不是运行 CLI 命令，而且 daemon 会话本来就拒绝 `/model` 写 settings。不做修改的话，`/model --vision --timeout 60` 会把 `--timeout 60` 存成 vision 模型。因此 Web Shell 用同样的规则解析 `--timeout`，把 `visionBridgeTimeoutMs` 写到 workspace 作用域；带模型 id 时同时写 `visionModel`。值无效时弹出错误提示，不写入任何内容。与 Web Shell 现有的 `/model --vision <id>` 一样，写入对新会话生效。daemon 的 settings 路由把 `visionBridgeTimeoutMs` 加入向 Web Shell 提供的 key 列表。该设置是 `showInDialog: false`，只能通过这个列表提供，同时它也会在 Web Shell 设置面板中出现一行。

命令和视觉模型选择器使用当前会话的工作区。同时修改模型和超时时，daemon 会先校验超时值和模型选择器，再一次写入两项。独立会话可以在 Settings 面板的 User 标签页编辑超时。

**重启标记。** 该设置保留 `requiresRestart: true`。`/config`、Web Shell 设置和手动编辑只写文件、不调用 setter，这些途径仍需重启。只有本命令会更新当前会话。

## 涉及文件

- `packages/core/src/config/config.ts`：共用校验和 setter。
- `packages/core/src/services/visionBridge/vision-bridge-service.ts`：导出内置默认值供回显使用。
- `packages/cli/src/ui/commands/modelCommand.ts`：flag 解析、校验、持久化、回显和补全。
- `packages/cli/src/i18n/locales/{en,zh,zh-TW}.js`：新增文案。
- `packages/cli/src/serve/routes/workspace-settings.ts`：向 Web Shell 提供 `visionBridgeTimeoutMs`。
- `packages/web-shell/client/vision-timeout-command.ts` 和 `App.tsx`：Web Shell 的解析与 settings 写入；`settings.ts`、`settings/messages.ts` 和 i18n 词典：alias、标签和文案。
- `packages/cli/src/config/settingsSchema.ts`、生成的 VS Code settings schema、`docs/users/configuration/settings.md` 和 `docs/users/features/commands.md`：描述文字。

## 验收标准

- `/model --vision --timeout 60` 把 `visionBridgeTimeoutMs: 60000` 写入所选作用域，并更新当前运行的 `Config`。
- `60s`、`90000ms` 以及把 `--timeout` 放在 `--vision` 之前，结果与对应的秒数写法相同。
- 无效值和不带 `--vision` 的 `--timeout` 返回错误，且不写入任何内容。
- `/model <model-id> <包含 --timeout 的 prompt>` 仍然原样提交 prompt。
- 非交互模式下 `/model --vision` 的回显列出当前超时。
- 在 Web Shell 中，`/model --vision [<model-id>] --timeout 60` 把 `visionBridgeTimeoutMs: 60000`（带模型 id 时还有 `visionModel`）写入 workspace 作用域，且不会把 `--timeout` 写进 `visionModel`。
