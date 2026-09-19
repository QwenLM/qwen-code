# Managed memory 与稳定的会话前缀

[English](managed-memory-stable-prefix.md) | [简体中文](managed-memory-stable-prefix.zh-CN.md)

## 问题与状态

#11550 的客户端机制是：managed memory 写入后会重新绑定当前会话的 system instruction，导致历史之前的请求前缀发生变化。对于没有显式 cache breakpoint 的 provider，这可能让未变化的会话历史被重新处理。

这是客户端静态诊断，不是 llama.cpp 缓存驱逐的实测。修订后的候选实现已在本地完成，但尚未运行测试或提交。

## 决策

自动写入／提取后刷新 Config 的 memory 快照，但不重新绑定当前 chat 的 live system instruction；用户主动触发的显式刷新保持原行为。

这样避免了首版候选的旧数据问题：新 chat 和子 agent 仍能读取更新后的 Config 快照。当前 chat 中，前台写入内容已存在于工具历史，查询召回则读取重建后的索引。写入后清空“已提供路径”的去重集合，使同一个文件更新后可以再次被选中；同时取消基于旧索引启动的召回。

ACP 用户主动 remember 仍属于显式改变前缀的操作；本修改不宣称解决 forget。

## 实现边界

拆分“刷新 Config 快照”和“刷新 live instruction”。managed 写入与成功提取完成索引重建后，只刷新快照并失效当前召回状态；保留游标顺序、失败处理、helper 布尔返回值及全部显式 instruction 刷新调用方。不修改 ACP 快照、权限或后台请求路由。

## 验收与限制

本地测试代码已覆盖这些边界，但按要求没有执行：自动写入刷新快照但不重绑 live instruction；提取只在索引完成后失效召回；显式刷新仍更新 instruction；memory 变化会清空已提供路径去重。合并前只需运行受影响的测试文件，并在一个代表性的 OpenAI-compatible 后端对比连续请求正文。

单槽位后端上的后台请求仍可能驱逐前台 KV 状态。请求文本稳定不代表不会被服务端驱逐，也不证明重处理量或账单下降。原报告的这部分需要后端专属证据，须与本客户端修复分开跟踪。
