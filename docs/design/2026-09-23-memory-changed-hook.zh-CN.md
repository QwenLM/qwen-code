# MemoryChanged hook

[English](2026-09-23-memory-changed-hook.md) | [简体中文](2026-09-23-memory-changed-hook.zh-CN.md)

## 问题

托管自动记忆是本地文件。外部集成方不知道哪些文档被创建、更新或删除，也不知道某个工作区的记忆是开还是关。`PostToolUse` 覆盖不到索引重建、`/forget`，以及不经过工具的写入。后续消费者（例如 Data Agent 里把 markdown 上传到自己接口的 hook）需要一个稳定的文档身份，以及写完之后还能读到的路径。

## 现状

`HookEventName` 没有记忆文档事件。remember、forget、extract、dream 把文档写进用户、项目、团队记忆根目录，然后重建 `MEMORY.md`。调度文件（`meta.json`、`extract-cursor.json`、`consolidation.lock`）在 `memory/` 外面。记忆对话框和 `qwen/settings/setMemory` 会写 `memory.enableManagedAutoMemory`，但不会发 hook。

## 方案

新增写后、非阻塞的 hook 事件 `MemoryChanged`。变更已经落地。hook 输出和 hook 失败都不会回滚。事件不带文件正文。`create` 和 `update` 时，集成方自己读 `paths`。`delete` 时文件已经不在。

### 文档变更

```json
{
  "paths": ["/abs/memory/user/role.md"],
  "relative_paths": ["user/role.md"],
  "memory_scope": "user",
  "operation": "update"
}
```

```json
{
  "paths": ["/abs/project/memory/a.md", "/abs/project/memory/b.md"],
  "relative_paths": ["a.md", "b.md"],
  "memory_scope": "project",
  "workspace": "/abs/project",
  "operation": "update"
}
```

- `paths`：绝对路径。单个文件是 `[path]`。一起改的文件留在同一个数组里，并按 scope 拆开。
- `relative_paths`：同一批文档，相对于该 scope 的记忆根目录，用 `/`，顺序与 `paths` 一致。这是稳定的文档键。沙箱上的绝对路径不是。
- `memory_scope`：`user`、`project` 或 `team`。
- `operation`：依据文件是否存在，取 `create`、`update` 或 `delete`。写入已有的空 `MEMORY.md` 属于 `update`，包括脚手架创建的空索引，以及被清空后重新填充的索引。此事件不会重放之前的创建操作；镜像方需要从已有文档初始化，并接受尚未见过的文档的更新。
- `workspace`：工作区绝对路径。项目和团队记忆带上。用户记忆省略。

`write_file` 和 `edit` 的目标在托管记忆根目录内时发通知。`/forget` 在删除或改写之后发通知。`MEMORY.md` 重建在索引写完后发通知，内容相同时跳过。定时 dream 和 extract 会在 agent（含索引重建）前后比较记忆目录，按差异只发一次。agent 里用 shell 删掉的文件是一条 `delete`。手动 `/dream` 是把提示交给主 agent，这一轮里的 shell 删除不在这次快照里。比较窗口还开着时，另一处已经自行通知的写入保留那条事件，窗口的差异以那条事件报出的内容为基线。显式传入的投递 id 只匹配其所属的注册；id 不可用时，不会回退到其他会话。只有没有 id 的事件才使用该工作区最新的活跃注册。关闭中的会话立即退出这种回退投递，但保留自身后台记忆任务的通知，直到任务排空。直接通知和快照都只纳入 Markdown 文档，排除调度文件和临时文件。如果外部通知在收尾快照读取之后到达，窗口会跳过这次过期的比较，由写入方负责该事件。

快照键使用文件系统保存的拼写，同时保留符号链接组件。路径因新符号链接而无法被遍历时，视为未知，而不是已删除。即使开窗快照无法读取文档，窗口外已报告的删除仍然是基线。

团队记忆同步在拉取及记录导入内容基线期间登记同步边界。快照等待该边界完成；同步与读取重叠时，重新读取快照。只有 Git 实际变更的文档路径会推进基线，内容使用 checkout 转换后的表示；与之不同的本地原始写入仍然发出事件。较新的显式通知优先于迟到的同步基线。共享用户记忆树中未自行通知的写入，仍保留此前已接受的跨窗口归属限制。

### 开关

```json
{
  "paths": [],
  "relative_paths": [],
  "workspace": "/abs/project",
  "enabled": false
}
```

只有这次开关才带 `enabled`。省略 `operation` 和 `memory_scope`。记忆对话框先将工作区设置提交到磁盘，再更新显示状态并以该项目根目录作为 `workspace` 发出通知。设置写入失败时显示错误，不发送开关事件。`qwen/settings/setMemory` 写的是用户设置；`enableManagedAutoMemory` 真的变化时，用这次请求的工作区发事件。开关没有相对路径，所以每个 `MemoryChanged` hook 都会收到。只关心文档的 hook 应忽略带 `enabled` 的事件。直接改 settings 文件不会发这个事件。只有记忆对话框和 `qwen/settings/setMemory` 会发。

基础 hook 输入仍有 `session_id` 和 `cwd`。`cwd` 是工作目录，不是工作区。

## 决策

| 决策                                            | 原因                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 写完之后，从记忆写入点发，不从 `PostToolUse` 发 | 索引重建和 `/forget` 不是工具调用。hook 运行时文件已可读，或已经删掉。                                               |
| 载荷不带文件正文                                | hook 自己读 `paths`。删除没有正文。大文档不必塞进 hook 的 stdin JSON。                                               |
| 增加 `relative_paths` 和 `memory_scope`         | 后续上传方不必重写 Qwen 的记忆目录规则就能给远端对象命名，也可以在团队记忆已由 git 同步时跳过 `team`。               |
| 每个 scope 一条事件                             | 用户记忆必须省略 `workspace`。同一次调用里的项目和团队记忆要分开。                                                   |
| hook 失败被忽略                                 | 本地写入已经落地。上传失败不能把它撤销。                                                                             |
| 只发给执行写入的工作区                          | 一个进程里可以有多个工作区。别的工作区的 hook 看不到这次变更。同一个工作区有多个会话时，事件发给执行写入的那个会话。 |
| matcher 用 `relative_paths`                     | 可以选 `MEMORY.md` 和 `user/role.md`，而不去匹配沙箱绝对路径。                                                       |

## 范围

包含：hook 事件、设置项、上面的发送点，以及用户 hook 文档。

不包含：上传字节、远端存储、新实例回填，以及在落盘前拦截或改写记忆写入。

## 验证

- 单测覆盖用户、项目、团队路径分类，丢掉调度文件和无关文件，把一起变更的路径打成一组，用户记忆省略 `workspace`，开关事件的 `paths` 为空。
- 监听方抛错不会让通知调用失败。
- hook 输入对用户文档省略 `workspace`，对开关省略 `operation` / `memory_scope`。

## 验收

- 配置了 `MemoryChanged` 命令 hook 后，文档或开关变更之后，stdin 收到上面的 JSON。
- 没有配置 hook 时，写入路径不跑 hook 命令。
- `meta.json`、`extract-cursor.json`、`consolidation.lock` 不发这个事件。
