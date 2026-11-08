# 仅命名 workflow 锁

[English](./2026-09-17-workflow-name-only.md)

跟踪 issue：#11013 第 12 项（剩余部分）。

状态：已在 #12078 实现。

## 问题

部署方可以让模型启动扩展随包发行的 workflow（`whenToUse`，#11957），也可以按名字或路径限定审批（#11943），但没有办法阻止同一个模型自己写一段最多 1000 个 agent 的内联脚本来运行。内联脚本没有可写权限规则的名字或路径，部署方一旦为命名 workflow 放宽审批，内联脚本也会一并放行。

## 决策

### 开关

`tools.workflowNameOnly`（默认 `false`）或 `QWEN_CODE_WORKFLOW_NAME_ONLY=1` 打开锁。`Config.isWorkflowNameOnly()` 在会话启动时确定一次：Workflow 工具在启动时构建描述和参数 schema，锁若在会话中途变化，模型手里的契约就与工具实际行为不一致。

工作区可以打开锁，不能关闭。该键是"工作区只能收紧"的设置：工作区的 `true` 生效；操作者设为 `true` 时，工作区的 `false` 会被丢弃并告警。环境变量不允许由项目 `.env` 设置，仓库内容无法取消操作者导出的值。

### 锁住什么

| 来源                                          | 锁开时 | 理由                                                                                                   |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `script`                                      | 拒绝   | 模型在会话里写的代码没有可被规则匹配的身份。                                                           |
| `scriptPath`                                  | 拒绝   | 每个已保存 workflow 都能按名字到达；路径提供不了名字之外的东西，generated-scripts 根目录是运行期目录。 |
| `name`，以及 `name` 加 `resumeFromRunId`      | 允许   | 可被 `Workflow(name:…[,sha256:…])` 规则匹配。                                                          |
| 模型启动的脚本里的 `workflow({ scriptPath })` | 拒绝   | 同一条规则的下一层。`workflow('<name>')` 照常。                                                        |

来源的判定与参数校验一致：`name` 旁边为空的 `script` 或 `scriptPath` 不会让一个按名运行的调用被拒。

### 锁约束模型，不约束宿主

拒绝放在工具的 `build` 里，模型和客户端的每次调用都经过这里，包括交互斜杠命令的 `schedule_tool`。宿主经 ACP 发起的 `run-saved`、`run-script`、retry、rerun 走 `buildSessionOwnedBackground`，与 `build` 共用参数校验但不经过 `build`，不受限制。嵌套拒绝也按同一条线划分：只有工具为模型或客户端构建的调用才会要求 runner 拒绝，宿主的脚本仍可按路径嵌套。

### 告诉模型什么

锁开的会话直接把规则告诉模型，而不是让它撞错才知道：

- 参数 schema 去掉 `script` 与 `scriptPath`。`name` 不设为必填，因为宿主的运行复用同一份 schema 校验，并从脚本启动。
- 描述用 "Named workflows only" 一段替换 authoring 指针，共享的决策与运行时文字去掉引导模型使用 `scriptPath` 或编辑已落盘脚本的句子。有测试保证这类说法不会在该段之外残留。
- `workflow` 关键词提醒引导 `{ name, args }`，不再引导写脚本。锁状态在该路径里任何可能失败的步骤之前读取。
- 交互 `/<name>` 命令按名调度。

### 按名恢复

锁关时，恢复调用仍给出脚本路径，已有的 `Workflow(scriptPath:…)` 授权继续匹配。锁开时路径被拒，恢复调用改为给出 workflow 名，但只给能回到本次运行所执行脚本的名字。workflow 名可能来自子目录里的文件路径、来自被同名项目 workflow 遮蔽的用户 workflow，或是 retry 回退到内联副本时沿用的旧名；按这样的名字恢复会运行另一个脚本，或者找不到脚本。因此 runner 在运行启动时解析一次该名字，只有解析到同一个文件时才记为该运行的 `resumeName`。没有 `resumeName` 的运行不提供恢复调用，失败通知说明只能由启动方重试。

锁本身只存在于一处：Config。Config 把它交给自己持有的 workflow 运行 registry，registry 在通知里给出恢复调用时读取；工具和关键词提醒读 Config。

### 宿主

`GET /session/:id/supported-commands` 的 `workflowToolFeatures.nameOnly` 反映锁状态，宿主据此知道模型受限，而自己的 `run-script` 仍能启动运行。

## 与 Claude Code 的差异

Claude Code 的 `CLAUDE_WORKFLOW_NAME_ONLY` 拒绝 `script`、`scriptPath` 和 `resumeFromRunId`，只解析内置 workflow，并对所有运行拒绝嵌套的 `workflow({ scriptPath })`。Qwen Code 没有内置 workflow，而这个锁面向的是启动命名运行并恢复它们的部署，所以保留全部名字层级（项目、用户、扩展），允许按名恢复，并且不限制宿主发起的运行。

## 相关修复

"工作区只能收紧"的合并逻辑把工作区的值与 User、SystemDefaults 中更严的那个比较，而合并时 User 覆盖 SystemDefaults。当 SystemDefaults 更严、User 更松时，与 SystemDefaults 相同的工作区值会被当成"没有变化"丢弃，尽管实际生效的是 User 的值。现在的基线是不含工作区时实际生效的值：User 设置了就用 User 的，否则用 SystemDefaults 的，否则用默认值。这一修复同样影响 `agents.crossSessionMessaging` 与 `agents.crossSessionInbound`。

## 局限与风险

- 锁保证模型发起的每次运行都可被按名规则寻址，它本身不批准也不阻止任何东西。模型仍可保存一个新的 workflow 文件再按名运行，按具体名字或脚本摘要限定的审批规则会对它发起询问。
- 锁开的会话里 `/review` 的 workflow 扇出不可用，因为它按路径运行生成的脚本。review skill 已规定工具不可用时报告并停止。
- 恢复名在运行启动时检查，之后新增或删除 workflow 文件不会反映出来。

## 不在范围内

- 内置 `deep-research` workflow（第 12 项的另一块剩余部分）。
- 名字来源白名单。
- 会话中途切换锁。

## 验证

- 单元测试覆盖：每一种被拒与被接受的来源；宿主运行（脚本、脚本路径、嵌套路径）；schema 与描述形态；恢复名匹配与不匹配两种情况；通知文案；registry 抛错时的关键词提醒；斜杠命令；Config 在启动时确定锁；该键与 `crossSessionInbound` 的收紧基线；ACP 能力位。
- 对每个新分支的手工变异都至少让一个测试失败。
