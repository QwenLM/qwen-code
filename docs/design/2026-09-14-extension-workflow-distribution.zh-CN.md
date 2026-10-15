# 扩展分发 workflow

[English](./2026-09-14-extension-workflow-distribution.md)

跟踪 issue：#11013 第 12 项（分发部分）；#8105 PR 15。

## 问题

saved workflow 只能放在项目（`.qwen/workflows`）或用户目录（`~/.qwen/workflows`），没有办法把可复用的 workflow 分发给别人。Claude Code 插件已经通过 `workflows` 清单字段和默认的 `workflows/` 目录分发 workflow。扩展是 Qwen Code 的分发单元，但扩展文件是第三方代码，所以这个功能必须在扩大分发范围的同时，不扩大 workflow 运行时能读取的范围。

## 决策

### 第三个 saved workflow 层级

已启用的扩展为 `workflow-saved.ts` 提供第三个层级，这个模块本来就负责项目和用户 workflow。所有消费方 —— `/<name>` 斜杠命令、脚本内的 `workflow('<name>')`、ACP 的 saved workflow 列表、详情与 run-saved 接口 —— 都只读这一个模块，因此没有任何一方长出单独的扩展路径。

扩展 workflow 始终以 `<扩展名>:<meta.name>` 寻址，与扩展 skill 和 Claude Code 插件 workflow 的形态一致。名字取自脚本静态的 `export const meta`，所以文件名可以不同。项目和用户层的名字是匹配 `^[a-z][a-z0-9-]{0,40}$` 的文件名，不可能含 `:`，因此各层不会互相遮蔽；优先级仍写为项目优先于用户、用户优先于扩展。如果同一个扩展同时提供同名的 skill 和 workflow，`CommandService` 会像处理任何重名的扩展命令一样，把 workflow 命令改名为 `<扩展名>.<名字>`，同时该命令保留文档中的名字用于 `slashCommands.disabled` 匹配：skill 在所有入口（包括 headless、ACP 和模型可见的命令列表）都保持可用，按文档名写下的一条禁用条目就能同时移除两者。同名的用户或项目自定义命令最后加载，会保留该斜杠命令；此时 workflow 仍可通过 `workflow()`、ACP saved workflow 接口和 web-shell Workflows 页面访问。

### 发现

`workflow-extension.ts` 读取默认的 `workflows/` 目录，或者只读取清单列出的目录和 `.js` 文件（`null` 视为未声明）。它只读一层目录，拒绝解析到扩展目录之外的路径，拒绝符号链接，单个文件上限 256 KiB，并用现有的静态解析器解析 `meta`，不执行脚本。`meta.description` 截断到 500 个字符，因为它会出现在同意提示、命令列表和审批对话框里。坏文件或无法读取的声明目录会带警告跳过，既不会让扩展加载失败，也不会丢掉排在它后面声明的路径。

### 读取边界

workflow 的 `{ scriptPath }` 加载由 `readWorkflowFileSecurely` 检查，它只证明文件位于某个受信任的根目录下，不检查文件是不是 workflow 脚本。因此扩展目录**不**作为根目录加入：一个根目录等于授权其下的所有文件，声明了 `"workflows": "."` 的扩展就会暴露自己的 `.env` 设置文件。取而代之的是，已发现的扩展文件只能按加载时记录的精确真实路径读取。加载后被替换成符号链接的文件会解析到别处，从而不再匹配。只有 `getActiveExtensions()` 会提供 workflow，所以停用扩展会让它的 workflow 从所有入口同时消失。

### 同意

安装和更新时的同意提示会列出每个 workflow 的名字和描述，列表变化时更新会重新询问。同意阶段的发现会像加载时一样展开 `workflows` 里的环境变量。复制式安装会把每个符号链接替换为它指向的文件，所以复制式安装的同意阶段会跟随符号链接，并按书写的路径检查包含关系；link 扩展直接加载源目录，所以它的同意阶段沿用运行时规则。与 skill 和 subagent 的发现一致，同意阶段会跟随目标在包外的符号链接读取内容，因为复制会把该目标实体化；复制时是否应对所有资源类型跳过这类链接，是仓库范围的问题，留给后续跟进。只修改脚本代码不会重新询问，按路径授予的"始终允许"在更新后仍然有效；这两点都写进了文档。

### 入口与门禁

扩展 workflow 复用现有门禁：斜杠命令受 Workflows 功能开关、bare mode 和 folder trust 约束，ACP 受 workflow 控制检查约束。斜杠命令以扩展的归属标签作为来源徽标，并且不能被模型调用。Workflow 工具的描述、参数描述、审批对话框和 resume 建议都会把扩展 workflow 标明为扩展 workflow。`/reload-plugins`、`qwen extensions list` 和扩展详情视图报告的是扩展提供了什么，与它们对命令、skill、agent 的做法一致。

### Claude Code 插件转换

转换器会按原相对路径复制声明的 workflow 文件，并把它们列进转换后的清单，所以不同目录下的同名文件互不覆盖。只有清单列出的文件会被发现；未声明 `workflows` 的插件保留其 `workflows/` 目录作为默认目录。marketplace 条目的 `workflows` 会覆盖插件自身的声明。声明目录里的符号链接，若目标仍在插件内，会被复制成普通文件。Agent Plugins v1 包不提供 workflow，因为该规范没有定义这个字段。

### 公开契约

ACP bridge 状态类型和 TypeScript daemon SDK 中 saved workflow 的 `source` 联合类型新增 `'extension'`。`listSavedWorkflows` 会返回扩展条目，运行时在这些接口上已经会带出这个值；让公开类型比实际数据更窄只会误导调用方。对 `'project' | 'user'` 做穷尽判断的调用方需要增加第三个分支。

## 不在范围内

- `Workflow({ name, args })` 调用，以及能锁定脚本内容的按名 `Workflow(name:...)` 权限规则。
- 内置 workflow 层级与仅按名锁定。
- serve 扩展能力数据中的 workflow 计数。
- 在 headless 或 ACP 模式下运行 workflow 斜杠命令。
