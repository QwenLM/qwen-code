# OpenTUI 输入交互所有权

[English](2026-10-21-opentui-owned-interactions.md)

## 范围

本批迁移命令与 shell 召回、取消所有权、结构化输入队列、已准备请求 Retry、倒计时跳过和自然退出展示。恢复重放、rewind 和 checkpoint 创建/恢复属于后续独立依赖批次。

## 所有权

命令在等待持久召回写入前取得取消控制器。等待完成后核验 session 与控制器所有权；已取消或已被后继替代的工作不得执行。递归确认不重复记录调用。裸退出别名不替换最近的召回提示。Shell 控制器保持可取消直到自身结束；旧完成回调不得清除后继。本地 shell 按键让位于模型轮次、对话框与审批。

模型轮次同时持有 generation、已准备载荷和结构化队列。已接收 steering 与取消后的日志回滚保持同一所有者。Retry 复用已准备的媒体和文件内容，不新增用户日志或回显，只跳过一次活跃倒计时，并且不能穿过 shell 或命令所有权。现有每 attempt prompt-ID 策略差异仍为观察范围，本批不改变 core ID 分配。

退出取消待处理工作，先提交收到的总结再自然结束。私有退出快照与 transcript/canonical checkpoint 恢复分开。

## 验收

对实际组合候选执行正常 build/typecheck、受影响 CLI 完整文件、原生输入所有权和真实 NodeInk/BunInk/strict 取消、Retry、held-shell 与退出合同。每项结果绑定源码和 bundle；首个失败、平台跳过及未执行门禁在 PR E2E 报告中保留。历史组合树结果不能作为新抽取候选的验收。最终安装、运行时和平台发布仍是独立的整体迁移验收门槛。
