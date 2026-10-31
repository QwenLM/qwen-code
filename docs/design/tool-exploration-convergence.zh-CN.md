# 只读探索收敛提醒

[English](tool-exploration-convergence.md) | [简体中文](tool-exploration-convergence.zh-CN.md)

## 问题与范围

#13321 要求在多样化发现调用成功、却没有推进交付物时提供可执行的收敛点。现有自适应默认工具调用上限允许有用的多样调用超过软阈值。本提案在该阈值追加提醒，不增加新的停止条件、不推断任务意图、不强迫写入，也不改变权限。#10887 的重复执行失败及其运维灰度策略继续单独跟进。

阈值等于 `model.maxToolCallsPerTurn`（默认 100），统计的是单个逻辑轮次内的一段连续只读阶段，因此动机事件观测到的调用数（约 92 次混合调用，其只读阶段被穿插的非只读调用反复重置）并不保证触发提醒。

## 行为

记录注册 kind 为 `Read`、`Search` 或 `Fetch` 的连续调用阶段；`lsp` 与 `tool_search` 虽注册为 `Kind.Other`，仍按探索读取计数（重新标注类型会改变调度器并发语义）。通过 registry 解析 `tool_call` 的桥接目标，因此声明为只读的 MCP 工具不依赖名称匹配。规划、实现、委派及未知 kind 结束该阶段。达到 `model.maxToolCallsPerTurn` 次后，在工具结果之后插入一次提醒：使用已收集信息，推进请求的交付物或解释具体阻塞。对于只读请求，应给出发现和剩余问题。提醒不授予工具新权限，也不替代规划批准。

保留现有自适应和显式硬上限语义。禁用或无限 allowance 不产生提醒。合法的进一步调查仍可继续，提醒不把每次读取都判定为无进展。只有进入非只读阶段或新的逻辑轮次后，才可能再次提醒。交互式 loop-detector 的会话禁用选择也会抑制 core 提醒。

## 归属与兼容

core 在现有逻辑轮次 loop detector 旁持有一份 budget，并将其绑定到开启该交互的 prompt id：这一阶段属于该交互，`record`、`commit`、`rollback`、`takeReminder` 以及各轮次 reset 等所有 budget 入口，对于属于其他交互的流一律为空操作。因此并发的插入式提问（`/btw`）既不会清零、也不会虚增或消耗正在运行轮次的阶段：它走到同一个 client，而它的工具结果续轮提交时不带旁路标记，所以真正起隔离作用的是 prompt id 绑定，而不是该标记。Retry 与 model fallback 回滚未提交的调用观测，provider 重复 call ID 只计一次，现有 user/Goal/Stop 轮次 reset 同时清除 budget。ACP 在每个 daemon tool-loop state 内持有 budget，该循环的工具结果续跑共享它。foreground、channel、Stop/todo、cron、notification 循环均会创建该 state。subagent 推理循环被排除在外：它直接驱动 `LlmChat`，不经过记录与注入 budget 的 client 或 daemon 工具循环，因此失控的 subagent 仍只受其既有每轮上限约束。旧调用方自行构造导出的 state、没有可选 budget 时保留原行为。不同 session 不共享状态，budget 不保存参数、结果正文或标识符。

该回滚扩展仅作用于 budget。loop detector 自身的每轮上限回滚仍只针对 Retry：生产环境的 model fallback 只可能先于自己尝试的调用出现（链路仅在失败尝试未产生任何 candidate output 时启动），没有可回滚的内容，而按轮次清空检测器累积的连击证据，会让经由反复 fallback 服务的轮次静默失去连续相同调用与停滞保护。

计数观测发出或接纳的调用 kind，不从语义上证明成功推进。非只读请求即使后来执行失败，也会结束该阶段；此情况仍由现有失败保护负责。三个后果是被接受的：记账类工具（`todo_write`、memory）会重置阶段；运行时自身的 active-todo 提示每 3 个工具轮次重新注入一次，因此维护待办清单的会话实际上无法累积 100 次连续读取类调用——#13321 的这一变体不在本功能覆盖范围内；而在 `tools.codeModeOnly` 会话中，除 direct-only 集合外对模型可见的工具只有 `exec`，它被构造为 `Kind.Other`（因此每次调用都会重置阶段），脚本内部通过 `tools.read_file(...)` 执行的读取根本不会以 `ToolCallRequest` 事件形式出现，所以该模式几乎不可能累积出一个完整的只读阶段——若要让它可达，需要由 code-mode 运行时记录 exec 脚本内部的调用，那是更大的改动，不在本 PR 范围内。模型可能忽略提醒，因此受控 provider 能验证插入与运行行为，不能证明生产模型已经收敛或节省 token。

## 验证与验收

使用定向测试验证阈值、一次性行为、实现/规划重置、禁用 allowance 以及 Retry 回滚。验证任意名称与桥接的注册 MCP kind。实际 CLI/tmux 使用不同文件的真实读取，捕获模型请求中的提醒、仍可用的只读工具、自然结束，并单独识别附加模型请求。原生证据必须绑定执行源码和构建产物身份。现有调用上限和权限检查仍有最终约束力。保持有效实现阶段和合法的大范围只读调查可继续，不强制写入。

## 开放边界

提醒插入是确定性的，模型回应不是。更强的语义完成门槛需要单独声明任务/进展契约，本提案不自行创造该契约。
