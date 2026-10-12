# 用于 TUI 回退映射的稳定 prompt 身份

[English](rewind-stable-prompt-identity.md) | [简体中文](rewind-stable-prompt-identity.zh-CN.md)

## 问题

TUI 回退（rewind）此前通过统计两套互相独立的表示，来对齐可见的用户轮次与面向模型的历史。
被清除的媒体等不可见条目会让这两个计数不一致，从而选中错误的截断边界。

## 决策

使用 `promptId` 作为可见用户轮次与其面向模型的 prompt 所共享的权威身份。

- 把该 id 持久化在用户 `ChatRecord` 上。
- 以 Symbol 元数据的形式挂到对应的内存态 API `Content` 上，因此不会被发送给模型提供方。
- 在记录、压缩、resume、branch 与 checkpoint restore 各条路径上保留该元数据。
- 被标识的回退目标只通过精确 id 查找解析，并要求该 id 在两侧都唯一。
- 该查找与重复普查都只覆盖"最近一次成功压缩标记之后的保留区"，
  因此某个 id 的孪生项即使已被吸收，也不会让仍能唯一解析的轮次被拒。
- 任意一侧缺失或重复该 id 时返回 `-1`，不再用位置映射猜测。
- 拒绝时说明原因：保留区内带 id 却无法解析的轮次（例如 retry 以未标记的形式重发了 prompt），
  提示的是"已无法与模型历史对应"，而不是"已被压缩"。
- 只有没有 id 的旧历史轮次保留既有的位置映射。

既有的压缩守卫继续拒绝那些已被无标记压缩前缀吸收的轮次。

## 身份生命周期

交互式、headless 与 ACP 三类入口都会铸造形如 `sessionId########<counter>` 的 id。
resume 与 fork 路径会把计数器播种（seed）到该 transcript 的记录所声明的身份之上，
使新轮次不会复用已有的 key。startup、resume 与 branch 都通过
`computeResumedPromptCountSeed` 使用同一条规则。

重复 id 仍然可能出现：本次改动之前写下的 transcript 不带记录级 id；
而当一次"仅回退对话"的操作把某个轮次从 transcript 中丢掉时，
file-history snapshot 的 key 可能比声明它的轮次活得更久。
因此两侧都选择显式失败而不是靠猜——对话截断要求恰好只有一条匹配的 API 条目，
而 `FileHistoryService.rewind` 会拒绝被多个 snapshot 同时穿戴的 key，
否则它会把共享 key 解析到最后一次出现的位置，然后裁剪掉更新的备份。
该拒绝是文件侧唯一的守卫；TUI 通过既有的 restore 错误路径把它呈现给用户，
而不是自己先跑一遍统计（census）。

压缩记录会把 prompt id 持久化为一个与其历史快照平行的数组。
恢复某个压缩 checkpoint 时，会把每个 id 重新挂回同一条目。

`/restore` 创建的 JSON checkpoint 无法让 Symbol 元数据穿过文件本身，
因此写入侧把 id 持久化为一个与 `clientHistory` 平行的数组，
恢复时会在安装该历史之前把每个 id 重新挂回对应条目。
本次改动之前写出的 checkpoint 没有这个数组：其中的 file key 仍可用于只恢复文件，
但对话回退会显式失败，而不会对已带 id 的轮次应用位置映射。

## 范围

本次改动为 TUI 回退提供稳定的轮次身份，以及维持该身份稳定所需的持久化路径。
它不引入文本归属（text ownership）、通知来源（notification provenance）、
序号对账（ordinal reconciliation）或其他对齐启发式；
那些做法会重新造出本设计意图消除的"双权威"问题。

OpenTUI 会在铸造新 id 之前，把自己的 prompt 计数器播种到 resume transcript
已声明的身份之后。虽然 OpenTUI 自身没有回退界面，但这些 id 会被持久化，
之后可能由 Ink rewind 消费。

本次改动仍刻意不把播种范围扩大到已保留的 file-history snapshot key 之上。
上面那处拒绝只在两个 snapshot 共享同一个 key 时触发。如果 resume 之后铸造的新轮次
重新穿戴了某个"仅回退对话"遗留下来的 snapshot 的 key，且自身没有写文件，
那么对该轮次做代码恢复会解析到那个更早的 snapshot。本次改动之前的播种只统计用户记录，
实时轮次本来就有这一暴露面；它作为残余风险被接受，并在 #11408 中跟踪。
