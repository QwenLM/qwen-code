# 已结束失败操作后的外部 Workspace 退役

[English](managed-retirement-settled-failure.md) | [简体中文](managed-retirement-settled-failure.zh-CN.md)

## 问题与方案

FAILED 和 CANCELLED 操作可以有意保留 BLOCKED 投递标记，防止 relay 再次派发。将这个标记视为未完成副作用，会永久阻止已经终止的外部 Worker 退役。

退役现在只阻止非终态操作，允许 COMPLETED、FAILED 和 CANCELLED。已有的待审批、活动工作、所有权、Session 成员及原 runtime 终止检查保留。改动只影响退役资格，不改变 relay 投递或 Worker 创建。

## 兼容性与验证

本次更新补充常驻外部 Workspace 退役，不修改 schema。已终止的 Workspace 若仅保留终态失败操作及 BLOCKED 投递，应允许退役；其他条件相同但操作尚非终态时，仍应拒绝。已有审批与未完成工作 fencing 必须继续生效。保留了回归源码，但公开分支最新提交 CI 和真实生命周期验收仍待完成，不声称本地测试通过。
