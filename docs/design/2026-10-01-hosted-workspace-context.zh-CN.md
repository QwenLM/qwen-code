# Hosted Workspace 项目上下文

[English](2026-10-01-hosted-workspace-context.md) | [简体中文](2026-10-01-hosted-workspace-context.zh-CN.md)

状态：已实现。解决 #13057。叠加在 #13166 之上。

## 问题与范围

Hosted 模型回合以 `safeMode: true` 运行，`refreshHierarchicalMemory` 在发现
之前就返回，因此回合开始时没有 Workspace 的 `QWEN.md` / `AGENTS.md`。
safe mode 是一个不可分割的捆绑（hooks、extensions、skills、MCP、工具列
表），必须保持开启；回合的 `cwd` 是 Harness 自己绑定的工作区，而设计禁止
模型依赖它。因此项目说明需要一条来自 Workspace 的路径，而不是解除一道
保护。

本切片交付这条路径：Hosted Workspace 回合第一次获取 Runtime 时，Harness
经现有 Broker 的 prepare/execute 路径读取根目录的说明文件（`QWEN.md`、
`AGENTS.md`），并把拼装好的文本保存在已接入的 Session 上。每个模型请求都
在请求组装时经 `Config.getUserMemory()` 读取系统提示所需内容，因此
Harness 通过 `Config.setUserMemory` 注入取回的文本——Session 已持有上下文
时在 `initialize()` 之后注入，首个请求即可带上；回合进行中取回时，在两个
模型轮次之间注入。

不在范围内：项目 settings、skills、rules 目录（safe mode 有意保持关闭）；
Workspace 根目录之外的嵌套或层级发现；已取回上下文的持久记录。持久化需要
新增 Session 域，而这是一个跨语言的契约变更（Java 存储侧镜像了封闭的域名
空间），因此延后：冷加载的 Session 在下一个工具回合重新读取。

## 时机与 Stage A 不变量

第一个模型请求从不等待 Runtime：读取搭载在第一个工具批次已有的获取动作
上。不调用工具的回合不读取，也不付出任何代价。Stage A 标准——Runtime 延
迟时模型输出仍然先返回——不受影响，因为首个请求路径上的任何环节都没有
变化。

由此带来的明确取舍：Session 的第一个回合在第一个请求时没有项目说明。读取
在该回合的第一次工具派发之前完成，因此同一回合的后续请求以及之后的所有
回合都有项目说明。

## 失败语义

读取是 best-effort 的。文件不存在、工具错误、传输失败或 Broker 拒绝都会让
Session 保持无上下文状态，回合不受影响；失败记录在 Harness 的 stderr。
slot 会记录一次已完成的读取——包括「Workspace 没有说明文件」——因此每个
已接入的 Session 最多读取一次。

## 拼装

每个读回非空内容的文件贡献一节，格式与本地层级记忆一致：
`--- Context from: <name> ---`、正文（即 `read_file` 返回的内容）与结束标
记。节与节之间空一行。文件名保持 Workspace 相对形式；Runtime 宿主的物理
路径从不出现。

## 实现边界

- CLI 工具回合：获取后读取，每个已接入 Session 一次，与它搭载的回合做失
  败隔离。
- CLI 模型回合：按请求注入的入口；safe mode 不变。
- CLI 会话：已接入的 Session 在其生命周期内保存取回的文本。
- Core 与 Java：不变。

## 验证与验收

回合级测试钉住：两次读取发生在第一次获取时，同一 Session 不再重复；文件
缺失时不产生内容；传输失败既不阻塞也不使回合失败。模型级测试钉住注入顺
序——预先取回的上下文在首个请求之前注入，回合进行中取回的在下一个请求
之前注入。会话级测试保持既有的恢复与不重复派发保证，并在断言派发计数的
地方显式点名上下文读取。

## 风险与未决问题

这两次读取为每个已接入的 Session 付出一次完整的持久化 prepare/execute
成本；更轻的只读派发路径另行跟踪。上下文是否应持久固定（并经
ContextBinding 契约带上 revision）由维护者决定；本切片建立的注入点在两种
答案下都不改变。
