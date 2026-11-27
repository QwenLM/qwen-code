# 工具参数名别名

[English](2026-11-27-tool-arg-name-aliases.md) | [简体中文](2026-11-27-tool-arg-name-aliases.zh-CN.md)

状态：提议（2026-11-27）。

## 问题

有些模型按别的 harness 的工具来命名参数。文件工具要求 `file_path`，模型发
`read_file {"path": "/repo/a.py"}` 时什么也读不到：schema 校验失败，模型收到
`params must have required property 'file_path'`。这条消息只说缺了哪个参数，
不提模型传的那个参数，而校验会忽略它。

在 Harness Leaderboard 上，Qwen Code 0.25.2 配 Flint 模型，抽样的 142 个 trial
里 9274 次工具调用有 2518 次（27%）花在 schema 错误上。套用下文的别名后，其中
2375 次（94%）按原样就能通过校验；几乎都是 `read_file`、`write_file` 或 `edit` 用
`path` 代替 `file_path`，少数是 `edit` 用 `old_str` / `new_str`。其余 143 次大多
是完全缺了某个必填参数（`edit` 没有 `new_string`）。2464 个 `path` 值中有 2462 个
是绝对路径。出过错的 133 个 trial 中，有 104 个在报错后改用过 `file_path`，其中
95 个后来又回到了 `path`：仅靠更清楚的消息解决不了这个模型的问题。

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

### 在接收工具调用时应用别名

core 中的一张表把工具 → 别名 → 标准名对应起来：

| 工具         | 别名      | 标准名       |
| ------------ | --------- | ------------ |
| `read_file`  | `path`    | `file_path`  |
| `write_file` | `path`    | `file_path`  |
| `edit`       | `path`    | `file_path`  |
| `edit`       | `old_str` | `old_string` |
| `edit`       | `new_str` | `new_string` |

`CoreToolScheduler` 在接收请求时克隆参数。解析出工具之后，包括通过 `tool_call`
展开的嵌套调用，它会对参数副本应用别名。标准名不存在而别名存在时，把值移到标准名
下并删除别名键。两者都存在时，以标准名为准。查找时先将旧工具名转换为标准名。
通过发现机制注册的工具保留各自 schema 中声明的参数名。

headless、Ink、OpenTUI、子代理以及共享循环上的 ACP 通过 `CoreToolScheduler`
调度。旧 ACP 循环直接执行工具，在桥接展开后、hook 和依赖参数的权限检查前，对参数
副本应用同一张表。两条路径都在聊天历史中保留模型原始调用，用于计算重复重放指纹。

如果改在工具的 `build` 里应用别名，`request.args` 里仍是 `path`：Ink 和 OpenTUI
的编辑 checkpoint 读取 `request.args.file_path`，会跳过这样的编辑，导致它无法
回退。

接收请求之后替换调用参数的地方（PreToolUse hook 的 `updatedInput`、在外部编辑器中
的修改、策略门禁）不会再应用一次别名：它们从标准参数出发；hook 若把 `path` 写回，
得到的是现在这样的 schema 错误。

### 读取历史的地方

聊天中的读取驻留检查、microcompaction 记录的被清除读取路径和压缩后的文件恢复，都会
对调用参数副本应用同一张别名表。microcompaction 按文件工具的规则去除路径首尾空白并
解除转义，从而将被清除结果对应文件的缓存置为失效。压缩后恢复文件时，先规范化桥接
工具名，再查别名。会话导出按写入或编辑结果中的实际路径计数。旧记录可回退到所保存的
`file_path` 和文件名，因此不同目录中的同名文件会分别计数。

### 在 schema 错误中点出未知参数

`BaseDeclarativeTool.validateToolParams` 在 schema 错误后追加：调用中 schema 没有
声明的顶层键，以及 schema 声明的键：

```
params must have required property 'pattern'. Unrecognized parameters: query. Accepted parameters: pattern, glob, path, limit.
```

省略 `additionalProperties` 或将它设为 `false` 时，校验错误可能追加说明。顶层没有
`properties`、显式把 `additionalProperties` 设为非 `false`，或带有可能接受其他键
的关键字（`patternProperties`、`allOf`、`anyOf`、`oneOf`、`$ref`、`if`、
`dependentSchemas`、`dependencies`、`unevaluatedProperties`）的 schema 会跳过
这条说明。省略 `additionalProperties` 且 `required` 中有键未列在 `properties` 时，
也会跳过说明。封闭 schema 可在 Ajv 的 `must NOT have additional properties`
错误之后点明多出的键。说明只在 schema 校验报错时追加。自行校验参数的工具（如
`agent`）继续返回自己的参数校验错误。

说明放在工具层而不是 `SchemaValidator` 里，因为后者的错误文本还有其他调用方共用。

## 风险

- 同时传 `path` 和 `file_path` 且值不同的模型，保持现在的行为：以 `file_path`
  为准。
- 说明会给测试和按原文匹配的客户端读到的错误多加一行。固定了原文的测试会同步
  更新。
- 别名表是固定列表。新的 harness 习惯需要改代码；这样行为是可预期的。

## 验证

单元测试覆盖调度器和旧 ACP 在 hook 前处理别名、保留原始历史参数、直接调用和桥接
调用的缓存失效与恢复、会话导出，以及封闭、组合和只在 `required` 中声明参数时的
schema 提示行为。桥接历史样例对应可由 `tools.eager` 设为延迟加载的文件工具。

[E2E 报告](https://github.com/QwenLM/qwen-code/pull/18500#issuecomment-7211299701)
记录了模型模拟环境和最初的 CLI、ACP 及子代理测试结果。验收用例包括：

- headless：`read_file {"path": …}` 能读到文件；带 `path`、`old_str`、`new_str`
  的 `write_file` 和 `edit` 能修改文件；
- `run_shell_command {"cmd": …}` 得到点出 `cmd` 和 `command` 的说明；
- 非 yolo：`write_file {"path": …}` 请求确认时显示该文件；
- 针对该文件的 deny 规则仍然拒绝 `path` 调用；
- PreToolUse hook 看到 `file_path`；
- 默认及旧循环上的 ACP 会话、子代理均可用 `path` 读文件。

## 验收标准

- 上述调用表现如上；历史中保留模型的 `path`。
- 构建、类型检查和改动涉及的单元测试通过。
