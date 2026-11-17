# 项目移动后的会话重新关联

[English](session-relink-after-project-move.md) | [简体中文](session-relink-after-project-move.zh-CN.md)

## 状态

本设计由显式执行 `qwen --resume <sessionId>` 时的项目移动恢复功能实现。

## 问题

旧版本地会话存储在由项目路径派生的目录下。项目改名或移动后，派生目录随之
变化，因此即使会话数据仍然存在，显式恢复也无法再找到 transcript。

## 目标与范围

- 恢复由完整 UUID 指定且唯一匹配的旧版本地会话。
- 移动文件前必须进行交互确认，默认选项为 No。
- 保留全部可恢复的 transcript 记录和所有会话 sidecar。
- 只要归属、存活状态、文件身份或目标安全性存在不确定性，就拒绝恢复。

会话选择器、标题查找、`--continue`、托管会话以及自动或 headless 文件移动
均不在范围内。本功能不引入网络服务或注册中心。

## 发现与归属

查找最多扫描配置的运行时根目录下 5,000 个由 Qwen 管理的项目存储目录。目录
数量超过上限或扫描不完整时一律安全拒绝。只有满足以下条件的 UUID 才能恢复：
恰好存在一个普通、非符号链接、硬链接数为一的 transcript；其首条可恢复记录
包含该 UUID 和原项目目录；并且原项目目录已经不存在。重复 UUID 保持歧义状态，
提示中列出能够读取到的原项目目录。

源存储目录必须等于根据记录的项目路径派生出的目录，目标目录不能包含任何同一
会话的产物。发现与移动共用以下唯一产物集合：

- `<id>.jsonl`
- `<id>.runtime.json`
- `<id>.worktree.json`
- `<id>.pr.json`
- `<id>.ledger.jsonl`
- `<id>.title.json`

标题、PR 和 ledger sidecar 按字节原样复制。runtime 和 worktree 中的路径只有
位于旧项目内部时才重新映射。

## 写入者与 transcript 安全

运行时存活判断同时使用 hostname、PID namespace、PID 启动标记、PID 存活状态
和 zombie 检测。`active` 与 `unknown` 都会阻止恢复，只有 `dead` 或 `missing`
才允许继续。这样既不会把其他 PID namespace 中的活跃进程误判为死亡写入者，
也不会让被回收的 PID 永久阻塞会话。

transcript 解析遵循正常会话加载器的容错 JSONL 契约。崩溃造成的截断或粘连尾行
中的可恢复记录会被保留；外部 session ID、错误归属或不存在可恢复首条记录仍视为
不安全。执行移动前会再次核对文件身份，包括 `dev`、`ino`、大小、`mtime` 和
`ctime`。

## 移动与失败处理

恢复过程先暂存改写后的字节，再以不覆盖方式发布所有目标，最后才删除源文件。
任何发布或删除失败都会逐字节恢复源文件、删除新发布的目标和临时文件，并返回
受控的拒绝信息。重新查找的结构化结果会返回 CLI，使活跃写入者、目标冲突、重复
匹配和源不可用各自保留准确诊断。

sandbox 宿主只执行认证初始化，并将恢复解析交给 sandbox 子进程。子进程先建立
worktree 与运行时目录上下文，再进行查找。headless 调用可以发现候选项，但没有
交互确认时绝不会移动文件。

## 验证与验收标准

- sandbox 与非 sandbox 的显式 UUID 恢复进入同一恢复流程。
- 外部 PID namespace 会阻止移动；启动标记不匹配的回收 PID 不会阻止移动。
- 六种产物整体移动，并在确认提示前报告目标冲突。
- 带可恢复截断尾行的 transcript 能够移动并从目标位置正常加载。
- 并发追加与移动中途失败测试证明身份校验和回滚有效。
- stdout 重定向或协议模式不会出现交互提示。
- Core 与 CLI 聚焦测试、lint、格式检查、build、typecheck 和仓库 preflight 全部通过。
