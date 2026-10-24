# Managed 用户消息队列

[English](2026-10-24-managed-user-message-queue.md) | [简体中文](2026-10-24-managed-user-message-queue.zh-CN.md)

## 问题

Managed Turn admission 拒绝第二个活动 Turn。浏览器 pending 输入用于提交重试，并非持久化队列。用户需要在执行过程中补充指导，同时保持工具执行完整。

## 行为

接收文本及已有文件引用，每个 Session 最多 32 条未完成消息。保持 FIFO 和独立消息身份。仅领取前允许通过版本校验编辑或撤回。在模型请求前、工具结果完整回填后及最终结算前消费。不得绕过审批。正常结束后剩余消息通过一个后续 Turn 承接；停止或失败后暂停，显式恢复才继续。图片仅支持空闲时发送。

## 归属与恢复

Java 控制面持久化入队和调度。原 Harness 通过带 writer fence 的 Managed 日志写入消费后的用户历史。入队不等于消费。投递不确定时查询原持久化证据，不得转投其他 Runtime。消费及用户历史证据必须原子提交。恢复请求先使用原快照，再接收新指导。上下文及文件引用保持入队时的绑定。关闭终止待发工作。

## 接口

Public 路由为 `/v1/agents/sessions/{sessionId}/user-messages`；WebShell adapter 在原前缀下使用 `/user-messages/query` 和 `/user-messages/command`。命令 action 为 submit、edit、withdraw 或 resume。写操作持久化 actor 作用域的幂等回执并返回其结果快照；客户端在变更后重新查询当前快照。入队、编辑、撤回和暂停状态通过不重叠的一秒轮询刷新。已消费输入也进入现有持久化 Session 事件流与对话记录。

Session 级消息提交、查询、编辑、撤回和恢复操作沿用鉴权及幂等约定，通过明确 capability 暴露。浏览器展示服务端快照。Public OpenAPI 与生成的 WebShell 类型同步演进。原 Turn 提交语义保持不变。

## 验证

见 `.qwen/e2e-tests/managed-user-message-queue.md`。覆盖 FIFO、Hooks、工具和审批边界、容量、权限、生命周期、响应丢失、重启和 writer 接管。SQL 并发需要 MySQL 证据；fixture 测试不能证明真实模型验收。

## 状态

已加入本地实现。TypeScript 验证和 bundle 的 Harness 能力冒烟记录在 E2E 报告中。Java/MySQL 并发、进行中 Turn 恢复及真实模型验收仍待完成。已消费用户记录本身不能证明模型已完成处理；无法证明结果的中断投递继续阻塞。尚未宣称生产或完整故障矩阵验收。
