# 工具参数名别名

[English](2026-11-27-tool-arg-name-aliases.md) | [简体中文](2026-11-27-tool-arg-name-aliases.zh-CN.md)

状态：提议（2026-11-27）。

## 问题

有些模型按别的 harness 的工具来命名参数。文件工具要求 `file_path`，模型发
`read_file {"path": "/repo/a.py"}` 时什么也读不到：schema 校验失败，模型收到
`params must have required property 'file_path'`。这条消息只说缺了哪个参数，
不提模型传的那个参数，而校验会忽略它。

在 Harness Leaderboard 上，Qwen Code 0.25.2 配 Flint 模型，抽样的 142 个 trial
里 9274 次工具调用有 2518 次（27%）花在 schema 错误上。其中 2412 次（96%）是
`read_file`、`write_file` 或 `edit` 用 `path` 代替 `file_path`；另有约 90 次是
`edit` 用 `old_str` / `new_str` 代替 `old_string` / `new_string`。2464 个 `path`
值中有 2462 个是绝对路径。出过错的 133 个 trial 中，有 103 个在报错后改用过
`file_path`，随后又回到 `path`：仅靠更清楚的消息解决不了这个模型的问题。

在当前 CLI（0.28.7）上对接模拟服务实测：任何工具写错任何参数名，都只得到缺少
参数的那句话；正确参数旁边的未知参数会被忽略。百炼的 7 个模型（qwen3.7-plus、
qwen3.8-flash、qwen-flash、qwen-plus、qwen3-coder-flash、glm-5、
deepseek-v4.1-flash）在注入一次 `path` 错误后，下一轮都改用了 `file_path`。

## 目标

- 把路径参数写成 `path` 的文件工具调用，按写了 `file_path` 的方式执行；`edit`
  的 `old_str` / `new_str` 同理。
- 接收请求之后的每个环节（权限检查、hook、Agent Host guard、checkpoint、遥测、
  invocation）看到的都是标准参数名。
- schema 错误点出工具不认识的参数，并列出它接受的参数。

不在目标内：猜测其他名字；为 MCP 或其他工具加别名；新增设置；修改模型看到的
schema；托管工作区的文件工具（它们自行校验 `file_path` 并会明确说明）。

## 设计

### 在调度器接收请求时应用别名

core 中的一张表把工具 → 别名 → 标准名对应起来：

| 工具         | 别名      | 标准名       |
| ------------ | --------- | ------------ |
| `read_file`  | `path`    | `file_path`  |
| `write_file` | `path`    | `file_path`  |
| `edit`       | `path`    | `file_path`  |
| `edit`       | `old_str` | `old_string` |
| `edit`       | `new_str` | `new_string` |

`CoreToolScheduler` 在接收请求时、`tool_call` 桥接展开嵌套调用之后，本来就会
克隆每个请求的 `args`。别名作用在这份克隆上：标准名不存在而别名存在时，把值移到
标准名下并删除别名键。两者都存在时不做改动（多出来的键照旧被忽略）。工具名先经
`canonicalToolName` 解析，所以旧工具名也能覆盖。

所有执行路径（headless、Ink、OpenTUI、ACP 会话、子代理、共享 agent loop）都通过
`CoreToolScheduler` 调度，所以一处就能覆盖全部。聊天历史保留模型自己的调用，
因此读取历史的重复重放指纹不变。

如果改在工具的 `build` 里应用别名，`request.args` 里仍是 `path`：Ink 和 OpenTUI
的编辑 checkpoint 读取 `request.args.file_path`，会跳过这样的编辑，导致它无法
回退。

### 在 schema 错误中点出未知参数

`BaseDeclarativeTool.validateToolParams` 在 schema 错误后追加：调用中 schema 没有
声明的顶层键，以及 schema 声明的键：

```
params must have required property 'pattern'. Unrecognized parameters: query. Accepted parameters: pattern, glob, path, limit.
```

顶层没有 `properties`，或带有 `patternProperties` 或非 `false` 的
`additionalProperties` 的 schema 不追加说明。封闭的 schema
（`additionalProperties: false`）会追加：Ajv 报告 `must NOT have additional
properties` 时不点名是哪个键。说明只加在校验本来就会报告的错误上；带多余键的合法调用仍然
合法。

说明放在工具层而不是 `SchemaValidator` 里，因为后者的错误文本还有其他调用方共用。

## 风险

- 同时传 `path` 和 `file_path` 且值不同的模型，保持现在的行为：以 `file_path`
  为准。
- 说明会给测试和按原文匹配的客户端读到的错误多加一行。固定了原文的测试会同步
  更新。
- 别名表是固定列表。新的 harness 习惯需要改代码；这样行为是可预期的。

## 验证

单元测试：别名函数；调度器接收请求（工具、PreToolUse hook 和调度中的请求看到的
都是 `file_path`；调用方传入的 args 不变）；说明在该出现时出现、不该出现时不出现。
`tool_call` 桥接只能调用延迟加载的工具，而文件工具不是延迟加载的，所以不需要单独
的用例。

对接模拟服务的端到端测试（`.qwen/e2e-tests/tool-arg-name-aliases/`）：

- headless：`read_file {"path": …}` 能读到文件；带 `path`、`old_str`、`new_str`
  的 `write_file` 和 `edit` 能修改文件；
- `run_shell_command {"cmd": …}` 得到点出 `cmd` 和 `command` 的说明；
- 非 yolo：`write_file {"path": …}` 请求确认时显示该文件；
- 针对该文件的 deny 规则仍然拒绝 `path` 调用；
- PreToolUse hook 看到 `file_path`；
- ACP 会话和子代理用 `path` 读文件。

## 验收标准

- 上述调用表现如上；历史中保留模型的 `path`。
- 构建、类型检查和改动涉及的单元测试通过。
